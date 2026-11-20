import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WEB_MODEL, type WebBinding, type WebRequest, type WebResponse } from '../src/web-bridge/contracts.ts'
import { captureWebRequest, prepareWebRequest, type WebGenerateOptions } from '../src/web-bridge/request.ts'
import { canonical, createResponse, digest, requestHash, validateContinuation,
  validatePageResponse, validateRequest, validateResponse, WEB_MAX_JSON_BYTES } from '../src/web-bridge/protocol.ts'

const binding: WebBinding = { protocolVersion: 1, installationId: 'installation', provider: 'chatgpt',
  profileId: 'profile', accountBinding: 'account' }
const definition = { name: 'write_note', description: 'Write a note', parameters: {
  type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false,
} }
function input(): WebGenerateOptions {
  return { provider: 'chatgpt', model: WEB_MODEL, sessionId: 'session',
    messages: [{ id: 'user-1', role: 'user', content: [{ type: 'text', text: 'Write a note' }] }], tools: [definition] }
}
function request(options = input(), override: Partial<WebBinding> = {}): WebRequest {
  return prepareWebRequest(captureWebRequest(options), { ...binding, ...override }, 'lease', 'attempt')
}
function rehash(request: WebRequest): WebRequest { return { ...request, idempotencyKey: requestHash(request) } }
function pageTool(id = 'call-1') {
  return { version: 1, complete: true, blocks: [{ type: 'tool-call', id, name: 'write_note', arguments: '{"text":"hello"}' }] }
}

test('hashes typed canonical JSON, ordered history, instructions, namespace and exact tool history', () => {
  assert.equal(canonical({ b: 2, a: 1 }), canonical({ a: 1, b: 2 }))
  assert.notEqual(digest(['1']), digest([1]))
  assert.notEqual(digest([1, 2]), digest([2, 1]))
  const base = request()
  assert.equal(base.idempotencyKey, requestHash({ ...base, clientLeaseId: 'other', deliveryAttemptId: 'next' }))
  for (const field of ['installationId', 'provider', 'profileId', 'accountBinding', 'sessionId'] as const) {
    assert.notEqual(base.idempotencyKey, requestHash({ ...base, [field]: 'different' }), field)
  }
  assert.notEqual(base.idempotencyKey, request({ ...input(), system: 'Be careful' }).idempotencyKey)
  const history = { tools: [definition], updates: [] }
  assert.notEqual(base.idempotencyKey, request({ ...input(), toolHistory: history }).idempotencyKey)
  const updated = structuredClone(base)
  updated.messages[0]!.content = [{ type: 'text', text: 'A different surface under the same message ID' }]
  assert.notEqual(base.idempotencyKey, requestHash(updated))
  assert.throws(() => validateRequest(updated, binding), { code: 'WEB_IDEMPOTENCY_CONFLICT' })
})

test('raw GenerateOptions is detached synchronously before caller mutation', () => {
  const options = input()
  const snapshot = captureWebRequest(options)
  ;(options.messages[0]!.content[0] as { text: string }).text = 'changed after stream()'
  ;(options.tools![0] as typeof definition).parameters.required.push('injected')
  const admitted = prepareWebRequest(snapshot, binding, 'lease', 'attempt')
  assert.equal((admitted.messages[0]!.content[0] as { text: string }).text, 'Write a note')
  assert.deepEqual(admitted.tools[0]!.parameters['required'], ['text'])
  // Restore shared fixture mutated only to exercise input aliasing.
  definition.parameters.required.pop()
})

test('preserves separate system instructions and existing leading-instruction precedence', () => {
  assert.equal(request({ ...input(), system: 'Separate' }).system, 'Separate')
  const options = input()
  options.messages = [{ id: 'system-1', role: 'system', content: [{ type: 'text', text: 'Leading' }] }, ...options.messages]
  assert.equal(request({ ...options, system: 'Ignored by the existing converter' }).system, undefined)
  assert.equal(request(options).idempotencyKey, request({ ...options, system: 'Ignored by the existing converter' }).idempotencyKey)
})

test('normal, compaction and title identities follow different public caller shapes', () => {
  assert.throws(() => request({ ...input(), sessionId: '' }), /sessionId/)
  assert.throws(() => request({ ...input(), messages: [{ role: 'user', content: [{ type: 'text', text: 'anonymous' }] }] }), { code: 'WEB_IDENTITY_REQUIRED' })
  const options = input()
  assert.doesNotThrow(() => request({ ...options, purpose: 'compaction',
    messages: [...options.messages, { role: 'user', content: [{ type: 'text', text: 'Summarize' }] }] }))
  assert.throws(() => request({ ...options, purpose: 'compaction', messages: [{ role: 'user', content: [] }, ...options.messages] }), { code: 'WEB_IDENTITY_REQUIRED' })
  const title = request({ ...options, purpose: 'session-title' })
  const retitled = input()
  retitled.messages = [{ ...retitled.messages[0]!, id: 'new-random-wrapper' }]
  assert.equal(title.idempotencyKey, request({ ...retitled, purpose: 'session-title' }).idempotencyKey)
  assert.notEqual(request(options).idempotencyKey, request(retitled).idempotencyKey)
})

test('unimplemented controls, modalities and future options fail before admission', () => {
  for (const controls of [{ maxTokens: 100 }, { temperature: 0 }, { stop: [] }]) {
    assert.throws(() => request({ ...input(), ...controls }), { code: 'WEB_UNSUPPORTED_CONTROL' })
  }
  for (const type of ['file', 'image']) {
    assert.throws(() => request({ ...input(), messages: [{ id: 'x', role: 'user', content: [{ type, attachment: { path: '/private' } }] }] }), { code: type === 'image' ? 'WEB_INVALID_REQUEST' : 'WEB_UNSUPPORTED_CONTENT' })
  }
  assert.throws(() => captureWebRequest({ ...input(), futureOption: true } as WebGenerateOptions), { code: 'WEB_UNSUPPORTED_OPTION' })
  assert.throws(() => request({ ...input(), reasoningEffort: 'high' }), { code: 'WEB_UNSUPPORTED_MODEL' })
})

test('rejects lossy, cyclic, oversized and excessively nested JSON', () => {
  for (const value of [NaN, Infinity, undefined, { a: undefined }, new Date(), [undefined], Array(1)]) assert.throws(() => canonical(value))
  const cycle: Record<string, unknown> = {}; cycle['self'] = cycle
  assert.throws(() => canonical(cycle), /Cyclic/)
  let deep: unknown = null
  for (let index = 0; index < 66; index++) deep = [deep]
  assert.throws(() => canonical(deep), /structure/)
  assert.throws(() => canonical('x'.repeat(1024 * 1024)), /exceeds/)
  assert.throws(() => canonical(Object.defineProperty({}, 'x', { enumerable: true, get: () => 1 })), /Accessor/)
})

test('tool response is validated as a whole with schema-checked arguments and response-local IDs', () => {
  const admitted = request()
  const blocks = validatePageResponse(pageTool(), admitted, 'turn-1')
  const first = blocks[0]!
  assert.equal(first.type === 'tool-call' && first.id, 'turn-1:call-1')
  assert.notDeepEqual(blocks, validatePageResponse(pageTool(), admitted, 'turn-2'))
  const response = createResponse(admitted, 'turn-1', 'generation', blocks)
  assert.deepEqual(validateResponse(response, admitted), response)
  assert.throws(() => validateResponse({ ...response, finishReason: 'stop' }, admitted), { code: 'WEB_INVALID_RESPONSE' })
  assert.throws(() => validatePageResponse({ ...pageTool(), complete: false }, admitted, 'turn'), { code: 'WEB_INVALID_RESPONSE' })
  const duplicate = pageTool(); duplicate.blocks.push(duplicate.blocks[0]!)
  assert.throws(() => validatePageResponse(duplicate, admitted, 'turn'), { code: 'WEB_INVALID_RESPONSE' })
  for (const change of [{ name: 'undeclared' }, { arguments: '{"text":42}' }, { arguments: '{"text":"ok","extra":true}' }, { arguments: 'not-json' }]) {
    const malformed = pageTool(); Object.assign(malformed.blocks[0]!, change)
    assert.throws(() => validatePageResponse(malformed, admitted, 'turn'), { code: 'WEB_INVALID_RESPONSE' })
  }
  assert.throws(() => validatePageResponse(pageTool(), request({ ...input(), purpose: 'compaction' }), 'turn'), { code: 'WEB_INVALID_RESPONSE' })
  assert.throws(() => request({ ...input(), tools: [{ ...definition, parameters: { $ref: 'https://example.com/schema' } }] }), { code: 'WEB_UNSUPPORTED_SCHEMA' })
})

function framedResponse(response: WebResponse): string {
  return `event: response\ndata: ${JSON.stringify(response)}\n\nevent: finish\ndata: ${JSON.stringify({
    turnId: response.turnId, reason: response.finishReason,
    responseDigest: response.receipt.responseDigest, state: 'completed',
  })}\n\n`
}

test('rejects page blocks that fit alone but exceed the complete receipt-bearing response budget', () => {
  const admitted = request()
  const page = { version: 1, complete: true, blocks: [{ type: 'text', text: 'x'.repeat(1_048_476) }] }
  assert.ok(Buffer.byteLength(canonical(page)) <= WEB_MAX_JSON_BYTES)
  const blocks = validatePageResponse(page, admitted, 'turn-limit')
  assert.throws(() => createResponse(admitted, 'turn-limit', 'generation', blocks), { code: 'WEB_RESPONSE_LIMIT' })
})

test('includes both SSE frames and the inspection wrapper in the pre-commit response budget', () => {
  const admitted = request()
  const seed = createResponse(admitted, 'turn-limit', 'generation', [{ type: 'text', text: 'x' }])
  const overhead = Buffer.byteLength(JSON.stringify(seed)) - 1
  // The response JSON itself fits exactly. The HTTP client also has to read
  // response/finish SSE framing, which is larger than that individual object.
  const blocks = [{ type: 'text' as const, text: 'x'.repeat(WEB_MAX_JSON_BYTES - overhead) }]
  const unchecked = { ...seed, blocks, receipt: { ...seed.receipt, responseDigest: digest(blocks) } }
  assert.equal(Buffer.byteLength(canonical(unchecked)), WEB_MAX_JSON_BYTES)
  assert.ok(Buffer.byteLength(framedResponse(unchecked)) > WEB_MAX_JSON_BYTES)
  assert.throws(() => createResponse(admitted, seed.turnId, 'generation', blocks), { code: 'WEB_RESPONSE_LIMIT' })

  const toolBlocks = validatePageResponse(pageTool(), admitted, seed.turnId)
  const toolSeed = createResponse(admitted, seed.turnId, 'generation', [...toolBlocks, { type: 'text', text: 'x' }])
  const framedOverhead = Buffer.byteLength(framedResponse(toolSeed)) - 1
  const oversizedInspectionBlocks = [...toolBlocks, { type: 'text' as const, text: 'x'.repeat(WEB_MAX_JSON_BYTES - framedOverhead) }]
  const inspectionCandidate = { ...toolSeed, blocks: oversizedInspectionBlocks,
    receipt: { ...toolSeed.receipt, responseDigest: digest(oversizedInspectionBlocks) } }
  assert.equal(Buffer.byteLength(framedResponse(inspectionCandidate)), WEB_MAX_JSON_BYTES)
  assert.ok(Buffer.byteLength(JSON.stringify({
    turnId: seed.turnId, sessionId: admitted.sessionId, state: 'completed', requestHash: admitted.idempotencyKey,
    generationId: 'generation', discarded: false, deliveryState: 'delivery-intent',
    deliveryOwner: { clientLeaseId: '\u0000'.repeat(256), deliveryAttemptId: '\u0000'.repeat(256) },
    response: inspectionCandidate,
  })) > WEB_MAX_JSON_BYTES)
  assert.throws(() => createResponse(admitted, seed.turnId, 'generation', oversizedInspectionBlocks), { code: 'WEB_RESPONSE_LIMIT' })
})

test('parent receipt is bound to hashed assistant content and full tool results', () => {
  const parent = request()
  const response = createResponse(parent, 'turn-parent', 'generation', validatePageResponse(pageTool(), parent, 'turn-parent'))
  const call = response.blocks[0]!
  assert.equal(call.type, 'tool-call')
  if (call.type !== 'tool-call') return
  const options = { ...input(), messages: [...input().messages,
    { id: 'assistant', role: 'assistant', content: response.blocks,
      source: { kind: 'model', provider: binding.provider, model: WEB_MODEL, replayState: { response: response.receipt } } },
    { id: 'result', role: 'tool', content: [{ type: 'text', text: 'done' }], toolCallId: call.id },
  ] }
  const continuation = request(options)
  assert.equal(validateContinuation(continuation, parent, response), true)
  assert.throws(() => validateRequest(rehash({ ...continuation, parentReceipt: null }), binding), { code: 'WEB_INVALID_RECEIPT' })
  const missing = request({ ...options, messages: options.messages.slice(0, -1) })
  assert.throws(() => validateContinuation(missing, parent, response), { code: 'WEB_INVALID_CONTINUATION' })
  const duplicated = request({ ...options, messages: [...options.messages, { ...options.messages.at(-1)!, id: 'duplicate' }] })
  assert.throws(() => validateContinuation(duplicated, parent, response), { code: 'WEB_INVALID_CONTINUATION' })
  const changedPrefix = structuredClone(continuation)
  changedPrefix.messages[0]!.content = [{ type: 'text', text: 'Compacted context' }]
  assert.equal(validateContinuation(changedPrefix, parent, response), false)
  // A fork cannot adopt the original bridge generation; only public content survives.
  assert.equal(request({ ...options, sessionId: 'fork' }).parentReceipt, null)
  const siwc = { ...options, messages: options.messages.map(message => message.role === 'assistant'
    ? { ...message, source: { kind: 'model', provider: 'chatgpt', model: 'gpt-6.2-astra', replayState: { response: { kind: 'chatgpt-responses' } } } } : message) }
  assert.equal(request(siwc).parentReceipt, null)
})

test('valid request history above the response limit can still continue its exact parent prefix', () => {
  const options = { ...input(), messages: [
    { id: 'one', role: 'user', content: [{ type: 'text', text: 'x'.repeat(600_000) }] },
    { id: 'two', role: 'user', content: [{ type: 'text', text: 'y'.repeat(600_000) }] },
  ] }
  const parent = request(options)
  const response = createResponse(parent, 'turn-parent', 'generation', [{ type: 'text', text: 'ok' }])
  const next = request({ ...options, messages: [...options.messages,
    { id: 'assistant', role: 'assistant', content: response.blocks,
      source: { kind: 'model', provider: binding.provider, model: WEB_MODEL, replayState: { response: response.receipt } } },
    { id: 'three', role: 'user', content: [{ type: 'text', text: 'Continue' }] },
  ] })
  assert.equal(validateContinuation(next, parent, response), true)
})
