import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { BrowserLedger, BROWSER_LEDGER_FILE, textDigest, type BrowserIdentity, type BrowserTerminalFailure } from '../src/web-browser/ledger.ts'
import { projectionSettingsDigest, renderPrompt } from '../src/web-browser/envelope.ts'
import { canonical, createResponse, requestHash, WEB_MAX_REQUEST_BYTES } from '../src/web-bridge/protocol.ts'
import { WebBridgeError, type PageTurn } from '../src/web-bridge/contracts.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
async function paths() {
  const root = await mkdtemp(join(tmpdir(), 'web-browser-ledger-')); directories.push(root)
  const directory = join(root, 'evidence'), profileDirectory = join(root, 'profile')
  await mkdir(profileDirectory, { mode: 0o700 })
  const identity: BrowserIdentity = { profileDirectory, provider: 'chatgpt', profileId: 'dedicated', accountBinding: 'account-binding' }
  return { root, directory, profileDirectory, identity }
}
function turn(): PageTurn {
  const request: PageTurn['request'] = { protocolVersion: 1, installationId: 'installation', provider: 'chatgpt', profileId: 'dedicated',
    accountBinding: 'account-binding', clientLeaseId: 'private-lease', deliveryAttemptId: 'attempt', idempotencyKey: '',
    sessionId: 'session', purpose: 'normal', model: 'gpt-6-pro-web', reasoningEffort: 'pro', system: 'System instructions',
    messages: [{ id: 'user', role: 'user', content: [{ type: 'text', text: 'Question' }] }], tools: [], controls: {}, attachmentVersions: [], parentReceipt: null }
  request.idempotencyKey = requestHash(request)
  return { request, turnId: 'browser-turn', generationId: 'generation' }
}
function code(expected: string) { return (error: unknown) => error instanceof WebBridgeError && error.code === expected }
async function snapshot(directory: string) { return JSON.parse(await readFile(join(directory, BROWSER_LEDGER_FILE), 'utf8')) }
async function submitted(ledger: BrowserLedger, current: PageTurn): Promise<void> {
  await ledger.admit(current, renderPrompt(current, 100_000))
  const send = await ledger.begin(current.turnId, 'send', 'https://chatgpt.com/c/owned')
  await ledger.observed(send, { promptId: 'user-1', conversationUrl: 'https://chatgpt.com/c/owned' })
  await ledger.updateTurn(current.turnId, { promptId: 'user-1' })
}
function rejectedProof(text = 'This is not the required response envelope'): BrowserTerminalFailure {
  return { kind: 'invalid-response', promptId: 'user-1', responseId: 'assistant-1', responseText: text,
    responseDigest: textDigest(text), transcriptDigest: textDigest('exact terminal transcript') }
}

describe('browser mutation ledger without a browser', () => {
  it('requires explicit first initialization, exclusive ownership, exact profile binding, and owner-only evidence', async () => {
    const p = await paths()
    await assert.rejects(BrowserLedger.open(p.directory, p.identity, false), code('WEB_BROWSER_LEDGER'))
    const ledger = await BrowserLedger.open(p.directory, p.identity, true)
    await assert.rejects(BrowserLedger.open(p.directory, p.identity, true), code('WEB_BROWSER_LOCKED'))
    const current = turn(); await ledger.admit(current, renderPrompt(current, 100_000))
    assert.equal((await stat(join(p.directory, BROWSER_LEDGER_FILE))).mode & 0o777, 0o600)
    assert.equal((await stat(p.directory)).mode & 0o777, 0o700)
    await ledger.close()
    await assert.rejects(BrowserLedger.open(p.directory, { ...p.identity, accountBinding: 'different' }, false), code('WEB_BROWSER_LEDGER'))
    const reopened = await BrowserLedger.open(p.directory, p.identity, false)
    assert.equal(reopened.turn(current.turnId)?.requestHash, current.request.idempotencyKey)
    await reopened.close()
  })

  it('publishes an intent before the mutation callback and preserves its fence through restart', async () => {
    const p = await paths(); const current = turn(); let witnessed = false
    const ledger = await BrowserLedger.open(p.directory, p.identity, true, async (point, action) => {
      if (point !== 'after-intent') return
      const disk = await snapshot(p.directory)
      assert.equal(disk.data.mutations.at(-1).id, action.id)
      assert.equal(disk.data.mutations.at(-1).state, 'intent')
      witnessed = true
      throw new Error('crash before remote action')
    })
    await ledger.admit(current, renderPrompt(current, 100_000))
    await assert.rejects(ledger.begin(current.turnId, 'send', 'https://chatgpt.com/'), /crash before remote action/)
    assert.equal(witnessed, true)
    await assert.rejects(ledger.begin(current.turnId, 'send', 'https://chatgpt.com/'), code('WEB_BROWSER_UNCERTAIN'))
    await ledger.close()
    const reopened = await BrowserLedger.open(p.directory, p.identity, false)
    assert.equal(reopened.pending()?.kind, 'send')
    await assert.rejects(reopened.admit({ ...current, turnId: 'different-turn' }, 'different prompt'), code('WEB_BROWSER_UNCERTAIN'))
    await reopened.close()
  })

  it('never silently replaces a lost journal or a changed store directory for an existing profile', async () => {
    const p = await paths(); const ledger = await BrowserLedger.open(p.directory, p.identity, true); await ledger.close()
    await rm(join(p.directory, BROWSER_LEDGER_FILE))
    await assert.rejects(BrowserLedger.open(p.directory, p.identity, true), code('WEB_BROWSER_LEDGER'))
    await assert.rejects(BrowserLedger.open(join(p.root, 'other-evidence'), p.identity, true), code('WEB_BROWSER_LEDGER'))
  })

  it('rejects corrupt persisted evidence even when the installation marker is present', async () => {
    const p = await paths(); const ledger = await BrowserLedger.open(p.directory, p.identity, true); await ledger.close()
    const raw = await snapshot(p.directory); raw.data.mutations.push({ kind: 'send' })
    await writeFile(join(p.directory, BROWSER_LEDGER_FILE), JSON.stringify(raw), { mode: 0o600 })
    await assert.rejects(BrowserLedger.open(p.directory, p.identity, false), code('WEB_BROWSER_LEDGER'))
  })

  it('commits completion and the corresponding projection tip in one durable snapshot', async () => {
    const p = await paths(); const current = turn(); const ledger = await BrowserLedger.open(p.directory, p.identity, true)
    await ledger.admit(current, renderPrompt(current, 100_000))
    const action = await ledger.begin(current.turnId, 'send', 'https://chatgpt.com/')
    await ledger.observed(action, { promptId: 'user-1', conversationUrl: 'https://chatgpt.com/c/owned' })
    await ledger.complete(current.turnId, { promptId: 'user-1', responseId: 'answer-1', responseText: '{}', completed: true }, current.generationId,
      { lastTurnId: current.turnId, projectedMessageCount: current.request.messages.length,
        projectedMessagesDigest: textDigest(canonical(current.request.messages)), projectionSettingsDigest: projectionSettingsDigest(current),
        transcript: [{ id: 'user-1', role: 'user', digest: textDigest('prompt') }, { id: 'answer-1', role: 'assistant', digest: textDigest('{}') }] })
    const disk = await snapshot(p.directory)
    assert.equal(disk.data.turns[0].completed, true); assert.equal(disk.data.generations[0].lastTurnId, current.turnId)
    assert.equal(disk.digest, textDigest(JSON.stringify(disk.data)))
    await ledger.close()
  })

  it('uses an exact existing prefix only and never exposes private transport identities in the website envelope', () => {
    const current = turn()
    const generation = { id: current.generationId, sessionId: current.request.sessionId, purpose: current.request.purpose,
      title: 'owned', transcript: [], lastTurnId: 'previous-turn', projectedMessageCount: 1,
      projectedMessagesDigest: textDigest(canonical(current.request.messages)), projectionSettingsDigest: projectionSettingsDigest(current) }
    const next = structuredClone(current)
    next.request.messages.push({ id: 'next', role: 'user', content: [{ type: 'text', text: 'Follow-up' }] })
    next.request.parentReceipt = { kind: 'chatgpt-web-receipt', version: 1, installationId: 'installation', provider: 'chatgpt', profileId: 'dedicated',
      accountBinding: 'account-binding', sessionId: 'session', purpose: 'normal', model: 'gpt-6-pro-web', generationId: current.generationId,
      turnId: 'previous-turn', requestHash: 'hash', responseDigest: 'digest' }
    const prompt = renderPrompt(next, 100_000, generation)
    assert.equal(JSON.parse(prompt).request.messages.length, 1)
    for (const privateValue of ['private-lease', 'account-binding', 'previous-turn']) assert.equal(prompt.includes(privateValue), false)
    next.request.messages[0]!.content = [{ type: 'text', text: 'Edited old input' }]
    assert.throws(() => renderPrompt(next, 100_000, generation), code('WEB_BROWSER_HISTORY'))
    const fresh = JSON.parse(renderPrompt(next, 100_000))
    assert.equal(fresh.request.messages.length, 2); assert.equal(fresh.projection, 'full-current-history')
  })

  it('keeps the real Chromium fixture script syntactically runnable without claiming a browser execution', async () => {
    const html = await readFile(new URL('./fixtures/web-browser/fixture.html', import.meta.url), 'utf8')
    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1]
    assert.ok(script); assert.doesNotThrow(() => new Script(script))
  })

  it('supports a legal request prefix larger than the response budget without duplicating it in the website append', () => {
    const previous = turn()
    previous.request.messages[0]!.content = [{ type: 'text', text: 'x'.repeat(600_000) }, { type: 'text', text: 'y'.repeat(600_000) }]
    previous.request.idempotencyKey = requestHash(previous.request)
    const full = renderPrompt(previous, 2_000_000)
    assert.ok(Buffer.byteLength(full) > 1024 * 1024)
    const response = createResponse(previous.request, previous.turnId, previous.generationId, [{ type: 'text', text: 'Answer' }])
    const next = structuredClone(previous)
    next.turnId = 'next-browser-turn'
    next.request.messages.push({ id: 'assistant', role: 'assistant', content: response.blocks,
      source: { kind: 'model', provider: 'chatgpt', model: 'gpt-6-pro-web', replayState: { response: response.receipt } } },
      { id: 'next-user', role: 'user', content: [{ type: 'text', text: 'Continue' }] })
    next.request.parentReceipt = response.receipt
    next.request.idempotencyKey = requestHash(next.request)
    const generation = { id: previous.generationId, sessionId: previous.request.sessionId, purpose: previous.request.purpose, title: 'owned', transcript: [],
      lastTurnId: previous.turnId, projectedMessageCount: 1, projectedMessagesDigest: textDigest(canonical(previous.request.messages, WEB_MAX_REQUEST_BYTES)),
      projectionSettingsDigest: projectionSettingsDigest(previous) }
    const append = renderPrompt(next, 2_000_000, generation)
    assert.ok(Buffer.byteLength(append) < 10_000)
    assert.equal(JSON.parse(append).request.messages.length, 2)
  })

  it('preserves an explicitly abandoned pending action without granting permission to replay its request', async () => {
    const p = await paths(); const current = turn(); const ledger = await BrowserLedger.open(p.directory, p.identity, true)
    const prompt = renderPrompt(current, 100_000)
    await ledger.admit(current, prompt)
    const intent = await ledger.begin(current.turnId, 'image-upload', 'https://chatgpt.com/')
    await ledger.discard(current); await ledger.discard(current)
    assert.equal(ledger.pending(), undefined)
    assert.equal(ledger.mutations(current.turnId)[0]?.state, 'intent')
    await assert.rejects(ledger.admit(current, prompt), code('WEB_BROWSER_DISCARDED'))
    // A later read-only witness can reconcile the original action even though
    // its request was abandoned. No action callback or Send runs here.
    await ledger.observed(intent, { uploadName: 'observed-original-upload' })
    await ledger.close()
    const reopened = await BrowserLedger.open(p.directory, p.identity, false)
    assert.equal(reopened.turn(current.turnId)?.discarded, true)
    assert.equal(reopened.mutations(current.turnId)[0]?.state, 'observed')
    await reopened.close()
  })

  it('persists immutable invalid-response evidence without advancing the successful generation prefix', async () => {
    const p = await paths(), current = turn(), proof = rejectedProof()
    const ledger = await BrowserLedger.open(p.directory, p.identity, true)
    await submitted(ledger, current)
    const generation = ledger.generation(current.generationId)
    await ledger.rejectResponse(current.turnId, proof)
    await ledger.rejectResponse(current.turnId, structuredClone(proof))
    assert.deepEqual(ledger.turn(current.turnId)?.terminalFailure, proof)
    assert.deepEqual(ledger.generation(current.generationId), generation)
    assert.equal(ledger.turn(current.turnId)?.completed, undefined)
    await assert.rejects(ledger.admit(current, renderPrompt(current, 100_000)), code('WEB_BROWSER_TERMINAL'))
    await assert.rejects(ledger.rejectResponse(current.turnId, rejectedProof('edited response')), code('WEB_BROWSER_LEDGER'))
    await assert.rejects(ledger.updateTurn(current.turnId, { completed: true }), code('WEB_BROWSER_LEDGER'))
    await assert.rejects(ledger.updateTurn(current.turnId, { promptId: 'replacement-prompt' }), code('WEB_BROWSER_LEDGER'))
    await assert.rejects(ledger.complete(current.turnId, { completed: true }, current.generationId, { lastTurnId: current.turnId }), code('WEB_BROWSER_LEDGER'))
    await ledger.close()
    const reopened = await BrowserLedger.open(p.directory, p.identity, false)
    assert.deepEqual(reopened.turn(current.turnId)?.terminalFailure, proof)
    assert.deepEqual(reopened.generation(current.generationId), generation)
    await reopened.close()
  })

  it('cannot establish terminal failure without positive Send evidence, matching bytes, and a bounded proof', async () => {
    const p = await paths(), current = turn()
    const ledger = await BrowserLedger.open(p.directory, p.identity, true)
    await ledger.admit(current, renderPrompt(current, 100_000))
    await assert.rejects(ledger.rejectResponse(current.turnId, rejectedProof()), code('WEB_BROWSER_LEDGER'))
    await submitted(ledger, current)
    await assert.rejects(ledger.rejectResponse(current.turnId, { ...rejectedProof(), responseDigest: textDigest('different bytes') }), code('WEB_BROWSER_LEDGER'))
    await assert.rejects(ledger.rejectResponse(current.turnId, rejectedProof('x'.repeat(1024 * 1024 + 1))), code('WEB_BROWSER_LEDGER'))
    assert.equal(ledger.turn(current.turnId)?.terminalFailure, undefined)
    await ledger.close()
  })

  it('never publishes a failed terminal-evidence write and keeps the old durable state after reopen', async () => {
    const p = await paths(), current = turn()
    const ledger = await BrowserLedger.open(p.directory, p.identity, true)
    await submitted(ledger, current)
    const moved = join(p.root, 'temporarily-unavailable')
    await rename(p.directory, moved)
    try {
      await assert.rejects(ledger.rejectResponse(current.turnId, rejectedProof()), { code: 'ENOENT' })
      assert.equal(ledger.turn(current.turnId)?.terminalFailure, undefined)
      await assert.rejects(ledger.rejectResponse(current.turnId, rejectedProof()), code('WEB_BROWSER_LEDGER'))
    } finally { await rename(moved, p.directory); await ledger.close() }
    const reopened = await BrowserLedger.open(p.directory, p.identity, false)
    assert.equal(reopened.turn(current.turnId)?.terminalFailure, undefined)
    await reopened.close()
  })
})
