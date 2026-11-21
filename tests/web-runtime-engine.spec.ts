import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openWebBridge } from '../src/web-bridge/engine.ts'
import { acquireProfileOwnership, assertProfileOwnership, JOURNAL_FILE } from '../src/web-bridge/journal.ts'
import { requestHash } from '../src/web-bridge/protocol.ts'
import type { WebBinding, WebPageTransport, WebRequest } from '../src/web-bridge/contracts.ts'

const binding: WebBinding = { protocolVersion: 1, installationId: 'runtime-installation', provider: 'chatgpt', profileId: 'runtime-profile', accountBinding: 'runtime-account' }
const page = { version: 1, complete: true, blocks: [{ type: 'text', text: 'complete' }] }
const toolPage = { version: 1, complete: true, blocks: [{ type: 'tool-call', id: 'read', name: 'read', arguments: '{}' }] }
function request(sessionId = 'session'): WebRequest {
  const value: WebRequest = { ...binding, clientLeaseId: 'private-client', deliveryAttemptId: 'private-attempt', idempotencyKey: '',
    sessionId, purpose: 'normal', model: 'gpt-6-pro-web', reasoningEffort: 'pro',
    messages: [{ id: 'user', role: 'user', content: [{ type: 'text', text: 'Read' }] }],
    tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } }], controls: {}, attachmentVersions: [], parentReceipt: null }
  value.idempotencyKey = requestHash(value)
  return value
}
function transport(overrides: Partial<WebPageTransport> = {}): WebPageTransport {
  return { async prepare() {}, async submit() { return { promptId: 'prompt' } }, async observe() { return page }, ...overrides }
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'web-runtime-engine-'))
  const cleanup: (() => Promise<unknown>)[] = []
  t.after(async () => {
    for (const close of cleanup.reverse()) await close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, directory: join(root, 'journal'), profileDirectory: join(root, 'profile'), binding, cleanup }
}
const turnId = (value: WebRequest) => `turn-${value.idempotencyKey.slice(7)}`

test('external profile ownership is unforgeable, exclusively borrowed, and retained until Chrome can stop', async t => {
  const paths = await fixture(t)
  const owner = await acquireProfileOwnership({ profileDirectory: paths.profileDirectory, initialize: true })
  paths.cleanup.push(() => owner.release())
  assert.throws(() => assertProfileOwnership({ ...owner }, paths.profileDirectory), { code: 'WEB_PROFILE_OWNERSHIP' })
  const options = { ...paths, profileOwnership: owner, initialize: true, transport: transport() }
  const engine = await openWebBridge(options)
  paths.cleanup.push(() => engine.close())
  await assert.rejects(owner.release(), { code: 'WEB_PROFILE_IN_USE' })
  await assert.rejects(openWebBridge(options), { code: 'WEB_PROFILE_OWNERSHIP' })
  await engine.close()
  await assert.rejects(acquireProfileOwnership({ profileDirectory: paths.profileDirectory }), { code: 'WEB_PROFILE_LOCKED' })
  await owner.release()
  assert.throws(() => assertProfileOwnership(owner, paths.profileDirectory), { code: 'WEB_PROFILE_OWNERSHIP' })
  const next = await acquireProfileOwnership({ profileDirectory: paths.profileDirectory })
  await next.release()
})

test('admin inspection and reconciliation do not consume delivery claims or grant client capabilities', async t => {
  const paths = await fixture(t)
  let sends = 0
  const engine = await openWebBridge({ ...paths, initialize: true, transport: transport({
    async submit() { sends++; throw new Error('lost outcome') }, async recover() { return { kind: 'completed', response: toolPage } },
  }) })
  paths.cleanup.push(() => engine.close())
  const input = request()
  await assert.rejects(engine.execute(input), { code: 'WEB_UNCERTAIN' })
  const recovered = await engine.administration.recover(turnId(input))
  assert.equal(recovered.state, 'completed')
  assert.equal(recovered.deliveryState, 'unclaimed')
  assert.equal(recovered.deliveryOwner, undefined)
  assert.equal((await engine.administration.list())[0]?.response, undefined)
  await assert.rejects(engine.inspect(turnId(input), { clientLeaseId: 'unauthorized', sessionId: input.sessionId }), { code: 'WEB_FORBIDDEN' })
  assert.equal((await engine.execute(input)).finishReason, 'tool-calls')
  assert.equal((await engine.administration.inspect(turnId(input))).deliveryOwner, undefined)
  assert.equal(JSON.stringify(await engine.administration.list()).includes('private-client'), false)
  await assert.rejects(engine.execute(input), { code: 'WEB_DELIVERY_CLAIMED' })
  assert.equal(sends, 1)
})

test('discard commits first, fences local disposition failures, and retries the idempotent hook on reopen', async t => {
  const paths = await fixture(t)
  const input = request()
  let attempts = 0
  let fail = true
  const adapter = transport({ async discard(turn) {
    const stored = JSON.parse(await readFile(join(paths.directory, JOURNAL_FILE), 'utf8')).value.turns
    assert.equal(stored.find((item: { turnId: string }) => item.turnId === turn.turnId).discarded, true)
    attempts++
    if (fail) throw new Error('interrupted local ledger write')
  } })
  const engine = await openWebBridge({ ...paths, initialize: true, transport: adapter })
  paths.cleanup.push(() => engine.close())
  await engine.execute(input)
  await assert.rejects(engine.administration.discard(turnId(input)), { code: 'WEB_DISCARD_PENDING' })
  assert.equal((await engine.administration.inspect(turnId(input))).discarded, true)
  await assert.rejects(engine.execute(request('new')), { code: 'WEB_DISCARD_PENDING' })
  await engine.close()
  fail = false
  const reopened = await openWebBridge({ ...paths, transport: adapter })
  paths.cleanup.push(() => reopened.close())
  assert.equal(attempts, 2)
  await assert.rejects(reopened.execute(input), { code: 'WEB_DISCARDED' })
  assert.equal((await reopened.execute(request('new'))).finishReason, 'stop')
})

test('discard never clears an unknown remote outcome even when local abandonment succeeds', async t => {
  const paths = await fixture(t)
  let discards = 0
  const engine = await openWebBridge({ ...paths, initialize: true, transport: transport({
    async submit() { throw new Error('unknown') }, async discard() { discards++ }, async recover() { return { kind: 'unknown' } },
  }) })
  paths.cleanup.push(() => engine.close())
  const input = request()
  await assert.rejects(engine.execute(input), { code: 'WEB_UNCERTAIN' })
  assert.equal((await engine.administration.discard(turnId(input))).state, 'uncertain')
  assert.equal((await engine.administration.recover(turnId(input))).state, 'uncertain')
  assert.equal(discards, 1)
  await assert.rejects(engine.execute(request('other')), { code: 'WEB_UNCERTAIN', requestId: turnId(input) })
})
