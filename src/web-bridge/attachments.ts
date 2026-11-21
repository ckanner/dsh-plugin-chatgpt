/** Exact attachment versions, independent of paths, URLs or mutable host references. */
import { createHash } from 'node:crypto'
import { prepareImages } from '../convert/images.ts'
import type { HarnessRequest } from '../adapter.ts'
import { WEB_MAX_REQUEST_BYTES, WebBridgeError, type WebAttachmentVersion } from './contracts.ts'
import type { CapturedWebRequest } from './request.ts'

export const WEB_MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const WEB_MAX_IMAGES = 20
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as const

function invalid(message: string): never { throw new WebBridgeError('WEB_INVALID_ATTACHMENT', message, 400) }

export function imageDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export function uploadName(digest: string, mimeType: WebAttachmentVersion['mimeType']): string {
  return `dsh-${digest.slice(7)}.${extensions[mimeType]}`
}

function checkMagic(bytes: Buffer, type: WebAttachmentVersion['mimeType']): void {
  const matches = type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : type === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
    : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  if (!matches) invalid('Attachment bytes do not match the declared image MIME type')
}

/** Decode only a bounded canonical base64 value, then verify its exact version. */
export function attachmentBytes(version: WebAttachmentVersion): Buffer {
  const base64 = version.base64
  if (typeof base64 !== 'string' || base64.length > Math.ceil(WEB_MAX_IMAGE_BYTES / 3) * 4) invalid('Inline image bytes are absent or too large')
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.toString('base64') !== base64 || bytes.byteLength !== version.byteLength || imageDigest(bytes) !== version.digest) {
    invalid('Attachment length or digest does not match its exact bytes')
  }
  checkMagic(bytes, version.mimeType)
  return bytes
}

export function validateAttachmentVersions(value: unknown): WebAttachmentVersion[] {
  if (!Array.isArray(value) || value.length > WEB_MAX_IMAGES) invalid('Too many image attachment versions')
  const seen = new Set<string>()
  const versions = value.map((raw: unknown): WebAttachmentVersion => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) invalid('Invalid attachment version')
    const item = raw as Record<string, unknown>
    if (Object.keys(item).some(key => !['id', 'digest', 'mimeType', 'byteLength', 'uploadName', 'base64', 'blobId'].includes(key))) invalid('Unsupported attachment field')
    if (typeof item['digest'] !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item['digest']) || item['id'] !== item['digest']) invalid('Invalid attachment identity')
    if (seen.has(item['id'])) invalid('Duplicate attachment version')
    seen.add(item['id'])
    if (typeof item['mimeType'] !== 'string' || !Object.hasOwn(extensions, item['mimeType'])) invalid('Unsupported image MIME type')
    if (!Number.isSafeInteger(item['byteLength']) || Number(item['byteLength']) <= 0 || Number(item['byteLength']) > WEB_MAX_IMAGE_BYTES) invalid('Invalid image byte length')
    const mimeType = item['mimeType'] as WebAttachmentVersion['mimeType']
    if (item['uploadName'] !== uploadName(item['digest'], mimeType)) invalid('Attachment upload name must be content-addressed')
    if ((item['base64'] !== undefined) === (item['blobId'] !== undefined)) invalid('Provide exactly one inline version or bridge-owned blob reference')
    const version: WebAttachmentVersion = { id: item['id'], digest: item['digest'], mimeType,
      byteLength: Number(item['byteLength']), uploadName: item['uploadName'] as string }
    if (item['base64'] !== undefined) {
      if (typeof item['base64'] !== 'string') invalid('Inline image bytes must be base64')
      version.base64 = item['base64']
      attachmentBytes(version)
    } else {
      if (item['blobId'] !== item['digest']) invalid('A blob reference must name this exact digest')
      version.blobId = item['digest']
    }
    return version
  })
  return versions.sort((left, right) => left.id.localeCompare(right.id))
}

export function attachmentIdentity(version: WebAttachmentVersion): Omit<WebAttachmentVersion, 'base64' | 'blobId'> {
  return { id: version.id, digest: version.digest, mimeType: version.mimeType, byteLength: version.byteLength, uploadName: version.uploadName }
}

/** Bound declared reads before the host reader allocates or base64-encodes any image. */
function preflight(snapshot: CapturedWebRequest): void {
  const references = new Map<string, number>()
  for (const message of snapshot.body.messages) for (const raw of message.content) {
    if (raw === null || typeof raw !== 'object' || !('type' in raw) || raw.type !== 'image') continue
    const block = raw as { attachment?: unknown, offloaded?: unknown }
    if (block.offloaded === true) continue
    const ref = block.attachment as { attachmentId?: unknown, bytes?: unknown } | undefined
    if (!ref || typeof ref.attachmentId !== 'string' || !ref.attachmentId || !Number.isSafeInteger(ref.bytes)
      || Number(ref.bytes) <= 0 || Number(ref.bytes) > WEB_MAX_IMAGE_BYTES) invalid('Each image requires a bounded durable reference of at most 20 MiB')
    const previous = references.get(ref.attachmentId)
    if (previous !== undefined && previous !== ref.bytes) invalid('Conflicting image versions share a host attachment identity')
    references.set(ref.attachmentId, Number(ref.bytes))
    if (references.size > WEB_MAX_IMAGES) invalid('At most 20 distinct host image references are accepted per request')
  }
  const declaredBase64Bytes = [...references.values()].reduce((sum, bytes) => sum + Math.ceil(bytes / 3) * 4, 0)
  // Conservatively retain the original reference metadata as part of the budget.
  if (Buffer.byteLength(JSON.stringify(snapshot.body)) + declaredBase64Bytes > WEB_MAX_REQUEST_BYTES) {
    invalid('Images and request metadata exceed the complete 32 MiB transport budget')
  }
}

/** Uses only the detached snapshot and the public host attachment reader. */
export async function resolveWebAttachments(snapshot: CapturedWebRequest, resolveAttachments?: () => unknown): Promise<CapturedWebRequest> {
  const hasImages = snapshot.body.messages.some(message => message.content.some(block =>
    block !== null && typeof block === 'object' && 'type' in block && (block.type === 'image' || block.type === 'file')))
  if (!hasImages) return snapshot
  preflight(snapshot)
  let prepared: HarnessRequest
  try {
    prepared = await prepareImages({ ...snapshot.body, ...snapshot.signal === undefined ? {} : { signal: snapshot.signal } } as unknown as HarnessRequest, {
      resolveModel: async () => ({ inputModalities: ['text', 'image'] }),
      ...resolveAttachments === undefined ? {} : { resolveAttachments },
    })
  } catch (cause) {
    snapshot.signal?.throwIfAborted()
    throw new WebBridgeError('WEB_INVALID_ATTACHMENT', cause instanceof Error ? cause.message : 'Image attachment could not be verified', 400, { cause })
  }
  const versions = new Map<string, WebAttachmentVersion>()
  const messages = prepared.messages.map(message => ({ ...message, content: message.content.map(block => {
    if (block.type !== 'image') return block
    if (typeof block['url'] !== 'string') invalid('The host did not resolve exact image bytes')
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(block['url'])
    if (!match) invalid('Unsupported resolved image data')
    const mimeType = match[1] as WebAttachmentVersion['mimeType']
    const base64 = match[2]!
    if (base64.length > Math.ceil(WEB_MAX_IMAGE_BYTES / 3) * 4) invalid('Image exceeds the upload byte limit')
    const bytes = Buffer.from(base64, 'base64')
    const digest = imageDigest(bytes)
    const version = { id: digest, digest, mimeType, byteLength: bytes.byteLength, uploadName: uploadName(digest, mimeType), base64 }
    attachmentBytes(version)
    versions.set(digest, version)
    return { type: 'image', attachmentVersion: digest }
  }) }))
  return { ...snapshot, body: { ...snapshot.body, messages }, attachmentVersions: validateAttachmentVersions([...versions.values()]) }
}
