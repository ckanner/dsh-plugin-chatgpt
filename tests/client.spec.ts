import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { ApiError, listModels, streamTurn } from '../src/client.ts'
import type { ResponsesEvent } from '../src/api/events.ts'

/** A server that answers one fixed reply, recording what it received. */
interface Stub {
  url: string
  requests: { path: string, authorization?: string, body?: string }[]
  close(): Promise<void>
}

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve())
    server.closeAllConnections()
  })))
})

/** Start a stub endpoint. */
async function stub(reply: (path: string) => { status: number, body?: unknown, stream?: string[] }): Promise<Stub> {
  const requests: Stub['requests'] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      requests.push({
        path: request.url ?? '/',
        ...request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization },
        body,
      })
      const answer = reply(request.url ?? '/')
      if (answer.stream !== undefined) {
        response.writeHead(answer.status, { 'content-type': 'text/event-stream' })
        for (const frame of answer.stream) response.write(frame)
        response.end()
        return
      }
      response.writeHead(answer.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(answer.body ?? {}))
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('stub bound no port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()) }),
  }
}

/** Frame one SSE event. */
function frame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

/** Collect a stream into an array. */
async function collect(stream: AsyncGenerator<ResponsesEvent>): Promise<ResponsesEvent[]> {
  const events: ResponsesEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

describe('listModels', () => {
  it('sends the bearer token and reads the server\'s order', async () => {
    const endpoint = await stub(() => ({
      status: 200,
      body: {
        models: [
          { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
          { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
        ],
      },
    }))

    const models = await listModels('token-123', { baseUrl: endpoint.url })

    assert.equal(endpoint.requests[0]?.authorization, 'Bearer token-123')
    assert.equal(endpoint.requests[0]?.path, '/models')
    // Filtering is the caller's job; the listing reports what the account has.
    assert.deepEqual(models.map(model => model.slug), ['gpt-6.1-sol', 'hidden'])
  })

  it('accepts an id field as well as a slug', async () => {
    const endpoint = await stub(() => ({ status: 200, body: { models: [{ id: 'from-id' }] } }))

    assert.deepEqual((await listModels('t', { baseUrl: endpoint.url })).map(m => m.slug), ['from-id'])
  })

  it('reports the endpoint\'s own error code', async () => {
    const endpoint = await stub(() => ({
      status: 401,
      body: { error: { code: 'invalid_api_key', message: 'Incorrect API key provided' } },
    }))

    await assert.rejects(
      listModels('bad', { baseUrl: endpoint.url }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.code, 'invalid_api_key')
        assert.equal(error.status, 401)
        assert.equal(error.planUsage, false)
        return true
      },
    )
  })

  it('labels a plan-usage refusal so the caller can answer differently', async () => {
    const endpoint = await stub(() => ({
      status: 429,
      body: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'usage limit reached' } },
    }))

    await assert.rejects(
      listModels('t', { baseUrl: endpoint.url }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.planUsage, true)
        return true
      },
    )
  })

  it('answers with nothing rather than throwing when the body carries no list', async () => {
    const endpoint = await stub(() => ({ status: 200, body: { unexpected: true } }))

    assert.deepEqual(await listModels('t', { baseUrl: endpoint.url }), [])
  })
})

describe('streamTurn', () => {
  it('posts the converted body and yields decoded events through completion', async () => {
    const endpoint = await stub(() => ({
      status: 200,
      stream: [
        frame({ type: 'response.created' }),
        frame({ type: 'response.output_text.delta', delta: 'Hel' }),
        frame({ type: 'response.output_text.delta', delta: 'lo' }),
        frame({ type: 'response.completed', response: { id: 'resp_1' } }),
      ],
    }))

    const events = await collect(streamTurn({
      accessToken: 'tok',
      endpoints: { baseUrl: endpoint.url },
      request: { model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'hi' }] },
    }))

    assert.deepEqual(events.map(event => event.kind), ['text', 'text', 'completed'])
    const sent = JSON.parse(endpoint.requests[0]?.body ?? '{}') as Record<string, unknown>
    assert.equal(sent['model'], 'gpt-6.1-sol')
    assert.equal(sent['store'], false)
    assert.equal(sent['stream'], true)
    assert.equal(endpoint.requests[0]?.authorization, 'Bearer tok')
  })

  it('surfaces a failure that arrives after text has already streamed', async () => {
    const endpoint = await stub(() => ({
      status: 200,
      stream: [
        frame({ type: 'response.output_text.delta', delta: 'half an ans' }),
        frame({
          type: 'response.failed',
          response: {
            error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'out of allowance' },
          },
        }),
      ],
    }))

    const events = await collect(streamTurn({
      accessToken: 'tok',
      endpoints: { baseUrl: endpoint.url },
      request: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    }))

    assert.deepEqual(events.map(event => event.kind), ['text', 'failed'])
  })

  it('refuses to call a stream that ended without a terminal event complete', async () => {
    // A connection closed mid-answer is the case that makes a truncated answer
    // look finished if the caller trusts the stream ending.
    const endpoint = await stub(() => ({
      status: 200,
      stream: [frame({ type: 'response.output_text.delta', delta: 'trunc' })],
    }))

    await assert.rejects(
      collect(streamTurn({
        accessToken: 'tok',
        endpoints: { baseUrl: endpoint.url },
        request: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      })),
      (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.code, 'stream_ended_early')
        return true
      },
    )
  })

  it('reports an HTTP refusal before any event is read', async () => {
    const endpoint = await stub(() => ({
      status: 400,
      body: { error: { code: 'invalid_request_error', message: 'unsupported field: temperature' } },
    }))

    await assert.rejects(
      collect(streamTurn({
        accessToken: 'tok',
        endpoints: { baseUrl: endpoint.url },
        request: { model: 'm', messages: [] },
      })),
      (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.match(error.message, /temperature/)
        return true
      },
    )
  })

  it('stops reading once a terminal event arrives', async () => {
    // Frames after the terminal one belong to nothing; reading them would keep
    // the connection open for a turn that has already ended.
    const endpoint = await stub(() => ({
      status: 200,
      stream: [
        frame({ type: 'response.completed' }),
        frame({ type: 'response.output_text.delta', delta: 'should not be read' }),
      ],
    }))

    const events = await collect(streamTurn({
      accessToken: 'tok',
      endpoints: { baseUrl: endpoint.url },
      request: { model: 'm', messages: [] },
    }))

    assert.deepEqual(events.map(event => event.kind), ['completed'])
  })
})
