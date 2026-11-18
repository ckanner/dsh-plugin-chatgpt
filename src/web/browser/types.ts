/** Browser wire contracts are plugin-owned; none of these names is an OpenAI API. */
export type WebContextPolicy = 'project-only' | 'personalized'

export interface WebConnection {
  id: string
  browserPath: string
  profilePath: string
  stateDir: string
  /** SHA-256 of the lower-cased account email observed in the account menu. */
  accountFingerprint: string
}

export interface WebConversation {
  id: string
  url: string
  projectUrl?: string
  title?: string
}

export interface WebActivity {
  requestId: string
  generation: number
  bindingDigest: string
  sequence: number
  kind: 'accepted' | 'content' | 'phase' | 'completed'
  at: number
  /** Content is never copied to the activity channel. */
  observedBytes?: number
}

export interface WebTurnRequest {
  requestId: string
  executionDomainId: string
  sessionId: string
  generation: number
  bindingDigest: string
  prompt: string
  title: string
  /** Absolute deadline; queuing, reconnect and cleanup never reset it. */
  deadlineMs: number
  signal?: AbortSignal
  contextPolicy: WebContextPolicy
  conversation?: WebConversation
  maxPromptBytes: number
  maxResponseBytes: number
  onActivity?: (activity: WebActivity) => void
}

export interface WebEvidence {
  adapter: 'chatgpt-dom/1'
  model: 'GPT-6'
  effort: 'Pro'
  accountFingerprint: string
  contextPolicy: WebContextPolicy
  conversationUrl: string
  projectUrl?: string
  capturedAt: number
  bindingDigest: string
}

export interface WebFacts {
  dispatch: 'not-dispatched' | 'unknown' | 'confirmed'
  outcome: 'unknown' | 'captured'
  localCleanup: 'confirmed' | 'unknown'
  remoteGeneration: 'not-started' | 'running' | 'completed' | 'stopped' | 'unknown'
  usage: 'unknown'
  replayAllowed: boolean
  stopReason?: 'cancelled' | 'deadline' | 'error'
}

export interface WebArtifact { path: string; bytes: number; sha256: string }

export interface WebTurnResult {
  requestId: string
  text: string
  responseId: string
  conversation: WebConversation
  artifact: WebArtifact
  facts: WebFacts
  evidence: WebEvidence
}

export type WebErrorCode = 'AUTH' | 'QUOTA' | 'RATE_LIMIT' | 'CONTEXT_WINDOW_EXCEEDED' |
  'INVALID_REQUEST' | 'TRANSPORT' | 'SERVER' | 'TIMEOUT' | 'EMPTY_RESPONSE'

export class WebTransportError extends Error {
  readonly code: WebErrorCode
  readonly reason: string
  readonly facts: WebFacts

  constructor(code: WebErrorCode, reason: string, facts: WebFacts, options?: ErrorOptions) {
    super(`ChatGPT Web: ${reason}`, options)
    this.name = 'WebTransportError'
    this.code = code
    this.reason = reason
    this.facts = { ...facts }
  }
}

export interface WebPageSample {
  conversation: WebConversation
  /** Stable UI message identity; position or text alone is insufficient. */
  userMessageId?: string
  acceptedPrompt?: string
  responseId?: string
  text: string
  stopVisible: boolean
  thinking: boolean
  /** Positive, response-scoped action controls, not absence of a spinner. */
  finishedActions: boolean
  phase?: string
  error?: { code: WebErrorCode; reason: string }
}

/** Injectable only at construction; production uses the CDP implementation. */
export interface WebPage {
  readonly targetId: string
  prepare(request: WebTurnRequest, beforeContainerMutation?: () => Promise<void>): Promise<{ conversation: WebConversation; evidence: WebEvidence }>
  inspect(request: WebTurnRequest): Promise<{ conversation: WebConversation; evidence: WebEvidence }>
  submit(prompt: string): Promise<void>
  sample(): Promise<WebPageSample>
  finalize?(conversation: WebConversation): Promise<WebConversation>
  stop(userMessageId: string): Promise<boolean>
  close(): Promise<void>
}

export interface WebPageFactory {
  open(connection: WebConnection, request: WebTurnRequest, targetId?: string): Promise<WebPage>
  connect(connection: WebConnection, deadlineMs: number): Promise<{ accountFingerprint?: string; targetId: string }>
}

export interface WebJournal {
  version: 1
  /** The request owns only local CDP clients; Chrome itself is connection-owned. */
  ownerPid?: number
  request: Omit<WebTurnRequest, 'signal' | 'onActivity'>
  connectionId: string
  accountFingerprint: string
  phase: 'prepared' | 'container-intent' | 'submit-intent' | 'submitted' | 'captured' | 'acknowledged' | 'failed'
  updatedAt: number
  targetId?: string
  conversation?: WebConversation
  evidence?: WebEvidence
  userMessageId?: string
  responseId?: string
  artifact?: WebArtifact
  facts: WebFacts
  hostCommitId?: string
}

export const initialWebFacts = (): WebFacts => ({
  dispatch: 'not-dispatched', outcome: 'unknown', localCleanup: 'unknown',
  remoteGeneration: 'not-started', usage: 'unknown', replayAllowed: true,
})
