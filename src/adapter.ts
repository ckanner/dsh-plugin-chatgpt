/**
 * The harness-facing adapter for a ChatGPT plan.
 *
 * This is the only module that knows both vocabularies. Everything below it —
 * the sign-in protocol, the request translation, the block numbering — is
 * deliberately independent of the harness so it can be tested without mounting
 * one; everything above it is the harness, which knows nothing about OpenAI's
 * stream format.
 *
 * Three behaviours here are policy rather than plumbing:
 *
 * - **Not being signed in is not an error.** The catalog is empty and the
 *   provider reports itself unconfigured, because a route with no account is a
 *   route waiting for one, not a broken route. Failing here would make the
 *   model selector unusable before the first sign-in.
 * - **A listing failure is not fatal to a call.** The model list is a
 *   convenience for the selector; a request naming a model directly is served
 *   with metadata from the catalog. Losing the listing must not lose the turn.
 * - **Model metadata is cached briefly.** The listing is a network call, and the
 *   selector may ask for it more than once per interaction. The cache is short
 *   because an account's entitlement can change under it, and a stale list is
 *   how a user is offered a model they can no longer call.
 *
 * @module dsh-plugin-chatgpt/adapter
 */

import { ApiError, listModels, streamTurn } from './client.ts'
import { BlockTranslator, type AdapterChunk } from './convert/blocks.ts'
import type { NeutralMessage, NeutralRequest, NeutralTool, ToolTraffic } from './convert/request.ts'
import { describableModels, type DescribedModel, type ListedModel } from './models/describe.ts'
import type { ChatGptAuth } from './auth/manager.ts'

/**
 * A failure that already carries a machine-readable code.
 *
 * This shape is what the plugin's own layers raise: the client sets a `code` off
 * the endpoint's answer, and the adapter sets one for its own refusals. The host
 * boundary translates it into the harness's error class, because that class
 * belongs to the host — naming it here would make this module unusable outside a
 * mounted harness, including in its own tests.
 */
export interface CodedError extends Error {
  /** Stable machine code, from the endpoint or from this plugin. */
  code: string
  /** HTTP status, when the failure was a response rather than a transport fault. */
  status?: number
  /** Whether the account's plan is what refused. */
  planUsage?: boolean
}

/**
 * Whether a thrown value already carries a usable code.
 *
 * A property check rather than `instanceof`: the harness may resolve a second
 * copy of this package, and an error thrown by one copy is not an instance of
 * the other's class.
 */
export function isCodedError(error: unknown): error is CodedError {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string'
}

/** Build one coded error for a refusal this adapter makes itself. */
function coded(message: string, code: string): CodedError {
  const error = new Error(message) as CodedError
  error.code = code
  return error
}

/** How long a model listing is reused before the account is asked again. */
const LISTING_TTL_MS = 60_000

/** What the adapter needs from the world around it. */
export interface ChatGptAdapterOptions {
  /** The credential owner this adapter asks for a usable grant. */
  auth: ChatGptAuth
  /** API base URL override (tests, gateways). */
  baseUrl?: string
  /** Display name for the provider row. */
  displayName?: string
  /** Clock, so the listing cache can be tested. */
  now?: () => number
}

/** One model as the harness reads a listing. */
export interface HarnessModelInfo {
  provider: string
  id: string
  name: string
  inputModalities: readonly ('text' | 'image')[]
}

/** Everything the harness may know about one model. */
export interface HarnessResolvedModel extends HarnessModelInfo {
  context: { contextWindow: number }
  defaultMaxTokens?: number
  reasoning?: {
    efforts: readonly { id: string, name: string, description?: string }[]
    defaultEffort?: string
  }
}

/** One request as the harness states it, reduced to what this adapter reads. */
export interface HarnessRequest {
  provider: string
  model: string
  messages: readonly HarnessMessage[]
  system?: string
  tools?: readonly { name: string, description: string, parameters: Record<string, unknown> }[]
  reasoningEffort?: string
  signal?: AbortSignal
}

/** One message as the harness states it. */
export interface HarnessMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  content: readonly HarnessBlock[]
  /** Present on a tool-role message: the call it answers. */
  toolCallId?: string
  isError?: boolean
}

/** One content block as the harness states it. */
export type HarnessBlock =
  | { type: 'text', text: string }
  | { type: 'reasoning', text: string }
  | { type: 'tool-call', id: string, name: string, arguments: string }
  | { type: string, [key: string]: unknown }

/** Reduce a harness message to the neutral shape the translation consumes. */
function neutralMessage(message: HarnessMessage): NeutralMessage {
  const text = message.content
    .map(block => (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string'
      ? (block as { text: string }).text
      : ''))
    .filter(value => value.length > 0)
    .join('\n')
  return {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: text,
  }
}

/**
 * Turn a harness request into the neutral request the client sends.
 *
 * Tool traffic is lifted out of the message stream into the top-level items the
 * wire format expects, keeping calls and their results in the order they
 * happened: a replayed call must precede the result that answers it, and leaving
 * either as a plain message would give the model a conversation it cannot
 * correlate.
 *
 * @param request - the harness request.
 * @returns the neutral request.
 */
export function toNeutralRequest(request: HarnessRequest): NeutralRequest {
  const messages: NeutralMessage[] = []
  const toolTraffic: ToolTraffic[] = []

  for (const message of request.messages) {
    if (message.role === 'tool') {
      const output = message.content
        .map(block => (block.type === 'text' ? (block as { text: string }).text : ''))
        .join('')
      if (message.toolCallId === undefined) continue
      toolTraffic.push({
        kind: 'result',
        result: {
          callId: message.toolCallId,
          output,
          ...message.isError === true ? { isError: true } : {},
        },
      })
      continue
    }

    // An assistant turn's calls are replayed as calls, ahead of the prose the
    // same turn produced.
    for (const block of message.content) {
      if (block.type !== 'tool-call') continue
      const call = block as { id: string, name: string, arguments: string }
      toolTraffic.push({
        kind: 'call',
        call: { callId: call.id, name: call.name, arguments: call.arguments },
      })
    }

    const neutral = neutralMessage(message)
    if (typeof neutral.content === 'string' && neutral.content.length > 0) messages.push(neutral)
  }

  const tools: NeutralTool[] = (request.tools ?? []).map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))

  return {
    model: request.model,
    messages,
    ...request.system === undefined ? {} : { system: request.system },
    ...tools.length === 0 ? {} : { tools },
    ...toolTraffic.length === 0 ? {} : { toolTraffic },
    ...request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort },
  }
}

/** Describe a listed model in the harness's vocabulary. */
function toHarnessResolved(provider: string, model: DescribedModel): HarnessResolvedModel {
  return {
    provider,
    id: model.id,
    name: model.name,
    inputModalities: model.input,
    context: { contextWindow: model.contextWindow },
    ...model.maxTokens === undefined ? {} : { defaultMaxTokens: model.maxTokens },
    ...model.reasoningEfforts === undefined ? {} : {
      reasoning: {
        efforts: model.reasoningEfforts,
        ...model.defaultReasoningEffort === undefined ? {} : { defaultEffort: model.defaultReasoningEffort },
      },
    },
  }
}

/**
 * Serves one harness provider route from a ChatGPT plan.
 *
 * The route name is supplied by the composition rather than fixed here, so the
 * same adapter can serve a private route alongside the built-in provider or
 * replace its name, without this module deciding.
 */
export class ChatGptAdapter {
  private readonly auth: ChatGptAuth
  private readonly baseUrl: string | undefined
  private readonly displayName: string
  private readonly now: () => number
  private listing: { at: number, models: DescribedModel[] } | undefined

  /**
   * @param options - the credential owner and endpoint policy.
   */
  constructor(options: ChatGptAdapterOptions) {
    this.auth = options.auth
    this.baseUrl = options.baseUrl
    this.displayName = options.displayName ?? 'ChatGPT'
    this.now = options.now ?? (() => Date.now())
  }

  /** The provider row this adapter describes. */
  providerInfo(provider: string): { id: string, name: string } {
    return { id: provider, name: this.displayName }
  }

  /**
   * The models this account may use, in the server's order.
   *
   * An account that is not signed in has none, which is an empty catalog rather
   * than a failure: the route exists and is waiting for a sign-in.
   *
   * @returns the describable models.
   */
  async listModels(): Promise<readonly DescribedModel[]> {
    const cached = this.listing
    if (cached !== undefined && this.now() - cached.at < LISTING_TTL_MS) return cached.models
    const credential = await this.auth.usable().catch(() => undefined)
    if (credential === undefined) return []
    let listed: ListedModel[]
    try {
      listed = await listModels(
        credential.accessToken,
        ...this.baseUrl === undefined ? [] : [{ baseUrl: this.baseUrl }],
      )
    } catch (error) {
      throw isCodedError(error)
        ? error
        : coded(String(error instanceof Error ? error.message : error), 'chatgpt_listing_failed')
    }
    const models = describableModels(listed)
    this.listing = { at: this.now(), models }
    return models
  }

  /** Drop the cached listing, so the next question re-asks the account. */
  forgetListing(): void {
    this.listing = undefined
  }

  /**
   * Everything known about one model.
   *
   * The listing is consulted first so an account-specific display name wins,
   * and the bundled catalog answers for a model the listing has not been asked
   * about — a direct call must not depend on a listing having happened.
   *
   * @param provider - the route.
   * @param model - the exact model id.
   * @returns the model's metadata.
   */
  async resolveModel(provider: string, model: string): Promise<HarnessResolvedModel> {
    const listed = (await this.listModels().catch(() => [])).find(entry => entry.id === model)
    const described = listed ?? describableModels([{ slug: model }])[0]
    /* c8 ignore next -- describableModels always answers for a non-empty slug */
    if (described === undefined) throw new Error(`no model named "${model}"`)
    return toHarnessResolved(provider, described)
  }

  /**
   * Refuse a model the account's own listing does not offer.
   *
   * The listing is the authority on entitlement, and asking for something else
   * does not fail loudly: the endpoint accepted a model this account could not
   * list and answered anyway, which means a request can be served by a different
   * model than the one that was asked for. A silent substitution is worse than a
   * refusal, because the transcript then records an answer as coming from a model
   * that never produced it.
   *
   * The check is deliberately skipped when the listing is unavailable — a
   * transport failure must not also fail every call — so it refuses only what the
   * account has positively told us it does not have.
   *
   * @param model - the model the caller asked for.
   * @throws {CodedError} code `chatgpt_model_not_available`.
   */
  private async assertServable(model: string): Promise<void> {
    let available: readonly DescribedModel[]
    try {
      available = await this.listModels()
    } catch {
      return
    }
    if (available.length === 0) return
    if (available.some(entry => entry.id === model)) return
    throw coded(
      `the signed-in ChatGPT account does not offer "${model}"; it offers ${available.map(entry => entry.id).join(', ')}`,
      'chatgpt_model_not_available',
    )
  }

  /**
   * Stream one turn.
   *
   * A credential that cannot be refreshed is reported as an authentication
   * failure rather than retried, because the recovery is a new sign-in and no
   * amount of retrying produces one.
   *
   * @param provider - the route (unused; one grant serves the account).
   * @param request - the harness request.
   * @returns the chunks for one assistant turn.
   */
  async *stream(provider: string, request: HarnessRequest): AsyncGenerator<AdapterChunk, void, undefined> {
    void provider
    let accessToken: string
    try {
      accessToken = (await this.auth.usable(request.signal)).accessToken
    } catch (error) {
      throw coded(
        `no usable ChatGPT credential: ${error instanceof Error ? error.message : String(error)}`,
        'chatgpt_not_signed_in',
      )
    }

    await this.assertServable(request.model)

    const translator = new BlockTranslator()
    const events = streamTurn({
      accessToken,
      request: toNeutralRequest(request),
      ...this.baseUrl === undefined ? {} : { endpoints: { baseUrl: this.baseUrl } },
      ...request.signal === undefined ? {} : { signal: request.signal },
    })
    try {
      for await (const event of events) {
        for (const chunk of translator.push(event)) yield chunk
      }
    } catch (error) {
      // A refused grant means this credential is finished; the next request
      // must not reuse it, so the listing is dropped with it.
      if (isCodedError(error) && (error.status === 401 || error.status === 403)) this.forgetListing()
      // Whatever went wrong, the blocks this turn opened still have to close, or
      // the harness holds a block that never ends.
      for (const chunk of translator.endAll()) yield chunk
      // Already coded when it came from the client; otherwise name it here so the
      // host has something better than an unknown failure to report.
      throw isCodedError(error) ? error : coded(String(error instanceof Error ? error.message : error), 'chatgpt_request_failed')
    }
  }
}
