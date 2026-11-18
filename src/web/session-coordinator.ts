import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { WebStore, WEB_RECORD_MAX_BYTES } from './store.ts'
import { WebToolProtocol, answerBlocks, type WebAnswer, type WebToolIdentity } from './protocol.ts'
import { canonical, digest, WEB_EFFORT, WEB_MODEL_ID, WEB_PROTOCOL, WebPolicyError } from './policy.ts'
import type { WebSettings } from './config.ts'
import type { WebConversation, WebFacts, WebTurnRequest, WebTurnResult } from './browser/types.ts'
import type { WebMediaAttachment } from './browser/types.ts'
import type { WebRecovery } from './transport.ts'
import type { WebBudgetPolicy } from './policy.ts'
import { prepareWebMedia, readWebMediaArtifact, webImageRef, WEB_IMAGE_POLICY } from './media.ts'

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
  recover(requestId: string, options?: { observe?: boolean; deadlineMs?: number; preparedRepair?: { parentRequestId: string; parentDigest: string } }): Promise<WebRecovery>
  releaseForRepair?(requestId: string, input: { nextRequestId: string; responseDigest: string }): Promise<void>
  retire?(requestId: string, input: { responseDigest: string; reason: 'user-discarded-invalid-response' }): Promise<{ at: number; responseDigest: string; reason: 'user-discarded-invalid-response' }>
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
  forceBootstrap?: boolean
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
  repairChain?: WebRepairAttempt[]
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
  repairs?: WebRepairAttempt[]
  retired?: WebRetirement
  trafficBytes?: number
  priorHistoryBytes?: number
  repairLimit?: number
  media?: WebMediaAttachment[]
  mediaDirectory?: string
}

export interface WebRepairAttempt {
  requestId: string
  parentRequestId: string
  parentDigest: string
  phase: 'prepared' | 'dispatch-intent' | 'not-dispatched'
  promptBytes: number
}

export interface WebRetirement {
  at: number
  responseDigest: string
  transportRequestId: string
  reason: 'user-discarded-invalid-response'
}

interface RejectedResponse { version: 1; requestId: string; transportRequestId: string; responseDigest: string; reason: string }

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
export function projectMessages(options: GenerateOptions, media: readonly WebMediaAttachment[] = [], fromMessage = 0): readonly Record<string, unknown>[] {
  return projectMessageRange(options, media, fromMessage, false)
}

function projectMessageRange(options: GenerateOptions, media: readonly WebMediaAttachment[], fromMessage: number, identityOnly: boolean): readonly Record<string, unknown>[] {
  return options.messages.slice(fromMessage).map((message, relativeIndex) => {
    const messageIndex = fromMessage + relativeIndex
    return {
      role: message.role,
      content: message.content.map((block, blockIndex) => {
        if (block.type === 'file') throw new WebPolicyError('Web media does not support ordinary file attachments; use an authorized local reading tool')
        if (block.type === 'image') {
          const ref = webImageRef(block.attachment)
          if ((block as unknown as { offloaded?: boolean }).offloaded === true) return { type: 'text', text: `[Image ${JSON.stringify(ref.attachmentId)} was offloaded by the host; its bytes are not included in this request.]` }
          // Compare durable host identities before selecting a bootstrap or
          // suffix. Already accepted prefix images need no new read or upload.
          if (identityOnly) return { type: 'image', attachment: ref }
          const item = media.find(candidate => candidate.messageIndex === messageIndex && candidate.blockIndex === blockIndex)
          if (!item || item.attachmentId !== ref.attachmentId) throw new WebPolicyError('Web image media has not been resolved to a verified artifact')
          return { type: 'image', uploadName: item.uploadName, attachmentId: item.attachmentId, mediaType: item.mediaType, bytes: item.artifact.bytes, sha256: item.artifact.sha256, width: item.width, height: item.height, messageIndex, blockIndex }
        }
        if (block.type === 'tool-call') return { type: block.type, id: String(block.id), name: block.name, arguments: canonical(JSON.parse(block.arguments)) }
        if (block.type === 'text' || block.type === 'reasoning') return { type: block.type, text: block.text }
        return structuredClone(block)
      }),
      ...(message.toolCallId === undefined ? {} : { toolCallId: String(message.toolCallId) }),
      ...(message.isError === undefined ? {} : { isError: message.isError }),
    }
  })
}

export class WebSessionCoordinator {
  private readonly store: WebStore
  private readonly transport: WebTransportPort
  private readonly report: (context: WebCallContext, requestId: string, facts: WebFacts, complete?: boolean) => Promise<void>
  private readonly activity: (context: WebCallContext, value: unknown) => void
  private readonly resolveAttachments: (() => unknown) | undefined
  constructor(
    stateDir: string,
    transport: WebTransportPort,
    report: (context: WebCallContext, requestId: string, facts: WebFacts, complete?: boolean) => Promise<void>,
    activity: (context: WebCallContext, value: unknown) => void,
    environment: { resolveAttachments?: () => unknown } = {},
  ) {
    this.store = new WebStore(join(resolve(stateDir), 'sessions'))
    this.transport = transport
    this.report = report
    this.activity = activity
    this.resolveAttachments = environment.resolveAttachments
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
    const historicalTools = context.kind !== 'main' && (options.tools?.length ?? 0) > 0 ? { role: 'developer', content: [{ type: 'text', text: `Historical tool definitions for understanding the transcript only; no tools are available in this auxiliary call: ${canonical(options.tools)}` }] } : undefined
    const identities = [...projectMessageRange(options, [], 0, true)]
    if (historicalTools) identities.unshift(historicalTools)
    const prefix = identities.map(digest)
    const bindingDigest = digest({
      provider: options.provider, model: WEB_MODEL_ID, effort: WEB_EFFORT, transport: 'chatgpt-web',
      connection, contextPolicy: settings.contextPolicy, budget: settings.budget,
      tools, system: options.system ?? null, executionDomainId: context.executionDomainId, imagePolicy: { version: WEB_IMAGE_POLICY.version, limits: settings.imagePolicy },
    })
    const key = context.kind === 'main' ? `${context.executionDomainId}:${context.sessionId}:main` : `${context.sessionId}:${context.kind}:${randomUUID()}`
    return await this.store.locked('conversation', key, async () => {
      let state = await this.store.read<ConversationState>('conversation', key)
      if (state?.pending) throw new WebPolicyError('previous Web response needs durable host acknowledgement; recover it before sending again')
      let bootstrap = state === undefined
      const compatible = state?.bindingDigest === bindingDigest && state.prefix.length <= prefix.length && state.prefix.every((value, index) => value === prefix[index])
      if (state && (state.forceBootstrap || !compatible || state.turns >= settings.budget.maxTurns || state.cumulativeBytes + settings.budget.maxInputBytes + settings.budget.outputReserveBytes > settings.budget.maxHistoryBytes)) bootstrap = true
      const generation = state === undefined ? 1 : bootstrap ? state.generation + 1 : state.generation
      if (generation > settings.budget.maxGenerations) throw new WebPolicyError('Web generation budget exhausted')
      const requestId = randomUUID()
      const toolIdentities = retainToolIdentities(options, state?.toolIdentities ?? [])
      const fromMessage = bootstrap ? 0 : state?.prefix.length ?? 0
      const media = await prepareWebMedia(options, join(connection.stateDir, 'images'), this.resolveAttachments, context.deadlineMs, settings.imagePolicy, fromMessage)
      const delta = [...projectMessages(options, media, fromMessage)]
      if (historicalTools) delta.unshift(historicalTools)
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
        priorHistoryBytes: state.cumulativeBytes,
        repairLimit: Math.min(settings.budget.maxFormatRepairs, Math.max(0, settings.budget.maxTurns - state.turns - 1)),
        ...(media.length ? { media, mediaDirectory: join(connection.stateDir, 'images') } : {}),
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
          ...(media.length ? { media } : {}),
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
      const parsed = await this.parseOrRepair(pending, context, protocol, result)
      result = parsed.result
      const answer = parsed.answer
      const blocks = answerBlocks(answer)
      const reference: WebReplayReference = {
        protocol: WEB_PROTOCOL, requestId, responseId: result.responseId, responseDigest: result.artifact.sha256,
        contentDigest: digest(blocks), sessionId: context.sessionId, executionDomainId: context.executionDomainId,
        hostInvocationId: context.hostInvocationId, kind: context.kind, generation,
        conversationUrl: result.conversation.url, usage: 'unknown',
      }
      const { text: _text, ...transportResult } = result
      const delivery: WebDelivery = { version: 1, reference, conversationKey: key, blocks, transportResult, ...(pending.repairs?.length ? { repairChain: pending.repairs } : {}) }
      if (context.recovery) {
        const { signal: _signal, ...request } = options
        delivery.recovery = { request: structuredClone(request), ...context.recovery }
      }
      await this.store.write('delivery', requestId, delivery)
      state.conversation = result.conversation
      state.prefix = [...prefix, digest({ role: 'assistant', content: blocks })]
      state.cumulativeBytes += pending.trafficBytes ?? Buffer.byteLength(prompt) + result.artifact.bytes
      state.turns += 1 + (pending.repairs?.filter(attempt => attempt.phase === 'dispatch-intent').length ?? 0)
      state.lastCapturedRequestId = requestId
      state.toolIdentities = appendToolIdentities(toolIdentities, answer)
      if (pending.repairs?.length) state.forceBootstrap = true
      await this.store.write('conversation', key, state)
      return delivery
    })
  }

  private async reject(pending: PendingRequest, result: WebTurnResult, error: unknown): Promise<void> {
    await this.store.write('rejected', pending.requestId, {
      version: 1, requestId: pending.requestId, transportRequestId: result.requestId,
      responseDigest: result.artifact.sha256, reason: error instanceof Error ? error.message : 'invalid response',
    } satisfies RejectedResponse)
  }

  private async parseOrRepair(pending: PendingRequest, context: WebCallContext, protocol: WebToolProtocol, initial: WebTurnResult): Promise<{ result: WebTurnResult; answer: WebAnswer }> {
    let result = initial
    pending.trafficBytes = pending.promptBytes + initial.artifact.bytes
    for (;;) {
      let rejected: unknown
      try {
        const answer = protocol.parse(result.text, pending.requestId, pending.generation, pending.budget)
        if (result.requestId !== pending.requestId) protocol.assertFaithfulRepair(answer, initial.text, pending.requestId, pending.generation, pending.budget)
        return { result, answer }
      } catch (error) { rejected = error; await this.reject(pending, result, error) }
      if (!protocol.repairable(rejected, initial.text) || (pending.repairs?.length ?? 0) >= (pending.repairLimit ?? pending.budget.maxFormatRepairs) || !this.transport.releaseForRepair || result.facts.outcome !== 'captured' || result.facts.remoteGeneration !== 'completed' || result.facts.localCleanup !== 'confirmed') throw rejected
      this.assertActive(context)
      const requestId = randomUUID()
      const prompt = protocol.repairPrompt(pending.requestId, pending.generation, requestId, { text: initial.text, sha256: initial.artifact.sha256 })
      const bytes = Buffer.byteLength(prompt)
      if (bytes + pending.budget.outputReserveBytes > pending.budget.maxInputBytes || (pending.priorHistoryBytes ?? 0) + pending.trafficBytes + bytes + pending.budget.outputReserveBytes > pending.budget.maxHistoryBytes) throw new WebPolicyError('format repair exceeds the original cumulative byte budget; inspect or discard the captured rejection')
      const attempt: WebRepairAttempt = { requestId, parentRequestId: result.requestId, parentDigest: result.artifact.sha256, phase: 'prepared', promptBytes: bytes }
      pending.repairs ??= []
      pending.repairs.push(attempt)
      await this.store.write('request', pending.requestId, pending)
      // The durable chain exists before releasing the predecessor. Neither
      // operation acknowledges delivery or permits any local tool execution.
      await this.transport.releaseForRepair(result.requestId, { nextRequestId: requestId, responseDigest: result.artifact.sha256 })
      this.assertActive(context)
      attempt.phase = 'dispatch-intent'
      await this.store.write('request', pending.requestId, pending)
      await this.report(context, pending.requestId, { dispatch: 'unknown', outcome: 'unknown', localCleanup: 'unknown', remoteGeneration: 'unknown', usage: 'unknown', replayAllowed: false })
      try {
        result = await this.transport.run({
          requestId, executionDomainId: context.executionDomainId, sessionId: context.sessionId,
          generation: pending.generation, bindingDigest: pending.bindingDigest, prompt,
          title: `${readableTitle(context.rawOptions, context.kind, pending.generation)} · format ${pending.repairs.length}`,
          deadlineMs: context.deadlineMs, contextPolicy: initial.evidence.contextPolicy, conversation: initial.conversation,
          maxPromptBytes: pending.budget.maxInputBytes - pending.budget.outputReserveBytes,
          maxResponseBytes: Math.min(pending.budget.maxResponseBytes, pending.budget.maxHistoryBytes - (pending.priorHistoryBytes ?? 0) - pending.trafficBytes - bytes),
          repairOf: { requestId: attempt.parentRequestId, responseDigest: attempt.parentDigest },
          ...(context.rawOptions.signal ? { signal: context.rawOptions.signal } : {}),
          onActivity: value => this.activity(context, { ...value, logicalRequestId: pending.requestId, purpose: 'format-repair' }),
        })
        pending.trafficBytes += bytes + result.artifact.bytes
        await this.store.write('request', pending.requestId, pending)
        await this.report(context, pending.requestId, result.facts)
      } catch (error) {
        const facts = (error as { facts?: WebFacts }).facts
        // A failed correction never turns the already dispatched root into a
        // replayable task. Keep the original domain fenced until reconciliation.
        if (facts) await this.report(context, pending.requestId, { ...facts, dispatch: facts.dispatch === 'unknown' ? 'unknown' : 'confirmed', replayAllowed: false })
        throw error
      }
    }
  }

  /** Called after the host stream has ended and its own transaction has flushed. */
  async acknowledge(reference: WebReplayReference, blocks: readonly unknown[], hostCommitId: string): Promise<void> {
    const delivery = await this.store.read<WebDelivery>('delivery', reference.requestId)
    if (!delivery || canonical(delivery.reference) !== canonical(reference) || digest(blocks) !== reference.contentDigest) throw new WebPolicyError('durable host commit does not match the captured Web response')
    if (delivery.committed && delivery.committed.hostCommitId !== hostCommitId) throw new WebPolicyError('Web response already belongs to another host commit')
    await this.store.locked('conversation', delivery.conversationKey, async () => {
      const pending = await this.store.read<PendingRequest>('request', reference.requestId)
      if (pending?.retired) throw new WebPolicyError('a discarded response cannot be acknowledged or adopted')
      await this.transport.acknowledge(delivery.transportResult.requestId, { hostCommitId, responseDigest: reference.responseDigest })
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
  private async recoveryTail(pending: PendingRequest): Promise<{ recovered: WebRecovery; original?: WebTurnResult }> {
    let recovered = await this.transport.recover(pending.requestId, { observe: true, deadlineMs: Date.now() + 30_000 })
    const original = recovered.result
    for (const attempt of pending.repairs ?? []) {
      if (attempt.parentRequestId !== recovered.requestId || attempt.parentDigest !== recovered.result?.artifact.sha256) throw new WebPolicyError('format repair chain no longer matches its immutable parent artifact')
      if (attempt.phase !== 'dispatch-intent') {
        attempt.phase = 'not-dispatched'
        await this.store.write('request', pending.requestId, pending)
        break
      }
      const next = await this.transport.recover(attempt.requestId, { observe: true, deadlineMs: Date.now() + 30_000, preparedRepair: attempt })
      if (next.facts.dispatch === 'not-dispatched' && next.facts.localCleanup === 'confirmed' && next.facts.replayAllowed) {
        attempt.phase = 'not-dispatched'
        await this.store.write('request', pending.requestId, pending)
        break
      }
      recovered = next
    }
    return { recovered, ...(original ? { original } : {}) }
  }

  private async retainRetirement(pending: PendingRequest, retired: WebRetirement): Promise<void> {
    pending.retired = retired
    await this.store.write('request', pending.requestId, pending)
    const state = await this.store.read<ConversationState>('conversation', pending.conversationKey)
    if (state?.pending === pending.requestId) {
      delete state.pending
      state.forceBootstrap = true
      await this.store.write('conversation', pending.conversationKey, state)
    }
  }

  async recover(requestId: string): Promise<WebRecovery> {
    const prepared = await this.store.read<PendingRequest>('request', requestId)
    if (!prepared || prepared.requestId !== requestId || prepared.version !== 1) throw new WebPolicyError('recovery request has no matching preparation record')
    return await this.store.locked('conversation', prepared.conversationKey, async () => {
      const pending = (await this.store.read<PendingRequest>('request', requestId))!
      // Verify original root images before following any text-only repair child.
      // Recovery never resolves attachments, uploads, or sends again.
      if (pending.media?.length && !pending.mediaDirectory) throw new WebPolicyError('recovery media has no original private artifact directory')
      for (const item of pending.media ?? []) await readWebMediaArtifact(item, pending.mediaDirectory!)
      const context = { ...pending.context, rawOptions: pending.request, active: false }
      if (pending.phase === 'prepared' || pending.phase === 'not-dispatched') {
        pending.phase = 'not-dispatched'
        await this.store.write('request', requestId, pending)
        const state = await this.store.read<ConversationState>('conversation', pending.conversationKey)
        if (state?.pending === requestId) { delete state.pending; await this.store.write('conversation', pending.conversationKey, state) }
        const facts: WebFacts = { dispatch: 'not-dispatched', outcome: 'unknown', localCleanup: 'confirmed', remoteGeneration: 'not-started', usage: 'unknown', replayAllowed: true }
        await this.report(context, requestId, facts)
        return { requestId, facts }
      }
      const { recovered, original } = await this.recoveryTail(pending)
      const result = recovered.result
      if (pending.retired || recovered.disposition?.kind === 'retired') {
        const disposition = recovered.disposition as Extract<NonNullable<WebRecovery['disposition']>, { kind: 'retired' }>
        const retired = pending.retired ?? { at: disposition.at, responseDigest: disposition.responseDigest, reason: disposition.reason, transportRequestId: recovered.requestId }
        await this.retainRetirement(pending, retired)
        await this.report(context, requestId, recovered.facts)
        return { ...recovered, requestId, retired }
      }
      if (!result) {
        const facts = pending.repairs?.length ? { ...recovered.facts, dispatch: recovered.facts.dispatch === 'unknown' ? 'unknown' as const : 'confirmed' as const, replayAllowed: false } : recovered.facts
        if (!pending.repairs?.length && facts.dispatch === 'not-dispatched' && facts.localCleanup === 'confirmed' && facts.replayAllowed) {
          const state = await this.store.read<ConversationState>('conversation', pending.conversationKey)
          if (state?.pending === requestId) { delete state.pending; await this.store.write('conversation', pending.conversationKey, state) }
        }
        await this.report(context, requestId, facts)
        return { ...recovered, requestId, facts }
      }
      if (result.evidence.bindingDigest !== pending.bindingDigest) throw new WebPolicyError('recovery result belongs to another prepared binding')
      const protocol = new WebToolProtocol(pending.context.kind === 'main' ? pending.request.tools ?? [] : [])
      let answer: WebAnswer
      try {
        answer = protocol.parse(result.text, requestId, pending.generation, pending.budget)
        if (result.requestId !== requestId) {
          if (!original) throw new WebPolicyError('format repair has lost its original captured response')
          protocol.assertFaithfulRepair(answer, original.text, requestId, pending.generation, pending.budget)
        }
      } catch (error) {
        await this.reject(pending, result, error)
        await this.report(context, requestId, result.facts)
        return { ...recovered, requestId, rejection: { reason: error instanceof Error ? error.message : 'invalid response', responseDigest: result.artifact.sha256, transportRequestId: result.requestId } }
      }
      const blocks = answerBlocks(answer)
      const reference: WebReplayReference = {
        protocol: WEB_PROTOCOL, requestId, responseId: result.responseId, responseDigest: result.artifact.sha256,
        contentDigest: digest(blocks), sessionId: pending.context.sessionId, executionDomainId: pending.context.executionDomainId,
        hostInvocationId: pending.context.hostInvocationId, kind: pending.context.kind, generation: pending.generation,
        conversationUrl: result.conversation.url, usage: 'unknown',
      }
      const existing = await this.delivery(requestId)
      if (existing) {
        if (canonical(existing.reference) !== canonical(reference) || digest(existing.blocks) !== reference.contentDigest) throw new WebPolicyError('captured and delivered recovery evidence differ')
        if (existing.committed) return { ...recovered, requestId }
      }
      const state = await this.store.read<ConversationState>('conversation', pending.conversationKey)
      if (!state || state.pending !== requestId || state.bindingDigest !== pending.bindingDigest) throw new WebPolicyError('conversation no longer owns this uncommitted result')
      const { text: _text, ...transportResult } = result
      const delivery: WebDelivery = {
        version: 1, reference, conversationKey: pending.conversationKey, blocks, transportResult,
        ...(pending.repairs?.length ? { repairChain: pending.repairs } : {}),
        ...(pending.recovery === undefined ? {} : { recovery: { request: pending.request, ...pending.recovery } }),
      }
      if (!existing) await this.store.write('delivery', requestId, delivery)
      state.conversation = result.conversation
      state.prefix = [...pending.prefix, digest({ role: 'assistant', content: blocks })]
      state.toolIdentities = appendToolIdentities(pending.toolIdentities, answer)
      if (pending.repairs?.length) state.forceBootstrap = true
      if (state.lastCapturedRequestId !== requestId) {
        state.cumulativeBytes += pending.trafficBytes ?? pending.promptBytes + result.artifact.bytes
        state.turns += 1 + (pending.repairs?.filter(attempt => attempt.phase === 'dispatch-intent').length ?? 0)
        state.lastCapturedRequestId = requestId
      }
      await this.store.write('conversation', pending.conversationKey, state)
      await this.report(context, requestId, result.facts)
      return { ...recovered, requestId }
    })
  }

  /** Only the explicit host/UI discard route calls this. No valid delivery is discarded. */
  async retire(requestId: string, expectedDigest: string): Promise<WebRetirement> {
    const observed = await this.recover(requestId)
    if (observed.retired) {
      if (observed.retired.responseDigest !== expectedDigest) throw new WebPolicyError('discard confirmation does not match the retired result')
      return observed.retired
    }
    if (!this.transport.retire || !observed.rejection || !observed.result || observed.rejection.responseDigest !== expectedDigest) throw new WebPolicyError('only an inspected, complete rejected response can be discarded')
    const prepared = (await this.store.read<PendingRequest>('request', requestId))!
    return await this.store.locked('conversation', prepared.conversationKey, async () => {
      const pending = (await this.store.read<PendingRequest>('request', requestId))!
      if (await this.delivery(requestId)) throw new WebPolicyError('a delivered response may already have executed tools and cannot be discarded')
      const { recovered } = await this.recoveryTail(pending)
      if (!recovered.result || recovered.result.artifact.sha256 !== expectedDigest || recovered.requestId !== observed.result!.requestId) throw new WebPolicyError('rejected response changed after inspection')
      const receipt = await this.transport.retire!(recovered.requestId, { responseDigest: expectedDigest, reason: 'user-discarded-invalid-response' })
      const retired: WebRetirement = { ...receipt, transportRequestId: recovered.requestId }
      await this.retainRetirement(pending, retired)
      return retired
    })
  }

}

function readableTitle(options: GenerateOptions, kind: WebCallContext['kind'], generation: number): string {
  const user = options.messages.find(message => message.role === 'user')
  const text = user?.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join(' ') ?? 'DSH task'
  const readable = text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64) || 'DSH task'
  return `${readable} · ${kind === 'main' ? 'DSH' : kind} · ${generation}`
}
