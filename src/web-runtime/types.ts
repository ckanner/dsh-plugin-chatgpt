import { readFileSync } from 'node:fs'
import type { TurnInspection, WebBinding } from '../web-bridge/contracts.ts'

export const RUNTIME_PROTOCOL_VERSION = 1 as const
export const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version
export const CONFIG_FILE = 'runtime.json'
export const HANDSHAKE_FILE = 'runtime-handshake.json'
export const START_LOCK = '.runtime-owner'
/** Management returns the most recent summaries, newest first; no response/lease data. */
export const WEB_RUNTIME_RECENT_TURNS = 100

export interface ManagedWebRuntimeOptions {
  stateDirectory: string
  provider: string
  chromeExecutable?: string
  /** Attach to a user-launched Chrome CDP endpoint instead of spawning an owned browser. */
  attachCdpUrl?: string
  /** Legacy project-only isolation; default false uses a fresh ordinary Chat. */
  projectIsolation?: boolean
  maxInputBytes?: number
  idleTimeoutMs?: number
  bridgeCommand?: { executable: string, args: string[] }
}

/** Only explicitly supplied setup values replace saved launch configuration. */
export type RuntimeLaunchSettings = Pick<ManagedWebRuntimeOptions, 'chromeExecutable' | 'maxInputBytes' | 'idleTimeoutMs'>

export interface WebRuntimeStatus {
  phase: 'not-initialized' | 'stopped' | 'starting' | 'login-required' | 'verification-required' | 'ready' | 'recovery-required' | 'error'
  enabled: boolean
  ready: boolean
  issues: string[]
  account?: string
  binding?: WebBinding
  profileDirectory?: string
  activeClients?: number
  activeTurns?: number
}

export interface RuntimeConfig {
  version: 1
  installationId: string
  profileId: string
  provider: string
  profileDirectory: string
  enabled: boolean
  setupPending: boolean
  chromeExecutable?: string
  attachCdpUrl?: string
  projectIsolation?: boolean
  maxInputBytes?: number
  idleTimeoutMs: number
  binding?: WebBinding
  account?: string
}

export interface RuntimeHandshake {
  protocolVersion: 1
  packageVersion: string
  instanceId: string
  nonce: string
  stateDirectory: string
  profileDirectory: string
  installationId: string
  profileId: string
  provider: string
  managementURL: string
  adminToken: string
  binding?: WebBinding
}

export interface RuntimeConnection {
  url: string
  token: string
  binding: WebBinding
  instanceId: string
}

export interface RuntimeAdministration {
  status(): Promise<WebRuntimeStatus>
  setup(settings?: RuntimeLaunchSettings): Promise<WebRuntimeStatus>
  verify(): Promise<WebRuntimeStatus>
  setEnabled(enabled: boolean): Promise<WebRuntimeStatus>
  connection(): Promise<RuntimeConnection>
  listTurns(): Promise<TurnInspection[]>
  inspectTurn(turnId: string): Promise<TurnInspection>
  recoverTurn(turnId: string): Promise<TurnInspection>
  discardTurn(turnId: string): Promise<TurnInspection>
}
