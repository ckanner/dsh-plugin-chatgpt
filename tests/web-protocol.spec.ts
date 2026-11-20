import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WEB_MODEL, type WebBinding, type WebRequest } from '../src/web-bridge/contracts.ts'
import { captureWebRequest, prepareWebRequest, type WebGenerateOptions } from '../src/web-bridge/request.ts'
import { canonical, createResponse, digest, requestHash, validateContinuation,
  validatePageResponse, validateRequest, validateResponse } from '../src/web-bridge/protocol.ts'

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
    assert.throws(() => request({ ...input(), messages: [{ id: 'x', role: 'user', content: [{ type, attachment: { path: '/private' } }] }] }), { code: 'WEB_UNSUPPORTED_CONTENT' })
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
