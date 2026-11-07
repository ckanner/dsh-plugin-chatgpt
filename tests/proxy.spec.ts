import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createScopedFetch } from '../src/http.ts'
import { listModels, streamTurn } from '../src/api/client.ts'
import { refreshCredential } from '../src/auth/refresh.ts'
import { beginSignIn } from '../src/auth/sign-in.ts'
import { revokeGrant } from '../src/auth/revoke.ts'
import type { ChatGptCredential } from '../src/auth/credential.ts'
import { idTokenClaims, jwt, waitFor } from './helpers.ts'

const execFileAsync = promisify(execFile)
const certificate = fileURLToPath(new URL('./fixtures/tls/localhost.crt', import.meta.url))
const privateKey = fileURLToPath(new URL('./fixtures/tls/localhost.key', import.meta.url))

const servers: Server[] = []
const transports: { close: () => Promise<void> }[] = []
const tunnelSockets = new Set<Duplex>()

afterEach(async () => {
  await Promise.all(transports.splice(0).map(transport => transport.close()))
  for (const socket of tunnelSockets) socket.destroy()
  tunnelSockets.clear()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

async function startProxy(): Promise<{ url: string, tunnels: string[] }> {
  const tunnels: string[] = []
  const proxy = createServer()
  proxy.on('connect', (request, client, head) => {
    tunnelSockets.add(client)
    client.on('close', () => tunnelSockets.delete(client))
    tunnels.push(request.url ?? '')
    const address = new URL(`http://${request.url}`)
    const upstream = connect(Number(address.port), address.hostname, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      client.pipe(upstream)
      upstream.pipe(client)
    })
    tunnelSockets.add(upstream)
    upstream.on('close', () => tunnelSockets.delete(upstream))
    upstream.on('error', () => client.destroy())
    client.on('error', () => upstream.destroy())
  })
  return { url: await listen(proxy), tunnels }
}

function transportFor(url: string): ReturnType<typeof createScopedFetch> {
  const transport = createScopedFetch(url)
  transports.push(transport)
  return transport
}

describe('scoped proxy transport', () => {
  it('routes API and token calls through its proxy without changing global fetch', async () => {
    const paths: string[] = []
    const endpoint = await listen(createServer((request, response) => {
      paths.push(request.url ?? '')
      response.setHeader('content-type', 'application/json')
      response.end(request.url === '/models'
        ? JSON.stringify({ models: [{ slug: 'proxy-model' }] })
        : JSON.stringify({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 }))
    }))
    const { url: proxyUrl, tunnels } = await startProxy()
    const transport = transportFor(proxyUrl)

    assert.deepEqual((await listModels('token', { baseUrl: endpoint, fetch: transport.fetch })).map(model => model.slug), ['proxy-model'])
    const credential: ChatGptCredential = {
      accessToken: 'old', refreshToken: 'old-refresh', clientId: 'issued', expiresAt: 0,
      scopes: ['chatgpt.tokens.use.direct'], savedAt: 0,
    }
    const rotated = await refreshCredential(credential, { tokenUrl: `${endpoint}/token`, fetch: transport.fetch })
    assert.equal(rotated.accessToken, 'fresh')
    assert.deepEqual(paths, ['/models', '/token'])
    assert.equal(tunnels.length, 2)

    await fetch(`${endpoint}/direct`)
    assert.deepEqual(paths, ['/models', '/token', '/direct'])
    assert.equal(tunnels.length, 2)
  })

  it('rejects unsupported proxy protocols', () => {
    assert.throws(() => createScopedFetch('socks5://127.0.0.1:1080'), /http:\/\/ or https:\/\//)
  })

  it('uses direct fetch when the proxy setting is absent or blank', async () => {
    const direct = createScopedFetch(undefined)
    const empty = createScopedFetch('  \t ')
    assert.equal(direct.fetch, globalThis.fetch)
    assert.equal(empty.fetch, globalThis.fetch)
    await direct.close()
    await empty.close()
  })

  it('tunnels an HTTPS target and verifies its certificate', async () => {
    const endpoint = await listen(createHttpsServer({
      key: await readFile(privateKey), cert: await readFile(certificate),
    }, (_request, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ models: [{ slug: 'tls-model' }] }))
    }))
    const { url: proxyUrl, tunnels } = await startProxy()
    // NODE_EXTRA_CA_CERTS is read when Node starts. A child process trusts only
    // this local test certificate, keeping TLS verification enabled in CI.
    const code = `
      import { createScopedFetch } from './src/http.ts'
      import { listModels } from './src/api/client.ts'
      const transport = createScopedFetch(process.env.TEST_PROXY_URL)
      try {
        const models = await listModels('token', { baseUrl: process.env.TEST_TARGET_URL, fetch: transport.fetch })
        process.stdout.write(models.map(model => model.slug).join(','))
      } finally { await transport.close() }
    `
    const result = await execFileAsync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: certificate,
        TEST_PROXY_URL: proxyUrl,
        TEST_TARGET_URL: endpoint.replace(/^http:/, 'https:'),
      },
    })
    assert.equal(result.stdout, 'tls-model')
    assert.equal(tunnels.length, 1)
    assert.match(tunnels[0] ?? '', /^127\.0\.0\.1:\d+$/)
  })

  it('cancels a Responses SSE stream through the proxy', async () => {
    let disconnected = false
    const endpoint = await listen(createServer((request, response) => {
      request.on('close', () => { disconnected = true })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"type":"response.output_text.delta","delta":"hello"}\n\n')
    }))
    const { url: proxyUrl, tunnels } = await startProxy()
    const transport = transportFor(proxyUrl)
    const controller = new AbortController()
    const events = streamTurn({
      accessToken: 'token', request: { model: 'test', messages: [] },
      endpoints: { baseUrl: endpoint, fetch: transport.fetch }, signal: controller.signal,
    })
    assert.equal((await events.next()).value?.kind, 'text')
    controller.abort()
    await assert.rejects(events.next(), /abort/i)
    await waitFor(() => disconnected)
    assert.ok(tunnels.length >= 1)
  })

  it('sends sign-in code exchange through the proxy', async () => {
    let nonce = ''
    const clientId = 'oaiapp_proxy_test'
    const requests: string[] = []
    const endpoint = await listen(createServer((request, response) => {
      requests.push(request.url ?? '')
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        access_token: 'proxy-access', refresh_token: 'proxy-refresh', expires_in: 3600,
        scope: 'openid chatgpt.tokens.use.direct',
        id_token: jwt(idTokenClaims({ clientId, nonce })),
      }))
    }))
    const { url: proxyUrl, tunnels } = await startProxy()
    const transport = transportFor(proxyUrl)
    const attempt = await beginSignIn({
      agentHostId: 'urn:uuid:6f1c1a1e-2b3d-4c5e-8f90-1234567890ab',
      agentNameHint: 'Test', preferredPort: 0,
      tokenUrl: `${endpoint}/token`, fetch: transport.fetch,
    })
    const params = new URL(attempt.authorizationUrl).searchParams
    nonce = params.get('nonce') ?? ''
    await attempt.submit(`${attempt.redirectUri}?code=test&state=${params.get('state')}&client_id=${clientId}`)
    assert.equal((await attempt.result).accessToken, 'proxy-access')
    assert.deepEqual(requests, ['/token'])
    assert.equal(tunnels.length, 1)
  })

  it('routes both discovery and revocation through the proxy', async () => {
    const paths: string[] = []
    let endpoint = ''
    endpoint = await listen(createServer((request, response) => {
      paths.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(request.url === '/discovery'
        ? JSON.stringify({ revocation_endpoint: `${endpoint}/revoke` }) : '')
    }))
    const { url: proxyUrl, tunnels } = await startProxy()
    const transport = transportFor(proxyUrl)
    const credential: ChatGptCredential = {
      accessToken: 'access', refreshToken: 'refresh', clientId: 'issued',
      expiresAt: 0, scopes: ['chatgpt.tokens.use.direct'], savedAt: 0,
    }
    const result = await revokeGrant(credential, {
      discoveryUrl: `${endpoint}/discovery`, fetch: transport.fetch,
    })
    assert.equal(result.confirmed, true)
    assert.deepEqual(paths, ['/discovery', '/revoke'])
    assert.equal(tunnels.length, 2)
  })

  it('closes an active request when the plugin transport is disposed', async () => {
    let disconnected = false
    const endpoint = await listen(createServer((request, response) => {
      request.on('close', () => { disconnected = true })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: ready\n\n')
    }))
    const { url: proxyUrl } = await startProxy()
    const transport = createScopedFetch(proxyUrl)
    const response = await transport.fetch(endpoint)
    assert.equal(response.status, 200)
    const reader = response.body?.getReader()
    assert.ok(reader !== undefined)
    assert.equal((await reader.read()).done, false)
    const pendingRead = reader.read()
    const closed = transport.close()
    await assert.rejects(pendingRead)
    await closed
    await waitFor(() => disconnected)
  })
})
