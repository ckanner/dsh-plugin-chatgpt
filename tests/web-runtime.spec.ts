import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ManagedWebRuntime, runWebBridgeCli, WEB_RUNTIME_RECENT_TURNS } from '../src/web-runtime/index.ts'
import { initializeConfig, loadConfig } from '../src/web-runtime/config.ts'
import { startRuntimeDaemon, type RunningWebRuntime, type RuntimeDependencies } from '../src/web-runtime/daemon.ts'
import { HANDSHAKE_FILE, START_LOCK, type ManagedWebRuntimeOptions, type RuntimeConnection } from '../src/web-runtime/types.ts'
import { writePrivateJson } from '../src/web-runtime/storage.ts'
import { acquireProfileOwnership, assertProfileOwnership, PROFILE_LOCK } from '../src/web-bridge/journal.ts'
import { requestHash } from '../src/web-bridge/protocol.ts'
import type { WebPageTransport, WebRequest } from '../src/web-bridge/contracts.ts'
import type { BrowserSetupEvidence } from '../src/web-browser/index.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
const textPage = { version: 1, complete: true, blocks: [{ type: 'text', text: 'fixture response' }] }
const verified: BrowserSetupEvidence = { visibleAccount: 'owner@example.test', accountBinding: 'fixture-visible-account', ready: true,
  model: 'GPT-6', effort: 'Pro', proAvailable: true, isPro: true, issues: [] }

async function fixture(t: TestContext, options: { idleTimeoutMs?: number, transport?: Partial<WebPageTransport> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'web-runtime-'))
  const stateDirectory = join(root, 'state')
  const managedOptions = { stateDirectory, provider: 'chatgpt', idleTimeoutMs: options.idleTimeoutMs ?? 60_000 }
  await initializeConfig(managedOptions)
  const state = { launches: 0, chromeCloses: 0, pageCloses: 0, inspections: 0, submits: 0,
    evidence: structuredClone(verified), recoveries: 0 }
  const dependencies: RuntimeDependencies = {
    async launchChrome({ profileDirectory, ownership }) {
      assertProfileOwnership(ownership, profileDirectory)
      await assert.rejects(acquireProfileOwnership({ profileDirectory }), { code: 'WEB_PROFILE_LOCKED' })
      state.launches++
      let closed = false
      return { cdpUrl: 'http://127.0.0.1:12345', profileDirectory, ownerNonce: 'fixture-owned', pid: -1,
        async close() { if (!closed) { state.chromeCloses++; closed = true } } }
    },
    async inspectSetup() { state.inspections++; return structuredClone(state.evidence) },
    async createTransport() {
      return {
        async inspectSetup() { state.inspections++; return structuredClone(state.evidence) },
        async prepare() {}, async submit() { state.submits++; return { promptId: 'fixture-prompt' } }, async observe() { return textPage },
        async recover() { state.recoveries++; return { kind: 'not-submitted' } }, async discard() {},
        async close() { state.pageCloses++ }, ...options.transport,
      }
    },
  }
  const daemons: RunningWebRuntime[] = []
  const clients: ManagedWebRuntime[] = []
  const running = await startRuntimeDaemon({ stateDirectory, dependencies })
  daemons.push(running)
  t.after(async () => {
    await Promise.all(clients.map(client => client.dispose()))
    for (const daemon of daemons.reverse()) await daemon.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, stateDirectory, state, running, dependencies,
    client(overrides: Partial<ManagedWebRuntimeOptions> = {}) { const client = new ManagedWebRuntime({ ...managedOptions, ...overrides }); clients.push(client); return client },
    async restart() { await running.close(); const next = await startRuntimeDaemon({ stateDirectory, dependencies }); daemons.push(next); return next },
  }
}

async function bridgeLease(connection: RuntimeConnection) {
  const response = await fetch(`${connection.url}/v1/clients`, { method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: '{}' })
  assert.equal(response.status, 201)
  const lease = await response.json() as { clientLeaseId: string }
  const headers = { authorization: `Bearer ${connection.token}`, 'x-web-client-lease': lease.clientLeaseId, 'content-type': 'application/json' }
  return {
    input(sessionId = 'fixture-session'): WebRequest {
      const value: WebRequest = { ...connection.binding, clientLeaseId: lease.clientLeaseId, deliveryAttemptId: 'attempt', idempotencyKey: '',
        sessionId, purpose: 'normal', model: 'gpt-6-pro-web', reasoningEffort: 'pro',
        messages: [{ id: 'user', role: 'user', content: [{ type: 'text', text: 'fixture input' }] }], tools: [], controls: {}, attachmentVersions: [], parentReceipt: null }
      value.idempotencyKey = requestHash(value)
      return value
    },
    execute: (value: WebRequest) => fetch(`${connection.url}/v1/turns`, { method: 'POST', headers, body: JSON.stringify(value) }),
    async release() { const response = await fetch(`${connection.url}/v1/clients/${lease.clientLeaseId}`, { method: 'DELETE', headers }); await response.body?.cancel() },
  }
}

function rawManagement(running: RunningWebRuntime, path: string, extras: string[] = [], method = 'GET', body?: string): Promise<{ status: number, text: string }> {
  const url = new URL(running.handshake.managementURL)
  return new Promise((resolve, reject) => {
    const headers = ['Host', url.host, 'Authorization', `Bearer ${running.handshake.adminToken}`, 'X-Web-Runtime-Instance', running.handshake.instanceId, ...extras]
    const request = httpRequest({ hostname: url.hostname, port: url.port, method, path, headers }, response => {
      let text = ''
      response.setEncoding('utf8').on('data', chunk => { text += chunk }).on('end', () => resolve({ status: response.statusCode ?? 0, text }))
    })
    request.on('error', reject)
    request.end(body)
  })
}

test('explicit setup holds profile ownership before Chrome; verified disabled accounts can be enabled', async t => {
  const f = await fixture(t)
  const manager = f.client()
  assert.equal((await manager.status()).phase, 'verification-required')
  assert.equal(f.state.launches, 0)
  assert.equal((await manager.setup()).phase, 'login-required')
  const status = await manager.verify()
  assert.equal(status.enabled, false)
  assert.equal(status.ready, false)
  assert.deepEqual(status.issues, [])
  assert.ok(status.binding)
  assert.equal((await manager.setEnabled(true)).ready, true)
  const connection = await manager.connection()
  assert.equal(connection.instanceId, f.running.handshake.instanceId)
  assert.equal(f.state.launches, 1)
  const exposed = JSON.stringify(await manager.status())
  assert.equal(exposed.includes(connection.token), false)
  assert.equal(exposed.includes(f.running.handshake.adminToken), false)
  assert.equal(exposed.includes(f.running.handshake.nonce), false)
})

test('two independent management clients share one daemon and disposing either leaves the other lease alive', async t => {
  const f = await fixture(t)
  const first = f.client(), second = f.client()
  await first.setup()
  await first.verify()
  await first.setEnabled(true)
  const a = await first.connection(), b = await second.connection()
  assert.equal(a.instanceId, b.instanceId)
  assert.equal((await second.status()).activeClients, 2)
  await first.dispose()
  assert.equal((await second.status()).activeClients, 1)
  assert.equal((await second.connection()).instanceId, b.instanceId)
  assert.equal(f.state.chromeCloses, 0)
  await assert.rejects(first.connection(), { code: 'WEB_RUNTIME_DISPOSED' })
})

test('repeated setup durably updates explicit launch settings only before Chrome and the engine start', async t => {
  const f = await fixture(t)
  const changed = f.client({ chromeExecutable: './fixture-chrome', maxInputBytes: 4096, idleTimeoutMs: 7000 })
  assert.equal((await changed.setup()).phase, 'login-required')
  const saved = (await loadConfig(f.stateDirectory))!
  assert.equal(saved.chromeExecutable, resolve('./fixture-chrome'))
  assert.equal(saved.maxInputBytes, 4096)
  assert.equal(saved.idleTimeoutMs, 7000)
  const conflict = f.client({ maxInputBytes: 8192 })
  await assert.rejects(conflict.setup(), { code: 'WEB_RUNTIME_BUSY' })
  assert.equal((await loadConfig(f.stateDirectory))!.maxInputBytes, 4096)
  assert.equal((await changed.setup()).phase, 'login-required')
  assert.equal(f.state.launches, 1)
})

test('verification and setup cannot inspect menus during active browser work or change its readiness', async t => {
  const entered = deferred(), finish = deferred()
  const f = await fixture(t, { transport: { async submit() { entered.resolve(); await finish.promise; return { promptId: 'in-flight' } } } })
  const manager = f.client()
  await manager.verify(); await manager.setEnabled(true)
  const lease = await bridgeLease(await manager.connection())
  const pending = lease.execute(lease.input())
  await entered.promise
  const before = f.state.inspections
  try {
    await assert.rejects(manager.verify(), { code: 'WEB_RUNTIME_BUSY' })
    await assert.rejects(manager.setup(), { code: 'WEB_RUNTIME_BUSY' })
    assert.equal(f.state.inspections, before)
    assert.equal((await manager.status()).ready, true)
  } finally { finish.resolve() }
  const result = await pending
  assert.equal(result.status, 200)
  await result.body?.cancel()
  await lease.release()
})

test('management rejects late Origin, alternate targets, bodies on read routes and forged instance proof', async t => {
  const f = await fixture(t)
  const lateOrigin = Array.from({ length: 70 }, (_, index) => [`x-padding-${index}`, 'x']).flat()
  assert.equal((await rawManagement(f.running, '/status', [...lateOrigin, 'Origin', 'https://attacker.example'])).status, 409)
  for (const target of [`${f.running.handshake.managementURL}/status`, '//status', '/x/../status', '/status#fragment', '/status\\x']) {
    assert.equal((await rawManagement(f.running, target)).status, 409, target)
  }
  assert.equal((await rawManagement(f.running, '/status', ['Content-Length', '2'], 'GET', '{}')).status, 409)
  assert.equal((await rawManagement(f.running, '/clients/current', ['Content-Length', '2'], 'DELETE', '{}')).status, 409)
  assert.equal((await rawManagement(f.running, '/status', ['X-Web-Runtime-Instance', 'forged'])).status, 409)
  assert.equal(f.state.launches, 0)
})

test('saved runtime account evidence opens recovery after restart even when the visible page is not request-ready', async t => {
  const f = await fixture(t, { transport: { async submit() { throw new Error('lost browser outcome') } } })
  const first = f.client()
  await first.verify(); await first.setEnabled(true)
  const lease = await bridgeLease(await first.connection())
  const input = lease.input()
  const response = await lease.execute(input)
  assert.equal(response.status, 409); await response.body?.cancel()
  await lease.release(); await first.dispose()
  await f.restart()
  f.state.evidence = { ...verified, ready: false, issues: ['Response still requires inspection.'] }
  const resumed = f.client()
  const listed = await resumed.listTurns()
  assert.equal(listed[0]?.state, 'uncertain')
  assert.equal(listed[0]?.response, undefined)
  const recovered = await resumed.recoverTurn(`turn-${input.idempotencyKey.slice(7)}`)
  assert.equal(recovered.state, 'failed')
  assert.equal(f.state.recoveries, 1)
  await assert.rejects(resumed.connection(), { code: 'WEB_VERIFICATION_REQUIRED' })
})

test('recent turn summaries are capped and contain no response bodies or delivery capabilities', async t => {
  const f = await fixture(t)
  const manager = f.client()
  await manager.verify(); await manager.setEnabled(true)
  const lease = await bridgeLease(await manager.connection())
  for (let index = 0; index <= WEB_RUNTIME_RECENT_TURNS; index++) {
    const response = await lease.execute(lease.input(`session-${index}`))
    assert.equal(response.status, 200)
    await response.text()
  }
  const turns = await manager.listTurns()
  assert.equal(turns.length, WEB_RUNTIME_RECENT_TURNS)
  assert.equal(turns[0]?.sessionId, `session-${WEB_RUNTIME_RECENT_TURNS}`)
  assert.equal(turns.at(-1)?.sessionId, 'session-1')
  assert.ok(turns.every(turn => turn.response === undefined && turn.deliveryOwner === undefined))
  assert.ok(Buffer.byteLength(JSON.stringify(turns)) < 1024 * 1024)
  await lease.release()
})

test('idle shutdown waits for both management and normal client leases before releasing the profile', async t => {
  const f = await fixture(t, { idleTimeoutMs: 1000 })
  const manager = f.client()
  await manager.verify(); await manager.setEnabled(true)
  const lease = await bridgeLease(await manager.connection())
  await delay(1300)
  assert.equal(f.state.chromeCloses, 0)
  await manager.dispose()
  await delay(1300)
  assert.equal(f.state.chromeCloses, 0)
  await lease.release()
  await Promise.race([f.running.closed, delay(3000).then(() => { throw new Error('idle runtime did not stop') })])
  assert.equal(f.state.chromeCloses, 1)
  await assert.rejects(readFile(join(f.stateDirectory, HANDSHAKE_FILE)), { code: 'ENOENT' })
  const config = (await loadConfig(f.stateDirectory))!
  await assert.rejects(readFile(join(config.profileDirectory, PROFILE_LOCK, 'owner.json')), { code: 'ENOENT' })
})

test('status and CLI never launch Chrome, overwrite malformed handshakes, or reclaim a stale runtime lock', async t => {
  const f = await fixture(t)
  await f.running.close()
  const manager = f.client()
  assert.equal((await manager.status()).phase, 'stopped')
  await writePrivateJson(join(f.stateDirectory, HANDSHAKE_FILE), { ...f.running.handshake, packageVersion: 'wrong-version', adminToken: 's'.repeat(43) })
  assert.equal((await manager.status()).phase, 'error')
  await assert.rejects(manager.verify(), { code: 'WEB_RUNTIME_HANDSHAKE' })
  assert.equal(f.state.launches, 0)
  let output = ''
  assert.equal(await runWebBridgeCli(['status', '--state-directory', f.stateDirectory], text => { output += text }), 0)
  assert.equal(output.includes('s'.repeat(43)), false)
  await rm(join(f.stateDirectory, HANDSHAKE_FILE))
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(f.stateDirectory, START_LOCK), { mode: 0o700 })
  assert.equal((await manager.status()).phase, 'recovery-required')
})
