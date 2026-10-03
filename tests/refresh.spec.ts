import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { refreshCredential, RefreshRefusedError } from '../src/auth/refresh.ts'
import type { ChatGptCredential } from '../src/auth/credential.ts'
import { startTokenServer } from './helpers.ts'

const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
})

const STORED: ChatGptCredential = {
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  expiresAt: Date.now() - 1000,
  clientId: 'oaiapp_issued',
  scopes: ['openid', 'chatgpt.tokens.use.direct'],
  subject: 'subject-1',
  email: 'me@example.com',
  savedAt: 1,
}

describe('refreshCredential', () => {
  it('sends the issued client id and omits scope', async () => {
    const token = await startTokenServer({
      body: { access_token: 'new', refresh_token: 'new-refresh', expires_in: 3600, scope: 'openid' },
    })
    closers.push(token.close)

    await refreshCredential(STORED, { tokenUrl: token.url })

    const request = token.requests.at(-1)
    assert.ok(request !== undefined)
    assert.equal(request.params.get('grant_type'), 'refresh_token')
    assert.equal(request.params.get('refresh_token'), 'old-refresh')
    // The issued id, never the dynamic entry point.
    assert.equal(request.params.get('client_id'), 'oaiapp_issued')
    assert.equal(request.params.get('resource'), 'https://api.openai.com/v1')
    // Granted scopes are fixed at authorization; refresh does not re-request them.
    assert.equal(request.params.get('scope'), null)
  })

  it('rotates both tokens and keeps the account identity', async () => {
    const token = await startTokenServer({
      body: {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
        scope: 'openid chatgpt.tokens.use.direct',
      },
    })
    closers.push(token.close)

    const rotated = await refreshCredential(STORED, { tokenUrl: token.url })

    assert.equal(rotated.accessToken, 'new-access')
    assert.equal(rotated.refreshToken, 'new-refresh')
    assert.equal(rotated.clientId, 'oaiapp_issued')
    assert.equal(rotated.subject, 'subject-1')
    assert.equal(rotated.email, 'me@example.com')
    assert.deepEqual(rotated.scopes, ['openid', 'chatgpt.tokens.use.direct'])
    // Discounted by the refresh margin, so no request starts with a dying token.
    assert.ok(rotated.expiresAt < Date.now() + 3600 * 1000)
    assert.ok(rotated.expiresAt > Date.now() + 3000 * 1000)
  })

  it('keeps the stored scopes when the response omits them', async () => {
    const token = await startTokenServer({
      body: { access_token: 'new', refresh_token: 'r', expires_in: 3600 },
    })
    closers.push(token.close)

    const rotated = await refreshCredential(STORED, { tokenUrl: token.url })

    assert.deepEqual(rotated.scopes, STORED.scopes)
  })

  it('reports a revoked grant as terminal, because retrying cannot help', async () => {
    const token = await startTokenServer({
      status: 400,
      body: { error: { code: 'invalid_grant', message: 'refresh token revoked' } },
    })
    closers.push(token.close)

    await assert.rejects(
      refreshCredential(STORED, { tokenUrl: token.url }),
      (error: unknown) => {
        assert.ok(error instanceof RefreshRefusedError)
        assert.equal(error.terminal, true)
        assert.match(error.message, /invalid_grant/)
        return true
      },
    )
  })

  it('treats an unrecognised refusal as transient', async () => {
    const token = await startTokenServer({ status: 503, body: { error: 'upstream_unavailable' } })
    closers.push(token.close)

    await assert.rejects(
      refreshCredential(STORED, { tokenUrl: token.url }),
      (error: unknown) => {
        assert.ok(error instanceof RefreshRefusedError)
        assert.equal(error.terminal, false)
        return true
      },
    )
  })

  it('refuses a response missing a rotated token', async () => {
    const token = await startTokenServer({ body: { access_token: 'new', expires_in: 3600 } })
    closers.push(token.close)

    await assert.rejects(refreshCredential(STORED, { tokenUrl: token.url }), /replacement refresh token/)
  })

  it('refuses a response missing a usable expiry', async () => {
    const token = await startTokenServer({ body: { access_token: 'new', refresh_token: 'r' } })
    closers.push(token.close)

    await assert.rejects(refreshCredential(STORED, { tokenUrl: token.url }), /expires_in/)
  })
})
