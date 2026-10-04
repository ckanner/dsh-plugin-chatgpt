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

import z, { type Volatile } from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  AdapterRegistrationHandle, DirectoryRegistrationHandle, GenerateOptions, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { ChatGptAdapter, isCodedError, type HarnessMessage, type HarnessRequest } from './adapter.ts'
import { ChatGptAuth } from './auth/manager.ts'
import { ChatGptController } from './controller.ts'
import { ChatGptSession } from './session.ts'
import type { AdapterChunk } from './convert/blocks.ts'

/**
 * Route and endpoint policy for one installation.
 *
 * This is a schema rather than a bare interface for two reasons. It validates
 * what the profile supplies, and a declared schema is what gives this plugin a
 * settings namespace: the Models page derives its namespace map from plugins that
 * declare one, and renders a provider row only for a row whose namespace exists.
 * A plugin with config but no schema therefore has a route the page cannot show.
 */
export const Config = z.object({
  /** Provider route this plugin serves. */
  provider: z.string().required().volatile(),
  /** Display name for the provider row and the account card. */
  displayName: z.string().volatile(),
  /** Directory this installation's ChatGPT state lives in. */
  stateDir: z.string().required().volatile(),
  /** API base URL override; defaults to the documented resource. */
  baseUrl: z.string().volatile(),
})

/** The configuration one installation supplies, as the harness resolves it. */
export type Config = {
  provider: Volatile<string>
  displayName: Volatile<string>
  stateDir: Volatile<string>
  baseUrl: Volatile<string>
}

/** What this plugin calls itself in diagnostics. */
export const name = 'chatgpt'

/**
 * The settings namespace this plugin's provider row belongs to, and the key its
 * browser card registers under.
 *
 * The Models page dispatches a card's extension area by the row's settings
 * namespace, so the two halves have to agree on one string. Keeping it beside the
 * route it describes is what makes that agreement visible.
 */
export const SETTINGS_NS = 'chatgpt'

/**
 * The name a human reads on the consent screen, and this app's identity at OpenAI.
 *
 * Separate from the display name on purpose: renaming the row in the UI must not
 * change what an already-granted client id was registered as, because the issued
 * client id is bound to the identity the human consented to.
 */
export const AGENT_NAME_HINT = 'DeepSeek Harness'

/**
 * The services this plugin needs before it can register anything.
 *
 * Cordis resolves injected services before `apply` runs, and reading `ctx.llm`
 * without declaring it throws rather than answering undefined. The registry is
 * the whole dependency: with no registry there is no route to own.
 */
export const inject = ['llm']

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
 * Give one thrown value the harness's error taxonomy.
 *
 * The harness classifies a provider failure by reading `code` and any status off
 * the thrown error, and reports anything else as a bare `UNKNOWN` — so a coded
 * error from this plugin's own layers is translated here, at the one boundary
 * that already depends on the host.
 *
 * @param error - whatever a lower layer threw.
 * @param fallbackCode - the code to use when the error carries none.
 * @returns the error to throw onward.
 */
function asHostError(error: unknown, fallbackCode: string): Error {
  if (error instanceof LlmError) return error
  if (isCodedError(error)) {
    return new LlmError(error.message, error.code, error.status === undefined ? {} : { status: error.status })
  }
  return new LlmError(error instanceof Error ? error.message : String(error), fallbackCode)
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
    try {
      const models = await this.inner.listModels()
      return models.map(model => ({ provider: this.route, id: model.id, name: model.name }))
    } catch (error) {
      throw asHostError(error, 'chatgpt_listing_failed')
    }
  }

  override async resolveModel(provider: string, model: string): Promise<ReturnType<LlmAdapter['resolveModel']> extends Promise<infer T> ? T : never> {
    return await this.inner.resolveModel(provider, model) as never
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk, void, undefined> {
    const chunks: AsyncGenerator<AdapterChunk, void, undefined> = this.inner.stream(
      options.provider,
      requestOf(options),
    )
    try {
      for await (const chunk of chunks) yield chunk as unknown as StreamChunk
    } catch (error) {
      throw asHostError(error, 'chatgpt_request_failed')
    }
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
  // This plugin owns a provider row and a card on it, not a settings page of its
  // own; without this the harness would generate one for the schema above.
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  const route = config.provider.get() ?? SETTINGS_NS
  const stateDir = config.stateDir.get()
  if (stateDir === undefined || stateDir.length === 0) {
    throw new Error('chatgpt: a state directory is required, so credentials have somewhere to live')
  }
  const displayName = config.displayName.get() ?? 'ChatGPT'
  const baseUrl = config.baseUrl.get() ?? ''
  const auth = new ChatGptAuth({
    stateDir,
    // Deliberately not the display name: this is the name a human reads on the
    // consent screen and the identity OpenAI records for the app, so renaming
    // the UI label must not change what a granted client id was registered as.
    agentNameHint: AGENT_NAME_HINT,
  })
  const inner = new ChatGptAdapter({
    auth,
    displayName,
    ...baseUrl.length === 0 ? {} : { baseUrl },
  })

  const adapter = new HarnessAdapter(inner, route)
  const handle: AdapterRegistrationHandle = ctx.llm.registerAdapter([route], adapter)
  ctx.effect(() => () => { handle() })

  // The row the Models page renders. A route with no directory entry exists for
  // the agent loop but is invisible to every configuration surface, which is why
  // this is registered even though the roster comes from the account.
  const directory: DirectoryRegistrationHandle = ctx.llm.registerConfigurableProviders([{
    provider: route,
    displayName,
    settingsNs: SETTINGS_NS,
    settingsPath: [],
  }])
  ctx.effect(() => () => { directory() })

  // The browser half reaches the sign-in through this service, under the
  // `chatgpt` namespace. Disposal is the parent's: the service lives and dies
  // with the plugin row that registered the route.
  const session = new ChatGptSession(auth, inner, {
    // What the browser model selector listens for. The account's roster arrives
    // after a sign-in that the selector slept through, so it has to be told.
    onRosterChanged: () => { ctx.emit('llm/adapters-updated') },
  })
  new ChatGptController(ctx, session)
}
