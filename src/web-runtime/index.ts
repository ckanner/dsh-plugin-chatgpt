/** Client facade for the independently running, private Web runtime daemon. */
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lstat } from 'node:fs/promises'
import type { TurnInspection, WebBinding } from '../web-bridge/contracts.ts'
import { WebBridgeError } from '../web-bridge/contracts.ts'
import { canonical, validateBinding } from '../web-bridge/protocol.ts'
import { initializeConfig, loadConfig } from './config.ts'
import { ioCode, privateDirectory, readPrivateJson, runtimeError } from './storage.ts'
import { HANDSHAKE_FILE, PACKAGE_VERSION, RUNTIME_PROTOCOL_VERSION, START_LOCK,
  type ManagedWebRuntimeOptions, type RuntimeConfig, type RuntimeConnection, type RuntimeHandshake, type WebRuntimeStatus } from './types.ts'

export type { ManagedWebRuntimeOptions, WebRuntimeStatus, RuntimeConnection } from './types.ts'
export { WEB_RUNTIME_RECENT_TURNS } from './types.ts'
export { runWebBridgeCli } from './cli.ts'

function endpoint(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw runtimeError('WEB_RUNTIME_HANDSHAKE', 'Runtime management must use a literal loopback endpoint.')
  return url.origin
}

function verifiedHandshake(value: RuntimeHandshake, directory: string, config: RuntimeConfig): RuntimeHandshake {
  if (value === null || typeof value !== 'object' || value.protocolVersion !== RUNTIME_PROTOCOL_VERSION || value.packageVersion !== PACKAGE_VERSION
    || value.stateDirectory !== directory || value.profileDirectory !== config.profileDirectory
    || value.installationId !== config.installationId || value.profileId !== config.profileId || value.provider !== config.provider
    || typeof value.instanceId !== 'string' || !value.instanceId || value.instanceId.length > 256
    || typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(value.nonce)
    || typeof value.adminToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(value.adminToken)
    || typeof value.managementURL !== 'string'
    || (value.binding === undefined) !== (config.binding === undefined)) {
    throw runtimeError('WEB_RUNTIME_HANDSHAKE', 'Runtime version, installation or ownership binding does not match. Inspect the existing service before restarting it.')
  }
  endpoint(value.managementURL)
  if (value.binding !== undefined) {
    const binding = validateBinding(value.binding)
    if (binding.installationId !== config.installationId || binding.profileId !== config.profileId || binding.provider !== config.provider
      || config.binding !== undefined && canonical(binding) !== canonical(config.binding)) {
      throw runtimeError('WEB_RUNTIME_HANDSHAKE', 'Runtime account binding differs from the saved profile.')
    }
  }
  return value
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.body || !(response.headers.get('content-type') ?? '').startsWith('application/json')) throw runtimeError('WEB_RUNTIME_PROTOCOL', 'Management returned no bounded JSON response.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > 1024 * 1024) throw runtimeError('WEB_RUNTIME_PROTOCOL', 'Management response exceeded its limit.')
      text += decoder.decode(part.value, { stream: true })
    }
    text += decoder.decode()
    const value: unknown = JSON.parse(text)
    canonical(value)
    return value
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}

export class ManagedWebRuntime {
  private readonly options: ManagedWebRuntimeOptions
  private handshake: RuntimeHandshake | undefined
  private lease: string | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private heartbeatPending: Promise<unknown> | undefined
  private connecting: Promise<RuntimeHandshake> | undefined
  private disposed = false

  constructor(options: ManagedWebRuntimeOptions) {
    if (!options.stateDirectory || !options.provider || options.provider.length > 256) throw runtimeError('WEB_RUNTIME_CONFIG', 'Runtime state directory and provider are required.')
    this.options = { ...options, stateDirectory: resolve(options.stateDirectory),
      ...options.chromeExecutable === undefined ? {} : { chromeExecutable: resolve(options.chromeExecutable) },
      ...options.bridgeCommand === undefined ? {} : { bridgeCommand: { executable: options.bridgeCommand.executable, args: [...options.bridgeCommand.args] } } }
  }

  private assertActive(): void { if (this.disposed) throw runtimeError('WEB_RUNTIME_DISPOSED', 'This runtime client is disposed.') }

  private async request<T>(handshake: RuntimeHandshake, path: string, method = 'GET', value?: unknown, timeout = 45_000): Promise<T> {
    const response = await fetch(`${endpoint(handshake.managementURL)}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { authorization: `Bearer ${handshake.adminToken}`, 'x-web-runtime-instance': handshake.instanceId,
        ...this.lease === undefined ? {} : { 'x-web-admin-lease': this.lease },
        ...value === undefined ? {} : { 'content-type': 'application/json' } },
      ...value === undefined ? {} : { body: canonical(value) },
    })
    if (response.headers.get('x-web-runtime-instance') !== handshake.instanceId
      || response.headers.get('x-web-runtime-nonce') !== handshake.nonce
      || response.headers.get('x-web-runtime-version') !== PACKAGE_VERSION) {
      await response.body?.cancel()
      throw runtimeError('WEB_RUNTIME_HANDSHAKE', 'The live management service did not prove the recorded instance and version.')
    }
    const result = await responseJson(response)
    if (!response.ok) {
      const error = (result as { error?: { code?: unknown, message?: unknown } }).error
      throw new WebBridgeError(typeof error?.code === 'string' ? error.code : 'WEB_RUNTIME_ERROR',
        typeof error?.message === 'string' ? error.message.slice(0, 768) : 'Runtime management failed.', response.status)
    }
    return result as T
  }

  private async current(): Promise<{ directory: string, config?: RuntimeConfig, handshake?: RuntimeHandshake }> {
    const directory = await privateDirectory(this.options.stateDirectory)
    const config = await loadConfig(directory, this.options.provider)
    if (config === undefined) return { directory }
    const value = await readPrivateJson<RuntimeHandshake>(join(directory, HANDSHAKE_FILE))
    return { directory, config, ...value === undefined ? {} : { handshake: verifiedHandshake(value, directory, config) } }
  }

  async status(): Promise<WebRuntimeStatus> {
    this.assertActive()
    try {
      const current = await this.current()
      if (current.config === undefined) return { phase: 'not-initialized', enabled: false, ready: false, issues: [] }
      if (current.handshake !== undefined) {
        try { return await this.request<WebRuntimeStatus>(current.handshake, '/status', 'GET', undefined, 2500) }
        catch { return { phase: 'recovery-required', enabled: current.config.enabled, ready: false,
          issues: ['A private handshake exists but its live owner could not be authenticated. Inspect it; stale locks are not reclaimed automatically.'],
          profileDirectory: current.config.profileDirectory, ...current.config.binding === undefined ? {} : { binding: current.config.binding },
          ...current.config.account === undefined ? {} : { account: current.config.account } } }
      }
      const lock = await lstat(join(current.directory, START_LOCK)).catch(error => { if (ioCode(error) === 'ENOENT') return undefined; throw error })
      return { phase: lock === undefined ? 'stopped' : 'recovery-required', enabled: current.config.enabled, ready: false,
        issues: lock === undefined ? [] : ['Runtime ownership exists without a verified handshake. Inspect incomplete startup or the stale owner.'],
        profileDirectory: current.config.profileDirectory, ...current.config.binding === undefined ? {} : { binding: current.config.binding },
        ...current.config.account === undefined ? {} : { account: current.config.account } }
    } catch (error) {
      if (ioCode(error) === 'ENOENT') return { phase: 'not-initialized', enabled: false, ready: false, issues: [] }
      return { phase: 'error', enabled: false, ready: false,
        issues: [error instanceof WebBridgeError ? error.message.slice(0, 768) : 'Runtime state could not be inspected safely.'] }
    }
  }

  private async ensureDaemon(): Promise<RuntimeHandshake> {
    this.assertActive()
    const current = await this.current()
    if (current.config === undefined) throw runtimeError('WEB_SETUP_REQUIRED', 'Run explicit Web setup first.')
    if (current.handshake !== undefined) {
      try { await this.request(current.handshake, '/status', 'GET', undefined, 2500) }
      catch (cause) { throw runtimeError('WEB_RUNTIME_RECOVERY', 'The recorded daemon owner could not be authenticated. Inspect its private handshake and locks; they are not replaced automatically.', cause) }
      return current.handshake
    }
    let launchError: unknown
    const existingLock = await lstat(join(current.directory, START_LOCK)).catch(error => { if (ioCode(error) === 'ENOENT') return undefined; throw error })
    if (existingLock === undefined) {
      const command = this.options.bridgeCommand
      const executable = command?.executable ?? process.execPath
      const entry = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './cli.ts' : './cli.js', import.meta.url))
      const args = [...command?.args ?? [entry], 'daemon', '--state-directory', current.directory]
      const child = spawn(executable, args, { cwd: current.directory, detached: true, stdio: 'ignore', shell: false })
      child.once('error', error => { launchError = error })
      child.unref()
    }
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      this.assertActive()
      if (launchError !== undefined) throw runtimeError('WEB_RUNTIME_START', 'The configured daemon executable could not be started.', launchError)
      const value = await readPrivateJson<RuntimeHandshake>(join(current.directory, HANDSHAKE_FILE))
      if (value !== undefined) {
        const handshake = verifiedHandshake(value, current.directory, current.config)
        await this.request(handshake, '/status', 'GET', undefined, 2500)
        return handshake
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw runtimeError('WEB_RUNTIME_START', 'No authenticated daemon became ready. Inspect startup and ownership locks; they are not stolen by PID.')
  }

  private async connected(): Promise<RuntimeHandshake> {
    this.assertActive()
    if (this.connecting !== undefined) return this.connecting
    const pending = (async () => {
      const handshake = await this.ensureDaemon()
      if (this.handshake?.instanceId !== handshake.instanceId) { this.lease = undefined; if (this.heartbeat !== undefined) clearInterval(this.heartbeat) }
      this.handshake = handshake
      if (this.lease === undefined) {
        const registration = await this.request<{ clientLeaseId: string, expiresAt: number }>(handshake, '/clients', 'POST', {})
        if (typeof registration.clientLeaseId !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(registration.clientLeaseId) || !Number.isFinite(registration.expiresAt)) throw runtimeError('WEB_RUNTIME_PROTOCOL', 'Invalid management lease.')
        this.lease = registration.clientLeaseId
        this.heartbeat = setInterval(() => {
          if (this.heartbeatPending !== undefined || this.disposed) return
          const heartbeat = this.request(handshake, '/clients/current/heartbeat', 'POST', {}, 5000)
          this.heartbeatPending = heartbeat
          void heartbeat.catch(() => { this.lease = undefined; if (this.heartbeat !== undefined) clearInterval(this.heartbeat) })
            .finally(() => { this.heartbeatPending = undefined })
        }, 20_000)
        this.heartbeat.unref()
      }
      this.assertActive()
      return handshake
    })()
    this.connecting = pending
    try { return await pending } finally { if (this.connecting === pending) this.connecting = undefined }
  }

  async setup(): Promise<WebRuntimeStatus> {
    this.assertActive()
    await initializeConfig(this.options)
    return this.request(await this.connected(), '/setup', 'POST', {
      ...this.options.chromeExecutable === undefined ? {} : { chromeExecutable: this.options.chromeExecutable },
      ...this.options.maxInputBytes === undefined ? {} : { maxInputBytes: this.options.maxInputBytes },
      ...this.options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: this.options.idleTimeoutMs },
    })
  }

  async verify(): Promise<WebRuntimeStatus> { return this.request(await this.connected(), '/verify', 'POST', {}) }
  async setEnabled(enabled: boolean): Promise<WebRuntimeStatus> { return this.request(await this.connected(), '/enabled', 'POST', { enabled }) }

  async connection(): Promise<RuntimeConnection> {
    this.assertActive()
    const current = await this.current()
    if (!current.config?.enabled || current.config.binding === undefined) throw runtimeError('WEB_VERIFICATION_REQUIRED', 'Enable and visibly verify Web Pro before requesting a connection.')
    const handshake = await this.connected()
    const connection = await this.request<RuntimeConnection>(handshake, '/connection')
    endpoint(connection.url)
    if (connection.instanceId !== handshake.instanceId || !/^[A-Za-z0-9_-]{32,256}$/.test(connection.token)
      || canonical(validateBinding(connection.binding)) !== canonical(validateBinding(current.config.binding))) throw runtimeError('WEB_RUNTIME_HANDSHAKE', 'The bridge connection differs from the verified account or runtime instance.')
    return { ...connection, binding: validateBinding(connection.binding) }
  }

  async listTurns(): Promise<TurnInspection[]> { return this.request(await this.connected(), '/turns') }
  async inspectTurn(turnId: string): Promise<TurnInspection> { return this.request(await this.connected(), `/turns/${this.turnPath(turnId)}`) }
  async recoverTurn(turnId: string): Promise<TurnInspection> { return this.request(await this.connected(), `/turns/${this.turnPath(turnId)}/recover`, 'POST', {}) }
  async discardTurn(turnId: string): Promise<TurnInspection> { return this.request(await this.connected(), `/turns/${this.turnPath(turnId)}/discard`, 'POST', {}) }
  private turnPath(turnId: string): string {
    if (!/^turn-[a-f0-9]{64}$/.test(turnId)) throw runtimeError('WEB_RUNTIME_INPUT', 'A journal turn ID is required.')
    return turnId
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    await this.connecting?.catch(() => undefined)
    await this.heartbeatPending?.catch(() => undefined)
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    if (this.handshake !== undefined && this.lease !== undefined) {
      await this.request(this.handshake, '/clients/current', 'DELETE', undefined, 5000).catch(() => undefined)
      this.lease = undefined
    }
  }
}
