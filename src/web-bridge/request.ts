/** Capture the raw public GenerateOptions seam before starting any asynchronous work. */
import { WEB_EFFORT, WEB_MODEL, type WebAttachmentVersion, type WebBinding, type WebMessage, type WebRequest, WebBridgeError } from './contracts.ts'
import { cloneJson, receiptMatches, requestHash, validateReceipt, validateRequest, WEB_MAX_REQUEST_BYTES } from './protocol.ts'

/** Structural public host input: one-shot messages may lack a durable id/source. */
export interface WebGenerateOptions {
  provider: string
  model: string
  reasoningEffort?: string
  sessionId?: string
  purpose?: string
  system?: string
  messages: readonly {
    id?: string
    role: string
    content: readonly unknown[]
    source?: unknown
    toolCallId?: string
    isError?: boolean
  }[]
  tools?: readonly unknown[]
  toolHistory?: unknown
  temperature?: number
  maxTokens?: number
  stop?: readonly string[]
  signal?: AbortSignal
}

export interface CapturedWebRequest {
  readonly body: Omit<WebGenerateOptions, 'signal'>
  readonly signal: AbortSignal | undefined
  readonly attachmentVersions?: WebAttachmentVersion[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child)
    Object.freeze(value)
  }
  return value
}

/** Opaque state from SIWC or another adapter is not forwarded to the Web model. */
function captureSource(value: unknown): unknown {
  const source = record(value)
  const response = record(record(source?.['replayState'])?.['response'])
  if (response?.['kind'] !== 'chatgpt-web-receipt') return undefined
  return { kind: source?.['kind'], provider: source?.['provider'], model: source?.['model'],
    replayState: { response: validateReceipt(response) } }
}

export function captureWebRequest(options: WebGenerateOptions): CapturedWebRequest {
  const supported = ['provider', 'model', 'reasoningEffort', 'sessionId', 'purpose', 'system', 'messages',
    'tools', 'toolHistory', 'temperature', 'maxTokens', 'stop', 'signal']
  if (Object.keys(options).some(key => !supported.includes(key))) {
    throw new WebBridgeError('WEB_UNSUPPORTED_OPTION', 'GenerateOptions contains an unsupported field', 400)
  }
  const body: Omit<WebGenerateOptions, 'signal'> = {
    provider: options.provider, model: options.model,
    messages: options.messages.map(message => {
      const source = captureSource(message.source)
      return { role: message.role, content: message.content,
        ...message.id === undefined ? {} : { id: message.id },
        ...source === undefined ? {} : { source },
        ...message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId },
        ...message.isError === undefined ? {} : { isError: message.isError } }
    }),
    ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
    ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
    ...options.purpose === undefined ? {} : { purpose: options.purpose },
    ...options.system === undefined ? {} : { system: options.system },
    ...options.tools === undefined ? {} : { tools: options.tools },
    ...options.toolHistory === undefined ? {} : { toolHistory: options.toolHistory },
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
    ...options.stop === undefined ? {} : { stop: options.stop },
  }
  return { body: immutable(cloneJson(body, WEB_MAX_REQUEST_BYTES)), signal: options.signal }
}

/** Finalize the immutable snapshot against this launch's authenticated binding. */
export function prepareWebRequest(snapshot: CapturedWebRequest, binding: WebBinding, clientLeaseId: string, deliveryAttemptId: string): WebRequest {
  const options = snapshot.body
  const purpose = options.purpose ?? 'normal'
  const scope = { ...binding, sessionId: options.sessionId ?? '', purpose: purpose as WebRequest['purpose'] }
  const messages = options.messages.map(message => {
    const source = record(message.source)
    const response = record(record(source?.['replayState'])?.['response'])
    const own = response !== undefined && receiptMatches(validateReceipt(response), scope)
      && source?.['kind'] === 'model' && source['provider'] === options.provider && source['model'] === WEB_MODEL
    return { ...message, ...purpose === 'session-title' ? { id: undefined } : {}, source: own ? source : undefined }
  }).map(message => Object.fromEntries(Object.entries(message).filter(([, value]) => value !== undefined))) as unknown as WebMessage[]
  const first = messages[0]?.role
  const request = {
    ...binding, provider: options.provider, clientLeaseId, deliveryAttemptId,
    idempotencyKey: '', sessionId: options.sessionId ?? '', purpose,
    model: options.model, reasoningEffort: options.reasoningEffort ?? WEB_EFFORT,
    ...options.system && first !== 'system' && first !== 'developer' ? { system: options.system } : {},
    messages, tools: options.tools ?? [],
    ...options.toolHistory === undefined ? {} : { toolHistory: options.toolHistory },
    controls: {
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      ...options.stop === undefined ? {} : { stop: options.stop },
    },
    attachmentVersions: snapshot.attachmentVersions ?? [],
    parentReceipt: messages.findLast(message => message.role === 'assistant')?.source?.replayState.response ?? null,
  // This candidate is not admitted until validateRequest below checks every field.
  } as unknown as WebRequest
  request.idempotencyKey = requestHash(request)
  return validateRequest(request, binding)
}
