import { constants } from 'node:fs'
import { access, link, lstat, mkdir, open, readFile, realpath, readdir, rename, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { WebArtifact, WebConnection, WebJournal, WebTurnRequest } from './types.ts'
import { withOwnerLock } from '../store.ts'

export const digest = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex')

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const dir = await open(path, constants.O_RDONLY)
  try { await dir.sync() } finally { await dir.close() }
}

export function checkDeadline(deadlineMs: number, signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  if (!Number.isFinite(deadlineMs) || Date.now() >= deadlineMs) throw new Error('Web call deadline exceeded')
}

export async function wait(ms: number, deadlineMs: number, signal?: AbortSignal): Promise<void> {
  checkDeadline(deadlineMs, signal)
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(done, Math.min(ms, Math.max(1, deadlineMs - Date.now())))
    function done(): void { signal?.removeEventListener('abort', abort); resolvePromise() }
    function abort(): void { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')) }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
  checkDeadline(deadlineMs, signal)
}

export async function privateDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Browser and state directories must be absolute paths')
  await mkdir(path, { recursive: true, mode: 0o700 })
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Private state directory must be a real directory')
  if (process.getuid && info.uid !== process.getuid()) throw new Error('Private state directory has another owner')
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('Private state directory must have mode 0700')
  return realpath(path)
}

/** fsync both data and directory. An ACK must never outrun its journal. */
export async function atomicPrivateWrite(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(text, 'utf8'); await file.sync() } finally { await file.close() }
  try {
    await rename(temp, path)
    await syncDirectory(dirname(path))
  } catch (error) { await rm(temp, { force: true }); throw error }
}

/** Atomically publish a fully written new record. A crash can leave only an
 * unreferenced temp file, never an empty lease or journal that blocks recovery. */
async function exclusivePrivateWrite(path: string, text: string): Promise<boolean> {
  const temp = `${path}.${randomUUID()}.tmp`
  const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(text, 'utf8'); await file.sync() } finally { await file.close() }
  try {
    try { await link(temp, path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error }
    await syncDirectory(dirname(path))
    return true
  } finally { await rm(temp, { force: true }) }
}

/** ESRCH is positive exit evidence; EPERM and PID reuse remain unknown/live. */
export function processExited(pid: number | undefined): boolean {
  if (!Number.isSafeInteger(pid) || !pid || pid < 1 || pid === process.pid) return false
  try { process.kill(pid, 0); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}

export async function privateRead(path: string, maxBytes = 32 * 1024 * 1024): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maxBytes || (process.getuid && stat.uid !== process.getuid())) throw new Error('Invalid private artifact')
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('Private artifact permissions are too broad')
    return await file.readFile('utf8')
  } finally { await file.close() }
}

interface LeaseRecord { version: 1; requestId: string; journalPath: string; owner: string; pid: number; retained?: 'awaiting-ack' | 'unresolved' | true }

export class BrowserStore {
  readonly profilePath: string
  readonly stateDir: string
  readonly coordinationDir: string
  private constructor(profilePath: string, stateDir: string, coordinationDir: string) {
    this.profilePath = profilePath; this.stateDir = stateDir; this.coordinationDir = coordinationDir
  }

  static async open(connection: WebConnection): Promise<BrowserStore> {
    if (!isAbsolute(connection.profilePath)) throw new Error('Dedicated profile path must be absolute')
    await mkdir(connection.profilePath, { recursive: true, mode: 0o700 })
    // Aliases intentionally converge on the actual profile, not the configured connection ID.
    const profile = await realpath(connection.profilePath)
    await privateDirectory(profile)
    const marker = join(profile, '.dsh-chatgpt-profile.json')
    try {
      const value = JSON.parse(await privateRead(marker, 1024)) as { version?: unknown; uid?: unknown }
      if (value.version !== 1 || value.uid !== (process.getuid?.() ?? 'windows-user')) throw new Error('Unrecognized browser profile owner')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const existing = await readdir(profile)
      if (existing.length) throw new Error('Refusing to adopt a non-empty browser profile; choose a new dedicated directory')
      const file = await open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await file.writeFile(JSON.stringify({ version: 1, uid: process.getuid?.() ?? 'windows-user' })); await file.sync() } finally { await file.close() }
    }
    const stateDir = await privateDirectory(connection.stateDir)
    const coordinationDir = await privateDirectory(join(profile, '.dsh-web-runtime'))
    await privateDirectory(join(stateDir, 'calls'))
    await privateDirectory(join(stateDir, 'artifacts'))
    return new BrowserStore(profile, stateDir, coordinationDir)
  }

  journalPath(id: string): string { return join(this.stateDir, 'calls', `${digest(id)}.json`) }
  async create(journal: WebJournal): Promise<boolean> {
    return await exclusivePrivateWrite(this.journalPath(journal.request.requestId), JSON.stringify(journal))
  }
  async get(id: string): Promise<WebJournal | undefined> {
    try {
      const journal = JSON.parse(await privateRead(this.journalPath(id))) as WebJournal
      if (journal.version !== 1 || journal.request?.requestId !== id || !journal.facts || !journal.phase) throw new Error('Malformed browser journal')
      return journal
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  }
  async put(journal: WebJournal): Promise<void> {
    journal.updatedAt = Date.now()
    await atomicPrivateWrite(this.journalPath(journal.request.requestId), JSON.stringify(journal))
  }
  async artifact(id: string, text: string): Promise<WebArtifact> {
    const path = join(this.stateDir, 'artifacts', `${digest(id)}.txt`)
    if (!await exclusivePrivateWrite(path, text)) {
      if (await privateRead(path, 16*1024*1024) !== text) throw new Error('An existing response artifact differs; recovery cannot overwrite it')
    }
    return { path, bytes: Buffer.byteLength(text), sha256: digest(text) }
  }
  async readArtifact(artifact: WebArtifact, maxBytes: number): Promise<string> {
    const path = resolve(artifact.path)
    if (dirname(path) !== join(this.stateDir, 'artifacts') || !/^[a-f0-9]{64}\.txt$/.test(path.split(/[\\/]/).at(-1) ?? '')) throw new Error('Artifact path escapes the bound directory')
    const text = await privateRead(path, maxBytes)
    if (Buffer.byteLength(text) !== artifact.bytes || digest(text) !== artifact.sha256) throw new Error('Artifact is truncated or changed')
    return text
  }
  async acquire(request: WebTurnRequest, recover = false): Promise<{ release: () => Promise<void>; retain: (reason?: 'awaiting-ack' | 'unresolved') => void }> {
    const lock = join(this.coordinationDir, 'turn.lock')
    const owner = randomUUID()
    for (;;) {
      checkDeadline(request.deadlineMs, request.signal)
      try {
        const record: LeaseRecord = { version: 1, requestId: request.requestId, journalPath: this.journalPath(request.requestId), owner, pid: process.pid }
        if (!await exclusivePrivateWrite(lock, JSON.stringify(record))) throw Object.assign(new Error('Browser turn is leased'), { code: 'EEXIST' })
        let retained: 'awaiting-ack' | 'unresolved' | undefined
        return {
          retain: (reason = 'unresolved') => { retained = reason },
          release: async () => {
            const current = JSON.parse(await privateRead(lock, 8192)) as LeaseRecord
            if (current.owner !== owner) throw new Error('Browser lease ownership changed')
            if (retained) { await atomicPrivateWrite(lock, JSON.stringify({ ...current, retained })); return }
            await rm(lock)
            await syncDirectory(this.coordinationDir)
          },
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        let current: LeaseRecord
        try { current = JSON.parse(await privateRead(lock, 8192)) as LeaseRecord }
        catch (readError) { if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue; throw readError }
        if (current.version !== 1 || !current.owner || !current.journalPath) throw new Error('Malformed browser lease')
        if (current.requestId === request.requestId || recover) throw new Error('An existing browser lease requires read-only recovery; it cannot be replayed')
        if (current.retained && current.retained !== 'awaiting-ack') throw new Error('An unresolved remote call retains this connection; recover its journal before continuing')
        try { process.kill(current.pid, 0) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') throw new Error('Previous browser owner exited with an unresolved call; recover its journal before continuing')
          throw error
        }
        // A healthy captured turn still owns admission until the host has
        // validated and durably committed it. Other conversations wait here;
        // an unknown result never turns back into spare connection capacity.
        await wait(100, request.deadlineMs, request.signal)
      }
    }
  }
  async assertConversationAvailable(conversationId: string, requestId: string): Promise<void> {
    const path = join(this.coordinationDir, `conversation-${digest(conversationId)}.json`)
    try {
      const existing = JSON.parse(await privateRead(path, 8192)) as { requestId: string }
      if (existing.requestId !== requestId) throw new Error('Previous response is awaiting a durable host ACK')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  async holdConversation(conversationId: string, requestId: string): Promise<void> {
    await this.assertConversationAvailable(conversationId, requestId)
    await atomicPrivateWrite(join(this.coordinationDir, `conversation-${digest(conversationId)}.json`), JSON.stringify({ version: 1, requestId, journalPath: this.journalPath(requestId) }))
  }
  async releaseConversation(conversationId: string, requestId: string, onlyIfOwned = false): Promise<void> {
    const path = join(this.coordinationDir, `conversation-${digest(conversationId)}.json`)
    let existing: { requestId: string }
    try { existing = JSON.parse(await privateRead(path,8192)) as typeof existing }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (existing.requestId !== requestId) { if (onlyIfOwned) return; throw new Error('Host ACK cannot release another invocation') }
    await rm(path)
    await syncDirectory(this.coordinationDir)
  }
  async withAcknowledgement<T>(requestId: string, callback: () => Promise<T>): Promise<T> {
    return await withOwnerLock(join(this.coordinationDir,`ack-${digest(requestId)}.mutex-v1`),callback)
  }
  async releaseResolvedTurn(requestId: string): Promise<void> {
    const path = join(this.coordinationDir, 'turn.lock')
    let current: LeaseRecord
    try { current = JSON.parse(await privateRead(path, 8192)) as LeaseRecord }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (current.requestId !== requestId || current.journalPath !== this.journalPath(requestId)) return
    if (!current.retained) {
      try { process.kill(current.pid, 0); throw new Error('Cannot release a browser call that still has an active owner') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
    // The normal owner never removes a retained lease. Other recoveries may remove it;
    // no caller can acquire a replacement until this unlink completes.
    await rm(path, { force: true })
    await syncDirectory(this.coordinationDir)
  }
  async assertExecutable(path: string): Promise<void> { await access(path, constants.X_OK) }
}
