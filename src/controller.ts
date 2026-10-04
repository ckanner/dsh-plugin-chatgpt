/**
 * The browser's way into the sign-in flow.
 *
 * A sign-in cannot happen in the browser: it needs a listener on the machine the
 * account is being authorized for, and it ends with credentials that must never
 * reach a page. So the page asks the host to start an attempt and shows what the
 * host reports back — the authorization URL, the loopback address the browser
 * will return to, and, once it is done, the account's display facts.
 *
 * The token is the one thing this surface never carries. Everything here is
 * either an instruction for the human or a fact about the account.
 *
 * This file is only the transport. The state machine lives in
 * {@link ChatGptSession}, which is testable without a gateway.
 *
 * @module dsh-plugin-chatgpt/controller
 */

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ChatGptSession, ChatGptSignOutOutcome, ChatGptStatusView } from './session.ts'

export type { ChatGptPendingView, ChatGptSignOutOutcome, ChatGptStatusView } from './session.ts'

/** Remote owner of the ChatGPT sign-in and account surface. */
export class ChatGptController extends TypertRemoteService {
  private readonly session: ChatGptSession

  /**
   * @param ctx - the plugin context.
   * @param session - the state machine this service carries.
   */
  constructor(ctx: unknown, session: ChatGptSession) {
    super(ctx, 'chatgptController', { namespace: 'chatgpt' })
    this.session = session
  }

  /**
   * Read the current account and attempt state.
   * @returns what the card should render.
   */
  @Remote
  async status(): Promise<ChatGptStatusView> {
    return await this.session.status()
  }

  /**
   * Open a sign-in attempt and answer with the URL to visit.
   * @returns the state, now carrying a pending attempt.
   */
  @Remote
  async begin(): Promise<ChatGptStatusView> {
    return await this.session.begin()
  }

  /**
   * Finish the open attempt from a pasted redirect URL or code.
   * @param value - the full redirect URL, or the code itself.
   * @returns the state after the exchange settles.
   */
  @Remote
  async submit(value: string): Promise<ChatGptStatusView> {
    return await this.session.submit(value)
  }

  /**
   * Abandon the open attempt.
   * @returns the state with no pending attempt.
   */
  @Remote
  async cancel(): Promise<ChatGptStatusView> {
    return await this.session.cancel()
  }

  /**
   * End one account's session, revoking it at the server before clearing it here.
   * @param subject - the account to end; defaults to the active one.
   * @returns the state, and whether the server confirmed the revocation.
   */
  @Remote
  async signOut(subject?: string): Promise<ChatGptSignOutOutcome> {
    return await this.session.signOut(subject)
  }
}
