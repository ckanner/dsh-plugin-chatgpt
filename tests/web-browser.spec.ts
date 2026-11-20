import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { chromeFixture, type ChromeFixture } from './fixtures/web-browser/chrome.ts'
import { accountBindingForVisibleIdentity, createChromePageTransport, inspectChromeSetup } from '../src/web-browser/index.ts'
import { BROWSER_LEDGER_FILE } from '../src/web-browser/ledger.ts'
import { parseResponse, renderPrompt } from '../src/web-browser/envelope.ts'
import { createResponse, requestHash, validatePageResponse } from '../src/web-bridge/protocol.ts'
import { imageDigest, uploadName } from '../src/web-bridge/attachments.ts'
import { WebBridgeError, type PageTurn, type WebRequest, type WebResponse } from '../src/web-bridge/contracts.ts'

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
})
