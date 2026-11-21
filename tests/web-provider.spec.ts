import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { test, type TestContext } from 'node:test'
import { WebProvider, type WebProviderOptions, type WebRuntime } from '../src/web-provider.ts'
import { createResponse, validatePageResponse, validateRequest } from '../src/web-bridge/protocol.ts'
import { WebBridgeError, type WebBinding, type WebRequest } from '../src/web-bridge/contracts.ts'
import type { WebGenerateOptions } from '../src/web-bridge/request.ts'
import type { WebRuntimeStatus } from '../src/web-runtime/types.ts'

const binding: WebBinding = { protocolVersion: 1, installationId: 'install', provider: 'chatgpt', profileId: 'profile', accountBinding: 'account' }
function input(): WebGenerateOptions { return { provider: 'chatgpt', model: 'gpt-6-pro-web', sessionId: 'session',
  messages: [{ id: 'stable-user', role: 'user', content: [{ type: 'text', text: 'original' }] }] } }
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const value of source) result.push(value); return result }

async function fixture(t: TestContext, patch: Partial<WebProviderOptions> = {}) {
  let runtimeStatus: WebRuntimeStatus = { phase: 'ready', enabled: true, ready: true, issues: [], binding, account: 'owner@example.test' }
  const requests: WebRequest[] = []
  let posted = 0, registrations = 0, releases = 0, connectionCalls = 0, runtimeDisposals = 0
  let heartbeatFails = false
  let releaseFails = false
  let holdTurns = false
  let firstPost!: () => void
  const postedOnce = new Promise<void>(resolve => { firstPost = resolve })
  let transport = 'browser'
  let replyInstance = 'instance'
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/health') { response.end(JSON.stringify({ ...binding, instanceId: replyInstance, transport })); return }
    if (request.url === '/v1/clients') { registrations++; response.end(JSON.stringify({ clientLeaseId: `client-${registrations}`, expiresAt: Date.now() + 60 })); return }
    if (request.url?.endsWith('/heartbeat')) {
      if (heartbeatFails) { response.writeHead(403).end(JSON.stringify({ error: { code: 'WEB_LEASE_EXPIRED', message: 'Lease expired' } })); return }
      response.end(JSON.stringify({ clientLeaseId: request.headers['x-web-client-lease'], expiresAt: Date.now() + 60 })); return
    }
    if (request.method === 'DELETE') {
      releases++
      if (releaseFails) response.writeHead(403).end(JSON.stringify({ error: { code: 'WEB_LEASE_EXPIRED', message: 'Lease expired before release' } }))
      else response.end('{}')
      return
    }
    let data = ''; for await (const chunk of request) data += String(chunk)
    if (request.url !== '/v1/turns') { response.end('{}'); return }
    posted++
    const value = validateRequest(JSON.parse(data), binding)
    requests.push(value)
    firstPost()
    if (holdTurns) return
    const turnId = `turn-${value.idempotencyKey.slice(7)}`
    const result = createResponse(value, turnId, 'generation', validatePageResponse({ version: 1, complete: true,
      blocks: [{ type: 'text', text: 'complete' }] }, value, turnId))
    response.setHeader('content-type', 'text/event-stream')
    response.end(`event: response\ndata: ${JSON.stringify(result)}\n\nevent: finish\ndata: ${JSON.stringify({ state: 'completed', turnId, reason: result.finishReason, responseDigest: result.receipt.responseDigest })}\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const runtime: WebRuntime = {
    async status() { return runtimeStatus }, async setup() { return runtimeStatus }, async verify() { return runtimeStatus },
    async setEnabled(enabled) { runtimeStatus = { ...runtimeStatus, enabled }; return runtimeStatus },
    async connection() { connectionCalls++; return { url: `http://127.0.0.1:${address.port}`, token: 'a'.repeat(43), binding, instanceId: 'instance' } },
    async listTurns() { return [] }, async inspectTurn() { throw Error('unused') }, async recoverTurn() { throw Error('unused') },
    async discardTurn() { throw Error('unused') }, async dispose() { runtimeDisposals++ },
  }
  const provider = new WebProvider({ provider: 'chatgpt', runtime, contextBudget: () => 32_768, ...patch })
  t.after(async () => { await provider.dispose().catch(() => {}); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) })
  return { provider, runtime, requests, setStatus: (value: Partial<WebRuntimeStatus>) => { runtimeStatus = { ...runtimeStatus, ...value } },
    setHeartbeatFailure: (value: boolean) => { heartbeatFails = value }, setTransport: (value: string) => { transport = value },
    setReleaseFailure: (value: boolean) => { releaseFails = value }, holdTurns: () => { holdTurns = true }, postedOnce,
    setInstance: (value: string) => { replyInstance = value }, get posted() { return posted }, get registrations() { return registrations },
    get releases() { return releases }, get connections() { return connectionCalls }, get runtimeDisposals() { return runtimeDisposals } }
}

test('Web readiness is live, explicit, Pro-only and has no invented token usage or output limit', async t => {
  const f = await fixture(t)
  const model = await f.provider.resolveModel()
  assert.equal(model.id, 'gpt-6-pro-web')
  assert.equal(model.context?.contextWindow, 32_768)
  assert.deepEqual(model.reasoning?.efforts.map(row => row.id), ['pro'])
  assert.equal(model.reasoning?.defaultEffort, 'pro')
  assert.equal(model.defaultMaxTokens, undefined)
  assert.deepEqual(model.inputModalities, ['text', 'image'])
  const output = await collect(f.provider.stream(input()))
  assert.equal(output.some(chunk => chunk.type === 'usage'), false)
  assert.equal(output.at(-1)?.type, 'finish')
  assert.equal(f.registrations, 1)
})

test('disabled or missing budget fail before any model turn', async t => {
  const disabled = await fixture(t); disabled.setStatus({ enabled: false })
  assert.deepEqual(await disabled.provider.listModels(), [])
  await assert.rejects(collect(disabled.provider.stream(input())), { code: 'WEB_DISABLED' })
  const budget = await fixture(t, { contextBudget: () => undefined })
  await assert.rejects(budget.provider.resolveModel(), { code: 'WEB_CONTEXT_BUDGET_REQUIRED' })
  await assert.rejects(budget.provider.setEnabled(true), { code: 'WEB_CONTEXT_BUDGET_REQUIRED' })
  assert.ok([disabled, budget].every(f => f.posted === 0 && f.connections === 0))
})

test('auxiliary calls fail explicitly before Chrome without inspecting host internals', async t => {
  const f = await fixture(t)
  await f.provider.resolveModel()
  for (const purpose of ['compaction', 'session-title']) {
    await assert.rejects(collect(f.provider.stream({ ...input(), purpose })), { code: 'WEB_AUXILIARY_UNSUPPORTED' })
  }
  assert.equal(f.posted, 0)
})

test('input is captured synchronously and preserves stable history identity', async t => {
  const f = await fixture(t)
  const options = input()
  const stream = f.provider.stream(options)
  ;(options.messages[0]!.content[0] as { text: string }).text = 'changed'
  Object.assign(options.messages[0]!, { id: 'different' })
  options.system = 'late mutation'
  await collect(stream)
  assert.equal(f.requests[0]!.messages[0]!.id, 'stable-user')
  assert.deepEqual(f.requests[0]!.messages[0]!.content, [{ type: 'text', text: 'original' }])
  assert.equal(f.requests[0]!.system, undefined)
})

test('a cached instance with an expired data lease cannot falsely report ready or post a model request', async t => {
  const f = await fixture(t)
  await f.provider.resolveModel()
  f.setHeartbeatFailure(true)
  await delay(80)
  await assert.rejects(f.provider.resolveModel(), { code: 'WEB_LEASE_EXPIRED' })
  assert.equal(f.posted, 0)
  assert.equal(f.releases, 1)
  f.setHeartbeatFailure(false)
  await f.provider.resolveModel()
  assert.equal(f.registrations, 2)
})

test('runtime metadata cannot make an experimental or mismatched bridge look browser-ready', async t => {
  const experimental = await fixture(t); experimental.setTransport('experimental')
  await assert.rejects(experimental.provider.resolveModel(), { code: 'WEB_BINDING_MISMATCH' })
  const other = await fixture(t); other.setInstance('other-instance')
  await assert.rejects(other.provider.resolveModel(), { code: 'WEB_BINDING_MISMATCH' })
  assert.equal(experimental.posted + other.posted, 0)
})

test('heartbeat failure after POST is uncertain and retains the request ID without another submission', async t => {
  const f = await fixture(t)
  f.holdTurns()
  const consumed = collect(f.provider.stream(input()))
  const rejected = assert.rejects(consumed, error => {
    assert.ok(error instanceof WebBridgeError)
    assert.equal(error.code, 'WEB_UNCERTAIN')
    assert.equal(error.requestId, `turn-${f.requests[0]!.idempotencyKey.slice(7)}`)
    return true
  })
  await f.postedOnce
  f.setHeartbeatFailure(true)
  await rejected
  assert.equal(f.posted, 1)
})

test('provider disposal releases management even when its data lease is already expired', async t => {
  const f = await fixture(t)
  await f.provider.resolveModel()
  f.setReleaseFailure(true)
  const disposal = f.provider.dispose()
  assert.equal(f.provider.dispose(), disposal)
  await assert.rejects(disposal, { code: 'WEB_LEASE_EXPIRED', message: 'Lease expired before release' })
  assert.equal(f.releases, 1)
  assert.equal(f.runtimeDisposals, 1)
})

test('auxiliary rejection reaches the host error seam without touching Chrome', async t => {
  const f = await fixture(t, { errorFactory: (message, code, status, requestId) => Object.assign(new Error(message), { code, status, requestId }) })
  await f.provider.resolveModel()
  await assert.rejects(collect(f.provider.stream({ ...input(), purpose: 'compaction' })), error => {
    assert.ok(error instanceof Error && !(error instanceof WebBridgeError))
    assert.equal((error as Error & { code: string }).code, 'WEB_AUXILIARY_UNSUPPORTED')
    return true
  })
  assert.equal(f.posted, 0)
})
