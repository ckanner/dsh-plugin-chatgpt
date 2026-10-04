import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatGptSession } from '../src/session.ts'
import { ChatGptAuth } from '../src/auth/manager.ts'
import { emptyDocument, writeDocument } from '../src/auth/store.ts'
import type { ChatGptAdapter } from '../src/adapter.ts'
import { idTokenClaims, jwt, startTokenServer, type TokenServer } from './helpers.ts'

const dirs: string[] = []
const tokenServers: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(tokenServers.splice(0).map(close => close()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A session over a fresh state directory, with a token endpoint and a spy adapter. */
async function sessionWith(token: TokenServer, revocationEndpoint?: string): Promise<{
  session: ChatGptSession
  forgotten: () => number
}> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-session-'))
  dirs.push(dir)
  let forgotten = 0
  const adapter = { forgetListing: () => { forgotten += 1 } } as unknown as ChatGptAdapter
  const auth = new ChatGptAuth({
    stateDir: dir,
    agentNameHint: 'DeepSeek Harness',
    endpoints: {
      tokenUrl: token.url,
      preferredPort: 0,
      ...revocationEndpoint === undefined ? {} : { revocationEndpoint },
    },
  })
  return { session: new ChatGptSession(auth, adapter), forgotten: () => forgotten }
}

/** A token endpoint answering a valid plan-scoped grant for the attempt's nonce. */
async function grantedTokenServer(nonce: { value: string }): Promise<TokenServer> {
  const server = await startTokenServer({
    reply: () => ({
      body: {
        access_token: 'access',
        refresh_token: 'refresh',
        id_token: jwt(idTokenClaims({ clientId: 'oaiapp_x', nonce: nonce.value, email: 'me@example.com', plan: 'plus' })),
        expires_in: 3600,
        scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      },
    }),
  })
  tokenServers.push(server.close)
  return server
}

describe('ChatGptSession', () => {
  it('reports nobody signed in before an attempt', async () => {
    const token = await startTokenServer({ body: {} })
    tokenServers.push(token.close)
    const { session } = await sessionWith(token)

    const status = session.status()

    assert.equal(status.signedIn, false)
    assert.equal(status.pending, undefined)
    assert.deepEqual(status.accounts, [])
  })

  it('opens an attempt and reports where to send the browser', async () => {
    const token = await startTokenServer({ body: {} })
    tokenServers.push(token.close)
    const { session } = await sessionWith(token)

    const status = await session.begin()

    assert.ok(status.pending !== undefined)
    assert.match(status.pending.url, /^https:\/\/auth\.openai\.com\/api\/accounts\/authorize\?/)
    assert.match(status.pending.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
    session.cancel()
  })

  it('cancels the previous attempt when a second one starts', async () => {
    const token = await startTokenServer({ body: {} })
    tokenServers.push(token.close)
    const { session } = await sessionWith(token)

    await session.begin()
    const first = session.status().pending
    const second = await session.begin()

    // Two live listeners would race for one callback, and the loser would report
    // a state mismatch the human could not act on.
    assert.notEqual(second.pending?.url, first?.url)
    session.cancel()
  })

  it('keeps the attempt open when a pasted value does not parse', async () => {
    const token = await startTokenServer({ body: {} })
    tokenServers.push(token.close)
    const { session } = await sessionWith(token)
    await session.begin()

    const status = await session.submit('http://elsewhere.example/callback?code=x')

    assert.match(status.error ?? '', /must start with/)
    // Still open, so a corrected paste can finish it.
    assert.ok(status.pending !== undefined)
    session.cancel()
  })

  it('refuses to submit when no attempt is open', async () => {
    const token = await startTokenServer({ body: {} })
    tokenServers.push(token.close)
    const { session } = await sessionWith(token)

    const status = await session.submit('anything')

    assert.match(status.error ?? '', /no sign-in attempt is open/)
  })

  it('adopts the grant a completed sign-in produces and drops the old roster', async () => {
    const nonce = { value: '' }
    const token = await grantedTokenServer(nonce)
    const { session, forgotten } = await sessionWith(token)

    const opened = await session.begin()
    const url = new URL(opened.pending?.url ?? '')
    nonce.value = url.searchParams.get('nonce') ?? ''
    const state = url.searchParams.get('state') ?? ''
    const redirect = opened.pending?.redirectUri ?? ''

    // The browser's path: the callback lands on the host's listener.
    const response = await fetch(`${redirect}?code=auth-code&state=${state}&client_id=oaiapp_x`)
    assert.equal(response.status, 200)

    // Give the completing promise a turn to adopt.
    await new Promise(resolve => setTimeout(resolve, 50))
    const status = session.status()

    assert.equal(status.signedIn, true)
    assert.equal(status.email, 'me@example.com')
    assert.equal(status.plan, 'plus')
    assert.equal(status.pending, undefined)
    assert.equal(forgotten(), 1)
  })

  it('finishes from a pasted redirect URL', async () => {
    const nonce = { value: '' }
    const token = await grantedTokenServer(nonce)
    const { session } = await sessionWith(token)

    const opened = await session.begin()
    const url = new URL(opened.pending?.url ?? '')
    nonce.value = url.searchParams.get('nonce') ?? ''
    const state = url.searchParams.get('state') ?? ''

    const status = await session.submit(
      `${opened.pending?.redirectUri ?? ''}?code=auth-code&state=${state}&client_id=oaiapp_x`,
    )

    assert.equal(status.signedIn, true)
    assert.equal(status.pending, undefined)
  })

  it('reports a declined authorization as the error for this attempt', async () => {
    const token = await startTokenServer({ body: {} })
    tokenServers.push(token.close)
    const { session } = await sessionWith(token)

    const opened = await session.begin()
    const url = new URL(opened.pending?.url ?? '')
    const state = url.searchParams.get('state') ?? ''
    await fetch(`${opened.pending?.redirectUri ?? ''}?error=access_denied&state=${state}`)
    await new Promise(resolve => setTimeout(resolve, 50))

    const status = session.status()

    assert.equal(status.signedIn, false)
    assert.match(status.error ?? '', /access_denied/)
    assert.equal(status.pending, undefined)
  })

  it('reports that signing out here is not the same as ending the grant', async () => {
    // A local sign-out while the server still holds a live grant is a different
    // outcome, and the card says which one happened rather than implying both.
    const token = await startTokenServer({ body: {} })
    tokenServers.push(token.close)
    const dir = await mkdtemp(join(tmpdir(), 'chatgpt-session-'))
    dirs.push(dir)
    writeDocument(join(dir, 'chatgpt-auth.json'), {
      ...emptyDocument('urn:uuid:x'),
      accounts: {
        'subject-1': {
          accessToken: 'access',
          refreshToken: 'refresh',
          expiresAt: Date.now() + 3600_000,
          clientId: 'oaiapp_issued',
          scopes: ['chatgpt.tokens.use.direct'],
          subject: 'subject-1',
          email: 'me@example.com',
          savedAt: Date.now(),
        },
      },
      active: 'subject-1',
    })
    const adapter = { forgetListing: () => {} } as unknown as ChatGptAdapter
    const auth = new ChatGptAuth({
      stateDir: dir,
      agentNameHint: 'DeepSeek Harness',
      endpoints: { tokenUrl: token.url, preferredPort: 0, revocationEndpoint: 'http://127.0.0.1:9/revoke' },
    })
    const session = new ChatGptSession(auth, adapter)

    assert.equal(session.status().signedIn, true)
    const outcome = await session.signOut()

    assert.equal(outcome.revocationConfirmed, false)
    assert.equal(outcome.status.signedIn, false)
    assert.ok((outcome.revocationError ?? '').length > 0)
  })

  it('treats signing out with nothing stored as already revoked', async () => {
    const token = await startTokenServer({ body: {} })
    tokenServers.push(token.close)
    const { session } = await sessionWith(token, 'http://127.0.0.1:9/revoke')

    const outcome = await session.signOut()

    // Nothing to revoke is not a failed revocation.
    assert.equal(outcome.revocationConfirmed, true)
    assert.equal(outcome.status.signedIn, false)
  })

  it('clears the pending attempt on cancel', async () => {
    const token = await startTokenServer({ body: {} })
    tokenServers.push(token.close)
    const { session } = await sessionWith(token)
    await session.begin()

    const status = session.cancel()

    assert.equal(status.pending, undefined)
  })
})
