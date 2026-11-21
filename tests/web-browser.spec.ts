import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { chromeFixture, type ChromeFixture } from './fixtures/web-browser/chrome.ts'
import { accountBindingForVisibleIdentity, createChromePageTransport, inspectChromeSetup } from '../src/web-browser/index.ts'
import { BROWSER_LEDGER_FILE } from '../src/web-browser/ledger.ts'
import { parseResponse, renderPrompt } from '../src/web-browser/envelope.ts'
import { createResponse, requestHash, validatePageResponse, WEB_MAX_JSON_BYTES } from '../src/web-bridge/protocol.ts'
import { imageDigest, uploadName } from '../src/web-bridge/attachments.ts'
import { WebBridgeError, type PageTurn, type WebRequest, type WebResponse } from '../src/web-bridge/contracts.ts'
import { openWebBridge } from '../src/web-bridge/engine.ts'

const fixtures: ChromeFixture[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close() })
async function fixture(): Promise<ChromeFixture> { const value = await chromeFixture(); fixtures.push(value); return value }
const signal = (): AbortSignal => new AbortController().signal
function code(expected: string) { return (error: unknown): boolean => error instanceof WebBridgeError && error.code === expected }
function turn(overrides: Partial<WebRequest> = {}, generationId = 'generation-one'): PageTurn {
  const request: WebRequest = { protocolVersion: 1, installationId: 'fixture-installation', provider: 'chatgpt', profileId: 'fixture-profile',
    accountBinding: accountBindingForVisibleIdentity('owner@example.test'), clientLeaseId: 'private-client-lease', deliveryAttemptId: 'attempt-one',
    idempotencyKey: '', sessionId: 'session-one', purpose: 'normal', model: 'gpt-6-pro-web', reasoningEffort: 'pro',
    system: 'Be precise.', messages: [{ id: 'user-one', role: 'user', content: [{ type: 'text', text: 'Inspect the README' }] }],
    tools: [{ name: 'read_file', description: 'Read one local file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }],
    controls: {}, attachmentVersions: [], parentReceipt: null, ...overrides }
  request.idempotencyKey = requestHash(request)
  return { request, turnId: `turn-${request.idempotencyKey.slice(7)}`, generationId }
}
async function complete(f: ChromeFixture, current = turn(), extra = {}) {
  const transport = await f.transport(extra)
  await transport.prepare(current, signal())
  const sent = await transport.submit(current, signal())
  const raw = await transport.observe(current, sent.promptId, signal())
  const response = createResponse(current.request, current.turnId, current.generationId, validatePageResponse(raw, current.request, current.turnId))
  return { transport, response }
}
function continuation(previous: PageTurn, response: WebResponse): PageTurn {
  const calls = response.blocks.filter(block => block.type === 'tool-call')
  return turn({ messages: [...previous.request.messages, { id: 'assistant-one', role: 'assistant', content: response.blocks,
    source: { kind: 'model', provider: 'chatgpt', model: 'gpt-6-pro-web', replayState: { response: response.receipt } } },
    ...calls.map(call => ({ id: `result-${call.id}`, role: 'tool' as const, toolCallId: call.id, content: [{ type: 'text' as const, text: 'README content' }] })),
    { id: 'user-two', role: 'user', content: [{ type: 'text', text: 'Continue' }] }], parentReceipt: response.receipt, deliveryAttemptId: 'attempt-two' }, previous.generationId)
}

describe('owned Chromium website transport', { skip: process.env['DSH_TEST_BROWSER'] !== '1' ? 'Set DSH_TEST_BROWSER=1 in an environment that permits real Chromium; enabled failures are never skipped.' : false }, () => {
  it('observes setup, creates a private Project and sends only after durable intents; disconnect preserves Chrome', async () => {
    const f = await fixture()
    const evidence = await inspectChromeSetup(f.options)
    assert.equal(evidence.ready, true)
    assert.equal(evidence.visibleAccount, 'owner@example.test')
    assert.equal(evidence.accountBinding, f.options.expectedAccountBinding)
    assert.equal(evidence.model, 'GPT-6'); assert.equal(evidence.effort, 'Pro')
    assert.equal(f.process.exitCode, null)
    const { transport, response } = await complete(f)
    assert.deepEqual(response.blocks, [{ type: 'text', text: 'Fixture answer' }])
    assert.deepEqual(f.actions.map(action => action.kind), ['create', 'send'])
    assert.deepEqual(f.intentKinds, ['project-create', 'send'])
    const prompt = String(f.actions.find(action => action.kind === 'send')!.prompt)
    assert.ok(!prompt.includes('private-client-lease'))
    assert.ok(!prompt.includes('owner@example.test'))
    assert.ok(!prompt.includes('fixture-account'))
    assert.equal(JSON.parse(prompt).request.system, 'Be precise.')
    assert.equal((await transport.recover(turn())).kind, 'completed')
    await transport.close()
    assert.equal(f.process.exitCode, null)
    assert.equal((await f.page.title()), 'Owned ChatGPT UI fixture')
    assert.equal(await f.page.evaluate(() => (window as unknown as { fixture: { strayEscapes?: number } }).fixture.strayEscapes ?? 0), 0)
  })

  it('reuses only a verified prefix and creates a new empty Project for a fresh generation', async () => {
    const f = await fixture(); await f.set({ answerMode: 'tool' })
    const first = turn(); const { transport, response } = await complete(f, first)
    const next = continuation(first, response)
    await f.set({ answerMode: 'text' })
    await transport.prepare(next, signal()); const second = await transport.submit(next, signal()); await transport.observe(next, second.promptId, signal())
    assert.equal(f.actions.filter(action => action.kind === 'create').length, 1)
    const sent = f.actions.filter(action => action.kind === 'send')
    const secondEnvelope = JSON.parse(String(sent[1]!.prompt))
    assert.equal(secondEnvelope.projection, 'append-to-verified-history')
    assert.equal(secondEnvelope.request.messages[0].role, 'assistant')
    assert.equal(secondEnvelope.request.messages.some((message: { role: string, content: unknown }) => message.role === 'tool'), true)
    assert.equal(secondEnvelope.request.messages.length, next.request.messages.length - first.request.messages.length)
    const compacted = turn({ messages: [{ id: 'summary', role: 'user', content: [{ type: 'text', text: 'Current compacted context' }] }] }, 'generation-two')
    await transport.prepare(compacted, signal()); const third = await transport.submit(compacted, signal()); await transport.observe(compacted, third.promptId, signal())
    assert.equal(f.actions.filter(action => action.kind === 'create').length, 2)
    const last = JSON.parse(String(f.actions.filter(action => action.kind === 'send')[2]!.prompt))
    assert.equal(last.projection, 'full-current-history')
    assert.equal(last.request.messages.length, 1)
  })

  for (const [name, change, expected] of [
    ['account', { email: 'another@example.test' }, 'WEB_BROWSER_ACCOUNT'],
    ['account during model inspection', { accountOnModelInspect: 'another@example.test' }, 'WEB_BROWSER_ACCOUNT'],
    ['model', { model: 'GPT-5' }, 'WEB_BROWSER_MODEL'],
    ['effort', { effort: 'High' }, 'WEB_BROWSER_MODEL'],
    ['contradictory model state', { modelConflict: true }, 'WEB_BROWSER_MODEL'],
    ['hosted mode', { hostedTools: true }, 'WEB_BROWSER_DRIFT'],
  ] as const) it(`rejects same-URL ${name} drift between preparation and any mutation`, async () => {
    const f = await fixture(); const transport = await f.transport(); const request = turn()
    await transport.prepare(request, signal()); const beforeUrl = f.page.url()
    await f.set(change); assert.equal(f.page.url(), beforeUrl)
    await assert.rejects(transport.submit(request, signal()), code(expected))
    assert.equal(f.actions.length, 0)
    const ledger = JSON.parse(await readFile(join(f.stateDirectory, BROWSER_LEDGER_FILE), 'utf8'))
    assert.equal(ledger.data.mutations.length, 0)
  })

  it('uploads exact image bytes with their own intent and proves attachment completion before Send', async () => {
    const f = await fixture()
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64')
    const digest = imageDigest(bytes), name = uploadName(digest, 'image/png')
    const request = turn({ messages: [{ role: 'user', id: 'image-user', content: [{ type: 'text', text: 'Read this image' }, { type: 'image', attachmentVersion: digest }] }],
      attachmentVersions: [{ id: digest, digest, mimeType: 'image/png', byteLength: bytes.byteLength, uploadName: name, base64: bytes.toString('base64') }] })
    const { transport } = await complete(f, request)
    assert.deepEqual(f.actions.map(action => action.kind), ['create', 'upload', 'send'])
    assert.deepEqual(f.intentKinds, ['project-create', 'image-upload', 'send'])
    assert.deepEqual(f.actions.find(action => action.kind === 'upload'), { kind: 'upload', name, size: bytes.byteLength, mimeType: 'image/png' })
    assert.equal((await transport.recover(request)).kind, 'completed')
  })

  it('fences an uncertain Send, then read-only recovery observes completion without resubmission', async () => {
    const f = await fixture(); const current = turn()
    const transport = await f.transport({ testOnlyLedgerFault(point, action) { if (point === 'before-observed' && action.kind === 'send') throw new Error('simulated post-send crash') } })
    await transport.prepare(current, signal())
    await assert.rejects(transport.submit(current, signal()), /simulated post-send crash/)
    assert.equal(f.actions.filter(action => action.kind === 'send').length, 1)
    await transport.close()
    const reopened = await f.transport({ initialize: false })
    await assert.rejects(reopened.prepare(turn({ sessionId: 'other-session' }), signal()), code('WEB_BROWSER_UNCERTAIN'))
    const recovered = await reopened.recover(current)
    assert.equal(recovered.kind, 'completed')
    assert.equal(f.actions.filter(action => action.kind === 'send').length, 1)
  })

  it('recovery never replaces a positively observed prompt ID with another same-text message', async () => {
    const f = await fixture(), current = turn(), transport = await f.transport()
    await transport.prepare(current, signal()); const sent = await transport.submit(current, signal())
    await transport.close()
    await f.page.evaluate(() => {
      const page = window as unknown as { fixture: { messages: Array<{ role: string, id: string }> }, renderFixture(): void }
      page.fixture.messages.find(message => message.role === 'user')!.id = 'replacement-user-with-same-text'
      page.renderFixture()
    })
    const reopened = await f.transport({ initialize: false })
    assert.equal((await reopened.recover(current)).kind, 'unknown')
    const saved = JSON.parse(await readFile(join(f.stateDirectory, BROWSER_LEDGER_FILE), 'utf8')).data
    assert.equal(saved.turns[0].promptId, sent.promptId)
    assert.equal(f.actions.filter(action => action.kind === 'send').length, 1)
  })

  it('recovery never replaces a known conversation URL after a same-Project redirect', async () => {
    const f = await fixture(), current = turn(), transport = await f.transport()
    await transport.prepare(current, signal()); await transport.submit(current, signal())
    const knownUrl = f.page.url()
    await transport.close()
    // The replacement is otherwise a self-consistent chat in the same Project;
    // only the earlier positive URL evidence distinguishes it from our chat.
    await f.page.evaluate(() => {
      const page = window as unknown as { fixture: { currentProject: { chat: string } }, renderFixture(): void }
      page.fixture.currentProject.chat = '/c/unowned-redirect'
      page.renderFixture()
    })
    await f.page.goto(f.origin)
    f.redirect(new URL(knownUrl).pathname, '/c/unowned-redirect')
    const reopened = await f.transport({ initialize: false })
    assert.equal((await reopened.recover(current)).kind, 'unknown')
    const saved = JSON.parse(await readFile(join(f.stateDirectory, BROWSER_LEDGER_FILE), 'utf8')).data
    assert.equal(saved.generations[0].conversationUrl, knownUrl)
    assert.equal(f.actions.filter(action => action.kind === 'send').length, 1)
  })

  it('never repeats an uncertain Project creation after restart', async () => {
    const f = await fixture(); const current = turn()
    const transport = await f.transport({ testOnlyLedgerFault(point, action) { if (point === 'before-observed' && action.kind === 'project-create') throw new Error('simulated post-create crash') } })
    await transport.prepare(current, signal()); await assert.rejects(transport.submit(current, signal()), /simulated post-create crash/)
    await transport.close(); const reopened = await f.transport({ initialize: false })
    assert.equal((await reopened.recover(current)).kind, 'not-submitted')
    await assert.rejects(reopened.prepare(turn({ sessionId: 'other' }), signal()), code('WEB_BROWSER_UNCERTAIN'))
    assert.equal(f.actions.filter(action => action.kind === 'create').length, 1)
    assert.equal(f.actions.filter(action => action.kind === 'send').length, 0)
    await reopened.discard(current)
    await assert.rejects(reopened.prepare(current, signal()), code('WEB_BROWSER_DISCARDED'))
    const fresh = turn({ sessionId: 'other' }, 'fresh-project-generation')
    await reopened.prepare(fresh, signal()); const sent = await reopened.submit(fresh, signal()); await reopened.observe(fresh, sent.promptId, signal())
    assert.equal(f.actions.filter(action => action.kind === 'create').length, 2)
    assert.equal(f.actions.filter(action => action.kind === 'send').length, 1)
  })

  it('does not accept stable assistant text without a positive completion control', async () => {
    const f = await fixture(); await f.set({ responseFinished: false })
    const transport = await f.transport(); const current = turn()
    await transport.prepare(current, signal()); const sent = await transport.submit(current, signal())
    await assert.rejects(transport.observe(current, sent.promptId, AbortSignal.timeout(200)), error => error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
    assert.equal((await transport.recover(current)).kind, 'unknown')
    assert.equal(f.actions.filter(action => action.kind === 'send').length, 1)
  })

  for (const mode of ['prose', 'wrong-request', 'malformed-json', 'bad-tool']) it(`recovers a strictly finished ${mode} response as terminal failure without another Send`, async () => {
    const f = await fixture(); await f.set({ answerMode: mode })
    const current = turn(), transport = await f.transport()
    await transport.prepare(current, signal()); const sent = await transport.submit(current, signal())
    await assert.rejects(transport.observe(current, sent.promptId, signal()), code('WEB_INVALID_RESPONSE'))
    const stored = JSON.parse(await readFile(join(f.stateDirectory, BROWSER_LEDGER_FILE), 'utf8')).data
    assert.equal(stored.turns[0].terminalFailure.kind, 'invalid-response')
    assert.equal(stored.turns[0].completed, undefined)
    assert.equal(stored.generations[0].lastTurnId, undefined)
    assert.deepEqual(stored.generations[0].transcript, [])
    await transport.close()
    const reopened = await f.transport({ initialize: false })
    assert.equal((await reopened.recover(current)).kind, 'terminal-failure')
    await assert.rejects(reopened.prepare(current, signal()), code('WEB_BROWSER_TERMINAL'))
    await assert.rejects(reopened.submit(current, signal()))
    assert.equal(f.actions.filter(action => action.kind === 'send').length, 1)
  })

  it('keeps recovery unknown when a terminally invalid response changes after its proof was saved', async () => {
    const f = await fixture(); await f.set({ answerMode: 'prose' })
    const current = turn(), transport = await f.transport()
    await transport.prepare(current, signal()); const sent = await transport.submit(current, signal())
    await assert.rejects(transport.observe(current, sent.promptId, signal()), code('WEB_INVALID_RESPONSE'))
    const proof = JSON.parse(await readFile(join(f.stateDirectory, BROWSER_LEDGER_FILE), 'utf8')).data.turns[0].terminalFailure
    await transport.close()
    await f.page.evaluate(() => {
      const fixture = window as unknown as { fixture: { messages: Array<{ role: string, text: string }> }, renderFixture(): void }
      fixture.fixture.messages.findLast(message => message.role === 'assistant')!.text += ' edited after observation'
      fixture.renderFixture()
    })
    const reopened = await f.transport({ initialize: false })
    assert.equal((await reopened.recover(current)).kind, 'unknown')
    assert.deepEqual(JSON.parse(await readFile(join(f.stateDirectory, BROWSER_LEDGER_FILE), 'utf8')).data.turns[0].terminalFailure, proof)
    assert.equal(f.actions.filter(action => action.kind === 'send').length, 1)
  })

  it('engine recovery retains an invalid-response tombstone and admits fresh work only in a new generation', async () => {
    const f = await fixture(); await f.set({ answerMode: 'prose' })
    const current = turn(), request = current.request, transport = await f.transport()
    const engine = await openWebBridge({ directory: join(f.directory, 'engine'), profileDirectory: f.profileDirectory, initialize: true, transport,
      binding: { protocolVersion: 1, installationId: request.installationId, provider: request.provider, profileId: request.profileId, accountBinding: request.accountBinding } })
    try {
      await assert.rejects(engine.execute(request), code('WEB_UNCERTAIN'))
      const recovered = await engine.administration.recover(current.turnId)
      assert.equal(recovered.state, 'failed')
      assert.equal(recovered.response, undefined)
      assert.equal(recovered.deliveryState, 'unclaimed')
      await assert.rejects(engine.execute(request), code('WEB_REMOTE_FAILED'))
      assert.equal(f.actions.filter(action => action.kind === 'send').length, 1)
      await f.set({ answerMode: 'text' })
      const next = await engine.execute(turn({ sessionId: 'new-after-terminal-failure' }).request)
      assert.equal(next.finishReason, 'stop')
      assert.notEqual(next.receipt.generationId, recovered.generationId)
      assert.equal(f.actions.filter(action => action.kind === 'create').length, 2)
      assert.equal(f.actions.filter(action => action.kind === 'send').length, 2)
    } finally { await engine.close() }
  })

  it('refuses a missing existing ledger and a mismatched dedicated profile', async () => {
    const f = await fixture(); const transport = await f.transport(); await transport.close()
    await rm(join(f.stateDirectory, BROWSER_LEDGER_FILE))
    await assert.rejects(f.transport(), code('WEB_BROWSER_LEDGER'))
    await assert.rejects(createChromePageTransport({ ...f.options, expectedProfileDirectory: f.directory }), code('WEB_BROWSER_OWNERSHIP'))
  })

  for (const [name, change] of [
    ['changed account', { accountAfterUpload: 'other@example.test' }],
    ['mismatched upload evidence', { uploadEvidenceMismatch: true }],
  ] as const) it(`does not enter or send a prompt after ${name}`, async () => {
    const f = await fixture(); await f.set(change)
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64')
    const digest = imageDigest(bytes)
    const current = turn({ messages: [{ id: 'image', role: 'user', content: [{ type: 'image', attachmentVersion: digest }] }], attachmentVersions: [
      { id: digest, digest, mimeType: 'image/png', byteLength: bytes.byteLength, uploadName: uploadName(digest, 'image/png'), base64: bytes.toString('base64') }] })
    const transport = await f.transport(); await transport.prepare(current, signal())
    await assert.rejects(transport.submit(current, signal()), code(name === 'changed account' ? 'WEB_BROWSER_ACCOUNT' : 'WEB_BROWSER_DRIFT'))
    assert.deepEqual(f.actions.map(action => action.kind), ['create', 'upload'])
    const ledger = JSON.parse(await readFile(join(f.stateDirectory, BROWSER_LEDGER_FILE), 'utf8'))
    assert.equal(ledger.data.mutations.some((entry: { kind: string }) => entry.kind === 'prompt-input' || entry.kind === 'send'), false)
  })

  it('rejects changed account at terminal completion after a long observation started', async () => {
    const f = await fixture(); await f.set({ autoRespond: false })
    const transport = await f.transport(); const current = turn()
    await transport.prepare(current, signal()); const sent = await transport.submit(current, signal())
    const observing = transport.observe(current, sent.promptId, signal())
    const rejected = assert.rejects(observing, code('WEB_BROWSER_ACCOUNT'))
    await f.page.waitForFunction(() => document.querySelector('[data-testid="accounts-profile-button"]') !== null)
    await new Promise(resolve => setTimeout(resolve, 300))
    await f.set({ email: 'changed@example.test' })
    await f.page.evaluate(() => (window as unknown as { finishFixture(): void }).finishFixture())
    await rejected
    assert.equal(f.actions.filter(action => action.kind === 'send').length, 1)
  })

  it('does not establish terminal failure when final account inspection changes same-URL Project membership', async () => {
    const f = await fixture(); await f.set({ answerMode: 'prose' })
    const transport = await f.transport(), current = turn()
    await transport.prepare(current, signal()); const sent = await transport.submit(current, signal())
    const url = f.page.url()
    const text = await f.page.locator('[data-message-author-role="assistant"] [data-message-content]').innerText()
    // observe's admission binding opens the account twice; the third opening
    // occurs only after completed() has rechecked Project settings and sharing.
    await f.set({ projectOnAccountInspect: '/g/g-p-unowned/project', projectAfterAccountInspections: 3, accountInspectionCount: 0 })
    await assert.rejects(transport.observe(current, sent.promptId, signal()), code('WEB_BROWSER_DRIFT'))
    assert.equal(f.page.url(), url)
    assert.equal(await f.page.locator('[data-message-author-role="assistant"] [data-message-content]').innerText(), text)
    const saved = JSON.parse(await readFile(join(f.stateDirectory, BROWSER_LEDGER_FILE), 'utf8')).data
    assert.equal(saved.turns[0].terminalFailure, undefined)
    assert.equal(saved.turns[0].completed, undefined)
    assert.equal((await transport.recover(current)).kind, 'unknown')
    assert.equal(f.actions.filter(action => action.kind === 'send').length, 1)
  })

  it('rejects edited prefix DOM and contradictory Project settings before another Send', async () => {
    const f = await fixture(); const first = turn(); const { transport, response } = await complete(f, first)
    const next = continuation(first, response)
    await f.page.evaluate(() => { (window as unknown as { fixture: { messages: Array<{ text: string }> } }).fixture.messages[0]!.text = 'Edited old browser message'; (window as unknown as { renderFixture(): void }).renderFixture() })
    await assert.rejects(transport.prepare(next, signal()), code('WEB_BROWSER_HISTORY'))
    assert.equal(f.actions.filter(action => action.kind === 'send').length, 1)
    await f.set({ settingsMode: 'contradictory' })
    assert.equal((await transport.recover(first)).kind, 'unknown')
    assert.equal(f.actions.filter(action => action.kind === 'send').length, 1)
  })

  it('requires exact attachment evidence in readonly recovery and preserves abandoned mutation evidence', async () => {
    const f = await fixture(); const current = turn()
    const transport = await f.transport({ testOnlyLedgerFault(point, action) { if (point === 'before-observed' && action.kind === 'send') throw Error('crash') } })
    await transport.prepare(current, signal()); await assert.rejects(transport.submit(current, signal()), /crash/)
    await transport.close(); const reopened = await f.transport({ initialize: false })
    await f.page.evaluate(() => { (window as unknown as { fixture: { messages: Array<{ role: string, attachments?: string[] }> } }).fixture.messages.find(message => message.role === 'user')!.attachments = ['dsh-' + 'f'.repeat(64) + '.png']; (window as unknown as { renderFixture(): void }).renderFixture() })
    assert.equal((await reopened.recover(current)).kind, 'unknown')
    await reopened.discard(current)
    const disk = JSON.parse(await readFile(join(f.stateDirectory, BROWSER_LEDGER_FILE), 'utf8'))
    assert.equal(disk.data.turns[0].discarded, true)
    assert.equal(disk.data.mutations.find((action: { kind: string }) => action.kind === 'send').state, 'intent')
    assert.equal(f.actions.filter(action => action.kind === 'send').length, 1)
    assert.equal((await reopened.recover(current)).kind, 'unknown')
    await f.page.evaluate(() => { (window as unknown as { fixture: { messages: Array<{ role: string, attachments?: string[] }> } }).fixture.messages.find(message => message.role === 'user')!.attachments = []; (window as unknown as { renderFixture(): void }).renderFixture() })
    assert.equal((await reopened.recover(current)).kind, 'completed')
    assert.equal(f.actions.filter(action => action.kind === 'send').length, 1)
    const fresh = turn({ sessionId: 'new-session' }, 'new-generation')
    await reopened.prepare(fresh, signal()); await reopened.submit(fresh, signal())
    assert.equal(f.actions.filter(action => action.kind === 'create').length, 2)
    assert.equal(f.actions.filter(action => action.kind === 'send').length, 2)
  })

  it('selects GPT-6 Pro again after an explicitly created empty Project resets its controls', async () => {
    const f = await fixture(); await f.set({ resetModelOnProject: true })
    await complete(f)
    assert.deepEqual(f.actions.map(action => action.kind), ['create', 'model', 'effort', 'send'])
    assert.deepEqual(f.intentKinds, ['project-create', 'model-selection', 'effort-selection', 'send'])
  })

  it('selects an observed bounded Pro slider without inferring its effort from a numeric maximum', async () => {
    const f = await fixture(); await f.set({ resetModelOnProject: true, effortSlider: true })
    await complete(f)
    assert.deepEqual(f.actions.map(action => action.kind), ['create', 'model', 'effort', 'send'])
    const disk = JSON.parse(await readFile(join(f.stateDirectory, BROWSER_LEDGER_FILE), 'utf8'))
    const effort = disk.data.mutations.find((entry: { kind: string }) => entry.kind === 'effort-selection')
    assert.deepEqual(effort.evidence, { selectedValue: '2', selectedLabel: 'Pro' })
  })

})

describe('website envelope', () => {
  it('rejects unknown output framing, request identity, and oversized full prompts', () => {
    const current = turn()
    const valid = JSON.stringify({ version: 1, requestId: current.turnId, complete: true, blocks: [{ type: 'text', text: 'Answer' }] })
    assert.deepEqual(parseResponse(valid, current), { version: 1, complete: true, blocks: [{ type: 'text', text: 'Answer' }] })
    assert.throws(() => parseResponse('```json\n' + valid + '\n```', current), code('WEB_INVALID_RESPONSE'))
    assert.throws(() => parseResponse(valid.replace(current.turnId, 'other-request'), current), code('WEB_INVALID_RESPONSE'))
    assert.throws(() => parseResponse(valid.replace('"version":1', '"version":0,"version":1'), current), code('WEB_INVALID_RESPONSE'))
    assert.throws(() => renderPrompt(current, 1024), code('WEB_INPUT_LIMIT'))
  })

  it('rejects a bounded page envelope that cannot fit its complete receipt and transport framing', () => {
    const current = turn()
    const response = { version: 1, complete: true, blocks: [{ type: 'text', text: 'x'.repeat(WEB_MAX_JSON_BYTES - 512) }] }
    const raw = JSON.stringify({ ...response, requestId: current.turnId })
    assert.ok(Buffer.byteLength(raw, 'utf8') <= WEB_MAX_JSON_BYTES)
    assert.doesNotThrow(() => validatePageResponse(response, current.request, current.turnId))
    assert.throws(() => parseResponse(raw, current), code('WEB_RESPONSE_LIMIT'))
  })
})
