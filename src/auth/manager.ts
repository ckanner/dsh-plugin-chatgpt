/**
 * The one place that owns this installation's ChatGPT credential state.
 *
 * Two concerns meet here and nowhere else: which account is active, and whether
 * its access token is still usable. Both are answered under a single in-flight
 * promise, because concurrent callers must never refresh the same grant twice —
 * a refresh rotates the refresh token, so a second refresh using the old one is
 * refused and would look like a dead credential rather than a race.
 *
 * The remote surface reads account *facts* from here (email, plan, expiry) and
 * never a token.
 *
 * @module dsh-plugin-chatgpt-subscription/auth/manager
 */

import { dirname, join } from 'node:path'
import { ensureHostId } from './host-id.ts'
import { beginSignIn, type SignInAttempt, type SignInOptions } from './sign-in.ts'
import { refreshCredential, RefreshRefusedError } from './refresh.ts'
import {
  emptyDocument, readDocument, removeDocument, writeDocument, type ChatGptStoreDocument,
} from './store.ts'
import { canSpendPlan, isFresh, type ChatGptCredential } from './credential.ts'

/** What the UI may know about this installation's ChatGPT access. */
export interface ChatGptStatus {
  /** Whether at least one account is authorized and can spend its plan. */
  signedIn: boolean
  /** Whether a grant exists but the plan-usage scope was not granted. */
  planUsageDenied: boolean
  /** The active account's email, when known. */
  email?: string
  /** The active account's ChatGPT plan name, when known. */
  plan?: string
  /** When the active access token stops being usable, epoch milliseconds. */
  expiresAt?: number
  /** Every authorized account's email, keyed by subject. */
  accounts: { subject: string, email?: string, active: boolean }[]
}

/** Options for {@link ChatGptAuth}. */
export interface ChatGptAuthOptions {
  /** The directory this installation's state lives in. */
  stateDir: string
  /** The app name the human sees on the consent screen. */
  agentNameHint: string
  /** Endpoint overrides (tests). */
  endpoints?: {
    authorizeUrl?: string
    tokenUrl?: string
    preferredPort?: number
  }
}

/**
 * Owns the stored grants, one active account, and the sign-in attempts in
 * flight.
 */
export class ChatGptAuth {
  private readonly file: string
  private readonly options: ChatGptAuthOptions
  private document: ChatGptStoreDocument | undefined
  private loaded = false
  private refreshing: Promise<ChatGptCredential> | undefined

  /**
   * @param options - where state lives and what to call this app.
   */
  constructor(options: ChatGptAuthOptions) {
    this.options = options
    this.file = join(options.stateDir, 'chatgpt-auth.json')
  }

  /** The absolute path of the credential file, for diagnostics. */
  get storePath(): string {
    return this.file
  }

  /** Load lazily so a plugin that is never used never touches the disk. */
  private load(): ChatGptStoreDocument {
    if (!this.loaded) {
      this.document = readDocument(this.file)
      this.loaded = true
    }
    return this.document ?? emptyDocument(this.hostId())
  }

  /** The persisted host id, minted on first use. */
  hostId(): string {
    return ensureHostId({ file: join(dirname(this.file), 'chatgpt-host-id') })
  }

  /** Persist a complete document. */
  private save(document: ChatGptStoreDocument): void {
    writeDocument(this.file, document)
    this.document = document
    this.loaded = true
  }

  /** The active grant, or `undefined` when nothing usable is stored. */
  active(): ChatGptCredential | undefined {
    const document = this.load()
    const subject = document.active
    if (subject === undefined) return undefined
    return document.accounts[subject]
  }

  /**
   * The active grant with a usable access token, refreshing first when needed.
   *
   * @param signal - cancellation for the refresh.
   * @returns the usable credential.
   * @throws {RefreshRefusedError} when the grant can no longer be refreshed.
   */
  async usable(signal?: AbortSignal): Promise<ChatGptCredential> {
    const current = this.active()
    if (current === undefined) {
      throw new Error('no ChatGPT account is signed in; run a sign-in first')
    }
    if (isFresh(current)) return current
    return this.rotate(current, signal)
  }

  /**
   * Mint a new access token from the stored grant, once, for concurrent callers.
   *
   * Rotation is single-use — the refresh token is replaced by the exchange — so
   * two callers refreshing at once would have the second present a token the
   * first already spent, and the endpoint reports that as a dead grant rather
   * than as a race.
   */
  private rotate(current: ChatGptCredential, signal?: AbortSignal): Promise<ChatGptCredential> {
    this.refreshing ??= this.runRefresh(current, signal).finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  /**
   * Exchange the stored grant for a new one, whatever the local expiry says.
   *
   * A token can be refused while it still looks valid: the endpoint answers
   * `token_expired` for a grant it has invalidated server-side, and a local clock
   * comparison cannot see that. Authorization can also change under a live
   * session — an account upgrade, a workspace switch — which retires tokens the
   * local expiry still considers good. This is the method a caller uses when the
   * endpoint has just told it the token is no good.
   *
   * @param signal - cancellation for the exchange.
   * @returns the rotated credential.
   */
  async renew(signal?: AbortSignal): Promise<ChatGptCredential> {
    const current = this.active()
    if (current === undefined) {
      throw new Error('no ChatGPT account is signed in; run a sign-in first')
    }
    await this.refreshing?.catch(() => undefined)
    return this.rotate(current, signal)
  }

  /** Refresh under the single-flight promise and persist the rotation. */
  private async runRefresh(current: ChatGptCredential, signal?: AbortSignal): Promise<ChatGptCredential> {
    const rotated = await refreshCredential(current, {
      ...this.options.endpoints?.tokenUrl === undefined ? {} : { tokenUrl: this.options.endpoints.tokenUrl },
      ...signal === undefined ? {} : { signal },
    })
    const document = this.load()
    const subject = current.subject ?? document.active
    if (subject === undefined) throw new Error('the stored ChatGPT credential has no account identity')
    this.save({ ...document, accounts: { ...document.accounts, [subject]: rotated }, active: subject })
    return rotated
  }

  /**
   * Begin a sign-in. A registration already stored for this installation is
   * reused, which is what keeps the issued client id stable across sign-ins.
   *
   * @returns the attempt, already listening for its callback.
   */
  async begin(): Promise<SignInAttempt> {
    const existing = this.active()
    const attemptOptions: SignInOptions = {
      agentHostId: this.hostId(),
      agentNameHint: this.options.agentNameHint,
      ...this.options.endpoints?.authorizeUrl === undefined ? {} : { authorizeUrl: this.options.endpoints.authorizeUrl },
      ...this.options.endpoints?.tokenUrl === undefined ? {} : { tokenUrl: this.options.endpoints.tokenUrl },
      ...this.options.endpoints?.preferredPort === undefined ? {} : { preferredPort: this.options.endpoints.preferredPort },
      // A previously issued client id skips registration entirely, which is the
      // documented path for a returning account on the same installation.
      ...existing === undefined ? {} : {
        registration: {
          clientId: existing.clientId,
          ...existing.subject === undefined ? {} : { loginHint: existing.email },
        },
      },
    }
    return beginSignIn(attemptOptions)
  }

  /**
   * Store a completed grant and make it the active account.
   *
   * @param credential - what the sign-in produced.
   * @returns the account subject the grant was filed under.
   */
  adopt(credential: ChatGptCredential): string {
    const document = this.load()
    const subject = credential.subject ?? credential.email ?? `account-${Object.keys(document.accounts).length + 1}`
    this.save({
      ...document,
      accounts: { ...document.accounts, [subject]: { ...credential, subject } },
      active: subject,
    })
    return subject
  }

  /** Make an already-authorized account active. */
  activate(subject: string): void {
    const document = this.load()
    if (document.accounts[subject] === undefined) {
      throw new Error(`no stored ChatGPT account is filed under ${subject}`)
    }
    this.save({ ...document, active: subject })
  }

  /** Forget one account, or every account when no subject is named. */
  signOut(subject?: string): void {
    const document = this.load()
    if (subject === undefined) {
      removeDocument(this.file)
      this.document = undefined
      this.loaded = false
      return
    }
    const accounts = { ...document.accounts }
    delete accounts[subject]
    const nextActive = document.active === subject
      ? Object.keys(accounts)[0]
      : document.active
    this.save({
      ...document,
      accounts,
      ...nextActive === undefined ? { active: undefined as unknown as string } : { active: nextActive },
    })
  }

  /** Account facts for the settings surface. */
  status(): ChatGptStatus {
    const document = this.load()
    const active = this.active()
    const entries = Object.entries(document.accounts)
    return {
      signedIn: active !== undefined && canSpendPlan(active),
      planUsageDenied: active !== undefined && !canSpendPlan(active),
      ...active?.email === undefined ? {} : { email: active.email },
      ...active?.planType === undefined ? {} : { plan: active.planType },
      ...active === undefined ? {} : { expiresAt: active.expiresAt },
      accounts: entries.map(([subject, credential]) => ({
        subject,
        ...credential.email === undefined ? {} : { email: credential.email },
        active: subject === document.active,
      })),
    }
  }
}

export { RefreshRefusedError }
