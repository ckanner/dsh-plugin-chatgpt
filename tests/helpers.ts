/**
 * Test doubles: a token endpoint, an unsigned ID token, and a body reader.
 *
 * The ID token is deliberately unsigned. Signature verification is a separate
 * documented step this plugin does not perform, so the checks under test are
 * claim checks — and signing a token would only test the fixture.
 */

import { createServer, type Server } from 'node:http'

/** One request the token endpoint received. */
export interface RecordedRequest {
  path: string
  contentType: string
  params: URLSearchParams
}

/** A live token endpoint and the requests it saw. */
export interface TokenServer {
  url: string
  requests: RecordedRequest[]
  close(): Promise<void>
}

/** Build an unsigned JWT whose payload carries `claims`. */
export function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`
}

/** ID-token claims addressing one issued client id and nonce. */
export function idTokenClaims(options: {
  clientId: string
  nonce: string
  subject?: string
  email?: string
  plan?: string
  expiresInSeconds?: number
  issuer?: string
}): Record<string, unknown> {
  return {
    iss: options.issuer ?? 'https://auth.openai.com',
    aud: options.clientId,
    sub: options.subject ?? 'subject-1',
    nonce: options.nonce,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (options.expiresInSeconds ?? 3600),
    'https://api.openai.com/profile': { email: options.email ?? 'someone@example.com' },
    'https://api.openai.com/auth': { chatgpt_plan_type: options.plan ?? 'plus' },
  }
}

/** A token response the mock endpoint returns. */
export interface TokenReply {
  status?: number
  body?: unknown
  /** Read the request and answer dynamically (nonce must match the attempt). */
  reply?: (params: URLSearchParams) => { status?: number, body: unknown }
}

/**
 * Start a token endpoint answering every request with `reply`.
 *
 * @param reply - the response, or a function of the received form fields.
 * @returns the endpoint, its recorded requests, and a closer.
 */
export async function startTokenServer(reply: TokenReply): Promise<TokenServer> {
  const requests: RecordedRequest[] = []
  const server: Server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      const params = new URLSearchParams(body)
      requests.push({
        path: request.url ?? '/',
        contentType: String(request.headers['content-type'] ?? ''),
        params,
      })
      const answer = reply.reply?.(params) ?? { status: reply.status, body: reply.body }
      response.writeHead(answer.status ?? 200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(answer.body))
    })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('token server bound no port')
  return {
    url: `http://127.0.0.1:${address.port}/token`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => { error === undefined ? resolve() : reject(error) })
      server.closeAllConnections()
    }),
  }
}

/** Resolve once `check` passes, or reject after `timeoutMs`. */
export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
