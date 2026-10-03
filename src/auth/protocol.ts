/**
 * The exact strings OpenAI's "Sign in with ChatGPT" flow is built from.
 *
 * Every value here is transcribed from OpenAI's published OSS token-sharing
 * documentation rather than inferred from a library, because each one is a
 * contract the server checks: a misspelled scope silently grants less than the
 * caller asked for, and a callback URI differing by one path segment is
 * refused at code exchange after the human has already approved the sign-in.
 *
 * The flow registers a client dynamically. `dynamic_agent_client` is an
 * *entry point*, not an identity: the authorization callback returns an issued
 * `oaiapp_…` client id, and every later sign-in and refresh for that account
 * must use the issued one. Storing the entry point in its place produces a
 * credential that works once and can never be refreshed.
 *
 * @module dsh-plugin-chatgpt-subscription/auth/protocol
 */

/** Where the browser is sent to authorize. */
export const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize'

/** Where an authorization code, and later a refresh token, is exchanged. */
export const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token'

/** The resource the granted token is scoped to; sent on both exchanges. */
export const RESOURCE = 'https://api.openai.com/v1'

/** The entry-point client id used only for a first-time registration. */
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client'

/**
 * The plan-usage scope. Its presence in the granted scopes is the *only*
 * evidence that the ChatGPT plan may be spent on inference; a valid ID token
 * without it authorizes identity and nothing else.
 */
export const DIRECT_TOKEN_SCOPE = 'chatgpt.tokens.use.direct'

/** Identity scopes plus refresh and plan usage, in the documented spelling. */
export const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`

/**
 * The callback path. Fixed by the server: `/callback` does not match
 * `/auth/callback`, and the whole URI must be byte-identical between the
 * authorization request and the code exchange.
 */
export const CALLBACK_PATH = '/auth/callback'

/**
 * The port OpenAI's own tooling uses. A loopback callback may legitimately use
 * any free port — only the scheme, host, and path are fixed — so this is a
 * preference, never a requirement, and a busy port falls through to one the
 * operating system picks.
 */
export const PREFERRED_CALLBACK_PORT = 1455

/** The loopback host. `localhost` is explicitly not a substitute. */
export const CALLBACK_HOST = '127.0.0.1'

/** How long a pending authorization attempt is given before it is abandoned. */
export const AUTHORIZATION_TIMEOUT_MS = 15 * 60 * 1000

/** Refresh this long before the real expiry so no request starts with a stale token. */
export const EXPIRY_MARGIN_MS = 3 * 60 * 1000

/** Build the callback URI for one attempt. */
export function callbackUri(port: number): string {
  return `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`
}
