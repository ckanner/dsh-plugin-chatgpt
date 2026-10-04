/**
 * Ending a grant at the server, not just on this machine.
 *
 * Deleting a credential locally leaves it live at OpenAI: the refresh token stays
 * redeemable, and nothing tells the account that this installation gave up
 * access. Signing out therefore has to revoke the renewable session first and
 * clear local state second, and it has to report honestly when only the second
 * part happened — a user who is told "signed out" while the grant still works
 * elsewhere has been misled.
 *
 * The endpoint is not hard-coded. It is read from the authorization server's
 * discovery document, which is where the protocol says to find it; the known
 * value is only a fallback for the case where discovery is unreachable, because a
 * sign-out that cannot even find the endpoint should still try the documented one
 * rather than silently skip revocation.
 *
 * @module dsh-plugin-chatgpt/auth/revoke
 */

import type { ChatGptCredential } from './credential.ts'

/** Where the authorization server describes its endpoints. */
export const DISCOVERY_URL = 'https://auth.openai.com/.well-known/openid-configuration'

/** The revocation endpoint observed for this server, used only when discovery fails. */
export const FALLBACK_REVOCATION_ENDPOINT = 'https://auth.openai.com/api/accounts/oauth/revoke'

/** How many times a transient revocation failure is retried before giving up. */
const MAX_ATTEMPTS = 3

/** Base delay between revocation attempts, doubled per attempt. */
const BASE_BACKOFF_MS = 250

/** What a sign-out attempt achieved. */
export interface RevocationResult {
  /** Whether the server confirmed the grant is no longer usable. */
  confirmed: boolean
  /** Why it was not confirmed, for the human. */
  reason?: string
}

/** Options for {@link revokeGrant}. */
export interface RevokeOptions {
  /** Override the discovery document (tests). */
  discoveryUrl?: string
  /** Override the revocation endpoint (tests). */
  revocationEndpoint?: string
  /** Cancellation. */
  signal?: AbortSignal
}

/** Discovery is stable for a process, so it is read once. */
let discovered: string | undefined

/**
 * The revocation endpoint, from discovery when possible.
 *
 * @param options - endpoint overrides.
 * @returns the endpoint to post to.
 */
async function revocationEndpoint(options: RevokeOptions): Promise<string> {
  if (options.revocationEndpoint !== undefined) return options.revocationEndpoint
  if (discovered !== undefined) return discovered
  try {
    const response = await fetch(options.discoveryUrl ?? DISCOVERY_URL, {
      headers: { accept: 'application/json' },
      ...options.signal === undefined ? {} : { signal: options.signal },
    })
    if (response.ok) {
      const document = (await response.json()) as Record<string, unknown>
      const endpoint = document['revocation_endpoint']
      if (typeof endpoint === 'string' && endpoint.length > 0) {
        discovered = endpoint
        return endpoint
      }
    }
  } catch {
    // Discovery is a convenience here, not a requirement: the fallback below is
    // the documented endpoint for this server.
  }
  return FALLBACK_REVOCATION_ENDPOINT
}

/** Wait before one retry, without holding an aborted attempt open. */
function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, BASE_BACKOFF_MS * 2 ** attempt)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new Error('revocation was cancelled'))
    }, { once: true })
  })
}

/**
 * Revoke one grant's renewable session.
 *
 * A 5xx or a transport failure is retried, because the refresh token is still
 * available while the caller has not cleared it. Any other refusal is reported
 * as unconfirmed rather than retried: repeating it would not change the answer.
 *
 * @param credential - the grant to revoke.
 * @param options - endpoint overrides and cancellation.
 * @returns whether the server confirmed the revocation.
 */
export async function revokeGrant(
  credential: ChatGptCredential,
  options: RevokeOptions = {},
): Promise<RevocationResult> {
  const endpoint = await revocationEndpoint(options)
  let lastReason = 'the revocation request did not complete'
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      try {
        await backoff(attempt - 1, options.signal)
      } catch (error) {
        return { confirmed: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          token: credential.refreshToken,
          token_type_hint: 'refresh_token',
          client_id: credential.clientId,
        }),
        ...options.signal === undefined ? {} : { signal: options.signal },
      })
      // An empty 200 is the documented success, including for a token that was
      // already invalid — so a second sign-out is not an error.
      if (response.ok) return { confirmed: true }
      const body = await response.text().catch(() => '')
      lastReason = `the server refused the revocation (${response.status})${body.length > 0 ? `: ${body.slice(0, 200)}` : ''}`
      // Only a server-side failure is worth retrying; a refusal of the request
      // itself would be refused again.
      if (response.status < 500) return { confirmed: false, reason: lastReason }
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error)
    }
  }
  return { confirmed: false, reason: lastReason }
}
