/** Owner-only durable runtime metadata. No PID-based lock reclamation. */
import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { link, lstat, mkdir, open, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { WebBridgeError } from '../web-bridge/contracts.ts'
import { canonical } from '../web-bridge/protocol.ts'

export function runtimeError(code: string, message: string, cause?: unknown): WebBridgeError {
  return new WebBridgeError(code, message, 409, cause === undefined ? undefined : { cause })
}

export function ioCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function privateMode(info: Stats, directory: boolean): void {
  if (typeof process.getuid !== 'function' || info.uid !== process.getuid() || (info.mode & 0o077) !== 0
    || (directory ? !info.isDirectory() : !info.isFile())) {
    throw runtimeError('WEB_RUNTIME_PERMISSIONS', 'Runtime state must be owner-only, owned by the current user, and contain no symlink metadata files.')
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const fd = await open(path, 'r')
  try { await fd.sync() } finally { await fd.close() }
}

export async function privateDirectory(path: string, initialize = false): Promise<string> {
  if (typeof process.getuid !== 'function' || constants.O_NOFOLLOW === undefined) throw runtimeError('WEB_PLATFORM_UNSUPPORTED', 'Managed Web runtime requires POSIX process and storage ownership.')
  if (initialize) {
    const first = await mkdir(path, { recursive: true, mode: 0o700 })
    if (first !== undefined) {
      const stop = dirname(await realpath(first))
      let cursor = await realpath(path)
      for (;;) { await syncDirectory(cursor); if (cursor === stop) break; cursor = dirname(cursor) }
    }
  }
  const physical = await realpath(path)
  privateMode(await lstat(physical), true)
  return physical
}

export async function readPrivateJson<T>(path: string): Promise<T | undefined> {
  try {
    privateMode(await lstat(path), false)
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await fd.stat()
      privateMode(info, false)
      if (info.size > 1024 * 1024) throw runtimeError('WEB_RUNTIME_STATE', 'Runtime metadata is too large.')
      const value: unknown = JSON.parse(await fd.readFile('utf8'))
      canonical(value)
      return value as T
    } finally { await fd.close() }
  } catch (error) {
    if (ioCode(error) === 'ENOENT') return undefined
    if (error instanceof WebBridgeError) throw error
    throw runtimeError('WEB_RUNTIME_STATE', 'Runtime metadata cannot be read safely; inspect it before continuing.', error)
  }
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await privateDirectory(dirname(path))
  const previous = await lstat(path).catch(error => { if (ioCode(error) === 'ENOENT') return undefined; throw error })
  if (previous !== undefined) privateMode(previous, false)
  const temporary = join(dirname(path), `.runtime-write-${randomUUID()}`)
  const fd = await open(temporary, 'wx', 0o600)
  try {
    await fd.writeFile(canonical(value), 'utf8')
    await fd.sync()
    await fd.close()
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } finally {
    await fd.close().catch(() => undefined)
    await rm(temporary, { force: true })
  }
}

/** Publish a complete first config once, even when two clients run setup. */
export async function createPrivateJson(path: string, value: unknown): Promise<boolean> {
  await privateDirectory(dirname(path))
  const temporary = join(dirname(path), `.runtime-create-${randomUUID()}`)
  const fd = await open(temporary, 'wx', 0o600)
  try {
    await fd.writeFile(canonical(value), 'utf8'); await fd.sync(); await fd.close()
    try { await link(temporary, path) } catch (error) { if (ioCode(error) === 'EEXIST') return false; throw error }
    await syncDirectory(dirname(path))
    return true
  } finally { await fd.close().catch(() => undefined); await rm(temporary, { force: true }) }
}

export async function acquireRuntimeLock(directory: string, instanceId: string): Promise<{ release(): Promise<void> }> {
  try { await mkdir(directory, { mode: 0o700 }) }
  catch (error) {
    if (ioCode(error) === 'EEXIST') throw runtimeError('WEB_RUNTIME_LOCKED', 'A runtime already owns this state directory. Unverified stale locks require offline inspection.')
    throw error
  }
  const token = randomUUID()
  const ownerPath = join(directory, 'owner.json')
  try { await writePrivateJson(ownerPath, { instanceId, token, pid: process.pid }); await syncDirectory(dirname(directory)) }
  catch (error) { await rm(ownerPath, { force: true }); await rmdir(directory); throw error }
  let released = false
  return { async release() {
    if (released) return
    const owner = await readPrivateJson<{ instanceId: string, token: string }>(ownerPath)
    if (owner?.instanceId !== instanceId || owner.token !== token) throw runtimeError('WEB_RUNTIME_OWNERSHIP', 'The runtime lock changed ownership; it will not be removed.')
    await rm(ownerPath); await rmdir(directory); await syncDirectory(dirname(directory)); released = true
  } }
}
