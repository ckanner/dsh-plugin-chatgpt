/** Authenticated, loopback-only HTTP transport for the experimental Web bridge. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  WebBridgeError, type BridgeHealth, type ClientLease, type TurnAccess, type WebBridgeEngine,
} from './contracts.ts'
import { validateRequest, WEB_MAX_JSON_BYTES, WEB_MAX_JSON_DEPTH, WEB_MAX_REQUEST_BYTES } from './protocol.ts'

export const WEB_HTTP_BODY_TIMEOUT_MS = 10_000
export const WEB_HTTP_MAX_HEADER_BYTES = 16_384
const DEFAULT_LEASE_TTL_MS = 60_000
const MAX_LEASE_TTL_MS = 86_400_000
const MAX_CLIENTS = 1_024

export interface WebBridgeServerOptions {
  engine: WebBridgeEngine
  token?: string
  leaseTtlMs?: number
  now?: () => number
  transport?: BridgeHealth['transport']
}

export interface WebBridgeServer {
  url: string
  token: string
  health: BridgeHealth
  activity(): { clients: number, activeTurns: number }
  close(): Promise<void>
}

interface LeaseEntry extends ClientLease {
  timer?: ReturnType<typeof setTimeout>
}

function failure(code: string, message: string, status = 400): WebBridgeError {
  return new WebBridgeError(code, message, status)
}

/** Reject ambiguous credentials and authorities before routing any request. */
function authenticate(request: IncomingMessage, authority: string, token: string): void {
  const critical = new Set(['host', 'authorization', 'origin', 'x-web-client-lease', 'content-type', 'content-encoding'])
  const seen = new Set<string>()
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!.toLowerCase()
    if (!critical.has(name)) continue
    if (seen.has(name)) throw failure('WEB_HTTP_HEADERS', 'Duplicate security-sensitive header')
    seen.add(name)
  }
  if (request.headers.host !== authority) {
    throw failure('WEB_HTTP_HOST', 'The exact loopback Host is required', 403)
  }
  if (request.headers.origin !== undefined) {
    throw failure('WEB_HTTP_ORIGIN', 'Browser origins are not allowed', 403)
  }
  const supplied = request.headers.authorization
  const expected = `Bearer ${token}`
  if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected)
    || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    throw failure('WEB_HTTP_AUTH', 'A valid bridge bearer token is required', 401)
  }
}

/** Scan nesting before JSON.parse or recursive protocol validation touches untrusted data. */
function checkJsonDepth(text: string): void {
  let depth = 0
  let quoted = false
  let escaped = false
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    else if (character === '[' || character === '{') {
      if (++depth > WEB_MAX_JSON_DEPTH) throw failure('WEB_HTTP_DEPTH', 'JSON nesting limit exceeded', 413)
    } else if (character === ']' || character === '}') depth--
  }
}

async function readJson(request: IncomingMessage, maxBytes = WEB_MAX_JSON_BYTES): Promise<unknown> {
  const contentType = request.headers['content-type']
  if (typeof contentType !== 'string'
    || !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(contentType.trim())
    || request.headers['content-encoding'] !== undefined) {
    throw failure('WEB_HTTP_CONTENT_TYPE', 'An unencoded application/json body is required', 415)
  }
  const declared = request.headers['content-length']
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw failure('WEB_HTTP_BODY_LIMIT', 'JSON body size limit exceeded', 413)
  }
  const body = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const cleanup = (): void => {
      clearTimeout(timer)
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('aborted', onAborted)
      request.off('error', onError)
    }
    const stop = (error: Error): void => { cleanup(); request.pause(); reject(error) }
    const onData = (chunk: Buffer): void => {
      size += chunk.byteLength
      if (size > maxBytes) {
        stop(failure('WEB_HTTP_BODY_LIMIT', 'JSON body size limit exceeded', 413))
      } else chunks.push(chunk)
    }
    const onEnd = (): void => { cleanup(); resolve(Buffer.concat(chunks, size)) }
    const onAborted = (): void => { stop(failure('WEB_HTTP_ABORTED', 'Request body was interrupted', 400)) }
    const onError = (): void => { stop(failure('WEB_HTTP_ABORTED', 'Request body could not be read', 400)) }
    const timer = setTimeout(() => {
      stop(failure('WEB_HTTP_TIMEOUT', 'Request body deadline exceeded', 408))
    }, WEB_HTTP_BODY_TIMEOUT_MS)
    timer.unref()
    request.on('data', onData)
    request.once('end', onEnd)
    request.once('aborted', onAborted)
    request.once('error', onError)
  })
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(body) } catch {
    throw failure('WEB_HTTP_JSON', 'Request body must contain valid UTF-8 JSON')
  }
  checkJsonDepth(text)
  try { return JSON.parse(text) as unknown } catch {
    throw failure('WEB_HTTP_JSON', 'Request body must contain valid JSON')
  }
}

function objectBody(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) {
    throw failure('WEB_HTTP_BODY', 'Request body has an invalid shape')
  }
  return value as Record<string, unknown>
}

function sessionIdentity(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw failure('WEB_HTTP_SESSION', 'A valid sessionId is required')
  }
  return value
}

function pathIdentity(value: string): string {
  let decoded: string
  try { decoded = decodeURIComponent(value) } catch { throw failure('WEB_HTTP_PATH', 'Invalid route identity') }
  if (decoded.length === 0 || decoded.length > 256 || /[\/\\\u0000-\u001f\u007f]/.test(decoded)) {
    throw failure('WEB_HTTP_PATH', 'Invalid route identity')
  }
  return decoded
}

function jsonText(value: unknown): string {
  const text = JSON.stringify(value)
  if (typeof text !== 'string' || Buffer.byteLength(text) > WEB_MAX_JSON_BYTES) {
    throw failure('WEB_HTTP_RESPONSE_LIMIT', 'Bridge response size limit exceeded', 502)
  }
  checkJsonDepth(text)
  return text
}

function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  const text = jsonText(value)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(text)
}

/** This server is started only through explicit programmatic transport injection. */
export async function startWebBridgeServer(options: WebBridgeServerOptions): Promise<WebBridgeServer> {
  const { engine } = options
  const token = options.token ?? randomBytes(32).toString('base64url')
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new TypeError('Bridge token must be a 32–256 character base64url secret')
  const ttl = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_LEASE_TTL_MS) throw new TypeError('Invalid client lease lifetime')
  const now = options.now ?? Date.now
  const clock = (): number => {
    const value = now()
    if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(value + ttl)) {
      throw failure('WEB_HTTP_CLOCK', 'Bridge clock is unavailable', 503)
    }
    return value
  }
  clock()
  const health: BridgeHealth = Object.freeze({ ...engine.binding, instanceId: engine.instanceId, transport: options.transport ?? 'experimental' })
  const leases = new Map<string, LeaseEntry>()
  const releases = new Set<Promise<void>>()
  const releaseErrors: unknown[] = []
  let closing = false
  let closePromise: Promise<void> | undefined
  let authority = ''
  let activeTurns = 0
  const duringTurn = async <T>(action: () => Promise<T>): Promise<T> => {
    activeTurns++
    try { return await action() } finally { activeTurns-- }
  }

  const revoke = (entry: LeaseEntry): Promise<void> => {
    if (leases.get(entry.clientLeaseId) !== entry) return Promise.resolve()
    leases.delete(entry.clientLeaseId)
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    const pending = Promise.resolve().then(() => engine.releaseClient(entry.clientLeaseId))
    releases.add(pending)
    void pending.then(() => { releases.delete(pending) }, error => {
      releases.delete(pending)
      releaseErrors.push(error)
    })
    return pending
  }
  const schedule = (entry: LeaseEntry): void => {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      if (closing || leases.get(entry.clientLeaseId) !== entry) return
      try {
        if (clock() >= entry.expiresAt) void revoke(entry)
        else schedule(entry)
      } catch {
        void revoke(entry)
      }
    }, Math.max(1, entry.expiresAt - clock()))
    entry.timer.unref()
  }
  const assertLease = (id: unknown): LeaseEntry => {
    if (closing) throw failure('WEB_HTTP_CLOSING', 'Bridge server is closing', 503)
    if (typeof id !== 'string') throw failure('WEB_LEASE_REQUIRED', 'A private client lease is required', 403)
    const entry = leases.get(id)
    if (entry === undefined) throw failure('WEB_LEASE_INVALID', 'Client lease is invalid or expired', 403)
    if (clock() >= entry.expiresAt) {
      void revoke(entry)
      throw failure('WEB_LEASE_EXPIRED', 'Client lease expired', 403)
    }
    return entry
  }
  const wireLease = (entry: LeaseEntry): ClientLease => ({ clientLeaseId: entry.clientLeaseId, expiresAt: entry.expiresAt })
  const liveDelivery = (response: ServerResponse, id: string): void => {
    assertLease(id)
    if (response.destroyed || response.writableEnded) throw failure('WEB_HTTP_DISCONNECTED', 'Delivery connection is closed', 409)
  }
  const sendError = (response: ServerResponse, error: unknown): void => {
    if (response.destroyed || response.writableEnded) return
    const known = error instanceof WebBridgeError
    const code = known && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'WEB_INTERNAL_ERROR'
    const message = known ? error.message.replaceAll(token, '[redacted]').slice(0, 1_024) : 'Bridge request failed'
    const status = known && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500
    const identity = known ? error.requestId ?? ('turnId' in error && typeof error.turnId === 'string' ? error.turnId : undefined) : undefined
    const requestId = identity !== undefined && /^turn-[a-f0-9]{64}$/.test(identity) ? identity : undefined
    const payload = { error: { code, message, ...requestId === undefined ? {} : { requestId } } }
    if (response.headersSent) response.end(`event: error\ndata: ${jsonText(payload)}\n\n`)
    else jsonResponse(response, status, payload)
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.shouldKeepAlive = false
    response.setHeader('connection', 'close')
    response.setHeader('cache-control', 'no-store')
    response.setHeader('x-content-type-options', 'nosniff')
    authenticate(request, authority, token)
    if (closing) throw failure('WEB_HTTP_CLOSING', 'Bridge server is closing', 503)
    const rawUrl = request.url ?? ''
    if (!rawUrl.startsWith('/') || rawUrl.startsWith('//') || rawUrl.includes('#') || rawUrl.includes('\\')) {
      throw failure('WEB_HTTP_PATH', 'An origin-form route is required')
    }
    const url = new URL(rawUrl, `http://${authority}`)
    const method = request.method
    if ((method === 'GET' || method === 'DELETE')
      && (request.headers['transfer-encoding'] !== undefined
        || request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) {
      throw failure('WEB_HTTP_BODY', 'This route does not accept a request body')
    }
    if (method === 'GET' && url.pathname === '/health' && url.search === '') {
      jsonResponse(response, 200, health)
      return
    }
    if (method === 'POST' && url.pathname === '/v1/clients' && url.search === '') {
      objectBody(await readJson(request), [])
      if (closing || response.destroyed) throw failure('WEB_HTTP_CLOSING', 'Client registration is unavailable', 503)
      for (const entry of leases.values()) if (clock() >= entry.expiresAt) void revoke(entry)
      if (leases.size >= MAX_CLIENTS) throw failure('WEB_LEASE_LIMIT', 'Too many active client leases', 429)
      const entry: LeaseEntry = { clientLeaseId: randomBytes(32).toString('base64url'), expiresAt: clock() + ttl }
      leases.set(entry.clientLeaseId, entry)
      schedule(entry)
      jsonResponse(response, 201, wireLease(entry))
      return
    }
    const lease = assertLease(request.headers['x-web-client-lease'])
    const clientMatch = /^\/v1\/clients\/([^/]+)(\/heartbeat)?$/.exec(url.pathname)
    if (clientMatch !== null && url.search === '') {
      if (pathIdentity(clientMatch[1]!) !== lease.clientLeaseId) throw failure('WEB_LEASE_OWNER', 'Client lease does not own this route', 403)
      if (method === 'POST' && clientMatch[2] === '/heartbeat') {
        objectBody(await readJson(request), [])
        assertLease(lease.clientLeaseId)
        lease.expiresAt = clock() + ttl
        schedule(lease)
        jsonResponse(response, 200, wireLease(lease))
        return
      }
      if (method === 'DELETE' && clientMatch[2] === undefined) {
        await revoke(lease)
        jsonResponse(response, 200, { released: true })
        return
      }
    }
    if (method === 'POST' && url.pathname === '/v1/turns' && url.search === '') {
      const raw = await readJson(request, WEB_MAX_REQUEST_BYTES)
      const envelope = validateRequest(raw, engine.binding)
      if (envelope.clientLeaseId !== lease.clientLeaseId) throw failure('WEB_LEASE_OWNER', 'Request lease does not match its authenticated client', 403)
      liveDelivery(response, lease.clientLeaseId)
      const result = await duringTurn(() => engine.execute(envelope, { authorizeDelivery: () => liveDelivery(response, lease.clientLeaseId) }))
      liveDelivery(response, lease.clientLeaseId)
      const payload = jsonText(result)
      const finish = jsonText({ turnId: result.turnId, reason: result.finishReason, responseDigest: result.receipt.responseDigest, state: 'completed' })
      const stream = `event: response\ndata: ${payload}\n\nevent: finish\ndata: ${finish}\n\n`
      if (Buffer.byteLength(stream) > WEB_MAX_JSON_BYTES) throw failure('WEB_HTTP_RESPONSE_LIMIT', 'Bridge response size limit exceeded', 502)
      liveDelivery(response, lease.clientLeaseId)
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(stream)
      return
    }
    const turnMatch = /^\/v1\/turns\/([^/]+)(?:\/(cancel|recover|discard))?$/.exec(url.pathname)
    if (turnMatch !== null) {
      const turnId = pathIdentity(turnMatch[1]!)
      const action = turnMatch[2]
      let sessionId: string
      if (method === 'GET' && action === undefined) {
        if (url.searchParams.size !== 1 || !url.searchParams.has('sessionId')) throw failure('WEB_HTTP_SESSION', 'Exactly one sessionId query parameter is required')
        sessionId = sessionIdentity(url.searchParams.get('sessionId'))
      } else if (method === 'POST' && action !== undefined && url.search === '') {
        sessionId = sessionIdentity(objectBody(await readJson(request), ['sessionId'])['sessionId'])
      } else throw failure('WEB_HTTP_ROUTE', 'Unknown bridge route', 404)
      liveDelivery(response, lease.clientLeaseId)
      const access: TurnAccess = { clientLeaseId: lease.clientLeaseId, sessionId }
      const result = await duringTurn(async () => action === undefined ? await engine.inspect(turnId, access)
        : action === 'cancel' ? await engine.cancel(turnId, access)
        : action === 'recover' ? await engine.recover(turnId, access) : await engine.discard(turnId, access))
      liveDelivery(response, lease.clientLeaseId)
      jsonResponse(response, 200, result)
      return
    }
    throw failure('WEB_HTTP_ROUTE', 'Unknown bridge route', 404)
  }

  const server = createServer({ maxHeaderSize: WEB_HTTP_MAX_HEADER_BYTES }, (request, response) => {
    // Socket failures already make delivery ineligible; they must not become uncaught events.
    request.on('error', () => {})
    response.on('error', () => {})
    void handle(request, response).catch(error => { sendError(response, error) })
  })
  // Header/body admission deadlines must not terminate a long, already admitted model request.
  server.headersTimeout = WEB_HTTP_BODY_TIMEOUT_MS
  server.requestTimeout = WEB_HTTP_BODY_TIMEOUT_MS
  server.timeout = 0
  // Do not silently truncate headers: an Origin or duplicate credential beyond a
  // count limit must still be checked. maxHeaderSize bounds the entire header block.
  server.maxHeadersCount = 0
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Bridge did not bind a loopback TCP port')
  authority = `127.0.0.1:${address.port}`
  return {
    url: `http://${authority}`,
    token,
    health,
    activity: () => ({ clients: leases.size, activeTurns }),
    close(): Promise<void> {
      closePromise ??= (async () => {
        closing = true
        const stopped = new Promise<void>((resolve, reject) => {
          server.close(error => { if (error !== undefined) reject(error); else resolve() })
          server.closeAllConnections()
        })
        for (const entry of leases.values()) void revoke(entry)
        await Promise.allSettled([...releases])
        let engineError: unknown
        try { await engine.close() } catch (error) { engineError = error }
        await stopped
        const failures = [...releaseErrors, ...engineError === undefined ? [] : [engineError]]
        if (failures.length > 0) throw new AggregateError(failures, 'Bridge shutdown failed')
      })()
      return closePromise
    },
  }
}
