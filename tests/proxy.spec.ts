import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { createScopedFetch } from '../src/http.ts'
import { listModels } from '../src/api/client.ts'
import { refreshCredential } from '../src/auth/refresh.ts'
import type { ChatGptCredential } from '../src/auth/credential.ts'

const servers: Server[] = []
const transports: { close: () => Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(transports.splice(0).map(transport => transport.close()))
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
    const tunnels: string[] = []
    const proxy = createServer()
    proxy.on('connect', (request, client, head) => {
      tunnels.push(request.url ?? '')
      const address = new URL(`http://${request.url}`)
      const upstream = connect(Number(address.port), address.hostname, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) upstream.write(head)
        client.pipe(upstream)
        upstream.pipe(client)
      })
      upstream.on('error', () => client.destroy())
      client.on('error', () => upstream.destroy())
    })
    const proxyUrl = await listen(proxy)
    const transport = createScopedFetch(proxyUrl)
    transports.push(transport)

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
})
