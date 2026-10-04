import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSseDecoder, decodeEvent, isPlanUsageCode } from '../src/api/events.ts'

/** Frame one event the way the endpoint does. */
function frame(event: unknown): string {
  return `event: something\ndata: ${JSON.stringify(event)}\n\n`
}

describe('decodeEvent', () => {
  it('reads a text delta', () => {
    assert.deepEqual(
      decodeEvent(JSON.stringify({ type: 'response.output_text.delta', delta: 'Hello' })),
      { kind: 'text', delta: 'Hello' },
    )
  })

  it('ignores a frame that carries no incremental content', () => {
    // Lifecycle markers are not errors; the caller simply has nothing to show.
    assert.equal(decodeEvent(JSON.stringify({ type: 'response.created' })), undefined)
    assert.equal(decodeEvent(JSON.stringify({ type: 'response.output_text.delta', delta: '' })), undefined)
  })

  it('reads a reasoning summary delta', () => {
    assert.deepEqual(
      decodeEvent(JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: 'thinking' })),
      { kind: 'reasoning', delta: 'thinking' },
    )
  })

  it('opens a tool call from an added function item', () => {
    assert.deepEqual(
      decodeEvent(JSON.stringify({
        type: 'response.output_item.added',
        output_index: 2,
        item: { type: 'function_call', call_id: 'call_abc', name: 'read_file' },
      })),
      { kind: 'toolCallStart', index: 2, callId: 'call_abc', name: 'read_file' },
    )
  })

  it('ignores an added item that is not a tool call', () => {
    assert.equal(
      decodeEvent(JSON.stringify({ type: 'response.output_item.added', item: { type: 'message' } })),
      undefined,
    )
  })

  it('accumulates tool arguments as separate deltas, never as parsed objects', () => {
    // The point of the delta contract: a consumer assembles the string itself,
    // so a half-written JSON fragment is never handed out as if it were parsed.
    assert.deepEqual(
      decodeEvent(JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"pa' })),
      { kind: 'toolCallDelta', index: 1, delta: '{"pa' },
    )
    assert.deepEqual(
      decodeEvent(JSON.stringify({ type: 'response.function_call_arguments.done', output_index: 1, arguments: '{"path":"a"}' })),
      { kind: 'toolCallEnd', index: 1, arguments: '{"path":"a"}' },
    )
  })

  it('treats response.completed as the only success terminal', () => {
    const completed = decodeEvent(JSON.stringify({
      type: 'response.completed',
      response: {
        id: 'resp_1',
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      },
    }))

    assert.deepEqual(completed, {
      kind: 'completed',
      responseId: 'resp_1',
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    })
  })

  it('reports an incomplete response as unfinished, not as success', () => {
    assert.deepEqual(
      decodeEvent(JSON.stringify({
        type: 'response.incomplete',
        response: { incomplete_details: { reason: 'max_output_tokens' } },
      })),
      { kind: 'incomplete', reason: 'max_output_tokens' },
    )
  })

  it('surfaces a plan usage failure that arrives after streaming began', () => {
    const failed = decodeEvent(JSON.stringify({
      type: 'response.failed',
      response: {
        error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'usage limit reached' },
      },
    }))

    assert.equal(failed?.kind, 'failed')
    assert.equal(failed?.kind === 'failed' ? failed.code : undefined, 'subscription_sharing_usage_limit_exceeded')
    assert.equal(failed?.kind === 'failed' ? failed.terminal : undefined, true)
    // The endpoint's own words are kept, and the documented recovery is added.
    assert.match(failed?.kind === 'failed' ? failed.message : '', /^usage limit reached/)
    assert.match(failed?.kind === 'failed' ? failed.message : '', /chatgpt\.com\/settings\/usage/)
  })

  it('takes cached input out of the input count, because the harness sums them', () => {
    // OpenAI folds cached input into `input_tokens`; the harness counts disjoint
    // buckets and adds them, so passing the wire value through bills it twice.
    const completed = decodeEvent(JSON.stringify({
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 1000,
          output_tokens: 50,
          total_tokens: 1050,
          input_tokens_details: { cached_tokens: 900 },
          output_tokens_details: { reasoning_tokens: 30 },
        },
      },
    }))

    assert.equal(completed?.kind, 'completed')
    assert.deepEqual(completed?.kind === 'completed' ? completed.usage : undefined, {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 1050,
      cacheReadTokens: 900,
      reasoningTokens: 30,
    })
  })

  it('reports a plain usage object unchanged', () => {
    const completed = decodeEvent(JSON.stringify({
      type: 'response.completed',
      response: { usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } },
    }))

    assert.deepEqual(completed?.kind === 'completed' ? completed.usage : undefined, {
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
    })
  })

  it('omits reasoning output that does not fit inside the output count', () => {
    // The meter refuses a reasoning count above the output count, so a provider
    // quirk must not turn a paid call into a rejected one.
    const completed = decodeEvent(JSON.stringify({
      type: 'response.completed',
      response: {
        usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 9 } },
      },
    }))

    assert.equal(completed?.kind === 'completed' ? completed.usage?.reasoningTokens : 'x', undefined)
  })

  it('tells the human where to act, not to retry, when the allowance is spent', () => {
    // Retrying a spent allowance cannot help, and the documentation names the
    // page that can: an app-specific limit may apply even when the plan has usage.
    const spent = decodeEvent(JSON.stringify({
      type: 'response.failed',
      response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'spent' } },
    }))
    const hint = spent?.kind === 'failed' ? spent.message : ''

    assert.match(hint, /no ChatGPT plan usage left/)
    assert.match(hint, /app-specific limit/)
  })

  it('calls a temporary unavailability retryable, unlike a spent allowance', () => {
    const unavailable = decodeEvent(JSON.stringify({
      type: 'response.failed',
      response: { error: { code: 'subscription_sharing_usage_unavailable', message: 'unknown' } },
    }))

    assert.match(unavailable?.kind === 'failed' ? unavailable.message : '', /retrying shortly/)
  })

  it('names the policy when the account is not eligible at all', () => {
    const ineligible = decodeEvent(JSON.stringify({
      type: 'response.failed',
      response: { error: { code: 'subscription_sharing_user_not_eligible', message: 'nope' } },
    }))

    assert.match(ineligible?.kind === 'failed' ? ineligible.message : '', /workspace or policy|cannot spend/)
  })

  it('leaves an unrelated failure message alone', () => {
    const failed = decodeEvent(JSON.stringify({
      type: 'response.failed',
      response: { error: { code: 'server_error', message: 'try later' } },
    }))

    assert.equal(failed?.kind === 'failed' ? failed.message : undefined, 'try later')
  })

  it('distinguishes a spent allowance from a temporary unavailability', () => {
    // Both are plan-usage codes, but only one is worth a bounded retry.
    assert.equal(isPlanUsageCode('subscription_sharing_usage_limit_exceeded'), true)
    assert.equal(isPlanUsageCode('subscription_sharing_usage_unavailable'), true)
    assert.equal(isPlanUsageCode('server_error'), false)

    const transient = decodeEvent(JSON.stringify({
      type: 'response.failed',
      response: { error: { code: 'server_error', message: 'try later' } },
    }))
    assert.equal(transient?.kind === 'failed' ? transient.terminal : undefined, false)
  })

  it('reads a top-level error frame, which carries no response object', () => {
    assert.deepEqual(
      decodeEvent(JSON.stringify({ type: 'error', error: { code: 'invalid_api_key', message: 'bad key' } })),
      { kind: 'failed', code: 'invalid_api_key', message: 'bad key', terminal: true },
    )
  })

  it('reports an unreadable payload rather than throwing mid-stream', () => {
    assert.deepEqual(decodeEvent('{ not json'), { kind: 'unknown', type: 'unparsable' })
    assert.deepEqual(decodeEvent(JSON.stringify({ nothing: true })), { kind: 'unknown', type: 'unrecognised' })
  })

  it('keeps an unknown event type visible instead of silently dropping it', () => {
    assert.deepEqual(decodeEvent(JSON.stringify({ type: 'response.something.new' })), {
      kind: 'unknown',
      type: 'response.something.new',
    })
  })
})

describe('createSseDecoder', () => {
  it('splits frames and ignores comments and other fields', () => {
    const decoder = createSseDecoder()

    const payloads = decoder.push(`: keep-alive\nevent: x\ndata: ${JSON.stringify({ type: 'a' })}\n\n`)

    assert.deepEqual(payloads, [JSON.stringify({ type: 'a' })])
  })

  it('reassembles a frame split across chunks at any byte', () => {
    const decoder = createSseDecoder()
    const whole = frame({ type: 'response.output_text.delta', delta: 'hi' })

    // Split one byte short, then deliver the rest.
    assert.deepEqual(decoder.push(whole.slice(0, whole.length - 3)), [])
    assert.deepEqual(decoder.push(whole.slice(whole.length - 3)), [
      JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' }),
    ])
  })

  it('returns several payloads from one chunk', () => {
    const decoder = createSseDecoder()

    const payloads = decoder.push(
      frame({ type: 'response.output_text.delta', delta: 'a' })
      + frame({ type: 'response.output_text.delta', delta: 'b' }),
    )

    assert.equal(payloads.length, 2)
  })

  it('joins a multi-line data field', () => {
    const decoder = createSseDecoder()

    assert.deepEqual(decoder.push('data: {"type":\ndata: "x"}\n\n'), ['{"type":\n"x"}'])
  })

  it('flushes a trailing frame that never got its blank line', () => {
    const decoder = createSseDecoder()

    assert.deepEqual(decoder.push('data: {"type":"x"}'), [])
    assert.deepEqual(decoder.flush(), ['{"type":"x"}'])
    // Flushing twice must not replay the same frame.
    assert.deepEqual(decoder.flush(), [])
  })
})
