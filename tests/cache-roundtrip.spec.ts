import { it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { ChatGptAdapter, type HarnessMessage, type HarnessRequest } from '../src/adapter.ts'
import type { AdapterChunk } from '../src/convert/blocks.ts'
import type { ChatGptAuth } from '../src/auth/manager.ts'
import type { ResponsesBody } from '../src/convert/request.ts'

it('preserves the wire prefix through HTTP, streamed output, durable restore and further tool turns', async () => {
  const requests: { body: ResponsesBody, session: string | undefined }[] = []
  const output = [
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque-test-state' },
    { type: 'message', id: 'msg_1', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Read it.', annotations: [] }] },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{ "path": "a" }' },
    { type: 'message', id: 'msg_2', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking next.', annotations: [] }] },
  ]
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const bytes of request) raw += bytes
    requests.push({ body: JSON.parse(raw), session: request.headers['session_id'] as string | undefined })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    output.forEach((item, index) => response.write(`data: ${JSON.stringify({ type: 'response.output_item.done', output_index: index, item })}\n\n`))
    response.end(`data: ${JSON.stringify({
      type: 'response.completed', response: { output: [], usage: { input_tokens: 5000, input_tokens_details: { cached_tokens: 4000 }, output_tokens: 20 } },
    })}\n\n`)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  let credential = {
    accessToken: 'mock-only', clientId: 'test-client', subject: 'test-subject',
    replayNamespace: 'cf5a7f74-6069-4dfa-bd1c-df7d2e76f278',
  }
  const auth = { usable: async () => credential, renew: async () => credential } as unknown as ChatGptAuth
  const options = { auth, baseUrl: `http://127.0.0.1:${address.port}` }
  const request: HarnessRequest = {
    provider: 'chatgpt', model: 'gpt-6.1-sol', sessionId: 'durable-session', reasoningEffort: 'high',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'Stable instructions.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Inspect a.' }] },
    ],
    tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  }
  try {
    const chunks: AdapterChunk[] = []
    for await (const chunk of new ChatGptAdapter(options).stream('chatgpt', request)) chunks.push(chunk)
    const finish = chunks.findLast(chunk => chunk.type === 'finish')
    assert.ok(finish?.replayState)
    const assistant: HarnessMessage = JSON.parse(JSON.stringify({
      role: 'assistant',
      content: chunks.filter(c => c.type === 'block-end').map(c => c.block),
      source: { kind: 'model', provider: request.provider, model: request.model, replayState: finish.replayState },
    }))
    const continued = {
      ...request, messages: [...request.messages, assistant, { role: 'tool' as const, toolCallId: 'call_1', content: [{ type: 'text', text: 'Contents.' }] }],
    }
    // A new adapter instance and JSON-restored messages do not lose native state.
    for await (const chunk of new ChatGptAdapter(options).stream('chatgpt', continued)) void chunk
    const updated = {
      ...continued, messages: [...continued.messages, { role: 'developer' as const, content: [{ type: 'text', text: 'New environment context.' }] }],
    }
    for await (const chunk of new ChatGptAdapter(options).stream('chatgpt', updated)) void chunk
    assert.deepEqual(requests[1].body.input.slice(0, requests[0].body.input.length), requests[0].body.input)
    assert.deepEqual(requests[1].body.input.slice(2, -1), output)
    assert.deepEqual(requests[2].body.input.slice(0, requests[1].body.input.length), requests[1].body.input)
    assert.equal(requests[2].body.input.at(-1).role, 'developer')
    for (const captured of requests) {
      assert.equal(captured.session, requests[0].session)
      assert.equal(captured.session, captured.body.prompt_cache_key)
      assert.match(captured.session, /^[a-f0-9]{64}$/)
      assert.equal(captured.body.store, false)
      assert.equal(captured.body.stream, true)
      assert.deepEqual(captured.body.tools, requests[0].body.tools)
    }
    // Same route and model, different authorized account registration.
    credential = { ...credential, clientId: 'other-client', subject: 'other-subject' }
    for await (const chunk of new ChatGptAdapter(options).stream('chatgpt', continued)) void chunk
    assert.notEqual(requests[3].session, requests[0].session)
    assert.ok(requests[3].body.input.every(item => item.type !== 'reasoning'))
    assert.ok(requests[3].body.input.some(item => item.type === 'function_call'))
    // A caller that bypasses the manager with a legacy credential cannot claim
    // a reusable namespace from an optional subject alone.
    credential = { ...credential, replayNamespace: undefined as never }
    const legacyChunks: AdapterChunk[] = []
    for await (const chunk of new ChatGptAdapter(options).stream('chatgpt', continued)) legacyChunks.push(chunk)
    assert.equal(requests[4].session, undefined)
    assert.equal(requests[4].body.prompt_cache_key, undefined)
    assert.ok(requests[4].body.input.every(item => item.type !== 'reasoning'))
    assert.equal(legacyChunks.findLast(chunk => chunk.type === 'finish')?.replayState, undefined)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
