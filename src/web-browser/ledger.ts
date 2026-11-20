/** Browser mutation evidence. Every hosted action has a durable intent before UI input. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, realpath, rename, rm, rmdir, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { WebBridgeError, type PageTurn } from '../web-bridge/contracts.ts'

export interface BrowserIdentity {
  profileDirectory: string
  provider: string
  profileId: string
  accountBinding: string
}
export interface BrowserMessageEvidence { id: string, role: string, digest: string }
export interface BrowserGeneration {
  id: string
  sessionId: string
  purpose: string
  title: string
  projectUrl?: string
  conversationUrl?: string
  transcript: BrowserMessageEvidence[]
  lastTurnId?: string
  projectedMessageCount?: number
  projectedMessagesDigest?: string
  projectionSettingsDigest?: string
}
export interface BrowserTurnRecord {
  id: string
  requestHash: string
  generationId: string
  prompt: string
  promptDigest: string
  promptId?: string
  responseId?: string
  responseText?: string
  completed?: boolean
  discarded?: boolean
}
export interface BrowserMutation {
  id: string
  turnId: string
  kind: string
  beforeUrl: string
  state: 'intent' | 'observed'
  evidence?: Record<string, string>
}
interface LedgerData {
  version: 1
  identity: BrowserIdentity
  generations: BrowserGeneration[]
  turns: BrowserTurnRecord[]
  mutations: BrowserMutation[]
}
export type BrowserLedgerFault = (point: 'after-intent' | 'before-observed', action: Readonly<BrowserMutation>) => void | Promise<void>
export const BROWSER_LEDGER_FILE = 'browser-ledger.json'
const MARKER = '.dsh-web-browser-store.json'
const MAX_LEDGER_BYTES = 64 * 1024 * 1024

export function textDigest(text: string): string { return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}` }
function error(message: string): never { throw new WebBridgeError('WEB_BROWSER_LEDGER', message, 503) }
function missing(error: unknown): boolean { return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' }

async function read(path: string): Promise<unknown | undefined> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_LEDGER_BYTES
      || process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || typeof process.getuid === 'function' && stat.uid !== process.getuid())) error('Browser evidence path is not an owner-only bounded regular file')
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.size > MAX_LEDGER_BYTES || process.platform !== 'win32' && ((opened.mode & 0o077) !== 0
        || typeof process.getuid === 'function' && opened.uid !== process.getuid())) error('Opened browser evidence is not an owner-only bounded file')
      return JSON.parse(await handle.readFile('utf8')) as unknown
    } finally { await handle.close() }
  } catch (cause) { if (missing(cause)) return undefined; throw new WebBridgeError('WEB_BROWSER_LEDGER', 'Browser evidence is unreadable; explicit inspection is required', 503, { cause }) }
}
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() } }
async function write(path: string, value: unknown): Promise<void> {
  const data = JSON.stringify(value)
  if (Buffer.byteLength(data) > MAX_LEDGER_BYTES) error('Browser evidence store is full; it will not silently discard history')
  const temporary = join(dirname(path), `.browser-write-${randomUUID()}`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(data, 'utf8'); await handle.sync(); await handle.close()
    await rename(temporary, path); await syncDirectory(dirname(path))
  } finally { await handle.close().catch(() => undefined); await rm(temporary, { force: true }) }
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

export class BrowserLedger {
  private closed = false
  private failure: unknown
  private readonly directory: string
  private data: LedgerData
  private readonly lock: string
  private readonly owner: string
  private readonly fault: BrowserLedgerFault | undefined
  private constructor(directory: string, data: LedgerData, lock: string, owner: string, fault?: BrowserLedgerFault) {
    this.directory = directory; this.data = data; this.lock = lock; this.owner = owner; this.fault = fault
  }

  static async open(directory: string, identity: BrowserIdentity, initialize: boolean, fault?: BrowserLedgerFault): Promise<BrowserLedger> {
    const firstCreated = await mkdir(directory, { recursive: true, mode: 0o700 })
    const physicalDirectory = await realpath(directory)
    if (firstCreated !== undefined) {
      const stop = dirname(await realpath(firstCreated))
      let cursor = physicalDirectory
      for (;;) { await syncDirectory(cursor); if (cursor === stop) break; cursor = dirname(cursor) }
    }
    const directoryStat = await lstat(physicalDirectory)
    if (!directoryStat.isDirectory() || process.platform !== 'win32' && ((directoryStat.mode & 0o077) !== 0
      || typeof process.getuid === 'function' && directoryStat.uid !== process.getuid())) error('Browser evidence directory is not owner-only')
    const physicalProfile = await realpath(identity.profileDirectory)
    const bound = { ...identity, profileDirectory: physicalProfile }
    const path = join(physicalDirectory, BROWSER_LEDGER_FILE)
    const markerPath = join(physicalProfile, MARKER)
    const lock = join(physicalDirectory, '.browser-ledger-lock')
    try { await mkdir(lock, { mode: 0o700 }) } catch (cause) {
      throw new WebBridgeError('WEB_BROWSER_LOCKED', 'Browser ledger is already owned; stale ownership requires offline inspection', 409, { cause })
    }
    const owner = randomUUID()
    try {
      await write(join(lock, 'owner.json'), { owner })
      const marker = await read(markerPath)
      const raw = await read(path)
      let data: LedgerData
      if (raw === undefined) {
        if (!initialize || marker !== undefined) error('Browser ledger is missing; an existing installation cannot be reset implicitly')
        data = { version: 1, identity: bound, generations: [], turns: [], mutations: [] }
        // A persisted marker before the ledger makes an interrupted initialization fail closed.
        await write(markerPath, { version: 1, directory: physicalDirectory, identity: bound })
        await write(path, { version: 1, digest: textDigest(JSON.stringify(data)), data })
      } else {
        if (!object(marker) || marker.version !== 1 || marker.directory !== physicalDirectory || JSON.stringify(marker.identity) !== JSON.stringify(bound)) error('Browser profile/store binding differs from this installation')
        if (!object(raw) || raw.version !== 1 || !object(raw.data) || raw.digest !== textDigest(JSON.stringify(raw.data))) error('Browser ledger checksum or format is invalid')
        const value = raw.data
        if (value.version !== 1 || JSON.stringify(value.identity) !== JSON.stringify(bound)
          || !Array.isArray(value.generations) || !Array.isArray(value.turns) || !Array.isArray(value.mutations)) error('Browser ledger identity or collections are invalid')
        const generations = new Set<string>()
        for (const generation of value.generations) {
          if (!object(generation) || typeof generation.id !== 'string' || generations.has(generation.id)
            || typeof generation.sessionId !== 'string' || typeof generation.purpose !== 'string' || typeof generation.title !== 'string'
            || !Array.isArray(generation.transcript) || generation.transcript.some(item => !object(item) || typeof item.id !== 'string' || typeof item.role !== 'string' || typeof item.digest !== 'string')
            || generation.projectUrl !== undefined && typeof generation.projectUrl !== 'string'
            || generation.conversationUrl !== undefined && typeof generation.conversationUrl !== 'string'
            || generation.lastTurnId !== undefined && typeof generation.lastTurnId !== 'string'
            || generation.projectedMessageCount !== undefined && (!Number.isSafeInteger(generation.projectedMessageCount) || Number(generation.projectedMessageCount) < 0)
            || generation.projectedMessagesDigest !== undefined && typeof generation.projectedMessagesDigest !== 'string'
            || generation.projectionSettingsDigest !== undefined && typeof generation.projectionSettingsDigest !== 'string') error('Browser generation evidence is invalid')
          generations.add(generation.id)
        }
        const turns = new Set<string>()
        for (const turn of value.turns) {
          if (!object(turn) || typeof turn.id !== 'string' || turns.has(turn.id) || typeof turn.requestHash !== 'string'
            || typeof turn.generationId !== 'string' || !generations.has(turn.generationId) || typeof turn.prompt !== 'string'
            || turn.promptDigest !== textDigest(turn.prompt) || turn.promptId !== undefined && typeof turn.promptId !== 'string'
            || turn.responseId !== undefined && typeof turn.responseId !== 'string' || turn.responseText !== undefined && typeof turn.responseText !== 'string'
            || turn.completed !== undefined && typeof turn.completed !== 'boolean'
            || turn.discarded !== undefined && typeof turn.discarded !== 'boolean') error('Browser turn evidence is invalid')
          turns.add(turn.id)
        }
        const actions = new Set<string>()
        for (const action of value.mutations) {
          if (!object(action) || typeof action.id !== 'string' || actions.has(action.id) || typeof action.turnId !== 'string' || !turns.has(action.turnId)
            || typeof action.kind !== 'string' || typeof action.beforeUrl !== 'string' || !['intent', 'observed'].includes(String(action.state))
            || action.evidence !== undefined && (!object(action.evidence) || Object.values(action.evidence).some(item => typeof item !== 'string'))) error('Browser action evidence is invalid')
          actions.add(action.id)
        }
        data = value as unknown as LedgerData
      }
      return new BrowserLedger(physicalDirectory, data, lock, owner, fault)
    } catch (cause) {
      await rm(join(lock, 'owner.json'), { force: true })
      await rmdir(lock)
      throw cause
    }
  }

  private assertOpen(): void { if (this.closed || this.failure !== undefined) error('Browser evidence store is closed or has a failed write') }
  private async commit(change: (value: LedgerData) => void): Promise<void> {
    this.assertOpen()
    const next = structuredClone(this.data)
    change(next)
    try { await write(join(this.directory, BROWSER_LEDGER_FILE), { version: 1, digest: textDigest(JSON.stringify(next)), data: next }) }
    catch (cause) { this.failure = cause; throw cause }
    this.data = next
  }
  pending(): BrowserMutation | undefined {
    this.assertOpen()
    const value = this.data.mutations.find(item => item.state === 'intent' && !this.data.turns.find(turn => turn.id === item.turnId)?.discarded)
    return value === undefined ? undefined : structuredClone(value)
  }
  generation(id: string): BrowserGeneration | undefined { const value = this.data.generations.find(item => item.id === id); return value === undefined ? undefined : structuredClone(value) }
  turn(id: string): BrowserTurnRecord | undefined { const value = this.data.turns.find(item => item.id === id); return value === undefined ? undefined : structuredClone(value) }
  mutations(turnId: string): BrowserMutation[] { return structuredClone(this.data.mutations.filter(item => item.turnId === turnId)) }
  async admit(turn: PageTurn, prompt: string): Promise<void> {
    const existing = this.turn(turn.turnId)
    if (existing !== undefined) {
      if (existing.discarded) throw new WebBridgeError('WEB_BROWSER_DISCARDED', 'This browser request was explicitly discarded and cannot be resubmitted', 409)
      if (existing.requestHash !== turn.request.idempotencyKey || existing.generationId !== turn.generationId || existing.prompt !== prompt) error('Browser request identity changed')
      return
    }
    if (this.pending()) throw new WebBridgeError('WEB_BROWSER_UNCERTAIN', 'A previous browser action has no verified outcome; inspect it before further mutation', 409)
    await this.commit(next => {
      const generation = next.generations.find(item => item.id === turn.generationId)
      if (generation !== undefined && (generation.sessionId !== turn.request.sessionId || generation.purpose !== turn.request.purpose)) error('Browser generation belongs to another session or purpose')
      if (generation === undefined) next.generations.push({ id: turn.generationId, sessionId: turn.request.sessionId, purpose: turn.request.purpose,
        title: `DSH ${textDigest(turn.generationId).slice(7, 39)}`, transcript: [] })
      next.turns.push({ id: turn.turnId, requestHash: turn.request.idempotencyKey, generationId: turn.generationId, prompt, promptDigest: textDigest(prompt) })
    })
  }
  async updateGeneration(id: string, change: Partial<BrowserGeneration>): Promise<void> {
    await this.commit(next => { const item = next.generations.find(item => item.id === id); if (!item) error('Missing browser generation'); Object.assign(item, change) })
  }
  async updateTurn(id: string, change: Partial<BrowserTurnRecord>): Promise<void> {
    await this.commit(next => { const item = next.turns.find(item => item.id === id); if (!item) error('Missing browser turn'); Object.assign(item, change) })
  }
  async complete(turnId: string, turn: Partial<BrowserTurnRecord>, generationId: string, generation: Partial<BrowserGeneration>): Promise<void> {
    await this.commit(next => {
      const storedTurn = next.turns.find(item => item.id === turnId)
      const storedGeneration = next.generations.find(item => item.id === generationId)
      if (!storedTurn || !storedGeneration || storedTurn.generationId !== generationId) error('Missing completion evidence identity')
      Object.assign(storedTurn, turn); Object.assign(storedGeneration, generation)
    })
  }
  async discard(turn: PageTurn): Promise<void> {
    const existing = this.turn(turn.turnId)
    if (!existing) return
    if (existing.requestHash !== turn.request.idempotencyKey || existing.generationId !== turn.generationId) error('Discard does not identify the recorded browser request')
    await this.updateTurn(turn.turnId, { discarded: true })
  }
  async begin(turnId: string, kind: string, beforeUrl: string): Promise<BrowserMutation> {
    if (this.pending()) throw new WebBridgeError('WEB_BROWSER_UNCERTAIN', 'An unresolved browser action fences this profile', 409)
    const action: BrowserMutation = { id: randomUUID(), turnId, kind, beforeUrl, state: 'intent' }
    await this.commit(next => { next.mutations.push(action) })
    await this.fault?.('after-intent', structuredClone(action))
    return action
  }
  async observed(action: BrowserMutation, evidence: Record<string, string>): Promise<void> {
    await this.fault?.('before-observed', structuredClone(action))
    await this.commit(next => {
      const item = next.mutations.find(item => item.id === action.id)
      if (!item || item.state !== 'intent') error('Browser mutation has no outstanding intent')
      item.state = 'observed'; item.evidence = evidence
    })
  }
  async close(): Promise<void> {
    if (this.closed) return
    const value = await read(join(this.lock, 'owner.json'))
    if (!object(value) || value.owner !== this.owner) error('Browser ledger ownership changed; the lock will not be removed')
    await rm(join(this.lock, 'owner.json'))
    await rmdir(this.lock)
    await syncDirectory(dirname(this.lock))
    this.closed = true
  }
}
