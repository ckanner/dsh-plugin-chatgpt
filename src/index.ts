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
import { join } from 'node:path'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type {
  AdapterRegistrationHandle, DirectoryRegistrationHandle, GenerateOptions, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { ChatGptAdapter, isCodedError } from './adapter.ts'
import { ChatGptAuth } from './auth/manager.ts'
import { ChatGptController } from './controller.ts'
import { ChatGptSession } from './session.ts'
import type { AdapterChunk } from './convert/blocks.ts'
import { requestOf } from './convert/harness.ts'
import { createScopedFetch } from './http.ts'
import { WebProvider } from './web-provider.ts'
import { ManagedWebRuntime } from './web-runtime/index.ts'
import { WEB_MODEL, WebBridgeError } from './web-bridge/contracts.ts'
export { contentCapabilities, webCapabilities } from './capabilities.ts'

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
  /** Optional HTTP(S) proxy for this plugin's server-side OpenAI requests. */
  proxyUrl: z.string().volatile(),
  /** Explicit context budget used as-is; absent follows each model's account-catalog default. */
  contextWindowLimit: z.number().step(1).min(1024).volatile(),
  /** Exact model IDs with budgets that override the global context budget. */
  modelContextWindowLimits: z.dict(z.number().step(1).min(1024)).volatile(),
  /** Startup option; changing the dedicated Chrome executable remounts this plugin. */
  webChromeExecutable: z.string(),
  /** Attach to a user-launched loopback Chrome CDP endpoint instead of spawning an owned browser. */
  webCdpUrl: z.string(),
  /** Startup byte admission limit; changing it remounts this plugin. */
  webMaxInputBytes: z.number().step(1).min(1024),
})

/** The configuration one installation supplies, as the harness resolves it. */
export type Config = {
  provider: Volatile<string>
  displayName: Volatile<string>
  stateDir: Volatile<string>
  baseUrl: Volatile<string>
  proxyUrl: Volatile<string>
  contextWindowLimit: Volatile<number>
  modelContextWindowLimits: Volatile<Record<string, number>>
  webChromeExecutable?: string
  webCdpUrl?: string
  webMaxInputBytes?: number
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
    const requestId = 'requestId' in error && typeof error.requestId === 'string' ? error.requestId : undefined
    return new LlmError(error.message, error.code, { ...error.status === undefined ? {} : { status: error.status },
      ...requestId === undefined ? {} : { requestId } })
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
  private readonly web: WebProvider | undefined

  /**
   * @param inner - the adapter that talks to the API.
   * @param route - the provider route this instance serves.
   */
  constructor(inner: ChatGptAdapter, route: string, web?: WebProvider) {
    super()
    this.inner = inner
    this.route = route
    this.web = web
  }

  override providerInfo(provider: string): { id: string, name: string } {
    return this.inner.providerInfo(provider)
  }

  override async listModels(provider: string): Promise<readonly { provider: string, id: string, name: string }[]> {
    void provider
    try {
      const [siwc, web] = await Promise.allSettled([this.inner.listModels(), this.web?.listModels() ?? Promise.resolve([])])
      const browserModels = web.status === 'fulfilled' ? web.value : []
      if (siwc.status === 'rejected' && browserModels.length === 0) throw siwc.reason
      const models = siwc.status === 'fulfilled' ? siwc.value : []
      return [...models.filter(model => model.id !== WEB_MODEL).map(model => ({ provider: this.route, id: model.id, name: model.name })), ...browserModels]
    } catch (error) {
      throw asHostError(error, 'chatgpt_listing_failed')
    }
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<ReturnType<LlmAdapter['resolveModel']> extends Promise<infer T> ? T : never> {
    if (model === WEB_MODEL) {
      if (provider !== this.route || !this.web) throw new LlmError('GPT-6 Pro Web is not enabled for this provider.', 'WEB_DISABLED')
      try { return await this.web.resolveModel(signal) } catch (error) { throw asHostError(error, 'WEB_SETUP_REQUIRED') }
    }
    return await this.inner.resolveModel(provider, model) as never
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.model === WEB_MODEL) {
      if (!this.web) return this.unavailableWeb()
      return this.web.stream(options)
    }
    return this.streamSiwc(options)
  }

  private async *unavailableWeb(): AsyncGenerator<StreamChunk> { throw new LlmError('GPT-6 Pro Web is not enabled.', 'WEB_DISABLED') }

  private async *streamSiwc(options: GenerateOptions): AsyncGenerator<StreamChunk, void, undefined> {
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
  const transport = createScopedFetch(config.proxyUrl.get())
  ctx.effect(() => () => {
    // Cordis awaits async disposers before unload/remount completes.
    return transport.close().catch(error => {
      console.error('chatgpt: failed to close proxy transport', error)
    })
  })
  const auth = new ChatGptAuth({
    fetch: transport.fetch,
    stateDir,
    // Deliberately not the display name: this is the name a human reads on the
    // consent screen and the identity OpenAI records for the app, so renaming
    // the UI label must not change what a granted client id was registered as.
    agentNameHint: AGENT_NAME_HINT,
  })
  const inner = new ChatGptAdapter({
    fetch: transport.fetch,
    auth,
    displayName,
    contextWindowLimit: () => config.contextWindowLimit.get(),
    modelContextWindowLimits: () => config.modelContextWindowLimits.get(),
    // A listing that recovers must clear a cached provider failure in the
    // browser's model selector; see the callback's documentation.
    onListingRecovered: () => { ctx.emit('llm/adapters-updated') },
    resolveAttachments: () => ctx.get('attachments'),
    ...baseUrl.length === 0 ? {} : { baseUrl },
  })

  const executable = config.webChromeExecutable
  const attachCdpUrl = config.webCdpUrl
  const maxInputBytes = config.webMaxInputBytes
  const web = new WebProvider({
    provider: route,
    runtime: new ManagedWebRuntime({ stateDirectory: join(stateDir, 'web'), provider: route,
      ...executable ? { chromeExecutable: executable } : {}, ...attachCdpUrl ? { attachCdpUrl } : {},
      ...maxInputBytes === undefined ? {} : { maxInputBytes } }),
    contextBudget: () => config.modelContextWindowLimits.get()?.[WEB_MODEL] ?? config.contextWindowLimit.get(),
    resolveAttachments: () => ctx.get('attachments'),
    errorFactory: (message, code, status, requestId) => new LlmError(message, code, { status,
      ...requestId === undefined ? {} : { requestId } }),
    onChanged: () => { ctx.emit('llm/adapters-updated') },
  })
  ctx.effect(() => () => web.dispose().catch(error => { console.error('chatgpt: Web client shutdown failed',
    error instanceof WebBridgeError ? error.code : 'WEB_SHUTDOWN_FAILED') }))
  const adapter = new HarnessAdapter(inner, route, web)
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
  new ChatGptController(ctx, session, web)
}
