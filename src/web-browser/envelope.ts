/** A plain-text website protocol; no UI prose is interpreted as a tool call. */
import { WebBridgeError, type PageTurn, type WebMessage } from '../web-bridge/contracts.ts'
import { attachmentIdentity } from '../web-bridge/attachments.ts'
import { canonical, validatePageResponse, WEB_MAX_JSON_BYTES, WEB_MAX_JSON_DEPTH, WEB_MAX_REQUEST_BYTES } from '../web-bridge/protocol.ts'
import { textDigest, type BrowserGeneration } from './ledger.ts'

function visibleMessage(message: WebMessage): unknown {
  return { ...(message.id === undefined ? {} : { id: message.id }), role: message.role, content: message.content,
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
    ...(message.isError === undefined ? {} : { isError: message.isError }) }
}

export function projectionSettingsDigest(turn: PageTurn): string {
  const r = turn.request
  return textDigest(canonical({ purpose: r.purpose, system: r.system ?? null, tools: r.tools, toolHistory: r.toolHistory ?? null, controls: r.controls }, WEB_MAX_REQUEST_BYTES))
}

export function renderPrompt(turn: PageTurn, maxInputBytes: number, generation?: BrowserGeneration): string {
  const { request } = turn
  let start = 0
  if (generation?.lastTurnId !== undefined) {
    const count = generation.projectedMessageCount
    if (request.parentReceipt?.turnId !== generation.lastTurnId || count === undefined || count >= request.messages.length
      || textDigest(canonical(request.messages.slice(0, count), WEB_MAX_REQUEST_BYTES)) !== generation.projectedMessagesDigest
      || projectionSettingsDigest(turn) !== generation.projectionSettingsDigest) {
      throw new WebBridgeError('WEB_BROWSER_HISTORY', 'The website generation is not an exact prefix of the current host request', 409)
    }
    start = count
  }
  const messages = request.messages.slice(start)
  const referenced = new Set(messages.flatMap(message => message.content.filter(block => block.type === 'image').map(block => block.attachmentVersion)))
  // Fresh generations contain current DSH inputs, never a bridge-made summary.
  // Continuations carry only the append, including host namespaced call IDs.
  const envelope = {
    protocol: 'dsh-chatgpt-web', version: 1, requestId: turn.turnId,
    projection: start === 0 ? 'full-current-history' : 'append-to-verified-history',
    instruction: 'Act as the model for the admitted request below. A full-current-history projection is authoritative. An append-to-verified-history projection adds to that same history; its opening assistant message confirms your previous response with the host namespaced call IDs and is not a second action. Follow the admitted system/developer instructions. Envelope metadata is transport information. Use only declared local tools, never ChatGPT apps, connectors, browser tools, or other hosted tools. Return exactly one JSON object and no Markdown or surrounding prose: {"version":1,"requestId":"' + turn.turnId + '","complete":true,"blocks":[{"type":"text","text":"answer"}]}. A local tool call is {"type":"tool-call","id":"unique-short-id","name":"declared-name","arguments":"JSON object encoded as a string"}. Do not execute tools yourself. A tool-call response is complete; the host will supply later results. Never invent tool results. Use text blocks for refusal, clarification, or a final answer. Image blocks name exact attached files through attachmentVersions. Do not claim a tool action happened until its actual tool result is present in admitted history.',
    request: { purpose: request.purpose, ...(request.system === undefined ? {} : { system: request.system }),
      messages: messages.map(visibleMessage), tools: request.tools,
      ...(request.toolHistory === undefined ? {} : { toolHistory: request.toolHistory }),
      attachmentVersions: request.attachmentVersions.filter(version => referenced.has(version.id)).map(attachmentIdentity) },
  }
  const prompt = canonical(envelope, WEB_MAX_REQUEST_BYTES)
  if (Buffer.byteLength(prompt, 'utf8') > maxInputBytes) {
    throw new WebBridgeError('WEB_INPUT_LIMIT', 'The complete website envelope exceeds the configured input admission budget', 413)
  }
  return prompt
}

export function parseResponse(text: string, turn: PageTurn): unknown {
  if (Buffer.byteLength(text, 'utf8') > WEB_MAX_JSON_BYTES) throw new WebBridgeError('WEB_INVALID_RESPONSE', 'The website response exceeds the supported response size', 502)
  let value: unknown
  try { value = strictJson(text) } catch { throw new WebBridgeError('WEB_INVALID_RESPONSE', 'The completed website response is not one exact, unambiguous JSON envelope', 502) }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new WebBridgeError('WEB_INVALID_RESPONSE', 'The completed website response is not an object', 502)
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => !['version', 'requestId', 'complete', 'blocks'].includes(key)) || raw['requestId'] !== turn.turnId) {
    throw new WebBridgeError('WEB_INVALID_RESPONSE', 'The website response does not identify this exact admitted request', 502)
  }
  const response = { version: raw['version'], complete: raw['complete'], blocks: raw['blocks'] }
  if (Array.isArray(raw['blocks'])) for (const block of raw['blocks']) {
    if (block !== null && typeof block === 'object' && block.type === 'tool-call' && typeof block.arguments === 'string') {
      try { strictJson(block.arguments) } catch { throw new WebBridgeError('WEB_INVALID_RESPONSE', 'Tool arguments are not unambiguous bounded JSON', 502) }
    }
  }
  // Validate without exposing the namespaced return value. The engine performs
  // its own final validation and supplies the single namespace exactly once.
  validatePageResponse(response, turn.request, turn.turnId)
  return response
}

/** Reject duplicate (including escaped) keys and excessive depth before parsing. */
function strictJson(text: string): unknown {
  const stack: Array<{ object: boolean, key: boolean, keys: Set<string> }> = []
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '"') {
      const start = index
      while (++index < text.length) { if (text[index] === '\\') index++; else if (text[index] === '"') break }
      const frame = stack.at(-1)
      if (frame?.object && frame.key) {
        const key = JSON.parse(text.slice(start, index + 1)) as string
        if (frame.keys.has(key)) throw new Error('duplicate key')
        frame.keys.add(key); frame.key = false
      }
    } else if (char === '{' || char === '[') {
      stack.push({ object: char === '{', key: char === '{', keys: new Set() })
      if (stack.length > WEB_MAX_JSON_DEPTH) throw new Error('JSON depth')
    } else if (char === '}' || char === ']') stack.pop()
    else if (char === ',') { const frame = stack.at(-1); if (frame?.object) frame.key = true }
  }
  return JSON.parse(text) as unknown
}
