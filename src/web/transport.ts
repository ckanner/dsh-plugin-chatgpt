import { BrowserStore, checkDeadline, digest, processExited, wait } from './browser/storage.ts'
import { CdpWebPageFactory } from './browser/page.ts'
import { WebTransportError, initialWebFacts } from './browser/types.ts'
import type { WebActivity, WebConnection, WebFacts, WebJournal, WebPage, WebPageFactory, WebPageSample, WebTurnRequest, WebTurnResult } from './browser/types.ts'
import { join } from 'node:path'
import { assertAcceptedWebMedia, readWebMediaArtifact, validateWebMedia } from './media.ts'

export { WebTransportError } from './browser/types.ts'
export type { WebActivity, WebConversation, WebEvidence, WebFacts } from './browser/types.ts'
export type WebConnectionConfig = WebConnection
export type WebRunRequest = WebTurnRequest
export type WebRunResult = WebTurnResult

export interface TerminalState { key: string; stableSince: number; confirmations: number }
/** Repeated unchanged content cannot finish a turn without response-scoped terminal UI. */
export function advanceTerminal(state: TerminalState | undefined, sample: WebPageSample, now: number): { state: TerminalState; complete: boolean } {
  const key = digest(JSON.stringify([sample.userMessageId, sample.responseId, sample.text]))
  const stable = state?.key === key
  const eligible = Boolean(sample.userMessageId && sample.responseId && sample.text.length && sample.finishedActions && !sample.stopVisible && !sample.thinking && !sample.error)
  const next = { key, stableSince: stable ? state.stableSince : now, confirmations: eligible && stable ? state.confirmations + 1 : 0 }
  return { state: next, complete: eligible && next.confirmations >= 3 && now - next.stableSince >= 1200 }
}

function validateRequest(request: WebTurnRequest): void {
  for (const [name, value] of Object.entries({ requestId: request.requestId, executionDomainId: request.executionDomainId, sessionId: request.sessionId })) {
    if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f]/.test(value)) throw new Error(`Invalid Web ${name}`)
  }
  if (!/^[a-f0-9]{64}$/.test(request.bindingDigest)) throw new Error('A frozen call binding digest is required')
  if (!Number.isSafeInteger(request.generation) || request.generation < 0) throw new Error('Invalid Web generation')
  if (!['project-only','personalized'].includes(request.contextPolicy)) throw new Error('Unknown Web context policy')
  if (!Number.isSafeInteger(request.maxPromptBytes) || request.maxPromptBytes < 1 || request.maxPromptBytes > 4 * 1024 * 1024) throw new Error('Invalid Web prompt budget')
  if (!Number.isSafeInteger(request.maxResponseBytes) || request.maxResponseBytes < 1 || request.maxResponseBytes > 16 * 1024 * 1024) throw new Error('Invalid Web result budget')
  if (typeof request.prompt !== 'string' || !request.prompt.trim() || Buffer.byteLength(request.prompt) > request.maxPromptBytes) throw new Error('Web prompt exceeds the configured local input budget')
  if (typeof request.title !== 'string' || request.title.length > 256) throw new Error('Invalid Web conversation title')
  validateWebMedia(request.media)
  checkDeadline(request.deadlineMs, request.signal)
}

function serializedRequest(request: WebTurnRequest): WebJournal['request'] {
  const { signal: _signal, onActivity: _activity, ...serializable } = request
  return structuredClone(serializable)
}

function failure(error: unknown, facts: WebFacts, request: WebTurnRequest): WebTransportError {
  const timedOut = Date.now() >= request.deadlineMs
  facts.stopReason = request.signal?.aborted ? 'cancelled' : timedOut ? 'deadline' : 'error'
  if (error instanceof WebTransportError) return new WebTransportError(error.code, error.reason, facts, { cause: error })
  return new WebTransportError(timedOut ? 'TIMEOUT' : facts.dispatch === 'not-dispatched' ? 'INVALID_REQUEST' : 'TRANSPORT', error instanceof Error ? error.message : 'browser-call-failed', facts, { cause: error })
}

export interface WebRecovery {
  requestId: string
  facts: WebFacts
  result?: WebTurnResult
  hostCommitId?: string
  disposition?: WebJournal['disposition']
  /** Observed cloud state is separate; the original dispatch record is never rewritten. */
  observation?: WebPageSample
  rejection?: { reason: string; responseDigest: string; transportRequestId: string }
  retired?: { at: number; responseDigest: string; transportRequestId: string; reason: 'user-discarded-invalid-response' }
}

interface RecoveryOptions { observe?: boolean; deadlineMs?: number; signal?: AbortSignal; preparedRepair?: { parentRequestId: string; parentDigest: string } }

export class WebTransport {
  private readonly pages: WebPageFactory
  readonly connection: WebConnection
  constructor(connection: WebConnection, options: { pageFactory?: WebPageFactory } = {}) {
    if (!connection.id || !connection.browserPath || !connection.profilePath || !connection.stateDir || (connection.accountFingerprint !== '' && !/^[a-f0-9]{64}$/.test(connection.accountFingerprint))) throw new Error('A dedicated browser connection is required')
    this.pages = options.pageFactory ?? new CdpWebPageFactory()
    this.connection = connection
  }

  /** No browser, account lookup or prompt. Suitable for catalog and diagnostics. */
  status(): { configured: true; transport: 'chatgpt-web'; accountVerified: false; modelVerified: false } {
    return { configured: true, transport: 'chatgpt-web', accountVerified: false, modelVerified: false }
  }

  async connect(deadlineMs = Date.now() + 30_000): Promise<{ accountFingerprint?: string; targetId: string }> {
    return this.pages.connect(this.connection, deadlineMs)
  }

  async run(request: WebTurnRequest): Promise<WebTurnResult> {
    const facts = initialWebFacts()
    let store: BrowserStore | undefined
    let journal: WebJournal | undefined
    let lease: Awaited<ReturnType<BrowserStore['acquire']>> | undefined
    let page: WebPage | undefined
    let result: WebTurnResult | undefined
    let error: unknown
    let sequence = 0
    const activity = (kind: WebActivity['kind'], observedBytes?: number): void => {
      // A UI callback is observational and may not change dispatch or trigger replay.
      try { request.onActivity?.({ requestId: request.requestId, generation: request.generation, bindingDigest: request.bindingDigest, sequence: ++sequence, kind, at: Date.now(), ...(observedBytes === undefined ? {} : { observedBytes }) }) } catch { /* consumer isolation */ }
    }
    try {
      validateRequest(request)
      if (!/^[a-f0-9]{64}$/.test(this.connection.accountFingerprint)) throw new WebTransportError('AUTH', 'Explicitly bind the signed-in account before a model call', facts)
      for (const item of request.media ?? []) await readWebMediaArtifact(item, join(this.connection.stateDir, 'images'))
      store = await BrowserStore.open(this.connection)
      if (request.repairOf) {
        const parent = await store.get(request.repairOf.requestId)
        if (!parent || parent.disposition?.kind !== 'format-repair' || parent.disposition.nextRequestId !== request.requestId || parent.disposition.responseDigest !== request.repairOf.responseDigest || parent.hostCommitId || parent.facts.outcome !== 'captured' || parent.facts.remoteGeneration !== 'completed' || parent.facts.localCleanup !== 'confirmed' || parent.request.executionDomainId !== request.executionDomainId || parent.request.sessionId !== request.sessionId || parent.request.bindingDigest !== request.bindingDigest || parent.request.generation !== request.generation || request.deadlineMs > parent.request.deadlineMs || request.conversation?.id !== parent.conversation?.id || request.conversation?.url !== parent.conversation?.url) throw new Error('Format repair does not match its terminal parent and original budget')
        await store.readArtifact(parent.artifact!, parent.request.maxResponseBytes)
      }
      const existing = await store.get(request.requestId)
      if (existing) throw new WebTransportError('INVALID_REQUEST', 'request-already-journaled-use-recovery', { ...existing.facts, replayAllowed: false })
      const preparedJournal: WebJournal = { version: 1, ownerPid: process.pid, request: serializedRequest(request), connectionId: this.connection.id, accountFingerprint: this.connection.accountFingerprint, phase: 'prepared', updatedAt: Date.now(), facts }
      if (!await store.create(preparedJournal)) {
        const concurrent = await store.get(request.requestId)
        throw new WebTransportError('INVALID_REQUEST', 'request-already-journaled-use-recovery', { ...(concurrent?.facts ?? facts), replayAllowed: false })
      }
      journal = preparedJournal
      if (request.conversation) await store.assertConversationAvailable(request.conversation.id, request.requestId)
      lease = await store.acquire(request)
      if (request.conversation) await store.assertConversationAvailable(request.conversation.id, request.requestId)
      checkDeadline(request.deadlineMs, request.signal)
      page = await this.pages.open(this.connection, request)
      checkDeadline(request.deadlineMs, request.signal)
      journal.targetId = page.targetId
      // A crash after a container mutation must be reconciled before creating another project.
      await store.put(journal)
      const prepared = await page.prepare(request, async () => {
        journal!.phase = 'container-intent'
        await store!.put(journal!)
      })
      if (prepared.evidence.model !== 'GPT-6' || prepared.evidence.effort !== 'Pro' || prepared.evidence.accountFingerprint !== this.connection.accountFingerprint || prepared.evidence.bindingDigest !== request.bindingDigest || prepared.evidence.contextPolicy !== request.contextPolicy) throw new Error('Browser identity evidence does not match the frozen call')
      journal.conversation = prepared.conversation; journal.evidence = prepared.evidence
      await store.assertConversationAvailable(prepared.conversation.id, request.requestId)
      checkDeadline(request.deadlineMs, request.signal)
      journal.phase = 'submit-intent'
      facts.dispatch = 'unknown'; facts.replayAllowed = false; facts.remoteGeneration = 'unknown'
      await store.put(journal)
      // No automatic retry is permitted after the fsynced intent, even when this throws.
      await page.submit(request.prompt)
      let terminal: TerminalState | undefined
      let lastActivity = ''
      for (;;) {
        checkDeadline(request.deadlineMs, request.signal)
        const sample = await page.sample()
        if (sample.error) throw new WebTransportError(sample.error.code, sample.error.reason, facts)
        if (Buffer.byteLength(sample.text) > request.maxResponseBytes) throw new Error('Complete Web response exceeds the local artifact limit')
        if (sample.userMessageId) {
          if (sample.acceptedPrompt?.replace(/\r\n/g,'\n').trim() !== request.prompt.replace(/\r\n/g,'\n').trim()) throw new Error('Prompt acceptance does not match the submitted request')
          assertAcceptedWebMedia(request.media, sample.acceptedMedia)
          if (journal.userMessageId && journal.userMessageId !== sample.userMessageId) throw new Error('Accepted prompt identity changed')
          if (!journal.userMessageId) {
            journal.userMessageId = sample.userMessageId; journal.conversation = sample.conversation
            if (request.media?.length) journal.media = { version: 1, userMessageId: sample.userMessageId, attachments: structuredClone(request.media), acceptedUploadNames: [...sample.acceptedMedia!], modelConsumption: 'unverified' }
            if (journal.evidence) journal.evidence.conversationUrl = sample.conversation.url
            journal.phase = 'submitted'; facts.dispatch = 'confirmed'; facts.remoteGeneration = 'running'
            await store.holdConversation(sample.conversation.id, request.requestId)
            await store.put(journal); activity('accepted')
          }
        }
        if (journal.userMessageId && sample.userMessageId !== journal.userMessageId) throw new Error('Current prompt disappeared from the owned conversation')
        const observed = digest(JSON.stringify([sample.responseId, sample.text, sample.phase]))
        if (sample.userMessageId && observed !== lastActivity) {
          if (sample.text) activity('content', Buffer.byteLength(sample.text))
          else if (sample.phase) activity('phase')
          lastActivity = observed
        }
        const classified = advanceTerminal(terminal, sample, Date.now()); terminal = classified.state
        if (classified.complete && sample.responseId) {
          const artifact = await store.artifact(request.requestId, sample.text)
          journal.phase = 'captured'; journal.responseId = sample.responseId; journal.artifact = artifact; journal.conversation = sample.conversation
          facts.outcome = 'captured'; facts.remoteGeneration = 'completed'; facts.replayAllowed = false
          await store.put(journal)
          activity('completed', artifact.bytes)
          let named=sample.conversation
          try { named=await page.finalize?.(sample.conversation)??sample.conversation } catch { /* A title failure cannot erase a fully captured response. */ }
          journal.conversation=named
          await store.put(journal)
          result = { requestId: request.requestId, text: sample.text, responseId: sample.responseId, conversation: named, artifact, facts: { ...facts }, evidence: { ...prepared.evidence, conversationUrl: sample.conversation.url }, ...(journal.media ? { media: journal.media } : {}) }
          break
        }
        await wait(400, request.deadlineMs, request.signal)
      }
    } catch (caught) {
      error = caught
      if (journal && journal.phase === 'container-intent') facts.replayAllowed = false
      if (page && journal?.userMessageId && facts.remoteGeneration !== 'completed') {
        // Cleanup has a separate finite budget, but a UI click alone does not prove cloud stop.
        try { if (await page.stop(journal.userMessageId)) facts.remoteGeneration = 'stopped' } catch { /* retain remote unknown */ }
      }
      if (facts.dispatch !== 'not-dispatched' && facts.remoteGeneration !== 'completed' && facts.remoteGeneration !== 'stopped') facts.remoteGeneration = 'unknown'
    } finally {
      if (page) {
        try { await page.close(); facts.localCleanup = 'confirmed' } catch { facts.localCleanup = 'unknown' }
      } else facts.localCleanup = 'confirmed'
      if (journal && store) {
        if (error) { const wrapped = failure(error, facts, request); if (wrapped.facts.stopReason) facts.stopReason = wrapped.facts.stopReason; error = wrapped }
        try { await store.put(journal) } catch (caught) { error ??= caught }
      }
      if (lease) {
        if (facts.outcome === 'captured') lease.retain(!error && facts.localCleanup === 'confirmed' ? 'awaiting-ack' : 'unresolved')
        else if (facts.remoteGeneration === 'unknown' || facts.remoteGeneration === 'running' || (journal?.phase === 'container-intent' && error)) lease.retain()
        try { await lease.release() } catch (caught) { error ??= caught; facts.localCleanup = 'unknown' }
      }
    }
    if (error) {
      // Existing journals are authoritative; a second invocation must not erase their facts.
      if (!journal && error instanceof WebTransportError) throw error
      throw failure(error, facts, request)
    }
    if (!result) throw new WebTransportError('EMPTY_RESPONSE', 'no-complete-response', facts)
    return { ...result, facts: { ...facts } }
  }

  async recover(requestId: string, options: RecoveryOptions = {}): Promise<WebRecovery> {
    const store = await BrowserStore.open(this.connection)
    return await store.withAcknowledgement(requestId, () => this.recoverJournal(store, requestId, options))
  }

  private async recoverJournal(store: BrowserStore, requestId: string, options: RecoveryOptions): Promise<WebRecovery> {
    const journal = await store.get(requestId)
    if (!journal && options.preparedRepair) {
      const parent = await store.get(options.preparedRepair.parentRequestId)
      if (parent?.disposition?.kind !== 'format-repair' || parent.disposition.nextRequestId !== requestId || parent.disposition.responseDigest !== options.preparedRepair.parentDigest) throw new Error('Missing repair journal has no verified prepared parent')
      // The coordinator holds its conversation transaction while checking this:
      // transport always publishes a journal before any browser operation.
      return { requestId, facts: { ...initialWebFacts(), localCleanup: 'confirmed' } }
    }
    if (!journal || journal.accountFingerprint !== this.connection.accountFingerprint) throw new Error('Recovery journal does not belong to this account')
    validateWebMedia(journal.request.media)
    if (journal.facts.localCleanup !== 'confirmed' && processExited(journal.ownerPid)) {
      // A crashed request's socket/listeners cease with its OS process. The
      // dedicated Chrome remains shared and is not a request-owned descendant.
      // This proves local cleanup only; it says nothing about cloud generation.
      journal.facts.localCleanup = 'confirmed'
      await store.put(journal)
    }
    const recovery: WebRecovery = { requestId, facts: { ...journal.facts }, ...(journal.hostCommitId ? { hostCommitId: journal.hostCommitId } : {}), ...(journal.disposition ? { disposition: journal.disposition } : {}) }
    if (journal.disposition) {
      // Complete a crashed disposition transaction without acknowledging an
      // answer or touching a successor's lease. Its original facts stay intact.
      if (journal.conversation) await store.releaseConversation(journal.conversation.id, requestId, true)
      await store.releaseResolvedTurn(requestId)
    }
    if (journal.artifact && journal.responseId && journal.conversation && journal.evidence) {
      const text = await store.readArtifact(journal.artifact, journal.request.maxResponseBytes)
      if (journal.request.media?.length) {
        if (!journal.media || journal.media.version !== 1 || journal.media.modelConsumption !== 'unverified' || journal.media.userMessageId !== journal.userMessageId || JSON.stringify(journal.media.attachments) !== JSON.stringify(journal.request.media)) throw new Error('Recovered media acceptance does not match the original request')
        assertAcceptedWebMedia(journal.request.media, journal.media.acceptedUploadNames)
      }
      recovery.result = { requestId, text, responseId: journal.responseId, conversation: journal.conversation, artifact: journal.artifact, evidence: journal.evidence, facts: { ...journal.facts }, ...(journal.media ? { media: journal.media } : {}) }
    }
    // A verified local artifact remains adoptable even when the browser was
    // closed or the account is temporarily offline. Do not require new remote
    // observation to re-prove an already durable complete response.
    if (!options.observe || recovery.result) return recovery
    if (journal.facts.localCleanup !== 'confirmed') throw new Error('The original browser request has no confirmed local cleanup; concurrent recovery is not allowed')
    if (journal.phase === 'prepared' && journal.facts.dispatch === 'not-dispatched' && journal.facts.remoteGeneration === 'not-started' && journal.facts.replayAllowed) {
      // The fsynced prepared phase precedes every container mutation and send
      // intent. A dead owner's unused capacity can be released without replay.
      await store.releaseResolvedTurn(requestId)
      return recovery
    }
    if (!journal.targetId || !journal.conversation) throw new Error('Original owned tab/conversation evidence is incomplete; manual recovery is required')
    const request: WebTurnRequest = { ...journal.request, conversation: journal.conversation, deadlineMs: options.deadlineMs ?? Date.now() + 10_000, ...(options.signal ? { signal: options.signal } : {}) }
    const page = await this.pages.open(this.connection, request, journal.targetId)
    try {
      await page.inspect(request)
      let terminal: TerminalState | undefined
      for (;;) {
        checkDeadline(request.deadlineMs, request.signal)
        const sample = await page.sample()
        // Copy controls can remain on a partial answer after the website reports
        // a failed generation. Recovery must apply the same error gate as run().
        if (sample.error) throw new WebTransportError(sample.error.code, sample.error.reason, journal.facts)
        if (journal.userMessageId && sample.userMessageId !== journal.userMessageId) throw new Error('Recovery prompt identity does not match the original invocation')
        if (journal.responseId && sample.responseId !== journal.responseId) throw new Error('Recovery response identity changed')
        if (sample.acceptedPrompt?.replace(/\r\n/g,'\n').trim() !== journal.request.prompt.replace(/\r\n/g,'\n').trim()) throw new Error('Recovery prompt body does not match the original invocation')
        assertAcceptedWebMedia(journal.request.media, sample.acceptedMedia)
        if (Buffer.byteLength(sample.text) > journal.request.maxResponseBytes) throw new Error('Recovered result exceeds the bound artifact size')
        recovery.observation = sample
        const classified = advanceTerminal(terminal, sample, Date.now()); terminal = classified.state
        if (classified.complete && sample.responseId && sample.userMessageId) {
          if (journal.artifact && digest(sample.text) !== journal.artifact.sha256) throw new Error('The recovered response changed after capture')
          // Read-only refers to the remote conversation: no send, regenerate or new container.
          // Capturing its proven completed result is a local recovery transaction. Dispatch
          // facts remain exactly as journaled; unknown is not rewritten as confirmed.
          const artifact = await store.artifact(requestId, sample.text)
          journal.phase = 'captured'; journal.artifact = artifact; journal.responseId = sample.responseId
          journal.userMessageId = sample.userMessageId; journal.conversation = sample.conversation
          if (journal.request.media?.length) journal.media = { version: 1, userMessageId: sample.userMessageId, attachments: structuredClone(journal.request.media), acceptedUploadNames: [...sample.acceptedMedia!], modelConsumption: 'unverified' }
          if (journal.evidence) journal.evidence.conversationUrl = sample.conversation.url
          journal.facts.outcome = 'captured'; journal.facts.remoteGeneration = 'completed'
          journal.facts.replayAllowed = false
          await store.holdConversation(sample.conversation.id, requestId)
          await store.put(journal)
          recovery.facts = { ...journal.facts }
          if (!journal.evidence) throw new Error('Original model identity evidence is missing')
          recovery.result = { requestId, text: sample.text, responseId: sample.responseId, conversation: sample.conversation, artifact, evidence: journal.evidence, facts: { ...journal.facts }, ...(journal.media ? { media: journal.media } : {}) }
          return recovery
        }
        // A read-only status request does not wait indefinitely for a cloud model.
        if (sample.stopVisible || sample.thinking || !sample.finishedActions) return recovery
        await wait(400, request.deadlineMs, request.signal)
      }
    } finally { await page.close() }
  }

  async acknowledge(requestId: string, commit: { hostCommitId: string; responseDigest: string }): Promise<void> {
    if (!commit.hostCommitId?.trim() || commit.hostCommitId.length > 512 || !/^[a-f0-9]{64}$/.test(commit.responseDigest)) throw new Error('A durable host commit and response digest are required')
    const store = await BrowserStore.open(this.connection)
    await store.withAcknowledgement(requestId, async () => {
      const journal = await store.get(requestId)
      if (!journal || journal.disposition || journal.accountFingerprint !== this.connection.accountFingerprint || !journal.artifact || !journal.conversation || journal.facts.outcome !== 'captured' || journal.facts.remoteGeneration !== 'completed' || journal.facts.localCleanup !== 'confirmed' || journal.artifact.sha256 !== commit.responseDigest) throw new Error('Host ACK does not match a complete captured response with confirmed local cleanup')
      await store.readArtifact(journal.artifact, journal.request.maxResponseBytes)
      if (journal.hostCommitId && journal.hostCommitId !== commit.hostCommitId) throw new Error('Host ACK conflicts with the existing durable commit')
      journal.phase = 'acknowledged'; journal.hostCommitId = commit.hostCommitId
      await store.put(journal)
      await store.releaseConversation(journal.conversation.id, requestId)
      await store.releaseResolvedTurn(requestId)
    })
  }

  /** Transfers a rejected terminal turn's capacity to one named correction. */
  async releaseForRepair(requestId: string, input: { nextRequestId: string; responseDigest: string }): Promise<void> {
    if (!input.nextRequestId || input.nextRequestId === requestId || input.nextRequestId.length > 256) throw new Error('A distinct bounded repair identity is required')
    const store = await BrowserStore.open(this.connection)
    await store.withAcknowledgement(requestId, async () => {
      const journal = await store.get(requestId)
      await this.assertDisposable(store, journal, input.responseDigest)
      if (journal!.disposition && (journal!.disposition.kind !== 'format-repair' || journal!.disposition.nextRequestId !== input.nextRequestId)) throw new Error('Response already has another terminal disposition')
      journal!.phase = 'format-repair'
      journal!.disposition = { kind: 'format-repair', ...input }
      await store.put(journal!)
      await store.releaseConversation(journal!.conversation!.id, requestId, true)
      await store.releaseResolvedTurn(requestId)
    })
  }

  /** Explicit failed disposition; it never fabricates an ACK or successful outcome. */
  async retire(requestId: string, input: { responseDigest: string; reason: 'user-discarded-invalid-response' }): Promise<{ at: number; responseDigest: string; reason: 'user-discarded-invalid-response' }> {
    if (input.reason !== 'user-discarded-invalid-response') throw new Error('Explicit rejected-response discard is required')
    const store = await BrowserStore.open(this.connection)
    return await store.withAcknowledgement(requestId, async () => {
      const journal = await store.get(requestId)
      await this.assertDisposable(store, journal, input.responseDigest)
      if (journal!.disposition?.kind === 'format-repair') {
        const next = await store.get(journal!.disposition.nextRequestId)
        // Only an unused prepared successor may be abandoned. Any dispatch or
        // unknown cleanup remains fenced, even if the parent was terminal.
        if (next && !(next.phase === 'prepared' && next.facts.dispatch === 'not-dispatched' && next.facts.replayAllowed && next.facts.remoteGeneration === 'not-started' && (next.facts.localCleanup === 'confirmed' || processExited(next.ownerPid)))) throw new Error('A dispatched or unresolved format repair cannot be discarded through its parent')
        if (next) { next.facts.localCleanup = 'confirmed'; await store.put(next); await store.releaseResolvedTurn(next.request.requestId) }
      }
      journal!.phase = 'retired'
      journal!.disposition = journal!.disposition?.kind === 'retired' ? journal!.disposition : { kind: 'retired', responseDigest: input.responseDigest, reason: input.reason, at: Date.now() }
      await store.put(journal!)
      await store.releaseConversation(journal!.conversation!.id, requestId, true)
      await store.releaseResolvedTurn(requestId)
      return { at: journal!.disposition.at, responseDigest: input.responseDigest, reason: input.reason }
    })
  }

  private async assertDisposable(store: BrowserStore, journal: WebJournal | undefined, responseDigest: string): Promise<void> {
    if (!journal || journal.accountFingerprint !== this.connection.accountFingerprint || journal.hostCommitId || !journal.artifact || !journal.conversation || journal.facts.dispatch !== 'confirmed' || journal.facts.outcome !== 'captured' || journal.facts.remoteGeneration !== 'completed' || journal.facts.localCleanup !== 'confirmed' || journal.artifact.sha256 !== responseDigest) throw new Error('Disposition requires a confirmed dispatch, uncommitted complete response and confirmed local cleanup')
    await store.readArtifact(journal.artifact, journal.request.maxResponseBytes)
  }
}
