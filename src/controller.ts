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
import type { ChatGptWebHost } from './web/host.ts'

export type { ChatGptPendingView, ChatGptSignOutOutcome, ChatGptStatusView } from './session.ts'

/** Remote owner of the ChatGPT sign-in and account surface. */
export class ChatGptController extends TypertRemoteService {
  private readonly session: ChatGptSession
  private readonly web: ChatGptWebHost | undefined

  /**
   * @param ctx - the plugin context.
   * @param session - the state machine this service carries.
   */
  constructor(ctx: unknown, session: ChatGptSession, web?: ChatGptWebHost) {
    super(ctx, 'chatgptController', { namespace: 'chatgpt' })
    this.session = session
    this.web = web
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

  @Remote
  async webStatus(): Promise<unknown> { return await this.web?.status() }

  @Remote
  async webConfigure(value: unknown): Promise<unknown> {
    if (!this.web) throw new Error('Web host is unavailable')
    return await this.web.configure(value)
  }

  @Remote
  async webConnect(): Promise<unknown> {
    if (!this.web) throw new Error('Web host is unavailable')
    return await this.web.connect()
  }

  @Remote
  async webRecover(requestId: string): Promise<unknown> {
    if (!this.web) throw new Error('Web host is unavailable')
    return await this.web.recover(requestId)
  }

  @Remote
  async webAdopt(requestId: string): Promise<unknown> {
    if (!this.web) throw new Error('Web host is unavailable')
    return await this.web.recover(requestId, true)
  }

  @Remote
  async webDiscard(requestId: string, responseDigest: string, confirmation: string): Promise<unknown> {
    if (!this.web) throw new Error('Web host is unavailable')
    return await this.web.retire(requestId, responseDigest, confirmation)
  }
}
