/** Launch and stop only a nonce-tagged Chrome in the profile we already own. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { assertProfileOwnership, type ProfileOwnership } from '../web-bridge/journal.ts'
import { ioCode, runtimeError } from './storage.ts'

export interface OwnedChrome {
  readonly cdpUrl: string
  readonly profileDirectory: string
  readonly ownerNonce: string
  readonly pid: number
  close(): Promise<void>
}

export async function discoverChrome(custom?: string): Promise<string> {
  const candidates = custom === undefined ? process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/opt/google/chrome/chrome']
    : [resolve(custom)]
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate } catch {}
  }
  throw runtimeError('WEB_CHROME_NOT_FOUND', 'Install Chrome/Chromium or configure its executable before setup.')
}

async function delay(ms: number): Promise<void> { await new Promise(resolve => setTimeout(resolve, ms)) }

/** Public CDP command; verifies the actual browser argv rather than a port/PID. */
export async function chromeArguments(cdpUrl: string): Promise<string[]> {
  const response = await fetch(`${cdpUrl}/json/version`, { redirect: 'error', signal: AbortSignal.timeout(2000) })
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Chrome discovery failed') }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = ''
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 64 * 1024) throw new Error('Chrome discovery is oversized')
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  const value = JSON.parse(text) as { webSocketDebuggerUrl?: unknown }
  if (typeof value.webSocketDebuggerUrl !== 'string') throw new Error('Missing Chrome endpoint')
  const url = new URL(value.webSocketDebuggerUrl)
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.port !== new URL(cdpUrl).port || url.username || url.password) throw new Error('Unexpected Chrome endpoint')
  const socket = new WebSocket(url)
  try {
    return await new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome ownership check timed out')), 2000)
      const fail = () => { clearTimeout(timer); reject(new Error('Chrome ownership connection failed')) }
      socket.addEventListener('error', fail, { once: true })
      socket.addEventListener('close', fail, { once: true })
      socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Browser.getBrowserCommandLine' })), { once: true })
      socket.addEventListener('message', event => {
        try {
          if (typeof event.data !== 'string' || event.data.length > 64 * 1024) throw new Error('Invalid Chrome command line response')
          const item = JSON.parse(event.data) as { id?: number, result?: { arguments?: unknown } }
          if (item.id !== 1) return
          const args = item.result?.arguments
          if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('Chrome does not expose verified command-line arguments')
          clearTimeout(timer); resolve(args as string[])
        } catch (error) { clearTimeout(timer); reject(error) }
      })
    })
  } finally { socket.close() }
}

function matches(args: string[], profileDirectory: string, nonce: string): boolean {
  const profiles = args.filter(arg => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='))
  const owners = args.filter(arg => arg === '--dsh-web-owner' || arg.startsWith('--dsh-web-owner='))
  return profiles.length === 1 && profiles[0] === `--user-data-dir=${profileDirectory}`
    && owners.length === 1 && owners[0] === `--dsh-web-owner=${nonce}`
}

function groupExists(pid: number): boolean {
  try { process.kill(-pid, 0); return true }
  catch (error) { if (ioCode(error) === 'ESRCH') return false; throw runtimeError('WEB_CHROME_OWNERSHIP', 'Cannot establish whether the owned process group is quiescent.', error) }
}

async function groupStopped(pid: number, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout
  while (groupExists(pid)) { if (Date.now() >= deadline) return false; await delay(50) }
  return true
}

export async function launchOwnedChrome(options: { profileDirectory: string, ownership: ProfileOwnership, executable?: string }): Promise<OwnedChrome> {
  assertProfileOwnership(options.ownership, options.profileDirectory)
  const executable = await discoverChrome(options.executable)
  const profileDirectory = options.profileDirectory
  const singleton = await lstat(join(profileDirectory, 'SingletonLock')).catch(error => { if (ioCode(error) === 'ENOENT') return undefined; throw error })
  if (singleton !== undefined) throw runtimeError('WEB_CHROME_PROFILE_IN_USE', 'Chrome has an existing profile lock; inspect it before launching another browser.')
  const portPath = join(profileDirectory, 'DevToolsActivePort')
  const previous = await lstat(portPath).catch(error => { if (ioCode(error) === 'ENOENT') return undefined; throw error })
  if (previous?.isSymbolicLink()) throw runtimeError('WEB_CHROME_OWNERSHIP', 'Chrome discovery metadata must not be a symlink.')
  await rm(portPath, { force: true })
  const ownerNonce = randomUUID()
  const args = ['--enable-automation', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profileDirectory}`, `--dsh-web-owner=${ownerNonce}`, '--no-first-run', '--no-default-browser-check', 'https://chatgpt.com/']
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', shell: false })
  let spawnError: unknown
  child.once('error', error => { spawnError = error })
  const spawned = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  let cdpUrl = ''
  let closePromise: Promise<void> | undefined
  const owned: OwnedChrome = {
    get cdpUrl() { return cdpUrl }, profileDirectory, ownerNonce,
    get pid() { return child.pid ?? -1 },
    close() {
      closePromise ??= (async () => {
        if (child.pid === undefined || !groupExists(child.pid)) return
        let verified = false
        if (cdpUrl) verified = await chromeArguments(cdpUrl).then(argv => matches(argv, profileDirectory, ownerNonce), () => false)
        // Linux can prove the exact argv even during startup/CDP failure. A PID
        // alone is never enough; no /proc fallback is assumed on macOS.
        if (!verified && process.platform === 'linux') {
          const argv = await readFile(`/proc/${child.pid}/cmdline`).then(bytes => bytes.toString('utf8').split('\0'), () => [])
          verified = matches(argv, profileDirectory, ownerNonce)
        }
        if (!verified) throw runtimeError('WEB_CHROME_OWNERSHIP', 'Cannot verify Chrome ownership; its process group and profile lock must be retained for inspection.')
        try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (ioCode(error) !== 'ESRCH') throw error }
        if (!await groupStopped(child.pid, 3000)) {
          const stillOwned = cdpUrl ? await chromeArguments(cdpUrl).then(argv => matches(argv, profileDirectory, ownerNonce), () => false) : false
          const argv = process.platform === 'linux' ? await readFile(`/proc/${child.pid}/cmdline`).then(bytes => bytes.toString('utf8').split('\0'), () => []) : []
          if (!stillOwned && !matches(argv, profileDirectory, ownerNonce)) throw runtimeError('WEB_CHROME_OWNERSHIP', 'Chrome ownership changed before forced shutdown; no signal was sent.')
          try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (ioCode(error) !== 'ESRCH') throw error }
          if (!await groupStopped(child.pid, 3000)) throw runtimeError('WEB_CHROME_STOP', 'The owned Chrome process group is not quiescent; retain the profile lock.')
        }
      })()
      return closePromise
    },
  }
  try {
    await spawned
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (spawnError !== undefined) throw spawnError
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Chrome exited before exposing its owned automation endpoint')
      const info = await lstat(portPath).catch(error => { if (ioCode(error) === 'ENOENT') return undefined; throw error })
      if (info !== undefined) {
        if (!info.isFile() || info.size > 4096 || typeof process.getuid !== 'function' || info.uid !== process.getuid()) throw new Error('Invalid Chrome discovery metadata')
        const port = Number((await readFile(portPath, 'utf8')).split('\n')[0])
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          const candidate = `http://127.0.0.1:${port}`
          if (await chromeArguments(candidate).then(argv => matches(argv, profileDirectory, ownerNonce), () => false)) { cdpUrl = candidate; return owned }
        }
      }
      await delay(100)
    }
    throw new Error('Chrome startup timed out')
  } catch (error) {
    try { await owned.close() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Chrome startup and verified cleanup failed; offline inspection is required.') }
    throw runtimeError('WEB_CHROME_START', 'Chrome could not start with verified ownership. Check its executable and graphical desktop.', error)
  }
}
