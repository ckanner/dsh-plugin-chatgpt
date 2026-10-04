import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BlockTranslator } from '../src/convert/blocks.ts'
import type { ResponsesEvent } from '../src/api/events.ts'

/** Feed a sequence through one translator and collect every chunk. */
function run(events: readonly ResponsesEvent[], translator = new BlockTranslator()) {
  const chunks = events.flatMap(event => translator.push(event))
  return { chunks, translator }
}

/** Assert the chunk stream is a well-formed sequence of numbered blocks. */
function assertBlocksAreWellFormed(chunks: readonly { type: string, index?: number }[]): void {
  const started = new Set<number>()
  const ended = new Set<number>()
  for (const chunk of chunks) {
    if (chunk.index === undefined) continue
    if (chunk.type === 'block-start') {
      assert.equal(started.has(chunk.index), false, `block ${chunk.index} started twice`)
      assert.equal(ended.has(chunk.index), false, `block ${chunk.index} started after ending`)
      started.add(chunk.index)
    }
    if (chunk.type === 'block-end') {
      assert.equal(started.has(chunk.index), true, `block ${chunk.index} ended before starting`)
      assert.equal(ended.has(chunk.index), false, `block ${chunk.index} ended twice`)
      ended.add(chunk.index)
    }
  }
  assert.deepEqual([...started].sort((a, b) => a - b), [...ended].sort((a, b) => a - b))
}

describe('BlockTranslator usage', () => {
  it('reports what the call cost, before the finish that ends it', () => {
    const translator = new BlockTranslator()
    translator.push({ kind: 'text', delta: 'hi' })

    const chunks = translator.push({
      kind: 'completed',
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 8 },
    })

    // The meter accounts for the call when the stream ends, so a total delivered
    // after the finish is never counted — which is how these readouts go blank.
    const types = chunks.map(chunk => chunk.type)
    assert.deepEqual(types, ['block-end', 'usage', 'finish'])
    assert.deepEqual(chunks[1], {
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cacheReadTokens: 8 },
    })
  })

  it('still finishes a call the provider reported no usage for', () => {
    const translator = new BlockTranslator()

    const types = translator.push({ kind: 'completed' }).map(chunk => chunk.type)

    assert.deepEqual(types, ['finish'])
  })
})

describe('BlockTranslator', () => {
  it('opens one text block, streams its deltas, and closes it with the whole text', () => {
    const { chunks } = run([
      { kind: 'text', delta: 'Hel' },
      { kind: 'text', delta: 'lo' },
      { kind: 'completed' },
    ])

    assert.deepEqual(chunks, [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hel' },
      { type: 'text-delta', index: 0, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    assertBlocksAreWellFormed(chunks)
  })

  it('gives reasoning and text their own blocks', () => {
    const { chunks } = run([
      { kind: 'reasoning', delta: 'why' },
      { kind: 'text', delta: 'answer' },
      { kind: 'completed' },
    ])

    assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-start'), [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'block-start', index: 1, blockType: 'text' },
    ])
    assert.deepEqual(chunks.at(-2), { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } })
    assertBlocksAreWellFormed(chunks)
  })

  it('opens a fresh text block when the model speaks again after a tool call', () => {
    // Speak, call, speak: three blocks, in the order the model produced them.
    const { chunks } = run([
      { kind: 'text', delta: 'let me check' },
      { kind: 'toolCallStart', index: 5, callId: 'call_1', name: 'read_file' },
      { kind: 'toolCallDelta', index: 5, delta: '{"path":' },
      { kind: 'toolCallDelta', index: 5, delta: '"a.txt"}' },
      { kind: 'toolCallEnd', index: 5, arguments: '{"path":"a.txt"}' },
      { kind: 'text', delta: 'it says hello' },
      { kind: 'completed' },
    ])

    assert.deepEqual(chunks.filter(chunk => chunk.type === 'block-start'), [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'block-start', index: 2, blockType: 'text' },
    ])
    assert.deepEqual(chunks.find(chunk => chunk.type === 'block-end' && chunk.index === 1), {
      type: 'block-end',
      index: 1,
      block: { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
    })
    assertBlocksAreWellFormed(chunks)
  })

  it('reports tool arguments as deltas, never as a parsed object', () => {
    const { chunks } = run([
      { kind: 'toolCallStart', index: 0, callId: 'c', name: 't' },
      { kind: 'toolCallDelta', index: 0, delta: '{"a"' },
    ])

    // The call's identity travels on the opening block-start; deltas carry only
    // argument text, so a half-written JSON fragment is never a parsed value.
    assert.deepEqual(chunks, [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'c', name: 't', argumentsDelta: '{"a"' },
    ])
  })

  it('prefers the authoritative argument string from the done event', () => {
    const { chunks } = run([
      { kind: 'toolCallStart', index: 0, callId: 'c', name: 't' },
      { kind: 'toolCallDelta', index: 0, delta: '{"a":1}' },
      // A server that re-sends a delta would leave the accumulation doubled.
      { kind: 'toolCallEnd', index: 0, arguments: '{"a":1}' },
    ])

    const end = chunks.find(chunk => chunk.type === 'block-end')
    assert.deepEqual(end?.type === 'block-end' ? end.block : undefined, {
      type: 'tool-call', id: 'c', name: 't', arguments: '{"a":1}',
    })
  })

  it('finishes with tool-calls when the model called one', () => {
    const { chunks } = run([
      { kind: 'toolCallStart', index: 0, callId: 'c', name: 't' },
      { kind: 'toolCallEnd', index: 0, arguments: '{}' },
      { kind: 'completed' },
    ])

    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('closes open blocks before reporting a failure', () => {
    const { chunks } = run([
      { kind: 'text', delta: 'half an ans' },
      { kind: 'failed', code: 'subscription_sharing_usage_limit_exceeded', message: 'out of allowance', terminal: true },
    ])

    // The partial answer is preserved rather than discarded, and the finish
    // follows ended blocks.
    assert.deepEqual(chunks, [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'half an ans' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'half an ans' } },
      {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'out of allowance', code: 'subscription_sharing_usage_limit_exceeded' },
        },
      },
    ])
    assertBlocksAreWellFormed(chunks)
  })

  it('reports an incomplete response as max-tokens, not as a clean stop', () => {
    const { chunks } = run([
      { kind: 'text', delta: 'truncated' },
      { kind: 'incomplete', reason: 'max_output_tokens' },
    ])

    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } })
  })

  it('ends an open tool call when the stream is cut off mid-call', () => {
    const translator = new BlockTranslator()
    translator.push({ kind: 'toolCallStart', index: 0, callId: 'c', name: 't' })
    translator.push({ kind: 'toolCallDelta', index: 0, delta: '{"partial"' })

    // A cancelled turn: the caller decides to stop, and must not leave a block open.
    const chunks = translator.endAll()

    assert.deepEqual(chunks, [{
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'c', name: 't', arguments: '{"partial"' },
    }])
  })

  it('ignores a tool delta for a call it never saw open', () => {
    const { chunks } = run([
      { kind: 'toolCallDelta', index: 9, delta: '{"a"' },
      { kind: 'toolCallEnd', index: 9, arguments: '{}' },
    ])

    assert.deepEqual(chunks, [])
  })

  it('never closes the same tool call twice', () => {
    const { chunks } = run([
      { kind: 'toolCallStart', index: 0, callId: 'c', name: 't' },
      { kind: 'toolCallEnd', index: 0, arguments: '{}' },
      { kind: 'toolCallEnd', index: 0, arguments: '{}' },
    ])

    assert.equal(chunks.filter(chunk => chunk.type === 'block-end').length, 1)
  })

  it('carries usage and finish only after every block has ended', () => {
    const { chunks } = run([
      { kind: 'reasoning', delta: 'r' },
      { kind: 'text', delta: 't' },
      { kind: 'completed', responseId: 'resp_1', usage: { totalTokens: 5 } },
    ])

    const finishAt = chunks.findIndex(chunk => chunk.type === 'finish')
    const lastEndAt = chunks.map(chunk => chunk.type).lastIndexOf('block-end')
    const usageAt = chunks.findIndex(chunk => chunk.type === 'usage')
    assert.ok(finishAt > lastEndAt)
    // This test was named for the usage it never checked, which is how a stream
    // that dropped every total kept a passing test while the rate, cache ratio,
    // and context share readouts stayed empty.
    assert.ok(usageAt > lastEndAt, 'usage must follow the blocks')
    assert.ok(usageAt < finishAt, 'usage must arrive before the call ends')
    assert.deepEqual(chunks[usageAt], { type: 'usage', usage: { totalTokens: 5 } })
    assertBlocksAreWellFormed(chunks)
  })
})
