/**
 * An ordered conversation for the public SIWC Responses route. Moving tool
 * results behind later messages breaks conversation semantics and cache reuse.
 */
import { DIRECT_TOKEN_SCOPE } from '../auth/protocol.ts'
import type { OutputItem } from './replay.ts'

export const STORE = false
export const STREAM = true

/** Cache options remain disabled pending route-specific validation. */
export const REFUSED_FIELDS = [
  'background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata',
  'moderation', 'multi_agent', 'prompt', 'previous_response_id', 'prompt_cache_breakpoint',
  'prompt_cache_options', 'prompt_cache_retention', 'safety_identifier', 'temperature',
  'top_logprobs', 'top_p', 'truncation', 'user',
] as const

export interface TextPart { type: 'text', text: string }
export interface ImagePart { type: 'image', url: string }
export interface ToolCallPart { type: 'tool-call', id: string, name: string, arguments: string }
export type InputPart = TextPart | ImagePart | ToolCallPart

export interface NeutralMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  content: string | readonly InputPart[]
  toolCallId?: string
  isError?: boolean
  /** Validated native items from this assistant message's durable state. */
  replay?: readonly OutputItem[]
}

export interface NeutralTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface NeutralRequest {
  model: string
  messages: readonly NeutralMessage[]
  /** Used when history has no leading system/developer instruction. */
  system?: string
  tools?: readonly NeutralTool[]
  reasoningEffort?: string
  maxTokens?: number
  cacheKey?: string
}

export type InputItem = Record<string, unknown> & { type: string }
export interface ResponsesBody {
  model: string
  input: InputItem[]
  stream: typeof STREAM
  store: typeof STORE
  prompt_cache_key?: string
  include: ['reasoning.encrypted_content']
  tools?: readonly { type: 'function', name: string, description: string, parameters: Record<string, unknown> }[]
  reasoning?: { effort: string, summary: 'concise' }
}

function textOf(content: NeutralMessage['content']): string {
  return typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join('')
}

/** Preserve message and assistant-block order; instruction roles stay in place. */
export function toResponsesBody(request: NeutralRequest): ResponsesBody {
  const input: InputItem[] = []
  const leadingRole = request.messages[0]?.role
  if (request.system && leadingRole !== 'system' && leadingRole !== 'developer') {
    input.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: request.system }] })
  }
  for (const message of request.messages) {
    if (message.role === 'assistant' && message.replay !== undefined) {
      input.push(...structuredClone(message.replay))
      continue
    }
    if (message.role === 'tool') {
      if (message.toolCallId === undefined) continue
      const output = textOf(message.content)
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.isError ? `Error: ${output}` : output })
      continue
    }
    const role = message.role === 'system' ? 'developer' : message.role
    const parts = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content
    let content: Record<string, unknown>[] = []
    const flush = () => {
      if (content.length > 0) input.push({ type: 'message', role, content })
      content = []
    }
    for (const part of parts) {
      if (part.type === 'tool-call') {
        if (role !== 'assistant') continue
        flush()
        input.push({ type: 'function_call', call_id: part.id, name: part.name, arguments: part.arguments })
      } else if (part.type === 'text') {
        if (part.text.length > 0) content.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text })
      } else if (role === 'user') {
        content.push({ type: 'input_image', image_url: part.url })
      }
    }
    flush()
  }
  return {
    model: request.model, input, stream: STREAM, store: STORE,
    include: ['reasoning.encrypted_content'],
    ...request.cacheKey === undefined ? {} : { prompt_cache_key: request.cacheKey },
    ...request.tools?.length ? {
      tools: request.tools.map(tool => ({ type: 'function' as const, name: tool.name, description: tool.description, parameters: tool.parameters })),
    } : {},
    ...request.reasoningEffort === undefined ? {} : { reasoning: { effort: request.reasoningEffort, summary: 'concise' } },
  }
}

export { DIRECT_TOKEN_SCOPE }
