/**
 * The bundle's plugin entry point.
 *
 * A bundle is a configuration layer, so this module exists to do the two things
 * a layer cannot: own a live adapter instance, and register the provider route
 * that instance serves.
 *
 * The route name is configuration rather than a constant. The built-in pi-ai
 * plugin already serves a route literally named `openai`, and the registry
 * refuses a second registration of one name outright — so a plugin that reserved
 * that name could not be installed beside the built-in provider. A private name
 * works in both compositions, and one key lets an operator move it.
 *
 * @module dsh-plugin-chatgpt
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ChatGptAdapter, type HarnessMessage, type HarnessRequest } from './adapter.ts'
import { ChatGptAuth } from './auth/manager.ts'
import type { AdapterChunk } from './convert/blocks.ts'

/** Route and endpoint policy for one installation. */
export interface Config {
  /** Provider route this plugin serves. */
  provider?: string
  /** Display name for the provider row and the account card. */
  displayName?: string
  /** Directory this installation's ChatGPT state lives in. */
  stateDir: string
  /** API base URL override; defaults to the documented resource. */
  baseUrl?: string
}

/** What this plugin calls itself in diagnostics. */
export const name = 'chatgpt'

/** Translate one harness request into what the adapter reads. */
function requestOf(options: GenerateOptions): HarnessRequest {
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
      if (block.type === 'text') return { type: 'text', text: (block as { text: string }).text }
      return { type: 'text', text: '' }
    // An empty text block carries nothing and would only add noise to the request.
    }).filter(block => typeof block.text !== 'string' || block.text.length > 0)

    const tool = message.role === 'tool' ? message as { toolCallId?: string, isError?: boolean } : undefined
    return {
      role: message.role,
      content: blocks,
      ...tool?.toolCallId === undefined ? {} : { toolCallId: String(tool.toolCallId) },
      ...tool?.isError === true ? { isError: true } : {},
    }
  })

  return {
    provider: options.provider,
    model: options.model,
    messages,
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

/**
 * The harness's adapter contract over the plan adapter.
 *
 * The wrapping is mechanical: it renames the vocabulary and adapts the two
 * asynchronous shapes. Every decision lives below it, which is why the class
 * carries no policy of its own.
 */
export class HarnessAdapter extends LlmAdapter {
  private readonly inner: ChatGptAdapter
  private readonly route: string

  /**
   * @param inner - the adapter that talks to the API.
   * @param route - the provider route this instance serves.
   */
  constructor(inner: ChatGptAdapter, route: string) {
    super()
    this.inner = inner
    this.route = route
  }

  override providerInfo(provider: string): { id: string, name: string } {
    return this.inner.providerInfo(provider)
  }

  override async listModels(provider: string): Promise<readonly { provider: string, id: string, name: string }[]> {
    void provider
    const models = await this.inner.listModels()
    return models.map(model => ({ provider: this.route, id: model.id, name: model.name }))
  }

  override async resolveModel(provider: string, model: string): Promise<ReturnType<LlmAdapter['resolveModel']> extends Promise<infer T> ? T : never> {
    return await this.inner.resolveModel(provider, model) as never
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk, void, undefined> {
    const chunks: AsyncGenerator<AdapterChunk, void, undefined> = this.inner.stream(
      options.provider,
      requestOf(options),
    )
    for await (const chunk of chunks) yield chunk as unknown as StreamChunk
  }
}

/**
 * Register the ChatGPT provider route.
 *
 * The route goes into the harness's own registry, so the provider reaches every
 * consumer — the model selector, the settings page, and the agent loop — exactly
 * as a built-in provider does.
 *
 * @param ctx - the plugin context.
 * @param config - the installation's route and state location.
 */
export function apply(ctx: Context, config: Config): void {
  const route = config.provider ?? 'chatgpt'
  const auth = new ChatGptAuth({
    stateDir: config.stateDir,
    // The name a human reads on the consent screen, and the identity OpenAI
    // records for this app. It must be stable across installations.
    agentNameHint: config.displayName ?? 'DeepSeek Harness',
  })
  const inner = new ChatGptAdapter({
    auth,
    displayName: config.displayName ?? 'ChatGPT',
    ...config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl },
  })

  const handle: AdapterRegistrationHandle = ctx.llm.registerAdapter([route], new HarnessAdapter(inner, route))
  ctx.effect(() => () => { handle() })
}
