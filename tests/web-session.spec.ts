import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { WebSessionCoordinator, type WebCallContext, type WebTransportPort } from '../src/web/session-coordinator.ts'
import type { WebFacts, WebTurnRequest, WebTurnResult } from '../src/web/browser/types.ts'
import { defaultWebSettings } from '../src/web/config.ts'
import { WEB_EFFORT, WEB_MODEL_ID, WEB_PROTOCOL } from '../src/web/policy.ts'

class TransportFixture implements WebTransportPort {
  requests: WebTurnRequest[] = []
  results = new Map<string, WebTurnResult>()
  acknowledgements: string[] = []
  answer: (request: WebTurnRequest) => object = () => ({ kind: 'final', text: 'Result' })
  async run(request: WebTurnRequest): Promise<WebTurnResult> {
    this.requests.push(request)
    const text = JSON.stringify({ protocol: WEB_PROTOCOL, requestId: request.requestId, generation: request.generation, ...this.answer(request) })
    const conversation = request.conversation ?? { id: `c-${request.generation}`, url: `https://chatgpt.com/c/c-${request.generation}` }
    const result: WebTurnResult = {
      requestId: request.requestId, text, responseId: `response-${request.requestId}`, conversation,
      artifact: { path: '/private/fixture.txt', bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') },
      facts: { dispatch: 'confirmed', outcome: 'captured', localCleanup: 'confirmed', remoteGeneration: 'completed', usage: 'unknown', replayAllowed: false },
      evidence: { adapter: 'chatgpt-dom/1', model: 'GPT-6', effort: 'Pro', accountFingerprint: 'a'.repeat(64), contextPolicy: request.contextPolicy, conversationUrl: conversation.url, capturedAt: Date.now(), bindingDigest: request.bindingDigest },
    }
    this.results.set(request.requestId, result)
    return result
  }
  async acknowledge(requestId: string, receipt: { hostCommitId: string; responseDigest: string }): Promise<void> {
    assert.equal(receipt.responseDigest, this.results.get(requestId)?.artifact.sha256)
    this.acknowledgements.push(requestId)
  }
  async recover(requestId: string) { const result = this.results.get(requestId)!; return { requestId, facts: result.facts, result } }
}

function options(messages: unknown[]): GenerateOptions {
  return { provider: 'chatgpt', model: WEB_MODEL_ID, reasoningEffort: WEB_EFFORT as never, sessionId: 's1' as never, messages: messages as GenerateOptions['messages'] }
}
function context(request: GenerateOptions, kind: WebCallContext['kind'] = 'main'): WebCallContext {
  return { kind, sessionId: 's1', executionDomainId: 'workspace1', hostInvocationId: 'host1', deadlineMs: Date.now() + 10000, requireIsolation: true, active: true, rawOptions: request, recovery: { requestHeaderSeq: 1, surfaceSeqs: [0, 2] } }
}

it('uses one conversation for tool loops, appends only new content and migrates edited prefixes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-session-'))
  try {
    const transport = new TransportFixture()
    const coordinator = new WebSessionCoordinator(dir, transport, async () => {}, () => {})
    const settings = defaultWebSettings(dir); settings.enabled = true; settings.connections.default!.accountFingerprint = 'a'.repeat(64)
    const initial = { role: 'user', content: [{ type: 'text', text: 'Read and review main.ts' }] }
    const request = options([initial]); request.tools = [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]
    transport.answer = () => ({ kind: 'tool_calls', calls: [{ id: 'call1', name: 'read_file', arguments: { path: 'main.ts' } }] })
    const first = await coordinator.run(context(request), settings)
    await assert.rejects(() => coordinator.run(context(request), settings), /acknowledgement/)
    await assert.rejects(() => coordinator.acknowledge(first.reference, [], 'commit1'), /does not match/)
    await coordinator.acknowledge(first.reference, first.blocks, 'commit1')
    const tool = { role: 'tool', toolCallId: first.blocks[0]!.id, content: [{ type: 'text', text: 'export const x = 1' }] }
    const secondRequest = { ...request, messages: [initial, { role: 'assistant', content: first.blocks }, tool] } as unknown as GenerateOptions
    transport.answer = () => ({ kind: 'final', text: 'Reviewed' })
    const second = await coordinator.run(context(secondRequest), settings)
    const sent = JSON.parse(transport.requests[1]!.prompt)
    assert.equal(sent.history, 'append-only-delta')
    assert.deepEqual(sent.messages, [tool])
    assert.deepEqual(sent.toolIdentities, [{ hostCallId: first.blocks[0]!.id, providerCallId: 'call1', requestId: first.reference.requestId }])
    assert.equal(transport.requests[1]!.conversation?.id, 'c-1')
    await coordinator.acknowledge(second.reference, second.blocks, 'commit2')
    const edited = { ...request, messages: [{ ...initial, content: [{ type: 'text', text: 'A changed authoritative request' }] }] } as unknown as GenerateOptions
    const third = await coordinator.run(context(edited), settings)
    assert.equal(third.reference.generation, 2)
    assert.equal(JSON.parse(transport.requests[2]!.prompt).history, 'authoritative-bootstrap')
    assert.equal(transport.requests[2]!.conversation, undefined)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('reconstructs a validated delivery after capture-before-delivery crash without resending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-recovery-'))
  try {
    const transport = new TransportFixture()
    let reports = 0
    const coordinator = new WebSessionCoordinator(dir, transport, async () => { if (++reports === 2) throw new Error('simulated host journal interruption') }, () => {})
    const settings = defaultWebSettings(dir); settings.enabled = true; settings.connections.default!.accountFingerprint = 'a'.repeat(64)
    await assert.rejects(() => coordinator.run(context(options([{ role: 'user', content: [{ type: 'text', text: 'Review' }] }])), settings), /interruption/)
    const id = transport.requests[0]!.requestId
    assert.equal(await coordinator.delivery(id), undefined)
    await coordinator.recover(id)
    const delivery = await coordinator.delivery(id)
    assert.ok(delivery)
    assert.equal(delivery.recovery?.requestHeaderSeq, 1)
    await coordinator.recover(id)
    await coordinator.acknowledge(delivery.reference, delivery.blocks, 'recovered-commit')
    assert.equal(transport.requests.length, 1)
    assert.equal(transport.acknowledgements.length, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('reconciles a preparation interrupted before transport with positive no-dispatch evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-prepared-'))
  try {
    const transport = new TransportFixture()
    let requestId = '', failed = false
    const coordinator = new WebSessionCoordinator(dir, transport, async (_context, id) => {
      requestId = id
      if (!failed) { failed = true; throw new Error('simulated host-index interruption') }
    }, () => {})
    const settings = defaultWebSettings(dir); settings.enabled = true; settings.connections.default!.accountFingerprint = 'a'.repeat(64)
    await assert.rejects(() => coordinator.run(context(options([{ role: 'user', content: [{ type: 'text', text: 'Review' }] }])), settings), /interruption/)
    const recovered = await coordinator.recover(requestId)
    assert.equal(recovered.facts.dispatch, 'not-dispatched')
    assert.equal(recovered.facts.replayAllowed, true)
    assert.equal(recovered.facts.localCleanup, 'confirmed')
    assert.equal(transport.requests.length, 0)
    const next = await coordinator.run(context(options([{ role: 'user', content: [{ type: 'text', text: 'Continue' }] }])), settings)
    assert.equal(next.reference.generation, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('keeps auxiliary conversations isolated and refuses oversized or media inputs before browser dispatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-auxiliary-'))
  try {
    const transport = new TransportFixture()
    const coordinator = new WebSessionCoordinator(dir, transport, async (_context, _requestId, facts: WebFacts) => { assert.equal(facts.usage, 'unknown') }, () => {})
    const settings = defaultWebSettings(dir); settings.enabled = true; settings.connections.default!.accountFingerprint = 'a'.repeat(64)
    const request = options([{ role: 'user', content: [{ type: 'text', text: 'Summarize' }] }]); request.purpose = 'compaction'
    const first = await coordinator.run(context(request, 'compaction'), settings)
    await coordinator.acknowledge(first.reference, first.blocks, 'summary1')
    const second = await coordinator.run(context(request, 'compaction'), settings)
    assert.notEqual(first.conversationKey, second.conversationKey)
    assert.equal(transport.requests[1]!.conversation, undefined)
    const count = transport.requests.length
    await assert.rejects(() => coordinator.run(context(options([{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(100000) }] }])), settings), /budget/)
    await assert.rejects(() => coordinator.run(context(options([{ role: 'user', content: [{ type: 'image', attachment: {} }] }])), settings), /media/)
    assert.equal(transport.requests.length, count)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
