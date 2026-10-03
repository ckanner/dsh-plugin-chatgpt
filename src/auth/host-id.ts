/**
 * This installation's stable agent-host identity.
 *
 * OpenAI's registration flow separates the *client* (what the human authorized,
 * identified by the issued `client_id`) from the *host* (where the app runs,
 * identified by `ext_agent_host_id`). One account's client can be reused across
 * several hosts — a laptop and a self-hosted VM — and each must present its own
 * host id, so the value has to be minted per installation and then never
 * change: an id that changed per launch would read as a new host every time.
 *
 * The documentation prefers a JWK thumbprint URI and explicitly supports a
 * UUID. This module uses the UUID: the harness already mints per-home UUIDs for
 * its own installation identity, so a plain UUID keeps this plugin's state
 * legible and inspectable rather than introducing key material for a value that
 * is not a credential.
 *
 * @module dsh-plugin-chatgpt-subscription/auth/host-id
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Options for {@link ensureHostId}. */
export interface EnsureHostIdOptions {
  /** Absolute path of the file holding the id. */
  file: string
  /** UUID generator (test seam). */
  randomUUID?: () => string
  /** Called when a value had to be minted because none was readable. */
  onMinted?: (id: string) => void
}

/** Read a valid persisted id, or `undefined` when absent or corrupt. */
function read(file: string): string | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const value = text.trim()
  return UUID_PATTERN.test(value) ? value.toLowerCase() : undefined
}

/**
 * Return the persisted host id, minting and storing one on first use.
 *
 * The id is rendered as `urn:uuid:<id>` because that is the accepted
 * `ext_agent_host_id` spelling; the file keeps the bare UUID so it stays
 * readable and hand-replaceable.
 *
 * Persistence is best-effort: a read-only home still yields a usable id for
 * this run, because a sign-in that would otherwise work must not be blocked by
 * the inability to remember it.
 *
 * @param options - where the id lives, and the generation seam.
 * @returns the `urn:uuid:` form to send as `ext_agent_host_id`.
 */
export function ensureHostId(options: EnsureHostIdOptions): string {
  let id = read(options.file)
  if (id === undefined) {
    const created = (options.randomUUID ?? randomUUID)()
    id = created.toLowerCase()
    options.onMinted?.(id)
    try {
      mkdirSync(dirname(options.file), { recursive: true })
      // `wx` settles a concurrent first launch: the loser adopts the winner.
      try {
        writeFileSync(options.file, `${id}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      } catch {
        id = read(options.file) ?? id
      }
    } catch {
      // Not writable: this run keeps the id it minted and the next launch mints
      // another. A sign-in still completes; it just does not read as the same
      // host later.
    }
  }
  return `urn:uuid:${id}`
}
