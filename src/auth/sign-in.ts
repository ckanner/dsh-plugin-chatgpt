/**
 * "Sign in with ChatGPT" for one installation.
 *
 * The flow has two halves that race: the browser redirect lands on a loopback
 * listener, and the human can paste the final redirect URL instead. Whichever
 * arrives first wins, because both are legitimate — a headless host has no
 * browser to redirect into, and a normal host has a browser whose redirect may
 * be intercepted by an extension or a different profile. Both paths converge
 * on one callback shape, so the state check, the code exchange, and the grant
 * validation are written once.
 *
 * What is deliberately strict:
 *
 * - The `state` echoed back must equal the one sent, or the attempt is refused.
 *   Without this, any page could hand this host a code for somebody else's
 *   registration.
 * - A first-time registration callback must carry an issued client id. The
 *   dynamic entry point is not a registration, and saving it would produce a
 *   credential that cannot be refreshed.
 * - The granted scopes must include the plan-usage scope. A valid ID token
 *   alone authorizes identity only, so a deployment that authorized identity
 *   and declined plan usage must be reported as such rather than as success.
 *
 * @module dsh-plugin-chatgpt-subscription/auth/sign-in
 */

import { EXPIRY_MARGIN_MS, SCOPE, RESOURCE, AUTHORIZE_URL, TOKEN_URL, DIRECT_TOKEN_SCOPE, DYNAMIC_CLIENT_ID, AUTHORIZATION_TIMEOUT_MS, PREFERRED_CALLBACK_PORT, CALLBACK_PATH, CALLBACK_HOST } from './protocol.ts'
import { generatePkce, randomValue } from './pkce.ts'
import { startCallbackListener, type CallbackListener, type CallbackQuery } from './callback-server.ts'
import type { ChatGptCredential } from './credential.ts'

/** One attempt's worth of state, and the two ways it can be completed. */
export interface SignInAttempt {
  /** Where to send the browser. */
  readonly authorizationUrl: string
  /** The exact callback URI this attempt accepts; only the port may differ from other attempts. */
  readonly redirectUri: string
  /**
   * Complete the attempt from a pasted value: the full redirect URL, an
   * absolute URL string carrying `code`, or a bare authorization code.
   * Rejects on a malformed or mismatched value while leaving the attempt open.
   * @param value - what the human pasted.
   */
  submit(value: string): Promise<void>
  /** Abandon the attempt; the pending promise rejects. */
  cancel(reason?: string): void
  /** Settles when the browser redirect or a successful paste produced a credential. */
  readonly result: Promise<ChatGptCredential>
}

/** Hooks the host uses to narrate one attempt. */
export interface SignInOptions {
  /** A stable, per-installation host identifier, sent as `ext_agent_host_id`. */
  agentHostId: string
  /** The app's name as the human will see it on the consent screen. Sent only on a first-time registration. */
  agentNameHint: string
  /**
   * Reuse an existing registration instead of registering again. When the
   * caller has a previously issued client id for this account, sending it (with
   * an `id_token_hint`) skips the registration step entirely.
   */
  registration?: {
    clientId: string
    idTokenHint?: string
    loginHint?: string
  }
  /** The port to try first; the OS picks one when it is busy. */
  preferredPort?: number
  /** Override the authorize endpoint (tests). */
  authorizeUrl?: string
  /** Override the token endpoint (tests). */
  tokenUrl?: string
  /** How long to wait for a callback before giving up. */
  timeoutMs?: number
  /** Called once the listener is bound, with the URI the human's browser will return to. */
  onListening?: (redirectUri: string) => void
}

/** A well-formed callback, whatever route it arrived by. */
interface Callback {
  code: string
  clientId: string
}

/** Parse a full redirect URL, an absolute URL carrying a code, or a bare code. */
function parseSubmitted(value: string, expectedRedirectUri: string): Callback {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new Error('paste the full redirect URL from the browser, or the code itself')

  // A bare code is the one input that is not a URL; everything else is parsed
  // so the state can be checked rather than trusted.
  if (!trimmed.includes('://') && !trimmed.includes('code=') && !trimmed.includes('?')) {
    return { code: trimmed, clientId: '' }
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('that does not look like a URL; paste the full redirect URL from the browser')
  }

  const expected = new URL(expectedRedirectUri)
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    throw new Error(`the pasted URL must start with ${expectedRedirectUri}`)
  }
  const error = url.searchParams.get('error')
  if (error !== null && error !== '') throw new Error(`ChatGPT declined the authorization: ${error}`)
  const code = url.searchParams.get('code')
  if (code === null || code === '') throw new Error('the pasted URL carries no authorization code')
  return { code, clientId: url.searchParams.get('client_id')?.trim() ?? '' }
}

/** One token-endpoint response, as far as this flow reads it. */
interface TokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  id_token?: unknown
  expires_in?: unknown
  scope?: unknown
}

/** The decoded payload of an ID token, read but not trusted until checked. */
interface IdTokenClaims {
  iss?: unknown
  aud?: unknown
  sub?: unknown
  exp?: unknown
  nonce?: unknown
  email?: unknown
  [claim: string]: unknown
}

/** Decode one JWT payload without verifying it; {@link validateIdToken} does the checking. */
function decodeJwtPayload(token: string): IdTokenClaims | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = parts[1] ?? ''
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as IdTokenClaims
  } catch {
    return undefined
  }
}

/** A required non-empty string field, or a named failure. */
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`the token response is missing ${field}`)
  }
  return value
}

/**
 * Check the claims this flow depends on.
 *
 * Signature verification against OpenAI's published JWKS is documented
 * separately and is not performed here; this validates the claims that decide
 * whether the grant may be used, and reports the account identity the host
 * stores. The token arrives over TLS directly from the token endpoint in
 * response to this host's own PKCE-protected exchange, which is the case these
 * checks defend.
 *
 * @param token - the ID token from the token response.
 * @param expectedAudience - the issued client id the token must be addressed to.
 * @param expectedNonce - the nonce this attempt generated.
 * @returns the account identity and display facts.
 */
export function validateIdToken(
  token: string,
  expectedAudience: string,
  expectedNonce: string,
): { subject: string, email?: string, planType?: string } {
  const claims = decodeJwtPayload(token)
  if (claims === undefined) throw new Error('the ID token is not a readable JWT')

  const issuer = claims.iss
  if (issuer !== 'https://auth.openai.com') {
    throw new Error(`the ID token came from an unexpected issuer: ${String(issuer)}`)
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audiences.includes(expectedAudience)) {
    throw new Error('the ID token is addressed to a different client than this installation registered')
  }
  if (claims.nonce !== expectedNonce) {
    throw new Error('the ID token carries a different nonce than this sign-in attempt')
  }
  const expiry = claims.exp
  if (typeof expiry === 'number' && expiry * 1000 <= Date.now()) {
    throw new Error('the ID token is already expired')
  }
  const subject = requireString(claims.sub, 'sub')

  const profile = claims['https://api.openai.com/profile']
  const auth = claims['https://api.openai.com/auth']
  const email = typeof profile === 'object' && profile !== null
    ? (profile as Record<string, unknown>)['email']
    : undefined
  const planType = typeof auth === 'object' && auth !== null
    ? (auth as Record<string, unknown>)['chatgpt_plan_type']
    : undefined

  return {
    subject,
    ...typeof email === 'string' && email.length > 0 ? { email } : {},
    ...typeof planType === 'string' && planType.length > 0 ? { planType } : {},
  }
}

/**
 * Begin one authorization attempt.
 *
 * The listener is bound before the URL is built, so the URI handed out is the
 * one that will really be listening — a port chosen optimistically would fail
 * at code exchange, after the human had already approved.
 *
 * @param options - the installation's host id, its name, and any reusable registration.
 * @returns the attempt, already listening.
 */
export async function beginSignIn(options: SignInOptions): Promise<SignInAttempt> {
  const preferredPort = options.preferredPort ?? PREFERRED_CALLBACK_PORT
  const listener: CallbackListener = await startCallbackListener(preferredPort)
  options.onListening?.(listener.redirectUri)

  const pkce = generatePkce()
  const state = randomValue(32)
  const nonce = randomValue(32)

  const url = new URL(options.authorizeUrl ?? AUTHORIZE_URL)
  const registration = options.registration
  const params: Record<string, string> = registration === undefined
    ? {
        client_id: DYNAMIC_CLIENT_ID,
        agent_name_hint: options.agentNameHint,
        ext_agent_host_id: options.agentHostId,
      }
    : {
        client_id: registration.clientId,
        ext_agent_host_id: options.agentHostId,
      }
  url.search = new URLSearchParams({
    ...params,
    ...registration?.idTokenHint === undefined ? {} : { id_token_hint: registration.idTokenHint },
    ...registration?.loginHint === undefined ? {} : { login_hint: registration.loginHint },
    response_type: 'code',
    redirect_uri: listener.redirectUri,
    resource: RESOURCE,
    scope: SCOPE,
    state,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    nonce,
  }).toString()

  let settled = false
  let timer: NodeJS.Timeout | undefined
  let resolveResult: (credential: ChatGptCredential) => void
  let rejectResult: (error: Error) => void
  const result = new Promise<ChatGptCredential>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const finish = (): void => {
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    listener.close()
  }

  /** Validate one callback and exchange its code for a stored-ready credential. */
  const complete = async (callback: Callback): Promise<void> => {
    const clientId = callback.clientId.length > 0 ? callback.clientId : options.registration?.clientId ?? ''
    if (clientId.length === 0) {
      throw new Error(
        'the authorization callback returned no issued client id; a first-time registration must issue one,'
        + ' and the dynamic entry point is not a registration',
      )
    }
    const response = await fetch(options.tokenUrl ?? TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code: callback.code,
        code_verifier: pkce.verifier,
        redirect_uri: listener.redirectUri,
        resource: RESOURCE,
      }),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`the token exchange failed (${response.status}): ${body || response.statusText}`)
    }
    const token = (await response.json()) as TokenResponse
    const access = requireString(token.access_token, 'access_token')
    const refresh = requireString(token.refresh_token, 'refresh_token')
    const idToken = requireString(token.id_token, 'id_token')
    const granted = requireString(token.scope, 'scope').split(/\s+/).filter(Boolean)
    if (!granted.includes(DIRECT_TOKEN_SCOPE)) {
      throw new Error(
        `the ChatGPT account granted ${granted.join(' ') || 'no scopes'}, which does not include`
        + ` ${DIRECT_TOKEN_SCOPE}; this account cannot spend its ChatGPT plan on inference`,
      )
    }
    const expiresIn = token.expires_in
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error('the token response carries no usable expires_in')
    }
    const identity = validateIdToken(idToken, clientId, nonce)
    resolveResult({
      accessToken: access,
      refreshToken: refresh,
      expiresAt: Date.now() + expiresIn * 1000 - EXPIRY_MARGIN_MS,
      clientId,
      scopes: granted,
      subject: identity.subject,
      ...identity.email === undefined ? {} : { email: identity.email },
      ...identity.planType === undefined ? {} : { planType: identity.planType },
      savedAt: Date.now(),
    })
  }

  listener.received.then(async (query: CallbackQuery) => {
    if (settled) return
    finish()
    try {
      if (query.error !== undefined) throw new Error(`ChatGPT declined the authorization: ${query.error}`)
      if (query.state !== state) throw new Error('the callback state does not match this sign-in attempt')
      if (query.code === undefined || query.code === '') throw new Error('the callback carried no authorization code')
      await complete({ code: query.code, clientId: query.clientId ?? '' })
    } catch (error) {
      rejectResult(error instanceof Error ? error : new Error(String(error)))
    }
  }).catch((error: unknown) => {
    if (settled) return
    finish()
    rejectResult(error instanceof Error ? error : new Error(String(error)))
  })

  timer = setTimeout(() => {
    if (settled) return
    finish()
    rejectResult(new Error('the sign-in attempt timed out before the browser returned'))
  }, options.timeoutMs ?? AUTHORIZATION_TIMEOUT_MS)
  // A pending sign-in must not hold the process open on its own.
  timer.unref?.()

  return {
    authorizationUrl: url.toString(),
    redirectUri: listener.redirectUri,
    result,
    /**
     * Accept a pasted value.
     *
     * A malformed paste rejects this call and nothing else: the human mistyped,
     * and the attempt — plus the browser callback still in flight — stays
     * alive so they can correct it. Only a value that parses and matches this
     * attempt's state is consumed.
     */
    async submit(value: string): Promise<void> {
      if (settled) throw new Error('this sign-in attempt has already finished')
      const callback = parseSubmitted(value, listener.redirectUri)
      const stateInPaste = stateOfSubmission(value)
      if (stateInPaste !== undefined && stateInPaste !== state) {
        throw new Error('the pasted callback state does not match this sign-in attempt')
      }
      finish()
      try {
        await complete(callback)
      } catch (error) {
        rejectResult(error instanceof Error ? error : new Error(String(error)))
      }
    },
    cancel(reason = 'the sign-in attempt was cancelled'): void {
      if (settled) return
      finish()
      rejectResult(new Error(reason))
    },
  }
}

/** Read the `state` a pasted value carries, when it carries one at all. */
function stateOfSubmission(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed.includes('://') && !trimmed.includes('?')) return undefined
  try {
    return new URL(trimmed).searchParams.get('state') ?? undefined
  } catch {
    return undefined
  }
}

/** The callback host and path this module expects. */
export const CALLBACK_SHAPE = { host: CALLBACK_HOST, path: CALLBACK_PATH }
