import { digest } from './policy.ts'

/** DSH's durable call event, scoped to its owning Session, identifies a tool tree. */
export interface WebToolRoot { sessionId: string; rootCallId: string; rootCallSeq: number }
export interface WebToolOccurrence extends WebToolRoot { hostInvocationId: string; callId: string }
export interface WebToolCommit extends WebToolRoot { resultEventSeq: number }
export interface WebToolIntent extends WebToolRoot {
  callId: string
  completed: boolean
  observed?: boolean
  outcomeUnknown?: boolean
  resultEventSeq?: number
}
export interface WebSessionEvent {
  type: string
  seq: number
  data: Record<string, unknown>
  sourceEventSeqs?: readonly number[]
}

function seq(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function id(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0') }
export function validToolRoot(root: WebToolRoot): boolean {
  return id(root.sessionId) && id(root.rootCallId) && seq(root.rootCallSeq)
}
export function toolOccurrenceKey(tool: WebToolRoot & { callId: string }): string {
  return digest({ sessionId: tool.sessionId, rootCallId: tool.rootCallId, rootCallSeq: tool.rootCallSeq, callId: tool.callId })
}

/** A historical call with the same model-supplied ID is not a current dispatch. */
export function toolRootFromEvents(sessionId: string, rootCallId: string, events: readonly WebSessionEvent[]): WebToolRoot | undefined {
  const step = events.findLast(event => event.type === 'step/start' || event.type === 'step/end')
  if (!step || step.type !== 'step/start' || !seq(step.seq) || !seq(step.data.turn) || !seq(step.data.step)) return
  const call = events.findLast(event => event.type === 'tool/call' && event.data.callId === rootCallId)
  if (!call || !seq(call.seq) || call.seq <= step.seq || call.data.turn !== step.data.turn || call.data.step !== step.data.step) return
  const root = { sessionId, rootCallId, rootCallSeq: call.seq }
  return validToolRoot(root) ? root : undefined
}

/** Result attribution comes from the persisted source-event link, never callId alone. */
export function toolCommitFromEvent(sessionId: string, event: WebSessionEvent, events: ReadonlyMap<number, WebSessionEvent>): WebToolCommit | undefined {
  if (event.type !== 'tool/result' || !seq(event.seq) || event.sourceEventSeqs?.length !== 1) return
  const rootCallSeq = event.sourceEventSeqs[0]
  if (!seq(rootCallSeq) || rootCallSeq >= event.seq) return
  const call = events.get(rootCallSeq)
  const message = event.data.message as { toolCallId?: unknown } | undefined
  if (!call || call.type !== 'tool/call' || !id(message?.toolCallId) || call.data.callId !== message.toolCallId
    || !seq(call.data.turn) || !seq(call.data.step) || call.data.turn !== event.data.turn || call.data.step !== event.data.step) return
  const root = { sessionId, rootCallId: message.toolCallId, rootCallSeq }
  return validToolRoot(root) ? { ...root, resultEventSeq: event.seq } : undefined
}

/** Legacy ID-only receipts cannot positively settle work after an upgrade/restart. */
export function settledToolIntent(key: string, tool: WebToolIntent, intents: Record<string, WebToolIntent>): boolean {
  if (!tool || !validToolRoot(tool) || !id(tool.callId) || key !== toolOccurrenceKey(tool)
    || tool.completed !== true || tool.outcomeUnknown === true || !seq(tool.resultEventSeq) || tool.resultEventSeq <= tool.rootCallSeq) return false
  if (tool.callId === tool.rootCallId) return true
  const root = intents[toolOccurrenceKey({ ...tool, callId: tool.rootCallId })]
  return tool.observed === true && root?.completed === true && root.outcomeUnknown !== true
    && root.resultEventSeq === tool.resultEventSeq && root.sessionId === tool.sessionId
    && root.rootCallSeq === tool.rootCallSeq && root.rootCallId === tool.rootCallId && root.callId === tool.rootCallId
}
