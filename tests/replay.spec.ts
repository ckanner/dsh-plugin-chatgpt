import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { toNeutralRequest, type HarnessMessage, type HarnessRequest } from '../src/adapter.ts'
import { toResponsesBody } from '../src/convert/request.ts'
import { requestOf } from '../src/convert/harness.ts'
import { BlockTranslator, type AdapterChunk } from '../src/convert/blocks.ts'
import { decodeEvent } from '../src/api/events.ts'
import { accountScope, sessionCacheKey, type OutputItem, type ReplayEnvelope } from '../src/convert/replay.ts'

const context = { provider: 'chatgpt', model: 'gpt-6.1-sol', scope: 'account-a' }
const text = (role: HarnessMessage['role'], value: string): HarnessMessage => ({ role, content: [{ type: 'text', text: value }] })
const call = { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{ "path": "a.txt" }' } as const
const result: HarnessMessage = { role: 'tool', toolCallId: call.id, content: [{ type: 'text', text: 'stable output'.repeat(2000) }] }
const native: OutputItem[] = [
  { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Plan' }], encrypted_content: 'opaque-one' },
  { type: 'message', id: 'msg_1', role: 'assistant', phase: 'commentary', status: 'completed', content: [{ type: 'output_text', text: 'Read first.', annotations: [] }] },
  { type: 'function_call', id: 'fc_1', call_id: call.id, name: call.name, arguments: call.arguments, status: 'completed' },
  { type: 'reasoning', id: 'rs_2', summary: [], encrypted_content: 'opaque-two' },
  { type: 'message', id: 'msg_2', role: 'assistant', phase: 'commentary', status: 'completed', content: [{ type: 'output_text', text: 'Then inspect.', annotations: [] }] },
]

function feed(translator: BlockTranslator, event: object): AdapterChunk[] {
  const decoded = decodeEvent(JSON.stringify(event))
  return decoded === undefined ? [] : translator.push(decoded)
}

/** Exercise real SSE event decoding, including data present only on the terminal response. */
function responseChunks(output = native): AdapterChunk[] {
  const translator = new BlockTranslator(context)
  const chunks: AdapterChunk[] = []
  output.forEach((item, index) => {
    const partial = item.type === 'function_call' ? { ...item, arguments: '' }
      : item.type === 'message' ? { ...item, content: [] } : { ...item, summary: [], encrypted_content: undefined }
    chunks.push(...feed(translator, { type: 'response.output_item.added', output_index: index, item: partial }))
    if (item.type === 'function_call') {
      chunks.push(...feed(translator, { type: 'response.function_call_arguments.delta', output_index: index, delta: item.arguments }))
      chunks.push(...feed(translator, { type: 'response.function_call_arguments.done', output_index: index, arguments: item.arguments }))
    } else if (item.type === 'message') {
      chunks.push(...feed(translator, { type: 'response.output_text.delta', output_index: index, delta: item.content[0].text }))
    } else if (item.summary.length > 0) {
      chunks.push(...feed(translator, { type: 'response.reasoning_summary_text.delta', output_index: index, delta: item.summary[0].text }))
    }
    chunks.push(...feed(translator, {
      type: 'response.output_item.done', output_index: index,
      item: item.type === 'reasoning' ? { ...item, encrypted_content: undefined } : item,
    }))
  })
  chunks.push(...feed(translator, { type: 'response.completed', response: {
    output, usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800, cache_write_tokens: 100 }, output_tokens: 20 },
  } }))
  return chunks
}

function assistant(chunks = responseChunks()): HarnessMessage {
  const blocks = chunks.filter(chunk => chunk.type === 'block-end').sort((a, b) => a.index - b.index).map(chunk => chunk.block)
  const finish = chunks.findLast(chunk => chunk.type === 'finish')
  assert.ok(finish?.replayState)
  return JSON.parse(JSON.stringify({
    role: 'assistant', content: blocks,
    source: { kind: 'model', provider: context.provider, model: context.model, replayState: finish.replayState },
  }))
}

function body(messages: HarnessMessage[], overrides: Partial<HarnessRequest> = {}) {
  return toResponsesBody(toNeutralRequest({ provider: context.provider, model: context.model, messages, ...overrides }, context.scope))
}

describe('cache-preserving history', () => {
  it('preserves the complete previous input when commentary and another tool are appended', () => {
    const history = [text('system', 'Stable instructions'), text('user', 'Inspect'), { role: 'assistant' as const, content: [call] }, result]
    const first = body(history)
    const second = body([...history, { role: 'assistant', content: [
      { type: 'text', text: 'Next file.' }, { ...call, id: 'call_2' }, { type: 'text', text: 'Waiting.' },
    ] }, { ...result, toolCallId: 'call_2' }])
    assert.deepEqual(second.input.slice(0, first.input.length), first.input)
    assert.deepEqual(second.input.map(item => item.type), [
      'message', 'message', 'function_call', 'function_call_output', 'message', 'function_call', 'message', 'function_call_output',
    ])
  })

  it('appends developer updates in place without lifting them into the old prefix', () => {
    const history = [text('system', 'Base'), text('user', 'Go'), { role: 'assistant' as const, content: [call] }, result]
    const before = body(history)
    const after = body([...history, text('developer', 'New context'), text('user', 'Continue')])
    assert.deepEqual(after.input.slice(0, before.input.length), before.input)
    assert.equal(after.input[0].role, 'developer')
    assert.equal(after.input.at(-2).role, 'developer')
    assert.equal('instructions' in after, false)
  })

  it('does not drop an out-of-band system prompt when a later developer update arrives', () => {
    const history = [text('user', 'Start')]
    const before = body(history, { system: 'Stable base' })
    const after = body([...history, text('developer', 'Later update')], { system: 'Stable base' })
    assert.deepEqual(after.input.slice(0, before.input.length), before.input)
    assert.equal(after.input.at(-1).role, 'developer')
  })

  it('round-trips exact native item order, phases, IDs, raw arguments and opaque reasoning through JSON', () => {
    const saved = assistant()
    const before = JSON.stringify(saved)
    const converted = body([text('user', 'Go'), saved, result])
    assert.deepEqual(converted.input.slice(1, -1), native)
    assert.equal(converted.input.at(-1).call_id, call.id)
    assert.equal(JSON.stringify(saved), before)
    const continued = body([text('user', 'Go'), saved, result, text('user', 'Next')])
    assert.deepEqual(continued.input.slice(0, converted.input.length), converted.input)
  })

  it('keeps native state and empty reasoning blocks across the actual plugin request boundary', () => {
    const saved = assistant()
    const options = { provider: context.provider, model: context.model, messages: [saved], sessionId: 'session-1', purpose: 'compaction' } as const
    const translated = requestOf(options as never)
    assert.deepEqual(translated.messages[0].content, saved.content)
    assert.deepEqual(translated.messages[0].source, saved.source)
    assert.equal(translated.sessionId, options.sessionId)
    assert.equal(translated.purpose, options.purpose)
    assert.deepEqual(body(translated.messages.slice()).input, native)
  })

  for (const change of ['model', 'provider', 'account', 'edited-text', 'edited-arguments', 'pruned-block', 'bad-version', 'bad-item', 'missing-state']) {
    it(`degrades ${change} history without replaying stale opaque state`, () => {
      const saved = assistant()
      const source = saved.source as { provider: string, model: string, replayState: ReplayEnvelope }
      const overrides: Partial<HarnessRequest> = {}
      if (change === 'model') overrides.model = 'gpt-6-astra'
      if (change === 'provider') overrides.provider = 'another-route'
      if (change === 'account') source.replayState.response.scope = 'another-account'
      if (change === 'edited-text') saved.content[1].text = 'Edited'
      if (change === 'edited-arguments') saved.content[2].arguments = '{}'
      if (change === 'pruned-block') {
        saved.content = saved.content.slice(1)
        source.replayState.blocks = source.replayState.blocks.slice(1)
      }
      if (change === 'bad-version') source.replayState.response.version = 99 as never
      if (change === 'bad-item') source.replayState.response.output[0] = { type: 'unexpected' } as never
      if (change === 'missing-state') delete source.replayState
      const converted = body([saved, result], overrides)
      assert.ok(converted.input.every(item => item.type !== 'reasoning'))
      assert.ok(converted.input.some(item => item.type === 'function_call'))
      assert.equal(converted.input.at(-1).type, 'function_call_output')
    })
  }
})

describe('indexed Responses streaming', () => {
  it('keeps two reasoning items and two text items separate, including an empty summary', () => {
    const chunks = responseChunks()
    assert.deepEqual(chunks.filter(c => c.type === 'block-start').map(c => c.blockType), ['reasoning', 'text', 'tool-call', 'reasoning', 'text'])
    assert.deepEqual(chunks.filter(c => c.type === 'block-end').map(c => c.index), [0, 1, 2, 3, 4])
    const usageIndex = chunks.findIndex(c => c.type === 'usage')
    assert.ok(usageIndex > chunks.map(c => c.type).lastIndexOf('block-end'))
    assert.deepEqual(chunks[usageIndex], { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 800, cacheWriteTokens: 100 } })
    assert.equal(chunks.at(-1).type, 'finish')
  })

  it('associates interleaved deltas with their output indexes', () => {
    const translator = new BlockTranslator(context)
    const chunks = [
      ...feed(translator, { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', summary: [] } }),
      ...feed(translator, { type: 'response.output_item.added', output_index: 1, item: { type: 'message', role: 'assistant', content: [] } }),
      ...feed(translator, { type: 'response.output_text.delta', output_index: 1, delta: 'Answer' }),
      ...feed(translator, { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'Plan' }),
      ...translator.push({ kind: 'completed' }),
    ]
    assert.deepEqual(chunks.filter(c => c.type === 'block-end').map(c => c.block), [
      { type: 'reasoning', text: 'Plan' }, { type: 'text', text: 'Answer' },
    ])
  })

  it('can recover a complete response that has only a terminal snapshot', () => {
    const chunks = feed(new BlockTranslator(context), { type: 'response.completed', response: { output: native } })
    assert.deepEqual(body([assistant(chunks)]).input, native)
  })

  it('retains item.done output when the SIWC terminal response has an empty output array', () => {
    const translator = new BlockTranslator(context)
    const chunks: AdapterChunk[] = []
    native.forEach((item, index) => chunks.push(...feed(translator, {
      type: 'response.output_item.done', output_index: index, item,
    })))
    chunks.push(...feed(translator, { type: 'response.completed', response: { output: [] } }))
    assert.deepEqual(body([assistant(chunks)]).input, native)
  })

  it('does not replay incomplete or failed output and emits nothing after terminal', () => {
    for (const terminal of [
      { kind: 'incomplete' as const, reason: 'max_output_tokens' },
      { kind: 'failed' as const, code: 'server_error', message: 'lost', terminal: false },
    ]) {
      const translator = new BlockTranslator(context)
      translator.push({ kind: 'itemStart', index: 0, item: native[0] })
      const finish = translator.push(terminal).at(-1)
      assert.equal(finish.type, 'finish')
      assert.equal(finish.replayState, undefined)
      assert.deepEqual(translator.push({ kind: 'completed', output: native }), [])
    }
  })

  it('preserves a refusal item rather than silently dropping it', () => {
    const refusal: OutputItem = { type: 'message', role: 'assistant', id: 'msg_refusal', content: [{ type: 'refusal', refusal: 'Cannot do that.' }] }
    const chunks = feed(new BlockTranslator(context), { type: 'response.completed', response: { output: [refusal] } })
    assert.deepEqual(body([assistant(chunks)]).input, [refusal])
  })

  it('retains reported usage on incomplete/failed responses without saving replay state', () => {
    for (const type of ['response.incomplete', 'response.failed']) {
      const chunks = feed(new BlockTranslator(context), { type, response: {
        error: { code: 'server_error', message: 'interrupted' },
        incomplete_details: { reason: 'max_output_tokens' },
        usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 4 },
      } })
      assert.deepEqual(chunks[0], { type: 'usage', usage: { inputTokens: 200, cacheReadTokens: 800, outputTokens: 4 } })
      assert.equal(chunks[1].type, 'finish')
      assert.equal(chunks[1].replayState, undefined)
      assert.notEqual(chunks[1].reason.kind, 'stop')
    }
  })
})

describe('session cache identity', () => {
  it('uses bounded stable keys, isolated by account, endpoint, route, session and purpose', () => {
    const scope = accountScope('https://api.openai.com/v1', 'client', 'subject')
    assert.equal(scope, accountScope('https://api.openai.com/v1/', 'client', 'subject'))
    const key = sessionCacheKey(scope, 'chatgpt', 's'.repeat(100))
    assert.match(key, /^[a-f0-9]{64}$/)
    assert.equal(key, sessionCacheKey(scope, 'chatgpt', 's'.repeat(100)))
    for (const other of [
      sessionCacheKey(accountScope('https://api.openai.com/v1', 'client', 'other'), 'chatgpt', 's'.repeat(100)),
      sessionCacheKey(accountScope('https://another.example/v1', 'client', 'subject'), 'chatgpt', 's'.repeat(100)),
      sessionCacheKey(scope, 'other', 's'.repeat(100)),
      sessionCacheKey(scope, 'chatgpt', 'different'),
      sessionCacheKey(scope, 'chatgpt', 's'.repeat(100), 'session-title'),
    ]) assert.notEqual(key, other)
    assert.equal(sessionCacheKey(scope, 'chatgpt'), undefined)
  })
})
