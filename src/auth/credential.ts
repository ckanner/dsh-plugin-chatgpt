/**
 * The credential one successful sign-in produces, and the only shape the
 * request path reads.
 *
 * `clientId` is the issued id from the authorization callback, never the
 * dynamic entry point: it is what identifies this installation's registration
 * on every later refresh. `scopes` is kept because plan usage is a *granted*
 * capability, not a requested one — a deployment can authorize identity and
 * decline plan usage, and the difference only shows up here.
 *
 * @module dsh-plugin-chatgpt-subscription/auth/credential
 */

/** One account's stored grant. */
export interface ChatGptCredential {
  /** Bearer token for `https://api.openai.com/v1`. */
  accessToken: string
  /** Long-lived token that mints the next access token. */
  refreshToken: string
  /** Epoch milliseconds at which {@link accessToken} stops being usable, already discounted by the refresh margin. */
  expiresAt: number
  /** The issued client id (`oaiapp_…`) this credential is registered under. */
  clientId: string
  /** Every scope the server actually granted, space-split. */
  scopes: string[]
  /** Validated ID-token subject: the account identity, stable across sign-ins. */
  subject?: string
  /** Email from the validated ID token, for display only. */
  email?: string
  /** ChatGPT plan name from the validated ID token, for display only. */
  planType?: string
  /** When this record was last written, epoch milliseconds. */
  savedAt: number
}

/** Whether the stored grant includes the plan-usage scope. */
export function canSpendPlan(credential: ChatGptCredential): boolean {
  return credential.scopes.includes('chatgpt.tokens.use.direct')
}

/** Whether the access token still has useful life left. */
export function isFresh(credential: ChatGptCredential, now = Date.now()): boolean {
  return credential.expiresAt > now
}
