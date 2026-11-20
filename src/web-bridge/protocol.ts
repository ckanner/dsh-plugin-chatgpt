/** Strict normalization and validation shared by both sides of the local bridge. */
import { createHash } from 'node:crypto'
import { Ajv, type ValidateFunction } from 'ajv'
import {
  WEB_EFFORT, WEB_MODEL, WebBridgeError,
  type JsonValue, type TurnInspection, type WebBinding, type WebInputBlock, type WebMessage,
  type WebOutputBlock, type WebPurpose, type WebReceipt, type WebRequest,
  type WebResponse, type WebTool, type WebToolHistory,
} from './contracts.ts'

export const WEB_MAX_JSON_BYTES = 1024 * 1024
export const WEB_MAX_JSON_DEPTH = 64
const MAX_ID_CODE_UNITS = 256

function invalid(message: string, code = 'WEB_INVALID_REQUEST'): never {
  throw new WebBridgeError(code, message, 400)
}

/** No lossy JSON coercions (undefined, NaN, getters, cycles or sparse arrays). */
export function canonical(value: unknown): string {
  const ancestors = new Set<object>()
  let nodes = 0
  function visit(item: unknown, depth: number): JsonValue {
    if (++nodes > 100_000 || depth > WEB_MAX_JSON_DEPTH) invalid('JSON structure exceeds the bridge limit')
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (typeof item !== 'object' || item === null) invalid('Expected lossless JSON values')
    if (ancestors.has(item)) invalid('Cyclic JSON input is unsupported')
    ancestors.add(item)
    let result: JsonValue
    if (Array.isArray(item)) {
      result = Array.from({ length: item.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index))
        if (!descriptor || !('value' in descriptor)) invalid('Sparse or accessor arrays are unsupported')
        return visit(descriptor.value, depth + 1)
      })
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        invalid('Only plain JSON objects are supported')
      }
      const object: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue }
      for (const key of Object.keys(item).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)!
        if (!('value' in descriptor)) invalid('Accessor properties are unsupported')
        object[key] = visit(descriptor.value, depth + 1)
      }
      result = object
    }
    ancestors.delete(item)
    return result
  }
  const text = JSON.stringify(visit(value, 0))
  if (Buffer.byteLength(text, 'utf8') > WEB_MAX_JSON_BYTES) invalid('JSON payload exceeds the bridge limit')
  return text
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(canonical(value)) as T
}

export function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`)
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(`${label} contains an unsupported field`)
}

function string(value: unknown, label: string, max = MAX_ID_CODE_UNITS, empty = false): string {
  if (typeof value !== 'string' || !empty && value.length === 0 || typeof value === 'string' && value.length > max) {
    invalid(`${label} must be ${empty ? 'a' : 'a nonempty'} string of at most ${max} characters`)
  }
  return value as string
}

function array(value: unknown, label: string, max = 10_000): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(`${label} must be a bounded array`)
  return value
}

function hash(value: unknown, label: string): string {
  const text = string(value, label)
  if (!/^sha256:[a-f0-9]{64}$/.test(text)) invalid(`${label} must be a SHA-256 digest`)
  return text
}

function purpose(value: unknown): WebPurpose {
  if (value !== 'normal' && value !== 'compaction' && value !== 'session-title') invalid('Unsupported Web request purpose')
  return value
}

export function validateBinding(value: unknown): WebBinding {
  const item = object(value, 'binding')
  if (item['protocolVersion'] !== 1) invalid('Unsupported bridge protocol', 'WEB_PROTOCOL_MISMATCH')
  return {
    protocolVersion: 1,
    installationId: string(item['installationId'], 'installationId'),
    provider: string(item['provider'], 'provider'),
    profileId: string(item['profileId'], 'profileId'),
    accountBinding: string(item['accountBinding'], 'accountBinding'),
  }
}

export function validateReceipt(value: unknown): WebReceipt {
  const item = object(value, 'receipt')
  keys(item, ['kind', 'version', 'installationId', 'provider', 'profileId', 'accountBinding',
    'sessionId', 'purpose', 'model', 'generationId', 'turnId', 'requestHash', 'responseDigest'], 'receipt')
  if (item['kind'] !== 'chatgpt-web-receipt' || item['version'] !== 1 || item['model'] !== WEB_MODEL) {
    invalid('Unsupported Web receipt', 'WEB_INVALID_RECEIPT')
  }
  return {
    kind: 'chatgpt-web-receipt', version: 1,
    installationId: string(item['installationId'], 'receipt.installationId'),
    provider: string(item['provider'], 'receipt.provider'),
    profileId: string(item['profileId'], 'receipt.profileId'),
    accountBinding: string(item['accountBinding'], 'receipt.accountBinding'),
    sessionId: string(item['sessionId'], 'receipt.sessionId'),
    purpose: purpose(item['purpose']), model: WEB_MODEL,
    generationId: string(item['generationId'], 'receipt.generationId'),
    turnId: string(item['turnId'], 'receipt.turnId'),
    requestHash: hash(item['requestHash'], 'receipt.requestHash'),
    responseDigest: hash(item['responseDigest'], 'receipt.responseDigest'),
  }
}

export function receiptMatches(receipt: WebReceipt, scope: WebBinding & { sessionId: string, purpose: WebPurpose }): boolean {
  return receipt.installationId === scope.installationId && receipt.provider === scope.provider
    && receipt.profileId === scope.profileId && receipt.accountBinding === scope.accountBinding
    && receipt.sessionId === scope.sessionId && receipt.purpose === scope.purpose && receipt.model === WEB_MODEL
}

function inputBlock(value: unknown): WebInputBlock {
  const item = object(value, 'content block')
  switch (item['type']) {
    case 'text': case 'reasoning':
      keys(item, ['type', 'text'], 'text block')
      return { type: item['type'], text: string(item['text'], 'text', WEB_MAX_JSON_BYTES, true) }
    case 'tool-call':
      keys(item, ['type', 'id', 'name', 'arguments'], 'tool-call block')
      return { type: 'tool-call', id: string(item['id'], 'call id'), name: string(item['name'], 'tool name', 128),
        arguments: string(item['arguments'], 'tool arguments', WEB_MAX_JSON_BYTES) }
    case 'tool-addition': case 'tool-removal':
      keys(item, ['type', 'toolName'], 'tool update')
      return { type: item['type'], toolName: string(item['toolName'], 'toolName', 128) }
    default: invalid('This experimental bridge accepts text and tools only; image/file transport is not implemented', 'WEB_UNSUPPORTED_CONTENT')
  }
}

function message(value: unknown, scope: WebBinding & { sessionId: string, purpose: WebPurpose }): WebMessage {
  const item = object(value, 'message')
  keys(item, ['id', 'role', 'content', 'source', 'toolCallId', 'isError'], 'message')
  const role = item['role']
  if (role !== 'system' && role !== 'developer' && role !== 'user' && role !== 'assistant' && role !== 'tool') invalid('Unsupported message role')
  const content = array(item['content'], 'message.content').map(inputBlock)
  if (content.some(block => block.type === 'tool-call' && role !== 'assistant'
    || (block.type === 'tool-addition' || block.type === 'tool-removal') && role !== 'developer')) invalid('Invalid role for a tool block')
  const result: WebMessage = { role, content }
  if (item['id'] !== undefined && scope.purpose !== 'session-title') result.id = string(item['id'], 'message.id')
  if (role === 'tool') {
    result.toolCallId = string(item['toolCallId'], 'toolCallId')
    if (item['isError'] !== undefined) {
      if (typeof item['isError'] !== 'boolean') invalid('isError must be boolean')
      result.isError = item['isError']
    }
  } else if (item['toolCallId'] !== undefined || item['isError'] !== undefined) invalid('Tool-result fields require a tool role')
  if (item['source'] !== undefined) {
    if (role !== 'assistant') invalid('Only assistant Web replay metadata crosses this boundary')
    const source = object(item['source'], 'source')
    keys(source, ['kind', 'provider', 'model', 'replayState'], 'source')
    const replay = object(source['replayState'], 'replayState')
    keys(replay, ['response'], 'replayState')
    const receipt = validateReceipt(replay['response'])
    if (source['kind'] !== 'model' || source['provider'] !== scope.provider || source['model'] !== WEB_MODEL
      || !receiptMatches(receipt, scope)) invalid('Receipt belongs to another route, account, session or purpose', 'WEB_INVALID_RECEIPT')
    result.source = { kind: 'model', provider: scope.provider, model: WEB_MODEL, replayState: { response: receipt } }
  }
  return result
}

function tool(value: unknown): WebTool {
  const item = object(value, 'tool schema')
  keys(item, ['name', 'description', 'parameters', 'deferLoading'], 'tool schema')
  if (item['deferLoading'] !== undefined && item['deferLoading'] !== true) invalid('Invalid deferLoading')
  return {
    name: string(item['name'], 'tool name', 128),
    description: string(item['description'], 'tool description', WEB_MAX_JSON_BYTES, true),
    parameters: object(item['parameters'], 'tool parameters') as { [key: string]: JsonValue },
    ...item['deferLoading'] === true ? { deferLoading: true as const } : {},
  }
}

function tools(value: unknown): WebTool[] {
  const result = array(value, 'tools', 128).map(tool)
  if (new Set(result.map(item => item.name)).size !== result.length) invalid('Tool names must be unique')
  return result
}

function toolHistory(value: unknown): WebToolHistory {
  const item = object(value, 'toolHistory')
  keys(item, ['tools', 'updates'], 'toolHistory')
  return { tools: tools(item['tools']), updates: array(item['updates'], 'toolHistory.updates').map(value => {
    const update = object(value, 'tool update')
    keys(update, ['messageId', 'additions'], 'tool update')
    return { messageId: string(update['messageId'], 'tool update.messageId'), additions: tools(update['additions']) }
  }) }
}

/** Compile before admission. No remote refs, coercions, defaults, or schema extensions. */
function validators(request: Pick<WebRequest, 'tools'>): Map<string, ValidateFunction> {
  const ajv = new Ajv({ strictSchema: true, strictTypes: false, strictTuples: false,
    strictRequired: false, allowUnionTypes: true, ownProperties: true, addUsedSchema: false })
  const result = new Map<string, ValidateFunction>()
  for (const definition of request.tools) {
    function check(value: JsonValue): void {
      if (Array.isArray(value)) { value.forEach(check); return }
      if (value === null || typeof value !== 'object') return
      if (value['$async'] !== undefined || typeof value['$ref'] === 'string' && !value['$ref'].startsWith('#')) {
        invalid('Async and external JSON Schema references are unsupported', 'WEB_UNSUPPORTED_SCHEMA')
      }
      Object.values(value).forEach(check)
    }
    check(definition.parameters)
    try { result.set(definition.name, ajv.compile(definition.parameters)) }
    catch { invalid(`Unsupported JSON Schema for tool ${definition.name}`, 'WEB_UNSUPPORTED_SCHEMA') }
  }
  return result
}

/** Semantic identity excludes transport leases, delivery attempts, tokens and timestamps. */
export function requestHash(request: WebRequest): string {
  const messages = request.messages.map(message => request.purpose === 'session-title'
    ? Object.fromEntries(Object.entries(message).filter(([key]) => key !== 'id')) : message)
  return digest({
    binding: { protocolVersion: request.protocolVersion, installationId: request.installationId,
      providerRoute: request.provider, profileId: request.profileId, accountBinding: request.accountBinding,
      sessionId: request.sessionId, purpose: request.purpose },
    anchor: request.purpose === 'session-title' ? [] : request.messages.map(message => message.id ?? null),
    payload: { model: request.model, reasoningEffort: request.reasoningEffort,
      ...request.system === undefined ? {} : { system: request.system },
      messages, tools: request.tools,
      ...request.toolHistory === undefined ? {} : { toolHistory: request.toolHistory },
      controls: request.controls, attachmentVersions: request.attachmentVersions, parentReceipt: request.parentReceipt },
  })
}

/** Parse, detach and independently recompute identity before any journal/cache access. */
export function validateRequest(value: unknown, binding: WebBinding): WebRequest {
  const item = object(cloneJson(value), 'request')
  keys(item, ['protocolVersion', 'installationId', 'provider', 'profileId', 'accountBinding',
    'clientLeaseId', 'deliveryAttemptId', 'idempotencyKey', 'sessionId', 'purpose', 'model', 'reasoningEffort',
    'system', 'messages', 'tools', 'toolHistory', 'controls', 'attachmentVersions', 'parentReceipt'], 'request')
  const received = validateBinding(item)
  if (canonical(received) !== canonical(binding)) invalid('Bridge installation/profile/account binding changed', 'WEB_BINDING_MISMATCH')
  if (item['model'] !== WEB_MODEL || item['reasoningEffort'] !== WEB_EFFORT) invalid('Web v1 accepts only gpt-6-pro-web with pro effort', 'WEB_UNSUPPORTED_MODEL')
  const scope = { ...received, sessionId: string(item['sessionId'], 'sessionId'), purpose: purpose(item['purpose']) }
  const messages = array(item['messages'], 'messages').map(value => message(value, scope))
  if (messages.length === 0) invalid('Web requests require input messages')
  if (scope.purpose === 'normal' && messages.some(item => item.id === undefined)) invalid('Normal Web requests require durable message IDs', 'WEB_IDENTITY_REQUIRED')
  if (scope.purpose === 'compaction' && (!messages.some(item => item.id !== undefined)
    || messages.some((item, index) => item.id === undefined && (index !== messages.length - 1 || item.role !== 'user')))) {
    invalid('Compaction requires source IDs; only its final user instruction may omit identity', 'WEB_IDENTITY_REQUIRED')
  }
  const ids = messages.flatMap(message => message.id === undefined ? [] : [message.id])
  if (new Set(ids).size !== ids.length) invalid('Message IDs must be unique within an input')
  const controls = object(item['controls'], 'controls')
  if (Object.keys(controls).length !== 0) invalid('Website-enforced generation controls are not implemented; route capped auxiliary calls elsewhere', 'WEB_UNSUPPORTED_CONTROL')
  const attachmentVersions = array(item['attachmentVersions'], 'attachmentVersions')
  if (attachmentVersions.length !== 0) invalid('Web attachment transport is not implemented', 'WEB_UNSUPPORTED_CONTENT')
  const result: WebRequest = {
    ...scope, clientLeaseId: string(item['clientLeaseId'], 'clientLeaseId'),
    deliveryAttemptId: string(item['deliveryAttemptId'], 'deliveryAttemptId'),
    idempotencyKey: hash(item['idempotencyKey'], 'idempotencyKey'),
    model: WEB_MODEL, reasoningEffort: WEB_EFFORT, messages, tools: tools(item['tools']),
    controls: {}, attachmentVersions: [], parentReceipt: item['parentReceipt'] === null ? null : validateReceipt(item['parentReceipt']),
  }
  if (item['system'] !== undefined) {
    if (messages[0]?.role === 'system' || messages[0]?.role === 'developer') invalid('A leading instruction message takes precedence over system')
    result.system = string(item['system'], 'system', WEB_MAX_JSON_BYTES)
  }
  if (item['toolHistory'] !== undefined) result.toolHistory = toolHistory(item['toolHistory'])
  if (messages.some(message => message.content.some(block => block.type === 'tool-addition' || block.type === 'tool-removal')) && result.toolHistory === undefined) {
    invalid('Tool update blocks require their historical declarations', 'WEB_UNSUPPORTED_SCHEMA')
  }
  const derived = messages.findLast(item => item.role === 'assistant')?.source?.replayState.response ?? null
  if (canonical(derived) !== canonical(result.parentReceipt)) invalid('parentReceipt does not match the hashed assistant history', 'WEB_INVALID_RECEIPT')
  if (result.parentReceipt !== null && !receiptMatches(result.parentReceipt, scope)) invalid('Foreign parent receipt', 'WEB_INVALID_RECEIPT')
  validators(result)
  if (requestHash(result) !== result.idempotencyKey) invalid('Request hash does not match its normalized body', 'WEB_IDEMPOTENCY_CONFLICT')
  return result
}

/** Validate the whole page envelope before its first tool block can be exposed. */
export function validatePageResponse(value: unknown, request: WebRequest, turnId: string): WebOutputBlock[] {
  const item = object(cloneJson(value), 'page response')
  keys(item, ['version', 'complete', 'blocks'], 'page response')
  if (item['version'] !== 1 || item['complete'] !== true) invalid('The page has not supplied a complete versioned response', 'WEB_INVALID_RESPONSE')
  const checks = validators(request)
  const ids = new Set<string>()
  const blocks = array(item['blocks'], 'response.blocks', 256).map(value => {
    const block = inputBlock(value)
    if (block.type === 'text') return block
    if (block.type !== 'tool-call') invalid('The page may return text or admitted tool calls only', 'WEB_INVALID_RESPONSE')
    if (request.purpose !== 'normal') invalid('Auxiliary requests cannot execute tools', 'WEB_INVALID_RESPONSE')
    if (ids.has(block.id)) invalid('Duplicate call ID in one response', 'WEB_INVALID_RESPONSE')
    ids.add(block.id)
    const validate = checks.get(block.name)
    if (!validate) invalid('The response requested an undeclared tool', 'WEB_INVALID_RESPONSE')
    let argumentsValue: unknown
    try { argumentsValue = JSON.parse(block.arguments) }
    catch { invalid('Tool arguments are not valid JSON', 'WEB_INVALID_RESPONSE') }
    object(argumentsValue, 'tool arguments')
    canonical(argumentsValue)
    if (!validate(argumentsValue)) invalid(`Arguments do not match the schema for ${block.name}`, 'WEB_INVALID_RESPONSE')
    return { ...block, id: `${turnId}:${string(block.id, 'page call ID', 128)}` }
  })
  if (!blocks.some(block => block.type === 'tool-call' || block.text.length > 0)) invalid('An empty page response is not a completed answer', 'WEB_INVALID_RESPONSE')
  return blocks
}

export function createResponse(request: WebRequest, turnId: string, generationId: string, blocks: WebOutputBlock[]): WebResponse {
  const response: WebResponse = {
    protocolVersion: 1, turnId, blocks: cloneJson(blocks),
    finishReason: blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop',
    receipt: {
      kind: 'chatgpt-web-receipt', version: 1, installationId: request.installationId,
      provider: request.provider, profileId: request.profileId, accountBinding: request.accountBinding,
      sessionId: request.sessionId, purpose: request.purpose, model: WEB_MODEL,
      generationId, turnId, requestHash: request.idempotencyKey, responseDigest: digest(blocks),
    },
  }
  validateResponseBudget(response)
  // Normal observation and read-only recovery both pass here before the engine
  // commits completed. A persisted response must survive the exact validator
  // used when the journal is reopened, including its receipt and namespaced IDs.
  return validateResponse(response, request)
}

/**
 * Bound the complete response and its actual transport/control envelopes, not
 * merely the page's blocks. These checks precede any completed journal commit.
 */
function validateResponseBudget(response: WebResponse): void {
  try {
    const payload = canonical(response)
    const finish = canonical({ turnId: response.turnId, reason: response.finishReason,
      responseDigest: response.receipt.responseDigest, state: 'completed' })
    const stream = `event: response\ndata: ${payload}\n\nevent: finish\ndata: ${finish}\n\n`
    if (Buffer.byteLength(stream, 'utf8') > WEB_MAX_JSON_BYTES) throw new Error('SSE framing exceeds the response budget')

    // A different admitted participant may claim the first tool delivery later.
    // Reserve the largest legal identifiers, including JSON escaping, rather
    // than assuming the currently admitting client's short lease will own it.
    const largestIdentifier = '\u0000'.repeat(MAX_ID_CODE_UNITS)
    const inspected: TurnInspection = {
      turnId: response.turnId, sessionId: response.receipt.sessionId, state: 'completed',
      requestHash: response.receipt.requestHash, generationId: response.receipt.generationId,
      discarded: false, deliveryState: response.finishReason === 'tool-calls' ? 'delivery-intent' : 'unclaimed',
      ...response.finishReason === 'tool-calls' ? {
        deliveryOwner: { clientLeaseId: largestIdentifier, deliveryAttemptId: largestIdentifier },
      } : {},
      response,
    }
    canonical(inspected)
  } catch (cause) {
    throw new WebBridgeError('WEB_RESPONSE_LIMIT', 'The completed response does not fit the bridge response and inspection limits.', 502, { cause })
  }
}

/** A receipt is evidence of a response, never evidence that a tool succeeded. */
export function validateContinuation(request: WebRequest, parentRequest: WebRequest, parentResponse: WebResponse): boolean {
  const receipt = request.parentReceipt
  const assistantIndex = request.messages.findLastIndex(message => message.role === 'assistant')
  const assistant = request.messages[assistantIndex]
  if (!receipt || canonical(receipt) !== canonical(parentResponse.receipt) || !assistant
    || canonical(assistant.content) !== canonical(parentResponse.blocks)) invalid('Parent receipt/content does not match the bridge journal', 'WEB_INVALID_CONTINUATION')
  const pending = new Set(parentResponse.blocks.flatMap(block => block.type === 'tool-call' ? [block.id] : []))
  const seen = new Set<string>()
  for (const message of request.messages.slice(assistantIndex + 1)) {
    if (message.role === 'tool') {
      if (!message.toolCallId || !pending.has(message.toolCallId) || seen.has(message.toolCallId)) invalid('Unexpected or duplicate tool result', 'WEB_INVALID_CONTINUATION')
      seen.add(message.toolCallId)
    } else if (pending.size !== seen.size && message.role !== 'developer') {
      invalid('A tool response requires its complete result set before continuation', 'WEB_INVALID_CONTINUATION')
    }
  }
  if (pending.size !== seen.size) invalid('Missing tool results; inspect the previous delivery instead of replaying tools', 'WEB_INVALID_CONTINUATION')
  return assistantIndex === parentRequest.messages.length
    && canonical(request.messages.slice(0, assistantIndex)) === canonical(parentRequest.messages)
    && request.system === parentRequest.system && canonical(request.tools) === canonical(parentRequest.tools)
    && canonical(request.toolHistory ?? null) === canonical(parentRequest.toolHistory ?? null)
    && canonical(request.controls) === canonical(parentRequest.controls)
}

/** Client-side defense: the authenticated server still must satisfy its wire contract. */
export function validateResponse(value: unknown, request: WebRequest): WebResponse {
  const item = object(cloneJson(value), 'response')
  keys(item, ['protocolVersion', 'turnId', 'blocks', 'finishReason', 'receipt'], 'response')
  const receipt = validateReceipt(item['receipt'])
  if (item['protocolVersion'] !== 1 || !receiptMatches(receipt, request)
    || receipt.requestHash !== request.idempotencyKey || receipt.turnId !== item['turnId']) invalid('Response scope does not match the request', 'WEB_INVALID_RESPONSE')
  const blocks = array(item['blocks'], 'response.blocks', 256).map(inputBlock)
  if (blocks.some(block => block.type !== 'text' && block.type !== 'tool-call')) invalid('Unsupported response content', 'WEB_INVALID_RESPONSE')
  const output = blocks as WebOutputBlock[]
  const shortBlocks = output.map(block => {
    if (block.type === 'text') return block
    const prefix = `${receipt.turnId}:`
    if (!block.id.startsWith(prefix)) invalid('Call ID is outside this response namespace', 'WEB_INVALID_RESPONSE')
    return { ...block, id: block.id.slice(prefix.length) }
  })
  validatePageResponse({ version: 1, complete: true, blocks: shortBlocks }, request, receipt.turnId)
  const reason = output.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop'
  if (item['finishReason'] !== reason || receipt.responseDigest !== digest(output)) invalid('Response digest or finish reason is inconsistent', 'WEB_INVALID_RESPONSE')
  return { protocolVersion: 1, turnId: receipt.turnId, blocks: output, finishReason: reason, receipt }
}
