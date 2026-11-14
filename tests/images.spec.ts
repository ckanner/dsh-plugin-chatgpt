import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { ChatGptAdapter, toNeutralRequest, type HarnessRequest } from '../src/adapter.ts'
import { ChatGptAuth } from '../src/auth/manager.ts'
import { emptyDocument, writeDocument } from '../src/auth/store.ts'
import { requestOf } from '../src/convert/harness.ts'
import type { ImageAttachmentReader, ImageAttachmentRef } from '../src/convert/images.ts'
import { contentCapabilities } from '../src/capabilities.ts'
import type { AdapterChunk } from '../src/convert/blocks.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/o8AAAAASUVORK5CYII=', 'base64')
const ref: ImageAttachmentRef = { attachmentId: 'fixture-image', mediaType: 'image/png', bytes: png.length, width: 1, height: 1 }
const url = `data:image/png;base64,${png.toString('base64')}`
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

function frame(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

/** Real auth owner and request client, with an in-process HTTP endpoint fixture. */
async function setup(options: {
  attachments?: ImageAttachmentReader | null
  modalities?: string[]
  response?: () => Response
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'chatgpt-images-'))
  directories.push(directory)
  writeDocument(join(directory, 'chatgpt-auth.json'), {
    ...emptyDocument('urn:uuid:image-fixture'), active: 'subject-1', accounts: {
      'subject-1': {
        accessToken: 'fixture-token', refreshToken: 'fixture-refresh', expiresAt: Date.now() + 3600_000,
        clientId: 'fixture-client', scopes: ['chatgpt.tokens.use.direct'], subject: 'subject-1', savedAt: Date.now(),
      },
    },
  })
  const reads: ImageAttachmentRef[] = []
  const bodies: Record<string, unknown>[] = []
  const paths: string[] = []
  const attachments = options.attachments === undefined ? {
    async readImage(value: ImageAttachmentRef) { reads.push(value); return { ref: value, data: png } },
  } : options.attachments
  const adapter = new ChatGptAdapter({
    auth: new ChatGptAuth({ stateDir: directory, agentNameHint: 'fixture' }),
    baseUrl: 'https://chatgpt-fixture.invalid/v1',
    resolveAttachments: () => attachments,
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      if (path.endsWith('/models')) return Response.json({ models: [{
        slug: 'vision-model', input_modalities: options.modalities ?? ['text', 'image'],
      }] })
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return options.response?.() ?? new Response(frame({ type: 'response.completed', response: { output: [] } }), {
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  })
  return { adapter, reads, bodies, paths }
}

function hostRequest(messages: object[], signal?: AbortSignal): HarnessRequest {
  // Host IDs are branded strings at compile time and ordinary strings on the
  // durable wire. This fixture goes through the production host converter.
  return requestOf({
    provider: 'chatgpt', model: 'vision-model',
    messages: messages.map((message, index) => ({ id: `m${index}`, source: { kind: 'user' }, ...message })),
    ...(signal === undefined ? {} : { signal }),
  } as unknown as GenerateOptions)
}

const image = { type: 'image', attachment: ref }
async function consume(adapter: ChatGptAdapter, request: HarnessRequest) {
  const chunks: AdapterChunk[] = []
  for await (const chunk of adapter.stream('chatgpt', request)) chunks.push(chunk)
  return chunks
}

describe('durable images through the actual Responses request path', () => {
  it('sends user attachments and PTC/LCU tool output images with original structured text and call identity', async () => {
    const fixture = await setup()
    const json = '{ "windowId": "w1", "result": [1, 2] }'
    const request = hostRequest([
      { role: 'user', content: [{ type: 'text', text: 'Inspect this' }, image] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'ptc-1', name: 'run_code', arguments: '{"code":"inspect(await cua.screenshot())"}' }] },
      { role: 'tool', toolCallId: 'ptc-1', content: [{ type: 'text', text: json }, image, { type: 'text', text: 'program complete' }] },
    ])
    const original = structuredClone(request)
    await consume(fixture.adapter, request)
    assert.equal(fixture.reads.length, 1, 'the same immutable attachment is read once per request')
    assert.equal(fixture.bodies.length, 1)
    assert.deepEqual(fixture.bodies[0]?.['input'], [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect this' }, { type: 'input_image', image_url: url }] },
      { type: 'function_call', call_id: 'ptc-1', name: 'run_code', arguments: '{"code":"inspect(await cua.screenshot())"}' },
      { type: 'function_call_output', call_id: 'ptc-1', output: [
        { type: 'input_text', text: json }, { type: 'input_image', image_url: url }, { type: 'input_text', text: 'program complete' },
      ] },
    ])
    assert.deepEqual(request, original, 'durable history must retain attachment references')
  })

  it('keeps error status together with a tool screenshot', async () => {
    const fixture = await setup()
    await consume(fixture.adapter, hostRequest([{ role: 'tool', toolCallId: 'failed-1', isError: true, content: [image, { type: 'text', text: 'target not found' }] }]))
    const input = fixture.bodies[0]?.['input'] as Record<string, unknown>[]
    assert.deepEqual(input[0], { type: 'function_call_output', call_id: 'failed-1', output: [
      { type: 'input_text', text: 'Error: ' }, { type: 'input_image', image_url: url }, { type: 'input_text', text: 'target not found' },
    ] })
  })

  it('uses text-only requests without an attachment service or model-list request', async () => {
    const fixture = await setup({ attachments: null })
    await consume(fixture.adapter, hostRequest([{ role: 'tool', toolCallId: 'text-1', content: [{ type: 'text', text: '{"ok":true}' }] }]))
    assert.deepEqual(fixture.paths, ['/v1/responses'])
    assert.deepEqual(fixture.bodies[0]?.['input'], [{ type: 'function_call_output', call_id: 'text-1', output: '{"ok":true}' }])
  })

  it('preserves the host offload decision instead of restoring image bytes on replay', async () => {
    const fixture = await setup({ attachments: null, modalities: ['text'] })
    const request = hostRequest([{ role: 'user', content: [{ ...image, offloaded: true }] }])
    await consume(fixture.adapter, request)
    assert.deepEqual(fixture.paths, ['/v1/responses'])
    assert.equal(fixture.reads.length, 0)
    assert.match(JSON.stringify(fixture.bodies[0]?.['input']), /offloaded by the harness/)
    assert.doesNotMatch(JSON.stringify(fixture.bodies[0]?.['input']), /input_image/)
    const block = request.messages[0]?.content[0]
    assert.ok(block?.type === 'image')
    assert.equal(block['offloaded'], true)
  })

  it('refuses an unsupported model or absent attachment service before inference', async () => {
    for (const options of [{ modalities: ['text'] }, { attachments: null }]) {
      const fixture = await setup(options)
      await assert.rejects(consume(fixture.adapter, hostRequest([{ role: 'user', content: [image] }])), { code: 'UNSUPPORTED_CONTENT' })
      assert.equal(fixture.bodies.length, 0)
      assert.equal(fixture.reads.length, 0)
    }
  })

  it('refuses invalid references, unsupported roles, files and uncorrelated tool images', async () => {
    const cases = [
      { role: 'user', content: [{ type: 'image', attachment: { url: 'file:///private/image.png' } }] },
      { role: 'assistant', content: [image] },
      { role: 'developer', content: [image] },
      { role: 'user', content: [{ type: 'file', attachment: { attachmentId: 'file-1' } }] },
      { role: 'tool', content: [image] },
    ]
    const fixture = await setup()
    for (const message of cases) {
      await assert.rejects(consume(fixture.adapter, hostRequest([message])), { code: 'UNSUPPORTED_CONTENT' })
    }
    assert.equal(fixture.paths.length, 0)
  })

  it('fails unreadable, mismatched and truncated attachments without inventing placeholder text', async () => {
    const readers: ImageAttachmentReader[] = [
      { async readImage() { throw new Error('missing fixture object') } },
      { async readImage() { return { ref: { ...ref, attachmentId: 'different' }, data: png } } },
      { async readImage() { return { ref, data: png.subarray(1) } } },
    ]
    for (const attachments of readers) {
      const fixture = await setup({ attachments })
      await assert.rejects(consume(fixture.adapter, hostRequest([{ role: 'user', content: [image] }])), { code: 'chatgpt_attachment_read_failed' })
      assert.equal(fixture.bodies.length, 0)
    }
  })

  it('rejects conflicting references even when they share the same storage id', async () => {
    const fixture = await setup()
    await assert.rejects(consume(fixture.adapter, hostRequest([{ role: 'user', content: [image, {
      type: 'image', attachment: { ...ref, width: 2 },
    }] }])), { code: 'chatgpt_attachment_read_failed' })
    assert.equal(fixture.paths.length, 0)
  })

  it('never turns an unresolved image into an empty neutral message', () => {
    assert.throws(() => toNeutralRequest(hostRequest([{ role: 'user', content: [image] }])), { code: 'UNSUPPORTED_CONTENT' })
    assert.deepEqual(contentCapabilities.imageInputRoles, ['user', 'tool'])
    assert.equal(contentCapabilities.fileInput, false)
  })
})

describe('image and response cancellation', () => {
  it('honors cancellation before preparation without any service call', async () => {
    const control = new AbortController()
    control.abort()
    const fixture = await setup()
    await assert.rejects(consume(fixture.adapter, hostRequest([{ role: 'user', content: [image] }], control.signal)), { code: 'ABORTED' })
    assert.equal(fixture.paths.length, 0)
  })

  it('settles when an attachment service ignores cancellation and never dispatches late bytes', { timeout: 2000 }, async () => {
    const control = new AbortController()
    let finish: ((value: { ref: ImageAttachmentRef, data: Uint8Array }) => void) | undefined
    const fixture = await setup({ attachments: { readImage(_ref, signal) {
      assert.equal(signal, control.signal)
      control.abort()
      return new Promise(resolve => { finish = resolve })
    } } })
    await assert.rejects(consume(fixture.adapter, hostRequest([{ role: 'user', content: [image] }], control.signal)), { code: 'ABORTED' })
    finish?.({ ref, data: png })
    await Promise.resolve()
    assert.equal(fixture.bodies.length, 0)
  })

  it('checks cancellation again when a completed read hands control back', async () => {
    const control = new AbortController()
    const fixture = await setup({ attachments: { async readImage() { control.abort(); return { ref, data: png } } } })
    await assert.rejects(consume(fixture.adapter, hostRequest([{ role: 'user', content: [image] }], control.signal)), { code: 'ABORTED' })
    assert.equal(fixture.bodies.length, 0)
  })

  it('closes a partial response on cancellation without fabricating usage or success', async () => {
    const control = new AbortController()
    let cancelled = false
    const fixture = await setup({ response: () => new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode(frame({ type: 'response.output_text.delta', output_index: 0, delta: 'partial' }))) },
      cancel() { cancelled = true },
    })) })
    const chunks: AdapterChunk[] = []
    await assert.rejects(async () => {
      for await (const chunk of fixture.adapter.stream('chatgpt', hostRequest([{ role: 'user', content: [{ type: 'text', text: 'go' }] }], control.signal))) {
        chunks.push(chunk)
        if (chunk.type === 'text-delta') control.abort()
      }
    }, { code: 'ABORTED' })
    assert.ok(cancelled)
    assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end'])
  })

  it('preserves reported usage but suppresses buffered success when cancellation lands inside a terminal batch', async () => {
    const control = new AbortController()
    const fixture = await setup({ response: () => new Response(frame({ type: 'response.completed', response: {
      output: [{ type: 'message', id: 'message-1', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
      usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
    } })) })
    const chunks: AdapterChunk[] = []
    await assert.rejects(async () => {
      for await (const chunk of fixture.adapter.stream('chatgpt', hostRequest([{ role: 'user', content: [{ type: 'text', text: 'go' }] }], control.signal))) {
        chunks.push(chunk)
        if (chunk.type === 'block-start') control.abort()
      }
    }, { code: 'ABORTED' })
    assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'block-end', 'usage'])
    assert.deepEqual(chunks.at(-1), { type: 'usage', usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 } })
  })

  it('releases the provider reader when the consumer returns early', async () => {
    let cancelled = false
    const fixture = await setup({ response: () => new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode(frame({ type: 'response.output_text.delta', output_index: 0, delta: 'partial' }))) },
      cancel() { cancelled = true },
    })) })
    const chunks = fixture.adapter.stream('chatgpt', hostRequest([{ role: 'user', content: [{ type: 'text', text: 'go' }] }]))
    assert.equal((await chunks.next()).value?.type, 'block-start')
    await chunks.return(undefined)
    assert.ok(cancelled)
  })
})
