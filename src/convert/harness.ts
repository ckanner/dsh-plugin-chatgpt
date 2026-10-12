import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { HarnessMessage, HarnessRequest } from '../adapter.ts'

/** Translate one harness request into what the adapter reads. */
export function requestOf(options: GenerateOptions): HarnessRequest {
  const messages: HarnessMessage[] = options.messages.map(message => {
    const blocks = message.content.map((block) => {
      if (block.type === 'tool-call') {
        const call = block as { id: string, name: string, arguments: string }
        return { type: 'tool-call', id: String(call.id), name: call.name, arguments: call.arguments }
      }
      // An image block carries a durable attachment reference rather than bytes.
      // Resolving it needs the attachment service, which this adapter does not
      // yet take; the block is surfaced as text naming the omission so a
      // request that carried one is not silently thinner than it looks.
      if (block.type === 'image') return { type: 'text', text: '[image omitted: not yet supported]' }
      if (block.type === 'file') return { type: 'text', text: '[file omitted: not yet supported]' }
      if (block.type === 'text' || block.type === 'reasoning') return { type: block.type, text: block.text }
      return { type: 'text', text: '' }
    })

    const tool = message.role === 'tool' ? message as { toolCallId?: string, isError?: boolean } : undefined
    return {
      role: message.role,
      source: message.source,
      content: blocks,
      ...tool?.toolCallId === undefined ? {} : { toolCallId: String(tool.toolCallId) },
      ...tool?.isError === true ? { isError: true } : {},
    }
  })

  return {
    provider: options.provider,
    model: options.model,
    messages,
    ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
    ...options.purpose === undefined ? {} : { purpose: options.purpose },
    ...options.system === undefined ? {} : { system: options.system },
    ...options.reasoningEffort === undefined ? {} : { reasoningEffort: String(options.reasoningEffort) },
    ...options.tools === undefined ? {} : {
      tools: options.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    },
    ...options.signal === undefined ? {} : { signal: options.signal },
  }
}
