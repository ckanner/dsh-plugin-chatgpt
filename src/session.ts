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
  /**
   * What the account can serve right now.
   *
   * The card reports this rather than promising a list of its own: the models a
   * selector shows come from the Host catalog, so a count here is the honest
   * statement, and a listing that fails says so instead of looking empty.
   */
  roster?: { count: number, error?: string }
  /** Why the last attempt failed, until another one starts. */
  error?: string
}

/** How long `submit` waits for the token exchange before answering. */
const SUBMIT_TIMEOUT_MS = 30_000

/** What a session tells its owner when the models it can serve change. */
export interface ChatGptSessionOptions {
  /**
   * Called after the roster changes.
   *
   * A model selector caches the Host catalog and reloads it only when the Host says
   * something changed. Signing in turns an empty roster into a full one, so without
   * this the selector keeps a list built before the account existed — the models
   * are being served and simply never appear.
   */
  onRosterChanged?: () => void
}

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
  private readonly onRosterChanged: () => void
  private pending: SignInAttempt | undefined
  private lastError: string | undefined
  private completing: Promise<void> | undefined

  /**
   * @param auth - the credential owner this session drives.
   * @param adapter - the provider adapter, told to re-ask the account after a change.
   * @param options - what to announce when the roster changes.
   */
  constructor(auth: ChatGptAuth, adapter: ChatGptAdapter, options: ChatGptSessionOptions = {}) {
    this.auth = auth
    this.adapter = adapter
    this.onRosterChanged = options.onRosterChanged ?? (() => {})
  }

  /** What the card should render now, including what the account can serve. */
  async status(): Promise<ChatGptStatusView> {
    const status = this.auth.status()
    const pending = this.pending
    return {
      ...status,
      roster: await this.roster(),
      ...pending === undefined ? {} : {
        pending: { url: pending.authorizationUrl, redirectUri: pending.redirectUri },
      },
      ...this.lastError === undefined ? {} : { error: this.lastError },
    }
  }

  /**
   * The roster, or why it could not be read.
   *
   * A listing failure is reported as a fact about the account rather than thrown:
   * the card is about the account, and a count it cannot read is still something
   * the human needs to see. The listing is cached by the adapter, so asking often
   * costs nothing.
   *
   * @returns the count, or the failure in place of it.
   */
  private async roster(): Promise<{ count: number, error?: string }> {
    try {
      return { count: (await this.adapter.listModels()).length }
    } catch (error) {
      return { count: 0, error: error instanceof Error ? error.message : String(error) }
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
          // The account can serve models now, and a selector that is holding the
          // empty catalog from before this sign-in has no other way to learn it.
          this.onRosterChanged()
        },
        (error: unknown) => {
          this.lastError = error instanceof Error ? error.message : String(error)
          this.pending = undefined
        },
      )
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
    }
    return await this.status()
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
      return await this.status()
    }
    try {
      await attempt.submit(value)
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      return await this.status()
    }
    await this.settle()
    return await this.status()
  }

  /**
   * Abandon the open attempt.
   * @returns the state with no pending attempt.
   */
  async cancel(): Promise<ChatGptStatusView> {
    this.cancelPending()
    return await this.status()
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
    this.onRosterChanged()
    return {
      status: await this.status(),
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
