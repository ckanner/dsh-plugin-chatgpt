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
}

/** An empty document for a fresh installation. */
export function emptyDocument(hostId: string): ChatGptStoreDocument {
  return { version: 1, hostId, accounts: {} }
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
    ...typeof document.active === 'string' ? { active: document.active } : {},
  }
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

/** Remove the store entirely (sign-out of every account). */
export function removeDocument(file: string): void {
  rmSync(file, { force: true })
}
