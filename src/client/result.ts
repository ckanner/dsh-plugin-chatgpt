/**
 * Unwrapping what a Remote call resolves to.
 *
 * A namespace method never rejects for a business or transport failure: it
 * resolves to an envelope carrying either the value or the refusal, and leaves the
 * decision to the caller. That is easy to miss, and missing it is silent — the
 * envelope rendered as if it were the value produced a card that showed "Signed
 * out" while a sign-in attempt was in fact running, so a working button looked
 * like a button that did nothing.
 *
 * Kept apart from the card, and free of React, so the rule can be tested directly.
 *
 * @module dsh-plugin-chatgpt/client/result
 */

/** What a Remote call resolves to. */
export type RemoteResult<T> =
  | { ok: true, value: T }
  | { ok: false, error: { code?: string, message?: string } }

/**
 * Unwrap a Remote result, turning a refusal into a thrown error.
 *
 * The card's handlers already report a throw as the account error, so a refused
 * call reaches the human rather than being mistaken for a state.
 *
 * @param result - the envelope the namespace method resolved to.
 * @returns the value it carries.
 * @throws When the call was refused, naming the Host's code and message.
 */
export function unwrap<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  const { code, message } = result.error ?? {}
  if (message === undefined || message.length === 0) {
    return refuse(code)
  }
  throw new Error(code === undefined || code.length === 0 ? message : `${code}: ${message}`)
}

/**
 * The error for a refusal that carried no message of its own.
 * @param code - the Host's code, when it sent one.
 * @returns never; always throws.
 */
function refuse(code: string | undefined): never {
  throw new Error(code === undefined || code.length === 0
    ? 'the ChatGPT service refused the request'
    : `the ChatGPT service refused the request (${code})`)
}
