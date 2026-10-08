/**
 * Reading the Responses API event stream.
 *
 * The stream, not the HTTP status, is where this endpoint reports most
 * outcomes. A request that was accepted can still fail partway through — a plan
 * usage limit is delivered as `response.failed` *after* text has already
 * streamed, because the server only learns the account's remaining allowance
 * when it starts billing the turn. So a consumer that treats "HTTP 200" as
 * success will show a half-written answer as a finished one.
 *
 * The one success terminal is `response.completed`. `response.incomplete` is
 * not a success, and neither is a stream that simply ends: both mean the turn
 * did not finish, and treating an early close as completion is how a truncated
 * answer becomes a plausible-looking wrong one.
 *
 * This module decodes the wire form into typed events and knows nothing about
 * any harness's own vocabulary, so it can be tested against captured frames.
 *
 * @module dsh-plugin-chatgpt-subscription/api/events
 */

/** One decoded stream event worth surfacing. */
export type ResponsesEvent =
  | { kind: 'text', delta: string }
  | { kind: 'reasoning', delta: string }
  | { kind: 'toolCallStart', index: number, callId: string, name: string }
  | { kind: 'toolCallDelta', index: number, delta: string }
  | { kind: 'toolCallEnd', index: number, arguments: string }
  | { kind: 'completed', responseId?: string, usage?: ResponsesUsage }
  | { kind: 'incomplete', reason: string }
  | { kind: 'failed', code: string, message: string, terminal: boolean }
  | { kind: 'unknown', type: string }

/**
 * Token accounting one completed response may report.
 *
 * The fields are the harness's, not the wire's, because the two disagree in a way
 * that silently corrupts a total: OpenAI folds cached input into `input_tokens`,
 * while the harness counts disjoint buckets and sums them. Reporting the wire
 * value unchanged would bill the cached tokens twice.
 */
export interface ResponsesUsage {
  /** Input tokens the account was not billed a cache read for. */
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/**
 * Plan-usage failures the caller must answer differently from a generic error.
 *
 * `limitExceeded` means the account's allowance is spent: retrying the same
 * request cannot help, and the honest response is to tell the human to check
 * their ChatGPT usage rather than to back off and try again.
 * `unavailable` means the plan could not be spent at all right now, which is
 * worth a bounded retry.
 */
const USAGE_CODES = new Set([
  'subscription_sharing_usage_limit_exceeded',
  'subscription_sharing_usage_unavailable',
])

/** Whether a failure code describes the account's plan rather than the request. */
export function isPlanUsageCode(code: string): boolean {
  return USAGE_CODES.has(code)
}

/** Where a user reviews and limits each app's use of their ChatGPT plan. */
export const USAGE_SETTINGS_URL = 'https://chatgpt.com/settings/usage'

/**
 * The action a plan-usage failure calls for, in the words the documentation
 * prescribes.
 *
 * The distinction matters because the two codes look alike and are not: an
 * exhausted allowance is a stop that the human resolves in their own ChatGPT
 * settings, while an unavailable one is worth retrying. Saying "try again" to a
 * spent allowance, or "check your usage" to a blip, sends the user the wrong way.
 *
 * @param code - the endpoint's error code.
 * @returns guidance to append to the failure message, or `undefined`.
 */
function recoveryHint(code: string): string | undefined {
  if (code === 'subscription_sharing_usage_limit_exceeded') {
    // The endpoint's own guidance for this code: "Do not assume the entire plan is
    // empty or infer a reset time from this code alone; an app-specific limit can
    // also apply." So the hint must not pick a cause — it says which two are
    // possible, where to look, and that the code carries no reset time.
    return 'This account has no ChatGPT plan allowance left for app inference right now, or an app-specific limit applies;'
      + ' the returned code does not say which.'
      + ` Review usage at ${USAGE_SETTINGS_URL} to see both the plan and this app's limit.`
      + " No reset time can be read from the code itself, so waiting is the only option"
      + ' unless an API key or another provider is available in the meantime.'
  }
  if (code === 'subscription_sharing_usage_unavailable') {
    return 'The plan usage could not be checked; retrying shortly is reasonable.'
  }
  if (code === 'subscription_sharing_user_not_eligible') {
    return 'This user, workspace, or policy cannot spend a ChatGPT plan on inference;'
      + ' check the ChatGPT account and workspace policy.'
  }
  return undefined
}

/** Read a nested object without assuming the wire shape. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/** Read a string field, or `undefined`. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Read a number field, or `undefined`. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read token usage from a response object, however much of it is present. */
function usageOf(response: Record<string, unknown> | undefined): ResponsesUsage | undefined {
  const usage = record(response?.['usage'])
  if (usage === undefined) return undefined
  const input = num(usage['input_tokens'])
  const output = num(usage['output_tokens'])
  const total = num(usage['total_tokens'])
  if (input === undefined && output === undefined && total === undefined) return undefined
  // OpenRouter-style detail objects, which the Responses API nests rather than
  // flattening into the totals.
  const details = record(usage['input_tokens_details'])
  const cached = num(details?.['cached_tokens'])
  const written = num(details?.['cache_write_tokens'])
  const reasoning = num(record(usage['output_tokens_details'])?.['reasoning_tokens'])
  // Both cache counts are folded into the input total, so they come out of it:
  // the harness bills input + cache reads + cache writes, and leaving them in
  // would count the same tokens twice.
  const cacheRead = cached === undefined || cached <= 0 ? undefined : cached
  const cacheWrite = written === undefined || written <= 0 ? undefined : written
  const uncachedInput = input === undefined
    ? undefined
    : Math.max(0, input - (cacheRead ?? 0) - (cacheWrite ?? 0))
  return {
    ...uncachedInput === undefined ? {} : { inputTokens: uncachedInput },
    ...output === undefined ? {} : { outputTokens: output },
    ...total === undefined ? {} : { totalTokens: total },
    ...cacheRead === undefined ? {} : { cacheReadTokens: cacheRead },
    ...cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite },
    // Reasoning output is a subset of the output count, and the meter refuses it
    // when it exceeds that, so it is reported only while it still fits.
    ...reasoning === undefined || output === undefined || reasoning > output ? {} : { reasoningTokens: reasoning },
  }
}

/**
 * Frames that report something happened without carrying anything to show.
 *
 * They are not errors, and they are not unknown: a consumer has nothing to do
 * with them. Reporting them as unrecognised would bury a genuine protocol
 * addition in lifecycle noise, which is exactly the signal this decoder's
 * `unknown` case exists to preserve.
 */
const LIFECYCLE_TYPES = new Set([
  'response.created',
  'response.queued',
  'response.in_progress',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.done',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.done',
  'response.reasoning_text.done',
])

/**
 * Decode one SSE `data` payload into an event, or `undefined` for frames this
 * plugin deliberately ignores.
 *
 * Ignored frames are the ones that carry no incremental content — lifecycle
 * markers such as `response.created` or `response.in_progress`. They are not
 * errors; the caller simply has nothing to show for them.
 *
 * @param payload - the JSON text of one `data:` line.
 * @returns the decoded event, or `undefined` when the frame says nothing.
 */
export function decodeEvent(payload: string): ResponsesEvent | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return { kind: 'unknown', type: 'unparsable' }
  }
  const event = record(parsed)
  const type = str(event?.['type'])
  if (event === undefined || type === undefined) return { kind: 'unknown', type: 'unrecognised' }
  if (LIFECYCLE_TYPES.has(type)) return undefined

  switch (type) {
    case 'response.output_text.delta': {
      const delta = str(event['delta']) ?? ''
      return delta.length === 0 ? undefined : { kind: 'text', delta }
    }
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta': {
      const delta = str(event['delta']) ?? ''
      return delta.length === 0 ? undefined : { kind: 'reasoning', delta }
    }
    case 'response.output_item.added': {
      const item = record(event['item'])
      if (str(item?.['type']) !== 'function_call') return undefined
      const index = num(event['output_index']) ?? 0
      return {
        kind: 'toolCallStart',
        index,
        callId: str(item?.['call_id']) ?? str(item?.['id']) ?? `call-${index}`,
        name: str(item?.['name']) ?? '',
      }
    }
    case 'response.function_call_arguments.delta': {
      const delta = str(event['delta']) ?? ''
      return delta.length === 0 ? undefined : { kind: 'toolCallDelta', index: num(event['output_index']) ?? 0, delta }
    }
    case 'response.function_call_arguments.done': {
      return {
        kind: 'toolCallEnd',
        index: num(event['output_index']) ?? 0,
        arguments: str(event['arguments']) ?? '',
      }
    }
    case 'response.completed': {
      const response = record(event['response'])
      const id = str(response?.['id'])
      const usage = usageOf(response)
      return {
        kind: 'completed',
        ...id === undefined ? {} : { responseId: id },
        ...usage === undefined ? {} : { usage },
      }
    }
    case 'response.incomplete': {
      const response = record(event['response'])
      const details = record(response?.['incomplete_details'])
      return { kind: 'incomplete', reason: str(details?.['reason']) ?? 'unknown' }
    }
    case 'response.failed':
    case 'error': {
      const source = type === 'error' ? event : record(event['response'])
      const error = record(source?.['error']) ?? record(event['error']) ?? {}
      const code = str(error['code']) ?? str(error['type']) ?? 'unknown_error'
      const reported = str(error['message']) ?? 'the response failed without a message'
      const hint = recoveryHint(code)
      return {
        kind: 'failed',
        code,
        message: hint === undefined ? reported : `${reported} ${hint}`,
        terminal: isPlanUsageCode(code) || code !== 'server_error',
      }
    }
    default:
      return { kind: 'unknown', type }
  }
}

/**
 * Split a byte stream into SSE `data` payloads.
 *
 * Server-sent events are separated by a blank line and may be split across
 * chunks at any byte, so framing is stateful: the trailing partial frame is
 * held until the next chunk completes it. `[DONE]` is not part of this
 * endpoint's vocabulary and is reported as a payload only if it really appears.
 *
 * @returns a push function and a flush function; both return whole payloads.
 */
export function createSseDecoder(): {
  push(chunk: string): string[]
  flush(): string[]
} {
  let buffer = ''
  return {
    push(chunk: string): string[] {
      buffer += chunk
      const payloads: string[] = []
      let separator = buffer.indexOf('\n\n')
      while (separator !== -1) {
        const frame = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        const payload = dataOf(frame)
        if (payload !== undefined) payloads.push(payload)
        separator = buffer.indexOf('\n\n')
      }
      return payloads
    },
    flush(): string[] {
      const frame = buffer
      buffer = ''
      const payload = frame.length === 0 ? undefined : dataOf(frame)
      return payload === undefined ? [] : [payload]
    },
  }
}

/** The joined `data:` lines of one frame, or `undefined` when it carries none. */
function dataOf(frame: string): string | undefined {
  const lines = frame.split('\n')
  const data: string[] = []
  for (const line of lines) {
    // Comments (leading ':') are keep-alives; every other field name is
    // ignored except `data`, which is the only one this endpoint uses.
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  return data.length === 0 ? undefined : data.join('\n')
}
