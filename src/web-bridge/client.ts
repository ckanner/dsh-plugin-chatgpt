/** Finite SSE client. The host still owns tools, checkpoints, retries and history. */
import { randomUUID } from 'node:crypto'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  WebBridgeError, type BridgeHealth, type ClientLease, type WebBinding, type WebRequest, type WebResponse,
} from './contracts.ts'
import { canonical, validateBinding, validateResponse, WEB_MAX_JSON_BYTES } from './protocol.ts'
import { captureWebRequest, prepareWebRequest, type CapturedWebRequest, type WebGenerateOptions } from './request.ts'

export interface WebBridgeClientOptions {
  url: string
  token: string
  expectedBinding?: WebBinding
  /** A host adapter supplies its public LlmError constructor without a runtime peer dependency here. */
  errorFactory?: (message: string, code: string, status: number) => Error
}

function error(message: string): never { throw new WebBridgeError('WEB_PROTOCOL_ERROR', message, 502) }

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) error('Invalid bridge JSON response')
  return value as Record<string, unknown>
}

async function bodyText(response: Response): Promise<string> {
  if (!response.body) error('Bridge returned no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = ''
  let bytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > WEB_MAX_JSON_BYTES) error('Bridge response exceeds the byte limit')
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

function json(text: string): unknown {
  try { const value: unknown = JSON.parse(text); canonical(value); return value }
  catch (cause) {
    if (cause instanceof WebBridgeError) throw cause
    error('Bridge returned invalid JSON')
  }
}

function failure(value: unknown, status: number): WebBridgeError {
  const item = record(record(value)['error'])
  if (typeof item['code'] !== 'string' || !/^WEB_[A-Z_]+$/.test(item['code']) || typeof item['message'] !== 'string') error('Invalid bridge error')
  return new WebBridgeError(item['code'], item['message'], status)
}

function lease(value: unknown): ClientLease {
  const item = record(value)
  if (typeof item['clientLeaseId'] !== 'string' || !item['clientLeaseId'] || typeof item['expiresAt'] !== 'number' || !Number.isFinite(item['expiresAt'])) error('Invalid client lease')
  return { clientLeaseId: item['clientLeaseId'], expiresAt: item['expiresAt'] }
}

function readSse(text: string, request: WebRequest): WebResponse {
  const normalized = text.replaceAll('\r\n', '\n')
  if (!normalized.endsWith('\n\n')) error('Bridge stream ended before a complete terminal event')
  let response: WebResponse | undefined
  let finished = false
  for (const frame of normalized.split('\n\n').filter(Boolean)) {
    let event: string | undefined
    const data: string[] = []
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue
      if (line.startsWith('event:') && event === undefined) event = line.slice(6).trimStart()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
      else error('Unexpected SSE field')
    }
    if (finished) error('Bridge emitted data after finish')
    const value = json(data.join('\n'))
    if (event === 'error') throw failure(value, 409)
    if (event === 'response') {
      if (response) error('Duplicate bridge response')
      response = validateResponse(value, request)
    } else if (event === 'finish') {
      const item = record(value)
      if (!response || item['state'] !== 'completed' || item['turnId'] !== response.turnId
        || item['reason'] !== response.finishReason || item['responseDigest'] !== response.receipt.responseDigest) error('Inconsistent bridge finish event')
      finished = true
    } else if (event === 'turn' || event === 'progress') {
      // Transport observations deliberately do not become model text, reasoning or usage.
      if (response) error('Progress appeared after the completed response')
    } else error('Unsupported SSE event')
  }
  if (!response || !finished) error('Bridge stream has no complete response and finish')
  return response
}

export class WebBridgeClient {
  private readonly baseUrl: string
  private readonly options: WebBridgeClientOptions
  private readonly shutdown = new AbortController()
  private connecting: Promise<BridgeHealth> | undefined
  private healthValue: BridgeHealth | undefined
  private leaseValue: ClientLease | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private leaseFailure: Error | undefined
  private disposed = false
  private heartbeatPending: Promise<void> | undefined
  private disposePromise: Promise<void> | undefined

  constructor(options: WebBridgeClientOptions) {
    const url = new URL(options.url)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new WebBridgeError('WEB_INVALID_ENDPOINT', 'Web bridge must use an explicit loopback http://127.0.0.1:port endpoint', 400)
    }
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.token)) throw new WebBridgeError('WEB_INVALID_TOKEN', 'A private launch token is required', 400)
    this.baseUrl = url.origin
    this.options = { ...options, ...options.expectedBinding === undefined ? {} : { expectedBinding: cloneBinding(options.expectedBinding) } }
  }

  private async fetch(path: string, method: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.options.token}` }
    if (this.leaseValue) headers['X-Web-Client-Lease'] = this.leaseValue.clientLeaseId
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (path === '/v1/turns') headers['accept'] = 'text/event-stream'
    const response = await fetch(`${this.baseUrl}${path}`, {
      method, headers, redirect: 'error',
      ...body === undefined ? {} : { body: canonical(body) },
      signal: signal ?? AbortSignal.timeout(5000),
    })
    if (!response.ok) throw failure(json(await bodyText(response)), response.status)
    return response
  }

  private async json(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetch(path, method, body, signal)
    if (!(response.headers.get('content-type') ?? '').startsWith('application/json')) error('Expected bridge JSON')
    return json(await bodyText(response))
  }

  connect(): Promise<BridgeHealth> {
    if (this.disposed) return Promise.reject(new WebBridgeError('WEB_CLIENT_CLOSED', 'The Web bridge client was disposed', 409))
    if (this.leaseFailure) return Promise.reject(this.leaseFailure)
    if (!this.connecting) {
      const pending = this.establish()
      this.connecting = pending
      void pending.catch(() => { if (this.connecting === pending) this.connecting = undefined })
    }
    return this.connecting
  }

  private async establish(): Promise<BridgeHealth> {
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(5000)])
    const value = record(await this.json('/health', 'GET', undefined, signal))
    signal.throwIfAborted()
    const binding = validateBinding(value)
    if (typeof value['instanceId'] !== 'string' || !value['instanceId'] || value['transport'] !== 'experimental') error('Invalid bridge health handshake')
    if (this.options.expectedBinding && canonical(binding) !== canonical(this.options.expectedBinding)) {
      throw new WebBridgeError('WEB_BINDING_MISMATCH', 'Bridge binding differs from the configured installation', 409)
    }
    const registered = lease(await this.json('/v1/clients', 'POST', {}, signal))
    this.leaseValue = registered
    this.healthValue = { ...binding, instanceId: value['instanceId'], transport: 'experimental' }
    if (this.disposed) {
      await this.release()
      throw new WebBridgeError('WEB_CLIENT_CLOSED', 'The Web bridge client was disposed during setup', 409)
    }
    const interval = Math.max(10, Math.min(15_000, Math.floor((registered.expiresAt - Date.now()) / 3)))
    this.heartbeatTimer = setInterval(() => { void this.heartbeat() }, interval)
    this.heartbeatTimer.unref()
    return this.healthValue
  }

  private heartbeat(): Promise<void> {
    if (this.heartbeatPending) return this.heartbeatPending
    if (this.disposed || !this.leaseValue || this.leaseFailure) return Promise.resolve()
    const clientId = this.leaseValue.clientLeaseId
    const pending = (async () => {
      try {
        const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(5000)])
        const renewed = lease(await this.json(`/v1/clients/${encodeURIComponent(clientId)}/heartbeat`, 'POST', {}, signal))
        if (this.disposed) return
        if (renewed.clientLeaseId !== clientId) error('Heartbeat changed lease ownership')
        this.leaseValue = renewed
      } catch (cause) {
        if (this.disposed) return
        this.leaseFailure = cause instanceof Error ? cause : new WebBridgeError('WEB_LEASE_EXPIRED', 'Web client lease could not be renewed', 409)
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
        this.shutdown.abort(this.leaseFailure)
      }
    })()
    this.heartbeatPending = pending
    void pending.then(() => { if (this.heartbeatPending === pending) this.heartbeatPending = undefined })
    return pending
  }

  /** The ordinary method (not an async generator body) captures mutable caller input now. */
  stream(options: WebGenerateOptions): AsyncIterable<StreamChunk> {
    let captured: CapturedWebRequest
    try { captured = captureWebRequest(options) }
    catch (cause) { return this.failed(cause) }
    return this.generate(captured)
  }

  private async *failed(cause: unknown): AsyncGenerator<StreamChunk> { throw this.hostError(cause) }

  private hostError(cause: unknown): Error {
    if (cause instanceof WebBridgeError) return this.options.errorFactory?.(cause.message, cause.code, cause.status) ?? cause
    if (cause instanceof Error && cause.name === 'AbortError') return cause
    return this.options.errorFactory?.('Web bridge connection failed; inspect the admitted turn before retrying', 'WEB_CONNECTION_LOST', 502)
      ?? new WebBridgeError('WEB_CONNECTION_LOST', 'Web bridge connection failed; inspect the admitted turn before retrying', 502, { cause })
  }

  private async *generate(snapshot: CapturedWebRequest): AsyncGenerator<StreamChunk> {
    let request: WebRequest | undefined
    const signal = snapshot.signal ? AbortSignal.any([snapshot.signal, this.shutdown.signal]) : this.shutdown.signal
    try {
      signal.throwIfAborted()
      const health = await this.connect()
      signal.throwIfAborted()
      request = prepareWebRequest(snapshot, validateBinding(health), this.leaseValue!.clientLeaseId, randomUUID())
      const http = await this.fetch('/v1/turns', 'POST', request, signal)
      if (!(http.headers.get('content-type') ?? '').startsWith('text/event-stream')) error('Expected a finite SSE bridge response')
      const response = readSse(await bodyText(http), request)
      signal.throwIfAborted()
      for (const [index, block] of response.blocks.entries()) {
        signal.throwIfAborted()
        yield { type: 'block-start', index, blockType: block.type }
        if (block.type === 'text') {
          signal.throwIfAborted()
          yield { type: 'text-delta', index, text: block.text }
          signal.throwIfAborted()
          yield { type: 'block-end', index, block }
        } else {
          const id = block.id as Extract<StreamChunk, { type: 'tool-call-delta' }>['id']
          signal.throwIfAborted()
          yield { type: 'tool-call-delta', index, id, name: block.name, argumentsDelta: block.arguments }
          signal.throwIfAborted()
          yield { type: 'block-end', index, block: { ...block, id } }
        }
      }
      signal.throwIfAborted()
      yield { type: 'finish', reason: { kind: response.finishReason }, replayState: { response: response.receipt } }
    } catch (cause) {
      if (signal.aborted && request && this.leaseValue && !this.disposed) {
        await this.json(`/v1/turns/turn-${request.idempotencyKey.slice(7)}/cancel`, 'POST', { sessionId: request.sessionId }).catch(() => {})
      }
      throw this.hostError(cause)
    }
  }

  private async release(): Promise<void> {
    if (!this.leaseValue) return
    const clientId = this.leaseValue.clientLeaseId
    try {
      const response = await this.fetch(`/v1/clients/${encodeURIComponent(clientId)}`, 'DELETE', undefined)
      await response.body?.cancel()
    }
    finally { this.leaseValue = undefined }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.shutdown.abort(new DOMException('Web bridge client disposed', 'AbortError'))
    const pending = [this.connecting, this.heartbeatPending].filter((value): value is Promise<BridgeHealth> | Promise<void> => value !== undefined)
    this.disposePromise = (async () => {
      await Promise.allSettled(pending)
      await this.release()
    })()
    return this.disposePromise
  }
}

function cloneBinding(binding: WebBinding): WebBinding { return validateBinding(JSON.parse(canonical(binding))) }
