/** Private, content-addressed bytes. Journal records retain exact version references. */
import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { link, lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { WebBridgeError, type WebAttachmentVersion, type WebRequest } from './contracts.ts'
import { attachmentBytes, attachmentIdentity, validateAttachmentVersions } from './attachments.ts'

export interface WebImageStore {
  store(request: WebRequest): Promise<WebRequest>
  hydrate(request: WebRequest): Promise<WebRequest>
  verify(request: WebRequest): Promise<void>
}

function code(value: unknown): unknown {
  return value !== null && typeof value === 'object' && 'code' in value ? value.code : undefined
}

function privateEntry(value: Stats, kind: 'file' | 'directory'): void {
  if (typeof process.getuid !== 'function' || value.uid !== process.getuid() || (value.mode & 0o077) !== 0
    || (kind === 'file' ? !value.isFile() : !value.isDirectory())) {
    throw new WebBridgeError('WEB_ATTACHMENT_PERMISSIONS', 'Image evidence must be owner-only regular files in a private directory.', 503)
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

/** Existing evidence is never reset; a missing/corrupt referenced blob blocks reopening. */
export async function openWebImageStore(path: string, options: { initialize?: boolean } = {}): Promise<WebImageStore> {
  if (options.initialize) {
    const first = await mkdir(path, { recursive: true, mode: 0o700 })
    if (first !== undefined) {
      const parent = dirname(await realpath(first))
      let current = await realpath(path)
      for (;;) {
        await syncDirectory(current)
        if (current === parent) break
        current = dirname(current)
      }
    }
  }
  // Unlike the Chrome profile path, an image-store symlink is not a supported alias.
  try { privateEntry(await lstat(path), 'directory') } catch (cause) {
    if (cause instanceof WebBridgeError) throw cause
    throw new WebBridgeError('WEB_ATTACHMENT_STORE_MISSING', 'The private image evidence store is missing.', 503, { cause })
  }
  const directory = await realpath(path)
  const file = (version: WebAttachmentVersion): string => join(directory, version.digest.slice(7))
  const read = async (version: WebAttachmentVersion): Promise<Buffer> => {
    try {
      privateEntry(await lstat(file(version)), 'file')
      const handle = await open(file(version), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await handle.stat()
        privateEntry(stat, 'file')
        if (stat.size !== version.byteLength) throw new Error('Image evidence length differs')
        const bytes = await handle.readFile()
        attachmentBytes({ ...attachmentIdentity(version), base64: bytes.toString('base64') })
        return bytes
      } finally { await handle.close() }
    } catch (cause) {
      if (cause instanceof WebBridgeError && cause.code === 'WEB_ATTACHMENT_PERMISSIONS') throw cause
      throw new WebBridgeError('WEB_ATTACHMENT_EVIDENCE', 'Exact image evidence is missing or corrupt; offline inspection is required.', 503, { cause })
    }
  }
  const persist = async (version: WebAttachmentVersion): Promise<void> => {
    if (version.blobId !== undefined) { await read(version); return }
    const bytes = attachmentBytes(version)
    const temporary = join(directory, `.image-${randomUUID()}`)
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      try { await link(temporary, file(version)) } catch (cause) {
        if (code(cause) !== 'EEXIST') throw cause
        await read(version)
      }
      await syncDirectory(directory)
    } finally { await rm(temporary, { force: true }) }
  }
  return {
    async store(request) {
      const versions = validateAttachmentVersions(request.attachmentVersions)
      for (const version of versions) await persist(version)
      return { ...request, attachmentVersions: versions.map(version => ({ ...attachmentIdentity(version), blobId: version.digest })) }
    },
    async hydrate(request) {
      const versions = validateAttachmentVersions(request.attachmentVersions)
      const hydrated: WebAttachmentVersion[] = []
      for (const version of versions) {
        const bytes = version.base64 === undefined ? await read(version) : attachmentBytes(version)
        hydrated.push({ ...attachmentIdentity(version), base64: bytes.toString('base64') })
      }
      return { ...request, attachmentVersions: hydrated }
    },
    async verify(request) {
      for (const version of validateAttachmentVersions(request.attachmentVersions)) await read(version)
    },
  }
}
