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
import type { ChatGptStatusView } from './session.ts'
import type { ChatGptSession } from './session.ts'

export type { ChatGptPendingView, ChatGptStatusView } from './session.ts'

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
  status(): ChatGptStatusView {
    return this.session.status()
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
  cancel(): ChatGptStatusView {
    return this.session.cancel()
  }

  /**
   * Forget one account, or every account when none is named.
   * @param subject - the account to forget.
   * @returns the state after signing out.
   */
  @Remote
  signOut(subject?: string): ChatGptStatusView {
    return this.session.signOut(subject)
  }
}
