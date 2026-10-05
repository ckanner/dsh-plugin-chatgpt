import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatGptAuth } from '../src/auth/manager.ts'
import { writeDocument, readDocument, emptyDocument } from '../src/auth/store.ts'
import type { ChatGptCredential } from '../src/auth/credential.ts'
import { startTokenServer } from './helpers.ts'

const dirs: string[] = []
const closers: (() => Promise<void>)[] = []

async function stateDir(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'chatgpt-manager-'))
  dirs.push(created)
  return created
}

function grant(overrides: Partial<ChatGptCredential> = {}): ChatGptCredential {
  return {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: Date.now() + 3600_000,
    clientId: 'oaiapp_issued',
    scopes: ['openid', 'chatgpt.tokens.use.direct'],
    subject: 'subject-1',
    email: 'me@example.com',
    planType: 'plus',
    savedAt: Date.now(),
    ...overrides,
  }
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
  await Promise.all(dirs.splice(0).map(entry => rm(entry, { recursive: true, force: true })))
})

describe('ChatGptAuth', () => {
  it('reports nobody signed in on a fresh installation', async () => {
    const auth = new ChatGptAuth({ stateDir: await stateDir(), agentNameHint: 'DeepSeek Harness' })

    const status = auth.status()

    assert.equal(status.signedIn, false)
    assert.equal(status.planUsageDenied, false)
    assert.deepEqual(status.accounts, [])
  })

  it('adopts a grant, persists it, and reports account facts without tokens', async () => {
    const dir = await stateDir()
    const auth = new ChatGptAuth({ stateDir: dir, agentNameHint: 'DeepSeek Harness' })

    const subject = auth.adopt(grant())
    const status = auth.status()

    assert.equal(subject, 'subject-1')
    assert.equal(status.signedIn, true)
    assert.equal(status.email, 'me@example.com')
    assert.equal(status.plan, 'plus')
    assert.deepEqual(status.accounts, [{ subject: 'subject-1', email: 'me@example.com', active: true }])
    // Nothing the UI sees carries a bearer token.
    assert.equal(JSON.stringify(status).includes('access'), false)

    // And it survives a fresh instance reading the same directory.
    const reopened = new ChatGptAuth({ stateDir: dir, agentNameHint: 'DeepSeek Harness' })
    assert.equal(reopened.status().email, 'me@example.com')
  })

  it('flags a grant that authorized identity but not plan usage', async () => {
    const auth = new ChatGptAuth({ stateDir: await stateDir(), agentNameHint: 'DeepSeek Harness' })
    auth.adopt(grant({ scopes: ['openid', 'profile', 'email'] }))

    const status = auth.status()

    assert.equal(status.signedIn, false)
    assert.equal(status.planUsageDenied, true)
  })

  it('refreshes a stale grant exactly once for concurrent callers', async () => {
    const dir = await stateDir()
    const token = await startTokenServer({
      body: {
        access_token: 'refreshed',
        refresh_token: 'rotated',
        expires_in: 3600,
        scope: 'openid chatgpt.tokens.use.direct',
      },
    })
    closers.push(token.close)
    const auth = new ChatGptAuth({
      stateDir: dir,
      agentNameHint: 'DeepSeek Harness',
      endpoints: { tokenUrl: token.url },
    })
    // Pre-seed an expired grant directly, so no sign-in is needed.
    writeDocument(join(dir, 'chatgpt-auth.json'), {
      ...emptyDocument('urn:uuid:x'),
      accounts: { 'subject-1': grant({ expiresAt: Date.now() - 1000 }) },
      active: 'subject-1',
    })

    const [first, second] = await Promise.all([auth.usable(), auth.usable()])

    // A rotation is single-use: a second concurrent refresh would be refused.
    assert.equal(token.requests.length, 1)
    assert.equal(first.accessToken, 'refreshed')
    assert.equal(second.accessToken, 'refreshed')
    // The rotation is persisted, so the next process starts from it.
    const stored = readDocument(join(dir, 'chatgpt-auth.json'))
    assert.equal(stored?.accounts['subject-1']?.refreshToken, 'rotated')
  })

  it('returns a fresh grant without touching the network', async () => {
    const dir = await stateDir()
    const auth = new ChatGptAuth({
      stateDir: dir,
      agentNameHint: 'DeepSeek Harness',
      endpoints: { tokenUrl: 'http://127.0.0.1:9/token' },
    })
    auth.adopt(grant())

    const usable = await auth.usable()

    assert.equal(usable.accessToken, 'access')
  })

  it('switches between stored accounts without discarding either', async () => {
    const dir = await stateDir()
    const auth = new ChatGptAuth({ stateDir: dir, agentNameHint: 'DeepSeek Harness' })
    auth.adopt(grant({ subject: 'work', email: 'work@example.com' }))
    auth.adopt(grant({ subject: 'home', email: 'home@example.com' }))

    assert.equal(auth.status().email, 'home@example.com')

    auth.activate('work')

    assert.equal(auth.status().email, 'work@example.com')
    assert.equal(auth.status().accounts.length, 2)
  })

  it('signs one account out and keeps the other', async () => {
    const auth = new ChatGptAuth({ stateDir: await stateDir(), agentNameHint: 'DeepSeek Harness' })
    auth.adopt(grant({ subject: 'work', email: 'work@example.com' }))
    auth.adopt(grant({ subject: 'home', email: 'home@example.com' }))

    auth.signOut('home')

    assert.deepEqual(auth.status().accounts.map(entry => entry.subject), ['work'])
    assert.equal(auth.status().email, 'work@example.com')
  })

  it('signs every account out while keeping what each one registered', async () => {
    // The documentation is explicit: signing out clears the tokens and retains the
    // account/client mapping, because a client belongs to the account rather than
    // to the session. Forgetting it makes the next sign-in register a second client,
    // and every registration is another app row in the account's ChatGPT settings.
    const dir = await stateDir()
    const auth = new ChatGptAuth({ stateDir: dir, agentNameHint: 'DeepSeek Harness' })
    auth.adopt(grant())

    auth.signOut()

    assert.equal(auth.status().signedIn, false)
    const document = readDocument(join(dir, 'chatgpt-auth.json'))
    assert.deepEqual(document?.accounts, {})
    assert.deepEqual(document?.registrations, {
      'subject-1': { clientId: 'oaiapp_issued', email: 'me@example.com', at: document?.registrations?.['subject-1']?.at },
    })
  })

  it('offers the retained registration on the next sign-in instead of registering again', async () => {
    const dir = await stateDir()
    const auth = new ChatGptAuth({ stateDir: dir, agentNameHint: 'DeepSeek Harness' })
    auth.adopt(grant())
    auth.signOut()

    const attempt = await auth.begin()
    const url = new URL(attempt.authorizationUrl)

    assert.equal(url.searchParams.get('client_id'), 'oaiapp_issued')
    // A reauthorization omits the registration hints and sends the saved account.
    assert.equal(url.searchParams.get('agent_name_hint'), null)
    assert.equal(url.searchParams.get('login_hint'), 'me@example.com')
    attempt.cancel()
    await assert.rejects(attempt.result)
  })

  it('registers a client only when this installation has none', async () => {
    const auth = new ChatGptAuth({ stateDir: await stateDir(), agentNameHint: 'DeepSeek Harness' })

    const attempt = await auth.begin()
    const url = new URL(attempt.authorizationUrl)

    assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client')
    assert.equal(url.searchParams.get('agent_name_hint'), 'DeepSeek Harness')
    assert.notEqual(url.searchParams.get('ext_agent_host_id'), null)
    attempt.cancel()
    await assert.rejects(attempt.result)
  })

  it('refuses to hand out a credential when nobody signed in', async () => {
    const auth = new ChatGptAuth({ stateDir: await stateDir(), agentNameHint: 'DeepSeek Harness' })

    await assert.rejects(auth.usable(), /no ChatGPT account is signed in/)
  })

  it('mints one host id and reuses it across instances', async () => {
    const dir = await stateDir()
    const first = new ChatGptAuth({ stateDir: dir, agentNameHint: 'DeepSeek Harness' })
    const second = new ChatGptAuth({ stateDir: dir, agentNameHint: 'DeepSeek Harness' })

    assert.equal(second.hostId(), first.hostId())
    assert.match(first.hostId(), /^urn:uuid:[0-9a-f-]{36}$/)
  })
})
