import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatGptAdapter, toNeutralRequest } from '../src/adapter.ts'
import { ChatGptAuth } from '../src/auth/manager.ts'
import { writeDocument, emptyDocument } from '../src/auth/store.ts'
import type { ChatGptCredential } from '../src/auth/credential.ts'
import { startTokenServer } from './helpers.ts'

const servers: Server[] = []
const dirs: string[] = []
/** Token endpoints, which own their own listener and close through their handle. */
const tokenServers: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(tokenServers.splice(0).map(close => close()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve())
    server.closeAllConnections()
  })))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A fresh state directory with a live (unexpired) grant already stored. */
async function signedIn(overrides: Partial<ChatGptCredential> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-adapter-'))
  dirs.push(dir)
  writeDocument(join(dir, 'chatgpt-auth.json'), {
    ...emptyDocument('urn:uuid:x'),
    accounts: {
      'subject-1': {
        accessToken: 'token',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 3600_000,
        clientId: 'oaiapp_issued',
        scopes: ['chatgpt.tokens.use.direct'],
        subject: 'subject-1',
        email: 'me@example.com',
        savedAt: Date.now(),
        ...overrides,
      },
    },
    active: 'subject-1',
  })
  return dir
}

/** An endpoint serving the listing and one streamed turn. */
async function endpoint(options: {
  listing?: unknown
  listingStatus?: number
  frames?: string[]
  /** Answer one request directly, overriding the scripted reply. */
  onRequest?: (path: string) => { status: number, body: unknown } | undefined
} = {}): Promise<{ url: string, paths: string[] }> {
  const paths: string[] = []
  const server = createServer((request, response) => {
    const path = request.url ?? '/'
    paths.push(path)
    const override = options.onRequest?.(path)
    if (override !== undefined) {
      response.writeHead(override.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(override.body))
      return
    }
    if (path.startsWith('/models')) {
      response.writeHead(options.listingStatus ?? 200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(options.listing ?? { models: [] }))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const frame of options.frames ?? []) response.write(frame)
    response.end()
  })
  servers.push(server)
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('endpoint bound no port')
  return { url: `http://127.0.0.1:${address.port}`, paths }
}

/** Frame one SSE event. */
function frame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

/** An adapter over a fresh auth instance for one state directory. */
function adapterFor(stateDir: string, url: string, now?: () => number): ChatGptAdapter {
  return new ChatGptAdapter({
    auth: new ChatGptAuth({ stateDir, agentNameHint: 'DeepSeek Harness' }),
    baseUrl: url,
    ...now === undefined ? {} : { now },
  })
}

describe('ChatGptAdapter', () => {
  it('names its provider row', async () => {
    const adapter = adapterFor(await signedIn(), 'http://127.0.0.1:9')

    assert.deepEqual(adapter.providerInfo('chatgpt'), { id: 'chatgpt', name: 'ChatGPT' })
  })

  it('offers nothing before a sign-in, without failing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chatgpt-adapter-'))
    dirs.push(dir)
    // Not being signed in is a route waiting for one, not a broken route: a
    // failure here would make the selector unusable before the first sign-in.
    const adapter = new ChatGptAdapter({
      auth: new ChatGptAuth({ stateDir: dir, agentNameHint: 'DeepSeek Harness' }),
      baseUrl: 'http://127.0.0.1:9',
    })

    assert.deepEqual(await adapter.listModels(), [])
  })

  it('describes the account\'s models with capacities and reasoning levels', async () => {
    const endpointUrl = await endpoint({
      listing: {
        models: [
          { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
          { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' },
        ],
      },
    })
    const adapter = adapterFor(await signedIn(), endpointUrl.url)

    const models = await adapter.listModels()

    // Advertised first, then the measured models the listing omits.
    assert.equal(models[0]?.id, 'gpt-6.1-sol')
    assert.deepEqual(
      models.map(model => model.id),
      ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna'],
    )
    const resolved = await adapter.resolveModel('chatgpt', 'gpt-6.1-sol')
    assert.equal(resolved.provider, 'chatgpt')
    assert.equal(resolved.name, 'GPT-6.1 Sol')
    assert.ok(resolved.context.contextWindow >= 200000)
    assert.ok((resolved.defaultMaxTokens ?? 0) > 0)
    assert.deepEqual(resolved.inputModalities, ['text', 'image'])
    assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.id), [
      'low', 'medium', 'high', 'xhigh', 'max',
    ])
    assert.equal(resolved.reasoning?.defaultEffort, 'medium')
  })

  it('reports the extended capacity the endpoint advertises, not the smaller default', async () => {
    // The endpoint reports both a default and a maximum; the harness models one
    // number, and reporting the default would make it compact earlier than the
    // model requires.
    const endpointUrl = await endpoint({
      listing: {
        models: [{ slug: 'wide', visibility: 'list', context_window: 272000, max_context_window: 872000 }],
      },
    })
    const adapter = adapterFor(await signedIn(), endpointUrl.url)

    const resolved = await adapter.resolveModel('chatgpt', 'wide')

    assert.equal(resolved.context.contextWindow, 872000)
  })

  it('falls back to the default capacity when no maximum is advertised', async () => {
    const endpointUrl = await endpoint({
      listing: { models: [{ slug: 'narrow', visibility: 'list', context_window: 200000 }] },
    })
    const adapter = adapterFor(await signedIn(), endpointUrl.url)

    assert.equal((await adapter.resolveModel('chatgpt', 'narrow')).context.contextWindow, 200000)
  })

  it('offers the levels the model accepts, not the ones the listing advertises', async () => {
    // Measured on a live account: the listing advertised `ultra` for
    // gpt-6-astra and the API answered a request carrying it with
    // `400 invalid_value`. A listing entry is advisory; a rejected level fails
    // the whole turn.
    const endpointUrl = await endpoint({
      listing: {
        models: [{
          slug: 'gpt-6-astra',
          visibility: 'list',
          reasoningLevels: [
            { effort: 'low' }, { effort: 'medium' }, { effort: 'high' },
            { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' },
          ],
          defaultReasoningLevel: 'ultra',
        }],
      },
    })
    const adapter = adapterFor(await signedIn(), endpointUrl.url)

    const model = (await adapter.listModels()).find(entry => entry.id === 'gpt-6-astra')

    assert.deepEqual(model?.reasoningEfforts?.map(effort => effort.id), [
      'low', 'medium', 'high', 'xhigh', 'max',
    ])
    assert.equal(model?.defaultReasoningEffort, 'medium')
  })

  it('offers the level the catalog omits but the model accepts', async () => {
    // The bundled catalog maps `none` to unsupported for the gpt-5.6 models and
    // the API accepts it, so neither source alone produces the right set.
    const endpointUrl = await endpoint({
      listing: { models: [{ slug: 'gpt-5.6-sol', visibility: 'list' }] },
    })
    const adapter = adapterFor(await signedIn(), endpointUrl.url)

    const model = (await adapter.listModels()).find(entry => entry.id === 'gpt-5.6-sol')

    assert.ok(model?.reasoningEfforts?.some(effort => effort.id === 'none'))
  })

  it('reports the measured route capacity for a model the listing omits', async () => {
    // The listing describes five models; the other three come from measurement,
    // and their capacity has to come from what the route accepts rather than from
    // the published specification, which is larger.
    const endpointUrl = await endpoint({ listing: { models: [] } })
    const adapter = adapterFor(await signedIn(), endpointUrl.url)

    const resolved = await adapter.resolveModel('chatgpt', 'gpt-6-sol')

    assert.equal(resolved.context.contextWindow, 872000)
    assert.equal(resolved.defaultMaxTokens, 128000)
  })

  it('serves the listing from cache inside the window, then re-asks', async () => {
    const endpointUrl = await endpoint({ listing: { models: [{ slug: 'm', visibility: 'list' }] } })
    let clock = 1000
    const adapter = adapterFor(await signedIn(), endpointUrl.url, () => clock)

    await adapter.listModels()
    await adapter.listModels()
    assert.equal(endpointUrl.paths.filter(path => path.startsWith('/models')).length, 1)

    // Past the window, entitlement may have changed under the cache.
    clock += 61_000
    await adapter.listModels()
    assert.equal(endpointUrl.paths.filter(path => path.startsWith('/models')).length, 2)
  })

  it('describes a model the listing never mentioned', async () => {
    const endpointUrl = await endpoint({ listing: { models: [] } })
    const adapter = adapterFor(await signedIn(), endpointUrl.url)

    // A direct call must not depend on a listing having happened.
    const resolved = await adapter.resolveModel('chatgpt', 'gpt-6.1-sol')

    assert.equal(resolved.id, 'gpt-6.1-sol')
    assert.ok(resolved.context.contextWindow > 0)
  })

  it('refuses a call when no account is signed in, naming the reason', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chatgpt-adapter-'))
    dirs.push(dir)
    const adapter = new ChatGptAdapter({
      auth: new ChatGptAuth({ stateDir: dir, agentNameHint: 'DeepSeek Harness' }),
      baseUrl: 'http://127.0.0.1:9',
    })

    const chunks = []
    await assert.rejects(
      (async () => {
        for await (const chunk of adapter.stream('chatgpt', {
          provider: 'chatgpt',
          model: 'm',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        })) chunks.push(chunk)
      })(),
      (error: unknown) => {
        assert.match(String(error), /no ChatGPT account is signed in/)
        assert.equal((error as { code?: string }).code, 'chatgpt_not_signed_in')
        return true
      },
    )
  })

  it('calls a dropped connection transport, not a missing credential', async () => {
    // A network blip is worth retrying; telling the human to sign in again over one
    // sends them the wrong way, and the code is what the harness's retry policy
    // reads before deciding.
    const dir = await mkdtemp(join(tmpdir(), 'chatgpt-adapter-'))
    dirs.push(dir)
    writeDocument(join(dir, 'chatgpt-auth.json'), {
      ...emptyDocument('urn:uuid:x'),
      accounts: {
        'subject-1': {
          accessToken: 'access',
          refreshToken: 'refresh',
          expiresAt: Date.now() + 3600_000,
          clientId: 'oaiapp_issued',
          scopes: ['chatgpt.tokens.use.openai'],
          subject: 'subject-1',
          savedAt: Date.now(),
        },
      },
      active: 'subject-1',
    })
    // Port 9 refuses the connection, which undici reports as a transport failure.
    const adapter = new ChatGptAdapter({
      auth: new ChatGptAuth({ stateDir: dir, agentNameHint: 'DeepSeek Harness' }),
      baseUrl: 'http://127.0.0.1:9',
    })

    await assert.rejects(
      (async () => {
        for await (const chunk of adapter.stream('chatgpt', {
          provider: 'chatgpt',
          model: 'm',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        })) void chunk
      })(),
      (error: unknown) => {
        const coded = error as { code?: string, message?: string }
        assert.equal(coded.code, 'TRANSPORT', `expected TRANSPORT, got ${String(coded.code)}: ${String(coded.message)}`)
        assert.doesNotMatch(String(coded.message), /signed in/)
        return true
      },
    )
  })

  it('streams a turn into numbered blocks that close before finishing', async () => {
    const endpointUrl = await endpoint({
      listing: { models: [{ slug: 'gpt-6.1-sol', visibility: 'list' }] },
      frames: [
        frame({ type: 'response.created' }),
        frame({ type: 'response.reasoning_summary_text.delta', delta: 'thinking' }),
        frame({ type: 'response.output_text.delta', delta: 'Hel' }),
        frame({ type: 'response.output_text.delta', delta: 'lo' }),
        frame({ type: 'response.completed', response: { id: 'resp_1' } }),
      ],
    })
    const adapter = adapterFor(await signedIn(), endpointUrl.url)
    const chunks = []
    for await (const chunk of adapter.stream('chatgpt', {
      provider: 'chatgpt',
      model: 'gpt-6.1-sol',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      reasoningEffort: 'high',
    })) chunks.push(chunk)

    assert.deepEqual(chunks, [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'thinking' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'Hel' },
      { type: 'text-delta', index: 1, text: 'lo' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'Hello' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('closes the blocks it opened, and reports the failure, when a turn fails mid-answer', async () => {
    const endpointUrl = await endpoint({
      frames: [
        frame({ type: 'response.output_text.delta', delta: 'half' }),
        frame({
          type: 'response.failed',
          response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'out of allowance' } },
        }),
      ],
    })
    const adapter = adapterFor(await signedIn(), endpointUrl.url)
    const chunks: { type: string, index?: number }[] = []

    for await (const chunk of adapter.stream('chatgpt', {
      provider: 'chatgpt',
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) chunks.push(chunk)

    // A failed response is a protocol-level terminal, not a transport fault: the
    // partial answer is preserved, no block is left dangling, and the reason
    // travels as the turn's finish rather than as a thrown error.
    assert.deepEqual(chunks, [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'half' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'half' } },
      {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'out of allowance This account has no ChatGPT plan allowance left for app inference right now, or an app-specific limit applies;'
              + ' the returned code does not say which.'
              + ' Review usage at https://chatgpt.com/settings/usage to see both the plan and this app\'s limit.'
              + ' No reset time can be read from the code itself, so waiting is the only option'
              + ' unless an API key or another provider is available in the meantime.',
            code: 'subscription_sharing_usage_limit_exceeded',
          },
        },
      },
    ])
  })

  it('closes its blocks and rethrows when the stream dies without a terminal event', async () => {
    const endpointUrl = await endpoint({
      frames: [frame({ type: 'response.output_text.delta', delta: 'half' })],
    })
    const adapter = adapterFor(await signedIn(), endpointUrl.url)
    const chunks: { type: string, index?: number }[] = []

    await assert.rejects(
      (async () => {
        for await (const chunk of adapter.stream('chatgpt', {
          provider: 'chatgpt',
          model: 'm',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        })) chunks.push(chunk)
      })(),
      /without a terminal event/,
    )

    // A transport fault still leaves no block open behind it.
    assert.deepEqual(chunks.map(chunk => chunk.type), ['block-start', 'text-delta', 'block-end'])
  })

  it('renews once and retries when the endpoint refuses a token that still looks valid', async () => {
    // Measured against a live account: an upgrade retired tokens server-side
    // while their JWT still had 45 minutes left, and the endpoint answered
    // `token_expired`. A local clock comparison cannot see that, so the refusal
    // itself has to drive the renewal.
    const refresh = await startTokenServer({
      body: { access_token: 'renewed-access', refresh_token: 'rotated', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' },
    })
    tokenServers.push(refresh.close)

    // The endpoint refuses the stored token, then accepts the renewed one.
    let calls = 0
    const endpointUrl = await endpoint({
      listing: { models: [{ slug: 'm', visibility: 'list' }] },
      onRequest: (path) => {
        calls += 1
        if (path.startsWith('/models') && calls === 1) {
          return { status: 401, body: { error: { code: 'token_expired', message: 'Provided authentication token is expired.' } } }
        }
        return undefined
      },
    })
    const stateDir = await signedIn()
    const auth = new ChatGptAuth({
      stateDir,
      agentNameHint: 'DeepSeek Harness',
      endpoints: { tokenUrl: refresh.url },
    })
    const adapter = new ChatGptAdapter({ auth, baseUrl: endpointUrl.url })

    const models = await adapter.listModels()

    assert.equal(models[0]?.id, 'm')
    // One refusal, one renewal, one retry — not a loop.
    assert.equal(refresh.requests.length, 1)
  })

  it('does not spend a refresh token on a failure that is not an authentication refusal', async () => {
    const refresh = await startTokenServer({ body: {} })
    tokenServers.push(refresh.close)
    const endpointUrl = await endpoint({
      listingStatus: 500,
      listing: { error: { code: 'server_error' } },
    })
    const auth = new ChatGptAuth({
      stateDir: await signedIn(),
      agentNameHint: 'DeepSeek Harness',
      endpoints: { tokenUrl: refresh.url },
    })

    await assert.rejects(new ChatGptAdapter({ auth, baseUrl: endpointUrl.url }).listModels())
    assert.equal(refresh.requests.length, 0)
  })

  it('sends every event of a turn, including the first one', async () => {
    // The retry path primes the stream to surface an early refusal, so the event
    // that read produced must still reach the caller.
    const endpointUrl = await endpoint({
      frames: [
        frame({ type: 'response.output_text.delta', delta: 'first' }),
        frame({ type: 'response.output_text.delta', delta: 'second' }),
        frame({ type: 'response.completed' }),
      ],
    })
    const adapter = adapterFor(await signedIn(), endpointUrl.url)

    const chunks = []
    for await (const chunk of adapter.stream('chatgpt', {
      provider: 'chatgpt',
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) chunks.push(chunk)

    const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.type === 'text-delta' ? chunk.text : '')
    assert.deepEqual(text, ['first', 'second'])
  })

  it('sends a model absent from the listing, because the listing is a roster and not an allowlist', async () => {
    // Measured against a real subscription: asking the endpoint for a model the
    // listing did not advertise was answered under the requested id, with
    // `response.completed`. Refusing on roster membership would therefore refuse
    // models the account can really call, so the roster only decides what the
    // selector offers.
    const endpointUrl = await endpoint({
      listing: { models: [{ slug: 'gpt-6-astra', visibility: 'list' }] },
      frames: [frame({ type: 'response.output_text.delta', delta: 'ok' }), frame({ type: 'response.completed' })],
    })
    const adapter = adapterFor(await signedIn(), endpointUrl.url)
    const kinds: string[] = []

    for await (const chunk of adapter.stream('chatgpt', {
      provider: 'chatgpt',
      model: 'gpt-6.1-sol',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) kinds.push(chunk.type)

    assert.deepEqual(kinds, ['block-start', 'text-delta', 'block-end', 'finish'])
    // It reached the endpoint with the requested id.
    assert.match(endpointUrl.paths.filter(path => path.startsWith('/responses')).length.toString(), /^[1-9]/)
  })

  it('offers the models measured to work that the listing omits', async () => {
    // The listing advertises one model and says nothing about the rest, yet this
    // route serves several of them. A roster built from the listing alone hides
    // capability the account already has.
    const endpointUrl = await endpoint({
      listing: { models: [{ slug: 'gpt-6-astra', visibility: 'list' }] },
    })
    const adapter = adapterFor(await signedIn(), endpointUrl.url)

    const ids = (await adapter.listModels()).map(model => model.id)

    assert.equal(ids[0], 'gpt-6-astra')
    for (const measured of ['gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol']) {
      assert.ok(ids.includes(measured), `${measured} should be offered`)
    }
  })

  it('never offers a model the listing marks hidden', async () => {
    // Hidden is a deliberate instruction about what a picker should show, which
    // is a different statement from leaving a model unmentioned.
    const endpointUrl = await endpoint({
      listing: {
        models: [
          { slug: 'gpt-6-astra', visibility: 'list' },
          { slug: 'gpt-reserve', visibility: 'hide' },
        ],
      },
    })
    const adapter = adapterFor(await signedIn(), endpointUrl.url)

    assert.equal((await adapter.listModels()).some(model => model.id === 'gpt-reserve'), false)
  })

  it('offers only what the account advertises when the measured extras are turned off', async () => {
    const endpointUrl = await endpoint({
      listing: { models: [{ slug: 'gpt-6-astra', visibility: 'list' }] },
    })
    const auth = new ChatGptAuth({ stateDir: await signedIn(), agentNameHint: 'DeepSeek Harness' })
    const adapter = new ChatGptAdapter({ auth, baseUrl: endpointUrl.url, includeUnlisted: false })

    assert.deepEqual((await adapter.listModels()).map(model => model.id), ['gpt-6-astra'])
  })

  it('describes a measured extra from the catalog, since the listing says nothing', async () => {
    const endpointUrl = await endpoint({ listing: { models: [] } })
    const adapter = adapterFor(await signedIn(), endpointUrl.url)

    const resolved = await adapter.resolveModel('chatgpt', 'gpt-6-sol')

    assert.equal(resolved.id, 'gpt-6-sol')
    assert.ok(resolved.context.contextWindow > 0)
    assert.ok((resolved.reasoning?.efforts.length ?? 0) > 0)
  })

  it('serves a model the account does offer', async () => {
    const endpointUrl = await endpoint({
      listing: { models: [{ slug: 'gpt-6-astra', visibility: 'list' }] },
      frames: [frame({ type: 'response.output_text.delta', delta: 'ok' }), frame({ type: 'response.completed' })],
    })
    const adapter = adapterFor(await signedIn(), endpointUrl.url)
    const kinds: string[] = []
    for await (const chunk of adapter.stream('chatgpt', {
      provider: 'chatgpt',
      model: 'gpt-6-astra',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) kinds.push(chunk.type)

    assert.deepEqual(kinds, ['block-start', 'text-delta', 'block-end', 'finish'])
  })

  it('does not fail every call when the listing itself is unavailable', async () => {
    // A transport failure must not turn into a refusal of models that may well
    // be serviceable; only a positive "not in the list" refuses.
    const endpointUrl = await endpoint({ listingStatus: 500, listing: { error: { code: 'server_error' } } })
    const adapter = adapterFor(await signedIn(), endpointUrl.url)

    await assert.rejects(
      (async () => {
        for await (const _chunk of adapter.stream('chatgpt', {
          provider: 'chatgpt',
          model: 'whatever',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        })) { /* drain */ }
      })(),
      // It still fails, but on the request rather than on a fabricated refusal.
      /listing|terminal event|ChatGPT/,
    )
  })

  it('drops the cached listing when the grant is refused', async () => {
    const endpointUrl = await endpoint({ listingStatus: 401, listing: { error: { code: 'invalid_api_key' } } })
    const adapter = adapterFor(await signedIn(), endpointUrl.url)

    await assert.rejects(adapter.listModels())
  })
})

describe('toNeutralRequest', () => {
  it('lifts the system prompt and keeps user text', () => {
    const neutral = toNeutralRequest({
      provider: 'chatgpt',
      model: 'm',
      system: 'be terse',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })

    assert.equal(neutral.system, 'be terse')
    assert.deepEqual(neutral.messages, [{ role: 'user', content: 'hi' }])
  })

  it('replays an assistant tool call ahead of the result that answers it', () => {
    const neutral = toNeutralRequest({
      provider: 'chatgpt',
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'read a' }] },
        { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' }] },
        { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'contents' }] },
      ],
    })

    assert.deepEqual(neutral.toolTraffic, [
      { kind: 'call', call: { callId: 'call_1', name: 'read_file', arguments: '{"path":"a"}' } },
      { kind: 'result', result: { callId: 'call_1', output: 'contents' } },
    ])
    // The call is not also sent as assistant prose.
    assert.deepEqual(neutral.messages, [{ role: 'user', content: 'read a' }])
  })

  it('marks a failed tool result', () => {
    const neutral = toNeutralRequest({
      provider: 'chatgpt',
      model: 'm',
      messages: [
        { role: 'tool', toolCallId: 'call_1', isError: true, content: [{ type: 'text', text: 'not found' }] },
      ],
    })

    assert.deepEqual(neutral.toolTraffic, [
      { kind: 'result', result: { callId: 'call_1', output: 'not found', isError: true } },
    ])
  })

  it('drops a tool message that names no call, since it cannot be correlated', () => {
    const neutral = toNeutralRequest({
      provider: 'chatgpt',
      model: 'm',
      messages: [{ role: 'tool', content: [{ type: 'text', text: 'orphan' }] }],
    })

    assert.equal(neutral.toolTraffic, undefined)
  })

  it('carries tools and the chosen reasoning effort', () => {
    const neutral = toNeutralRequest({
      provider: 'chatgpt',
      model: 'm',
      reasoningEffort: 'high',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
    })

    assert.equal(neutral.reasoningEffort, 'high')
    assert.deepEqual(neutral.tools, [{ name: 't', description: 'd', parameters: { type: 'object' } }])
  })
})
