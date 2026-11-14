/** Durable DSH images become request-local bytes; history keeps its references. */
import type { HarnessBlock, HarnessRequest } from '../adapter.ts'
import { abortable, assertNotAborted } from '../abort.ts'

/** Structural subset of the host's ImageAttachmentRef; the id is never a path. */
export interface ImageAttachmentRef {
  attachmentId: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  bytes: number
  width: number
  height: number
  name?: string
}

/** The stable readImage contract shared by DSH rc.3 and current master. */
export interface ImageAttachmentReader {
  readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<{ ref: ImageAttachmentRef, data: Uint8Array }>
}

export interface ImagePreparation {
  resolveModel(): Promise<{ inputModalities?: readonly string[] }>
  resolveAttachments?(): unknown
}

function failure(message: string, code = 'UNSUPPORTED_CONTENT'): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Check the reference before passing it to the authoritative attachment store. */
function imageRef(value: unknown): ImageAttachmentRef {
  if (!record(value) || typeof value['attachmentId'] !== 'string' || !value['attachmentId']
    || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(String(value['mediaType']))
    || !['bytes', 'width', 'height'].every(key => Number.isSafeInteger(value[key]) && Number(value[key]) > 0)) {
    throw failure('ChatGPT image input requires a valid durable image attachment reference')
  }
  return value as unknown as ImageAttachmentRef
}

function identity(ref: ImageAttachmentRef): string {
  return JSON.stringify([ref.attachmentId, ref.mediaType, ref.bytes, ref.width, ref.height])
}

/**
 * Resolve both user images and tool-result images, including PTC/LCU output.
 * No paths, bearer URLs or inline file objects are interpreted here. The host
 * store owns decoding/digest verification. Missing bytes or unsupported content
 * fail the turn before inference instead of replacing the content with text.
 */
export async function prepareImages(request: HarnessRequest, options: ImagePreparation): Promise<HarnessRequest> {
  assertNotAborted(request.signal)
  // A persisted offload is a host decision about this exact occurrence. Never
  // resurrect its bytes during model/provider switching or session replay.
  request = { ...request, messages: request.messages.map(message => ({
    ...message,
    content: message.content.map((block): HarnessBlock => {
      if (block.type !== 'image' || block['offloaded'] !== true) return block
      const ref = imageRef(block['attachment'])
      return { type: 'text', text: `[Image ${JSON.stringify(ref.attachmentId)} was offloaded by the harness to fit request image limits; its bytes are not included in this request.]` }
    }),
  })) }
  const refs = new Map<string, ImageAttachmentRef>()
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type === 'file') throw failure('ChatGPT file attachments are not supported by this adapter')
      if (block.type !== 'image') continue
      if (message.role !== 'user' && message.role !== 'tool') {
        throw failure('ChatGPT supports images only in user messages and tool results')
      }
      if (message.role === 'tool' && !message.toolCallId) {
        throw failure('ChatGPT image tool results require the originating tool call id')
      }
      const ref = imageRef(block['attachment'])
      const prior = refs.get(ref.attachmentId)
      if (prior !== undefined && identity(prior) !== identity(ref)) {
        throw failure('Conflicting image references share an attachment id', 'chatgpt_attachment_read_failed')
      }
      refs.set(ref.attachmentId, ref)
    }
  }
  if (refs.size === 0) return request
  const model = await abortable(options.resolveModel(), request.signal)
  assertNotAborted(request.signal)
  if (model.inputModalities?.includes('image') !== true) {
    throw failure(`ChatGPT model "${request.model}" does not support image input`)
  }
  const attachments = options.resolveAttachments?.()
  if (!record(attachments) || typeof attachments['readImage'] !== 'function') {
    throw failure('ChatGPT image input requires the durable attachment service')
  }
  const reader = attachments as unknown as ImageAttachmentReader
  const urls = new Map<string, string>()
  for (const ref of refs.values()) {
    assertNotAborted(request.signal)
    try {
      const stored = await abortable(reader.readImage(ref, request.signal), request.signal)
      assertNotAborted(request.signal)
      if (!stored || !(stored.data instanceof Uint8Array) || stored.data.byteLength !== ref.bytes
        || identity(imageRef(stored.ref)) !== identity(ref)) {
        throw failure('The attachment service returned bytes or metadata that do not match the image reference', 'chatgpt_attachment_read_failed')
      }
      urls.set(ref.attachmentId, `data:${ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`)
    } catch (error) {
      assertNotAborted(request.signal)
      if (error instanceof Error && 'code' in error && error.code === 'chatgpt_attachment_read_failed') throw error
      throw failure('The durable image attachment could not be read or verified', 'chatgpt_attachment_read_failed')
    }
  }
  assertNotAborted(request.signal)
  return {
    ...request,
    messages: request.messages.map(message => ({
      ...message,
      content: message.content.map((block): HarnessBlock => block.type === 'image'
        ? { type: 'image', url: urls.get(imageRef(block['attachment']).attachmentId) as string }
        : block),
    })),
  }
}
