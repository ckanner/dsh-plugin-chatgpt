/**
 * Where one installation's ChatGPT grants live.
 *
 * This is credential state, not configuration, so it has its own rules: the
 * file is written atomically (a torn write would lose a working grant and force
 * a fresh browser sign-in), it is owner-only, and it never carries anything the
 * request path does not read. Tokens are stored as opaque strings and are never
 * logged, echoed into an error, or exposed over the plugin's remote surface —
 * the UI sees account facts, never a bearer token.
 *
 * Grants are keyed by the account subject rather than by installation, because
 * one installation can legitimately hold several ChatGPT accounts (work and
 * personal) and each has its own issued client id, its own refresh token, and
 * its own plan. Keying by subject is what lets an account be switched without
 * discarding the other.
 *
 * @module dsh-plugin-chatgpt-subscription/auth/store
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChatGptCredential } from './credential.ts'

/** The persisted document. */
export interface ChatGptStoreDocument {
  /** Format version, so a future change can migrate rather than guess. */
  version: 1
  /** The stable `urn:uuid:` host id this installation registers as. */
  hostId: string
  /** Grants by account subject. */
  accounts: Record<string, ChatGptCredential>
  /** The subject whose grant the request path uses; absent when no account is active. */
  active?: string
  /**
   * The issued client each account registered, kept after signing out.
   *
   * A client registration belongs to the account, not to the session: the
   * documentation is explicit that signing out retains the account/client mapping
   * and that signing back in with a saved account "does not create a new client".
   * Dropping this with the credential would make every sign-out followed by a
   * sign-in register again, and each registration is another app row in the
   * account's ChatGPT settings.
   */
  registrations?: Record<string, ChatGptRegistration>
}

/** What a sign-in registered, retained independently of the credential. */
export interface ChatGptRegistration {
  /** The issued `oaiapp_…` id this account registered. */
  clientId: string
  /** The account's email, used as `login_hint` on a later sign-in. */
  email?: string
  /** When this registration was last confirmed, for choosing the most recent. */
  at: number
}

/** An empty document for a fresh installation. */
export function emptyDocument(hostId: string): ChatGptStoreDocument {
  return { version: 1, hostId, accounts: {}, registrations: {} }
}

/** Read one document, tolerating absence and rejecting corruption loudly. */
export function readDocument(file: string): ChatGptStoreDocument | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`the ChatGPT credential file at ${file} is not valid JSON; delete it and sign in again`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`the ChatGPT credential file at ${file} does not hold an object; delete it and sign in again`)
  }
  const document = parsed as Partial<ChatGptStoreDocument>
  if (document.version !== 1 || typeof document.hostId !== 'string' || typeof document.accounts !== 'object' || document.accounts === null) {
    throw new Error(`the ChatGPT credential file at ${file} has an unrecognised shape; delete it and sign in again`)
  }
  return {
    version: 1,
    hostId: document.hostId,
    accounts: document.accounts,
    registrations: registrationsOf(document.registrations),
    ...typeof document.active === 'string' ? { active: document.active } : {},
  }
}

/**
 * Read the retained registrations, dropping anything not shaped like one.
 *
 * A registration is a convenience for the next sign-in rather than a credential,
 * so a damaged entry is discarded instead of refusing a document whose grants are
 * perfectly usable.
 *
 * @param value - whatever the file held under `registrations`.
 * @returns the entries worth keeping.
 */
function registrationsOf(value: unknown): Record<string, ChatGptRegistration> {
  if (typeof value !== 'object' || value === null) return {}
  const kept: Record<string, ChatGptRegistration> = {}
  for (const [subject, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue
    const candidate = entry as Partial<ChatGptRegistration>
    if (typeof candidate.clientId !== 'string' || candidate.clientId.length === 0) continue
    kept[subject] = {
      clientId: candidate.clientId,
      at: typeof candidate.at === 'number' ? candidate.at : 0,
      ...typeof candidate.email === 'string' ? { email: candidate.email } : {},
    }
  }
  return kept
}

/**
 * Write one document atomically and owner-only.
 *
 * The rename is what makes it atomic: a reader either sees the previous file or
 * the complete new one, never a half-written grant.
 *
 * @param file - the target path.
 * @param document - the complete document to store.
 */
export function writeDocument(file: string, document: ChatGptStoreDocument): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

