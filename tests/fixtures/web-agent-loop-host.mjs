/** Offline fixture provider around the real stock DSH host; no host doubles. */
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, LlmError, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import { openWebBridge } from '../../src/web-bridge/engine.ts'
import { startWebBridgeServer } from '../../src/web-bridge/server.ts'
import { WebBridgeClient } from '../../src/web-bridge/client.ts'

const root = process.argv[2]
assert.ok(root, 'The launcher must supply an isolated verification directory')
const model = 'gpt-6-pro-web'
const effectName = 'record_effect'
const effectMarker = 'one-execution-only'

function deferred() {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}

async function bounded(promise, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10_000) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

async function jsonlEvents(directory) {
  const events = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) events.push(...await jsonlEvents(path))
    else if (entry.name.endsWith('.jsonl')) {
      const data = await readFile(path, 'utf8')
      events.push(...data.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)))
    }
  }
  return events
}

/** Counting wrapper delegates every engine operation unchanged to the real engine. */
function observeEngine(engine, requests, concurrentEntered) {
  return {
    binding: engine.binding,
    instanceId: engine.instanceId,
    execute(request, options) {
      requests.push(request)
      if (requests.length === 2) concurrentEntered.resolve()
      return engine.execute(request, options)
    },
    inspect: (...args) => engine.inspect(...args),
    cancel: (...args) => engine.cancel(...args),
    recover: (...args) => engine.recover(...args),
    discard: (...args) => engine.discard(...args),
    releaseClient: (...args) => engine.releaseClient(...args),
    close: () => engine.close(),
  }
}

async function scenario(name) {
  const directory = join(root, name)
  const history = join(directory, 'host-history')
  const binding = {
    protocolVersion: 1,
    installationId: `test-${name}`,
    provider: 'chatgpt',
    profileId: `profile-${name}`,
    accountBinding: 'offline-fixture-account',
  }
  const trace = []
  const submits = []
  const httpRequests = []
  const optionsSeen = []
  const hostFailures = []
  const concurrentEntered = deferred()
  const toolObservation = deferred()
  const releaseObservation = deferred()
  const transport = {
    async prepare() {},
    async submit(turn) {
      submits.push(turn)
      trace.push(`submit:${submits.length}`)
      return { promptId: `page-${submits.length}` }
    },
    async observe(turn) {
      const results = turn.request.messages.filter(message => message.role === 'tool')
      if (results.length === 0) {
        if (name === 'concurrent-delivery') {
          toolObservation.resolve()
          await releaseObservation.promise
        }
        return { version: 1, complete: true, blocks: [
          { type: 'tool-call', id: 'effect-call', name: effectName, arguments: JSON.stringify({ marker: effectMarker }) },
        ] }
      }
      assert.equal(results.length, 1, 'The next real host request carries exactly one tool result')
      assert.equal(results[0].toolCallId, `${submits[0].turnId}:effect-call`)
      assert.ok(results[0].content.some(block => block.type === 'text' && block.text === `recorded:${effectMarker}`))
      assert.ok(turn.request.parentReceipt, 'The real host preserves the Web replay receipt into continuation')
      assert.equal(turn.request.parentReceipt.turnId, submits[0].turnId)
      return { version: 1, complete: true, blocks: [{ type: 'text', text: 'Finished after one local tool.' }] }
    },
  }
  const engine = await openWebBridge({
    directory: join(directory, 'bridge-journal'),
    profileDirectory: join(directory, 'profile'),
    binding,
    transport,
    initialize: true,
  })
  let server
  const clients = []
  const ctx = new Context()
  let effectCount = 0
  let streamClosed = 0
  let lastToolOptions
  let activeClient
  let competitorResults
  let injected = false
  try {
    server = await startWebBridgeServer({ engine: observeEngine(engine, httpRequests, concurrentEntered) })
    for (let index = 0; index < (name === 'concurrent-delivery' ? 2 : 1); index += 1) {
      const client = new WebBridgeClient({
        url: server.url,
        token: server.token,
        expectedBinding: binding,
        errorFactory: (message, code, status) => new LlmError(message, code, { status }),
      })
      await client.connect()
      clients.push(client)
    }
    activeClient = clients[0]

    // These are the same production service plugins used by stock AgentLoop.
    for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt,
      ToolRuntime, NativeToolExecutor, AgentRegistry]) await ctx.plugin(plugin)
    await ctx.plugin(JsonlSessionPersistence, { root: history, compression: 'none' })
    await ctx.plugin(SessionCheckpointPolicy)
    await ctx.plugin(AgentLoop, { agents: [] })

    class BridgeAdapter extends LlmAdapter {
      async resolveModel(provider, id) {
        return { provider, id, name: 'GPT-6 Pro · Web (offline fixture)',
          reasoning: { efforts: [{ id: 'pro', name: 'Pro' }], defaultEffort: 'pro' } }
      }

      stream(options) {
        optionsSeen.push(options)
        const ordinal = optionsSeen.length
        const source = activeClient.stream(options)
        if (ordinal === 1) lastToolOptions = options
        return (async function* () {
          let chunks
          if (name === 'concurrent-delivery' && ordinal === 1) {
            const primary = collect(source)
            await bounded(toolObservation.promise, 'primary browser observation')
            const duplicate = collect(clients[1].stream(options))
            const settled = Promise.allSettled([primary, duplicate])
            await bounded(concurrentEntered.promise, 'both HTTP subscribers entering the real engine')
            releaseObservation.resolve()
            competitorResults = await bounded(settled, 'concurrent tool response delivery')
            const fulfilled = competitorResults.filter(result => result.status === 'fulfilled')
            assert.equal(fulfilled.length, 1, 'Only one subscriber receives executable tool blocks')
            assert.equal(competitorResults.find(result => result.status === 'rejected').reason.code, 'WEB_DELIVERY_CLAIMED')
            activeClient = clients[competitorResults.findIndex(result => result.status === 'fulfilled')]
            chunks = fulfilled[0].value
          } else {
            chunks = await collect(source)
          }
          if (name === 'cached-text-retry' && ordinal === 2 && !injected) {
            injected = true
            throw new LlmError('Offline fixture lost a completed text response before host delivery', 'TRANSPORT')
          }
          for (const chunk of chunks) {
            if (name === 'tool-delivery-retry' && chunk.type === 'finish' && !injected) {
              injected = true
              throw new LlmError('Offline fixture lost tool finish after exposure', 'TRANSPORT')
            }
            yield chunk
          }
          streamClosed += 1
          trace.push(`stream-closed:${ordinal}`)
        })()
      }
    }
    ctx.llm.registerAdapter(['chatgpt'], new BridgeAdapter())
    ctx.on('agent/request-error', async ({ failure }) => {
      hostFailures.push(failure)
      if (hostFailures.length === 1 && failure.code === 'TRANSPORT') return { kind: 'retry' }
      return undefined
    })
    ctx.tools.register(defineTool({
      name: effectName,
      description: 'Record one isolated verification effect.',
      parameters: { marker: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute({ marker }) {
        assert.equal(marker, effectMarker)
        assert.ok(streamClosed > 0, 'The adapter iterator must close before DSH invokes the tool')
        const durable = await jsonlEvents(history)
        assert.ok(durable.some(event => event.type === 'assistant/message'), 'Stock checkpoint persists the assistant before the tool body')
        effectCount += 1
        trace.push('tool-executed')
        return `recorded:${marker}`
      },
    }))
    const agent = await ctx.agentLoop.create(`web-${name}`, { provider: 'chatgpt', model, reasoningEffort: 'pro' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run record_effect once, then finish.' }], source: { kind: 'user' } }))
    await bounded(agent.whenIdle(), 'stock AgentLoop settlement')
    await ctx.sessions.flush(agent.session)

    const events = agent.session.snapshotEvents()
    const terminal = events.findLast(event => event.type === 'turn/end')
    assert.ok(terminal, 'The real AgentLoop must commit a terminal outcome')
    if (name === 'tool-delivery-retry') {
      assert.equal(terminal.data.reason.kind, 'error')
      assert.equal(effectCount, 0, 'An uncommitted tool response must not execute on a later retry')
      assert.equal(submits.length, 1, 'A retry cannot resubmit the exposed tool request')
      assert.equal(optionsSeen.length, 2)
      assert.equal(hostFailures.length, 2)
      assert.equal(hostFailures[1].code, 'WEB_DELIVERY_CLAIMED')
    } else {
      assert.equal(terminal.data.reason.kind, 'completed', JSON.stringify({ scenario: name, terminal: terminal.data.reason, hostFailures, trace }))
      assert.equal(effectCount, 1)
      assert.equal(submits.length, 2, 'One tool response and one continuation require exactly two browser submissions')
      assert.equal(submits[0].generationId, submits[1].generationId, 'An exact tool continuation stays in the verified conversation generation')
      assert.ok(trace.indexOf('stream-closed:1') < trace.indexOf('tool-executed'))
      assert.ok(trace.indexOf('tool-executed') < trace.indexOf('submit:2'))
      const assistants = events.filter(event => event.type === 'assistant/message')
      assert.equal(assistants.length, 2)
      assert.ok(assistants.every(event => event.data.usage === undefined), 'Unknown Web usage must remain absent in durable stock history')
      assert.equal(assistants.at(-1).data.message.content.find(block => block.type === 'text')?.text, 'Finished after one local tool.')
      if (name === 'cached-text-retry') {
        assert.equal(optionsSeen.length, 3)
        assert.equal(hostFailures.length, 1)
        assert.equal(httpRequests[1].idempotencyKey, httpRequests[2].idempotencyKey)
      } else {
        assert.equal(optionsSeen.length, 2)
        assert.equal(hostFailures.length, 0)
      }
      // A new delivery attempt for the original tool request must fail even
      // after the host has safely executed the first delivery and continued.
      const beforeReplay = httpRequests.length
      await assert.rejects(() => collect(activeClient.stream({ ...lastToolOptions, signal: new AbortController().signal })),
        error => error.code === 'WEB_DELIVERY_CLAIMED')
      assert.equal(httpRequests.length, beforeReplay + 1, 'The replay reaches the real bridge admission with a new delivery attempt')
      assert.equal(httpRequests.at(-1).idempotencyKey, httpRequests[0].idempotencyKey)
      assert.equal(effectCount, 1)
      assert.equal(submits.length, 2)
    }
    console.log(`PASS: ${name}; stock tool effects=${effectCount}, browser submissions=${submits.length}, host attempts=${optionsSeen.length}`)
  } finally {
    releaseObservation.resolve()
    await ctx.fiber.dispose()
    for (const client of clients) await client.dispose()
    await server?.close()
    await engine.close()
  }
}

for (const name of ['tool-loop', 'cached-text-retry', 'tool-delivery-retry', 'concurrent-delivery']) await scenario(name)
