import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  WebBridgeError, type ClientLease, type ExecuteOptions, type TurnAccess, type TurnInspection,
  type WebBinding, type WebBridgeEngine, type WebRequest, type WebResponse,
} from '../src/web-bridge/contracts.ts'
import { digest, requestHash, WEB_MAX_JSON_BYTES, WEB_MAX_JSON_DEPTH } from '../src/web-bridge/protocol.ts'
import { startWebBridgeServer, WEB_HTTP_MAX_HEADER_BYTES, type WebBridgeServer } from '../src/web-bridge/server.ts'
import { openWebBridge } from '../src/web-bridge/engine.ts'

const binding: WebBinding = { protocolVersion: 1, installationId: 'test-installation', provider: 'chatgpt', profileId: 'test-profile', accountBinding: 'test-account' }
const servers: WebBridgeServer[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function deferred<T = void>(): { promise: Promise<T>, resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

function input(lease: string, sessionId = 'session-one'): WebRequest {
  const request: WebRequest = {
    ...binding, clientLeaseId: lease, deliveryAttemptId: 'delivery-one', idempotencyKey: `sha256:${'0'.repeat(64)}`,
    sessionId, purpose: 'normal', model: 'gpt-6-pro-web', reasoningEffort: 'pro',
    messages: [{ id: 'message-one', role: 'user', content: [{ type: 'text', text: 'Inspect this fixture.' }] }],
    tools: [], controls: {}, attachmentVersions: [], parentReceipt: null,
  }
  request.idempotencyKey = requestHash(request)
  return request
}

function answer(request: WebRequest, turnId: string): WebResponse {
  const blocks: WebResponse['blocks'] = [{ type: 'text', text: 'Fixture complete.' }]
  return {
    protocolVersion: 1, turnId, blocks, finishReason: 'stop',
    receipt: {
      kind: 'chatgpt-web-receipt', version: 1, installationId: binding.installationId, provider: binding.provider,
      profileId: binding.profileId, accountBinding: binding.accountBinding, sessionId: request.sessionId, purpose: request.purpose,
      model: 'gpt-6-pro-web', generationId: 'generation-one', turnId, requestHash: request.idempotencyKey,
      responseDigest: digest(blocks),
    },
  }
}

class TestEngine implements WebBridgeEngine {
  readonly binding = binding
  readonly instanceId = 'fixture-instance'
  readonly requests: WebRequest[] = []
  readonly releases: string[] = []
  readonly controls: { action: string, turnId: string, access: TurnAccess }[] = []
  closeCount = 0
  onExecute: ((request: WebRequest, options: ExecuteOptions | undefined, result: WebResponse) => Promise<WebResponse>) | undefined
  onRelease: ((id: string) => void) | undefined
  onClose: (() => void) | undefined
  private readonly turns = new Map<string, { request: WebRequest, response: WebResponse }>()

  async execute(request: WebRequest, options?: ExecuteOptions): Promise<WebResponse> {
    this.requests.push(request)
    const response = answer(request, `turn-${this.requests.length}`)
    this.turns.set(response.turnId, { request, response })
    if (this.onExecute !== undefined) return this.onExecute(request, options, response)
    options?.authorizeDelivery?.()
    return response
  }

  private control(action: string, turnId: string, access: TurnAccess): Promise<TurnInspection> {
    this.controls.push({ action, turnId, access })
    const record = this.turns.get(turnId)
    if (record === undefined || record.request.sessionId !== access.sessionId
      || record.request.clientLeaseId !== access.clientLeaseId) {
      return Promise.reject(new WebBridgeError('WEB_ACCESS_DENIED', 'This client has not joined this request', 403))
    }
    return Promise.resolve({
      turnId, sessionId: access.sessionId, state: 'completed', requestHash: record.request.idempotencyKey,
      generationId: 'generation-one', discarded: action === 'discard', deliveryState: 'unclaimed', response: record.response,
    })
  }

  inspect(turnId: string, access: TurnAccess): Promise<TurnInspection> { return this.control('inspect', turnId, access) }
  cancel(turnId: string, access: TurnAccess): Promise<TurnInspection> { return this.control('cancel', turnId, access) }
  recover(turnId: string, access: TurnAccess): Promise<TurnInspection> { return this.control('recover', turnId, access) }
  discard(turnId: string, access: TurnAccess): Promise<TurnInspection> { return this.control('discard', turnId, access) }
  releaseClient(id: string): Promise<void> { this.releases.push(id); this.onRelease?.(id); return Promise.resolve() }
  close(): Promise<void> { this.closeCount++; this.onClose?.(); return Promise.resolve() }
}

async function start(engine = new TestEngine(), options: { leaseTtlMs?: number, now?: () => number } = {}): Promise<WebBridgeServer> {
  const server = await startWebBridgeServer({ engine, ...options })
  servers.push(server)
  return server
}

interface WireOptions {
  method?: string
  path?: string
  headers?: OutgoingHttpHeaders | string[]
  body?: string | Buffer
  authorize?: boolean
}
interface WireResult { status: number, headers: IncomingHttpHeaders, body: string }

function wire(server: WebBridgeServer, options: WireOptions = {}): Promise<WireResult> {
  const port = new URL(server.url).port
  const headers = Array.isArray(options.headers) ? options.headers : {
    ...options.authorize === false ? {} : { authorization: `Bearer ${server.token}` },
    ...options.body === undefined ? {} : { 'content-type': 'application/json' },
    ...options.headers,
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path ?? '/health', headers }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.once('error', reject)
      response.once('end', () => { resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }) })
    })
    request.once('error', reject)
    request.end(options.body)
  })
}

async function register(server: WebBridgeServer): Promise<ClientLease> {
  const result = await wire(server, { method: 'POST', path: '/v1/clients', body: '{}' })
  assert.equal(result.status, 201, result.body)
  return JSON.parse(result.body) as ClientLease
}

function submit(server: WebBridgeServer, lease: ClientLease, request = input(lease.clientLeaseId)): Promise<WireResult> {
  return wire(server, { method: 'POST', path: '/v1/turns', headers: { 'x-web-client-lease': lease.clientLeaseId }, body: JSON.stringify(request) })
}

function errorCode(result: WireResult): string { return (JSON.parse(result.body) as { error: { code: string } }).error.code }

describe('experimental Web bridge HTTP boundary', () => {
  it('binds only an ephemeral literal loopback endpoint and authenticates health with a fresh launch token', async () => {
    const first = await start()
    const second = await start()
    assert.match(first.url, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/)
    assert.match(first.token, /^[\w-]{43}$/)
    assert.notEqual(first.token, second.token)
    assert.equal((await wire(first, { authorize: false })).status, 401)
    assert.equal((await wire(first, { headers: { authorization: `Bearer ${second.token}` } })).status, 401)
    const result = await wire(first)
    assert.equal(result.status, 200)
    assert.deepEqual(JSON.parse(result.body), { ...binding, instanceId: 'fixture-instance', transport: 'experimental' })
    assert.equal(result.headers['access-control-allow-origin'], undefined)
    assert.equal(result.headers['cache-control'], 'no-store')
    assert.equal(result.body.includes(first.token), false)
    await assert.rejects(startWebBridgeServer({ engine: new TestEngine(), token: 'weak' }), /token/)
  })

  it('rejects browser origins, nonexact Host, proxy request targets and ambiguous credentials', async () => {
    const server = await start()
    const host = new URL(server.url).host
    for (const origin of ['https://chatgpt.com', 'null', '']) {
      const result = await wire(server, { headers: { origin } })
      assert.equal(result.status, 403)
      assert.equal(errorCode(result), 'WEB_HTTP_ORIGIN')
      assert.equal(result.headers['access-control-allow-origin'], undefined)
    }
    assert.equal((await wire(server, { headers: { host: `localhost:${new URL(server.url).port}` } })).status, 403)
    assert.equal((await wire(server, { path: 'http://example.invalid/health' })).status, 400)
    assert.equal((await wire(server, { method: 'OPTIONS', headers: { origin: 'https://example.invalid', 'access-control-request-method': 'POST' } })).status, 403)
    const duplicate = await wire(server, { headers: ['Host', host, 'Authorization', `Bearer ${server.token}`, 'Authorization', `Bearer ${server.token}`] })
    assert.equal(duplicate.status, 400)
    assert.equal(errorCode(duplicate), 'WEB_HTTP_HEADERS')
    const many: OutgoingHttpHeaders = Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`x-extra-${index}`, 'x']))
    many['origin'] = 'https://example.invalid'
    assert.equal((await wire(server, { headers: many })).status, 403, 'headers must not be silently truncated before checking Origin')
  })

  it('bounds headers, declared bodies and streamed bodies before creating leases or executing work', async () => {
    const engine = new TestEngine()
    const server = await start(engine)
    assert.equal((await wire(server, { headers: { 'x-large': 'x'.repeat(WEB_HTTP_MAX_HEADER_BYTES) } })).status, 431)
    const declared = await wire(server, { method: 'POST', path: '/v1/clients', headers: { 'content-length': String(WEB_MAX_JSON_BYTES + 1) }, body: '{}' })
    assert.equal(declared.status, 413)
    const streamed = await wire(server, { method: 'POST', path: '/v1/clients', body: `"${'x'.repeat(WEB_MAX_JSON_BYTES)}"` })
    assert.equal(streamed.status, 413)
    assert.equal(errorCode(streamed), 'WEB_HTTP_BODY_LIMIT')
    assert.deepEqual(engine.requests, [])
    assert.deepEqual(engine.releases, [])
  })

  it('requires bounded, valid UTF-8 JSON with the exact media type and a known body shape', async () => {
    const server = await start()
    for (const contentType of ['text/plain', 'application/jsonp', 'application/problem+json', 'application/json; charset=latin1']) {
      assert.equal((await wire(server, { method: 'POST', path: '/v1/clients', headers: { 'content-type': contentType }, body: '{}' })).status, 415)
    }
    assert.equal((await wire(server, { method: 'POST', path: '/v1/clients', headers: { 'content-encoding': 'gzip' }, body: '{}' })).status, 415)
    for (const body of ['', '{', Buffer.from([0xff]), '[]', '{"extra":true}']) {
      assert.equal((await wire(server, { method: 'POST', path: '/v1/clients', body })).status, 400)
    }
    const deep = '['.repeat(WEB_MAX_JSON_DEPTH + 1) + '0' + ']'.repeat(WEB_MAX_JSON_DEPTH + 1)
    const result = await wire(server, { method: 'POST', path: '/v1/clients', body: deep })
    assert.equal(result.status, 413)
    assert.equal(errorCode(result), 'WEB_HTTP_DEPTH')
    const quoted = JSON.stringify({ extra: `${'['.repeat(WEB_MAX_JSON_DEPTH + 1)}\\\"` })
    assert.equal(errorCode(await wire(server, { method: 'POST', path: '/v1/clients', body: quoted })), 'WEB_HTTP_BODY')
    assert.equal((await wire(server, { method: 'GET', headers: { 'content-length': '2' }, body: '{}' })).status, 400)
  })

  it('ends a body that stalls after admission without waiting for the sender to finish', { timeout: 15_000 }, async () => {
    const server = await start()
    const result = await new Promise<WireResult>((resolve, reject) => {
      const request = httpRequest(`${server.url}/v1/clients`, {
        method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json', 'content-length': '2' },
      }, response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => { body += chunk })
        response.once('end', () => { request.destroy(); resolve({ status: response.statusCode!, headers: response.headers, body }) })
      })
      request.once('error', reject)
      request.write('{')
    })
    assert.equal(result.status, 408)
    assert.equal(errorCode(result), 'WEB_HTTP_TIMEOUT')
    assert.equal((await wire(server)).status, 200)
  })

  it('renews only the named private lease and never revives an expired client', async () => {
    let now = 1_000
    const engine = new TestEngine()
    const server = await start(engine, { now: () => now, leaseTtlMs: 1_000 })
    const first = await register(server)
    const second = await register(server)
    assert.equal(first.expiresAt, 2_000)
    assert.notEqual(first.clientLeaseId, second.clientLeaseId)
    now = 1_500
    const heartbeat = await wire(server, { method: 'POST', path: `/v1/clients/${first.clientLeaseId}/heartbeat`, headers: { 'x-web-client-lease': first.clientLeaseId }, body: '{}' })
    assert.equal(heartbeat.status, 200)
    assert.equal((JSON.parse(heartbeat.body) as ClientLease).expiresAt, 2_500)
    assert.equal((await wire(server, { method: 'DELETE', path: `/v1/clients/${second.clientLeaseId}`, headers: { 'x-web-client-lease': first.clientLeaseId } })).status, 403)
    assert.equal((await wire(server, { method: 'POST', path: `/v1/clients/${second.clientLeaseId}/heartbeat`, body: '{}' })).status, 403)
    now = 2_500
    assert.equal((await wire(server, { method: 'POST', path: `/v1/clients/${first.clientLeaseId}/heartbeat`, headers: { 'x-web-client-lease': first.clientLeaseId }, body: '{}' })).status, 403)
    assert.deepEqual(engine.releases, [first.clientLeaseId])
  })

  it('validates body lease ownership and the complete request hash before engine dispatch', async () => {
    const engine = new TestEngine()
    const server = await start(engine)
    const first = await register(server)
    const second = await register(server)
    assert.equal((await submit(server, first, input(second.clientLeaseId))).status, 403)
    const changed = input(first.clientLeaseId)
    changed.system = 'different effective instructions'
    const conflict = await submit(server, first, changed)
    assert.equal(errorCode(conflict), 'WEB_IDEMPOTENCY_CONFLICT')
    const unsupported = input(first.clientLeaseId)
    unsupported.controls = { maxTokens: 20 }
    unsupported.idempotencyKey = requestHash(unsupported)
    assert.equal(errorCode(await submit(server, first, unsupported)), 'WEB_UNSUPPORTED_CONTROL')
    assert.deepEqual(engine.requests, [])
  })

  it('delivers one finite response and finish only after the engine completes and authorizes delivery', async () => {
    const engine = new TestEngine()
    const entered = deferred()
    const complete = deferred()
    let authorized = false
    engine.onExecute = async (_request, options, result) => {
      entered.resolve()
      await complete.promise
      options?.authorizeDelivery?.()
      authorized = true
      return result
    }
    const server = await start(engine)
    const lease = await register(server)
    let settled = false
    const pending = submit(server, lease).then(result => { settled = true; return result })
    await entered.promise
    assert.equal(settled, false)
    complete.resolve()
    const result = await pending
    assert.equal(authorized, true)
    assert.equal(result.status, 200)
    assert.match(result.headers['content-type']!, /^text\/event-stream/)
    const events = result.body.trim().split('\n\n')
    assert.equal(events.length, 2)
    assert.match(events[0]!, /^event: response\ndata: /)
    assert.match(events[1]!, /^event: finish\ndata: /)
    const finish = JSON.parse(events[1]!.slice('event: finish\ndata: '.length))
    assert.deepEqual(finish, { turnId: 'turn-1', reason: 'stop', responseDigest: digest([{ type: 'text', text: 'Fixture complete.' }]), state: 'completed' })
  })

  it('rechecks expiry at delivery, releases the expired owner, and emits no successful SSE', async () => {
    let now = 1_000
    const engine = new TestEngine()
    engine.onExecute = async (_request, options, result) => {
      now = 2_000
      options?.authorizeDelivery?.()
      return result
    }
    const server = await start(engine, { now: () => now, leaseTtlMs: 1_000 })
    const lease = await register(server)
    const result = await submit(server, lease)
    assert.equal(result.status, 403)
    assert.equal(errorCode(result), 'WEB_LEASE_EXPIRED')
    assert.match(result.headers['content-type']!, /^application\/json/)
    assert.deepEqual(engine.releases, [lease.clientLeaseId])
  })

  it('expires an abandoned lease even without a later heartbeat or request', { timeout: 2_000 }, async () => {
    const engine = new TestEngine()
    const released = deferred()
    const entered = deferred()
    engine.onRelease = () => { released.resolve() }
    engine.onExecute = async (_request, options, result) => {
      entered.resolve()
      await released.promise
      options?.authorizeDelivery?.()
      return result
    }
    const server = await start(engine, { leaseTtlMs: 100 })
    const lease = await register(server)
    const pending = submit(server, lease)
    await entered.promise
    assert.equal((await pending).status, 403)
    assert.deepEqual(engine.releases, [lease.clientLeaseId])
  })

  it('releasing the launching client leaves another client and the service usable', async () => {
    const engine = new TestEngine()
    const entered = deferred()
    const complete = deferred()
    engine.onExecute = async (_request, options, result) => {
      entered.resolve()
      await complete.promise
      options?.authorizeDelivery?.()
      return result
    }
    const server = await start(engine)
    const first = await register(server)
    const second = await register(server)
    const activeSecond = submit(server, second)
    await entered.promise
    const result = await wire(server, { method: 'DELETE', path: `/v1/clients/${first.clientLeaseId}`, headers: { 'x-web-client-lease': first.clientLeaseId } })
    assert.equal(result.status, 200)
    assert.equal(engine.closeCount, 0)
    assert.deepEqual(engine.releases, [first.clientLeaseId])
    assert.equal((await submit(server, first)).status, 403)
    assert.equal((await wire(server)).status, 200)
    complete.resolve()
    assert.equal((await activeSecond).status, 200)
    await server.close()
    await server.close()
    assert.equal(engine.closeCount, 1)
    assert.deepEqual(engine.releases, [first.clientLeaseId, second.clientLeaseId])
  })

  it('passes exact control scope to the engine and cannot authorize an unjoined lease using only a sessionId', async () => {
    const engine = new TestEngine()
    const server = await start(engine)
    const lease = await register(server)
    const stranger = await register(server)
    assert.equal((await submit(server, lease)).status, 200)
    const headers = { 'x-web-client-lease': lease.clientLeaseId }
    assert.equal((await wire(server, { path: '/v1/turns/turn-1?sessionId=session-one', headers })).status, 200)
    assert.equal((await wire(server, { path: '/v1/turns/turn-1?sessionId=session-one', headers: { 'x-web-client-lease': stranger.clientLeaseId } })).status, 403)
    assert.equal((await wire(server, { path: '/v1/turns/turn-1?sessionId=another-session', headers })).status, 403)
    const before = engine.controls.length
    assert.equal((await wire(server, { path: '/v1/turns/turn-1?sessionId=session-one&sessionId=another-session', headers })).status, 400)
    assert.equal(engine.controls.length, before)
    for (const action of ['cancel', 'recover', 'discard']) {
      assert.equal((await wire(server, { method: 'POST', path: `/v1/turns/turn-1/${action}`, headers, body: '{"sessionId":"session-one"}' })).status, 200)
    }
    assert.deepEqual(engine.controls.at(-1), { action: 'discard', turnId: 'turn-1', access: { clientLeaseId: lease.clientLeaseId, sessionId: 'session-one' } })
  })

  it('enforces real journal participation and a single executable delivery across two authenticated HTTP clients', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'web-server-engine-'))
    directories.push(directory)
    let submitted = 0
    const engine = await openWebBridge({
      directory: join(directory, 'journal'), profileDirectory: join(directory, 'profile'), binding, initialize: true,
      transport: {
        async prepare() {},
        async submit() { submitted++; return { promptId: 'observed-prompt' } },
        async observe() {
          return { version: 1, complete: true, blocks: [{ type: 'tool-call', id: 'list', name: 'list_files', arguments: '{}' }] }
        },
      },
    })
    const server = await startWebBridgeServer({ engine })
    servers.push(server)
    const first = await register(server)
    const second = await register(server)
    const request = input(first.clientLeaseId)
    request.tools = [{ name: 'list_files', description: 'List fixture files', parameters: { type: 'object', properties: {}, additionalProperties: false } }]
    request.idempotencyKey = requestHash(request)
    const delivered = await submit(server, first, request)
    assert.equal(delivered.status, 200, delivered.body)
    const response = JSON.parse(delivered.body.split('\n\n')[0]!.slice('event: response\ndata: '.length)) as WebResponse
    assert.equal(response.finishReason, 'tool-calls')
    const route = `/v1/turns/${response.turnId}`
    const secondHeaders = { 'x-web-client-lease': second.clientLeaseId }
    assert.equal(errorCode(await wire(server, { path: `${route}?sessionId=session-one`, headers: secondHeaders })), 'WEB_FORBIDDEN')
    const joined = { ...request, clientLeaseId: second.clientLeaseId, deliveryAttemptId: 'delivery-two' }
    assert.equal(requestHash(joined), request.idempotencyKey)
    const replay = await submit(server, second, joined)
    assert.equal(errorCode(replay), 'WEB_DELIVERY_CLAIMED')
    assert.equal(replay.body.includes('event: response'), false)
    const inspected = await wire(server, { path: `${route}?sessionId=session-one`, headers: secondHeaders })
    assert.equal(inspected.status, 200)
    assert.equal(inspected.body.includes(first.clientLeaseId), false, 'inspection must not leak another client\'s private control capability')
    const recovered = await wire(server, { method: 'POST', path: `${route}/recover`, headers: secondHeaders, body: '{"sessionId":"session-one"}' })
    assert.equal(recovered.status, 200)
    assert.equal(recovered.body.includes(first.clientLeaseId), false)
    assert.equal(errorCode(await wire(server, { method: 'POST', path: `${route}/cancel`, headers: secondHeaders, body: '{"sessionId":"session-one"}' })), 'WEB_FORBIDDEN')
    const discarded = await wire(server, { method: 'POST', path: `${route}/discard`, headers: secondHeaders, body: '{"sessionId":"session-one"}' })
    assert.equal(discarded.status, 200)
    assert.equal((JSON.parse(discarded.body) as TurnInspection).discarded, true)
    assert.equal(discarded.body.includes(first.clientLeaseId), false)
    assert.equal(submitted, 1)
  })

  it('bounds responses and hides stacks, launch tokens and unexpected engine errors', async () => {
    const engine = new TestEngine()
    const server = await start(engine)
    const lease = await register(server)
    engine.onExecute = async () => { throw new WebBridgeError('WEB_UNCERTAIN', `Do not expose ${server.token}`, 409) }
    const known = await submit(server, lease)
    assert.equal(known.status, 409)
    assert.equal(errorCode(known), 'WEB_UNCERTAIN')
    assert.equal(known.body.includes(server.token), false)
    assert.equal(known.body.includes('stack'), false)
    engine.onExecute = async () => { throw new Error(`Private filesystem and token ${server.token}`) }
    const unknown = await submit(server, lease)
    assert.equal(unknown.status, 500)
    assert.equal(unknown.body.includes('filesystem'), false)
    assert.equal(unknown.body.includes(server.token), false)
    engine.onExecute = async (_request, options, result) => {
      options?.authorizeDelivery?.()
      result.blocks = [{ type: 'text', text: 'x'.repeat(WEB_MAX_JSON_BYTES) }]
      return result
    }
    const large = await submit(server, lease)
    assert.equal(large.status, 502)
    assert.equal(errorCode(large), 'WEB_HTTP_RESPONSE_LIMIT')
    assert.equal(large.body.includes('event: response'), false)
  })

  it('does not claim delivery after the HTTP client disconnects', async () => {
    const engine = new TestEngine()
    const entered = deferred()
    const disconnected = deferred()
    const checked = deferred<string>()
    engine.onExecute = async (_request, options, result) => {
      entered.resolve()
      await disconnected.promise
      try { options?.authorizeDelivery?.(); checked.resolve('unexpected-success') } catch (error) {
        checked.resolve(error instanceof WebBridgeError ? error.code : 'unexpected-error')
        throw error
      }
      return result
    }
    const server = await start(engine)
    const lease = await register(server)
    const request = httpRequest(`${server.url}/v1/turns`, { method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json', 'x-web-client-lease': lease.clientLeaseId } })
    request.on('error', () => {})
    request.end(JSON.stringify(input(lease.clientLeaseId)))
    await entered.promise
    const closed = new Promise<void>(resolve => { request.once('close', resolve) })
    request.destroy()
    await closed
    // A round trip gives the server its socket-close notification before delivery.
    assert.equal((await wire(server)).status, 200)
    disconnected.resolve()
    assert.equal(await checked.promise, 'WEB_HTTP_DISCONNECTED')
    assert.equal((await wire(server)).status, 200)
  })
})
