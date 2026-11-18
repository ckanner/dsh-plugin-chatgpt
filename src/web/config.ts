import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { budgetPolicy, DEFAULT_WEB_BUDGET, exactKeys, nonempty, objectValue, type WebBudgetPolicy, WebPolicyError } from './policy.ts'
import { WebStore } from './store.ts'
import type { WebConnection, WebContextPolicy } from './browser/types.ts'
import { DEFAULT_WEB_IMAGE_LIMITS, imageLimits, type WebImageLimits } from './image-policy.ts'

export interface WebSettings {
  version: 1
  enabled: boolean
  activeConnection: string
  connections: Record<string, WebConnection>
  contextPolicy: WebContextPolicy
  budget: WebBudgetPolicy
  imagePolicy: WebImageLimits
}

export function defaultWebSettings(stateDir: string): WebSettings {
  return {
    version: 1, enabled: false, activeConnection: 'default', contextPolicy: 'project-only',
    connections: {
      default: {
        id: 'default', browserPath: process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/google-chrome',
        profilePath: join(resolve(stateDir), 'web-browser'), stateDir: join(resolve(stateDir), 'web-runtime'), accountFingerprint: '',
      },
    },
    budget: { ...DEFAULT_WEB_BUDGET },
    imagePolicy: { ...DEFAULT_WEB_IMAGE_LIMITS },
  }
}

export function parseWebSettings(input: unknown): WebSettings {
  const raw = objectValue(input, 'web settings')
  exactKeys(raw, ['version', 'enabled', 'activeConnection', 'connections', 'contextPolicy', 'budget', 'imagePolicy'], 'web settings')
  if (raw.version !== 1 || typeof raw.enabled !== 'boolean') throw new WebPolicyError('unsupported Web settings version or enabled value')
  const activeConnection = nonempty(raw.activeConnection, 'activeConnection', 64)
  const entries = objectValue(raw.connections, 'connections')
  if (Object.keys(entries).length > 16) throw new WebPolicyError('too many Web connections')
  const connections: Record<string, WebConnection> = Object.create(null) as Record<string, WebConnection>
  for (const [key, value] of Object.entries(entries)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) throw new WebPolicyError('invalid connection name')
    const connection = objectValue(value, 'connection')
    exactKeys(connection, ['id', 'browserPath', 'profilePath', 'stateDir', 'accountFingerprint'], 'connection')
    if (connection.id !== key) throw new WebPolicyError('connection key and id differ')
    const paths = ['browserPath', 'profilePath', 'stateDir'] as const
    for (const name of paths) if (!isAbsolute(nonempty(connection[name], name))) throw new WebPolicyError(`${name} must be absolute`)
    const profilePath = resolve(connection.profilePath as string)
    const stateDir = resolve(connection.stateDir as string)
    if (profilePath === stateDir || profilePath === homedir() || stateDir === homedir() || profilePath === '/' || stateDir === '/') throw new WebPolicyError('browser and state directories must be dedicated, separate directories')
    if (typeof connection.accountFingerprint !== 'string' || !/^(?:[a-f0-9]{64})?$/.test(connection.accountFingerprint)) throw new WebPolicyError('accountFingerprint must be empty or an observed SHA-256 identity')
    connections[key] = { id: key, browserPath: connection.browserPath as string, profilePath, stateDir, accountFingerprint: connection.accountFingerprint }
  }
  if (!Object.hasOwn(connections, activeConnection)) throw new WebPolicyError('activeConnection does not exist')
  if (raw.contextPolicy !== 'project-only' && raw.contextPolicy !== 'personalized') throw new WebPolicyError('unknown hosted-context policy')
  return { version: 1, enabled: raw.enabled, activeConnection, connections, contextPolicy: raw.contextPolicy, budget: budgetPolicy(raw.budget), imagePolicy: imageLimits(raw.imagePolicy) }
}

/** Profile-provided settings win; card settings otherwise persist in the plugin's private directory. */
export class WebSettingsStore {
  private readonly store: WebStore
  private readonly stateDir: string
  private readonly configured: (() => unknown) | undefined
  private readonly changed: (() => void) | undefined
  constructor(stateDir: string, configured?: () => unknown, changed?: () => void) {
    this.stateDir = stateDir
    this.configured = configured
    this.changed = changed
    this.store = new WebStore(join(resolve(stateDir), 'web-settings'))
  }
  async read(): Promise<WebSettings> {
    const explicit = this.configured?.()
    if (explicit !== undefined) return parseWebSettings(explicit)
    return parseWebSettings(await this.store.read('settings', 'current') ?? defaultWebSettings(this.stateDir))
  }
  managedByProfile(): boolean { return this.configured?.() !== undefined }
  async save(value: unknown): Promise<WebSettings> {
    if (this.configured?.() !== undefined) throw new WebPolicyError('Web settings are managed by the DSH profile; edit that profile')
    const settings = parseWebSettings(value)
    await this.store.locked('settings', 'current', async () => { await this.store.write('settings', 'current', settings) })
    this.changed?.()
    return settings
  }
}
