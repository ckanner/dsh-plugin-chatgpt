/** Durable snapshots and deliberately non-reclaiming physical-profile locks. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { WebBridgeError, type WebBinding } from './contracts.ts'

export const JOURNAL_FILE = 'web-bridge-journal.json'
export const PROFILE_LOCK = '.web-bridge-profile-lock'
export const JOURNAL_LOCK = '.web-bridge-journal-lock'
const PROFILE_STORE = '.web-bridge-store.json'
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024

export type JournalFaultPoint = 'before-write' | 'after-write' | 'after-file-sync' | 'after-rename' | 'after-directory-sync'
/** Local test seam only; never exposed through the bridge protocol. */
export type JournalFault = (point: JournalFaultPoint, snapshot: unknown) => void | Promise<void>

function ioCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined
}

function checksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requirePrivate(details: Stats, kind: 'file' | 'directory'): void {
  if (typeof process.getuid !== 'function' || details.uid !== process.getuid()
    || (details.mode & 0o077) !== 0
    || (kind === 'file' ? !details.isFile() : !details.isDirectory())) {
    throw new WebBridgeError('WEB_JOURNAL_PERMISSIONS', 'Web state must be owned by the current OS user, owner-only, and contain regular files rather than symlinks.', 503)
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function initializeDirectory(path: string): Promise<void> {
  const firstCreated = await mkdir(path, { recursive: true, mode: 0o700 })
  if (firstCreated === undefined) return
  const existingParent = dirname(await realpath(firstCreated))
  let current = await realpath(path)
  // Syncing a new directory's contents alone does not establish the durability
  // of its name in its parent. Preserve the entire newly created setup chain.
  while (true) {
    await syncDirectory(current)
    if (current === existingParent) break
    current = dirname(current)
  }
}

/** A rename is not a durability barrier until both the file and parent are synced. */
async function atomicWrite(path: string, value: unknown, fault?: JournalFault): Promise<void> {
  const encoded = JSON.stringify({ version: 1, checksum: checksum(value), value })
  if (Buffer.byteLength(encoded) > MAX_JOURNAL_BYTES) {
    throw new WebBridgeError('WEB_JOURNAL_LIMIT', 'The Web journal is full; inspect it before admitting more work.', 507)
  }
  const temporary = join(dirname(path), `.web-write-${randomUUID()}`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    await fault?.('before-write', value)
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(encoded, 'utf8')
    await fault?.('after-write', value)
    await handle.sync()
    await fault?.('after-file-sync', value)
    await handle.close()
    handle = undefined
    await rename(temporary, path)
    await fault?.('after-rename', value)
    await syncDirectory(dirname(path))
    await fault?.('after-directory-sync', value)
  } finally {
    await handle?.close()
    await rm(temporary, { force: true })
  }
}

async function readSnapshot(path: string): Promise<unknown | undefined> {
  let text: string
  try {
    requirePrivate(await lstat(path), 'file')
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const details = await handle.stat()
      requirePrivate(details, 'file')
      if (details.size > MAX_JOURNAL_BYTES) throw new Error('Invalid journal file size')
      text = await handle.readFile('utf8')
    } finally { await handle.close() }
  } catch (error) {
    if (ioCode(error) === 'ENOENT') return undefined
    if (error instanceof WebBridgeError) throw error
    throw new WebBridgeError('WEB_JOURNAL_CORRUPT', 'Cannot read the Web journal; offline inspection is required.', 503, { cause: error })
  }
  try {
    const envelope: unknown = JSON.parse(text)
    if (!record(envelope) || envelope.version !== 1 || typeof envelope.checksum !== 'string'
      || !('value' in envelope) || envelope.checksum !== checksum(envelope.value)) {
      throw new Error('Invalid journal envelope or checksum')
    }
    return envelope.value
  } catch (error) {
    throw new WebBridgeError('WEB_JOURNAL_CORRUPT', 'The Web journal is corrupt; offline inspection is required.', 503, { cause: error })
  }
}

interface OwnedLock {
  release(): Promise<void>
}

async function acquireLock(directory: string, instanceId: string): Promise<OwnedLock> {
  try {
    await mkdir(directory, { mode: 0o700 })
  } catch (error) {
    if (ioCode(error) === 'EEXIST') {
      throw new WebBridgeError('WEB_PROFILE_LOCKED', 'The Web profile or journal is locked. A stale lock requires explicit offline inspection; PID checks do not reclaim it.', 409)
    }
    throw error
  }
  const token = randomUUID()
  const ownerPath = join(directory, 'owner.json')
  let released = false
  try {
    await atomicWrite(ownerPath, { instanceId, token, pid: process.pid })
    await syncDirectory(dirname(directory))
  } catch (error) {
    // No transport has been created; this invocation still owns the freshly
    // created directory. Unexpected contents are never recursively removed.
    await rm(ownerPath, { force: true }).catch(() => undefined)
    await rmdir(directory).catch(() => undefined)
    throw error
  }
  return {
    async release() {
      if (released) return
      const owner = await readSnapshot(ownerPath)
      if (!record(owner) || owner.token !== token || owner.instanceId !== instanceId) {
        throw new WebBridgeError('WEB_LOCK_OWNERSHIP', 'The profile lock changed ownership; it will not be removed.', 503)
      }
      await rm(ownerPath)
      await rmdir(directory)
      await syncDirectory(dirname(directory))
      released = true
    },
  }
}

export interface JournalStore<T> {
  readonly value: T
  readonly directory: string
  readonly profileDirectory: string
  write(value: T): Promise<void>
  close(): Promise<void>
}

interface OpenJournalOptions<T> {
  directory: string
  profileDirectory: string
  binding: WebBinding
  instanceId: string
  initialize: boolean
  initial: T
  validate(value: unknown): T
  fault?: JournalFault
}

/**
 * A profile permanently names its evidence store. Opening another journal must
 * not make an earlier uncertain submission disappear. Neither lock is stolen
 * after a crash: recovery of a stale lock is an explicit offline operation.
 */
export async function openJournal<T>(options: OpenJournalOptions<T>): Promise<JournalStore<T>> {
  if (typeof process.getuid !== 'function' || constants.O_NOFOLLOW === undefined) {
    throw new WebBridgeError('WEB_PLATFORM_UNSUPPORTED', 'This journal currently requires POSIX ownership, no-follow file reads, and directory fsync.', 503)
  }
  if (options.initialize) {
    await initializeDirectory(options.directory)
    await initializeDirectory(options.profileDirectory)
  }
  let directory: string
  let profileDirectory: string
  try {
    directory = await realpath(options.directory)
    profileDirectory = await realpath(options.profileDirectory)
  } catch (error) {
    throw new WebBridgeError('WEB_SETUP_REQUIRED', 'The Web profile and journal must be explicitly initialized.', 503, { cause: error })
  }
  requirePrivate(await lstat(directory), 'directory')
  requirePrivate(await lstat(profileDirectory), 'directory')
  const profileLock = await acquireLock(join(profileDirectory, PROFILE_LOCK), options.instanceId)
  let journalLock: OwnedLock | undefined
  try {
    journalLock = await acquireLock(join(directory, JOURNAL_LOCK), options.instanceId)
    const path = join(directory, JOURNAL_FILE)
    const markerPath = join(profileDirectory, PROFILE_STORE)
    const identity = { version: 1, directory, profileDirectory, binding: options.binding }
    const marker = await readSnapshot(markerPath)
    let persisted = await readSnapshot(path)
    if (marker === undefined && persisted === undefined && options.initialize) {
      // Marker first: an interrupted first setup must fail closed, not resemble
      // another clean initialization that may forget already-admitted work.
      await atomicWrite(markerPath, identity)
      await atomicWrite(path, options.initial, options.fault)
      persisted = options.initial
    } else if (marker === undefined || persisted === undefined) {
      throw new WebBridgeError('WEB_JOURNAL_MISSING', 'Web journal identity or evidence is missing. Explicit setup cannot reset an existing profile.', 503)
    } else if (checksum(marker) !== checksum(identity)) {
      throw new WebBridgeError('WEB_JOURNAL_BINDING', 'This physical profile belongs to a different journal or account binding.', 409)
    }
    let value: T
    try {
      value = options.validate(persisted)
    } catch (error) {
      throw new WebBridgeError('WEB_JOURNAL_CORRUPT', 'The Web journal fails semantic validation; offline inspection is required.', 503, { cause: error })
    }
    let closed = false
    let failed = false
    const store: JournalStore<T> = {
      get value() { return value },
      directory,
      profileDirectory,
      async write(next) {
        if (closed || failed) throw new WebBridgeError('WEB_JOURNAL_UNAVAILABLE', 'This journal is closed or has an unresolved write failure.', 503)
        try {
          await atomicWrite(path, next, options.fault)
          value = next
        } catch (error) {
          failed = true
          throw new WebBridgeError('WEB_JOURNAL_WRITE', 'The Web journal could not establish durability; no further work is admitted.', 503, { cause: error })
        }
      },
      async close() {
        if (closed) return
        closed = true
        // The engine must await all transport operations before reaching here.
        await journalLock?.release()
        await profileLock.release()
      },
    }
    return store
  } catch (error) {
    await journalLock?.release().catch(() => undefined)
    await profileLock.release().catch(() => undefined)
    throw error
  }
}
