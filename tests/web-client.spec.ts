import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { test, type TestContext } from 'node:test'
import { WebBridgeClient } from '../src/web-bridge/client.ts'
import { createResponse, validatePageResponse } from '../src/web-bridge/protocol.ts'
import { type WebBinding, type WebRequest, type WebResponse, WEB_MODEL } from '../src/web-bridge/contracts.ts'
import type { WebGenerateOptions } from '../src/web-bridge/request.ts'

const binding: WebBinding = { protocolVersion: 1, installationId: 'install', provider: 'chatgpt',
  profileId: 'profile', accountBinding: 'account' }
const token = 'a'.repeat(43)
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of stream) result.push(item)
  return result
}
function input(): WebGenerateOptions {
  return { provider: 'chatgpt', model: WEB_MODEL, sessionId: 'session',
    messages: [{ id: 'user', role: 'user', content: [{ type: 'text', text: 'original' }] }],
    tools: [{ name: 'echo', description: 'Echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }
}
function complete(request: WebRequest, tool = false): WebResponse {
  return createResponse(request, 'turn-test', 'generation', validatePageResponse({ version: 1, complete: true,
    blocks: tool ? [{ type: 'tool-call', id: 'one', name: 'echo', arguments: '{"text":"ok"}' }] : [{ type: 'text', text: 'ok' }],
  }, request, 'turn-test'))
}
function sse(response: WebResponse): string {
  return `event: response\ndata: ${JSON.stringify(response)}\n\nevent: finish\ndata: ${JSON.stringify({ turnId: response.turnId,
    reason: response.finishReason, responseDigest: response.receipt.responseDigest, state: 'completed' })}\n\n`
}
async function fixture(t: TestContext, reply: (request: WebRequest, response: ServerResponse) => void,
  healthReply?: (response: ServerResponse, call: number) => boolean) {
  let turns = 0
  let releases = 0
  let registrations = 0
  let healthCalls = 0
  const requests: WebRequest[] = []
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return }
    response.setHeader('content-type', 'application/json')
    if (request.url === '/health') {
      healthCalls++
      if (healthReply?.(response, healthCalls)) return
      response.end(JSON.stringify({ ...binding, instanceId: 'instance', transport: 'experimental' })); return
    }
    if (request.url === '/v1/clients') { registrations++; response.end(JSON.stringify({ clientLeaseId: 'private-client', expiresAt: Date.now() + 60_000 })); return }
    if (request.method === 'DELETE') { releases++; response.end('{}'); return }
    let body = ''
    for await (const chunk of request) body += String(chunk)
    if (request.url === '/v1/turns') {
      turns++
      const admitted = JSON.parse(body) as WebRequest
      requests.push(admitted)
      response.setHeader('content-type', 'text/event-stream')
      reply(admitted, response)
    } else response.end('{}')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const client = new WebBridgeClient({ url: `http://127.0.0.1:${address.port}`, token, expectedBinding: binding })
  t.after(async () => {
    await client.dispose().catch(() => {})
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
  })
  return { client, requests, get turns() { return turns }, get releases() { return releases },
    get registrations() { return registrations }, get healthCalls() { return healthCalls } }
}

test('stream captures the raw host input before the first iterator advance', async t => {
  const { client, requests } = await fixture(t, (request, response) => response.end(sse(complete(request))))
  const options = input()
  const stream = client.stream(options)
  ;(options.messages[0]!.content[0] as { text: string }).text = 'mutated before connecting'
  options.system = 'mutated system'
  const chunks = await collect(stream)
  assert.equal((requests[0]!.messages[0]!.content[0] as { text: string }).text, 'original')
  assert.equal(requests[0]!.system, undefined)
  assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end', 'finish'])
  assert.equal(chunks.some(chunk => chunk.type === 'usage' || chunk.type === 'reasoning-delta'), false)
})

test('buffers a complete tool response through terminal SSE and EOF before exposing any chunks', async t => {
  let finish: (() => void) | undefined
  let observed!: () => void
  const started = new Promise<void>(resolve => { observed = resolve })
  const { client } = await fixture(t, (request, response) => {
    const data = complete(request, true)
    response.write(`event: response\ndata: ${JSON.stringify(data)}\n\n`)
    finish = () => response.end(sse(data).split('\n\n').slice(1).join('\n\n'))
    observed()
  })
  const chunks: unknown[] = []
  const consuming = (async () => { for await (const chunk of client.stream(input())) chunks.push(chunk) })()
  await started
  assert.equal(chunks.length, 0)
  finish!()
  await consuming
  const final = chunks.at(-1) as { reason: { kind: string }, replayState: { response: { kind: string } } }
  assert.equal(final.reason.kind, 'tool-calls')
  assert.equal(final.replayState.response.kind, 'chatgpt-web-receipt')
  assert.equal(chunks.length, 4)
})

for (const mode of ['missing-finish', 'truncated-frame', 'after-finish', 'wrong-digest', 'invalid-arguments'] as const) {
  test(`never exposes executable content from ${mode} SSE`, async t => {
    const { client } = await fixture(t, (request, response) => {
      const data = complete(request, true)
      if (mode === 'wrong-digest') data.receipt.responseDigest = `sha256:${'0'.repeat(64)}`
      if (mode === 'invalid-arguments' && data.blocks[0]?.type === 'tool-call') data.blocks[0].arguments = '{"text":42}'
      const body = sse(data)
      response.end(mode === 'missing-finish' ? body.split('\n\n')[0] + '\n\n'
        : mode === 'truncated-frame' ? body.slice(0, -1)
        : mode === 'after-finish' ? body + 'event: progress\ndata: {}\n\n' : body)
    })
    const chunks: unknown[] = []
    await assert.rejects(async () => { for await (const chunk of client.stream(input())) chunks.push(chunk) })
    assert.deepEqual(chunks, [])
  })
}

test('unsupported controls fail before a turn is posted, and dispose releases only its lease', async t => {
  const session = await fixture(t, (request, response) => response.end(sse(complete(request))))
  await assert.rejects(collect(session.client.stream({ ...input(), maxTokens: 16 })), { code: 'WEB_UNSUPPORTED_CONTROL' })
  assert.equal(session.turns, 0)
  await session.client.dispose()
  assert.equal(session.releases, 1)
  await assert.rejects(collect(session.client.stream(input())), /disposed|connection failed/)
})

test('does not emit further executable chunks after cancellation between chunks', async t => {
  const { client } = await fixture(t, (request, response) => response.end(sse(complete(request, true))))
  const abort = new AbortController()
  const iterator = client.stream({ ...input(), signal: abort.signal })[Symbol.asyncIterator]()
  const first = await iterator.next()
  assert.equal(first.value?.type, 'block-start')
  abort.abort()
  await assert.rejects(iterator.next(), { name: 'AbortError' })
})

test('client rejects external endpoints, URL credentials and weak launch tokens', () => {
  for (const url of ['https://127.0.0.1:5555', 'http://localhost:5555', 'http://127.0.0.1:5555/private', 'http://user:secret@127.0.0.1:5555']) {
    assert.throws(() => new WebBridgeClient({ url, token }), { code: 'WEB_INVALID_ENDPOINT' })
  }
  assert.throws(() => new WebBridgeClient({ url: 'http://127.0.0.1:5555', token: 'short' }), { code: 'WEB_INVALID_TOKEN' })
})

test('a failed handshake can reconnect, while concurrent setup shares one lease', async t => {
  const session = await fixture(t, (request, response) => response.end(sse(complete(request))), (response, call) => {
    if (call !== 1) return false
    response.writeHead(503).end(JSON.stringify({ error: { code: 'WEB_UNAVAILABLE', message: 'Try setup again' } }))
    return true
  })
  await assert.rejects(session.client.connect(), { code: 'WEB_UNAVAILABLE' })
  const [first, second] = await Promise.all([session.client.connect(), session.client.connect()])
  assert.deepEqual(first, second)
  assert.equal(session.healthCalls, 2)
  assert.equal(session.registrations, 1)
  assert.equal((await collect(session.client.stream(input()))).at(-1)?.type, 'finish')
})

test('dispose cancels and joins in-flight setup without a late lease registration', async t => {
  let requested!: () => void
  const observed = new Promise<void>(resolve => { requested = resolve })
  let healthResponse: ServerResponse | undefined
  const session = await fixture(t, () => {}, response => {
    healthResponse = response
    requested()
    return true
  })
  const connecting = session.client.connect()
  const rejection = assert.rejects(connecting, { name: 'AbortError' })
  await observed
  const disposing = session.client.dispose()
  assert.equal(session.client.dispose(), disposing)
  await disposing
  await rejection
  healthResponse!.end(JSON.stringify({ ...binding, instanceId: 'instance', transport: 'experimental' }))
  assert.equal(session.registrations, 0)
  assert.equal(session.releases, 0)
})
