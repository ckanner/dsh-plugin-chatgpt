import { randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { validateBinding } from '../web-bridge/protocol.ts'
import { CONFIG_FILE, type ManagedWebRuntimeOptions, type RuntimeConfig } from './types.ts'
import { createPrivateJson, privateDirectory, readPrivateJson, runtimeError } from './storage.ts'

export function validateConfig(value: unknown, stateDirectory: string, provider?: string): RuntimeConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw runtimeError('WEB_RUNTIME_CONFIG', 'Runtime configuration is missing or malformed.')
  const item = value as RuntimeConfig
  if (item.version !== 1 || typeof item.installationId !== 'string' || !item.installationId || item.installationId.length > 256
    || typeof item.profileId !== 'string' || !item.profileId || item.profileId.length > 256
    || typeof item.provider !== 'string' || !item.provider || item.provider.length > 256
    || provider !== undefined && item.provider !== provider
    || item.profileDirectory !== join(stateDirectory, 'chrome-profile')
    || typeof item.enabled !== 'boolean' || typeof item.setupPending !== 'boolean'
    || !Number.isSafeInteger(item.idleTimeoutMs) || item.idleTimeoutMs < 1000 || item.idleTimeoutMs > 86_400_000
    || item.chromeExecutable !== undefined && (typeof item.chromeExecutable !== 'string' || !item.chromeExecutable || !isAbsolute(item.chromeExecutable) || item.chromeExecutable.length > 4096)
    || item.maxInputBytes !== undefined && (!Number.isSafeInteger(item.maxInputBytes) || item.maxInputBytes < 1024 || item.maxInputBytes > 16 * 1024 * 1024)
    || item.account !== undefined && (typeof item.account !== 'string' || item.account.length > 1024)) {
    throw runtimeError('WEB_RUNTIME_CONFIG', 'Runtime identity, provider, profile or limits do not match this installation.')
  }
  if (item.binding !== undefined) {
    const binding = validateBinding(item.binding)
    if (binding.installationId !== item.installationId || binding.profileId !== item.profileId || binding.provider !== item.provider) throw runtimeError('WEB_RUNTIME_CONFIG', 'The saved account binding belongs to another installation.')
  }
  return structuredClone(item)
}

export async function loadConfig(stateDirectory: string, provider?: string): Promise<RuntimeConfig | undefined> {
  const value = await readPrivateJson<unknown>(join(stateDirectory, CONFIG_FILE))
  return value === undefined ? undefined : validateConfig(value, stateDirectory, provider)
}

export async function initializeConfig(options: ManagedWebRuntimeOptions): Promise<{ stateDirectory: string, config: RuntimeConfig }> {
  const stateDirectory = await privateDirectory(options.stateDirectory, true)
  const profileDirectory = await privateDirectory(join(stateDirectory, 'chrome-profile'), true)
  if (profileDirectory !== join(stateDirectory, 'chrome-profile')) throw runtimeError('WEB_RUNTIME_PROFILE', 'A dedicated runtime profile cannot alias a different browser profile.')
  const config = validateConfig({
    version: 1, installationId: randomUUID(), profileId: randomUUID(), provider: options.provider,
    profileDirectory, enabled: false, setupPending: true, idleTimeoutMs: options.idleTimeoutMs ?? 300_000,
    ...options.chromeExecutable === undefined ? {} : { chromeExecutable: resolve(options.chromeExecutable) },
    ...options.maxInputBytes === undefined ? {} : { maxInputBytes: options.maxInputBytes },
  }, stateDirectory, options.provider)
  await createPrivateJson(join(stateDirectory, CONFIG_FILE), config)
  return { stateDirectory, config: (await loadConfig(stateDirectory, options.provider))! }
}
