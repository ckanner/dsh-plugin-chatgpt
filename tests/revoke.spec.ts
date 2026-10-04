import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { ChatGptAuth } from '../src/auth/manager.ts'
import { revokeGrant } from '../src/auth/revoke.ts'
import type { ChatGptCredential } from '../src/auth/credential.ts'
import { writeDocument, emptyDocument } from '../src/auth/store.ts'

const dirs: string[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve())
    server.closeAllConnections()
  })))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A revocation endpoint recording what it received. */
async function revocationServer(answer: (attempt: number) => { status: number, body?: string }): Promise<{
  url: string
  requests: URLSearchParams[]
}> {
  const requests: URLSearchParams[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      requests.push(new URLSearchParams(body))
      const reply = answer(requests.length)
      response.writeHead(reply.status, { 'content-type': 'application/json' })
      response.end(reply.body ?? '')
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('revocation server bound no port')
  return { url: `http://127.0.0.1:${address.port}/revoke`, requests }
}

const GRANT: ChatGptCredential = {
  accessToken: 'access',
  refreshToken: 'refresh-abc',
  expiresAt: Date.now() + 3600_000,
  clientId: 'oaiapp_issued',
  scopes: ['chatgpt.tokens.use.direct'],
  subject: 'subject-1',
  savedAt: 1,
}

/** A state directory holding one signed-in account with a chosen revocation endpoint. */
async function signedIn(revocationEndpoint: string): Promise<{ auth: ChatGptAuth, dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'chatgpt-revoke-'))
  dirs.push(dir)
  writeDocument(join(dir, 'chatgpt-auth.json'), {
    ...emptyDocument('urn:uuid:x'),
    accounts: { 'subject-1': GRANT },
    active: 'subject-1',
  })
  return {
    dir,
    auth: new ChatGptAuth({
      stateDir: dir,
      agentNameHint: 'DeepSeek Harness',
      endpoints: { revocationEndpoint },
    }),
  }
}

describe('revokeGrant', () => {
  it('posts the refresh token with the issued client id', async () => {
    const endpoint = await revocationServer(() => ({ status: 200 }))

    const result = await revokeGrant(GRANT, { revocationEndpoint: endpoint.url })

    assert.equal(result.confirmed, true)
    const sent = endpoint.requests[0]
    assert.equal(sent?.get('token'), 'refresh-abc')
    assert.equal(sent?.get('token_type_hint'), 'refresh_token')
    // The issued id, never the dynamic entry point.
    assert.equal(sent?.get('client_id'), 'oaiapp_issued')
  })

  it('treats an empty success as confirmation, so a second sign-out is not an error', async () => {
    const endpoint = await revocationServer(() => ({ status: 200, body: '' }))

    assert.equal((await revokeGrant(GRANT, { revocationEndpoint: endpoint.url })).confirmed, true)
  })

  it('retries a server failure while the refresh token is still held', async () => {
    const endpoint = await revocationServer(attempt => attempt < 3
      ? { status: 503, body: 'busy' }
      : { status: 200 })

    const result = await revokeGrant(GRANT, { revocationEndpoint: endpoint.url })

    assert.equal(result.confirmed, true)
    assert.equal(endpoint.requests.length, 3)
  })

  it('does not repeat a refusal of the request itself', async () => {
    // Repeating it would produce the same answer, and the caller needs to know
    // the grant may still be live rather than wait on retries.
    const endpoint = await revocationServer(() => ({ status: 400, body: 'invalid_request' }))

    const result = await revokeGrant(GRANT, { revocationEndpoint: endpoint.url })

    assert.equal(result.confirmed, false)
    assert.match(result.reason ?? '', /invalid_request/)
    assert.equal(endpoint.requests.length, 1)
  })

  it('reports an unreachable endpoint as unconfirmed rather than claiming success', async () => {
    const result = await revokeGrant(GRANT, { revocationEndpoint: 'http://127.0.0.1:9/revoke' })

    assert.equal(result.confirmed, false)
    assert.ok((result.reason ?? '').length > 0)
  })

  it('reads the endpoint from discovery when it is available', async () => {
    const endpoint = await revocationServer(() => ({ status: 200 }))
    const discovery = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ revocation_endpoint: endpoint.url }))
    })
    servers.push(discovery)
    await new Promise<void>(resolve => { discovery.listen(0, '127.0.0.1', resolve) })
    const address = discovery.address()
    if (address === null || typeof address === 'string') throw new Error('discovery bound no port')

    const result = await revokeGrant(GRANT, {
      discoveryUrl: `http://127.0.0.1:${address.port}/.well-known/openid-configuration`,
    })

    assert.equal(result.confirmed, true)
    assert.equal(endpoint.requests.length, 1)
  })
})

describe('ChatGptAuth revocation', () => {
  it('revokes before clearing, and clears even when the server cannot confirm', async () => {
    const endpoint = await revocationServer(() => ({ status: 500, body: 'down' }))
    const { auth } = await signedIn(endpoint.url)

    const result = await auth.revoke()

    assert.equal(result.confirmed, false)
    // The user asked to sign out, so they are signed out here regardless — the
    // outcome says which of the two things happened.
    assert.equal(auth.status().signedIn, false)
    assert.deepEqual(auth.status().accounts, [])
  })

  it('clears the credential after a confirmed revocation', async () => {
    const endpoint = await revocationServer(() => ({ status: 200 }))
    const { auth } = await signedIn(endpoint.url)

    const result = await auth.revoke()

    assert.equal(result.confirmed, true)
    assert.equal(auth.active(), undefined)
    assert.equal(endpoint.requests.length, 1)
  })

  it('answers an unknown account without pretending to have revoked it', async () => {
    const endpoint = await revocationServer(() => ({ status: 200 }))
    const { auth } = await signedIn(endpoint.url)

    const result = await auth.revoke('nobody')

    assert.equal(result.confirmed, false)
    assert.match(result.reason ?? '', /no stored ChatGPT account/)
    // The real account is untouched.
    assert.equal(auth.status().signedIn, true)
  })
})
