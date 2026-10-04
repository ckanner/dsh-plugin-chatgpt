/**
 * Translating a harness request into a Responses request.
 *
 * This endpoint is stricter than a chat-completions endpoint, and the strictness
 * is not optional: the plan-usage route rejects a request body carrying fields
 * that a normal API key call accepts. `temperature`, `max_output_tokens`,
 * `top_p`, and `truncation` are among the refused spellings, so a translation
 * that "helpfully" forwards the harness's sampling knobs produces a request the
 * server declines before the model ever sees it.
 *
 * Two more differences drive the shape here:
 *
 * - The input array is messages. A system-role item inside it is rejected, so
 *   the system prompt travels as `instructions`.
 * - Tool traffic is not a message role. A call is a `function_call` item and its
 *   result is a `function_call_output` item, both top-level, correlated by
 *   `call_id` rather than by position.
 *
 * Everything here works on a neutral request shape rather than the harness's own
 * types, so the translation can be tested against literal payloads.
 *
 * @module dsh-plugin-chatgpt/convert/request
 */

import { DIRECT_TOKEN_SCOPE } from '../auth/protocol.ts'

/** The request field a plan-usage call must always carry. */
export const STORE = false

/** The streaming flag a plan-usage call must always carry. */
export const STREAM = true

/**
 * Fields the plan-usage route refuses.
 *
 * Listed rather than merely omitted so a future caller cannot reintroduce one
 * by accident: an explicitly named refusal is a compile-time reminder, and this
 * array is what the tests assert against.
 */
export const REFUSED_FIELDS = [
  'background',
  'conversation',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'moderation',
  'multi_agent',
  'prompt',
  'prompt_cache_retention',
  'safety_identifier',
  'temperature',
  'top_logprobs',
  'top_p',
  'truncation',
  'user',
] as const

/** One text part of a message. */
export interface TextPart {
  type: 'text'
  text: string
}

/** One image part of a message, referenced by URL. */
export interface ImagePart {
  type: 'image'
  /** Either a data URL or an https URL the API can fetch. */
  url: string
}

/** Message content this adapter accepts. */
export type InputPart = TextPart | ImagePart

/** One conversation message in neutral form. */
export interface NeutralMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | readonly InputPart[]
}

/** One tool result the harness wants delivered back to the model. */
export interface NeutralToolResult {
  callId: string
  output: string
  /** Whether the tool call failed; reported to the model rather than thrown. */
  isError?: boolean
}

/** One tool call the model made on an earlier turn, being replayed. */
export interface NeutralToolCall {
  callId: string
  name: string
  /** Raw JSON string the model produced. */
  arguments: string
}

/**
 * One entry of the tool traffic, in the order it happened.
 *
 * A call and its result are different things that share a correlation id, and
 * the wire format wants them as separate top-level items in conversational
 * order. Keeping them in one ordered stream is what preserves that order — a
 * replayed call must precede the result that answers it.
 */
export type ToolTraffic =
  | { kind: 'call', call: NeutralToolCall }
  | { kind: 'result', result: NeutralToolResult }

/** A tool the model may call. */
export interface NeutralTool {
  name: string
  description: string
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>
}

/** One request, in the vocabulary this adapter consumes. */
export interface NeutralRequest {
  model: string
  /** Messages in order. Any `system` entries are lifted into `instructions`. */
  messages: readonly NeutralMessage[]
  /** An out-of-band system prompt, used when the messages carry none. */
  system?: string
  tools?: readonly NeutralTool[]
  /** Replayed calls and their results, in conversational order. */
  toolTraffic?: readonly ToolTraffic[]
  /** Provider-accepted reasoning effort spelling. */
  reasoningEffort?: string
  /** Cap on emitted tokens. Always omitted for now; see {@link REFUSED_FIELDS}. */
  maxTokens?: number
}

/**
 * An input item destined for the Responses `input` array.
 *
 * One shape covers the three item kinds this adapter sends, because the wire
 * format discriminates them by `type` and each kind reads a different subset.
 */
export interface InputItem {
  type: 'message' | 'function_call' | 'function_call_output'
  /** Present on a message item. */
  role?: 'user' | 'assistant'
  /** Present on a message item. */
  content?: readonly Record<string, unknown>[]
  /** Present on a replayed call and on the result that answers it. */
  call_id?: string
  /** Present on a replayed call. */
  name?: string
  /** Present on a replayed call: the raw JSON string the model produced. */
  arguments?: string
  /** Present on a result item. */
  output?: string
}

/** The body one plan-usage request carries. */
export interface ResponsesBody {
  model: string
  input: InputItem[]
  stream: typeof STREAM
  store: typeof STORE
  instructions?: string
  tools?: readonly { type: 'function', name: string, description: string, parameters: Record<string, unknown> }[]
  reasoning?: {
    effort: string
    /**
     * Ask for a readable summary of the model's thinking.
     *
     * Without a summary this route streams nothing at all until the answer begins,
     * so a thinking model looks like a hang: measured at 16.7 seconds of silence
     * before the first byte of a short answer.
     *
     * `concise` rather than `auto`, because `auto` lets the model decide and it
     * sometimes decides not to summarize: on a realistic request — a large
     * instruction block and a simple question at maximum effort — `auto` produced no
     * summary at all while `concise` produced one. Asking for a summary is the
     * entire point, so the length is fixed rather than left to chance.
     */
    summary: 'concise'
  }
}

/**
 * Text parts of one message as Responses content items.
 *
 * The content part a message carries depends on who sent it, and getting it wrong
 * is not a warning: an assistant turn replayed as `input_text` is refused with
 * `invalid_value`, which fails every request after the first, because only the
 * first has no history to replay. The endpoint accepts `output_text` and `refusal`
 * from an assistant and `input_text` and `input_image` from a user.
 *
 * @param role - who sent the message.
 * @param content - the message's text, or its parts.
 * @returns the content items to send.
 */
function contentItems(
  role: 'user' | 'assistant',
  content: string | readonly InputPart[],
): Record<string, unknown>[] {
  const textType = role === 'assistant' ? 'output_text' : 'input_text'
  if (typeof content === 'string') {
    return content.length === 0 ? [] : [{ type: textType, text: content }]
  }
  const items: Record<string, unknown>[] = []
  for (const part of content) {
    if (part.type === 'text') {
      if (part.text.length > 0) items.push({ type: textType, text: part.text })
      continue
    }
    // An assistant cannot attach an image, and the endpoint refuses one from it,
    // so a stray part is left out rather than failing the whole request. Nothing
    // produces one today; this keeps a future one from breaking every turn.
    if (role === 'assistant') continue
    items.push({ type: 'input_image', image_url: part.url })
  }
  return items
}

/**
 * Collect the system prompt.
 *
 * A `system` entry among the messages is lifted rather than forwarded, because
 * the wire format refuses a system-role item. The out-of-band `system` field is
 * used when the messages carry none, so a loop-built request and a one-shot
 * request both end up describing their instructions once.
 *
 * @param request - the neutral request.
 * @returns the instructions text, or `undefined` when there is none.
 */
function instructionsOf(request: NeutralRequest): string | undefined {
  const lifted = request.messages
    .filter(message => message.role === 'system')
    .map(message => typeof message.content === 'string'
      ? message.content
      : message.content.filter((part): part is TextPart => part.type === 'text').map(part => part.text).join('\n'))
    .filter(text => text.length > 0)
  if (lifted.length > 0) return lifted.join('\n\n')
  return request.system !== undefined && request.system.length > 0 ? request.system : undefined
}

/**
 * Translate one request into a plan-usage Responses body.
 *
 * The returned body deliberately carries no sampling knobs: see
 * {@link REFUSED_FIELDS} for why every one of them would be refused.
 *
 * @param request - the neutral request.
 * @returns the body to send.
 */
export function toResponsesBody(request: NeutralRequest): ResponsesBody {
  const instructions = instructionsOf(request)
  const input: InputItem[] = []

  for (const message of request.messages) {
    // Lifted into `instructions`; forwarding it would be refused.
    if (message.role === 'system') continue
    const content = contentItems(message.role, message.content)
    if (content.length === 0) continue
    input.push({ type: 'message', role: message.role, content })
  }

  // Tool traffic is top-level, correlated by call id, and in the order it
  // happened: a replayed call must precede the result that answers it.
  for (const entry of request.toolTraffic ?? []) {
    if (entry.kind === 'call') {
      input.push({
        type: 'function_call',
        call_id: entry.call.callId,
        name: entry.call.name,
        arguments: entry.call.arguments,
      })
      continue
    }
    input.push({
      type: 'function_call_output',
      call_id: entry.result.callId,
      output: entry.result.isError === true ? `Error: ${entry.result.output}` : entry.result.output,
    })
  }

  return {
    model: request.model,
    input,
    stream: STREAM,
    store: STORE,
    ...instructions === undefined ? {} : { instructions },
    ...request.tools === undefined || request.tools.length === 0 ? {} : {
      tools: request.tools.map(tool => ({
        type: 'function' as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    },
    ...request.reasoningEffort === undefined
      ? {}
      : { reasoning: { effort: request.reasoningEffort, summary: 'concise' as const } },
  }
}

/** The scope a usable credential must carry; re-exported for callers that gate on it. */
export { DIRECT_TOKEN_SCOPE }
