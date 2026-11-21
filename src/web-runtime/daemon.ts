/** A private management service whose lifetime is independent of any plugin client. */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { WebBridgeError, type WebBinding, type WebBridgeEngine } from '../web-bridge/contracts.ts'
import { openWebBridge, type ManagedWebBridgeEngine } from '../web-bridge/engine.ts'
import { acquireProfileOwnership, type ProfileOwnership } from '../web-bridge/journal.ts'
import { openWebImageStore } from '../web-bridge/image-store.ts'
import { startWebBridgeServer, type WebBridgeServer } from '../web-bridge/server.ts'
import { canonical, validateBinding } from '../web-bridge/protocol.ts'
import type { BrowserSetupEvidence, ChromePageTransport, ChromePageTransportOptions, ChromeConnectionOptions } from '../web-browser/index.ts'
import { launchOwnedChrome, type OwnedChrome } from './chrome.ts'
import { loadConfig, validateConfig } from './config.ts'
import { acquireRuntimeLock, privateDirectory, readPrivateJson, runtimeError, syncDirectory, writePrivateJson } from './storage.ts'
import { CONFIG_FILE, HANDSHAKE_FILE, PACKAGE_VERSION, RUNTIME_PROTOCOL_VERSION, START_LOCK, WEB_RUNTIME_RECENT_TURNS,
  type RuntimeAdministration, type RuntimeConfig, type RuntimeHandshake, type RuntimeLaunchSettings, type WebRuntimeStatus } from './types.ts'

export interface RuntimeDependencies {
  launchChrome(options: { profileDirectory: string, ownership: ProfileOwnership, executable?: string }): Promise<OwnedChrome>
  inspectSetup(options: ChromeConnectionOptions): Promise<BrowserSetupEvidence>
  createTransport(options: ChromePageTransportOptions): Promise<ChromePageTransport>
}

export interface RunningWebRuntime {
  readonly handshake: RuntimeHandshake
  readonly administration: RuntimeAdministration
  close(): Promise<void>
  readonly closed: Promise<void>
}

const ADMIN_TTL = 60_000
const MAX_MANAGEMENT_BYTES = 64 * 1024

function issue(error: unknown): string {
  return error instanceof WebBridgeError ? `${error.code}: ${error.message}`.slice(0, 768)
    : 'Web runtime operation failed. Inspect the local browser and runtime state before retrying.'
}

function authenticate(request: IncomingMessage, authority: string, token: string, instanceId: string): void {
  const sensitive = new Set(['host', 'authorization', 'origin', 'x-web-runtime-instance', 'x-web-admin-lease', 'content-type', 'content-encoding'])
  const seen = new Set<string>()
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const key = request.rawHeaders[index]!.toLowerCase()
    if (!sensitive.has(key)) continue
    if (seen.has(key)) throw runtimeError('WEB_RUNTIME_AUTH', 'Duplicate management security header.')
    seen.add(key)
  }
  if (request.headers.host !== authority || request.headers.origin !== undefined
    || request.headers['x-web-runtime-instance'] !== instanceId) throw runtimeError('WEB_RUNTIME_AUTH', 'Management authority or instance does not match.')
  const actual = request.headers.authorization
  const expected = `Bearer ${token}`
  if (typeof actual !== 'string' || Buffer.byteLength(actual) !== Buffer.byteLength(expected)
    || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) throw runtimeError('WEB_RUNTIME_AUTH', 'A private management credential is required.')
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')
    || request.headers['content-encoding'] !== undefined) throw runtimeError('WEB_RUNTIME_INPUT', 'Management requests require uncompressed JSON.')
  const declared = request.headers['content-length']
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_MANAGEMENT_BYTES)) throw runtimeError('WEB_RUNTIME_INPUT', 'Management body exceeds its limit.')
  return new Promise((resolve, reject) => {
    let bytes = 0
    const chunks: Buffer[] = []
    const timer = setTimeout(() => { reject(runtimeError('WEB_RUNTIME_TIMEOUT', 'Management body timed out.')); request.destroy() }, 10_000)
    const fail = (error: unknown) => { clearTimeout(timer); reject(error) }
    request.on('error', fail)
    request.on('aborted', () => fail(runtimeError('WEB_RUNTIME_INPUT', 'Management connection closed.')))
    request.on('data', chunk => {
      bytes += chunk.length
      if (bytes > MAX_MANAGEMENT_BYTES) { fail(runtimeError('WEB_RUNTIME_INPUT', 'Management body exceeds its limit.')); request.destroy(); return }
      chunks.push(Buffer.from(chunk))
    })
    request.on('end', () => {
      clearTimeout(timer)
      try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
        canonical(value)
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
        resolve(value as Record<string, unknown>)
      } catch { reject(runtimeError('WEB_RUNTIME_INPUT', 'Invalid management JSON.')) }
    })
  })
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return
  const text = canonical(value)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', connection: 'close' })
  response.end(text)
}

export async function startRuntimeDaemon(options: { stateDirectory: string, dependencies?: RuntimeDependencies }): Promise<RunningWebRuntime> {
  const stateDirectory = await privateDirectory(options.stateDirectory)
  let config = await loadConfig(stateDirectory)
  if (config === undefined) throw runtimeError('WEB_SETUP_REQUIRED', 'Run explicit Web setup before starting its daemon.')
  const configured: RuntimeConfig = config
  const instanceId = randomUUID()
  const runtimeLock = await acquireRuntimeLock(join(stateDirectory, START_LOCK), instanceId)
  const dependencies: RuntimeDependencies = options.dependencies ?? {
    launchChrome: launchOwnedChrome,
    inspectSetup: async options => (await import('../web-browser/index.ts')).inspectChromeSetup(options),
    createTransport: async options => (await import('../web-browser/index.ts')).createChromePageTransport(options),
  }
  let owner: ProfileOwnership | undefined
  let chrome: OwnedChrome | undefined
  let page: ChromePageTransport | undefined
  let engine: ManagedWebBridgeEngine | undefined
  let bridge: WebBridgeServer | undefined
  let phase: WebRuntimeStatus['phase'] = configured.binding === undefined ? 'verification-required' : 'stopped'
  let issues: string[] = []
  let closing = false
  let unsafeChrome = false
  let queue: Promise<void> = Promise.resolve()
  let activeManagement = 0
  let lastActivity = Date.now()
  let closePromise: Promise<void> | undefined
  let resolveClosed!: () => void
  let rejectClosed!: (error: unknown) => void
  const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject })
  void closed.catch(() => undefined)
  const adminClients = new Map<string, number>()
  const handshake: RuntimeHandshake = {
    protocolVersion: RUNTIME_PROTOCOL_VERSION, packageVersion: PACKAGE_VERSION, instanceId,
    nonce: randomBytes(32).toString('base64url'), stateDirectory, profileDirectory: configured.profileDirectory,
    installationId: configured.installationId, profileId: configured.profileId, provider: configured.provider,
    managementURL: '', adminToken: randomBytes(32).toString('base64url'),
    ...configured.binding === undefined ? {} : { binding: configured.binding },
  }
  const mutate = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.then(async () => { if (closing) throw runtimeError('WEB_RUNTIME_CLOSED', 'Runtime is stopping.'); return work() })
    queue = result.then(() => undefined, () => undefined)
    return result
  }
  const save = async (next: RuntimeConfig = configured): Promise<void> => {
    const nextHandshake = { ...handshake, ...next.binding === undefined ? {} : { binding: structuredClone(next.binding) } }
    try {
      await writePrivateJson(join(stateDirectory, CONFIG_FILE), next)
      await writePrivateJson(join(stateDirectory, HANDSHAKE_FILE), nextHandshake)
    } catch (error) {
      phase = 'recovery-required'
      issues = ['Runtime settings could not establish durability. Inspect local storage before admitting more work.']
      throw error
    }
    Object.assign(configured, next)
    Object.assign(handshake, nextHandshake)
  }
  const ensureChrome = async (): Promise<void> => {
    if (unsafeChrome) throw runtimeError('WEB_CHROME_OWNERSHIP', 'An earlier Chrome cleanup was not verified; offline inspection is required.')
    if (configured.attachCdpUrl !== undefined) {
      // Attach mode deliberately does not own, launch, lock or close this browser.
      phase = 'starting'
      return
    }
    if (chrome !== undefined) return
    phase = 'starting'
    const physical = await privateDirectory(configured.profileDirectory)
    if (physical !== configured.profileDirectory) throw runtimeError('WEB_RUNTIME_PROFILE', 'The dedicated profile now aliases a different directory.')
    owner ??= await acquireProfileOwnership({ profileDirectory: physical, instanceId })
    try {
      chrome = await dependencies.launchChrome({ profileDirectory: physical, ownership: owner,
        ...configured.chromeExecutable === undefined ? {} : { executable: configured.chromeExecutable } })
    } catch (error) {
      // An unverifiable process must keep the profile locked even after daemon
      // shutdown. A successful launch cleanup reports WEB_CHROME_START instead.
      if (!(error instanceof WebBridgeError) || error.code === 'WEB_CHROME_OWNERSHIP' || error.code === 'WEB_CHROME_STOP') unsafeChrome = true
      throw error
    }
  }
  const status = async (): Promise<WebRuntimeStatus> => {
    for (const [id, expiry] of adminClients) if (expiry <= Date.now()) adminClients.delete(id)
    const activity = engine?.administration.activity() ?? { activeTurns: 0, uncertainTurns: 0 }
    const currentPhase = activity.uncertainTurns > 0 ? 'recovery-required' : phase
    return {
      phase: currentPhase, enabled: configured.enabled,
      ready: currentPhase === 'ready' && configured.enabled && bridge !== undefined && !closing,
      issues: activity.uncertainTurns > 0 ? ['A browser outcome is unresolved. Inspect and recover it before more submissions.', ...issues] : issues,
      profileDirectory: configured.profileDirectory,
      ...configured.account === undefined ? {} : { account: configured.account },
      ...configured.binding === undefined ? {} : { binding: structuredClone(configured.binding) },
      activeClients: (bridge?.activity().clients ?? 0) + adminClients.size,
      activeTurns: activity.activeTurns + activity.uncertainTurns,
    }
  }
  const setup = async (settings: RuntimeLaunchSettings = {}): Promise<WebRuntimeStatus> => {
    if ((engine?.administration.activity().activeTurns ?? 0) > 0 || (bridge?.activity().activeTurns ?? 0) > 0) throw runtimeError('WEB_RUNTIME_BUSY', 'Wait for active browser work before setup.')
    const next = validateConfig({ ...configured, ...settings }, stateDirectory, configured.provider)
    const changed = (['chromeExecutable', 'maxInputBytes', 'idleTimeoutMs'] as const).some(key => next[key] !== configured[key])
    if (changed) {
      if (chrome !== undefined || engine !== undefined) throw runtimeError('WEB_RUNTIME_BUSY', 'Stop the owned runtime or wait for all clients to release it and idle shutdown to finish, then repeat setup to change browser launch settings.')
      await save(next)
    }
    if (engine !== undefined) return status()
    try { await ensureChrome(); phase = configured.binding === undefined ? 'login-required' : 'verification-required'; issues = [] }
    catch (error) { phase = 'recovery-required'; issues = [issue(error)] }
    return status()
  }
  const ensureEngine = async (binding: WebBinding, initialize: boolean): Promise<ManagedWebBridgeEngine> => {
    if (engine !== undefined) return engine
    await ensureChrome()
    const attached = configured.attachCdpUrl !== undefined
    const opened = await dependencies.createTransport({ cdpUrl: attached ? configured.attachCdpUrl! : chrome!.cdpUrl,
      stateDirectory: join(stateDirectory, 'browser'), attached,
      expectedProfileDirectory: configured.profileDirectory, expectedAccountBinding: binding.accountBinding,
      provider: configured.provider, profileId: configured.profileId, initialize,
      ...configured.projectIsolation === undefined ? {} : { projectIsolation: configured.projectIsolation },
      ...configured.maxInputBytes === undefined ? {} : { maxInputBytes: configured.maxInputBytes } })
    try {
      const imageStore = await openWebImageStore(join(stateDirectory, 'images'), { initialize })
      engine = await openWebBridge({ directory: join(stateDirectory, 'journal'), profileDirectory: configured.profileDirectory,
        binding, transport: opened, initialize, instanceId, imageStore,
        ...owner === undefined ? {} : { profileOwnership: owner } })
      page = opened
      if (phase === 'starting') phase = 'verification-required'
      return engine
    } catch (error) { await opened.close(); throw error }
  }
  const ensureBridge = async (admittedEngine: ManagedWebBridgeEngine): Promise<void> => {
    if (bridge !== undefined) return
    const gated: WebBridgeEngine = {
      binding: admittedEngine.binding, instanceId: admittedEngine.instanceId,
      execute: (request, options) => {
        if (!configured.enabled || phase !== 'ready' || closing) return Promise.reject(runtimeError('WEB_DISABLED', 'Verify and enable the Web provider before sending a request.'))
        return admittedEngine.execute(request, options)
      },
      inspect: (id, access) => admittedEngine.inspect(id, access), cancel: (id, access) => admittedEngine.cancel(id, access),
      recover: (id, access) => admittedEngine.recover(id, access), discard: (id, access) => admittedEngine.discard(id, access),
      releaseClient: id => admittedEngine.releaseClient(id), close: () => admittedEngine.close(),
    }
    bridge = await startWebBridgeServer({ engine: gated, transport: 'browser' })
  }
  const verify = async (): Promise<WebRuntimeStatus> => {
    if ((engine?.administration.activity().activeTurns ?? 0) > 0 || (bridge?.activity().activeTurns ?? 0) > 0) {
      throw runtimeError('WEB_RUNTIME_BUSY', 'Wait for active browser work before opening verification controls.')
    }
    // Prevent a newly arriving model request from starting while verification
    // opens read-only account/model menus on the same owned page.
    phase = 'verification-required'
    try {
      await ensureChrome()
      const attached = configured.attachCdpUrl !== undefined
      const evidence = page === undefined ? await dependencies.inspectSetup({ cdpUrl: attached ? configured.attachCdpUrl! : chrome!.cdpUrl,
        expectedProfileDirectory: configured.profileDirectory, attached }) : await page.inspectSetup()
      if (!evidence.visibleAccount || !evidence.accountBinding) {
        phase = 'login-required'; issues = evidence.issues.length ? evidence.issues.slice(0, 8).map(text => text.slice(0, 768)) : ['Sign in visibly in the dedicated Chrome window.']; return status()
      }
      if (!evidence.ready || evidence.model !== 'GPT-6' || evidence.effort !== 'Pro') {
        phase = 'verification-required'; issues = evidence.issues.length ? evidence.issues.slice(0, 8).map(text => text.slice(0, 768)) : ['Verify the visible GPT-6 and Pro controls.']; return status()
      }
      const binding: WebBinding = { protocolVersion: 1, installationId: configured.installationId,
        provider: configured.provider, profileId: configured.profileId, accountBinding: evidence.accountBinding }
      if (configured.binding !== undefined && canonical(configured.binding) !== canonical(binding)) throw runtimeError('WEB_BINDING_MISMATCH', 'The visible account differs from this profile journal. Inspect the existing state; it cannot be retargeted automatically.')
      const admittedEngine = await ensureEngine(binding, configured.setupPending)
      // All first-install stores are durable before any bridge client can run.
      await save({ ...configured, binding: validateBinding(binding), account: evidence.visibleAccount, setupPending: false })
      await ensureBridge(admittedEngine)
      phase = 'ready'; issues = []
    } catch (error) { phase = 'recovery-required'; issues = [issue(error)] }
    return status()
  }
  const requireEngine = async (): Promise<ManagedWebBridgeEngine> => {
    if (engine !== undefined) return engine
    if (configured.binding === undefined || configured.setupPending) throw runtimeError('WEB_VERIFICATION_REQUIRED', 'Complete initial verification before inspecting the engine journal.')
    // Loading existing evidence is independent of new-request readiness. An
    // active/unknown website response must not make admin recovery unreachable.
    return ensureEngine(configured.binding, false)
  }
  const administration: RuntimeAdministration = {
    status,
    setup: settings => mutate(() => setup(settings)),
    verify: () => mutate(verify),
    setEnabled: enabled => mutate(async () => {
      await save({ ...configured, enabled })
      if (enabled && configured.binding !== undefined) return engine !== undefined && phase === 'ready' ? status() : verify()
      issues = enabled && configured.binding === undefined ? ['Complete visible account and model verification.'] : []
      return status()
    }),
    connection: () => mutate(async () => {
      if (!configured.enabled || configured.binding === undefined) throw runtimeError('WEB_VERIFICATION_REQUIRED', 'Enable and visibly verify Web Pro first.')
      if (bridge === undefined || phase !== 'ready') await verify()
      const current = await status()
      if (!current.ready || bridge === undefined) throw runtimeError('WEB_VERIFICATION_REQUIRED', current.issues[0] ?? 'The Web runtime is not ready.')
      return { url: bridge.url, token: bridge.token, binding: validateBinding(bridge.health), instanceId }
    }),
    listTurns: () => mutate(async () => (await (await requireEngine()).administration.list()).slice(-WEB_RUNTIME_RECENT_TURNS).reverse()),
    inspectTurn: turnId => mutate(async () => (await requireEngine()).administration.inspect(turnId)),
    recoverTurn: turnId => mutate(async () => (await requireEngine()).administration.recover(turnId)),
    discardTurn: turnId => mutate(async () => (await requireEngine()).administration.discard(turnId)),
  }

  let authority = ''
  const server = createServer({ maxHeaderSize: 16_384 }, (request, response) => {
    activeManagement++
    response.on('error', () => undefined)
    void (async () => {
      authenticate(request, authority, handshake.adminToken, instanceId)
      response.setHeader('x-web-runtime-instance', instanceId)
      response.setHeader('x-web-runtime-nonce', handshake.nonce)
      response.setHeader('x-web-runtime-version', PACKAGE_VERSION)
      if (closing) throw runtimeError('WEB_RUNTIME_CLOSED', 'Runtime is stopping.')
      lastActivity = Date.now()
      const target = request.url ?? ''
      if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\') || target.includes('#')) throw runtimeError('WEB_RUNTIME_INPUT', 'Invalid management request target.')
      const url = new URL(target, handshake.managementURL)
      if (url.origin !== handshake.managementURL || url.search) throw runtimeError('WEB_RUNTIME_INPUT', 'Invalid management route.')
      if (url.pathname !== target) throw runtimeError('WEB_RUNTIME_INPUT', 'Management request targets must be canonical.')
      const method = request.method ?? ''
      if ((method === 'GET' || method === 'DELETE') && (request.headers['transfer-encoding'] !== undefined
        || request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0')) throw runtimeError('WEB_RUNTIME_INPUT', 'This management method does not accept a body.')
      if (method === 'GET' && url.pathname === '/status') { json(response, 200, await status()); return }
      if (method === 'POST' && url.pathname === '/clients') {
        if (Object.keys(await body(request)).length !== 0 || adminClients.size >= 1024) throw runtimeError('WEB_RUNTIME_INPUT', 'Invalid management registration or too many clients.')
        const id = randomBytes(24).toString('base64url'); const expiresAt = Date.now() + ADMIN_TTL
        adminClients.set(id, expiresAt); json(response, 201, { clientLeaseId: id, expiresAt }); return
      }
      const lease = request.headers['x-web-admin-lease']
      if (typeof lease !== 'string' || (adminClients.get(lease) ?? 0) <= Date.now()) throw runtimeError('WEB_RUNTIME_LEASE', 'A current management lease is required.')
      if (url.pathname === '/clients/current' && method === 'DELETE') { adminClients.delete(lease); json(response, 200, { released: true }); return }
      if (url.pathname === '/clients/current/heartbeat' && method === 'POST') {
        if (Object.keys(await body(request)).length !== 0) throw runtimeError('WEB_RUNTIME_INPUT', 'Unexpected heartbeat fields.')
        const expiresAt = Date.now() + ADMIN_TTL; adminClients.set(lease, expiresAt); json(response, 200, { clientLeaseId: lease, expiresAt }); return
      }
      if (method === 'GET' && url.pathname === '/connection') { json(response, 200, await administration.connection()); return }
      if (method === 'GET' && url.pathname === '/turns') { json(response, 200, await administration.listTurns()); return }
      if (method === 'POST' && ['/setup', '/verify', '/enabled'].includes(url.pathname)) {
        const value = await body(request)
        if (url.pathname === '/enabled') {
          if (Object.keys(value).length !== 1 || typeof value.enabled !== 'boolean') throw runtimeError('WEB_RUNTIME_INPUT', 'Expected only enabled: boolean.')
          json(response, 200, await administration.setEnabled(value.enabled))
        } else {
          const setupKeys = new Set(['chromeExecutable', 'maxInputBytes', 'idleTimeoutMs'])
          if (Object.keys(value).some(key => url.pathname !== '/setup' || !setupKeys.has(key))) throw runtimeError('WEB_RUNTIME_INPUT', 'Unexpected management fields.')
          json(response, 200, await (url.pathname === '/setup' ? administration.setup(value as RuntimeLaunchSettings) : administration.verify()))
        }
        return
      }
      const turn = /^\/turns\/(turn-[a-f0-9]{64})(?:\/(recover|discard))?$/.exec(url.pathname)
      if (turn !== null) {
        if (method === 'GET' && turn[2] === undefined) { json(response, 200, await administration.inspectTurn(turn[1]!)); return }
        if (method === 'POST' && turn[2] !== undefined && Object.keys(await body(request)).length === 0) {
          json(response, 200, await (turn[2] === 'recover' ? administration.recoverTurn(turn[1]!) : administration.discardTurn(turn[1]!))); return
        }
      }
      throw runtimeError('WEB_RUNTIME_ROUTE', 'Unknown management route.')
    })().catch(error => {
      try { json(response, error instanceof WebBridgeError ? error.status : 500, { error: { code: error instanceof WebBridgeError ? error.code : 'WEB_RUNTIME_ERROR', message: issue(error) } }) }
      catch { response.destroy() }
    }).finally(() => { activeManagement--; lastActivity = Date.now() })
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 1
  // Do not silently truncate a late Origin/authentication header.
  server.maxHeadersCount = 0
  server.maxConnections = 128
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closing = true
      clearInterval(idle)
      const stopped = new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
      await queue
      let safe = !unsafeChrome
      const failures: unknown[] = []
      try { if (bridge !== undefined) await bridge.close(); else await engine?.close() } catch (error) { safe = false; failures.push(error) }
      try { await page?.close() } catch (error) { safe = false; failures.push(error) }
      try { await chrome?.close() } catch (error) { safe = false; failures.push(error) }
      await stopped
      if (safe) {
        await owner?.release()
        const current = await readPrivateJson<RuntimeHandshake>(join(stateDirectory, HANDSHAKE_FILE))
        if (current?.instanceId === instanceId && current.nonce === handshake.nonce) { await rm(join(stateDirectory, HANDSHAKE_FILE)); await syncDirectory(stateDirectory) }
        await runtimeLock.release()
      }
      if (!safe) throw new AggregateError(failures, 'Runtime could not prove all owned browser work stopped; ownership locks remain for offline inspection.')
    })()
    void closePromise.then(resolveClosed, rejectClosed)
    return closePromise
  }
  const idle = setInterval(() => {
    void status().then(current => {
      const bridgeActivity = bridge?.activity()
      if (!closing && activeManagement === 0 && (current.activeClients ?? 0) === 0 && (current.activeTurns ?? 0) === 0
        && (bridgeActivity?.activeTurns ?? 0) === 0 && Date.now() - lastActivity >= configured.idleTimeoutMs) void close().catch(() => undefined)
    })
  }, 250)
  idle.unref()
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('No management address')
    authority = `127.0.0.1:${address.port}`
    handshake.managementURL = `http://${authority}`
    await writePrivateJson(join(stateDirectory, HANDSHAKE_FILE), handshake)
    return { handshake, administration, close, closed }
  } catch (error) {
    await close().catch(() => undefined)
    throw error
  }
}
