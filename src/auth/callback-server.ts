/**
 * The loopback callback listener one authorization attempt owns.
 *
 * The browser's redirect has to land somewhere, and where it lands is part of
 * what the server verifies: the scheme, host, and path are fixed, only the port
 * may vary. So the exact port this listener actually bound is what the
 * authorization request must carry — which is why the URI is derived from the
 * bound address rather than from the requested one.
 *
 * A port already in use is not an error. Another harness, the Codex CLI, or a
 * half-finished earlier attempt may hold the preferred one, and a fresh
 * ephemeral port is just as valid, so the preferred port is a preference and
 * never a requirement. Only a caller that cannot accept any port would need
 * this to fail.
 *
 * Spare connections are closed explicitly on teardown. A browser opens
 * speculative connections ahead of time; one that has not sent a request yet
 * stays attached to this listener, and a later attempt's callback could be
 * delivered over it — to a listener whose `state` no longer matches, which
 * would reject a perfectly good callback and leave the new attempt waiting.
 *
 * @module dsh-plugin-chatgpt-subscription/auth/callback-server
 */

import { createServer, type Server } from 'node:http'
import { PREFERRED_CALLBACK_PORT, CALLBACK_PATH, callbackUri } from './protocol.ts'

/** What one callback delivered, before the state check is applied. */
export interface CallbackQuery {
  /** The authorization code, absent when the human declined. */
  code?: string
  /** The `state` the browser echoed back. */
  state?: string
  /** The issued client id, present on a first-time registration. */
  clientId?: string
  /** An OAuth error code, present when the human declined or the request was refused. */
  error?: string
}

/** A listener bound to one attempt, with the URI that must be sent. */
export interface CallbackListener {
  /** The exact `redirect_uri` this attempt must use in both requests. */
  readonly redirectUri: string
  /** The port actually bound. */
  readonly port: number
  /** Resolves with the first callback that arrives, or rejects on listener failure. */
  readonly received: Promise<CallbackQuery>
  /** Stop listening and drop spare connections. Safe to call more than once. */
  close(): void
}

/** A page the browser can render without any asset request. */
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>`
    + '<style>body{font:15px/1.6 system-ui,sans-serif;margin:12vh auto;max-width:34rem;padding:0 1.5rem;color:#111}'
    + 'h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:.25rem 0;color:#444}</style></head>'
    + `<body><h1>${title}</h1><p>${body}</p></body></html>`
}

/** Read one callback request's query, ignoring anything off the callback path. */
function queryOf(rawUrl: string | undefined): CallbackQuery | undefined {
  const url = new URL(rawUrl ?? '/', 'http://127.0.0.1')
  if (url.pathname !== CALLBACK_PATH) return undefined
  const read = (name: string): string | undefined => url.searchParams.get(name)?.trim() || undefined
  return {
    ...read('code') === undefined ? {} : { code: read('code')! },
    ...read('state') === undefined ? {} : { state: read('state')! },
    ...read('client_id') === undefined ? {} : { clientId: read('client_id')! },
    ...read('error') === undefined ? {} : { error: read('error')! },
  }
}

/** Bind a listener, preferring `preferredPort` and falling back to an OS-assigned one. */
function listen(server: Server, preferredPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      // EADDRINUSE is the one refusal worth retrying: the port is a preference,
      // not part of the contract, so an occupied one is a different port away
      // from working. Every other failure (permissions, no loopback) is real.
      if (error.code === 'EADDRINUSE' && preferredPort !== 0) {
        server.removeListener('error', onError)
        listen(server, 0).then(resolve, reject)
        return
      }
      reject(error)
    }
    server.once('error', onError)
    server.listen(preferredPort, '127.0.0.1', () => {
      server.removeListener('error', onError)
      const address = server.address()
      /* c8 ignore next -- listen() reports either an object or a string path; a TCP bind always yields the object */
      if (address === null || typeof address === 'string') {
        reject(new Error('the OAuth callback listener bound no TCP port'))
        return
      }
      resolve(address.port)
    })
  })
}

/**
 * Start the listener for one authorization attempt.
 *
 * @param preferredPort - the port to try first; the OS picks one when it is busy.
 * @returns the listener, already bound, with the URI the attempt must use.
 */
export async function startCallbackListener(
  preferredPort: number = PREFERRED_CALLBACK_PORT,
): Promise<CallbackListener> {
  let settle: (query: CallbackQuery) => void
  let fail: (error: Error) => void
  const received = new Promise<CallbackQuery>((resolve, reject) => {
    settle = resolve
    fail = reject
  })

  const server = createServer((request, response) => {
    const query = queryOf(request.url)
    if (query === undefined) {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      response.end(page('Not found', 'This address is only for finishing a ChatGPT sign-in.'))
      return
    }
    if (query.error !== undefined) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      response.end(page('ChatGPT was not connected', `The server reported: ${query.error}`))
      settle(query)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(page('ChatGPT sign-in complete', 'You can close this window and return to DeepSeek Harness.'))
    settle(query)
  })

  const port = await listen(server, preferredPort)
  return {
    port,
    redirectUri: callbackUri(port),
    received,
    close(): void {
      server.close()
      // close() only stops accepting new connections; a speculative one already
      // accepted would otherwise stay attached to a listener nobody awaits.
      server.closeAllConnections()
    },
  }
}
