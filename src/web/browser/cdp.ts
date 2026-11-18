import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicPrivateWrite, BrowserStore, checkDeadline, privateRead, processExited, wait } from './storage.ts'
import { withOwnerLock } from '../store.ts'
import type { WebConnection } from './types.ts'
import { composerImageInput } from './media-dom.ts'

interface Pending {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** A small public Chrome DevTools Protocol client; no ChatGPT HTTP endpoints. */
export class CdpConnection {
  private nextId = 0
  private readonly pending = new Map<number, Pending>()
  private readonly socket: WebSocket
  private deadlineMs: number
  private constructor(socket: WebSocket, deadlineMs: number) {
    this.socket = socket; this.deadlineMs = deadlineMs
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 64 * 1024 * 1024) {
        this.fail(new Error('Invalid or oversized CDP frame')); socket.close(); return
      }
      let message: { id?: number; result?: Record<string, unknown>; error?: { message: string } }
      try { message = JSON.parse(event.data) as typeof message } catch { this.fail(new Error('Invalid CDP JSON')); socket.close(); return }
      if (typeof message.id !== 'number') return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(`CDP: ${message.error.message}`))
      else pending.resolve(message.result ?? {})
    })
    socket.addEventListener('close', () => this.fail(new Error('Browser connection closed')))
    socket.addEventListener('error', () => this.fail(new Error('Browser connection failed')))
  }

  static async connect(url: string, deadlineMs: number): Promise<CdpConnection> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1' || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(parsed.pathname)) throw new Error('CDP must be the dedicated local browser endpoint')
    checkDeadline(deadlineMs)
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Browser connection timed out')) }, Math.min(10_000, Math.max(1, deadlineMs - Date.now())))
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Browser connection failed')) }, { once: true })
    })
    return new CdpConnection(socket, deadlineMs)
  }

  async command<T extends Record<string, unknown> = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    checkDeadline(this.deadlineMs)
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Browser connection is not open')
    const id = ++this.nextId
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)) }, Math.min(15_000, Math.max(1, this.deadlineMs - Date.now())))
      this.pending.set(id, { resolve, reject, timer })
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    }) as T
  }

  close(): void { this.fail(new Error('Browser connection released')); this.socket.close() }
  /** Only for cancelling/detaching an already-owned page; never for navigation or submission. */
  beginCleanup(): void { this.deadlineMs = Date.now() + 2_000 }
  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }
}

async function endpoint(profile: string): Promise<string | undefined> {
  try {
    // Chrome itself creates this file with its own permissions. It contains no credentials.
    const file = await open(join(profile, 'DevToolsActivePort'), constants.O_RDONLY | constants.O_NOFOLLOW)
    let data: string
    try { const stat = await file.stat(); if (!stat.isFile() || stat.size > 1024) throw new Error('Invalid DevToolsActivePort'); data = await file.readFile('utf8') } finally { await file.close() }
    const [port, path] = data.trim().split(/\r?\n/)
    if (!port || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !path || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(path)) throw new Error('Invalid DevToolsActivePort')
    return `ws://127.0.0.1:${port}${path}`
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
}

interface BrowserOwner {
  version: 1
  phase?: 'launch-intent' | 'running' | 'failed'
  profilePath: string
  pid?: number
  launcherPid?: number
  launchedAt?: number
}

async function browserOwner(store: BrowserStore): Promise<BrowserOwner | undefined> {
  try {
    const owner = JSON.parse(await privateRead(join(store.coordinationDir, 'chrome-owner.json'), 2048)) as BrowserOwner
    if (owner.version !== 1 || owner.profilePath !== store.profilePath || (owner.pid !== undefined && (!Number.isSafeInteger(owner.pid) || owner.pid < 1)) || (owner.phase === undefined && owner.pid === undefined) || (owner.phase !== undefined && !['launch-intent', 'running', 'failed'].includes(owner.phase))) throw new Error('Invalid dedicated browser owner record')
    return owner
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
}

/** Chrome is detached from each SDK request's process group and is never killed on call cleanup. */
export async function openBrowser(connection: WebConnection, deadlineMs: number, signal?: AbortSignal): Promise<CdpConnection> {
  checkDeadline(deadlineMs,signal)
  const store = await BrowserStore.open(connection)
  const existing = await endpoint(store.profilePath)
  if (existing) {
    try { return await CdpConnection.connect(existing,deadlineMs) }
    catch { checkDeadline(deadlineMs,signal) /* Diagnose the owned process under the startup lock. */ }
  }
  return await withOwnerLock(join(store.coordinationDir, 'startup.mutex-v1'), async () => {
    checkDeadline(deadlineMs,signal)
    const owner = await browserOwner(store)
    const ready = await endpoint(store.profilePath)
    if (ready) {
      try { return await CdpConnection.connect(ready,deadlineMs) }
      catch (connectionError) {
        if (!owner) throw new Error('Existing dedicated browser endpoint is unreachable and its owner is unknown', { cause: connectionError })
        if(!processExited(owner.pid))throw new Error('Dedicated browser is still owned by a live or unknown process; reconnect without launching another browser')
        await rm(join(store.profilePath,'DevToolsActivePort'))
      }
    }
    if (owner && owner.phase !== 'failed' && !processExited(owner.pid)) {
      // A cancelled launcher does not own Chrome's lifetime. Its already live
      // process may still be starting. A launch-intent without a recorded PID
      // is uncertain even after the launcher dies, and must never spawn twice.
      const startupDeadline = Math.min(deadlineMs, Date.now() + 20_000)
      for (;;) {
        checkDeadline(startupDeadline, signal)
        const available = await endpoint(store.profilePath)
        if (available) return await CdpConnection.connect(available, deadlineMs)
        if (processExited(owner.pid)) break
        await wait(100, startupDeadline, signal)
      }
    }
    checkDeadline(deadlineMs,signal)
    await store.assertExecutable(connection.browserPath)
    checkDeadline(deadlineMs,signal)
    const ownerPath = join(store.coordinationDir, 'chrome-owner.json')
    await atomicPrivateWrite(ownerPath, JSON.stringify({ version: 1, phase: 'launch-intent', launcherPid: process.pid, profilePath: store.profilePath, launchedAt: Date.now() } satisfies BrowserOwner))
    try { checkDeadline(deadlineMs, signal) }
    catch (error) {
      await atomicPrivateWrite(ownerPath, JSON.stringify({ version: 1, phase: 'failed', launcherPid: process.pid, profilePath: store.profilePath } satisfies BrowserOwner))
      throw error
    }
    let spawnError: Error | undefined
    const child = spawn(connection.browserPath, [
      `--user-data-dir=${store.profilePath}`, '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', 'about:blank',
    ], { detached: true, stdio: 'ignore', windowsHide: false })
    child.once('error', (error) => { spawnError = error })
    child.unref()
    try { await new Promise<void>((resolve,reject)=>{child.once('spawn',()=>resolve());child.once('error',reject)}) }
    catch (error) {
      // A spawn error is positive proof that no Chrome process was created.
      await atomicPrivateWrite(ownerPath, JSON.stringify({ version: 1, phase: 'failed', launcherPid: process.pid, profilePath: store.profilePath } satisfies BrowserOwner))
      throw error
    }
    if(!child.pid)throw new Error('Dedicated browser did not provide a process identity')
    await atomicPrivateWrite(ownerPath,JSON.stringify({version:1,phase:'running',pid:child.pid,launcherPid:process.pid,profilePath:store.profilePath,launchedAt:Date.now()} satisfies BrowserOwner))
    const launchDeadline = Math.min(deadlineMs, Date.now() + 20_000)
    for (;;) {
      if (spawnError) throw spawnError
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Dedicated browser exited before CDP was ready')
      const launched = await endpoint(store.profilePath)
      if (launched) return CdpConnection.connect(launched, deadlineMs)
      await wait(100, launchDeadline,signal)
    }
  }, { waitMs: Math.max(0,Math.min(20_000,deadlineMs-Date.now())),...(signal?{signal}:{}) })
}

export class CdpPage {
  readonly cdp: CdpConnection
  readonly targetId: string
  readonly sessionId: string
  private constructor(cdp: CdpConnection, targetId: string, sessionId: string) {
    this.cdp = cdp; this.targetId = targetId; this.sessionId = sessionId
  }

  static async create(cdp: CdpConnection, targetId?: string): Promise<CdpPage> {
    let id = targetId
    if (!id) {
      const result = await cdp.command<{ targetId: string }>('Target.createTarget', { url: 'about:blank', background: true })
      id = result.targetId
    }
    const attached = await cdp.command<{ sessionId: string }>('Target.attachToTarget', { targetId: id, flatten: true })
    const page = new CdpPage(cdp, id, attached.sessionId)
    await cdp.command('Page.enable', {}, attached.sessionId)
    await cdp.command('Runtime.enable', {}, attached.sessionId)
    return page
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.cdp.command<{ result: { value?: T; subtype?: string; description?: string }; exceptionDetails?: unknown }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, this.sessionId)
    if (result.exceptionDetails || result.result.subtype === 'error') throw new Error('ChatGPT page adapter could not evaluate the supported layout')
    return result.result.value as T
  }
  async navigate(url: string): Promise<void> {
    const parsed = new URL(url)
    if (parsed.origin !== 'https://chatgpt.com' || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Unsupported ChatGPT conversation URL')
    await this.cdp.command('Page.navigate', { url }, this.sessionId)
  }
  async insertText(text: string): Promise<void> { await this.cdp.command('Input.insertText', { text }, this.sessionId) }
  /** Resolve one actual composer input in the bound document; never set a guessed node id. */
  async setFileInputFiles(files: readonly string[], expectedUrl: string): Promise<void> {
    const result = await this.cdp.command<{ result: { objectId?: string; subtype?: string }; exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression: `(() => { if(location.href!==${JSON.stringify(expectedUrl)}) throw new Error('Upload document changed'); const input=(${composerImageInput.toString()})(); if(${files.length}>1&&!input.multiple) throw new Error('Composer does not accept this image batch'); return input; })()`,
      returnByValue: false,
    }, this.sessionId)
    const objectId = result.result.objectId
    if (result.exceptionDetails || result.result.subtype === 'error' || !objectId) throw new Error('The supported composer image upload input is unavailable')
    try { await this.cdp.command('DOM.setFileInputFiles', { files: [...files], objectId }, this.sessionId) }
    finally { await this.cdp.command('Runtime.releaseObject', { objectId }, this.sessionId).catch(() => {}) }
    const selected = await this.evaluate<{ url: string; files: Array<{ name: string; size: number }> }>(`(() => { const input=(${composerImageInput.toString()})(); return {url:location.href,files:[...input.files??[]].map(f=>({name:f.name,size:f.size}))}; })()`)
    // A React uploader may immediately clear FileList. Upload completion is
    // proved separately from composer tiles, never from this setter returning.
    if (selected.url !== expectedUrl) throw new Error('Upload document changed after file selection')
    if (selected.files.length && (selected.files.length !== files.length || selected.files.some((file, index) => file.name !== files[index]!.split(/[\\/]/).at(-1)))) throw new Error('Browser selected different image files')
  }
  async escape(): Promise<void> {
    await this.cdp.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, this.sessionId)
    await this.cdp.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, this.sessionId)
  }
  /** Detach only. Keeping the owned tab allows cloud-state reconciliation and user inspection. */
  async close(): Promise<void> {
    this.cdp.beginCleanup()
    try { await this.cdp.command('Target.detachFromTarget', { sessionId: this.sessionId }) } finally { this.cdp.close() }
  }
}
