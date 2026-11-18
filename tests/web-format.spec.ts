import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { defaultWebSettings } from '../src/web/config.ts'
import { ChatGptWebHost, webHostCapabilities } from '../src/web/host.ts'
import { WebSessionCoordinator, type WebCallContext } from '../src/web/session-coordinator.ts'
import { WebTransport } from '../src/web/transport.ts'
import { BrowserStore } from '../src/web/browser/storage.ts'
import { WEB_PROTOCOL } from '../src/web/policy.ts'
import type { WebFacts, WebPageFactory, WebTurnRequest } from '../src/web/browser/types.ts'

const tool = { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }
const action = { kind: 'tool_calls', calls: [{ id: 'read', name: 'read_file', arguments: { path: 'src/main.ts' } }] }
function envelope(request: WebTurnRequest, answer: object = action): string {
  const identity = JSON.parse(request.prompt) as { requestId: string }
  return JSON.stringify({ protocol: WEB_PROTOCOL, requestId: identity.requestId, generation: request.generation, ...answer })
}
const fenced = (text: string) => `\`\`\`json\n${text}\n\`\`\``

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'web-format-'))
  const settings = defaultWebSettings(dir)
  settings.enabled = true
  settings.contextPolicy = 'personalized'
  settings.connections.default!.accountFingerprint = 'a'.repeat(64)
  let response = (request: WebTurnRequest) => request.repairOf ? envelope(request) : fenced(envelope(request))
  let uncertainRepair = false
  let failAfterCapture = false
  let submits = 0, captures = 0
  const requests: WebTurnRequest[] = []
  const texts = new Map<string, string>()
  const reports: WebFacts[] = []
  const pages: WebPageFactory = {
    async connect() { return { targetId: 'fixture', accountFingerprint: 'a'.repeat(64) } },
    async open(connection, request) {
      const conversation = request.conversation ?? { id: `chat-${request.requestId}`, url: `https://chatgpt.com/c/chat-${request.requestId}` }
      const evidence = { adapter: 'chatgpt-dom/1' as const, model: 'GPT-6' as const, effort: 'Pro' as const, accountFingerprint: connection.accountFingerprint, contextPolicy: request.contextPolicy, conversationUrl: conversation.url, bindingDigest: request.bindingDigest, capturedAt: Date.now() }
      const prepare = async () => ({ conversation, evidence })
      return {
        targetId: `tab-${request.requestId}`, prepare, inspect: prepare,
        async submit() {
          requests.push(request); submits++
          texts.set(request.requestId, response(request))
          if (request.repairOf && uncertainRepair) throw new Error('lost correction send acknowledgement')
        },
        async sample() {
          return { conversation, userMessageId: `user-${request.requestId}`, responseId: `response-${request.requestId}`, acceptedPrompt: request.prompt,
            text: request.repairOf && uncertainRepair ? '' : texts.get(request.requestId) ?? '',
            stopVisible: Boolean(request.repairOf && uncertainRepair), thinking: false, finishedActions: !(request.repairOf && uncertainRepair) }
        },
        async stop() { return false }, async close() {},
      }
    },
  }
  const transport = new WebTransport(settings.connections.default!, { pageFactory: pages })
  const report = async (_context: WebCallContext, _id: string, facts: WebFacts) => {
    reports.push(structuredClone(facts))
    if (facts.outcome === 'captured' && ++captures === 2 && failAfterCapture) throw new Error('simulated crash after correction capture')
  }
  const create = () => new WebSessionCoordinator(dir, transport, report, () => {})
  const request: GenerateOptions = { provider: 'chatgpt', model: 'gpt-6-pro-web', reasoningEffort: 'pro' as never, sessionId: 's1' as never,
    tools: [tool], messages: [{ role: 'user', content: [{ type: 'text', text: 'Read src/main.ts and review it' }] }] as unknown as GenerateOptions['messages'] }
  const context = (): WebCallContext => ({ kind: 'main', sessionId: 's1', executionDomainId: 'workspace', hostInvocationId: 'invocation', deadlineMs: Date.now() + 30_000, requireIsolation: false, active: true, rawOptions: request, recovery: { requestHeaderSeq: 1, surfaceSeqs: [0, 2] } })
  return { dir, settings, transport, create, pages, request, context, requests, reports, counts: () => ({ submits }),
    response: (fn: typeof response) => { response = fn }, unknown: () => { uncertainRepair = true }, crashAfterCapture: () => { failAfterCapture = true }, dispose: () => rm(dir, { recursive: true, force: true }) }
}

test('a bounded correction preserves tool arguments, logical identity, original deadline and artifacts before host ACK', async () => {
  const f = await fixture()
  try {
    const coordinator = f.create(), context = f.context()
    const delivery = await coordinator.run(context, f.settings)
    assert.equal(f.requests.length, 2)
    const [first, second] = f.requests
    assert.equal(second!.deadlineMs, first!.deadlineMs)
    assert.equal(second!.repairOf?.requestId, first!.requestId)
    assert.equal(second!.conversation?.url, delivery.transportResult.conversation.url)
    assert.equal('media' in second!, false)
    const correction = JSON.parse(second!.prompt)
    assert.equal(correction.purpose, 'format-repair')
    assert.equal(correction.messages, undefined)
    assert.equal(delivery.reference.requestId, first!.requestId)
    assert.equal(delivery.transportResult.requestId, second!.requestId)
    assert.equal(delivery.blocks[0]!.id, `${first!.requestId}_read`)
    assert.equal(delivery.blocks[0]!.arguments, '{"path":"src/main.ts"}')
    const store = await BrowserStore.open(f.settings.connections.default!)
    const original = (await store.get(first!.requestId))!
    assert.equal(original.phase, 'format-repair')
    assert.equal(original.hostCommitId, undefined)
    assert.ok((await readFile(original.artifact!.path, 'utf8')).startsWith('```json'))
    await assert.rejects(() => f.transport.acknowledge(first!.requestId, { hostCommitId: 'fake', responseDigest: original.artifact!.sha256 }), /Host ACK/)
    await coordinator.acknowledge(delivery.reference, delivery.blocks, 'durable-assistant')
    assert.equal((await store.get(second!.requestId))!.hostCommitId, 'durable-assistant')
    assert.equal((await store.get(first!.requestId))!.hostCommitId, undefined)
    f.response(request => envelope(request, { kind: 'final', text: 'Done' }))
    const next = await coordinator.run(f.context(), f.settings)
    assert.equal(next.reference.generation, 2, 'authoritative history restarts after a correction')
    assert.equal(f.requests[2]!.conversation, undefined)
  } finally { await f.dispose() }
})

test('a correction cannot change a tool argument; explicit digest-bound discard preserves failure and unlocks capacity', async () => {
  const f = await fixture()
  try {
    f.response(request => request.repairOf ? envelope(request, { kind: 'tool_calls', calls: [{ id: 'read', name: 'read_file', arguments: { path: 'secret.txt' } }] }) : fenced(envelope(request)))
    const coordinator = f.create()
    await assert.rejects(() => coordinator.run(f.context(), f.settings), /changed the captured answer/)
    const id = f.requests[0]!.requestId
    assert.equal(await coordinator.delivery(id), undefined)
    const observed = await f.create().recover(id)
    assert.ok(observed.rejection)
    await assert.rejects(() => coordinator.retire(id, '0'.repeat(64)), /inspected/)
    const retired = await coordinator.retire(id, observed.rejection.responseDigest)
    const store = await BrowserStore.open(f.settings.connections.default!)
    const journal = (await store.get(retired.transportRequestId))!
    assert.equal(journal.phase, 'retired')
    assert.equal(journal.hostCommitId, undefined)
    assert.equal(journal.facts.outcome, 'captured')
    assert.equal(journal.facts.usage, 'unknown')
    assert.equal(journal.facts.replayAllowed, false)
    assert.deepEqual((await f.create().recover(id)).retired, retired)
    assert.equal(f.requests.length, 2, 'inspection and discard send no new prompt')
    f.response(request => envelope(request, { kind: 'final', text: 'A new explicit task' }))
    const next = await coordinator.run(f.context(), f.settings)
    assert.equal(next.reference.generation, 2)
  } finally { await f.dispose() }
})

test('a correction whose submit is unknown remains fenced across restart and cannot be discarded', async () => {
  const f = await fixture()
  try {
    f.unknown()
    await assert.rejects(() => f.create().run(f.context(), f.settings), /lost correction/)
    const id = f.requests[0]!.requestId
    const recovered = await f.create().recover(id)
    assert.equal(recovered.result, undefined)
    assert.equal(recovered.facts.dispatch, 'unknown')
    assert.equal(recovered.facts.replayAllowed, false)
    await assert.rejects(() => f.create().retire(id, '0'.repeat(64)), /complete rejected/)
    await assert.rejects(() => f.create().run(f.context(), f.settings), /acknowledgement/)
    assert.equal(f.requests.length, 2)
  } finally { await f.dispose() }
})

test('a restart after capacity transfer before correction dispatch can inspect and retire the original rejection without replay', async () => {
  const f = await fixture()
  try {
    const release = f.transport.releaseForRepair.bind(f.transport)
    f.transport.releaseForRepair = async (...args) => { await release(...args); throw new Error('crash after capacity transfer') }
    await assert.rejects(() => f.create().run(f.context(), f.settings), /crash after capacity/)
    const id = f.requests[0]!.requestId
    const observed = await f.create().recover(id)
    assert.ok(observed.rejection)
    await f.create().retire(id, observed.rejection.responseDigest)
    assert.equal(f.requests.length, 1)
    f.response(request => envelope(request, { kind: 'final', text: 'New task' }))
    await f.create().run(f.context(), f.settings)
    assert.equal(f.requests.length, 2)
  } finally { await f.dispose() }
})

test('captured correction survives a delivery interruption and is recovered exactly once without another send', async () => {
  const f = await fixture()
  try {
    f.crashAfterCapture()
    await assert.rejects(() => f.create().run(f.context(), f.settings), /simulated crash/)
    const id = f.requests[0]!.requestId
    const coordinator = f.create()
    await coordinator.recover(id)
    const delivery = (await coordinator.delivery(id))!
    assert.ok(delivery)
    assert.equal(delivery.transportResult.requestId, f.requests[1]!.requestId)
    await coordinator.acknowledge(delivery.reference, delivery.blocks, 'recovered-host-commit')
    await coordinator.recover(id)
    assert.equal(f.requests.length, 2)
    await assert.rejects(() => coordinator.retire(id, delivery.reference.responseDigest), /complete rejected/)
  } finally { await f.dispose() }
})

test('disabled correction, semantic rejection, cancellation and byte limits do not dispatch a correction', async () => {
  for (const mode of ['disabled', 'semantic', 'cancelled', 'oversized', 'turn-limit'] as const) {
    const f = await fixture()
    try {
      const context = f.context()
      if (mode === 'disabled') f.settings.budget.maxFormatRepairs = 0
      if (mode === 'turn-limit') f.settings.budget.maxTurns = 1
      if (mode === 'semantic') f.response(request => envelope(request, { kind: 'tool_calls', calls: [{ id: 'read', name: 'forbidden', arguments: {} }] }))
      if (mode === 'cancelled') {
        const original = f.transport.run.bind(f.transport)
        f.transport.run = async request => { const result = await original(request); context.active = false; return result }
      }
      if (mode === 'oversized') f.response(() => 'x'.repeat(70_000))
      await assert.rejects(() => f.create().run(context, f.settings))
      assert.equal(f.requests.length, 1, mode)
    } finally { await f.dispose() }
  }
})

test('host discard requires an explicit inspected rejection, preserves failed outcome across restart and does not fake a commit', async () => {
  const f = await fixture()
  try {
    f.settings.budget.maxFormatRepairs = 0
    const environment = { capabilities: () => ({ ...webHostCapabilities.requiredHost }), activity() {}, pageFactory: f.pages }
    const make = () => new ChatGptWebHost(f.dir, 'chatgpt', environment, () => f.settings)
    const host = make()
    await host.beginInvocation({ sessionId: 's1', executionDomainId: 'domain', hostInvocationId: 'host', workspace: f.dir })
    const context = await host.callContext(f.request, 'main', { sessionId: 's1', rootSessionId: 's1', workspace: f.dir })
    await assert.rejects(async () => {
      for await (const _ of host.wrap(context, async function* () { await host.generate(undefined, f.request); yield { type: 'finish' } as never })) { /* no chunks before admission */ }
    })
    const id = f.requests[0]!.requestId
    const observed = await host.recover(id) as { rejection: { responseDigest: string } }
    await assert.rejects(() => host.retire(id, observed.rejection.responseDigest, ''), /explicit discard/)
    await assert.rejects(() => make().guardSession('fresh', f.dir), /recovery/)
    const result = await host.retire(id, observed.rejection.responseDigest, 'discard-rejected-response') as { outcome: string }
    assert.equal(result.outcome, 'failed')
    const restarted = make()
    await restarted.guardSession('fresh', f.dir)
    const facts = await restarted.invocationFacts({ sessionId: 's1', executionDomainId: 'domain', hostInvocationId: 'host' })
    assert.equal(facts.outcome, 'failed')
    assert.equal(facts.usageStatus, 'unknown')
    assert.equal(facts.invocations[0]!.committed, false)
    assert.ok(facts.invocations[0]!.retired)
    await assert.rejects(() => restarted.recover(id, true), /discarded/)
    await restarted.retire(id, observed.rejection.responseDigest, 'discard-rejected-response')
    assert.equal(f.requests.length, 1)
  } finally { await f.dispose() }
})

test('plain final prose is wrapped unchanged and a malformed correction exhausts its explicit attempt limit', async () => {
  const f = await fixture()
  try {
    const text = 'The review is complete.\nNo files were modified.'
    f.response(request => request.repairOf ? envelope(request, { kind: 'final', text }) : text)
    const coordinator = f.create()
    const delivery = await coordinator.run(f.context(), f.settings)
    assert.deepEqual(delivery.blocks, [{ type: 'text', text }])
    await coordinator.acknowledge(delivery.reference, delivery.blocks, 'plain-final')
    f.settings.budget.maxFormatRepairs = 2
    f.response(request => request.repairOf ? 'still not an envelope' : fenced(envelope(request)))
    await assert.rejects(() => coordinator.run(f.context(), f.settings), /invalid JSON/)
    assert.equal(f.requests.length, 5, 'two task turns and exactly three configured correction turns')
    const root = f.requests[2]!
    assert.equal(f.requests[3]!.deadlineMs, root.deadlineMs)
    assert.equal(f.requests[4]!.deadlineMs, root.deadlineMs)
    assert.equal(f.requests[4]!.repairOf?.requestId, f.requests[3]!.requestId)
    const observed = await f.create().recover(root.requestId)
    assert.ok(observed.rejection)
    await f.create().retire(root.requestId, observed.rejection.responseDigest)
    assert.equal(f.requests.length, 5)
  } finally { await f.dispose() }
})

test('discard refuses another unresolved tool and cannot discard a response already exposed to the host', async () => {
  const f = await fixture()
  try {
    const environment = { capabilities: () => ({ ...webHostCapabilities.requiredHost }), activity() {}, pageFactory: f.pages }
    const host = new ChatGptWebHost(f.dir, 'chatgpt', environment, () => f.settings)
    await host.beginInvocation({ sessionId: 's1', executionDomainId: 'domain', hostInvocationId: 'host', workspace: f.dir })
    f.settings.budget.maxFormatRepairs = 0
    // The plugin freezes settings at beginInvocation, so build a fresh owner
    // after configuring this fixture's policy.
    const host2 = new ChatGptWebHost(join(f.dir, 'second'), 'chatgpt', environment, () => f.settings)
    await host2.beginInvocation({ sessionId: 's1', executionDomainId: 'domain2', hostInvocationId: 'host2', workspace: join(f.dir, 'second') })
    await host2.toolStarted('s1', 'earlier-pending-tool', 'earlier-pending-tool', 10)
    const context = await host2.callContext(f.request, 'main', { sessionId: 's1', rootSessionId: 's1', workspace: join(f.dir, 'second') })
    await assert.rejects(async () => {
      for await (const _ of host2.wrap(context, async function* () { await host2.generate(undefined, f.request); yield { type: 'finish' } as never })) { /* none */ }
    })
    const observed = await host2.recover(f.requests[0]!.requestId) as { rejection: { responseDigest: string } }
    await assert.rejects(() => host2.retire(f.requests[0]!.requestId, observed.rejection.responseDigest, 'discard-rejected-response'), /unresolved local tool/)
    await host2.toolCommitted({ sessionId: 's1', rootCallId: 'earlier-pending-tool', rootCallSeq: 10, resultEventSeq: 11 }, true, false)
    await host2.retire(f.requests[0]!.requestId, observed.rejection.responseDigest, 'discard-rejected-response')
    f.response(request => envelope(request, { kind: 'final', text: 'Valid answer' }))
    const coordinator = f.create()
    const delivery = await coordinator.run(f.context(), f.settings)
    await assert.rejects(() => coordinator.retire(delivery.reference.requestId, delivery.reference.responseDigest), /complete rejected/)
  } finally { await f.dispose() }
})

test('an actual process exit after repair transfer is recovered from disk without replay and releases only its own capacity', async () => {
  const f = await fixture()
  try {
    const code = `
      import { WebSessionCoordinator } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/web/session-coordinator.ts')).href)};
      import { WebTransport } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/web/transport.ts')).href)};
      const { dir, settings, options } = JSON.parse(process.env.WEB_FORMAT_CASE);
      const pages = {
        async connect() { return { targetId: 'crash-tab' }; },
        async open(connection, request) {
          const conversation = { id: 'crashed-chat', url: 'https://chatgpt.com/c/crashed-chat' };
          const evidence = { adapter: 'chatgpt-dom/1', model: 'GPT-6', effort: 'Pro', accountFingerprint: connection.accountFingerprint, contextPolicy: request.contextPolicy, conversationUrl: conversation.url, bindingDigest: request.bindingDigest, capturedAt: Date.now() };
          const value = JSON.stringify({ protocol: 'dsh-chatgpt-web/1', requestId: request.requestId, generation: request.generation, kind: 'final', text: 'Original result' });
          const fence = String.fromCharCode(96).repeat(3);
          return { targetId: 'crash-tab', async prepare() { return { conversation, evidence }; }, async inspect() { return { conversation, evidence }; }, async submit() {}, async stop() { return false; }, async close() {},
            async sample() { return { conversation, userMessageId: 'crash-user', responseId: 'crash-response', acceptedPrompt: request.prompt, text: fence + 'json\\n' + value + '\\n' + fence, stopVisible: false, thinking: false, finishedActions: true }; } };
        }
      };
      const transport = new WebTransport(settings.connections.default, { pageFactory: pages });
      const original = transport.releaseForRepair.bind(transport);
      transport.releaseForRepair = async (requestId, value) => { await original(requestId, value); await new Promise(() => process.stdout.write(requestId + '\\n', () => process.exit(23))); };
      const coordinator = new WebSessionCoordinator(dir, transport, async () => {}, () => {});
      await coordinator.run({ kind: 'main', sessionId: 's1', executionDomainId: 'workspace', hostInvocationId: 'invocation', deadlineMs: Date.now() + 15000, requireIsolation: false, active: true, rawOptions: options }, settings);
    `
    const child = spawn(process.execPath, ['--input-type=module', '--eval', code], { env: { ...process.env, WEB_FORMAT_CASE: JSON.stringify({ dir: f.dir, settings: f.settings, options: f.request }) }, stdio: ['ignore', 'pipe', 'pipe'], signal: AbortSignal.timeout(15000) })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += String(data) })
    child.stderr.on('data', data => { stderr += String(data) })
    const [status] = await once(child, 'close')
    assert.equal(status, 23, stderr)
    const id = stdout.trim()
    assert.match(id, /^[a-f0-9-]{36}$/)
    const recovered = await f.create().recover(id)
    assert.ok(recovered.rejection)
    assert.equal(f.requests.length, 0, 'recovering a terminal parent does not open or submit a correction')
    await f.create().retire(id, recovered.rejection.responseDigest)
    f.response(request => envelope(request, { kind: 'final', text: 'Explicit follow-up' }))
    await f.create().run(f.context(), f.settings)
    assert.equal(f.requests.length, 1)
  } finally { await f.dispose() }
})

test('a captured rejection whose historical dispatch is unknown cannot be retired as a confirmed failed invocation', async () => {
  const f = await fixture()
  try {
    f.settings.budget.maxFormatRepairs = 0
    await assert.rejects(() => f.create().run(f.context(), f.settings))
    const id = f.requests[0]!.requestId
    const store = await BrowserStore.open(f.settings.connections.default!)
    const journal = (await store.get(id))!
    journal.facts.dispatch = 'unknown'
    await store.put(journal)
    const observed = await f.create().recover(id)
    assert.ok(observed.rejection)
    assert.equal(observed.facts.dispatch, 'unknown')
    await assert.rejects(() => f.create().retire(id, observed.rejection!.responseDigest), /confirmed dispatch/)
    assert.equal((await store.get(id))!.phase, 'captured')
    assert.equal(f.requests.length, 1)
  } finally { await f.dispose() }
})
