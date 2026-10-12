import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ChatGptAuth } from '../src/auth/manager.ts'
import type { ChatGptCredential } from '../src/auth/credential.ts'
import { emptyDocument, readDocument, writeDocument } from '../src/auth/store.ts'
import { accountScope, createReplay, outputBlock, type OutputItem } from '../src/convert/replay.ts'
import { toNeutralRequest } from '../src/adapter.ts'
import { toResponsesBody } from '../src/convert/request.ts'
import { startTokenServer } from './helpers.ts'

const directories: string[] = []
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-auth-replay-'))
  directories.push(dir)
  return dir
}
function grant(overrides: Partial<ChatGptCredential> = {}): ChatGptCredential {
  return { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3600000,
    clientId: 'same-client', scopes: ['chatgpt.tokens.use.direct'], savedAt: Date.now(), ...overrides }
}
const endpoint = 'https://api.openai.com/v1'

describe('authorization-scoped replay', () => {
  it('does not synthesize a subject from an email or a local account key', async () => {
    const auth = new ChatGptAuth({ stateDir: await directory(), agentNameHint: 'Test' })
    const key = auth.adopt(grant({ email: 'display@example.test' }))
    assert.notEqual(key, 'display@example.test')
    assert.equal(auth.active()?.subject, undefined)
    assert.equal(auth.status().accounts[0]?.subject, key)
  })

  it('isolates two adopted grants without subjects even when their client and email match', async () => {
    const auth = new ChatGptAuth({ stateDir: await directory(), agentNameHint: 'Test' })
    const keyA = auth.adopt(grant({ email: 'shared@example.test' }))
    const a = await auth.usable()
    const scopeA = accountScope(endpoint, a)
    assert.ok(scopeA)
    assert.ok(a.replayNamespace)
    const output: OutputItem[] = [
      { type: 'reasoning', id: 'rs_a', summary: [], encrypted_content: 'opaque-a' },
      { type: 'message', role: 'assistant', id: 'msg_a', content: [{ type: 'output_text', text: 'Visible history' }] },
      { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'read', arguments: '{}' },
    ]
    const content = output.map(outputBlock)
    const replayState = createReplay({ provider: 'chatgpt', model: 'm', scope: scopeA }, output, content)
    auth.signOut()
    const keyB = auth.adopt(grant({ email: 'shared@example.test', accessToken: 'account-b', replayNamespace: a.replayNamespace }))
    const b = await auth.usable()
    const scopeB = accountScope(endpoint, b)
    assert.ok(scopeB)
    assert.notEqual(keyA, keyB)
    assert.notEqual(scopeA, scopeB)
    const input = toResponsesBody(toNeutralRequest({
      provider: 'chatgpt', model: 'm', sessionId: 'same-session',
      messages: [{ role: 'assistant', content, source: { provider: 'chatgpt', model: 'm', replayState } }],
    }, scopeB)).input
    assert.deepEqual(input, [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Visible history' }] },
      { type: 'function_call', call_id: 'call_a', name: 'read', arguments: '{}' },
    ])
  })

  it('persists a legacy-grant namespace and preserves it through refresh and restart', async () => {
    const dir = await directory()
    writeDocument(join(dir, 'chatgpt-auth.json'), {
      ...emptyDocument('urn:uuid:test'), accounts: { 'account-1': grant({ subject: 'account-1' }) }, active: 'account-1',
    })
    const token = await startTokenServer({ body: { access_token: 'rotated', refresh_token: 'rotated-refresh', expires_in: 3600 } })
    closers.push(token.close)
    const options = { stateDir: dir, agentNameHint: 'Test', endpoints: { tokenUrl: token.url } }
    const auth = new ChatGptAuth(options)
    const first = await auth.usable()
    assert.ok(first.replayNamespace)
    const scope = accountScope(endpoint, first)
    assert.ok(scope)
    assert.equal(readDocument(auth.storePath)?.accounts['account-1']?.replayNamespace, first.replayNamespace)
    assert.equal(accountScope(endpoint, await auth.renew()), scope)
    assert.equal(accountScope(endpoint, await new ChatGptAuth(options).usable()), scope)
    auth.signOut()
    auth.adopt(grant({ subject: 'account-1' }))
    assert.notEqual(accountScope(endpoint, await auth.usable()), scope)
  })

  it('fails closed for a credential whose local replay namespace is absent or malformed', () => {
    for (const replayNamespace of [undefined, '', 'account-1', 'display@example.test']) {
      assert.equal(accountScope(endpoint, grant({
        subject: 'subject', ...replayNamespace === undefined ? {} : { replayNamespace },
      })), undefined)
    }
    assert.equal(accountScope(endpoint, { clientId: '', replayNamespace: 'cf5a7f74-6069-4dfa-bd1c-df7d2e76f278' }), undefined)
  })

  it('refreshes separate grants independently without switching the active account back', async () => {
    const token = await startTokenServer({ reply: params => ({ body: {
      access_token: 'new-' + params.get('refresh_token'), refresh_token: 'next-' + params.get('refresh_token'), expires_in: 3600,
    } }) })
    closers.push(token.close)
    const auth = new ChatGptAuth({ stateDir: await directory(), agentNameHint: 'Test', endpoints: { tokenUrl: token.url } })
    const a = auth.adopt(grant({ refreshToken: 'A', expiresAt: 0 }))
    const first = auth.usable()
    const b = auth.adopt(grant({ refreshToken: 'B', expiresAt: 0 }))
    const second = auth.usable()
    const [rotatedA, rotatedB] = await Promise.all([first, second])
    assert.equal(rotatedA.accessToken, 'new-A')
    assert.equal(rotatedB.accessToken, 'new-B')
    assert.equal(token.requests.length, 2)
    assert.equal(readDocument(auth.storePath)?.active, b)
    auth.activate(a)
    assert.equal(auth.active()?.accessToken, 'new-A')
  })

  it('does not restore a signed-out grant when its refresh finishes late', async () => {
    const token = await startTokenServer({ body: { access_token: 'old-grant-rotated', refresh_token: 'old-r2', expires_in: 3600 } })
    closers.push(token.close)
    const auth = new ChatGptAuth({ stateDir: await directory(), agentNameHint: 'Test', endpoints: { tokenUrl: token.url } })
    auth.adopt(grant({ subject: 'same-subject' }))
    const pending = auth.renew()
    const rejected = assert.rejects(pending, /changed|removed/)
    auth.signOut()
    auth.adopt(grant({ subject: 'same-subject', accessToken: 'new-grant' }))
    await rejected
    assert.equal(auth.active()?.accessToken, 'new-grant')
  })
})
