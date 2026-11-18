import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { WebStore, WEB_RECORD_MAX_BYTES } from './store.ts'
import { WebToolProtocol, answerBlocks, type WebAnswer, type WebToolIdentity } from './protocol.ts'
import { canonical, digest, WEB_EFFORT, WEB_MODEL_ID, WEB_PROTOCOL, WebPolicyError } from './policy.ts'
import type { WebSettings } from './config.ts'
import type { WebConversation, WebFacts, WebTurnRequest, WebTurnResult } from './browser/types.ts'
import type { WebRecovery } from './transport.ts'
import type { WebBudgetPolicy } from './policy.ts'

export interface WebCallContext {
  kind: 'main' | 'compaction' | 'session-title' | 'one-shot'
  sessionId: string
  executionDomainId: string
  hostInvocationId: string
  deadlineMs: number
  requireIsolation: boolean
  active: boolean
  rawOptions: GenerateOptions
  recovery?: { requestHeaderSeq?: number; surfaceSeqs: number[]; originalCompactionId?: string; sourceEventSeqs?: number[] }
}

export interface WebTransportPort {
  run(request: WebTurnRequest): Promise<WebTurnResult>
  acknowledge(requestId: string, receipt: { hostCommitId: string; responseDigest: string }): Promise<void>
  recover(requestId: string, options?: { observe?: boolean; deadlineMs?: number }): Promise<WebRecovery>
}

interface ConversationState {
  version: 1
  sessionId: string
  bindingDigest: string
  generation: number
  conversation?: WebConversation
  prefix: string[]
  cumulativeBytes: number
  turns: number
  lastCapturedRequestId?: string
  toolIdentities?: WebToolIdentity[]
  pending?: string
}

export interface WebReplayReference {
  protocol: typeof WEB_PROTOCOL
  requestId: string
  responseId: string
  responseDigest: string
  contentDigest: string
  sessionId: string
  executionDomainId: string
  hostInvocationId: string
  kind: WebCallContext['kind']
  generation: number
  conversationUrl: string
  usage: 'unknown'
}

export interface WebDelivery {
  version: 1
  reference: WebReplayReference
  conversationKey: string
  blocks: readonly Record<string, unknown>[]
  transportResult: Omit<WebTurnResult, 'text'>
  committed?: { hostCommitId: string }
  recovery?: { request: Omit<GenerateOptions, 'signal'>; requestHeaderSeq?: number; surfaceSeqs: number[]; originalCompactionId?: string; sourceEventSeqs?: number[] }
}

interface PendingRequest {
  version: 1
  phase: 'prepared' | 'dispatch-intent' | 'not-dispatched'
  requestId: string
  conversationKey: string
  bindingDigest: string
  generation: number
  context: Omit<WebCallContext, 'rawOptions' | 'active' | 'recovery'>
  request: Omit<GenerateOptions, 'signal'>
  recovery?: WebCallContext['recovery']
  prefix: string[]
  promptBytes: number
  budget: WebBudgetPolicy
  toolIdentities: WebToolIdentity[]
}

function retainToolIdentities(options: GenerateOptions, previous: readonly WebToolIdentity[]): WebToolIdentity[] {
  const known = new Map(previous.map(identity => [identity.hostCallId, identity]))
  const referenced = new Set<string>()
  for (const message of options.messages) {
    if (message.toolCallId) referenced.add(String(message.toolCallId))
    const reference = (message as unknown as { source?: { replayState?: { response?: Partial<WebReplayReference> } } }).source?.replayState?.response
    for (const block of message.content) {
      if (block.type !== 'tool-call') continue
      const id = String(block.id); referenced.add(id)
      if (reference?.protocol === WEB_PROTOCOL && typeof reference.requestId === 'string' && id.startsWith(`${reference.requestId}_`)) {
        known.set(id, { hostCallId: id, requestId: reference.requestId, providerCallId: id.slice(reference.requestId.length + 1) })
      }
    }
  }
  return [...known.values()].filter(identity => referenced.has(identity.hostCallId))
}

function appendToolIdentities(previous: readonly WebToolIdentity[], answer: WebAnswer): WebToolIdentity[] {
  return answer.kind === 'final' ? [...previous] : [...previous, ...answer.calls.map(call => ({ hostCallId: `${answer.requestId}_${call.id}`, requestId: answer.requestId, providerCallId: call.id }))]
}

/** Ignore host-generated IDs and replay metadata, but preserve the complete model-visible content. */
export function projectMessages(options: GenerateOptions): readonly Record<string, unknown>[] {
  return options.messages.map(message => ({
    role: message.role,
    content: message.content.map(block => {
      if (block.type === 'image' || block.type === 'file') throw new WebPolicyError('Web media has not passed acceptance; use a local read tool for files')
      if (block.type === 'tool-call') return { type: block.type, id: String(block.id), name: block.name, arguments: canonical(JSON.parse(block.arguments)) }
      if (block.type === 'text' || block.type === 'reasoning') return { type: block.type, text: block.text }
      return structuredClone(block)
    }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: String(message.toolCallId) }),
    ...(message.isError === undefined ? {} : { isError: message.isError }),
  }))
}

export class WebSessionCoordinator {
  private readonly store: WebStore
  private readonly transport: WebTransportPort
  private readonly report: (context: WebCallContext, requestId: string, facts: WebFacts, complete?: boolean) => Promise<void>
  private readonly activity: (context: WebCallContext, value: unknown) => void
  constructor(
    stateDir: string,
    transport: WebTransportPort,
    report: (context: WebCallContext, requestId: string, facts: WebFacts, complete?: boolean) => Promise<void>,
    activity: (context: WebCallContext, value: unknown) => void,
  ) {
    this.store = new WebStore(join(resolve(stateDir), 'sessions'))
    this.transport = transport
    this.report = report
    this.activity = activity
  }

  private assertActive(context: WebCallContext): void {
    if (!context.active || context.rawOptions.signal?.aborted) throw new WebPolicyError('call was cancelled before dispatch', 'TIMEOUT')
    if (Date.now() >= context.deadlineMs) throw new WebPolicyError('call deadline expired before dispatch', 'TIMEOUT')
  }

  async run(context: WebCallContext, settings: WebSettings): Promise<WebDelivery> {
    this.assertActive(context)
    const options = context.rawOptions
    if (options.model !== WEB_MODEL_ID || options.reasoningEffort !== WEB_EFFORT) throw new WebPolicyError('Web model requires the exact Pro effort')
    if (context.requireIsolation && settings.contextPolicy !== 'project-only') throw new WebPolicyError('this host operation requires project-only isolation')
    const connection = settings.connections[settings.activeConnection]
    if (!connection?.accountFingerprint) throw new WebPolicyError('connect and verify the dedicated browser account first', 'AUTH')
    const tools = context.kind === 'main' ? options.tools ?? [] : []
    const protocol = new WebToolProtocol(tools)
    const messages = [...projectMessages(options)]
    if (context.kind !== 'main' && (options.tools?.length ?? 0) > 0) messages.unshift({ role: 'developer', content: [{ type: 'text', text: `Historical tool definitions for understanding the transcript only; no tools are available in this auxiliary call: ${canonical(options.tools)}` }] })
    const prefix = messages.map(digest)
    const bindingDigest = digest({
      provider: options.provider, model: WEB_MODEL_ID, effort: WEB_EFFORT, transport: 'chatgpt-web',
      connection, contextPolicy: settings.contextPolicy, budget: settings.budget,
      tools, system: options.system ?? null, executionDomainId: context.executionDomainId,
    })
    const key = context.kind === 'main' ? `${context.executionDomainId}:${context.sessionId}:main` : `${context.sessionId}:${context.kind}:${randomUUID()}`
    return await this.store.locked('conversation', key, async () => {
      let state = await this.store.read<ConversationState>('conversation', key)
      if (state?.pending) throw new WebPolicyError('previous Web response needs durable host acknowledgement; recover it before sending again')
      let bootstrap = state === undefined
      const compatible = state?.bindingDigest === bindingDigest && state.prefix.length <= prefix.length && state.prefix.every((value, index) => value === prefix[index])
      if (state && (!compatible || state.turns >= settings.budget.maxTurns || state.cumulativeBytes + settings.budget.maxInputBytes + settings.budget.outputReserveBytes > settings.budget.maxHistoryBytes)) bootstrap = true
      const generation = state === undefined ? 1 : bootstrap ? state.generation + 1 : state.generation
      if (generation > settings.budget.maxGenerations) throw new WebPolicyError('Web generation budget exhausted')
      const requestId = randomUUID()
      const toolIdentities = retainToolIdentities(options, state?.toolIdentities ?? [])
      const delta = bootstrap ? messages : messages.slice(state?.prefix.length ?? 0)
      if (!bootstrap && delta.length === 0) throw new WebPolicyError('duplicate model input has no new authoritative messages')
      const prompt = protocol.prompt(requestId, generation, delta, bootstrap, options.system, toolIdentities)
      if (Buffer.byteLength(prompt) + settings.budget.outputReserveBytes > settings.budget.maxInputBytes) {
        throw new WebPolicyError('authoritative context exceeds the local Web input budget; compact through DSH before dispatch', 'CONTEXT_WINDOW_EXCEEDED')
      }
      this.assertActive(context)
      state = bootstrap || state === undefined ? {
        version: 1, sessionId: context.sessionId, bindingDigest, generation, prefix: [], cumulativeBytes: 0, turns: 0,
      } : state
      const { signal: _signal, ...request } = options
      const pending: PendingRequest = {
        version: 1, phase: 'prepared', requestId, conversationKey: key, bindingDigest, generation,
        context: { kind: context.kind, sessionId: context.sessionId, executionDomainId: context.executionDomainId, hostInvocationId: context.hostInvocationId, deadlineMs: context.deadlineMs, requireIsolation: context.requireIsolation },
        request: structuredClone(request), prefix, promptBytes: Buffer.byteLength(prompt), budget: settings.budget, toolIdentities,
        ...(context.recovery === undefined ? {} : { recovery: context.recovery }),
      }
      const retainedBytes = Buffer.byteLength(JSON.stringify(pending))
      // Tool arguments become a JSON string in the host block. Budget their
      // worst numeric/string expansion plus original recovery input before send.
      if (retainedBytes > settings.budget.maxHistoryBytes || retainedBytes + 6 * settings.budget.maxResponseBytes + 128 * 1024 > WEB_RECORD_MAX_BYTES) throw new WebPolicyError('the original request and bounded response exceed the recoverable journal budget; compact or lower the response limit before dispatch', 'CONTEXT_WINDOW_EXCEEDED')
      // Publish complete recovery input before the host index, then reserve the
      // conversation. A crash cannot leave an undiscoverable pending turn.
      await this.store.write('request', requestId, pending)
      await this.report(context, requestId, { dispatch: 'unknown', outcome: 'unknown', localCleanup: 'unknown', remoteGeneration: 'unknown', usage: 'unknown', replayAllowed: false })
      state.pending = requestId
      await this.store.write('conversation', key, state)
      this.assertActive(context)
      // This durable transition precedes entering the transport. Only a still
      // prepared record positively proves that no browser operation was called.
      pending.phase = 'dispatch-intent'
      await this.store.write('request', requestId, pending)
      let result: WebTurnResult
      try {
        result = await this.transport.run({
          requestId, executionDomainId: context.executionDomainId, sessionId: context.sessionId,
          generation, prompt, bindingDigest,
          title: readableTitle(options, context.kind, generation), deadlineMs: context.deadlineMs,
          contextPolicy: settings.contextPolicy,
          maxPromptBytes: settings.budget.maxInputBytes - settings.budget.outputReserveBytes,
          maxResponseBytes: settings.budget.maxResponseBytes,
          ...(state.conversation === undefined ? {} : { conversation: state.conversation }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          onActivity: activity => { this.activity(context, activity) },
        })
        await this.report(context, requestId, result.facts)
      } catch (error) {
        const facts = (error as { facts?: WebFacts }).facts
        if (facts) {
          await this.report(context, requestId, facts)
          if (facts.dispatch === 'not-dispatched' && facts.localCleanup === 'confirmed' && facts.replayAllowed) {
            delete state.pending
            await this.store.write('conversation', key, state)
          }
        }
        throw error
      }
      let answer: WebAnswer
      try { answer = protocol.parse(result.text, requestId, generation, settings.budget) }
      catch (error) {
        await this.store.write('rejected', requestId, { version: 1, requestId, responseDigest: result.artifact.sha256, reason: error instanceof Error ? error.message : 'invalid response' })
        throw error
      }
      const blocks = answerBlocks(answer)
      const reference: WebReplayReference = {
        protocol: WEB_PROTOCOL, requestId, responseId: result.responseId, responseDigest: result.artifact.sha256,
        contentDigest: digest(blocks), sessionId: context.sessionId, executionDomainId: context.executionDomainId,
        hostInvocationId: context.hostInvocationId, kind: context.kind, generation,
        conversationUrl: result.conversation.url, usage: 'unknown',
      }
      const { text: _text, ...transportResult } = result
      const delivery: WebDelivery = { version: 1, reference, conversationKey: key, blocks, transportResult }
      if (context.recovery) {
        const { signal: _signal, ...request } = options
        delivery.recovery = { request: structuredClone(request), ...context.recovery }
      }
      await this.store.write('delivery', requestId, delivery)
      state.conversation = result.conversation
      state.prefix = [...prefix, digest({ role: 'assistant', content: blocks })]
      state.cumulativeBytes += Buffer.byteLength(prompt) + result.artifact.bytes
      state.turns++
      state.lastCapturedRequestId = requestId
      state.toolIdentities = appendToolIdentities(toolIdentities, answer)
      await this.store.write('conversation', key, state)
      return delivery
    })
  }

  /** Called after the host stream has ended and its own transaction has flushed. */
  async acknowledge(reference: WebReplayReference, blocks: readonly unknown[], hostCommitId: string): Promise<void> {
    const delivery = await this.store.read<WebDelivery>('delivery', reference.requestId)
    if (!delivery || canonical(delivery.reference) !== canonical(reference) || digest(blocks) !== reference.contentDigest) throw new WebPolicyError('durable host commit does not match the captured Web response')
    if (delivery.committed && delivery.committed.hostCommitId !== hostCommitId) throw new WebPolicyError('Web response already belongs to another host commit')
    await this.store.locked('conversation', delivery.conversationKey, async () => {
      await this.transport.acknowledge(reference.requestId, { hostCommitId, responseDigest: reference.responseDigest })
      delivery.committed = { hostCommitId }
      await this.store.write('delivery', reference.requestId, delivery)
      const state = await this.store.read<ConversationState>('conversation', delivery.conversationKey)
      if (state?.pending === reference.requestId) {
        delete state.pending
        await this.store.write('conversation', delivery.conversationKey, state)
      } else if (state?.pending) throw new WebPolicyError('conversation moved to a different uncommitted request')
    })
  }

  async delivery(requestId: string): Promise<WebDelivery | undefined> { return await this.store.read('delivery', requestId) }
  async recover(requestId: string): Promise<WebRecovery> {
    const pending = await this.store.read<PendingRequest>('request', requestId)
    if (!pending || pending.requestId !== requestId || pending.version !== 1) throw new WebPolicyError('recovery request has no matching preparation record')
    if (pending.phase === 'prepared' || pending.phase === 'not-dispatched') {
      return await this.store.locked('conversation', pending.conversationKey, async () => {
        const latest = await this.store.read<PendingRequest>('request', requestId)
        if (!latest || (latest.phase !== 'prepared' && latest.phase !== 'not-dispatched')) throw new WebPolicyError('preparation advanced while recovery waited')
        latest.phase = 'not-dispatched'
        await this.store.write('request', requestId, latest)
        const state = await this.store.read<ConversationState>('conversation', pending.conversationKey)
        if (state?.pending === requestId) { delete state.pending; await this.store.write('conversation', pending.conversationKey, state) }
        const facts: WebFacts = { dispatch: 'not-dispatched', outcome: 'unknown', localCleanup: 'confirmed', remoteGeneration: 'not-started', usage: 'unknown', replayAllowed: true }
        await this.report({ ...pending.context, rawOptions: pending.request, active: false }, requestId, facts)
        return { requestId, facts }
      })
    }
    const recovered = await this.transport.recover(requestId, { observe: true, deadlineMs: Date.now() + 30_000 })
    const result = recovered.result
    if (!result) {
      const facts = recovered.facts
      if (facts.dispatch === 'not-dispatched' && facts.localCleanup === 'confirmed' && facts.replayAllowed) {
        await this.store.locked('conversation', pending.conversationKey, async () => {
          const state = await this.store.read<ConversationState>('conversation', pending.conversationKey)
          if (state?.pending === requestId) { delete state.pending; await this.store.write('conversation', pending.conversationKey, state) }
        })
      }
      await this.report({ ...pending.context, rawOptions: pending.request, active: false }, requestId, facts)
      return recovered
    }
    if (result.requestId !== requestId || result.evidence.bindingDigest !== pending.bindingDigest) throw new WebPolicyError('recovery result belongs to another prepared binding')
    const protocol = new WebToolProtocol(pending.context.kind === 'main' ? pending.request.tools ?? [] : [])
    const answer = protocol.parse(result.text, requestId, pending.generation, pending.budget)
    const blocks = answerBlocks(answer)
    const reference: WebReplayReference = {
      protocol: WEB_PROTOCOL, requestId, responseId: result.responseId, responseDigest: result.artifact.sha256,
      contentDigest: digest(blocks), sessionId: pending.context.sessionId, executionDomainId: pending.context.executionDomainId,
      hostInvocationId: pending.context.hostInvocationId, kind: pending.context.kind, generation: pending.generation,
      conversationUrl: result.conversation.url, usage: 'unknown',
    }
    await this.store.locked('conversation', pending.conversationKey, async () => {
      const existing = await this.delivery(requestId)
      if (existing) {
        if (canonical(existing.reference) !== canonical(reference) || digest(existing.blocks) !== reference.contentDigest) throw new WebPolicyError('captured and delivered recovery evidence differ')
        if (existing.committed) return
      }
      const state = await this.store.read<ConversationState>('conversation', pending.conversationKey)
      if (!state || state.pending !== requestId || state.bindingDigest !== pending.bindingDigest) throw new WebPolicyError('conversation no longer owns this uncommitted result')
      const { text: _text, ...transportResult } = result
      const delivery: WebDelivery = {
        version: 1, reference, conversationKey: pending.conversationKey, blocks, transportResult,
        ...(pending.recovery === undefined ? {} : { recovery: { request: pending.request, ...pending.recovery } }),
      }
      if (!existing) await this.store.write('delivery', requestId, delivery)
      state.conversation = result.conversation
      state.prefix = [...pending.prefix, digest({ role: 'assistant', content: blocks })]
      state.toolIdentities = appendToolIdentities(pending.toolIdentities, answer)
      if (state.lastCapturedRequestId !== requestId) {
        state.cumulativeBytes += pending.promptBytes + result.artifact.bytes
        state.turns++
        state.lastCapturedRequestId = requestId
      }
      await this.store.write('conversation', pending.conversationKey, state)
    })
    await this.report({ ...pending.context, rawOptions: pending.request, active: false }, requestId, result.facts)
    return recovered
  }
}

function readableTitle(options: GenerateOptions, kind: WebCallContext['kind'], generation: number): string {
  const user = options.messages.find(message => message.role === 'user')
  const text = user?.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join(' ') ?? 'DSH task'
  const readable = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64) || 'DSH task'
  return `${readable} · ${kind === 'main' ? 'DSH' : kind} · ${generation}`
}
