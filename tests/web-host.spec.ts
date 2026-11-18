import assert from 'node:assert/strict'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { ChatGptWebHost, webHostCapabilities, type WebHostEnvironment } from '../src/web/host.ts'
import { defaultWebSettings } from '../src/web/config.ts'
import { WEB_EFFORT, WEB_MODEL_ID, WEB_PROTOCOL } from '../src/web/policy.ts'
import { deliveryChunks } from '../src/web/chunks.ts'
import type { WebDelivery } from '../src/web/session-coordinator.ts'
import type { WebPageFactory, WebTurnRequest } from '../src/web/browser/types.ts'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'web-host-'))
  const settings = defaultWebSettings(dir)
  settings.enabled = true
  settings.connections.default!.accountFingerprint = 'a'.repeat(64)
  settings.contextPolicy = 'personalized'
  let opens = 0, submits = 0
  let failPrepare = false
  let answer = { kind: 'final', text: 'Reviewed' } as object
  const pageFactory: WebPageFactory = {
    async connect() { return { targetId: 'fixture', accountFingerprint: 'a'.repeat(64) } },
    async open(connection, request) {
      opens++
      const conversation = request.conversation ?? { id: `chat-${request.requestId}`, url: `https://chatgpt.com/c/chat-${request.requestId}` }
      const evidence = { adapter: 'chatgpt-dom/1' as const, model: 'GPT-6' as const, effort: 'Pro' as const, accountFingerprint: connection.accountFingerprint, contextPolicy: request.contextPolicy, conversationUrl: conversation.url, bindingDigest: request.bindingDigest, capturedAt: Date.now() }
      const prepare = async (_request: WebTurnRequest, beforeContainerMutation?: () => Promise<void>) => {
        if (failPrepare) { await beforeContainerMutation?.(); throw new Error('lost project creation confirmation') }
        return { conversation, evidence }
      }
      return {
        targetId: 'fixture', prepare, inspect: prepare,
        async submit() { submits++ },
        async sample() { return { conversation, userMessageId: `user-${request.requestId}`, acceptedPrompt: request.prompt, responseId: `response-${request.requestId}`, text: JSON.stringify({ protocol: WEB_PROTOCOL, requestId: request.requestId, generation: request.generation, ...answer }), stopVisible: false, thinking: false, finishedActions: true } },
        async stop() { return false }, async close() {},
      }
    },
  }
  const stopped: Parameters<NonNullable<WebHostEnvironment['blocked']>>[0][] = []
  const environment: WebHostEnvironment = { capabilities: () => ({ ...webHostCapabilities.requiredHost, recoveredResponse: 1, recoveredSummary: 1 }), activity() {}, pageFactory, blocked: input => { stopped.push(input) } }
  const create = () => new ChatGptWebHost(dir, 'chatgpt', environment, () => settings)
  return { dir, settings, environment, create, stopped, counts: () => ({ opens, submits }), answer: (value: object) => { answer = value }, failPrepare: () => { failPrepare = true }, dispose: () => rm(dir, { recursive: true, force: true }) }
}

function request(sessionId: string, text = 'Review this change'): GenerateOptions {
  return { provider: 'chatgpt', model: WEB_MODEL_ID, sessionId: sessionId as never, messages: [{ role: 'user', content: [{ type: 'text', text }] }] as unknown as GenerateOptions['messages'] }
}

async function generate(host: ChatGptWebHost, workspace: string, options: GenerateOptions): Promise<WebDelivery> {
  const sessionId = String(options.sessionId)
  const context = await host.callContext(options, 'main', { sessionId, rootSessionId: sessionId, workspace })
  context.recovery = { requestHeaderSeq: 1, surfaceSeqs: [0, 2] }
  let delivery: WebDelivery | undefined
  for await (const _chunk of host.wrap(context, async function* () {
    delivery = await host.generate(undefined, { ...options, reasoningEffort: WEB_EFFORT as never })
    yield* deliveryChunks(delivery)
  })) { /* The actual host commits only after this iterator terminates. */ }
  assert.ok(delivery)
  return delivery
}

it('keeps static discovery separate from host/account admission and never opens a browser for invalid bindings', async () => {
  const f = await fixture()
  try {
    const host = f.create()
    const status = await host.status()
    assert.equal(status.liveVerified, false)
    assert.equal(status.configured, true)
    await assert.rejects(() => host.admitBinding({ provider: 'chatgpt', model: WEB_MODEL_ID, reasoningEffort: 'max' }), /binding/)
    await assert.rejects(() => host.admitBinding({ provider: 'chatgpt', model: WEB_MODEL_ID, reasoningEffort: 'pro', requireIsolation: true }), /project-only/)
    const oldHost = new ChatGptWebHost(f.dir, 'chatgpt', { ...f.environment, capabilities: () => ({}) }, () => f.settings)
    await assert.rejects(() => oldHost.admitBinding({ provider: 'chatgpt', model: WEB_MODEL_ID, reasoningEffort: 'pro' }), /host extension/)
    const ambiguousSummaryHost = new ChatGptWebHost(f.dir, 'chatgpt', { ...f.environment, capabilities: () => ({ ...webHostCapabilities.requiredHost, summaryRoute: 1 }) }, () => f.settings)
    await assert.rejects(() => ambiguousSummaryHost.admitBinding({ provider: 'chatgpt', model: WEB_MODEL_ID, reasoningEffort: 'pro' }), /summaryRoute v2/)
    assert.deepEqual(f.counts(), { opens: 0, submits: 0 })
  } finally { await f.dispose() }
})

it('binds external host domains to physical workspaces and records non-Web descendant tool uncertainty across restart', async () => {
  const f = await fixture()
  try {
    const host = f.create()
    await host.beginInvocation({ sessionId: 'root', executionDomainId: 'flywheel:task', hostInvocationId: 'invocation', workspace: f.dir })
    await host.inheritOwner({ sessionId: 'child', rootSessionId: 'root', parentSessionId: 'root', workspace: f.dir })
    await host.toolStarted('child', 'ptc-root', 'ptc-root', 10)
    const nested = await host.toolStarted('child', 'nested', 'ptc-root', 10)
    assert.ok(nested)
    const observation = host.toolObserved(nested, true)
    await host.toolCommitted({ sessionId: 'child', rootCallId: 'ptc-root', rootCallSeq: 10, resultEventSeq: 11 }, true, false)
    await observation
    assert.ok(f.stopped.some(value => value.sessionIds.includes('child') && value.executionDomainId === 'flywheel:task'))
    const alias = `${f.dir}-alias`; await symlink(f.dir, alias, 'dir')
    try {
      const restarted = f.create()
      assert.equal(await restarted.isManagedSession('fresh-non-web', alias), true)
      await assert.rejects(() => restarted.guardSession('fresh-non-web', alias), /needs recovery/)
      await assert.rejects(() => restarted.beginInvocation({ sessionId: 'fresh', executionDomainId: 'flywheel:task', hostInvocationId: 'replacement', workspace: alias }), /unresolved/)
      await restarted.guardSession('unrelated', join(f.dir, 'unrelated'))
    } finally { await rm(alias) }
  } finally { await f.dispose() }
})

it('materializes the exact resolved Pro effort, waits for durable host ACK, and preserves unknown usage', async () => {
  const f = await fixture()
  try {
    const host = f.create()
    await host.beginInvocation({ sessionId: 'root', executionDomainId: 'domain', hostInvocationId: 'invocation', workspace: f.dir })
    const delivery = await generate(host, f.dir, request('root'))
    assert.equal(delivery.recovery?.request.reasoningEffort, 'pro')
    await assert.rejects(() => f.create().guardSession('fresh', f.dir), /recovery/)
    await assert.rejects(() => host.committed(delivery.reference, delivery.blocks, 'commit', false), /durable/)
    await assert.rejects(() => host.guardSession('fresh', f.dir), /recovery/)
    await assert.rejects(() => host.committed(delivery.reference, [], 'commit', true), /does not match/)
    await host.committed(delivery.reference, delivery.blocks, 'commit', true)
    await host.guardSession('fresh', f.dir)
    const facts = await host.invocationFacts({ sessionId: 'root', executionDomainId: 'domain', hostInvocationId: 'invocation' })
    assert.equal(facts.dispatch, 'dispatched'); assert.equal(facts.outcome, 'completed')
    assert.equal(facts.usageStatus, 'unknown'); assert.equal(facts.localCleanupConfirmed, true)
    assert.equal(deliveryChunks(delivery).some(chunk => chunk.type === 'usage'), false)
    const title = await host.callContext({ ...request('root'), purpose: 'session-title' }, 'session-title', { sessionId: 'root', rootSessionId: 'root', workspace: f.dir })
    assert.equal(title.hostInvocationId, 'invocation'); assert.equal(title.executionDomainId, 'domain')
    assert.equal(title.requireIsolation, false)
  } finally { await f.dispose() }
})

for (const child of [false, true]) {
  it(`retains every actual workspace touched by ${child ? 'an inherited child' : 'a managed root'} before non-Web tool dispatch`, async () => {
    const f = await fixture()
    try {
      const host = f.create()
      const identity = { sessionId: 'root', executionDomainId: 'moving-domain', hostInvocationId: 'moving-invocation' }
      await host.beginInvocation({ ...identity, workspace: f.dir })
      const sessionId = child ? 'child' : 'root'
      const owner = { sessionId, rootSessionId: 'root', ...(child ? { parentSessionId: 'root' } : {}) }
      await host.inheritOwner({ ...owner, workspace: f.dir })
      const moved = join(f.dir, 'moved-worktree')
      await host.inheritOwner({ ...owner, workspace: moved })
      const occurrence = await host.toolStarted(sessionId, 'non-web-write', 'non-web-write', 10)
      assert.ok(occurrence)
      await host.toolObserved(occurrence, true)
      const restarted = f.create()
      for (const workspace of [f.dir, moved]) {
        assert.equal(await restarted.isManagedSession('fresh-session', workspace), true)
        await assert.rejects(() => restarted.guardSession('fresh-session', workspace), /needs recovery/)
      }
      assert.ok(f.stopped.some(event => event.workspaces.includes(f.dir) && event.workspaces.includes(moved)), 'cancellation must include both recorded execution workspaces')
      await assert.rejects(() => restarted.inheritOwner({ ...owner, workspace: join(f.dir, 'another-worktree') }), /needs recovery/)
      assert.equal((await restarted.invocationFacts(identity)).outcome, 'unknown')
      assert.deepEqual(f.counts(), { opens: 0, submits: 0 })
    } finally { await f.dispose() }
  })
}

it('lets stable workspace ownership settle its durable tool result after restart before applying the execution guard', async () => {
  const f = await fixture()
  try {
    const host = f.create()
    const owner = { sessionId: 'root', rootSessionId: 'root', workspace: f.dir }
    await host.beginInvocation({ sessionId: 'root', executionDomainId: 'stable-domain', hostInvocationId: 'stable-invocation', workspace: f.dir })
    const occurrence = await host.toolStarted('root', 'completed-local-write', 'completed-local-write', 10)
    assert.ok(occurrence)
    await host.toolObserved(occurrence, false)
    const restarted = f.create()
    // The integration reads the original Session's durable result after this
    // no-op ownership step and only then authorizes another provider request.
    await restarted.inheritOwner(owner)
    await assert.rejects(() => restarted.guardSession('root', f.dir), /needs recovery/)
    await restarted.toolCommitted({ sessionId: 'root', rootCallId: 'completed-local-write', rootCallSeq: 10, resultEventSeq: 11 }, true, false)
    await restarted.guardSession('root', f.dir)
    assert.deepEqual(f.counts(), { opens: 0, submits: 0 })
  } finally { await f.dispose() }
})

it('does not turn an idle invocation with no response into a successful business outcome', async () => {
  const f = await fixture()
  try {
    const host = f.create()
    await host.beginInvocation({ sessionId: 'root', executionDomainId: 'domain', hostInvocationId: 'empty', workspace: f.dir, requireIsolation: true })
    await host.agentIdle('root')
    const facts = await host.invocationFacts({ sessionId: 'root', executionDomainId: 'domain', hostInvocationId: 'empty' })
    assert.equal(facts.dispatch, 'not-dispatched'); assert.equal(facts.outcome, 'failed')
    const auxiliary = await host.callContext({ ...request('root'), purpose: 'session-title' }, 'session-title', { sessionId: 'root', rootSessionId: 'root', workspace: f.dir })
    assert.equal(auxiliary.hostInvocationId, 'empty'); assert.equal(auxiliary.requireIsolation, true)
  } finally { await f.dispose() }
})

it('freezes the complete outer binding and verifies an already managed account without rewriting its profile', async () => {
  const f = await fixture()
  try {
    const host = f.create()
    await host.beginInvocation({ sessionId: 'root', executionDomainId: 'domain', hostInvocationId: 'bound', workspace: f.dir })
    const input = { sessionId: 'root', hostInvocationId: 'bound', executionDomainId: 'domain', provider: 'chatgpt', model: WEB_MODEL_ID, reasoningEffort: WEB_EFFORT }
    assert.equal((await host.admitBinding(input)).accountFingerprint, 'a'.repeat(64))
    assert.equal((await host.connect()).configured, true)
    await host.toolStarted('root', 'local-tool', 'local-tool', 10)
    await assert.rejects(() => host.configure(f.settings), /active Web calls and local tools/)
    f.settings.connections.default!.accountFingerprint = 'b'.repeat(64)
    await assert.rejects(() => host.admitBinding(input), /changed within the host invocation/)
    await assert.rejects(() => host.beginInvocation({ sessionId: 'root', executionDomainId: 'domain', hostInvocationId: 'bound', workspace: f.dir }), /changed within/)
    f.settings.connections.default!.accountFingerprint = ''
    const observed = await host.connect()
    assert.equal(observed.configurationRequired, true)
    assert.equal(observed.connection.accountFingerprint, 'a'.repeat(64))
    assert.equal(f.settings.connections.default!.accountFingerprint, '')
  } finally { await f.dispose() }
})

it('queues healthy sibling Web calls until the preceding durable ACK without changing their shared ownership', async () => {
  const f = await fixture()
  try {
    const host = f.create()
    const identity = { sessionId: 'root', executionDomainId: 'domain', hostInvocationId: 'siblings' }
    await host.beginInvocation({ ...identity, workspace: f.dir, deadlineMs: Date.now() + 10_000 })
    for (const sessionId of ['first', 'second']) await host.inheritOwner({ sessionId, rootSessionId: 'root', parentSessionId: 'root', workspace: f.dir })
    const first = generate(host, f.dir, request('first'))
    for (let attempts = 0; f.counts().opens === 0 && attempts < 200; attempts++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(f.counts().opens, 1)
    const second = generate(host, f.dir, request('second'))
    const captured = await first
    assert.equal(captured.reference.hostInvocationId, 'siblings')
    assert.equal(f.counts().submits, 1)
    assert.equal((await host.invocationFacts(identity)).outcome, 'unknown')
    await host.committed(captured.reference, captured.blocks, 'first-commit', true)
    const next = await second
    assert.equal(next.reference.hostInvocationId, 'siblings')
    assert.equal(next.reference.executionDomainId, 'domain')
    await host.committed(next.reference, next.blocks, 'second-commit', true)
    assert.equal(f.counts().submits, 2)
  } finally { await f.dispose() }
})

it('recovers immutable captured content after host restart without reopening the browser or resending', async () => {
  const f = await fixture()
  try {
    const host = f.create()
    const delivery = await generate(host, f.dir, request('root'))
    const before = f.counts()
    const restarted = f.create()
    await restarted.recover(delivery.reference.requestId)
    await restarted.authorizeRecovery(delivery.reference, deliveryChunks(delivery))
    await assert.rejects(() => restarted.authorizeRecovery(delivery.reference, [{ type: 'text-delta', index: 0, text: 'forged' }]), /content differs/)
    await restarted.committed(delivery.reference, delivery.blocks, 'recovered-commit', true)
    await restarted.guardSession('fresh', f.dir)
    assert.deepEqual(f.counts(), before)
  } finally { await f.dispose() }
})

it('does not adopt a captured answer while another local tool outcome is unsettled', async () => {
  const f = await fixture()
  try {
    const host = f.create()
    await host.beginInvocation({ sessionId: 'root', executionDomainId: 'domain', hostInvocationId: 'invocation', workspace: f.dir })
    const delegation = await host.toolStarted('root', 'delegation', 'delegation', 10)
    assert.ok(delegation)
    const delivery = await generate(host, f.dir, request('root'))
    await assert.rejects(() => host.authorizeRecovery(delivery.reference), /unresolved local tool/)
    await host.toolObserved(delegation, false)
    await host.toolCommitted({ sessionId: 'root', rootCallId: 'delegation', rootCallSeq: 10, resultEventSeq: 11 }, true, false)
    await host.authorizeRecovery(delivery.reference)
  } finally { await f.dispose() }
})

it('keeps an uncertain project mutation fenced even when no prompt was sent and local resources were released', async () => {
  const f = await fixture()
  try {
    f.failPrepare()
    const host = f.create()
    await host.beginInvocation({ sessionId: 'root', executionDomainId: 'domain', hostInvocationId: 'invocation', workspace: f.dir })
    await assert.rejects(() => generate(host, f.dir, request('root')), /project creation/)
    const facts = await host.invocationFacts({ sessionId: 'root', executionDomainId: 'domain', hostInvocationId: 'invocation' })
    assert.equal(facts.dispatch, 'not-dispatched')
    assert.equal(facts.localCleanupConfirmed, true)
    assert.equal(facts.outcome, 'unknown')
    await assert.rejects(() => f.create().guardSession('fresh', f.dir), /recovery/)
    assert.equal(f.counts().submits, 0)
  } finally { await f.dispose() }
})
