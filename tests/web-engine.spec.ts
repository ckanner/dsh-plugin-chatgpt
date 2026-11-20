import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWebBridge, type OpenWebBridgeOptions } from '../src/web-bridge/engine.ts'
import { JOURNAL_FILE, JOURNAL_LOCK, PROFILE_LOCK, type JournalFaultPoint } from '../src/web-bridge/journal.ts'
import { requestHash } from '../src/web-bridge/protocol.ts'
import {
  WebBridgeError, type PageTurn, type WebBinding, type WebBridgeEngine, type WebMessage,
  type WebPageTransport, type WebRequest, type WebResponse,
} from '../src/web-bridge/contracts.ts'

const binding: WebBinding = {
  protocolVersion: 1, installationId: 'fixture-installation', provider: 'chatgpt',
  profileId: 'fixture-profile', accountBinding: 'fixture-account',
}
const directories: string[] = []
const engines = new Set<WebBridgeEngine>()

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function code(expected: string) {
  return (error: unknown) => {
    assert.ok(error instanceof WebBridgeError)
    assert.equal(error.code, expected)
    return true
  }
}

function request(overrides: Partial<WebRequest> = {}): WebRequest {
  const value: WebRequest = {
    ...binding, clientLeaseId: 'client-a', deliveryAttemptId: 'delivery-a',
    idempotencyKey: '', sessionId: 'session-a', purpose: 'normal', model: 'gpt-6-pro-web', reasoningEffort: 'pro',
    messages: [{ id: 'user-a', role: 'user', content: [{ type: 'text', text: 'Inspect the file' }] }],
    tools: [{ name: 'inspect', description: 'Inspect a named file', parameters: {
      type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
    } }],
    controls: {}, attachmentVersions: [], parentReceipt: null,
    ...overrides,
  }
  value.idempotencyKey = requestHash(value)
  return value
}

function turnId(value: WebRequest): string { return `turn-${value.idempotencyKey.slice(7)}` }
function access(value: WebRequest) { return { clientLeaseId: value.clientLeaseId, sessionId: value.sessionId } }
const textPage = { version: 1, complete: true, blocks: [{ type: 'text', text: 'Complete answer' }] }
const toolPage = { version: 1, complete: true, blocks: [{ type: 'tool-call', id: 'call-a', name: 'inspect', arguments: '{"path":"file.txt"}' }] }

function transport(overrides: Partial<WebPageTransport> = {}): WebPageTransport {
  return {
    async prepare() {},
    async submit() { return { promptId: 'page-prompt' } },
    async observe() { return textPage },
    ...overrides,
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'web-engine-'))
  directories.push(root)
  return { root, directory: join(root, 'journal'), profileDirectory: join(root, 'profile') }
}

async function open(options: Omit<OpenWebBridgeOptions, 'binding'> & { binding?: WebBinding }) {
  const engine = await openWebBridge({ binding, ...options })
  engines.add(engine)
  return engine
}

async function close(engine: WebBridgeEngine) {
  await engine.close()
  engines.delete(engine)
}

async function snapshot(directory: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(directory, JOURNAL_FILE), 'utf8')).value as Record<string, any>
}

function continuation(parentRequest: WebRequest, response: WebResponse, suffix: string, prefix = parentRequest.messages): WebRequest {
  const assistant: WebMessage = {
    id: `assistant-${suffix}`, role: 'assistant', content: structuredClone(response.blocks),
    source: { kind: 'model', provider: binding.provider, model: 'gpt-6-pro-web', replayState: { response: response.receipt } },
  }
  const results: WebMessage[] = response.blocks.flatMap(block => block.type === 'tool-call'
    ? [{ id: `result-${suffix}-${block.id}`, role: 'tool' as const, toolCallId: block.id, content: [{ type: 'text' as const, text: `result ${suffix}` }] }]
    : [])
  return request({ messages: [...prefix, assistant, ...results], parentReceipt: response.receipt, deliveryAttemptId: `delivery-${suffix}` })
}

afterEach(async () => {
  await Promise.all([...engines].map(close))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('durable Web bridge engine', () => {
  it('requires explicit first setup and persists each submission boundary before calling the transport', async () => {
    const paths = await fixture()
    await assert.rejects(open({ ...paths, transport: transport() }), code('WEB_SETUP_REQUIRED'))
    let prepares = 0
    let submits = 0
    const engine = await open({ ...paths, initialize: true, transport: transport({
      async prepare() {
        prepares++
        assert.equal((await snapshot(paths.directory)).turns[0].state, 'preparing')
      },
      async submit() {
        submits++
        assert.equal((await snapshot(paths.directory)).turns[0].state, 'submit_intent')
        return { promptId: 'positive-page-id' }
      },
      async observe() {
        const stored = (await snapshot(paths.directory)).turns[0]
        assert.equal(stored.state, 'observing')
        assert.equal(stored.promptId, 'positive-page-id')
        return textPage
      },
    }) })
    const input = request()
    const response = await engine.execute(input)
    assert.equal(response.finishReason, 'stop')
    assert.equal((await snapshot(paths.directory)).turns[0].state, 'completed')
    assert.deepEqual((await snapshot(paths.directory)).turns[0].response, response)
    assert.deepEqual(await engine.execute(request({ clientLeaseId: 'client-b', deliveryAttemptId: 'delivery-b' })), response)
    assert.equal(prepares, 1)
    assert.equal(submits, 1)
    assert.equal((await stat(join(paths.directory, JOURNAL_FILE))).mode & 0o777, 0o600)
    await close(engine)
    const reopened = await open({ ...paths, transport: transport({ async submit() { throw new Error('cached replay must not submit') } }) })
    assert.deepEqual(await reopened.execute(request({ clientLeaseId: 'new-lease' })), response)
  })

  for (const point of ['before-write', 'after-write', 'after-file-sync', 'after-rename', 'after-directory-sync'] as JournalFaultPoint[]) {
    it(`never submits after an injected submit-intent durability failure at ${point}`, async () => {
      const paths = await fixture()
      let submits = 0
      const engine = await open({ ...paths, initialize: true, transport: transport({ async submit() { submits++; return { promptId: 'must-not-send' } } }),
        journalFault(observed, value) {
          if (observed === point && (value as { turns: { state: string }[] }).turns.some(turn => turn.state === 'submit_intent')) {
            throw new Error(`injected ${point}`)
          }
        },
      })
      const input = request()
      await assert.rejects(engine.execute(input), code('WEB_JOURNAL_WRITE'))
      assert.equal(submits, 0)
      await assert.rejects(engine.execute(request({ sessionId: 'another-session' })), code('WEB_JOURNAL_UNAVAILABLE'))
      await close(engine)
      const recovered = await open({ ...paths, transport: transport() })
      const uncertain = point === 'after-rename' || point === 'after-directory-sync'
      await assert.rejects(recovered.execute(input), code(uncertain ? 'WEB_UNCERTAIN' : 'WEB_INTERRUPTED_BEFORE_SUBMIT'))
      const stored = await recovered.inspect(turnId(input), access(input))
      assert.equal(stored.state, uncertain ? 'uncertain' : 'failed')
      if (uncertain) await assert.rejects(recovered.execute(request({ sessionId: 'new-session' })), code('WEB_UNCERTAIN'))
      else assert.equal((await recovered.execute(request({ sessionId: 'new-session' }))).finishReason, 'stop')
    })
  }

  it('keeps an acknowledged Send with a lost response fenced across restart, new keys and discard', async () => {
    const paths = await fixture()
    let submits = 0
    const engine = await open({ ...paths, initialize: true, transport: transport({
      async submit() { submits++; throw new Error('remote accepted; acknowledgement was lost') },
    }) })
    const input = request()
    await assert.rejects(engine.execute(input), code('WEB_UNCERTAIN'))
    assert.equal(submits, 1)
    await close(engine)
    const reopened = await open({ ...paths, transport: transport({ async submit() { submits++; return { promptId: 'unexpected' } } }) })
    const nextLease = request({ clientLeaseId: 'restarted-client' })
    await assert.rejects(reopened.inspect(turnId(input), access(nextLease)), code('WEB_FORBIDDEN'))
    await assert.rejects(reopened.execute(nextLease), code('WEB_UNCERTAIN'))
    assert.equal((await reopened.inspect(turnId(input), access(nextLease))).state, 'uncertain')
    await assert.rejects(reopened.execute(request({ sessionId: 'new-session' })), code('WEB_UNCERTAIN'))
    const discarded = await reopened.discard(turnId(input), access(nextLease))
    assert.equal(discarded.discarded, true)
    assert.equal(discarded.state, 'uncertain')
    await assert.rejects(reopened.execute(request({ sessionId: 'new-session' })), code('WEB_UNCERTAIN'))
    assert.equal(submits, 1)
  })

  it('reconciles read-only evidence without resubmitting and requires exact-request participation after restart', async () => {
    const paths = await fixture()
    let submits = 0
    const engine = await open({ ...paths, initialize: true, transport: transport({
      async submit() { submits++; return { promptId: 'accepted' } },
      async observe() { throw new Error('lost page connection') },
    }) })
    const input = request()
    await assert.rejects(engine.execute(input), code('WEB_UNCERTAIN'))
    await close(engine)
    let recoveries = 0
    const restarted = await open({ ...paths, transport: transport({
      async submit() { submits++; throw new Error('recovery must not submit') },
      async recover(turn) { recoveries++; assert.equal(turn.turnId, turnId(input)); return { kind: 'completed', response: textPage } },
    }) })
    const rejoined = request({ clientLeaseId: 'rejoined' })
    await assert.rejects(restarted.recover(turnId(input), access(rejoined)), code('WEB_FORBIDDEN'))
    await assert.rejects(restarted.execute(rejoined), code('WEB_UNCERTAIN'))
    const state = await restarted.recover(turnId(input), access(rejoined))
    assert.equal(state.state, 'completed')
    assert.equal(state.response?.finishReason, 'stop')
    assert.equal((await restarted.execute(rejoined)).finishReason, 'stop')
    assert.equal(recoveries, 1)
    assert.equal(submits, 1)
  })

  it('retains a proven-not-submitted request tombstone instead of sending it after recovery', async () => {
    const paths = await fixture()
    let submits = 0
    const engine = await open({ ...paths, initialize: true, transport: transport({
      async submit() { if (++submits === 1) throw new Error('submission status lost'); return { promptId: 'new-input' } },
      async recover() { return { kind: 'not-submitted' } },
    }) })
    const input = request()
    await assert.rejects(engine.execute(input), code('WEB_UNCERTAIN'))
    assert.equal((await engine.recover(turnId(input), access(input))).state, 'failed')
    await assert.rejects(engine.execute(input), code('WEB_NOT_SUBMITTED'))
    await engine.execute(request({ sessionId: 'new-operation' }))
    assert.equal(submits, 2)
  })

  it('shares one browser operation but grants only one executable delivery even to identical owner retries', async () => {
    const paths = await fixture()
    const observing = deferred<void>()
    const finish = deferred<void>()
    let submits = 0
    const engine = await open({ ...paths, initialize: true, transport: transport({
      async submit() { submits++; return { promptId: 'one-submit' } },
      async observe() { observing.resolve(); await finish.promise; return toolPage },
    }) })
    const a = request()
    const b = request({ clientLeaseId: 'client-b', deliveryAttemptId: 'delivery-b' })
    const first = engine.execute(a)
    const second = engine.execute(b)
    const results = Promise.allSettled([first, second])
    await observing.promise
    finish.resolve()
    const settled = await results
    assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1)
    const denied = settled.find(item => item.status === 'rejected')
    assert.ok(denied?.status === 'rejected')
    code('WEB_DELIVERY_CLAIMED')(denied.reason)
    assert.equal(submits, 1)
    const stored = await engine.inspect(turnId(a), access(b))
    assert.equal(stored.deliveryState, 'delivery-intent')
    const winner = settled[0]?.status === 'fulfilled' ? a : b
    const loser = winner === a ? b : a
    assert.equal((await engine.inspect(turnId(a), access(loser))).deliveryOwner, undefined)
    assert.deepEqual((await engine.inspect(turnId(a), access(winner))).deliveryOwner, {
      clientLeaseId: winner.clientLeaseId, deliveryAttemptId: winner.deliveryAttemptId,
    })
    const retry = request({ clientLeaseId: winner.clientLeaseId, deliveryAttemptId: winner.deliveryAttemptId })
    await assert.rejects(engine.execute(retry), code('WEB_DELIVERY_CLAIMED'))
    await assert.rejects(engine.cancel(turnId(a), access(b)), code('WEB_FORBIDDEN'))
    await close(engine)
    const reopened = await open({ ...paths, transport: transport() })
    await assert.rejects(reopened.execute(request({ clientLeaseId: 'new-client' })), code('WEB_DELIVERY_CLAIMED'))
  })

  it('checks authorization before claiming delivery and permits an authorized first owner if nothing was exposed', async () => {
    const paths = await fixture()
    const engine = await open({ ...paths, initialize: true, transport: transport({ async observe() { return toolPage } }) })
    const input = request()
    let checks = 0
    await assert.rejects(engine.execute(input, { authorizeDelivery() { checks++; throw new WebBridgeError('WEB_LEASE_EXPIRED', 'Expired') } }), code('WEB_LEASE_EXPIRED'))
    assert.equal(checks, 1)
    assert.equal((await engine.inspect(turnId(input), access(input))).deliveryState, 'unclaimed')
    const allowed = request({ clientLeaseId: 'authorized', deliveryAttemptId: 'new-attempt' })
    assert.equal((await engine.execute(allowed)).finishReason, 'tool-calls')
    assert.equal((await engine.inspect(turnId(input), access(allowed))).deliveryOwner?.clientLeaseId, 'authorized')
  })

  it('does not deliver after lease expiry during claim fsync and never transfers the consumed claim', async () => {
    const paths = await fixture()
    let expired = false
    const engine = await open({ ...paths, initialize: true, transport: transport({ async observe() { return toolPage } }),
      journalFault(point, value) {
        if (point === 'after-directory-sync' && (value as { turns: { deliveryState: string }[] }).turns.some(turn => turn.deliveryState === 'delivery-intent')) expired = true
      },
    })
    const input = request()
    await assert.rejects(engine.execute(input, { authorizeDelivery() { if (expired) throw new WebBridgeError('WEB_LEASE_EXPIRED', 'Expired during sync') } }), code('WEB_LEASE_EXPIRED'))
    assert.equal((await engine.inspect(turnId(input), access(input))).deliveryState, 'delivery-intent')
    await assert.rejects(engine.execute(request({ clientLeaseId: 'another-client' })), code('WEB_DELIVERY_CLAIMED'))
  })

  it('never exposes a tool response whose cache failed durability', async () => {
    const paths = await fixture()
    const engine = await open({ ...paths, initialize: true, transport: transport({ async observe() { return toolPage } }),
      journalFault(point, value) {
        if (point === 'after-file-sync' && (value as { turns: { state: string }[] }).turns.some(turn => turn.state === 'completed')) throw new Error('response cache sync failed')
      },
    })
    await assert.rejects(engine.execute(request()), code('WEB_JOURNAL_WRITE'))
    assert.equal((await snapshot(paths.directory)).turns[0].state, 'observing')
    await close(engine)
    const reopened = await open({ ...paths, transport: transport() })
    await assert.rejects(reopened.execute(request()), code('WEB_UNCERTAIN'))
  })

  it('validates complete tool result sets, reuses only the current exact prefix and forks stale tips', async () => {
    const paths = await fixture()
    const generations: string[] = []
    let submits = 0
    const engine = await open({ ...paths, initialize: true, transport: transport({
      async prepare(turn) { generations.push(turn.generationId) },
      async submit() { submits++; return { promptId: `prompt-${submits}` } },
      async observe() { return submits === 1 ? toolPage : textPage },
    }) })
    const input = request()
    const toolResponse = await engine.execute(input)
    const incomplete = continuation(input, toolResponse, 'missing')
    incomplete.messages.pop()
    incomplete.idempotencyKey = requestHash(incomplete)
    await assert.rejects(engine.execute(incomplete), code('WEB_INVALID_CONTINUATION'))
    assert.equal(submits, 1)
    const next = continuation(input, toolResponse, 'valid')
    const final = await engine.execute(next)
    assert.equal(final.receipt.generationId, toolResponse.receipt.generationId)
    const sibling = continuation(input, toolResponse, 'sibling')
    const fork = await engine.execute(sibling)
    assert.notEqual(fork.receipt.generationId, toolResponse.receipt.generationId)
    const changed = continuation(next, final, 'changed', [
      { id: 'compacted-prefix', role: 'user', content: [{ type: 'text', text: 'Compacted history' }] },
    ])
    const replaced = await engine.execute(changed)
    assert.notEqual(replaced.receipt.generationId, final.receipt.generationId)
    assert.equal(generations.length, 4)
    assert.equal(submits, 4)
  })

  it('does not adopt a copied receipt in another session or accept a changed body under an old key', async () => {
    const paths = await fixture()
    let submits = 0
    const engine = await open({ ...paths, initialize: true, transport: transport({
      async submit() { submits++; return { promptId: 'one' } }, async observe() { return toolPage },
    }) })
    const input = request()
    const response = await engine.execute(input)
    const fork = continuation(input, response, 'fork')
    fork.sessionId = 'forked-session'
    fork.idempotencyKey = requestHash(fork)
    await assert.rejects(engine.execute(fork), code('WEB_INVALID_RECEIPT'))
    const mismatch = structuredClone(input)
    mismatch.messages[0]!.content = [{ type: 'text', text: 'Different input' }]
    await assert.rejects(engine.execute(mismatch), code('WEB_IDEMPOTENCY_CONFLICT'))
    assert.equal(submits, 1)
  })

  it('serializes different requests and releasing a queued client never aborts another owner', async () => {
    const paths = await fixture()
    const entered = deferred<void>()
    const ready = deferred<void>()
    let firstSignal: AbortSignal | undefined
    let submits = 0
    const engine = await open({ ...paths, initialize: true, transport: transport({
      async prepare(turn, signal) {
        if (turn.request.clientLeaseId === 'client-a') { firstSignal = signal; entered.resolve(); await ready.promise }
      },
      async submit() { submits++; return { promptId: 'serial' } },
    }) })
    const first = engine.execute(request())
    const queued = engine.execute(request({ clientLeaseId: 'client-b', sessionId: 'session-b' }))
    const queuedResult = assert.rejects(queued, code('WEB_CANCELLED'))
    await entered.promise
    try {
      await engine.releaseClient('client-b')
      assert.equal(firstSignal?.aborted, false)
    } finally { ready.resolve() }
    assert.equal((await first).finishReason, 'stop')
    await queuedResult
    assert.equal(submits, 1)
  })

  it('holds the physical-profile lock until an uncooperative cancelled submit has actually settled', async () => {
    const paths = await fixture()
    const entered = deferred<void>()
    const finish = deferred<void>()
    const engine = await open({ ...paths, initialize: true, transport: transport({
      async submit() { entered.resolve(); await finish.promise; return { promptId: 'late-ack' } },
    }) })
    const executing = engine.execute(request())
    const failed = assert.rejects(executing, code('WEB_UNCERTAIN'))
    await entered.promise
    let closed = false
    const closing = close(engine).then(() => { closed = true })
    try {
      await assert.rejects(open({ ...paths, transport: transport() }), code('WEB_PROFILE_LOCKED'))
      assert.equal(closed, false)
    } finally { finish.resolve() }
    await failed
    await closing
    const reopened = await open({ ...paths, transport: transport() })
    await assert.rejects(reopened.execute(request()), code('WEB_UNCERTAIN'))
  })

  it('locks the real physical profile across journal directories and symlink aliases', async () => {
    const paths = await fixture()
    const engine = await open({ ...paths, initialize: true, transport: transport() })
    const alias = join(paths.root, 'profile-alias')
    await symlink(paths.profileDirectory, alias)
    await assert.rejects(open({ ...paths, directory: join(paths.root, 'other-journal'), profileDirectory: alias, initialize: true, transport: transport() }), code('WEB_PROFILE_LOCKED'))
    await close(engine)
    await assert.rejects(open({ ...paths, directory: join(paths.root, 'other-journal'), initialize: true, transport: transport() }), code('WEB_JOURNAL_MISSING'))
    const samePhysical = await open({ ...paths, profileDirectory: alias, transport: transport() })
    assert.equal((await samePhysical.execute(request())).finishReason, 'stop')
  })

  it('fails closed on lost journals even when initialize is explicitly passed again', async () => {
    const paths = await fixture()
    const engine = await open({ ...paths, initialize: true, transport: transport() })
    await close(engine)
    await rm(join(paths.directory, JOURNAL_FILE))
    await assert.rejects(open({ ...paths, initialize: true, transport: transport() }), code('WEB_JOURNAL_MISSING'))
  })

  it('rejects corrupt and semantically inconsistent snapshots instead of opening a fresh registry', async () => {
    const paths = await fixture()
    const engine = await open({ ...paths, initialize: true, transport: transport() })
    await engine.execute(request())
    await close(engine)
    const path = join(paths.directory, JOURNAL_FILE)
    const original = await readFile(path, 'utf8')
    await writeFile(path, '{ torn', { mode: 0o600 })
    await assert.rejects(open({ ...paths, transport: transport() }), code('WEB_JOURNAL_CORRUPT'))
    const envelope = JSON.parse(original)
    envelope.value.turns[0].response.blocks[0].text = 'Changed after receipt'
    envelope.checksum = createHash('sha256').update(JSON.stringify(envelope.value)).digest('hex')
    await writeFile(path, JSON.stringify(envelope), { mode: 0o600 })
    await assert.rejects(open({ ...paths, transport: transport() }), code('WEB_JOURNAL_CORRUPT'))
  })

  it('rejects permissive directories, public journal files and symlinked evidence without chmodding them', async () => {
    const paths = await fixture()
    await mkdir(paths.directory, { mode: 0o755 })
    await assert.rejects(open({ ...paths, initialize: true, transport: transport() }), code('WEB_JOURNAL_PERMISSIONS'))
    assert.equal((await stat(paths.directory)).mode & 0o777, 0o755)
    await chmod(paths.directory, 0o700)
    const engine = await open({ ...paths, initialize: true, transport: transport() })
    await close(engine)
    const path = join(paths.directory, JOURNAL_FILE)
    await chmod(path, 0o644)
    await assert.rejects(open({ ...paths, transport: transport() }), code('WEB_JOURNAL_PERMISSIONS'))
    await chmod(path, 0o600)
    const bytes = await readFile(path)
    const outside = join(paths.root, 'evidence-copy.json')
    await writeFile(outside, bytes, { mode: 0o600 })
    await rm(path)
    await symlink(outside, path)
    await assert.rejects(open({ ...paths, transport: transport() }), code('WEB_JOURNAL_PERMISSIONS'))
  })

  it('does not reclaim a crashed process lock by PID and restores its submitted intent only after explicit offline cleanup', async () => {
    const paths = await fixture()
    const sent = join(paths.root, 'send-observed')
    const script = `
      import { openWebBridge } from ${JSON.stringify(new URL('../src/web-bridge/engine.ts', import.meta.url).href)};
      import { writeFile } from 'node:fs/promises';
      const engine = await openWebBridge({
        directory: ${JSON.stringify(paths.directory)}, profileDirectory: ${JSON.stringify(paths.profileDirectory)},
        binding: ${JSON.stringify(binding)}, initialize: true,
        transport: {
          async prepare() {},
          async submit() { await writeFile(${JSON.stringify(sent)}, 'one remote action'); process.exit(73); },
          async observe() { throw new Error('unreachable'); }
        }
      });
      await engine.execute(${JSON.stringify(request())});
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const [exit] = await once(child, 'close')
    assert.equal(exit, 73, stderr)
    assert.equal(await readFile(sent, 'utf8'), 'one remote action')
    assert.equal((await snapshot(paths.directory)).turns[0].state, 'submit_intent')
    await assert.rejects(open({ ...paths, transport: transport() }), code('WEB_PROFILE_LOCKED'))
    // This test acts as an offline operator after observing the exact child
    // exit. Production open never performs either cleanup based on a PID.
    await rm(join(paths.profileDirectory, PROFILE_LOCK), { recursive: true })
    await rm(join(paths.directory, JOURNAL_LOCK), { recursive: true })
    const reopened = await open({ ...paths, transport: transport({ async submit() { throw new Error('must never resubmit') } }) })
    await assert.rejects(reopened.execute(request()), code('WEB_UNCERTAIN'))
    assert.equal((await reopened.inspect(turnId(request()), access(request()))).state, 'uncertain')
  })
})
