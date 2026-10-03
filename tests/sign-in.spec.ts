import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { beginSignIn } from '../src/auth/sign-in.ts'
import { idTokenClaims, jwt, startTokenServer, type TokenServer } from './helpers.ts'

const AGENT_HOST_ID = 'urn:uuid:6f1c1a1e-2b3d-4c5e-8f90-1234567890ab'
const closers: (() => Promise<void>)[] = []

/**
 * The nonce the attempt under test generated. A real token endpoint echoes the
 * nonce from the ID token it mints; the mock reads it from here, and each test
 * publishes its attempt's value before answering.
 */
const nonce = { value: '' }

afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
})

/** The query parameters of one authorization URL. */
function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams
}

describe('beginSignIn', () => {
  it('sends the documented first-registration parameters', async () => {
    const token = await startTokenServer({ body: {} })
    closers.push(token.close)
    const attempt = await beginSignIn({
      agentHostId: AGENT_HOST_ID,
      agentNameHint: 'DeepSeek Harness',
      tokenUrl: token.url,
      preferredPort: 0,
    })
    const params = paramsOf(attempt.authorizationUrl)

    assert.equal(params.get('client_id'), 'dynamic_agent_client')
    assert.equal(params.get('agent_name_hint'), 'DeepSeek Harness')
    assert.equal(params.get('ext_agent_host_id'), AGENT_HOST_ID)
    assert.equal(params.get('response_type'), 'code')
    assert.equal(params.get('code_challenge_method'), 'S256')
    assert.equal(params.get('resource'), 'https://api.openai.com/v1')
    assert.equal(
      params.get('scope'),
      'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    )
    // Only the port may vary, and the URI handed out must be the one listening.
    assert.equal(params.get('redirect_uri'), attempt.redirectUri)
    assert.match(attempt.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
    assert.ok((params.get('state') ?? '').length > 10)
    assert.ok((params.get('nonce') ?? '').length > 10)

    attempt.cancel()
    await assert.rejects(attempt.result)
    void token
  })

  it('refuses a callback whose state does not match the attempt', async () => {
    const token = await startTokenServer({ body: {} })
    closers.push(token.close)
    const attempt = await beginSignIn({
      agentHostId: AGENT_HOST_ID,
      agentNameHint: 'DeepSeek Harness',
      tokenUrl: token.url,
      preferredPort: 0,
    })
    const nonce = paramsOf(attempt.authorizationUrl).get('nonce') ?? ''
    assert.ok(nonce.length > 0)

    // A code delivered with somebody else's state must be refused outright.
    // Attach before the callback travels: the attempt settles as soon as the
    // request is handled, which can be while this test is still awaiting it.
    const refusedResult = assert.rejects(attempt.result, /state/)
    const forged = `${attempt.redirectUri}?code=stolen&state=not-this-attempt&client_id=oaiapp_test123`
    const refused = await fetch(forged)
    assert.equal(refused.status, 200)
    await refusedResult
  })

  it('treats a declined authorization as a refusal, not a crash', async () => {
    const token = await startTokenServer({ body: {} })
    closers.push(token.close)
    const attempt = await beginSignIn({
      agentHostId: AGENT_HOST_ID,
      agentNameHint: 'DeepSeek Harness',
      tokenUrl: token.url,
      preferredPort: 0,
    })
    const state = paramsOf(attempt.authorizationUrl).get('state') ?? ''
    const refusedResult = assert.rejects(attempt.result, /access_denied/)
    const declined = await fetch(`${attempt.redirectUri}?error=access_denied&state=${state}`)
    assert.equal(declined.status, 400)
    await refusedResult
  })

  it('exchanges the browser callback for a stored-ready credential', async () => {
    const clientId = 'oaiapp_browser123'
    const token = await startTokenServer({
      reply: () => ({
        body: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          id_token: jwt(idTokenClaims({
            clientId, nonce: nonce.value, email: 'me@example.com', plan: 'pro',
          })),
          expires_in: 3600,
          scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
        },
      }),
    })
    closers.push(token.close)
    const attempt = await beginSignIn({
      agentHostId: AGENT_HOST_ID,
      agentNameHint: 'DeepSeek Harness',
      tokenUrl: token.url,
      preferredPort: 0,
    })
    const params = paramsOf(attempt.authorizationUrl)
    const state = params.get('state') ?? ''
    nonce.value = params.get('nonce') ?? ''

    const response = await fetch(`${attempt.redirectUri}?code=auth-code&state=${state}&client_id=${clientId}`)
    assert.equal(response.status, 200)

    const credential = await attempt.result
    assert.equal(credential.accessToken, 'access-token')
    assert.equal(credential.refreshToken, 'refresh-token')
    assert.equal(credential.clientId, clientId)
    assert.equal(credential.email, 'me@example.com')
    assert.equal(credential.planType, 'pro')
    assert.equal(credential.subject, 'subject-1')
    assert.deepEqual(credential.scopes, [
      'openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct',
    ])
    assert.ok(credential.expiresAt > Date.now())

    const exchange = token.requests.at(-1)
    assert.ok(exchange !== undefined)
    assert.equal(exchange.contentType, 'application/x-www-form-urlencoded')
    assert.equal(exchange.params.get('grant_type'), 'authorization_code')
    assert.equal(exchange.params.get('client_id'), clientId)
    assert.equal(exchange.params.get('code'), 'auth-code')
    assert.equal(exchange.params.get('redirect_uri'), attempt.redirectUri)
    assert.equal(exchange.params.get('resource'), 'https://api.openai.com/v1')
    assert.ok((exchange.params.get('code_verifier') ?? '').length > 10)
  })

  it('accepts a pasted redirect URL instead of the browser callback', async () => {
    const clientId = 'oaiapp_paste123'
    const token = await startTokenServer({
      reply: () => ({
        body: {
          access_token: 'pasted-access',
          refresh_token: 'pasted-refresh',
          id_token: jwt(idTokenClaims({ clientId, nonce: nonce.value, email: 'pasted@example.com' })),
          expires_in: 3600,
          scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
        },
      }),
    })
    closers.push(token.close)
    const attempt = await beginSignIn({
      agentHostId: AGENT_HOST_ID,
      agentNameHint: 'DeepSeek Harness',
      tokenUrl: token.url,
      preferredPort: 0,
    })
    const params = paramsOf(attempt.authorizationUrl)
    nonce.value = params.get('nonce') ?? ''

    await attempt.submit(`${attempt.redirectUri}?code=pasted-code&state=${params.get('state') ?? ''}&client_id=${clientId}`)

    const credential = await attempt.result
    assert.equal(credential.accessToken, 'pasted-access')
    assert.equal(credential.email, 'pasted@example.com')
  })

  it('keeps the attempt alive when a paste is malformed', async () => {
    const token = await startTokenServer({ body: {} })
    closers.push(token.close)
    const attempt = await beginSignIn({
      agentHostId: AGENT_HOST_ID,
      agentNameHint: 'DeepSeek Harness',
      tokenUrl: token.url,
      preferredPort: 0,
    })

    await assert.rejects(attempt.submit('http://elsewhere.example/callback?code=x'), /must start with/)
    // The attempt is still usable, so a corrected paste can finish it.
    attempt.cancel()
    await assert.rejects(attempt.result, /cancelled/)
  })

  it('refuses a grant that is missing the plan-usage scope', async () => {
    const token = await startTokenServer({
      reply: () => ({
        body: {
          access_token: 'a',
          refresh_token: 'r',
          id_token: jwt(idTokenClaims({ clientId: 'oaiapp_x', nonce: nonce.value })),
          expires_in: 3600,
          scope: 'openid profile email offline_access',
        },
      }),
    })
    closers.push(token.close)
    const attempt = await beginSignIn({
      agentHostId: AGENT_HOST_ID,
      agentNameHint: 'DeepSeek Harness',
      tokenUrl: token.url,
      preferredPort: 0,
    })
    const params = paramsOf(attempt.authorizationUrl)
    nonce.value = params.get('nonce') ?? ''

    const refusedResult = assert.rejects(attempt.result, /chatgpt\.tokens\.use\.direct/)
    await attempt.submit(`${attempt.redirectUri}?code=c&state=${params.get('state') ?? ''}&client_id=oaiapp_x`)
    await refusedResult
  })

  it('refuses a first-registration callback that issued no client id', async () => {
    const token = await startTokenServer({ body: {} })
    closers.push(token.close)
    const attempt = await beginSignIn({
      agentHostId: AGENT_HOST_ID,
      agentNameHint: 'DeepSeek Harness',
      tokenUrl: token.url,
      preferredPort: 0,
    })
    const state = paramsOf(attempt.authorizationUrl).get('state') ?? ''
    const refusedResult = assert.rejects(attempt.result, /no issued client id/)

    const response = await fetch(`${attempt.redirectUri}?code=auth-code&state=${state}`)
    assert.equal(response.status, 200)
    await refusedResult
  })

  it('reuses an existing registration instead of registering again', async () => {
    const token = await startTokenServer({ body: {} })
    closers.push(token.close)
    const attempt = await beginSignIn({
      agentHostId: AGENT_HOST_ID,
      agentNameHint: 'DeepSeek Harness',
      tokenUrl: token.url,
      preferredPort: 0,
      registration: { clientId: 'oaiapp_returning', loginHint: 'me@example.com' },
    })
    const params = paramsOf(attempt.authorizationUrl)

    assert.equal(params.get('client_id'), 'oaiapp_returning')
    assert.equal(params.get('login_hint'), 'me@example.com')
    // The entry point and its name hint are only for first-time registration.
    assert.equal(params.get('agent_name_hint'), null)
    attempt.cancel()
    await assert.rejects(attempt.result)
  })
})
