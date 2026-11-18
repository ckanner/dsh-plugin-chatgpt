import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { parseWebSettings, type WebSettings } from './config.ts'
import { canonical, digest, nonempty, objectValue, WEB_EFFORT, WEB_MODEL_ID, WEB_PROTOCOL, WebPolicyError } from './policy.ts'
import type { WebBudgetPolicy } from './policy.ts'
import { answerBlocks, WebToolProtocol, type WebToolSchema } from './protocol.ts'
import type { WebFacts, WebJournal, WebMediaAttachment } from './browser/types.ts'
import type { WebDelivery } from './session-coordinator.ts'
import { assertAcceptedWebMedia, readWebMediaArtifact, validateWebMedia } from './media.ts'

/** Private, invocation-bound evidence. This is not a browser connection API. */
export interface WebRecoveryIdentity { sessionId: string; executionDomainId: string; hostInvocationId: string }
export interface WebRecoveryCheckpoint {
  version: 1
  contract: 'chatgpt-web/read-only-recovery/1'
  stateDir: string
  provider: string
  identity: WebRecoveryIdentity
  ownerPid: number
  settings: WebSettings
  settingsDigest: string
  profileManaged: boolean
  invocationIdentity: string
  domainInvocations: string[]
}

interface SavedCall {
  requestId: string
  sessionId: string
  kind: 'main' | 'compaction' | 'session-title' | 'one-shot'
  connectionKey: string
  facts: WebFacts
  committed: boolean
  retired?: { at: number; responseDigest: string; transportRequestId: string; reason: 'user-discarded-invalid-response' }
}
interface SavedInvocation extends WebRecoveryIdentity {
  version: 1
  managedBy: string
  deadlineMs: number
  requireIsolation: boolean
  settingsDigest: string
  calls: SavedCall[]
  toolIntents: Record<string, { sessionId: string; rootCallId: string; completed: boolean; outcomeUnknown?: boolean }>
  fence?: string
  finished: boolean
  completed: boolean
}
interface Registry {
  version: 1
  sessions: Record<string, string>
  invocations: Record<string, SavedInvocation>
}
interface RepairAttempt { requestId: string; parentRequestId: string; parentDigest: string; phase: string; promptBytes: number }
type RecoveryJournal = WebJournal & { disposition?: { kind: string; responseDigest: string; nextRequestId?: string; reason?: string; at?: number } }

const CONTRACT = 'chatgpt-web/read-only-recovery/1' as const
const MAX_RECORD = 32 * 1024 * 1024
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const rawDigest = (value: string): string => createHash('sha256').update(value).digest('hex')
function fail(message: string): never { throw new WebPolicyError(`read-only recovery: ${message}`) }

/** Read helpers never create directories, locks, sessions, or browser clients. */
async function directory(path: string, privateMode = true): Promise<string> {
  if (!isAbsolute(path) || path.includes('\0')) fail('state path must be absolute')
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & (privateMode ? 0o077 : 0o022)) !== 0 || (process.getuid && stat.uid !== process.getuid())) fail('state directory is not private and owned')
  return await realpath(path)
}

class Snapshot {
  private readonly records = new Map<string, { bytes: number; sha256: string }>()
  async bytes(path: string, limit = MAX_RECORD): Promise<Buffer> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > limit || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) fail('record is not a private bounded regular file')
      const bytes = await file.readFile()
      if (bytes.byteLength !== stat.size || bytes.byteLength > limit) fail('record changed while reading')
      const fingerprint = { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }
      const previous = this.records.get(path)
      if (previous !== undefined && (previous.bytes !== fingerprint.bytes || previous.sha256 !== fingerprint.sha256)) fail('evidence changed during the read')
      this.records.set(path, fingerprint)
      return bytes
    } finally { await file.close() }
  }
  async text(path: string, limit = MAX_RECORD): Promise<string> { return (await this.bytes(path, limit)).toString('utf8') }
  async json<T>(root: string, namespace: string, key: string): Promise<T> {
    if (!/^[a-z-]+$/.test(namespace)) fail('invalid namespace')
    return JSON.parse(await this.text(join(root, `${namespace}-${digest(key)}.json`))) as T
  }
  async verify(): Promise<string> {
    const before = [...this.records]
    for (const [path] of before) await this.bytes(path)
    return digest(before)
  }
}

function identity(input: WebRecoveryIdentity): WebRecoveryIdentity {
  for (const key of ['sessionId', 'executionDomainId', 'hostInvocationId'] as const) nonempty(input[key], key, 200)
  return { sessionId: input.sessionId, executionDomainId: input.executionDomainId, hostInvocationId: input.hostInvocationId }
}

function invocation(registry: Registry, input: WebRecoveryIdentity): SavedInvocation {
  if (registry?.version !== 1 || !registry.sessions || !registry.invocations) fail('unsupported host registry')
  const record = registry.invocations[input.hostInvocationId]
  if (!record || record.version !== 1 || record.managedBy !== 'host' || record.sessionId !== input.sessionId || record.executionDomainId !== input.executionDomainId || record.hostInvocationId !== input.hostInvocationId || registry.sessions[input.sessionId] !== input.hostInvocationId) fail('host invocation is missing or has another owner')
  if (record.requireIsolation !== true || !hash(record.settingsDigest) || !Number.isSafeInteger(record.deadlineMs) || !Array.isArray(record.calls) || !record.toolIntents || typeof record.toolIntents !== 'object' || Array.isArray(record.toolIntents)) fail('host invocation has invalid policy or call evidence')
  return record
}

function invocationIdentity(record: SavedInvocation): string {
  return digest({ version: record.version, managedBy: record.managedBy, sessionId: record.sessionId, executionDomainId: record.executionDomainId, hostInvocationId: record.hostInvocationId, requireIsolation: record.requireIsolation, deadlineMs: record.deadlineMs, settingsDigest: record.settingsDigest })
}

function domainInvocations(registry: Registry, domain: string): string[] {
  return Object.values(registry.invocations).filter(record => record.executionDomainId === domain).map(record => record.hostInvocationId).sort()
}

/** Called by the public host after beginInvocation and before any prompt. */
export async function createWebRecoveryCheckpoint(
  source: { stateDir: string; route: string; settings: WebSettings; profileManaged: boolean },
  input: WebRecoveryIdentity,
): Promise<WebRecoveryCheckpoint> {
  const owner = identity(input), stateDir = await directory(resolve(source.stateDir), false)
  nonempty(source.route, 'provider', 512)
  const settings = parseWebSettings(source.settings)
  if (!settings.enabled || settings.contextPolicy !== 'project-only' || !settings.connections[settings.activeConnection]?.accountFingerprint) fail('original isolated connection was not admitted')
  const snapshot = new Snapshot()
  const registry = await snapshot.json<Registry>(await directory(join(stateDir, 'web-host')), 'registry', 'current')
  const record = invocation(registry, owner)
  if (record.settingsDigest !== digest(settings) || record.calls.length || Object.keys(record.toolIntents).length) fail('checkpoint must precede the original prompt and tools')
  await snapshot.verify()
  return { version: 1, contract: CONTRACT, stateDir, provider: source.route, identity: owner, ownerPid: process.pid,
    settings, settingsDigest: digest(settings), profileManaged: source.profileManaged, invocationIdentity: invocationIdentity(record),
    domainInvocations: domainInvocations(registry, owner.executionDomainId) }
}

function exited(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) return false
  try { process.kill(pid, 0); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
}

function facts(value: WebFacts): void {
  if (!value || !['not-dispatched', 'unknown', 'confirmed'].includes(value.dispatch) || !['unknown', 'captured'].includes(value.outcome) ||
      !['confirmed', 'unknown'].includes(value.localCleanup) || !['not-started', 'running', 'completed', 'stopped', 'unknown'].includes(value.remoteGeneration) ||
      value.usage !== 'unknown' || typeof value.replayAllowed !== 'boolean') fail('invalid browser facts')
}

async function capturedJournal(snapshot: Snapshot, browserRoot: string, requestId: string, connection: WebSettings['connections'][string], sessionId: string, domain: string, binding: string) {
  const journal = JSON.parse(await snapshot.text(join(await directory(join(browserRoot, 'calls')), `${rawDigest(requestId)}.json`))) as RecoveryJournal
  if (journal.version !== 1 || journal.request.requestId !== requestId || journal.request.executionDomainId !== domain || journal.request.sessionId !== sessionId ||
      journal.connectionId !== connection.id || journal.accountFingerprint !== connection.accountFingerprint || journal.request.bindingDigest !== binding ||
      !journal.artifact || !journal.responseId || journal.facts.dispatch !== 'confirmed' || journal.facts.outcome !== 'captured' || journal.facts.localCleanup !== 'confirmed' || journal.facts.remoteGeneration !== 'completed' ||
      journal.evidence?.model !== 'GPT-6' || journal.evidence.effort !== 'Pro' || journal.evidence.accountFingerprint !== connection.accountFingerprint || journal.evidence.contextPolicy !== 'project-only' || journal.evidence.bindingDigest !== binding) fail('terminal browser evidence is incomplete or mismatched')
  const artifactPath = join(await directory(join(browserRoot, 'artifacts')), `${rawDigest(requestId)}.txt`)
  if (journal.artifact.path !== artifactPath || !hash(journal.artifact.sha256)) fail('artifact path is outside its original request')
  const artifact = await snapshot.text(artifactPath, 16 * 1024 * 1024)
  if (journal.artifact.bytes !== Buffer.byteLength(artifact) || journal.artifact.sha256 !== rawDigest(artifact)) fail('response artifact changed')
  return { journal, artifact }
}

/**
 * Inspect only original private evidence after the original SDK owner exits.
 * A committed model response is NOT a completed Flywheel task. Consumers must
 * also require their own prompt/wait/terminal and candidate/role checkpoints.
 */
export async function readWebInvocationRecovery(input: WebRecoveryCheckpoint) {
  const raw = objectValue(input, 'Web recovery checkpoint')
  if (Object.keys(raw).some(key => !['version','contract','stateDir','provider','identity','ownerPid','settings','settingsDigest','profileManaged','invocationIdentity','domainInvocations'].includes(key)) ||
      input.version !== 1 || input.contract !== CONTRACT || typeof input.profileManaged !== 'boolean' || !hash(input.settingsDigest) || !hash(input.invocationIdentity) ||
      !Array.isArray(input.domainInvocations) || !input.domainInvocations.every(id => typeof id === 'string')) fail('unsupported checkpoint')
  const owner = identity(input.identity)
  nonempty(input.provider, 'provider', 512)
  if (!exited(input.ownerPid)) fail('original SDK owner is still live or its exit is unknown')
  const settings = parseWebSettings(input.settings)
  const connection = settings.connections[settings.activeConnection]!
  if (!settings.enabled || settings.contextPolicy !== 'project-only' || !connection.accountFingerprint || digest(settings) !== input.settingsDigest) fail('original settings changed')
  const stateDir = await directory(input.stateDir, false)
  if (stateDir !== input.stateDir) fail('original state root changed')
  const snapshot = new Snapshot()
  if (!input.profileManaged) {
    const savedSettings = await snapshot.json<unknown>(await directory(join(stateDir, 'web-settings')), 'settings', 'current')
    if (digest(parseWebSettings(savedSettings)) !== input.settingsDigest) fail('saved connection or policy changed')
  }
  const registry = await snapshot.json<Registry>(await directory(join(stateDir, 'web-host')), 'registry', 'current')
  const record = invocation(registry, owner)
  if (invocationIdentity(record) !== input.invocationIdentity || canonical(domainInvocations(registry, owner.executionDomainId)) !== canonical(input.domainInvocations)) fail('invocation identity or execution-domain revision changed')
  const connectionKey = digest(connection)
  const calls = new Set<string>()
  const terminalMain: { requestId: string; responseId: string; contentDigest: string; hostCommitId: string; text: string }[] = []
  let blocked = record.fence !== undefined, retired = false, confirmed = false
  let cleanup = true, remote: 'idle' | 'running' | 'unknown' = 'idle', dispatch: 'not-dispatched' | 'dispatched' | 'unknown' = 'not-dispatched'
  for (const tool of Object.values(record.toolIntents)) {
    if (!tool || tool.completed !== true || tool.outcomeUnknown === true) blocked = true
  }
  for (const call of record.calls) {
    nonempty(call.requestId, 'original requestId', 200)
    if (calls.has(call.requestId) || call.connectionKey !== connectionKey || !['main','compaction','session-title','one-shot'].includes(call.kind) || typeof call.committed !== 'boolean') fail('call index is inconsistent')
    calls.add(call.requestId)
    facts(call.facts)
    if (call.facts.dispatch === 'unknown') dispatch = 'unknown'
    else if (call.facts.dispatch === 'confirmed' && dispatch !== 'unknown') dispatch = 'dispatched'
    if (call.facts.localCleanup !== 'confirmed') cleanup = false
    if (call.facts.remoteGeneration === 'unknown') remote = 'unknown'
    else if (call.facts.remoteGeneration === 'running' && remote !== 'unknown') remote = 'running'
    const connectionsRoot = await directory(join(stateDir, 'web-connections'))
    const connectionRoot = await directory(join(connectionsRoot, connectionKey))
    const sessions = await directory(join(connectionRoot, 'sessions'))
    const pending = await snapshot.json<{ version: number; requestId: string; phase: string; context: WebRecoveryIdentity & { kind: string }; generation: number; bindingDigest: string; repairs?: RepairAttempt[]; retired?: SavedCall['retired']; request: { tools?: WebToolSchema[]; messages?: { role: string; toolCallId?: string; content: Record<string, unknown>[] }[] }; budget: WebBudgetPolicy; media?: WebMediaAttachment[]; mediaDirectory?: string }>(sessions, 'request', call.requestId)
    if (pending.version !== 1 || pending.requestId !== call.requestId || pending.context.hostInvocationId !== owner.hostInvocationId || pending.context.executionDomainId !== owner.executionDomainId || pending.context.sessionId !== call.sessionId || pending.context.kind !== call.kind ||
        !Number.isSafeInteger(pending.generation) || pending.generation < 1 || canonical(pending.budget) !== canonical(settings.budget)) fail('preparation belongs to another invocation')
    if (call.facts.dispatch === 'not-dispatched' && call.facts.localCleanup === 'confirmed' && call.facts.replayAllowed) {
      if (pending.phase === 'dispatch-intent') {
        // The coordinator persists intent before entering the transport. A
        // browser admission failure may still have positive no-submit proof.
        const browserRoot = await directory(connection.stateDir)
        const journal = JSON.parse(await snapshot.text(join(await directory(join(browserRoot, 'calls')), `${rawDigest(call.requestId)}.json`))) as WebJournal
        if (journal.version !== 1 || journal.request?.requestId !== call.requestId || journal.request.executionDomainId !== owner.executionDomainId || journal.request.sessionId !== call.sessionId ||
            journal.connectionId !== connection.id || journal.accountFingerprint !== connection.accountFingerprint || journal.request.bindingDigest !== pending.bindingDigest ||
            !['prepared','failed'].includes(journal.phase) || journal.facts.dispatch !== 'not-dispatched' || journal.facts.localCleanup !== 'confirmed' || !journal.facts.replayAllowed ||
            journal.facts.remoteGeneration !== 'not-started' || journal.userMessageId || journal.responseId || journal.artifact) fail('transport does not prove the original request was unsent')
      } else if (pending.phase !== 'not-dispatched' && pending.phase !== 'prepared') fail('no-dispatch proof contradicts preparation')
      continue
    }
    if (!call.committed && !call.retired) { blocked = true; continue }
    if (call.facts.dispatch !== 'confirmed' || call.facts.outcome !== 'captured' || call.facts.remoteGeneration !== 'completed' || call.facts.localCleanup !== 'confirmed') fail('settled call contradicts its browser facts')
    const delivery = call.committed ? await snapshot.json<WebDelivery>(sessions, 'delivery', call.requestId) : undefined
    const transportId = delivery?.transportResult.requestId ?? call.retired?.transportRequestId
    if (!transportId) fail('settled call has no transport identity')
    nonempty(transportId, 'transport requestId', 200)
    const browserRoot = await directory(connection.stateDir)
    const protocol = new WebToolProtocol(call.kind === 'main' ? pending.request.tools ?? [] : [])
    const original = await capturedJournal(snapshot, browserRoot, call.requestId, connection, call.sessionId, owner.executionDomainId, pending.bindingDigest)
    if (original.journal.request.generation !== pending.generation || original.journal.request.repairOf !== undefined) fail('original request generation or repair identity changed')
    if (canonical(original.journal.request.media ?? null) !== canonical(pending.media ?? null)) fail('original image manifest changed')
    if (pending.media?.length) {
      validateWebMedia(pending.media)
      if (pending.mediaDirectory !== join(connection.stateDir, 'images')) fail('images have no original private directory')
      const imageDirectory = await directory(pending.mediaDirectory)
      const receipt = original.journal.media
      if (!receipt || receipt.version !== 1 || receipt.modelConsumption !== 'unverified' || receipt.userMessageId !== original.journal.userMessageId ||
          canonical(receipt.attachments) !== canonical(pending.media)) fail('original image acceptance receipt changed')
      assertAcceptedWebMedia(pending.media, receipt.acceptedUploadNames)
      for (const item of pending.media) {
        const message = pending.request.messages?.[item.messageIndex]
        const block = message?.content[item.blockIndex]
        const reference = block?.attachment as Record<string, unknown> | undefined
        if (message?.role !== item.role || (message.toolCallId ?? undefined) !== item.toolCallId || block?.type !== 'image' || block.offloaded === true ||
            !reference || reference.attachmentId !== item.attachmentId || reference.mediaType !== item.mediaType || reference.bytes !== item.artifact.bytes || reference.width !== item.width || reference.height !== item.height) fail('image no longer belongs to its original message occurrence')
        const image = await readWebMediaArtifact(item, imageDirectory)
        if (!(await snapshot.bytes(item.artifact.path)).equals(image)) fail('image changed during the evidence read')
      }
    } else if (pending.media !== undefined || pending.mediaDirectory !== undefined || original.journal.media !== undefined) fail('unexpected original image evidence')
    const parseAnswer = (text: string, requestId: string) => {
      const answer = protocol.parse(text, call.requestId, pending.generation, pending.budget)
      if (requestId !== call.requestId) protocol.assertFaithfulRepair(answer, original.artifact, call.requestId, pending.generation, pending.budget)
      return answer
    }
    let tail = call.requestId
    const chain = new Set([tail])
    if (pending.repairs !== undefined && !Array.isArray(pending.repairs)) fail('invalid format repair chain')
    for (const [index, repair] of (pending.repairs ?? []).entries()) {
      nonempty(repair.requestId, 'repair requestId', 200)
      if (repair.parentRequestId !== tail || chain.has(repair.requestId) || !hash(repair.parentDigest) || !Number.isSafeInteger(repair.promptBytes) || repair.promptBytes < 1 ||
          !['prepared','not-dispatched','dispatch-intent'].includes(repair.phase)) fail('format repair chain changed')
      const parent = await capturedJournal(snapshot, browserRoot, tail, connection, call.sessionId, owner.executionDomainId, pending.bindingDigest)
      if (parent.journal.artifact!.sha256 !== repair.parentDigest) fail('format repair parent artifact changed')
      if (repair.phase !== 'dispatch-intent') {
        if (index !== pending.repairs!.length - 1) fail('format repair continued after an unsent child')
        break // Explicitly unsent repair leaves the captured parent as the tail.
      }
      if (String(parent.journal.phase) !== 'format-repair' || parent.journal.hostCommitId !== undefined || parent.journal.disposition?.kind !== 'format-repair' ||
          parent.journal.disposition.nextRequestId !== repair.requestId || parent.journal.disposition.responseDigest !== repair.parentDigest) fail('format repair lacks its original continuation receipt')
      const child = await capturedJournal(snapshot, browserRoot, repair.requestId, connection, call.sessionId, owner.executionDomainId, pending.bindingDigest)
      if (child.journal.request.generation !== pending.generation || canonical(child.journal.request.repairOf) !== canonical({ requestId: tail, responseDigest: repair.parentDigest }) ||
          child.journal.request.prompt !== protocol.repairPrompt(call.requestId, pending.generation, repair.requestId, { text: original.artifact, sha256: original.journal.artifact!.sha256 }) ||
          Buffer.byteLength(child.journal.request.prompt) !== repair.promptBytes || child.journal.request.media !== undefined || child.journal.media !== undefined) fail('format correction is not bound to its original answer')
      tail = repair.requestId
      chain.add(tail)
    }
    if (tail !== transportId) fail('terminal transport is outside the original repair chain')
    const { journal, artifact } = await capturedJournal(snapshot, browserRoot, tail, connection, call.sessionId, owner.executionDomainId, pending.bindingDigest)
    if (call.retired) {
      if (call.committed || call.retired.reason !== 'user-discarded-invalid-response' || call.retired.responseDigest !== journal.artifact!.sha256 || !Number.isSafeInteger(call.retired.at) ||
          canonical(pending.retired) !== canonical(call.retired) || String(journal.phase) !== 'retired' || journal.hostCommitId !== undefined ||
          journal.disposition?.kind !== 'retired' || journal.disposition.responseDigest !== call.retired.responseDigest || journal.disposition.reason !== call.retired.reason || journal.disposition.at !== call.retired.at) fail('retirement does not match the rejected response')
      let rejection: unknown
      try { parseAnswer(artifact, tail) } catch (error) { rejection = error }
      if (!(rejection instanceof WebPolicyError)) fail('retired response is not rejected by the original protocol')
      const rejected = await snapshot.json<{ version: number; requestId: string; transportRequestId: string; responseDigest: string; reason: string }>(sessions, 'rejected', call.requestId)
      if (rejected.version !== 1 || rejected.requestId !== call.requestId || rejected.transportRequestId !== tail || rejected.responseDigest !== journal.artifact!.sha256 || rejected.reason !== rejection.message) fail('retirement lost its original rejection receipt')
      retired = true
      continue
    }
    const originalBlocks = answerBlocks(parseAnswer(artifact, tail))
    if (canonical(originalBlocks) !== canonical(delivery!.blocks)) fail('host blocks differ from the captured response')
    const reference = delivery!.reference
    if (delivery!.version !== 1 || reference.protocol !== WEB_PROTOCOL || reference.requestId !== call.requestId || reference.responseId !== journal.responseId ||
        reference.responseDigest !== journal.artifact!.sha256 || reference.contentDigest !== digest(delivery!.blocks) || reference.sessionId !== call.sessionId ||
        reference.executionDomainId !== owner.executionDomainId || reference.hostInvocationId !== owner.hostInvocationId || reference.kind !== call.kind ||
        reference.generation !== pending.generation || !delivery!.committed?.hostCommitId || journal.hostCommitId !== delivery!.committed?.hostCommitId || journal.phase !== 'acknowledged') fail('host commit or complete delivery is unconfirmed')
    confirmed = true
    if (call.kind === 'main' && call.sessionId === owner.sessionId && delivery!.blocks.length && delivery!.blocks.every(block => block.type === 'text' && typeof block.text === 'string')) {
      terminalMain.push({ requestId: call.requestId, responseId: reference.responseId, contentDigest: reference.contentDigest, hostCommitId: delivery!.committed!.hostCommitId, text: delivery!.blocks.map(block => String(block.text)).join('') })
    }
  }
  if (!cleanup || remote !== 'idle' || dispatch === 'unknown') blocked = true
  const revision = await snapshot.verify()
  const disposition = blocked ? 'blocked' as const : retired ? 'retired' as const : dispatch === 'not-dispatched' ? 'not-dispatched' as const : confirmed ? 'committed' as const : 'blocked' as const
  return {
    version: 1 as const, contract: CONTRACT, identity: owner, checkpointDigest: digest(input), revision, disposition,
    binding: { protocol: 1 as const, transport: 'chatgpt-web' as const, provider: input.provider, model: WEB_MODEL_ID, reasoningEffort: WEB_EFFORT,
      connectionId: connection.id, accountFingerprint: connection.accountFingerprint, policyVersion: settings.budget.version, contextPolicy: 'project-only' as const,
      observation: 'opaque' as const, usage: 'unknown' as const, hostContractVersion: 1 as const, runtimeVersion: 'web-runtime/1' as const },
    facts: { version: 1 as const, ...owner, dispatch, outcome: disposition === 'blocked' ? 'unknown' as const : disposition === 'committed' && record.completed && terminalMain.length ? 'completed' as const : 'failed' as const,
      remoteGeneration: remote, localCleanupConfirmed: cleanup, usageStatus: 'unknown' as const },
    terminalMain,
  }
}
