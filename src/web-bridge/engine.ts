/** Provider-side durability only: no host ACK, tool execution, or browser implementation. */
import { randomUUID } from 'node:crypto'
import {
  WebBridgeError, type ExecuteOptions, type PageTurn, type TurnAccess, type TurnInspection,
  type TurnState, type WebBinding, type WebBridgeEngine, type WebPageTransport,
  type WebRequest, type WebResponse,
} from './contracts.ts'
import { openJournal, type JournalFault, type JournalStore, type ProfileOwnership } from './journal.ts'
import type { WebImageStore } from './image-store.ts'
import {
  canonical, createResponse, requestHash, validateBinding, validateContinuation,
  validatePageResponse, validateRequest, validateResponse,
} from './protocol.ts'

interface StoredTurn extends TurnInspection {
  request: WebRequest
  ownerClientLeaseId: string
  promptId?: string
  failureCode?: string
  createdAt: number
  updatedAt: number
}

interface JournalData {
  version: 1
  binding: WebBinding
  turns: StoredTurn[]
}

interface Operation {
  owner: string
  abort: AbortController
  done: Promise<void>
}

export interface OpenWebBridgeOptions {
  directory: string
  profileDirectory: string
  binding: WebBinding
  transport: WebPageTransport
  initialize?: boolean
  instanceId?: string
  /** Explicit local fault-injection seam for durability tests; not a wire option. */
  journalFault?: JournalFault
  /** The daemon retains ownership until both the engine and its Chrome have stopped. */
  profileOwnership?: ProfileOwnership
  imageStore?: WebImageStore
}

/** In-process management capability; never offered through normal client leases. */
export interface WebBridgeAdministration {
  list(): Promise<TurnInspection[]>
  inspect(turnId: string): Promise<TurnInspection>
  recover(turnId: string): Promise<TurnInspection>
  discard(turnId: string): Promise<TurnInspection>
  activity(): { activeTurns: number, uncertainTurns: number }
}

export interface ManagedWebBridgeEngine extends WebBridgeEngine {
  readonly administration: WebBridgeAdministration
}

const STATES = new Set<TurnState>(['accepted', 'preparing', 'submit_intent', 'submitted',
  'observing', 'completed', 'uncertain', 'failed', 'cancelled'])
const MAY_HAVE_SUBMITTED = new Set<TurnState>(['submit_intent', 'submitted', 'observing', 'uncertain'])
const PRE_SEND = new Set<TurnState>(['accepted', 'preparing'])

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

function inspection(turn: StoredTurn, clientLeaseId?: string): TurnInspection {
  return structuredClone({
    turnId: turn.turnId, sessionId: turn.sessionId, state: turn.state,
    requestHash: turn.requestHash, generationId: turn.generationId,
    discarded: turn.discarded, deliveryState: turn.deliveryState,
    // Lease IDs are control capabilities. An admitted observer may inspect the
    // outcome, but must not learn another client's cancellation credential.
    ...clientLeaseId === undefined || turn.deliveryOwner?.clientLeaseId !== clientLeaseId ? {} : { deliveryOwner: turn.deliveryOwner },
    ...turn.fenceReason === undefined ? {} : { fenceReason: turn.fenceReason },
    ...turn.response === undefined ? {} : { response: turn.response },
  })
}

function turnIdFor(request: WebRequest): string {
  return `turn-${request.idempotencyKey.slice('sha256:'.length)}`
}

function failure(code: string, message: string, turn?: StoredTurn, cause?: unknown): WebBridgeError {
  const error = new WebBridgeError(code, message, 409, {
    ...cause === undefined ? {} : { cause }, ...turn === undefined ? {} : { requestId: turn.turnId },
  })
  // Keep the public Error shape compatible while making recovery identifiers
  // available to callers. The ID is also deterministically derived from the key.
  if (turn !== undefined) Object.assign(error, { turnId: turn.turnId })
  return error
}

function storedFailure(turn: StoredTurn): WebBridgeError {
  if (turn.discarded) return failure('WEB_DISCARDED', 'This request was discarded; its identity cannot be reset.', turn)
  if (MAY_HAVE_SUBMITTED.has(turn.state)) {
    return failure('WEB_UNCERTAIN', 'The browser outcome is unresolved. Inspect and reconcile this request before submitting more work.', turn)
  }
  if (turn.state === 'cancelled') return failure('WEB_CANCELLED', 'This request was cancelled; retry cannot replace it.', turn)
  return failure(turn.failureCode ?? 'WEB_FAILED', turn.fenceReason ?? 'This request is terminal and cannot be submitted again.', turn)
}

function validateJournal(value: unknown, binding: WebBinding): JournalData {
  if (!object(value) || value.version !== 1 || canonical(value.binding) !== canonical(binding) || !Array.isArray(value.turns)) {
    throw new Error('Invalid journal identity or shape')
  }
  const ids = new Set<string>()
  const keys = new Set<string>()
  const turns = value.turns.map((entry: unknown): StoredTurn => {
    if (!object(entry)) throw new Error('Invalid journal turn')
    const request = validateRequest(entry.request, binding)
    if (entry.turnId !== turnIdFor(request) || entry.sessionId !== request.sessionId
      || entry.requestHash !== requestHash(request) || typeof entry.generationId !== 'string' || entry.generationId.length === 0
      || typeof entry.state !== 'string' || !STATES.has(entry.state as TurnState)
      || typeof entry.discarded !== 'boolean' || entry.ownerClientLeaseId !== request.clientLeaseId
      || !Number.isSafeInteger(entry.createdAt) || !Number.isSafeInteger(entry.updatedAt)
      || (entry.createdAt as number) < 0 || (entry.updatedAt as number) < 0
      || entry.deliveryState !== 'unclaimed' && entry.deliveryState !== 'delivery-intent'
      || entry.promptId !== undefined && (typeof entry.promptId !== 'string' || entry.promptId.length === 0)
      || entry.failureCode !== undefined && typeof entry.failureCode !== 'string'
      || entry.fenceReason !== undefined && typeof entry.fenceReason !== 'string') throw new Error('Invalid journal turn fields')
    if (ids.has(entry.turnId) || keys.has(request.idempotencyKey)) throw new Error('Duplicate journal identity')
    ids.add(entry.turnId)
    keys.add(request.idempotencyKey)
    const response = entry.response === undefined ? undefined : validateResponse(entry.response, request)
    if ((entry.state === 'completed') !== (response !== undefined)
      || response !== undefined && (response.turnId !== entry.turnId || response.receipt.generationId !== entry.generationId)) {
      throw new Error('Journal response/state disagreement')
    }
    if (entry.deliveryState === 'delivery-intent') {
      if (!object(entry.deliveryOwner) || typeof entry.deliveryOwner.clientLeaseId !== 'string'
        || entry.deliveryOwner.clientLeaseId.length === 0 || typeof entry.deliveryOwner.deliveryAttemptId !== 'string'
        || entry.deliveryOwner.deliveryAttemptId.length === 0 || response?.finishReason !== 'tool-calls') {
        throw new Error('Invalid tool delivery claim')
      }
    } else if (entry.deliveryOwner !== undefined) throw new Error('Delivery owner without an intent')
    return { ...entry, request, ...response === undefined ? {} : { response } } as unknown as StoredTurn
  })
  // Parent receipts require local evidence, even after process restart. A
  // copied receipt cannot bootstrap a new journal or adopt a forked session.
  for (const turn of turns) {
    if (turn.request.parentReceipt === null) continue
    const parent = turns.find(candidate => candidate.turnId === turn.request.parentReceipt?.turnId)
    if (!parent?.response || parent.turnId === turn.turnId) throw new Error('Missing parent evidence')
    validateContinuation(turn.request, parent.request, parent.response)
  }
  return { version: 1, binding, turns }
}

class DurableWebBridge implements ManagedWebBridgeEngine {
  readonly binding: WebBinding
  readonly instanceId: string
  private readonly store: JournalStore<JournalData>
  private readonly transport: WebPageTransport
  private readonly imageStore: WebImageStore | undefined
  private data: JournalData
  private transactions: Promise<void> = Promise.resolve()
  private profileQueue: Promise<void> = Promise.resolve()
  private readonly operations = new Map<string, Operation>()
  private readonly participants = new Map<string, Set<string>>()
  private readonly releasedClients = new Set<string>()
  private readonly recoveries = new Set<Promise<void>>()
  private readonly pendingDiscards = new Set<string>()
  private readonly discardOperations = new Map<string, Promise<void>>()
  private closing = false
  private closePromise: Promise<void> | undefined
  private journalFailure: unknown
  readonly administration: WebBridgeAdministration = {
    list: () => this.transaction(() => {
      this.assertOpen()
      return this.data.turns.map(turn => {
        const result = inspection(turn)
        delete result.response
        return result
      })
    }),
    inspect: turnId => this.transaction(() => { this.assertOpen(); return inspection(this.turn(turnId)) }),
    recover: turnId => this.recoverFor(turnId),
    discard: turnId => this.discardFor(turnId),
    activity: () => ({ activeTurns: this.operations.size + this.recoveries.size,
      uncertainTurns: this.data.turns.filter(turn => turn.state === 'uncertain').length }),
  }

  constructor(store: JournalStore<JournalData>, options: OpenWebBridgeOptions, instanceId: string) {
    this.store = store
    this.transport = options.transport
    this.imageStore = options.imageStore
    this.instanceId = instanceId
    this.binding = freeze(structuredClone(store.value.binding))
    this.data = store.value
    for (const turn of this.data.turns) this.participants.set(turn.turnId, new Set([turn.ownerClientLeaseId]))
  }

  /** Every in-memory state transition is published only after durable commit. */
  private async commit(next: JournalData): Promise<void> {
    try {
      await this.store.write(next)
      this.data = next
    } catch (error) {
      this.journalFailure = error
      for (const operation of this.operations.values()) operation.abort.abort(error)
      throw error
    }
  }

  private transaction<T>(body: () => T | Promise<T>): Promise<T> {
    const result = this.transactions.then(body)
    this.transactions = result.then(() => undefined, () => undefined)
    return result
  }

  private assertOpen(): void {
    if (this.closing) throw failure('WEB_CLOSED', 'The bridge is closing; no new work is admitted.')
    if (this.journalFailure !== undefined) throw failure('WEB_JOURNAL_UNAVAILABLE', 'The journal has an unresolved durability failure.', undefined, this.journalFailure)
  }

  private assertClient(clientLeaseId: string): void {
    if (this.releasedClients.has(clientLeaseId)) throw failure('WEB_LEASE_EXPIRED', 'This client lease has been released.')
  }

  private turn(turnId: string): StoredTurn {
    const turn = this.data.turns.find(item => item.turnId === turnId)
    if (turn === undefined) throw failure('WEB_NOT_FOUND', 'No journal record exists for this turn.')
    return turn
  }

  private access(turnId: string, access: TurnAccess): StoredTurn {
    this.assertClient(access.clientLeaseId)
    const turn = this.turn(turnId)
    if (turn.sessionId !== access.sessionId || !this.participants.get(turnId)?.has(access.clientLeaseId)) {
      throw failure('WEB_FORBIDDEN', 'This lease has not admitted the exact request for this session.', turn)
    }
    return turn
  }

  private async update(turnId: string, change: (turn: StoredTurn) => void): Promise<StoredTurn> {
    const next = structuredClone(this.data)
    const turn = next.turns.find(item => item.turnId === turnId)
    if (turn === undefined) throw failure('WEB_NOT_FOUND', 'No journal record exists for this turn.')
    change(turn)
    turn.updatedAt = Date.now()
    await this.commit(next)
    return turn
  }

  private checkParent(request: WebRequest): string | undefined {
    if (request.parentReceipt === null) return undefined
    const parent = this.data.turns.find(turn => turn.turnId === request.parentReceipt?.turnId)
    if (!parent?.response || parent.discarded) throw failure('WEB_INVALID_CONTINUATION', 'The parent receipt has no admissible local journal evidence.')
    const append = validateContinuation(request, parent.request, parent.response)
    // A second child of an older receipt must not inherit the first child's
    // hidden website context. Admission reserves the tip even before Send.
    const tip = this.data.turns.findLast(turn => turn.generationId === parent.generationId)
    return append && tip?.turnId === parent.turnId ? parent.generationId : undefined
  }

  private fence(): StoredTurn | undefined {
    return this.data.turns.find(turn => turn.state === 'uncertain'
      || MAY_HAVE_SUBMITTED.has(turn.state) && !this.operations.has(turn.turnId))
  }

  private assertDiscardedEvidence(): void {
    const turnId = this.pendingDiscards.values().next().value
    if (turnId !== undefined) throw failure('WEB_DISCARD_PENDING', 'A durable discard still needs its local browser evidence reconciled. Repeat discard or reopen before more submissions.', this.turn(turnId))
  }

  private async reconcileDiscard(turnId: string): Promise<void> {
    if (this.transport.discard === undefined) return
    try {
      const page = await this.page(this.turn(turnId))
      await this.transport.discard(page)
      this.pendingDiscards.delete(turnId)
    } catch (error) {
      throw failure('WEB_DISCARD_PENDING', 'The durable discard is saved, but its local browser evidence needs reconciliation. Repeat discard or reopen.', this.turn(turnId), error)
    }
  }

  private async page(turn: StoredTurn): Promise<PageTurn> {
    const request = this.imageStore === undefined ? turn.request : await this.imageStore.hydrate(turn.request)
    if (requestHash(request) !== turn.requestHash) throw failure('WEB_ATTACHMENT_EVIDENCE', 'Hydrated image evidence changed the admitted request identity.', turn)
    return freeze(structuredClone({ request, turnId: turn.turnId, generationId: turn.generationId }))
  }

  async restore(): Promise<void> {
    for (const turn of this.data.turns) {
      if (turn.request.attachmentVersions.length === 0) continue
      if (this.imageStore === undefined) throw failure('WEB_ATTACHMENT_STORE_MISSING', 'This journal requires its private image evidence store.', turn)
      await this.imageStore.verify(turn.request)
    }
    const next = structuredClone(this.data)
    let changed = false
    for (const turn of next.turns) {
      if (PRE_SEND.has(turn.state)) {
        turn.state = 'failed'
        turn.failureCode = 'WEB_INTERRUPTED_BEFORE_SUBMIT'
        turn.fenceReason = 'The previous bridge stopped before establishing a submission intent; this identity is not resumed automatically.'
        changed = true
      } else if (MAY_HAVE_SUBMITTED.has(turn.state) && turn.state !== 'uncertain') {
        turn.state = 'uncertain'
        turn.failureCode = 'WEB_UNCERTAIN'
        turn.fenceReason = 'The bridge restarted after submission intent; reconcile the exact browser outcome.'
        changed = true
      }
    }
    if (changed) await this.commit(next)
    // The engine tombstone is committed before the transport's local one. A
    // crash between those writes is repaired without creating a remote action.
    if (this.transport.discard !== undefined) {
      for (const turn of this.data.turns) if (turn.discarded) this.pendingDiscards.add(turn.turnId)
      for (const turnId of this.pendingDiscards) await this.reconcileDiscard(turnId)
    }
  }

  async execute(value: WebRequest, options: ExecuteOptions = {}): Promise<WebResponse> {
    const request = validateRequest(value, this.binding)
    const admitted = await this.transaction(async () => {
      this.assertOpen()
      this.assertClient(request.clientLeaseId)
      if (request.attachmentVersions.length > 0 && this.imageStore === undefined) throw failure('WEB_ATTACHMENT_STORE_MISSING', 'Images require a durable private evidence store before admission.')
      const parentGeneration = this.checkParent(request)
      const existing = this.data.turns.find(turn => turn.requestHash === request.idempotencyKey)
      if (existing !== undefined) {
        if (requestHash(existing.request) !== requestHash(request)) throw failure('WEB_IDEMPOTENCY_CONFLICT', 'This key belongs to a different request.', existing)
        if (this.imageStore !== undefined) await this.imageStore.verify(existing.request)
        this.participants.get(existing.turnId)?.add(request.clientLeaseId)
        return { turnId: existing.turnId, operation: this.operations.get(existing.turnId)?.done }
      }
      this.assertDiscardedEvidence()
      const fenced = this.fence()
      if (fenced !== undefined) throw failure('WEB_UNCERTAIN', 'This profile has an unresolved browser outcome; inspect its existing request.', fenced)
      const now = Date.now()
      const storedRequest = this.imageStore === undefined ? request : validateRequest(await this.imageStore.store(request), this.binding)
      const turn: StoredTurn = {
        turnId: turnIdFor(request), sessionId: request.sessionId, requestHash: request.idempotencyKey,
        generationId: parentGeneration ?? randomUUID(), request: storedRequest, ownerClientLeaseId: request.clientLeaseId,
        state: 'accepted', discarded: false, deliveryState: 'unclaimed', createdAt: now, updatedAt: now,
      }
      const next = structuredClone(this.data)
      next.turns.push(turn)
      await this.commit(next)
      this.participants.set(turn.turnId, new Set([request.clientLeaseId]))
      const abort = new AbortController()
      const done = this.profileQueue.then(() => this.run(turn.turnId, abort.signal))
      this.profileQueue = done.then(() => undefined, () => undefined)
      this.operations.set(turn.turnId, { owner: request.clientLeaseId, abort, done })
      const clear = () => { this.operations.delete(turn.turnId) }
      void done.then(clear, clear)
      return { turnId: turn.turnId, operation: done }
    })
    await admitted.operation
    return this.transaction(async () => {
      this.assertOpen()
      this.assertClient(request.clientLeaseId)
      const turn = this.turn(admitted.turnId)
      if (turn.state !== 'completed' || turn.discarded || turn.response === undefined) throw storedFailure(turn)
      options.authorizeDelivery?.()
      if (turn.response.finishReason === 'tool-calls') {
        if (turn.deliveryState !== 'unclaimed') {
          throw failure('WEB_DELIVERY_CLAIMED', 'This tool response may already have been delivered. Supply its exact continuation or inspect it; cached tool calls are not replayed.', turn)
        }
        await this.update(turn.turnId, current => {
          current.deliveryState = 'delivery-intent'
          current.deliveryOwner = { clientLeaseId: request.clientLeaseId, deliveryAttemptId: request.deliveryAttemptId }
        })
        // Expiry or disconnect during fsync consumes the conservative claim but
        // must not leak executable output to a now-unauthorized connection.
        this.assertOpen()
        this.assertClient(request.clientLeaseId)
        options.authorizeDelivery?.()
      }
      return structuredClone(turn.response)
    })
  }

  private async run(turnId: string, signal: AbortSignal): Promise<void> {
    let intent = false
    try {
      await this.transaction(async () => {
        this.assertOpen()
        const turn = this.turn(turnId)
        if (turn.discarded || turn.state !== 'accepted') throw storedFailure(turn)
        this.assertDiscardedEvidence()
        const fenced = this.fence()
        if (fenced !== undefined) throw failure('WEB_UNCERTAIN', 'This profile has an unresolved browser outcome; inspect its existing request.', fenced)
        signal.throwIfAborted()
        await this.update(turnId, current => { current.state = 'preparing' })
      })
      let page = await this.page(this.turn(turnId))
      signal.throwIfAborted()
      await this.transport.prepare(page, signal)
      signal.throwIfAborted()
      await this.transaction(async () => {
        this.assertOpen()
        signal.throwIfAborted()
        if (this.turn(turnId).discarded) throw storedFailure(this.turn(turnId))
        await this.update(turnId, current => { current.state = 'submit_intent' })
        intent = true
      })
      page = await this.page(this.turn(turnId))
      signal.throwIfAborted()
      const submitted = await this.transport.submit(page, signal)
      signal.throwIfAborted()
      if (typeof submitted?.promptId !== 'string' || submitted.promptId.length === 0) throw new Error('No positive prompt identity was observed')
      await this.transaction(async () => {
        this.assertOpen()
        signal.throwIfAborted()
        await this.update(turnId, current => { current.state = 'submitted'; current.promptId = submitted.promptId })
        await this.update(turnId, current => { current.state = 'observing' })
      })
      page = await this.page(this.turn(turnId))
      signal.throwIfAborted()
      const value = await this.transport.observe(page, submitted.promptId, signal)
      signal.throwIfAborted()
      const record = this.turn(turnId)
      const response = createResponse(record.request, turnId, record.generationId, validatePageResponse(value, record.request, turnId))
      await this.transaction(async () => {
        this.assertOpen()
        signal.throwIfAborted()
        await this.update(turnId, current => {
          current.state = 'completed'
          current.response = response
          delete current.failureCode
          delete current.fenceReason
        })
      })
    } catch (error) {
      if (this.journalFailure !== undefined) throw this.journalFailure
      await this.transaction(async () => {
        const turn = this.turn(turnId)
        if (turn.state === 'completed' || turn.state === 'cancelled' || turn.state === 'failed') return
        await this.update(turnId, current => {
          if (intent || MAY_HAVE_SUBMITTED.has(current.state)) {
            current.state = 'uncertain'
            current.failureCode = 'WEB_UNCERTAIN'
            current.fenceReason = 'Submission may have happened; inspect and reconcile the browser outcome.'
          } else if (signal.aborted || this.closing || current.discarded) {
            current.state = 'cancelled'
            current.failureCode = 'WEB_CANCELLED'
            current.fenceReason = 'Cancelled before any submission action.'
          } else {
            current.state = 'failed'
            current.failureCode = error instanceof WebBridgeError ? error.code : 'WEB_PREPARATION_FAILED'
            current.fenceReason = 'The request failed before submission; this identity is retained and will not be retried automatically.'
          }
        })
      })
      throw storedFailure(this.turn(turnId))
    }
  }

  async inspect(turnId: string, access: TurnAccess): Promise<TurnInspection> {
    return this.transaction(() => {
      this.assertOpen()
      return inspection(this.access(turnId, access), access.clientLeaseId)
    })
  }

  private async cancelOwned(turnId: string, clientLeaseId: string): Promise<void> {
    const turn = this.turn(turnId)
    if (turn.ownerClientLeaseId !== clientLeaseId) throw failure('WEB_FORBIDDEN', 'Only the admitting client can cancel this browser operation.', turn)
    this.operations.get(turnId)?.abort.abort(failure('WEB_CANCELLED', 'The owning client cancelled this request.', turn))
    if (!PRE_SEND.has(turn.state) && !MAY_HAVE_SUBMITTED.has(turn.state)) return
    await this.update(turnId, current => {
      if (PRE_SEND.has(current.state)) {
        current.state = 'cancelled'
        current.failureCode = 'WEB_CANCELLED'
        current.fenceReason = 'The owner cancelled before submission.'
      } else {
        current.state = 'uncertain'
        current.failureCode = 'WEB_UNCERTAIN'
        current.fenceReason = 'The owner cancelled after submission intent; stopping a connection is not proof of no submission.'
      }
    })
  }

  async cancel(turnId: string, access: TurnAccess): Promise<TurnInspection> {
    return this.transaction(async () => {
      this.assertOpen()
      this.access(turnId, access)
      await this.cancelOwned(turnId, access.clientLeaseId)
      return inspection(this.turn(turnId), access.clientLeaseId)
    })
  }

  async discard(turnId: string, access: TurnAccess): Promise<TurnInspection> {
    return this.discardFor(turnId, access)
  }

  private async discardFor(turnId: string, access?: TurnAccess): Promise<TurnInspection> {
    const admitted = await this.transaction(async () => {
      this.assertOpen()
      if (access !== undefined) this.access(turnId, access)
      const turn = await this.update(turnId, current => { current.discarded = true })
      if (this.transport.discard === undefined) return { done: undefined }
      this.pendingDiscards.add(turnId)
      const existing = this.discardOperations.get(turnId)
      if (existing !== undefined) return { done: existing }
      // Never mutate local page evidence concurrently with an uncooperative
      // in-flight submit. Tombstoning does not grant another lease cancellation.
      const done = this.profileQueue.then(() => this.reconcileDiscard(turn.turnId))
      this.profileQueue = done.then(() => undefined, () => undefined)
      this.discardOperations.set(turnId, done)
      this.recoveries.add(done)
      const clear = () => { this.discardOperations.delete(turnId); this.recoveries.delete(done) }
      void done.then(clear, clear)
      return { done }
    })
    await admitted.done
    return access === undefined ? this.administration.inspect(turnId) : this.inspect(turnId, access)
  }

  async recover(turnId: string, access: TurnAccess): Promise<TurnInspection> {
    return this.recoverFor(turnId, access)
  }

  private async recoverFor(turnId: string, access?: TurnAccess): Promise<TurnInspection> {
    const admitted = await this.transaction(() => {
      this.assertOpen()
      const turn = access === undefined ? this.turn(turnId) : this.access(turnId, access)
      if (this.operations.has(turnId)) throw failure('WEB_BUSY', 'The original transport must settle before recovery can establish a new outcome.', turn)
      if (turn.state !== 'uncertain') return { done: undefined }
      if (this.transport.recover === undefined) throw failure('WEB_RECOVERY_UNAVAILABLE', 'This transport has no read-only recovery implementation.', turn)
      const done = this.profileQueue.then(async () => {
        this.assertOpen()
        const current = this.turn(turnId)
        if (current.state !== 'uncertain') return
        const page = await this.page(current)
        this.assertOpen()
        const recovery = await this.transport.recover!(page)
        await this.transaction(async () => {
          this.assertOpen()
          if (recovery.kind === 'unknown') return
          if (recovery.kind === 'completed') {
            const record = this.turn(turnId)
            const blocks = validatePageResponse(recovery.response, record.request, turnId)
            const response = createResponse(record.request, turnId, record.generationId, blocks)
            await this.update(turnId, next => {
              next.state = 'completed'; next.response = response
              delete next.failureCode; delete next.fenceReason
            })
          } else if (recovery.kind === 'not-submitted' || recovery.kind === 'terminal-failure') {
            await this.update(turnId, next => {
              next.state = 'failed'
              next.failureCode = recovery.kind === 'not-submitted' ? 'WEB_NOT_SUBMITTED' : 'WEB_REMOTE_FAILED'
              next.fenceReason = recovery.kind === 'not-submitted'
                ? 'Read-only recovery proved no submission. The original request identity remains terminal.'
                : 'Read-only recovery proved a terminal remote failure.'
            })
          } else throw failure('WEB_INVALID_RECOVERY', 'The transport returned an unrecognized recovery outcome.', this.turn(turnId))
        })
      })
      this.profileQueue = done.then(() => undefined, () => undefined)
      this.recoveries.add(done)
      const clear = () => { this.recoveries.delete(done) }
      void done.then(clear, clear)
      return { done }
    })
    await admitted.done
    return access === undefined ? this.administration.inspect(turnId) : this.inspect(turnId, access)
  }

  async releaseClient(clientLeaseId: string): Promise<void> {
    this.releasedClients.add(clientLeaseId)
    // Abort immediately, even while a journal fsync is holding the transaction
    // queue. Never await the transport, and never touch another owner's work.
    for (const operation of this.operations.values()) {
      if (operation.owner === clientLeaseId) operation.abort.abort(failure('WEB_LEASE_EXPIRED', 'The owning client lease ended.'))
    }
    await this.transaction(async () => {
      if (this.closing || this.journalFailure !== undefined) return
      for (const turn of this.data.turns) {
        if (turn.ownerClientLeaseId === clientLeaseId && (PRE_SEND.has(turn.state) || MAY_HAVE_SUBMITTED.has(turn.state))) {
          await this.cancelOwned(turn.turnId, clientLeaseId)
        }
      }
    })
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closing = true
    for (const operation of this.operations.values()) operation.abort.abort(failure('WEB_CLOSED', 'The bridge is closing.'))
    this.closePromise = (async () => {
      await this.transaction(async () => {
        if (this.journalFailure !== undefined) return
        const next = structuredClone(this.data)
        let changed = false
        for (const turn of next.turns) {
          if (PRE_SEND.has(turn.state)) {
            turn.state = 'cancelled'; turn.failureCode = 'WEB_CANCELLED'
            turn.fenceReason = 'Bridge closed before submission.'; changed = true
          } else if (MAY_HAVE_SUBMITTED.has(turn.state) && turn.state !== 'uncertain') {
            turn.state = 'uncertain'; turn.failureCode = 'WEB_UNCERTAIN'
            turn.fenceReason = 'Bridge closed after submission intent; reconcile before more submissions.'; changed = true
          }
        }
        if (changed) await this.commit(next)
      }).catch(() => undefined)
      // An uncooperative submit may still mutate the page after abort. The
      // physical-profile lock stays held until that promise actually settles.
      await Promise.allSettled([...this.operations.values()].map(operation => operation.done))
      await Promise.allSettled([...this.recoveries])
      await this.profileQueue
      await this.transactions
      await this.store.close()
    })()
    return this.closePromise
  }
}

export async function openWebBridge(options: OpenWebBridgeOptions): Promise<ManagedWebBridgeEngine> {
  const binding = validateBinding(options.binding)
  const instanceId = options.instanceId ?? options.profileOwnership?.instanceId ?? randomUUID()
  const store = await openJournal({
    directory: options.directory, profileDirectory: options.profileDirectory, binding, instanceId,
    initialize: options.initialize === true, initial: { version: 1, binding, turns: [] } as JournalData,
    validate: value => validateJournal(value, binding),
    ...options.journalFault === undefined ? {} : { fault: options.journalFault },
    ...options.profileOwnership === undefined ? {} : { profileOwnership: options.profileOwnership },
  })
  const engine = new DurableWebBridge(store, options, instanceId)
  try {
    await engine.restore()
    return engine
  } catch (error) {
    await engine.close()
    throw error
  }
}
