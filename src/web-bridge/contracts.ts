/** Versioned, JSON-only boundary for the experimental local Web bridge. */
export const WEB_PROTOCOL_VERSION = 1 as const
export const WEB_MODEL = 'gpt-6-pro-web' as const
export const WEB_EFFORT = 'pro' as const
/** Includes wire image bytes; responses and inspection keep their smaller independent bound. */
export const WEB_MAX_REQUEST_BYTES = 32 * 1024 * 1024

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type WebPurpose = 'normal' | 'compaction' | 'session-title'

export interface WebBinding {
  protocolVersion: 1
  installationId: string
  provider: string
  profileId: string
  accountBinding: string
}

export type WebOutputBlock =
  | { type: 'text', text: string }
  | { type: 'tool-call', id: string, name: string, arguments: string }

export type WebInputBlock = WebOutputBlock
  | { type: 'reasoning', text: string }
  | { type: 'tool-addition' | 'tool-removal', toolName: string }
  | { type: 'image', attachmentVersion: string }

/** Content-addressed exact bytes; the journal uses blobId, transport may use base64. */
export interface WebAttachmentVersion {
  id: string
  digest: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  byteLength: number
  uploadName: string
  base64?: string
  blobId?: string
}

export interface WebReceipt {
  kind: 'chatgpt-web-receipt'
  version: 1
  installationId: string
  provider: string
  profileId: string
  accountBinding: string
  sessionId: string
  purpose: WebPurpose
  model: typeof WEB_MODEL
  generationId: string
  turnId: string
  requestHash: string
  responseDigest: string
}

/** Only Web receipts are forwarded; opaque state from another transport is not input. */
export interface WebMessage {
  id?: string
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  content: WebInputBlock[]
  source?: { kind: 'model', provider: string, model: string, replayState: { response: WebReceipt } }
  toolCallId?: string
  isError?: boolean
}

export interface WebTool {
  name: string
  description: string
  parameters: { [key: string]: JsonValue }
  deferLoading?: true
}

export interface WebToolHistory {
  tools: WebTool[]
  updates: { messageId: string, additions: WebTool[] }[]
}

export interface WebRequest extends WebBinding {
  clientLeaseId: string
  deliveryAttemptId: string
  idempotencyKey: string
  sessionId: string
  purpose: WebPurpose
  model: typeof WEB_MODEL
  reasoningEffort: typeof WEB_EFFORT
  system?: string
  messages: WebMessage[]
  tools: WebTool[]
  toolHistory?: WebToolHistory
  controls: { [key: string]: JsonValue }
  attachmentVersions: WebAttachmentVersion[]
  parentReceipt: WebReceipt | null
}

/** Complete, durably recorded response. No partial block is executable. */
export interface WebResponse {
  protocolVersion: 1
  turnId: string
  blocks: WebOutputBlock[]
  finishReason: 'stop' | 'tool-calls'
  receipt: WebReceipt
}

export type TurnState = 'accepted' | 'preparing' | 'submit_intent' | 'submitted'
  | 'observing' | 'completed' | 'uncertain' | 'failed' | 'cancelled'

export interface TurnInspection {
  turnId: string
  sessionId: string
  state: TurnState
  requestHash: string
  generationId: string
  discarded: boolean
  deliveryState: 'unclaimed' | 'delivery-intent'
  deliveryOwner?: { clientLeaseId: string, deliveryAttemptId: string }
  fenceReason?: string
  /** Inspection data, never permission to emit executable chunks. */
  response?: WebResponse
}

export interface TurnAccess {
  clientLeaseId: string
  sessionId: string
}

export interface PageTurn {
  request: WebRequest
  turnId: string
  generationId: string
}

export type PageRecovery =
  | { kind: 'unknown' }
  | { kind: 'not-submitted' }
  | { kind: 'terminal-failure', message: string }
  | { kind: 'completed', response: unknown }

/**
 * Injectable page seam. prepare is read-only. The browser implementation records
 * its own intent before each Project/upload/input/Send mutation within submit.
 * Recovery observes remote evidence; abandonment only updates local evidence.
 */
export interface WebPageTransport {
  prepare(turn: PageTurn, signal: AbortSignal): Promise<void>
  submit(turn: PageTurn, signal: AbortSignal): Promise<{ promptId: string }>
  observe(turn: PageTurn, promptId: string, signal: AbortSignal): Promise<unknown>
  /** Read-only evidence reconciliation. It must never submit or run tools. */
  recover?(turn: PageTurn): Promise<PageRecovery>
  /** Record explicit abandonment locally; preserve evidence and never mutate the website. */
  discard?(turn: PageTurn): Promise<void>
}

export interface ExecuteOptions {
  /** Revalidate the HTTP client's lease immediately before claiming delivery. */
  authorizeDelivery?: () => void
}

/** Surface shared by the HTTP server and the durable engine. */
export interface WebBridgeEngine {
  readonly binding: WebBinding
  readonly instanceId: string
  execute(request: WebRequest, options?: ExecuteOptions): Promise<WebResponse>
  inspect(turnId: string, access: TurnAccess): Promise<TurnInspection>
  cancel(turnId: string, access: TurnAccess): Promise<TurnInspection>
  recover(turnId: string, access: TurnAccess): Promise<TurnInspection>
  discard(turnId: string, access: TurnAccess): Promise<TurnInspection>
  releaseClient(clientLeaseId: string): Promise<void>
  close(): Promise<void>
}

export interface BridgeHealth extends WebBinding {
  instanceId: string
  transport: 'experimental' | 'browser'
}

export interface ClientLease {
  clientLeaseId: string
  expiresAt: number
}

/** Stable bridge failures are translated to the host's public LlmError at the seam. */
export class WebBridgeError extends Error {
  readonly code: string
  readonly status: number
  readonly requestId: string | undefined

  constructor(code: string, message: string, status = 409, options?: ErrorOptions & { requestId?: string }) {
    super(message, options)
    this.name = 'WebBridgeError'
    this.code = code
    this.status = status
    this.requestId = options?.requestId
  }
}
