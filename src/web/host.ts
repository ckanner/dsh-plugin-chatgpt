import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { WebSettingsStore, type WebSettings } from './config.ts'
import { WebStore } from './store.ts'
import { canonical, digest, nonempty, WEB_EFFORT, WEB_MODEL_ID, WEB_PROTOCOL, WebPolicyError } from './policy.ts'
import { WebSessionCoordinator, type WebCallContext, type WebDelivery, type WebReplayReference } from './session-coordinator.ts'
import { WebTransport } from './transport.ts'
import type { WebFacts, WebPageFactory } from './browser/types.ts'
import { deliveryChunks } from './chunks.ts'

export const webHostCapabilities = Object.freeze({
  version: 1, runtimeVersion: 'web-runtime/1', providerModel: WEB_MODEL_ID,
  transport: 'chatgpt-web', observation: 'opaque', usage: 'unknown',
  requiredHost: Object.freeze({ replayVeto: 1, durableResponseAck: 1, summaryRoute: 1, durableSummaryAck: 1, pressurePolicy: 1 }),
  // Capability declarations are not a live account or browser compatibility probe.
  media: 'unavailable', oracleRuntime: false,
})

export interface WebBindingRequest {
  provider: string
  model: string
  reasoningEffort?: string
  sessionId?: string
  hostInvocationId?: string
  purpose?: string
  executionDomainId?: string
  requireIsolation?: boolean
  deadlineMs?: number
}

export interface WebInvocationRequest {
  sessionId: string
  executionDomainId: string
  hostInvocationId: string
  deadlineMs?: number
  requireIsolation?: boolean
  workspace?: string
}

export interface WebSessionOwner { sessionId: string; rootSessionId: string; workspace: string; parentSessionId?: string }

interface CallRecord {
  requestId: string
  sessionId: string
  kind: WebCallContext['kind']
  connectionKey: string
  facts: WebFacts
  committed: boolean
  conversationUrl?: string
}

interface InvocationRecord {
  version: 1
  sessionId: string
  executionDomainId: string
  hostInvocationId: string
  deadlineMs: number
  requireIsolation: boolean
  managedBy: 'host' | 'plugin'
  settingsDigest: string
  calls: CallRecord[]
  toolIntents: Record<string, { sessionId: string; rootCallId: string; completed: boolean; observed?: boolean; outcomeUnknown?: boolean }>
  fence?: string
  finished: boolean
  completed: boolean
}

interface HostRegistry {
  version: 1
  sessions: Record<string, string>
  invocations: Record<string, InvocationRecord>
  /** Public-host domains remain discoverable after fresh sessions/provider switches. */
  workspaceDomains?: Record<string, string[]>
}

export interface WebHostEnvironment {
  capabilities(): { replayVeto?: number; durableResponseAck?: number; summaryRoute?: number; durableSummaryAck?: number; pressurePolicy?: number; recoveredResponse?: number; recoveredSummary?: number }
  activity(value: unknown): void
  /** Construction-only test seam; production always uses the managed CDP page. */
  pageFactory?: WebPageFactory
  isAgentBusy?(sessionId: string): boolean
  blocked?(input: { executionDomainId: string; sessionIds: string[]; workspaces: string[]; reason: string }): void | Promise<void>
  /** Public host adoption transaction, installed only by the versioned compatibility contract. */
  adopt?(delivery: WebDelivery): Promise<unknown>
}

export class ChatGptWebHost {
  readonly version = 1
  readonly runtimeVersion = 'web-runtime/1'
  readonly settings: WebSettingsStore
  private readonly store: WebStore
  private readonly contexts = new AsyncLocalStorage<WebCallContext>()
  private readonly coordinators = new Map<string, WebSessionCoordinator>()
  private readonly transports = new Map<string, WebTransport>()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly liveTools = new Map<string, string>()
  private readonly liveCalls = new Map<string, WebCallContext>()
  private readonly stateDir: string
  private readonly route: string
  private readonly environment: WebHostEnvironment

  constructor(stateDir: string, route: string, environment: WebHostEnvironment, configured?: () => unknown, changed?: () => void) {
    this.stateDir = stateDir
    this.route = route
    this.environment = environment
    this.settings = new WebSettingsStore(stateDir, configured, changed)
    this.store = new WebStore(join(resolve(stateDir), 'web-host'))
  }

  private async registry(): Promise<HostRegistry> {
    return await this.store.read<HostRegistry>('registry', 'current') ?? { version: 1, sessions: {}, invocations: {} }
  }

  private async physicalWorkspace(workspace: string): Promise<string> {
    nonempty(workspace, 'workspace', 4096)
    try { return await realpath(resolve(workspace)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(workspace); throw error }
  }

  private bindWorkspace(registry: HostRegistry, workspace: string, domain: string): void {
    registry.workspaceDomains ??= {}
    const domains = registry.workspaceDomains[workspace] ??= []
    if (!domains.includes(domain)) domains.push(domain)
  }

  private async stopDomain(executionDomainId: string, reason: string): Promise<void> {
    const registry = await this.registry()
    const invocationIds = new Set(Object.values(registry.invocations).filter(record => record.executionDomainId === executionDomainId).map(record => record.hostInvocationId))
    await this.environment.blocked?.({
      executionDomainId, reason,
      sessionIds: Object.entries(registry.sessions).filter(([, id]) => invocationIds.has(id)).map(([id]) => id),
      workspaces: Object.entries(registry.workspaceDomains ?? {}).filter(([, domains]) => domains.includes(executionDomainId)).map(([workspace]) => workspace),
    })
  }

  private async change<T>(operation: (registry: HostRegistry) => Promise<T> | T, writeWhen: (registry: HostRegistry) => boolean = () => true): Promise<T> {
    const job = this.queue.catch(() => {}).then(() => this.store.locked('registry', 'current', async () => {
      const registry = await this.registry()
      const result = await operation(registry)
      if (writeWhen(registry)) await this.store.write('registry', 'current', registry)
      return result
    }))
    // A rejected admission is reported to its caller. The ordering barrier
    // still settles, so unrelated execution domains are not permanently poisoned.
    this.queue = job.then(() => {}, () => {})
    return await job
  }

  private requireHost(): void {
    const actual = this.environment.capabilities()
    for (const [key, version] of Object.entries(webHostCapabilities.requiredHost)) {
      if (actual[key as keyof typeof actual] !== version) throw new WebPolicyError(`DSH host extension ${key} v${version} is required; install the documented compatibility build before enabling Web calls`)
    }
  }

  async admitBinding(input: WebBindingRequest) {
    if (input.provider !== this.route || input.model !== WEB_MODEL_ID || input.reasoningEffort !== WEB_EFFORT) throw new WebPolicyError('requested binding is not this Web model and Pro effort')
    const settings = await this.settings.read()
    if (input.hostInvocationId !== undefined || input.sessionId !== undefined) {
      await this.queue
      const registry = await this.registry()
      const id = input.hostInvocationId ?? registry.sessions[input.sessionId!]
      const invocation = id ? registry.invocations[id] : undefined
      if (input.hostInvocationId && !invocation) throw new WebPolicyError('binding has no matching host invocation')
      if (invocation && (invocation.settingsDigest !== digest(settings) || (input.executionDomainId !== undefined && invocation.executionDomainId !== input.executionDomainId))) throw new WebPolicyError('Web connection or policy changed within the host invocation')
    }
    if (!settings.enabled) throw new WebPolicyError('Web models are disabled')
    this.requireHost()
    const connection = settings.connections[settings.activeConnection]
    if (!connection?.accountFingerprint) throw new WebPolicyError('the dedicated browser account has not been bound', 'AUTH')
    if (input.requireIsolation && settings.contextPolicy !== 'project-only') throw new WebPolicyError('the operation requires project-only hosted context')
    if (input.executionDomainId) await this.assertDomain(input.executionDomainId)
    return {
      protocol: 1 as const, transport: 'chatgpt-web' as const, provider: this.route, model: WEB_MODEL_ID, reasoningEffort: WEB_EFFORT,
      connectionId: connection.id, accountFingerprint: connection.accountFingerprint, policyVersion: settings.budget.version,
      contextPolicy: settings.contextPolicy, observation: 'opaque' as const, usage: 'unknown' as const,
      hostContractVersion: 1 as const, runtimeVersion: this.runtimeVersion,
    }
  }

  private unresolved(record: InvocationRecord): boolean {
    return record.fence !== undefined || Object.entries(record.toolIntents).some(([id, tool]) => !tool.completed && !this.liveTools.has(`${record.hostInvocationId}:${id}`))
      || record.calls.some(call => !call.committed && !this.callIsLive(call.requestId) && !(call.facts.dispatch === 'not-dispatched' && call.facts.localCleanup === 'confirmed' && call.facts.replayAllowed))
  }

  private callIsLive(requestId: string): boolean {
    const context = this.liveCalls.get(requestId)
    return context !== undefined && !context.rawOptions.signal?.aborted
      && (context.active || this.environment.isAgentBusy?.(context.sessionId) === true)
  }

  async assertDomain(executionDomainId: string): Promise<void> {
    await this.queue
    const registry = await this.registry()
    const blocked = Object.values(registry.invocations).find(record => record.executionDomainId === executionDomainId && this.unresolved(record))
    if (blocked) throw new WebPolicyError(`execution domain needs recovery: ${blocked.fence ?? 'a response or tool outcome is uncommitted'}`)
  }

  async beginInvocation(input: WebInvocationRequest): Promise<void> {
    await this.createInvocation(input, 'host')
  }

  private async createInvocation(input: WebInvocationRequest, managedBy: InvocationRecord['managedBy']): Promise<void> {
    nonempty(input.hostInvocationId, 'hostInvocationId', 200)
    nonempty(input.sessionId, 'sessionId', 200)
    nonempty(input.executionDomainId, 'executionDomainId', 200)
    const settings = await this.settings.read()
    const workspace = input.workspace === undefined ? undefined : await this.physicalWorkspace(input.workspace)
    const deadline = Math.min(input.deadlineMs ?? Infinity, Date.now() + settings.budget.wallTimeoutMs)
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) throw new WebPolicyError('invocation has no remaining wall budget', 'TIMEOUT')
    await this.change(registry => {
      if (workspace !== undefined) this.bindWorkspace(registry, workspace, input.executionDomainId)
      const existing = registry.invocations[input.hostInvocationId]
      if (existing) {
        if (existing.sessionId !== input.sessionId || existing.executionDomainId !== input.executionDomainId || existing.requireIsolation !== (input.requireIsolation ?? false)) throw new WebPolicyError('host invocation identity changed')
        if (existing.settingsDigest !== digest(settings)) throw new WebPolicyError('Web connection or policy changed within the host invocation')
        // Re-entrant admission cannot extend the original deadline.
        existing.deadlineMs = Math.min(existing.deadlineMs, deadline)
        return
      }
      const previous = Object.values(registry.invocations).find(record => record.executionDomainId === input.executionDomainId && (this.unresolved(record) || record.calls.some(call => this.liveCalls.has(call.requestId)) || Object.keys(record.toolIntents).some(id => this.liveTools.has(`${record.hostInvocationId}:${id}`))))
      if (previous) throw new WebPolicyError('execution domain contains an unresolved invocation')
      if (Object.keys(registry.invocations).length >= 2048) throw new WebPolicyError('Web journal index requires explicit retention maintenance')
      registry.invocations[input.hostInvocationId] = {
        version: 1, sessionId: input.sessionId, executionDomainId: input.executionDomainId, hostInvocationId: input.hostInvocationId,
        deadlineMs: deadline, requireIsolation: input.requireIsolation ?? false, managedBy, settingsDigest: digest(settings), calls: [], toolIntents: {}, finished: false, completed: false,
      }
      registry.sessions[input.sessionId] = input.hostInvocationId
    })
  }

  /** Called for every child provider/tool, including children that never use Web. */
  async inheritOwner(owner: WebSessionOwner): Promise<void> {
    await this.queue
    const registry = await this.registry()
    const parentId = (owner.parentSessionId ? registry.sessions[owner.parentSessionId] : undefined) ?? (owner.rootSessionId !== owner.sessionId ? registry.sessions[owner.rootSessionId] : undefined)
    if (!parentId || registry.sessions[owner.sessionId] === parentId) return
    const parent = registry.invocations[parentId]
    if (!parent) throw new WebPolicyError('subagent execution owner is missing')
    const workspace = await this.physicalWorkspace(owner.workspace)
    await this.guardSession(owner.sessionId, workspace)
    await this.assertDomain(parent.executionDomainId)
    await this.change(state => { state.sessions[owner.sessionId] = parentId; this.bindWorkspace(state, workspace, parent.executionDomainId) })
  }

  async callContext(options: GenerateOptions, kind: WebCallContext['kind'], owner: WebSessionOwner): Promise<WebCallContext> {
    const workspace = await this.physicalWorkspace(owner.workspace)
    await this.guardSession(owner.sessionId, workspace)
    const registry = await this.registry()
    let invocationId = registry.sessions[owner.sessionId] ?? (owner.parentSessionId ? registry.sessions[owner.parentSessionId] : undefined) ?? registry.sessions[owner.rootSessionId]
    let invocation = invocationId === undefined ? undefined : registry.invocations[invocationId]
    if (!invocation || (invocation.managedBy === 'plugin' && invocation.finished && kind !== 'session-title' && owner.rootSessionId === owner.sessionId)) {
      invocationId = randomUUID()
      // Workspace identity survives fresh sessions and provider switches. Child
      // sessions inherit a parent's explicit host domain when one exists.
      const domain = `dsh-workspace:${digest(workspace)}`
      await this.createInvocation({ sessionId: owner.sessionId, executionDomainId: domain, hostInvocationId: invocationId, workspace }, 'plugin')
      invocation = (await this.registry()).invocations[invocationId]!
    }
    const context: WebCallContext = {
      kind, sessionId: owner.sessionId, executionDomainId: invocation.executionDomainId, hostInvocationId: invocation.hostInvocationId,
      deadlineMs: invocation.deadlineMs, requireIsolation: invocation.requireIsolation, active: true, rawOptions: options,
    }
    await this.change(state => { state.sessions[owner.sessionId] = context.hostInvocationId; this.bindWorkspace(state, workspace, context.executionDomainId) })
    await this.assertDomain(context.executionDomainId)
    return context
  }

  /** Scope the complete lazy iterator, including return/throw, without mutating frozen host options. */
  wrap(context: WebCallContext, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    const storage = this.contexts
    let claimed = false
    return {
      [Symbol.asyncIterator]() {
        if (claimed) throw new WebPolicyError('Web stream cannot be iterated twice')
        claimed = true
        const iterator = storage.run(context, () => next()[Symbol.asyncIterator]())
        async function run(method: 'next' | 'return' | 'throw', value?: unknown): Promise<IteratorResult<StreamChunk>> {
          if (!context.active) return { done: true, value: undefined }
          try {
            const operation = iterator[method]
            if (!operation) { context.active = false; if (method === 'throw') throw value; return { done: true, value: undefined } }
            const result = await storage.run(context, () => operation.call(iterator, value as never))
            if (result.done || method !== 'next') context.active = false
            return result
          } catch (error) { context.active = false; throw error }
        }
        return { next: () => run('next'), return: value => run('return', value), throw: error => run('throw', error) }
      },
    }
  }

  private async connection(settings: WebSettings): Promise<{ key: string; transport: WebTransport; coordinator: WebSessionCoordinator }> {
    const connection = settings.connections[settings.activeConnection]!
    const key = digest(connection)
    let transport = this.transports.get(key)
    if (!transport) { transport = new WebTransport(connection, this.environment.pageFactory === undefined ? {} : { pageFactory: this.environment.pageFactory }); this.transports.set(key, transport) }
    let coordinator = this.coordinators.get(key)
    if (!coordinator) {
      coordinator = new WebSessionCoordinator(join(this.stateDir, 'web-connections', key), transport, async (context, requestId, facts) => {
        if (context.active) this.liveCalls.set(requestId, context)
        await this.change(registry => {
          const invocation = registry.invocations[context.hostInvocationId]
          if (!invocation || invocation.executionDomainId !== context.executionDomainId) throw new WebPolicyError('invocation facts have lost their host owner')
          let call = invocation.calls.find(call => call.requestId === requestId)
          if (!call) { call = { requestId, sessionId: context.sessionId, kind: context.kind, connectionKey: key, facts, committed: false }; invocation.calls.push(call) }
          else call.facts = facts
          if (!this.liveCalls.has(requestId) && (facts.dispatch === 'unknown' || facts.remoteGeneration === 'unknown')) invocation.fence = 'remote dispatch or generation is unknown'
          else if (invocation.calls.every(entry => entry.committed || (entry.facts.dispatch === 'not-dispatched' && entry.facts.localCleanup === 'confirmed' && entry.facts.replayAllowed)) && Object.values(invocation.toolIntents).every(tool => tool.completed)) delete invocation.fence
        })
      }, (context, activity) => this.environment.activity({ ...activity as object, executionDomainId: context.executionDomainId, hostInvocationId: context.hostInvocationId, sessionId: context.sessionId }))
      this.coordinators.set(key, coordinator)
    }
    return { key, transport, coordinator }
  }

  async generate(expectedSettings?: string, resolved?: GenerateOptions): Promise<WebDelivery> {
    const context = this.contexts.getStore()
    if (!context?.active) throw new WebPolicyError('Web calls require the public pre-projection host boundary')
    if (resolved) {
      if (resolved.provider !== context.rawOptions.provider || resolved.model !== context.rawOptions.model || resolved.reasoningEffort !== WEB_EFFORT || (context.rawOptions.reasoningEffort !== undefined && context.rawOptions.reasoningEffort !== resolved.reasoningEffort)) throw new WebPolicyError('resolved Web binding differs from the original host request')
      // The host resolves defaults after the pre-projection middleware. Keep
      // its original media/history and materialize only the admitted effort.
      context.rawOptions = { ...context.rawOptions, reasoningEffort: resolved.reasoningEffort }
    }
    await this.admitBinding({ provider: context.rawOptions.provider, model: context.rawOptions.model, reasoningEffort: String(context.rawOptions.reasoningEffort), hostInvocationId: context.hostInvocationId, sessionId: context.sessionId, executionDomainId: context.executionDomainId, requireIsolation: context.requireIsolation })
    const settings = await this.settings.read()
    if (expectedSettings !== undefined && digest(settings) !== expectedSettings) throw new WebPolicyError('Web connection or policy changed after model preparation')
    const { coordinator } = await this.connection(settings)
    try { return await coordinator.run(context, settings) }
    catch (error) {
      for (const [id, active] of this.liveCalls) if (active === context) this.liveCalls.delete(id)
      // An ordinary classification failure must not erase a transport WAL or
      // permit the host's "always" retry policy to replay an uncertain turn.
      const facts = (error as { facts?: WebFacts }).facts
      if (!facts || facts.dispatch !== 'not-dispatched' || facts.localCleanup !== 'confirmed' || !facts.replayAllowed) {
        const reason = error instanceof Error ? error.message.slice(0, 512) : 'Web call needs recovery'
        const blocked = await this.change(registry => { const record = registry.invocations[context.hostInvocationId]; if (record?.calls.some(call => !call.committed)) { record.fence = reason; return true }; return false })
        if (blocked) await this.stopDomain(context.executionDomainId, reason)
      }
      throw error
    }
  }

  async committed(reference: WebReplayReference, blocks: readonly unknown[], hostCommitId: string, durable: boolean): Promise<void> {
    const registry = await this.registry()
    const invocation = registry.invocations[reference.hostInvocationId]
    const call = invocation?.calls.find(call => call.requestId === reference.requestId)
    if (!call || call.sessionId !== reference.sessionId || invocation?.executionDomainId !== reference.executionDomainId) throw new WebPolicyError('host commit has no matching Web invocation')
    try {
      if (!durable) throw new WebPolicyError('DSH did not confirm a durable host commit; Web response remains pending')
      let coordinator = this.coordinators.get(call.connectionKey)
      if (!coordinator) {
        const active = await this.connection(await this.settings.read())
        if (active.key !== call.connectionKey) throw new WebPolicyError('restore the original Web connection to recover its response')
        coordinator = active.coordinator
      }
      await coordinator.acknowledge(reference, blocks, hostCommitId)
      this.liveCalls.delete(reference.requestId)
      await this.change(state => {
        const record = state.invocations[reference.hostInvocationId]!
        const saved = record.calls.find(entry => entry.requestId === reference.requestId)!
        saved.committed = true
        saved.conversationUrl = reference.conversationUrl
        if (reference.kind === 'main' && reference.sessionId === record.sessionId && !blocks.some(block => (block as { type?: string }).type === 'tool-call')) { record.finished = true; record.completed = true }
        if (record.calls.every(entry => entry.committed || (entry.facts.dispatch === 'not-dispatched' && entry.facts.localCleanup === 'confirmed' && entry.facts.replayAllowed)) && Object.values(record.toolIntents).every(tool => tool.completed)) delete record.fence
      })
    } catch (error) {
      this.liveCalls.delete(reference.requestId)
      const reason = error instanceof Error ? error.message.slice(0, 512) : 'durable host acknowledgement failed'
      await this.change(state => { const record = state.invocations[reference.hostInvocationId]; if (record) record.fence = reason })
      await this.stopDomain(reference.executionDomainId, reason)
      throw error
    }
  }

  async replayCheck(sessionId: string): Promise<void> {
    const registry = await this.registry()
    const invocationId = registry.sessions[sessionId]
    const invocation = invocationId ? registry.invocations[invocationId] : undefined
    if (invocation) await this.assertDomain(invocation.executionDomainId)
  }

  async toolStarted(sessionId: string, toolId: string, rootCallId = toolId): Promise<void> {
    if (!(await this.registry()).sessions[sessionId]) return
    await this.replayCheck(sessionId)
    await this.change(registry => {
      const id = registry.sessions[sessionId]
      const invocation = id ? registry.invocations[id] : undefined
      if (invocation) {
        if (Object.values(registry.invocations).some(record => record.executionDomainId === invocation.executionDomainId && this.unresolved(record))) throw new WebPolicyError('execution domain became unresolved before tool dispatch')
        if (invocation.toolIntents[toolId]) throw new WebPolicyError('tool identity was already dispatched')
        invocation.toolIntents[toolId] = { sessionId, rootCallId, completed: false }
        this.liveTools.set(`${invocation.hostInvocationId}:${toolId}`, sessionId)
      }
    })
  }

  async toolObserved(sessionId: string, toolId: string, unknown: boolean): Promise<void> {
    // Enqueue synchronously: tools/result is an emitted event, so an async
    // registry read here could let the following durable root result overtake it.
    const domain = await this.change(registry => {
      const id = registry.sessions[sessionId]
      const invocation = id ? registry.invocations[id] : undefined
      const tool = invocation?.toolIntents[toolId]
      if (!invocation || !tool) return
      tool.observed = true
      if (unknown) {
        tool.outcomeUnknown = true
        this.liveTools.delete(`${invocation.hostInvocationId}:${toolId}`)
        invocation.fence = 'tool outcome is not durably known'
        return invocation.executionDomainId
      }
    }, registry => registry.sessions[sessionId] !== undefined)
    if (domain) await this.stopDomain(domain, 'tool outcome is not durably known')
  }

  async toolCommitted(sessionId: string, toolId: string, durable: boolean, unknown: boolean): Promise<void> {
    if (!(await this.registry()).sessions[sessionId]) return
    const blocked = await this.change(registry => {
      const id = registry.sessions[sessionId]
      const invocation = id ? registry.invocations[id] : undefined
      const related = Object.entries(invocation?.toolIntents ?? {}).filter(([id, tool]) => id === toolId || tool.rootCallId === toolId)
      if (!invocation || related.length === 0) return
      if (!durable || unknown) {
        if (unknown) for (const [, tool] of related) tool.outcomeUnknown = true
        invocation.fence = 'tool outcome is not durably known'; return invocation.executionDomainId
      }
      for (const [id, tool] of related) {
        if (tool.outcomeUnknown || (id !== toolId && !tool.observed)) { invocation.fence = 'nested tool outcome is not durably known'; continue }
        tool.completed = true
        this.liveTools.delete(`${invocation.hostInvocationId}:${id}`)
      }
      if (related.some(([, tool]) => !tool.completed)) return invocation.executionDomainId
    })
    if (blocked) await this.stopDomain(blocked, 'tool outcome is not durably known')
  }

  async guardSession(sessionId: string, workspace: string): Promise<void> {
    await this.queue
    const registry = await this.registry()
    const id = registry.sessions[sessionId]
    const invocation = id ? registry.invocations[id] : undefined
    const physical = await this.physicalWorkspace(workspace)
    const domains = new Set([`dsh-workspace:${digest(physical)}`, ...(registry.workspaceDomains?.[physical] ?? []), ...(invocation ? [invocation.executionDomainId] : [])])
    for (const domain of domains) await this.assertDomain(domain)
  }

  async isManagedSession(sessionId: string, workspace: string): Promise<boolean> {
    await this.queue
    const registry = await this.registry()
    const physical = await this.physicalWorkspace(workspace)
    const domains = new Set([`dsh-workspace:${digest(physical)}`, ...(registry.workspaceDomains?.[physical] ?? [])])
    return registry.sessions[sessionId] !== undefined || Object.values(registry.invocations).some(record => domains.has(record.executionDomainId) && this.unresolved(record))
  }

  observeAgentIdle(sessionId: string): void {
    // This runs synchronously in the status event. A following turn cannot
    // revive a previous unfinished call merely by making the Agent running again.
    for (const [id, owner] of this.liveTools) if (owner === sessionId) this.liveTools.delete(id)
    for (const [id, context] of this.liveCalls) if (context.sessionId === sessionId && !context.active) this.liveCalls.delete(id)
  }

  async agentIdle(sessionId: string): Promise<void> {
    this.observeAgentIdle(sessionId)
    if (!(await this.registry()).sessions[sessionId]) return
    const blocked = await this.change(registry => {
      const id = registry.sessions[sessionId]
      const invocation = id ? registry.invocations[id] : undefined
      if (!invocation) return
      if (invocation.sessionId === sessionId && !this.unresolved(invocation)) invocation.finished = true
      if (this.unresolved(invocation)) return invocation.executionDomainId
    })
    if (blocked) await this.stopDomain(blocked, 'the Agent stopped before all Web and tool commits were confirmed')
  }

  async deliveredEphemeral(reference: WebReplayReference, blocks: readonly unknown[]): Promise<void> {
    if (reference.kind !== 'session-title' && reference.kind !== 'one-shot') throw new WebPolicyError('only explicitly nonpersistent auxiliary calls use delivery acknowledgement')
    // The private delivery receipt is durable, while the caller's title/one-shot
    // operation is explicitly classified as nonpersistent in the reference.
    await this.committed(reference, blocks, `nonpersistent-delivery:${reference.requestId}`, true)
  }

  async invocationFacts(input: Pick<WebInvocationRequest, 'sessionId' | 'executionDomainId' | 'hostInvocationId'>) {
    await this.queue
    const registry = await this.registry()
    const record = registry.invocations[input.hostInvocationId]
    if (!record || record.sessionId !== input.sessionId || record.executionDomainId !== input.executionDomainId) throw new WebPolicyError('no facts match this host invocation identity')
    // Live ownership affects admission/queuing, never the business evidence
    // returned at the process boundary while a response or tool is unfinished.
    const unknown = this.unresolved(record) || Object.values(record.toolIntents).some(tool => !tool.completed)
      || record.calls.some(call => !call.committed && !(call.facts.dispatch === 'not-dispatched' && call.facts.localCleanup === 'confirmed' && call.facts.replayAllowed))
    const dispatch = record.calls.some(call => call.facts.dispatch === 'unknown') ? 'unknown' as const
      : record.calls.some(call => call.facts.dispatch === 'confirmed') ? 'dispatched' as const : 'not-dispatched' as const
    return {
      version: 1 as const, ...input, dispatch,
      outcome: unknown ? 'unknown' as const : record.completed ? 'completed' as const : 'failed' as const,
      remoteGeneration: record.calls.some(call => call.facts.remoteGeneration === 'unknown') ? 'unknown' as const
        : record.calls.some(call => call.facts.remoteGeneration === 'running') ? 'running' as const : 'idle' as const,
      localCleanupConfirmed: record.calls.every(call => call.facts.localCleanup === 'confirmed'), usageStatus: 'unknown' as const,
      invocations: record.calls.map(call => ({ requestId: call.requestId, sessionId: call.sessionId, kind: call.kind, facts: call.facts, committed: call.committed })),
    }
  }

  async status() {
    const settings = await this.settings.read()
    const registry = await this.registry()
    return {
      settings, hostCapabilities: this.environment.capabilities(), runtimeVersion: this.runtimeVersion,
      managedByProfile: this.settings.managedByProfile(),
      configured: settings.connections[settings.activeConnection]?.accountFingerprint !== '',
      // Static reads never launch Chrome, inspect personal tabs or spend quota.
      liveVerified: false,
      recentConversations: Object.values(registry.invocations).flatMap(record => record.calls).filter(call => call.committed && call.conversationUrl !== undefined).slice(-5).map(call => ({ sessionId: call.sessionId, kind: call.kind, url: call.conversationUrl! })),
      pending: Object.values(registry.invocations).filter(record => this.unresolved(record)).map(record => ({ sessionId: record.sessionId, hostInvocationId: record.hostInvocationId, reason: record.fence ?? 'pending host/tool commit', requestIds: record.calls.filter(call => !call.committed).map(call => call.requestId) })),
    }
  }

  async configure(value: unknown) {
    if (this.liveCalls.size > 0 || this.liveTools.size > 0) throw new WebPolicyError('wait for active Web calls and local tools before changing the connection')
    if ((await this.status()).pending.length > 0) throw new WebPolicyError('recover pending Web work before changing its connection')
    await this.settings.save(value)
    return await this.status()
  }

  async connect() {
    const settings = await this.settings.read()
    const { transport } = await this.connection(settings)
    const result = await transport.connect()
    if (result.accountFingerprint) {
      const connection = settings.connections[settings.activeConnection]!
      if (connection.accountFingerprint && connection.accountFingerprint !== result.accountFingerprint) throw new WebPolicyError('browser account differs from its stored binding', 'AUTH')
      if (!connection.accountFingerprint) {
        if (this.settings.managedByProfile()) return { ...await this.status(), connection: result, configurationRequired: true }
        connection.accountFingerprint = result.accountFingerprint
        await this.settings.save(settings)
      }
    }
    return { ...await this.status(), connection: result, configurationRequired: false }
  }

  async recover(requestId: string, adopt = false): Promise<unknown> {
    nonempty(requestId, 'requestId', 200)
    const registry = await this.registry()
    const call = Object.values(registry.invocations).flatMap(record => record.calls).find(call => call.requestId === requestId)
    if (!call) throw new WebPolicyError('request is not owned by this plugin host')
    const active = await this.connection(await this.settings.read())
    if (active.key !== call.connectionKey) throw new WebPolicyError('recovery requires the original Web connection')
    const observed = await active.coordinator.recover(requestId)
    if (!adopt) return observed
    const delivery = await active.coordinator.delivery(requestId)
    if (!delivery) throw new WebPolicyError('no validated response is available to adopt')
    const required = delivery.reference.kind === 'compaction' ? 'recoveredSummary' : 'recoveredResponse'
    if (this.environment.capabilities()[required] !== 1 || !this.environment.adopt) throw new WebPolicyError('the host does not provide this recovered-response adoption transaction; the captured result is read-only')
    await this.authorizeRecovery(delivery.reference)
    return await this.environment.adopt(delivery)
  }

  /** Adoption can settle this response, never unrelated remote/tool uncertainty. */
  async authorizeRecovery(reference: WebReplayReference, chunks?: readonly StreamChunk[]): Promise<void> {
    await this.queue
    const registry = await this.registry()
    const owner = registry.invocations[reference.hostInvocationId]
    const target = owner?.calls.find(call => call.requestId === reference.requestId)
    if (!owner || owner.executionDomainId !== reference.executionDomainId || !target || target.sessionId !== reference.sessionId || target.kind !== reference.kind) throw new WebPolicyError('recovery does not match its original host ownership')
    const active = await this.connection(await this.settings.read())
    const delivery = await active.coordinator.delivery(reference.requestId)
    if (active.key !== target.connectionKey || !delivery || canonical(delivery.reference) !== canonical(reference) || digest(delivery.blocks) !== reference.contentDigest || (chunks !== undefined && canonical(chunks) !== canonical(deliveryChunks(delivery)))) throw new WebPolicyError('recovery content differs from the validated private delivery')
    if (target.facts.outcome !== 'captured' || target.facts.remoteGeneration !== 'completed' || target.facts.localCleanup !== 'confirmed') throw new WebPolicyError('recovery requires a captured terminal response and confirmed local cleanup')
    for (const record of Object.values(registry.invocations).filter(entry => entry.executionDomainId === owner.executionDomainId)) {
      if (Object.values(record.toolIntents).some(tool => !tool.completed)) throw new WebPolicyError('recovery cannot settle an unresolved local tool outcome')
      if (record !== owner && this.unresolved(record)) throw new WebPolicyError('another invocation in this execution domain needs recovery')
      if (record.calls.some(call => call.requestId !== target.requestId && !call.committed && !(call.facts.dispatch === 'not-dispatched' && call.facts.localCleanup === 'confirmed' && call.facts.replayAllowed))) throw new WebPolicyError('another response in this execution domain needs recovery')
    }
  }
}

export function replayReference(value: unknown): WebReplayReference | undefined {
  if (!value || typeof value !== 'object') return
  const raw = value as Partial<WebReplayReference>
  if (raw.protocol !== WEB_PROTOCOL) return
  for (const key of ['requestId', 'responseId', 'responseDigest', 'contentDigest', 'sessionId', 'executionDomainId', 'hostInvocationId', 'conversationUrl'] as const) nonempty(raw[key], key)
  if (!['main', 'compaction', 'session-title', 'one-shot'].includes(raw.kind ?? '') || !Number.isSafeInteger(raw.generation)) throw new WebPolicyError('invalid Web replay reference')
  return raw as WebReplayReference
}
