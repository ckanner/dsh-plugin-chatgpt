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

import { ApiError, listModels, streamTurn } from './api/client.ts'
import { BlockTranslator, type AdapterChunk } from './convert/blocks.ts'
import type { NeutralMessage, NeutralRequest, NeutralTool, ToolTraffic } from './convert/request.ts'
import type { ResponsesEvent } from './api/events.ts'
import { describableModels, describeModel, effortLabel, type DescribedModel, type ListedModel } from './models/describe.ts'
import { ROUTE_MAX_CONTEXT_WINDOW, ROUTE_MAX_OUTPUT_TOKENS, SERVED_MODELS, servedRecord } from './models/served.ts'
import type { ChatGptAuth } from './auth/manager.ts'
import { RefreshRefusedError } from './auth/refresh.ts'

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

/**
 * Whether a failure reads as a dropped connection rather than a decision.
 *
 * The wording is the built-in pi-ai adapter's, including undici's bare
 * `terminated` — what a mid-stream socket drop looks like once the real
 * SocketError has been flattened away — because a transient failure has to be
 * told apart from a refusal here: one is worth retrying, the other is not.
 *
 * @param message - the failure's text.
 * @returns whether it reads as transport.
 */
function isTransportFailure(message: string): boolean {
  return /\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b|\bterminated\b|premature close/i.test(message)
    || /\btime(?:d)?\s*out\b|timeout/i.test(message)
    || /\b5\d\d\b/.test(message)
    || /\b429\b|rate.?limit/i.test(message)
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
  /**
   * Offer the models measured to work on this route that the account's listing
   * omits. Defaults to true: the listing demonstrably leaves out models this
   * route serves, and hiding them hides capability the account already has.
   */
  includeUnlisted?: boolean
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

/**
 * Run one authenticated call, renewing the grant once if the endpoint refuses it.
 *
 * A stored token can be refused while it still looks valid locally: the endpoint
 * answers `token_expired` for a grant it invalidated server-side, and authorization
 * can change under a live session — an account upgrade, a workspace switch. A
 * local clock comparison cannot see either, so the endpoint's refusal is what
 * triggers a renewal, and the call is attempted twice at most.
 *
 * @param usable - mints a token from the stored grant, refreshing if it looks stale.
 * @param renew - exchanges the grant for a new one regardless of local expiry.
 * @param call - the authenticated call, given a token.
 * @returns what the call produced.
 * @throws the second attempt's failure, or the first one when a renewal was not the answer.
 */
async function withFreshGrant<T>(
  usable: () => Promise<{ accessToken: string }>,
  renew: () => Promise<{ accessToken: string }>,
  call: (accessToken: string) => Promise<T>,
): Promise<T> {
  const credential = await usable()
  try {
    return await call(credential.accessToken)
  } catch (error) {
    // Only an authentication refusal is worth a renewal; anything else would
    // spend a refresh token to be told the same thing again.
    if (!isCodedError(error) || (error.status !== 401 && error.status !== 403)) throw error
    const renewed = await renew()
    return await call(renewed.accessToken)
  }
}

/**
 * Classify a failure from getting a usable credential.
 *
 * "Not signed in" is one specific condition — this installation has no account, or
 * its grant was refused for good — and it must not be reported for a dropped
 * connection. Reporting a network blip as a missing credential sends the human to
 * sign in again over something a retry repairs, so a transport failure carries the
 * code the retry policy acts on instead.
 *
 * @param auth - the credential owner, asked whether any account is stored.
 * @param error - whatever the credential step or the first read threw.
 * @returns the coded failure to report.
 */
function credentialFailure(auth: ChatGptAuth, error: unknown): CodedError {
  const message = error instanceof Error ? error.message : String(error)
  if (auth.active() === undefined) {
    // `usable()` already says exactly this, so wrapping it would say it twice.
    return coded(message, 'chatgpt_not_signed_in')
  }
  if (error instanceof RefreshRefusedError) {
    return error.terminal
      ? coded(`the ChatGPT grant was refused and needs a new sign-in: ${message}`, 'chatgpt_not_signed_in')
      : coded(`the ChatGPT grant could not be renewed right now: ${message}`, 'TRANSPORT')
  }
  return isTransportFailure(message)
    ? coded(`the ChatGPT request could not reach the service: ${message}`, 'TRANSPORT')
    : coded(`the ChatGPT request could not be prepared: ${message}`, 'chatgpt_request_failed')
}

/** Describe a listed model in the harness's vocabulary. */
function toHarnessResolved(provider: string, model: DescribedModel): HarnessResolvedModel {
  return {
    provider,
    id: model.id,
    name: model.name,
    inputModalities: model.input,
    // The harness models one capacity per model, so it gets the largest the
    // endpoint advertises rather than the smaller default. Measured: a request
    // well past the advertised default context was accepted, so reporting the
    // default would understate what the model can hold and make the harness
    // compact sooner than it needs to.
    context: { contextWindow: model.maxContextWindow ?? model.contextWindow },
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
  private readonly includeUnlisted: boolean
  private readonly now: () => number
  private listing: { at: number, models: DescribedModel[] } | undefined

  /**
   * @param options - the credential owner and endpoint policy.
   */
  constructor(options: ChatGptAdapterOptions) {
    this.auth = options.auth
    this.baseUrl = options.baseUrl
    this.displayName = options.displayName ?? 'ChatGPT'
    this.includeUnlisted = options.includeUnlisted ?? true
    this.now = options.now ?? (() => Date.now())
  }

  /** The provider row this adapter describes. */
  providerInfo(provider: string): { id: string, name: string } {
    return { id: provider, name: this.displayName }
  }

  /**
   * The models this account advertises, in the server's order.
   *
   * This is a *roster for display*, not an allowlist. The endpoint lists what it
   * wants a picker to show, and it serves models that are absent from that list:
   * asked directly, it answers under the requested id and reports having done so.
   * Gating a call on membership here would refuse models the account can really
   * use — a mistake this plugin made once and should not make again.
   *
   * What the harness offers is therefore the roster; what a call may reach is
   * whatever the endpoint accepts, and its own error is the answer for a model
   * that does not exist.
   *
   * An account that is not signed in has no roster, which is an empty catalog
   * rather than a failure: the route exists and is waiting for a sign-in.
   *
   * @returns the describable models.
   */
  async listModels(): Promise<readonly DescribedModel[]> {
    const cached = this.listing
    if (cached !== undefined && this.now() - cached.at < LISTING_TTL_MS) return cached.models
    // No account is an empty roster, not a failure: the route exists and is
    // waiting for a sign-in, and a throwing listing would make the selector
    // unusable before the first one.
    if (this.auth.active() === undefined) return []
    let listed: ListedModel[]
    try {
      listed = await withFreshGrant(
        () => this.auth.usable(),
        () => this.auth.renew(),
        token => listModels(token, ...this.baseUrl === undefined ? [] : [{ baseUrl: this.baseUrl }]),
      )
    } catch (error) {
      throw isCodedError(error)
        ? error
        : coded(String(error instanceof Error ? error.message : error), 'chatgpt_listing_failed')
    }
    const models = this.rosterOf(listed)
    this.listing = { at: this.now(), models }
    return models
  }

  /**
   * The roster the selector offers: what the account advertises, plus the models
   * measured to work on this route that the listing leaves out.
   *
   * The listing is a curated selection, not an inventory. It omits models this
   * route serves — asked for by id, they answer — so a roster built from it alone
   * hides models the account paid for. The extra ids come from
   * {@link SERVED_MODELS}, which records when they were measured, because no
   * endpoint states them.
   *
   * A model the listing marks hidden is not offered: hidden is a deliberate
   * instruction about what a picker should show, and it is a different statement
   * from leaving a model unmentioned.
   *
   * @param listed - every entry the account's listing returned.
   * @returns the models to offer, listing order first.
   */
  private rosterOf(listed: readonly ListedModel[]): DescribedModel[] {
    const advertised = describableModels(listed).map(model => this.withMeasurement(model))
    const present = new Set(advertised.map(model => model.id))
    const extras = this.includeUnlisted
      ? SERVED_MODELS
          .filter(entry => !entry.advertised && !present.has(entry.id))
          .map(entry => {
            const described = describeModel({ slug: entry.id })
            // The listing says nothing about these, so both their capacity and
            // their accepted levels come from what the route measurably serves.
            return {
              ...described,
              contextWindow: ROUTE_MAX_CONTEXT_WINDOW,
              maxContextWindow: ROUTE_MAX_CONTEXT_WINDOW,
              maxTokens: described.maxTokens ?? ROUTE_MAX_OUTPUT_TOKENS,
              metadataSource: 'measured' as const,
            }
          })
      : []
    return [...advertised, ...extras]
  }

  /**
   * Overlay the measured facts about one model.
   *
   * The listing describes capacity and the endpoint accepts requests, but its
   * reasoning-level list is not reliable — it advertised a level the API refuses.
   * Where a measurement exists it wins, because the cost of offering a rejected
   * level is a failed turn.
   */
  private withMeasurement(model: DescribedModel): DescribedModel {
    const record = servedRecord(model.id)
    if (record === undefined) return model
    const efforts = record.reasoningEfforts.map(effort => ({ id: effort, name: effortLabel(effort) }))
    // `medium` is the published default wherever the model accepts it, matching
    // what the endpoint reports for the models it describes.
    const preferred = record.reasoningEfforts.includes('medium') ? 'medium' : undefined
    return {
      ...model,
      reasoningEfforts: efforts,
      ...preferred === undefined
        ? model.defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort: model.defaultReasoningEffort }
        : { defaultReasoningEffort: preferred },
    }
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
    const neutral = toNeutralRequest(request)
    const translator = new BlockTranslator()
    let events: AsyncGenerator<ResponsesEvent, void, undefined>
    let primed: IteratorResult<ResponsesEvent>
    try {
      ({ events, primed } = await withFreshGrant(
        () => this.auth.usable(request.signal),
        () => this.auth.renew(request.signal),
        // A generator is lazy, so a refused token would not surface until the
        // first read. Reading one step inside the retry is what lets the refusal
        // be answered here, before the caller has seen anything — and the event
        // that read produced is carried out, not discarded.
        async (token) => {
          const started = streamTurn({
            accessToken: token,
            request: neutral,
            ...this.baseUrl === undefined ? {} : { endpoints: { baseUrl: this.baseUrl } },
            ...request.signal === undefined ? {} : { signal: request.signal },
          })
          return { events: started, primed: await started.next() }
        },
      ))
    } catch (error) {
      if (isCodedError(error) && (error.status === 401 || error.status === 403)) this.forgetListing()
      throw isCodedError(error) ? error : credentialFailure(this.auth, error)
    }
    try {
      for (let step: IteratorResult<ResponsesEvent> = primed; !step.done; step = await events.next()) {
        for (const chunk of translator.push(step.value)) yield chunk
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
      if (isCodedError(error)) throw error
      const message = error instanceof Error ? error.message : String(error)
      // A stream cut short is retryable, and the harness retries exactly the codes
      // its policy names; anything else keeps the honest protocol-error code.
      throw isTransportFailure(message)
        ? coded(`the ChatGPT response was cut short: ${message}`, 'TRANSPORT')
        : coded(message, 'chatgpt_request_failed')
    }
  }
}
