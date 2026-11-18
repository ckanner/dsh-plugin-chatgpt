import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import * as DshLlm from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ChatGptWebHost, replayReference } from './host.ts'
import { deliveryChunks } from './chunks.ts'
import { WEB_EFFORT, WEB_MODEL_ID, WebPolicyError } from './policy.ts'
import type { WebCallContext, WebDelivery } from './session-coordinator.ts'
import type { WebPageFactory } from './browser/types.ts'

interface SessionEvent { type: string; seq: number; data: Record<string, unknown> }
interface Agent {
  id: string
  status: 'idle' | 'running'
  cancel(cause: { kind: 'hook'; reason: string }): void
  session: {
    id: string
    header: { cwd?: string; parentSession?: string; origin?: 'subagent' }
    surface: { nodes: readonly number[] }
    snapshotEvents(): readonly SessionEvent[]
    deriveEventMessage(event: SessionEvent): { id: string } | null
  }
  model: { current(): { provider: string; model: string; reasoningEffort?: string } | undefined }
}
interface Agents { currentInitiator(): Agent | undefined; get(id: string): Agent | undefined; list(): Agent[] }
interface Sessions { flush(session: Agent['session']): Promise<boolean> }
interface AgentLoop { hostPolicyCapabilities?: Record<string, number>; adoptRecoveredResponse?(agent: Agent, input: unknown): Promise<unknown> }
interface Compaction { hostPolicyCapabilities?: Record<string, number>; adoptRecoveredSummary?(agent: Agent, input: unknown, signal: AbortSignal): Promise<unknown> }

/** Structural view of the public host API. The compatibility patch is version-checked at admission. */
export interface WebPluginContext {
  get(name: string): unknown
  provide(name: string, value: unknown): () => void
  on(name: string, callback: (...args: never[]) => unknown): () => void
  emit(name: string, ...args: unknown[]): void
}

function listener<T extends unknown[]>(ctx: WebPluginContext, name: string, callback: (...args: T) => unknown): void {
  ctx.on(name, callback as (...args: never[]) => unknown)
}

/** Register public hooks once; the host owns AgentLoop, tools, compaction and persistence. */
export function installWebHost(ctx: WebPluginContext, stateDir: string, route: string, configured?: () => unknown, options: { pageFactory?: WebPageFactory } = {}): ChatGptWebHost {
  const capabilities = () => ({
    ...(ctx.get('agentLoop') as AgentLoop | undefined)?.hostPolicyCapabilities,
    ...(ctx.get('compaction') as Compaction | undefined)?.hostPolicyCapabilities,
  })
  const host = new ChatGptWebHost(stateDir, route, {
    capabilities,
    resolveAttachments: () => ctx.get('attachments'),
    ...(options.pageFactory === undefined ? {} : { pageFactory: options.pageFactory }),
    isAgentBusy: sessionId => (ctx.get('agents') as Agents | undefined)?.get(sessionId)?.status === 'running',
    blocked: async ({ executionDomainId, sessionIds, workspaces, reason }) => {
      const agents = ctx.get('agents') as Agents | undefined
      for (const agent of agents?.list() ?? []) {
        const owner = ownerOf(agent)
        const workspace = await realpath(owner.workspace).catch(() => resolve(owner.workspace))
        if (!sessionIds.includes(agent.id) && !sessionIds.includes(owner.rootSessionId) && !workspaces.includes(workspace)) continue
        // Cancellation is synchronous; waiting for this hook's own Agent to
        // become idle would deadlock its cleanup. Existing host owners drain.
        try { agent.cancel({ kind: 'hook', reason: `Web execution domain blocked: ${reason}` }) }
        catch { ctx.emit('chatgpt-web/cleanup-pending', { executionDomainId, sessionId: agent.id }) }
      }
    },
    activity: value => {
      const raw = value as Record<string, unknown>
      const kinds: Record<string, string> = { accepted: 'prompt-accepted', content: 'content-delta', phase: 'phase-change', completed: 'response-completed' }
      ctx.emit('chatgpt-web/activity', { ...raw, kind: kinds[String(raw.kind)] ?? raw.kind })
    },
    adopt: async delivery => {
      const agents = ctx.get('agents') as Agents | undefined
      const agent = agents?.get(delivery.reference.sessionId)
      const loop = ctx.get('agentLoop') as AgentLoop | undefined
      if (!agent || !delivery.recovery) throw new WebPolicyError('this captured response requires its original live host recovery transaction')
      const chunks = deliveryChunks(delivery)
      const common = {
        executionDomainId: delivery.reference.executionDomainId, requestId: delivery.reference.requestId,
        providerResponseId: delivery.reference.responseId,
        responseDigest: createHash('sha256').update(JSON.stringify(chunks)).digest('hex'),
        request: delivery.recovery.request,
        surfaceSeqs: delivery.recovery.surfaceSeqs, chunks,
      }
      if (delivery.reference.kind === 'compaction') {
        const engine = ctx.get('compaction') as Compaction | undefined
        if (!engine?.adoptRecoveredSummary || !delivery.recovery.originalCompactionId || !delivery.recovery.sourceEventSeqs) throw new WebPolicyError('the host lacks the original summary recovery transaction')
        return await engine.adoptRecoveredSummary(agent, { ...common, originalCompactionId: delivery.recovery.originalCompactionId, sourceEventSeqs: delivery.recovery.sourceEventSeqs }, new AbortController().signal)
      }
      if (delivery.reference.kind !== 'main' || !loop?.adoptRecoveredResponse || delivery.recovery.requestHeaderSeq === undefined) throw new WebPolicyError('the host lacks the original main-response recovery transaction')
      const adopted = await loop.adoptRecoveredResponse(agent, { ...common, requestHeaderSeq: delivery.recovery.requestHeaderSeq })
      // The maintenance transaction has settled its tools. Publish their
      // durable facts before returning; emitted idle observers may still drain.
      await settleTools(agent)
      if (agent.status === 'idle') await host.agentIdle(String(agent.id))
      return adopted
    },
  }, configured, () => ctx.emit('llm/adapters-updated'))
  ctx.provide('chatgptWebHost', host)

  function ownerOf(agent: Agent): { sessionId: string; rootSessionId: string; workspace: string; parentSessionId?: string } {
    const agents = ctx.get('agents') as Agents | undefined
    let root = agent
    const seen = new Set([agent.id])
    // A normal fork may retain parentSession as history provenance. Only an
    // actual subagent inherits its creator's active execution domain.
    while (root.session.header.origin === 'subagent' && root.session.header.parentSession) {
      const parent = agents?.get(root.session.header.parentSession)
      if (!parent) break
      if (seen.has(parent.id)) throw new WebPolicyError('cyclic subagent ownership')
      seen.add(parent.id); root = parent
    }
    return {
      sessionId: String(agent.id), rootSessionId: String(root.id), workspace: root.session.header.cwd ?? stateDir,
      ...(agent.session.header.origin === 'subagent' && agent.session.header.parentSession ? { parentSessionId: String(agent.session.header.parentSession) } : {}),
    }
  }

  async function settleTools(agent: Agent): Promise<void> {
    const events = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    if (events.length === 0) return
    const sessions = ctx.get('sessions') as Sessions | undefined
    const durable = await sessions?.flush(agent.session) ?? false
    for (const event of events) {
      const message = event.data.message as { toolCallId?: string } | undefined
      const error = event.data.error as { code?: string } | undefined
      if (message?.toolCallId) await host.toolCommitted(String(agent.id), String(message.toolCallId), durable, error?.code === 'TOOL_OUTCOME_UNKNOWN')
    }
  }

  listener(ctx, 'llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> => {
    const agent = (ctx.get('agents') as Agents | undefined)?.currentInitiator()
    const main = typeof DshLlm.isAgentLoopRequest === 'function' && DshLlm.isAgentLoopRequest(options)
    return {
      async *[Symbol.asyncIterator]() {
        if (agent) await host.inheritOwner(ownerOf(agent))
        if (agent && await host.isManagedSession(String(agent.id), ownerOf(agent).workspace)) {
          await settleTools(agent)
          await host.guardSession(String(agent.id), ownerOf(agent).workspace)
        }
        if (options.provider !== route || options.model !== WEB_MODEL_ID) { yield* next(); return }
        let kind: WebCallContext['kind']
        if (main) {
          if (!agent || options.sessionId !== agent.id || options.purpose !== undefined) throw new WebPolicyError('main Web call has no matching public AgentLoop identity')
          kind = 'main'
        } else if (options.purpose === 'compaction' || options.purpose === 'session-title') kind = options.purpose
        else if (options.purpose !== undefined) throw new WebPolicyError('unsupported Web auxiliary purpose')
        else {
          if (options.tools?.length) throw new WebPolicyError('one-shot Web calls cannot request local tools')
          kind = 'one-shot'
        }
        const sessionId = options.sessionId ? String(options.sessionId) : `one-shot-${randomUUID()}`
        if (agent && sessionId !== agent.id) throw new WebPolicyError('Web auxiliary session identity differs from the initiating Agent')
        const context = await host.callContext(options, kind, agent ? ownerOf(agent) : { sessionId, rootSessionId: sessionId, workspace: stateDir })
        if (kind === 'main' && agent) {
          const header = agent.session.snapshotEvents().findLast(event => event.type === 'request/header')
          if (!header) throw new WebPolicyError('main Web request is missing its durable request header')
          context.recovery = { requestHeaderSeq: header.seq, surfaceSeqs: [...agent.session.surface.nodes] }
        }
        if (kind === 'compaction' && agent) {
          const events = agent.session.snapshotEvents()
          const start = events.findLast(event => event.type === 'compaction/start')
          if (!start || typeof start.data.compactionId !== 'string') throw new WebPolicyError('summary call is missing its original compaction transaction')
          const messages = new Set(options.messages.map(message => message.id).filter(Boolean))
          const selected = agent.session.surface.nodes.filter((seq, index) => {
            const event = events.find(event => event.seq === seq)
            const message = event && agent.session.deriveEventMessage(event)
            return !(index === 0 && event?.type === 'system/message') && message?.id !== undefined && messages.has(message.id as never)
          })
          if (selected.length === 0) throw new WebPolicyError('summary has no verifiable source surface range')
          const surface = [...agent.session.surface.nodes]
          const sourceEventSeqs = surface.slice(surface.indexOf(selected[0]!), surface.indexOf(selected[selected.length - 1]!) + 1)
          context.recovery = { surfaceSeqs: [...agent.session.surface.nodes], sourceEventSeqs: [...sourceEventSeqs], originalCompactionId: start.data.compactionId }
        }
        // rawOptions reaches the coordinator unchanged. Its image resolver runs
        // before browser intent and rejects unsupported files or missing bytes.
        yield* host.wrap(context, next)
      },
    }
  })

  listener(ctx, 'agent/replay-check', async ({ agent, request, failure }: { agent: Agent; request: GenerateOptions; failure: { message: string; code: string } }) => {
    await host.inheritOwner(ownerOf(agent))
    if (await host.isManagedSession(String(agent.id), ownerOf(agent).workspace)) { await settleTools(agent); await host.guardSession(String(agent.id), ownerOf(agent).workspace) }
    // Web failures stop this request series, including permanent preflight
    // failures under an "always" host retry policy. A new safe invocation is
    // explicit; ordinary SIWC retries retain the provider's normal semantics.
    if (request.provider === route && request.model === WEB_MODEL_ID) throw new WebPolicyError(failure.message, failure.code)
  })
  listener(ctx, 'agent/response-committed', async (payload: { agent: Agent; message: { id: string; content: readonly unknown[]; source: { replayState?: { response?: unknown } } }; eventSeq: number; durable: boolean }) => {
    const reference = replayReference(payload.message.source.replayState?.response)
    if (!reference) return
    if (reference.kind !== 'main' || reference.sessionId !== payload.agent.id) throw new WebPolicyError('main host commit has mismatched Web ownership')
    await host.committed(reference, payload.message.content, `assistant:${payload.agent.id}:${payload.eventSeq}:${payload.message.id}`, payload.durable)
  })
  listener(ctx, 'compaction/summary-route', async (payload: { proposedTarget?: { provider: string; model: string }; agent: Agent; maxTokens: number }, next: () => Promise<unknown>) => {
    const proposed = payload.proposedTarget ?? payload.agent.model.current()
    if (proposed?.provider !== route || proposed.model !== WEB_MODEL_ID) return next()
    await host.admitBinding({ provider: route, model: WEB_MODEL_ID, reasoningEffort: WEB_EFFORT })
    const { budget } = await host.settings.read()
    return { provider: route, model: WEB_MODEL_ID, reasoningEffort: WEB_EFFORT, maxTokens: Math.min(payload.maxTokens, Math.floor(budget.outputReserveBytes / 4)) }
  })
  listener(ctx, 'compaction/pressure-policy', async (payload: { target: { provider: string; model: string } }, next: () => Promise<unknown>) => {
    if (payload.target.provider !== route || payload.target.model !== WEB_MODEL_ID) return next()
    const { budget } = await host.settings.read()
    const window = Math.floor((budget.maxInputBytes - budget.outputReserveBytes) / 4)
    const headroomTokens = Math.min(1024, Math.floor(window / 8))
    const maxTokens = Math.min(Math.floor(budget.outputReserveBytes / 4), Math.floor(window / 2))
    return {
      headroomTokens, maxTokens, thresholdRatio: 0.7,
      retainTokens: Math.max(1, Math.floor((window - maxTokens - headroomTokens) / 4)),
    }
  })
  listener(ctx, 'compaction/committed', async (payload: { agent: Agent; event: SessionEvent; durable: boolean }) => {
    const state = payload.event.data.replayState as { response?: unknown } | undefined
    const reference = replayReference(state?.response)
    if (!reference) return
    if (reference.kind !== 'compaction' || reference.sessionId !== payload.agent.id) throw new WebPolicyError('summary commit has mismatched Web ownership')
    await host.committed(reference, payload.event.data.rawOutput as readonly unknown[], `compaction:${payload.agent.id}:${String(payload.event.data.compactionId)}:${payload.event.seq}`, payload.durable)
  })

  listener(ctx, 'tools/execute', async (exec: { agent?: Agent; callId: string; rootCallId: string }, next: () => Promise<unknown>) => {
    if (exec.agent) {
      await host.inheritOwner(ownerOf(exec.agent))
      if (await host.isManagedSession(String(exec.agent.id), ownerOf(exec.agent).workspace)) await host.guardSession(String(exec.agent.id), ownerOf(exec.agent).workspace)
      await host.toolStarted(String(exec.agent.id), String(exec.callId), String(exec.rootCallId))
    }
    return await next()
  })
  listener(ctx, 'tools/result', (exec: { agent?: Agent; callId: string }, result: { error?: { info?: { code?: string } } }) => {
    if (!exec.agent) return
    void host.toolObserved(String(exec.agent.id), String(exec.callId), result.error?.info?.code === 'TOOL_OUTCOME_UNKNOWN').catch(() => {
      // A failed observer never grants admission: its intent remains pending.
    })
  })
  listener(ctx, 'agent/status', ({ agent, status }: { agent: Agent; status: string }) => {
    if (status === 'idle' || status === 'disposed') {
      host.observeAgentIdle(String(agent.id))
      void settleTools(agent).then(() => host.agentIdle(String(agent.id))).catch(() => {})
    }
  })

  const recoveryCheck = async (payload: { agent: Agent; input: { requestId: string; executionDomainId: string; providerResponseId: string; chunks: StreamChunk[] } }) => {
    const finish = payload.input.chunks.findLast(chunk => chunk.type === 'finish')
    const reference = replayReference((finish?.type === 'finish' ? finish.replayState as { response?: unknown } | undefined : undefined)?.response)
    if (!reference || reference.sessionId !== payload.agent.id || reference.requestId !== payload.input.requestId || reference.executionDomainId !== payload.input.executionDomainId || reference.responseId !== payload.input.providerResponseId) throw new WebPolicyError('recovered Web response identity is invalid')
    // The adoption service verifies its surface/header/tool contract. The
    // plugin additionally requires its own captured, digest-checked journal.
    const observed = await host.recover(reference.requestId) as { result?: { artifact?: { sha256?: string } } }
    if (observed.result?.artifact?.sha256 !== reference.responseDigest) throw new WebPolicyError('recovered result does not match the private Web artifact')
    await host.authorizeRecovery(reference, payload.input.chunks)
  }
  listener(ctx, 'agent/recovery-check', recoveryCheck)
  listener(ctx, 'compaction/recovery-check', recoveryCheck)
  return host
}
