/**
 * The sign-in session: one open attempt, and the account facts around it.
 *
 * This is the logic the browser card drives, kept apart from the Remote
 * decorators that carry it, because the interesting parts are the state
 * transitions — one attempt at a time, a refused paste leaving the attempt open,
 * a completed sign-in invalidating the roster the previous account produced — and
 * those are worth testing without a gateway in the way.
 *
 * @module dsh-plugin-chatgpt/session
 */

import type { ChatGptAdapter } from './adapter.ts'
import type { ChatGptAuth } from './auth/manager.ts'
import type { SignInAttempt } from './auth/sign-in.ts'

/** An attempt the page can finish. */
export interface ChatGptPendingView {
  /** Where to send the browser. */
  url: string
  /** The loopback address the browser returns to; only this exact address is accepted. */
  redirectUri: string
}

/** Everything the sign-in card may show. */
/** What a sign-out achieved, when it did not achieve everything. */
export interface ChatGptSignOutOutcome {
  /** The state after signing out locally. */
  status: ChatGptStatusView
  /**
   * Whether the server confirmed the grant is no longer usable. `false` means
   * the credential is gone from this machine but may still be live elsewhere,
   * which the human is told rather than left to assume.
   */
  revocationConfirmed: boolean
  /** Why the server did not confirm, when it did not. */
  revocationError?: string
}

export interface ChatGptStatusView {
  /** Whether an account is authorized and may spend its plan. */
  signedIn: boolean
  /** Whether a grant exists but plan usage was not authorized. */
  planUsageDenied: boolean
  /** The active account's email, when the ID token carried one. */
  email?: string
  /** The active account's ChatGPT plan, when known. */
  plan?: string
  /** When the active access token stops being usable, epoch milliseconds. */
  expiresAt?: number
  /** Every authorized account, for a future account switcher. */
  accounts: { subject: string, email?: string, active: boolean }[]
  /** The attempt awaiting the browser, when one is open. */
  pending?: ChatGptPendingView
  /** Why the last attempt failed, until another one starts. */
  error?: string
}

/** How long `submit` waits for the token exchange before answering. */
const SUBMIT_TIMEOUT_MS = 30_000

/**
 * Owns the one open sign-in attempt and projects the account state for a page.
 *
 * One attempt at a time per instance: two live loopback listeners for the same
 * account would race for the same callback, and the loser would report a state
 * mismatch the human could do nothing about.
 */
export class ChatGptSession {
  private readonly auth: ChatGptAuth
  private readonly adapter: ChatGptAdapter
  private pending: SignInAttempt | undefined
  private lastError: string | undefined
  private completing: Promise<void> | undefined

  /**
   * @param auth - the credential owner this session drives.
   * @param adapter - the provider adapter, told to re-ask the account after a change.
   */
  constructor(auth: ChatGptAuth, adapter: ChatGptAdapter) {
    this.auth = auth
    this.adapter = adapter
  }

  /** What the card should render now. */
  status(): ChatGptStatusView {
    const status = this.auth.status()
    const pending = this.pending
    return {
      ...status,
      ...pending === undefined ? {} : {
        pending: { url: pending.authorizationUrl, redirectUri: pending.redirectUri },
      },
      ...this.lastError === undefined ? {} : { error: this.lastError },
    }
  }

  /**
   * Open an attempt and answer with the URL to visit.
   * @returns the state, now carrying a pending attempt.
   */
  async begin(): Promise<ChatGptStatusView> {
    this.cancelPending()
    this.lastError = undefined
    try {
      const attempt = await this.auth.begin()
      this.pending = attempt
      this.completing = attempt.result.then(
        (credential) => {
          this.auth.adopt(credential)
          // The roster is per account, so a listing produced by the previous
          // account must not outlive the sign-in that replaces it.
          this.adapter.forgetListing()
          this.pending = undefined
        },
        (error: unknown) => {
          this.lastError = error instanceof Error ? error.message : String(error)
          this.pending = undefined
        },
      )
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
    }
    return this.status()
  }

  /**
   * Finish the open attempt from a pasted redirect URL or code.
   *
   * A malformed value is reported as this attempt's error and leaves the attempt
   * open, so a mistyped paste can be corrected without starting over.
   *
   * @param value - the full redirect URL, or the code itself.
   * @returns the state after the exchange settles.
   */
  async submit(value: string): Promise<ChatGptStatusView> {
    const attempt = this.pending
    if (attempt === undefined) {
      this.lastError = 'no sign-in attempt is open; start one first'
      return this.status()
    }
    try {
      await attempt.submit(value)
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      return this.status()
    }
    await this.settle()
    return this.status()
  }

  /**
   * Abandon the open attempt.
   * @returns the state with no pending attempt.
   */
  cancel(): ChatGptStatusView {
    this.cancelPending()
    return this.status()
  }

  /**
   * End one account's session, at the server first and locally second.
   * @param subject - the account to end; defaults to the active one.
   * @returns the state, and whether the server confirmed the revocation.
   */
  async signOut(subject?: string): Promise<ChatGptSignOutOutcome> {
    this.cancelPending()
    const result = await this.auth.revoke(subject)
    this.adapter.forgetListing()
    return {
      status: this.status(),
      revocationConfirmed: result.confirmed,
      ...result.reason === undefined ? {} : { revocationError: result.reason },
    }
  }

  /** Wait for an in-flight exchange to settle, within one answer's patience. */
  private async settle(): Promise<void> {
    const completing = this.completing
    if (completing === undefined) return
    await Promise.race([
      completing,
      new Promise<void>(resolve => { setTimeout(resolve, SUBMIT_TIMEOUT_MS) }),
    ])
  }

  /** Abandon the open attempt, if any. */
  private cancelPending(): void {
    const attempt = this.pending
    this.pending = undefined
    this.completing = undefined
    attempt?.cancel('superseded by a new sign-in attempt')
  }
}
