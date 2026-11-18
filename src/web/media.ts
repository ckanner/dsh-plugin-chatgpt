/** Host-owned image references become bounded private artifacts, never URL/path guesses. */
import { constants } from 'node:fs'
import { lstat, open, realpath, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentReader, ImageAttachmentRef } from '../convert/images.ts'
import { abortable } from '../abort.ts'
import { canonical, digest as identityDigest, WebPolicyError } from './policy.ts'
import { checkDeadline, digest, privateDirectory } from './browser/storage.ts'
import type { WebMediaAttachment } from './browser/types.ts'
import { DEFAULT_WEB_IMAGE_LIMITS, imageLimits, MAX_WEB_IMAGE_LIMITS, type WebImageLimits } from './image-policy.ts'
import { withOwnerLock } from './store.ts'

/** Local upload admission limits, not claims about the website's quota or context window. */
export const WEB_IMAGE_POLICY = Object.freeze({
  version: 'web-images/1', ...DEFAULT_WEB_IMAGE_LIMITS,
  absoluteLimits: MAX_WEB_IMAGE_LIMITS,
  mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const),
  roles: Object.freeze(['user', 'tool'] as const), fileInput: false,
})
const extensions: Record<ImageAttachmentRef['mediaType'], string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
function failed(reason: string): WebPolicyError { return new WebPolicyError(`image media: ${reason}`, 'UNSUPPORTED_CONTENT') }

export function webImageRef(value: unknown): ImageAttachmentRef {
  if (!record(value) || typeof value.attachmentId !== 'string' || !value.attachmentId || value.attachmentId.length > 512 || /[\u0000-\u001f]/.test(value.attachmentId)
    || !WEB_IMAGE_POLICY.mediaTypes.includes(value.mediaType as never)
    || !['bytes', 'width', 'height'].every(key => Number.isSafeInteger(value[key]) && Number(value[key]) > 0)) throw failed('a valid durable image reference is required')
  if (Number(value.bytes) > MAX_WEB_IMAGE_LIMITS.maxImageBytes) throw failed('image exceeds the absolute per-image byte limit')
  return { attachmentId: value.attachmentId, mediaType: value.mediaType as ImageAttachmentRef['mediaType'], bytes: Number(value.bytes), width: Number(value.width), height: Number(value.height) }
}

/** This checks the declared format; decoding and original digest validation belong to readImage. */
export function verifyImageSignature(data: Uint8Array, mediaType: ImageAttachmentRef['mediaType']): void {
  const bytes = Buffer.from(data)
  const valid = mediaType === 'image/png' ? bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii', 12, 16) === 'IHDR'
    : mediaType === 'image/jpeg' ? bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217
    : mediaType === 'image/webp' ? bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) === bytes.length - 8
    : bytes.length >= 14 && /^(GIF87a|GIF89a)$/.test(bytes.toString('ascii', 0, 6)) && bytes[bytes.length - 1] === 0x3b
  if (!valid) throw failed('attachment bytes do not match their declared image format')
}

export function webImageName(attachment: Pick<WebMediaAttachment, 'attachmentId' | 'mediaType' | 'messageIndex' | 'blockIndex' | 'role' | 'toolCallId'>, sha256: string): string {
  const occurrence = identityDigest({ attachmentId: attachment.attachmentId, messageIndex: attachment.messageIndex, blockIndex: attachment.blockIndex, role: attachment.role, toolCallId: attachment.toolCallId ?? null })
  return `dsh-${occurrence.slice(0, 20)}-${sha256.slice(0, 20)}.${extensions[attachment.mediaType]}`
}

/** Validate metadata before a browser can see a local filename. */
export function validateWebMedia(media: readonly WebMediaAttachment[] | undefined): void {
  if (media === undefined) return
  if (!Array.isArray(media) || media.length === 0 || media.length > MAX_WEB_IMAGE_LIMITS.maxImages) throw failed('image count exceeds the absolute upload limit')
  const names = new Set<string>(), occurrences = new Set<string>()
  let total = 0
  for (const item of media as readonly WebMediaAttachment[]) {
    if (!record(item as unknown) || item.version !== 1 || !['user', 'tool'].includes(item.role)
      || !Number.isSafeInteger(item.messageIndex) || item.messageIndex < 0 || !Number.isSafeInteger(item.blockIndex) || item.blockIndex < 0
      || (item.role === 'tool' && (typeof item.toolCallId !== 'string' || !item.toolCallId))
      || (item.role === 'user' && item.toolCallId !== undefined)
      || !record(item.artifact as unknown) || typeof item.artifact.path !== 'string' || !isAbsolute(item.artifact.path) || typeof item.artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.artifact.sha256)) throw failed('invalid original image occurrence or artifact')
    webImageRef({ ...item, bytes: item.artifact.bytes })
    if (item.uploadName !== webImageName(item, item.artifact.sha256) || basename(item.artifact.path) !== item.uploadName) throw failed('upload filename does not match the original occurrence and digest')
    const occurrence = `${item.messageIndex}:${item.blockIndex}`
    if (names.has(item.uploadName) || occurrences.has(occurrence)) throw failed('duplicate image occurrence')
    names.add(item.uploadName); occurrences.add(occurrence); total += item.artifact.bytes
  }
  if (total > MAX_WEB_IMAGE_LIMITS.maxTotalBytes) throw failed('images exceed the absolute aggregate byte limit')
}

export async function readWebMediaArtifact(item: WebMediaAttachment, directory: string): Promise<Buffer> {
  validateWebMedia([item])
  // Recovery inspection is strictly read-only: a missing private directory is
  // missing evidence, never a reason to initialize a new store.
  if (!isAbsolute(directory)) throw failed('the private image directory must be absolute')
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())
    || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw failed('the private image directory is unsafe')
  const root = await realpath(directory)
  if (dirname(resolve(item.artifact.path)) !== root) throw failed('artifact escapes the bound private image directory')
  const file = await open(item.artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size !== item.artifact.bytes || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())
      || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw failed('artifact size, ownership or permissions changed')
    const data = await file.readFile()
    if (data.byteLength !== item.artifact.bytes || digest(data) !== item.artifact.sha256) throw failed('artifact bytes changed or were truncated')
    verifyImageSignature(data, item.mediaType)
    return data
  } finally { await file.close() }
}

async function saveImage(directory: string, item: WebMediaAttachment, data: Uint8Array, deadlineMs: number, signal?: AbortSignal): Promise<void> {
  await withOwnerLock(join(directory, 'publish-locks', item.uploadName), async () => {
    checkDeadline(deadlineMs, signal)
    try { await readWebMediaArtifact(item, directory); return }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const temp = join(directory, `${randomUUID()}.tmp`)
    const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      try { await file.writeFile(data); await file.sync() } finally { await file.close() }
      checkDeadline(deadlineMs, signal)
      // The owner lock serializes publishers. Atomic rename leaves one link,
      // including if the writer exits immediately after publication. Existing
      // artifacts were verified above and are never rewritten by a later turn.
      await rename(temp, item.artifact.path)
      if (process.platform !== 'win32') {
        const parent = await open(directory, constants.O_RDONLY)
        try { await parent.sync() } finally { await parent.close() }
      }
      await readWebMediaArtifact(item, directory)
    } finally { await rm(temp, { force: true }) }
  }, { waitMs: Math.max(1, Math.min(60_000, deadlineMs - Date.now())), ...(signal ? { signal } : {}) })
}

/** Resolve before publishing any browser intent. The original host request retains its references. */
export async function prepareWebMedia(options: GenerateOptions, directory: string, resolveAttachments: (() => unknown) | undefined, deadlineMs: number, configured: WebImageLimits = DEFAULT_WEB_IMAGE_LIMITS, fromMessage = 0): Promise<WebMediaAttachment[]> {
  checkDeadline(deadlineMs, options.signal)
  const limits = imageLimits(configured)
  if (!Number.isSafeInteger(fromMessage) || fromMessage < 0 || fromMessage > options.messages.length) throw failed('invalid authoritative message suffix')
  const occurrences: Array<{ ref: ImageAttachmentRef; messageIndex: number; blockIndex: number; role: 'user' | 'tool'; toolCallId?: string }> = []
  const identities = new Map<string, string>()
  let total = 0
  for (const [messageIndex, message] of options.messages.entries()) {
    for (const [blockIndex, block] of message.content.entries()) {
      if (block.type === 'file') throw failed('ordinary file attachments are not supported; use an authorized local reading tool')
      if (block.type !== 'image') continue
      const ref = webImageRef(block.attachment)
      // Respect the host's explicit occurrence-level offload; never resurrect those bytes.
      if ((block as unknown as { offloaded?: boolean }).offloaded === true) continue
      if (message.role !== 'user' && message.role !== 'tool') throw failed('images are supported only in user messages and tool results')
      if (message.role === 'tool' && !message.toolCallId) throw failed('image tool result has no originating tool call id')
      const identity = canonical(ref)
      if (identities.has(ref.attachmentId) && identities.get(ref.attachmentId) !== identity) throw failed('conflicting references share an attachment id')
      identities.set(ref.attachmentId, identity)
      // Accepted prefix images already belong to this conversation. Neither
      // download nor count them again when uploading only the new suffix.
      if (messageIndex < fromMessage) continue
      if (ref.bytes > limits.maxImageBytes) throw failed('image exceeds the configured per-image byte limit')
      total += ref.bytes
      occurrences.push({ ref, messageIndex, blockIndex, role: message.role, ...(message.role === 'tool' ? { toolCallId: String(message.toolCallId) } : {}) })
    }
  }
  if (!occurrences.length) return []
  if (occurrences.length > limits.maxImages || total > limits.maxTotalBytes) throw failed('images exceed the configured count or aggregate byte limit; compact or offload through the host')
  const attachments = resolveAttachments?.()
  if (!record(attachments) || typeof attachments.readImage !== 'function') throw failed('the durable attachment service is unavailable')
  const root = await privateDirectory(directory)
  const reader = attachments as unknown as ImageAttachmentReader
  const read = new Map<string, Uint8Array>()
  const media: WebMediaAttachment[] = []
  for (const { ref, ...source } of occurrences) {
    checkDeadline(deadlineMs, options.signal)
    let data = read.get(ref.attachmentId)
    if (!data) {
      let stored: Awaited<ReturnType<ImageAttachmentReader['readImage']>>
      const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(deadlineMs - Date.now())))
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
      try { stored = await abortable(reader.readImage(ref, signal), signal) }
      catch (error) { checkDeadline(deadlineMs, options.signal); throw failed('the durable attachment could not be read or verified') }
      checkDeadline(deadlineMs, options.signal)
      if (!stored || !(stored.data instanceof Uint8Array) || stored.data.byteLength !== ref.bytes || canonical(webImageRef(stored.ref)) !== canonical(ref)) throw failed('attachment bytes or returned metadata do not match the original reference')
      verifyImageSignature(stored.data, ref.mediaType)
      data = Uint8Array.from(stored.data); read.set(ref.attachmentId, data)
    }
    const sha256 = digest(data)
    const name = webImageName({ ...source, ...ref }, sha256)
    const item: WebMediaAttachment = { version: 1, attachmentId: ref.attachmentId, mediaType: ref.mediaType, ...source, width: ref.width, height: ref.height, uploadName: name, artifact: { path: join(root, name), bytes: data.byteLength, sha256 } }
    await saveImage(root, item, data, deadlineMs, options.signal)
    checkDeadline(deadlineMs, options.signal)
    media.push(item)
  }
  validateWebMedia(media)
  return media
}

/** Order is kept in the original message manifest; the UI may reorder tiles. */
export function assertAcceptedWebMedia(media: readonly WebMediaAttachment[] | undefined, observed: readonly string[] | undefined): void {
  const expected = (media ?? []).map(item => item.uploadName).sort()
  const actual = [...observed ?? []].sort()
  if (canonical(expected) !== canonical(actual)) throw failed('accepted user message attachments do not match the submitted image manifest')
}
