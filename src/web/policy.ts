import { createHash } from 'node:crypto'

export const WEB_MODEL_ID = 'gpt-6-pro-web'
export const WEB_EFFORT = 'pro'
export const WEB_PROTOCOL = 'dsh-chatgpt-web/1'

/** Policy estimates are local limits, never claims about the ChatGPT context window. */
export interface WebBudgetPolicy {
  version: string
  maxInputBytes: number
  outputReserveBytes: number
  maxResponseBytes: number
  maxHistoryBytes: number
  maxTurns: number
  maxGenerations: number
  maxToolCalls: number
  maxJsonDepth: number
  wallTimeoutMs: number
}

export const DEFAULT_WEB_BUDGET: Readonly<WebBudgetPolicy> = Object.freeze({
  version: 'web-local-byte-budget/1',
  maxInputBytes: 96 * 1024,
  outputReserveBytes: 32 * 1024,
  maxResponseBytes: 1024 * 1024,
  maxHistoryBytes: 256 * 1024,
  maxTurns: 24,
  maxGenerations: 16,
  maxToolCalls: 16,
  maxJsonDepth: 48,
  wallTimeoutMs: 60 * 60 * 1000,
})

export class WebPolicyError extends Error {
  readonly code: string
  readonly reason: string
  constructor(reason: string, code = 'INVALID_REQUEST') {
    super(`ChatGPT Web: ${reason}`)
    this.name = 'WebPolicyError'
    this.code = code
    this.reason = reason
  }
}

export function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WebPolicyError(`${label} must be an object`)
  return value as Record<string, unknown>
}

export function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new WebPolicyError(`${label} has an unknown field: ${key}`)
}

export function nonempty(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || value.includes('\0')) {
    throw new WebPolicyError(`${label} must be a nonempty bounded string`)
  }
  return value
}

export function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new WebPolicyError(`${label} is outside its supported range`)
  return value as number
}

export function budgetPolicy(value: unknown = DEFAULT_WEB_BUDGET): WebBudgetPolicy {
  const raw = objectValue(value, 'budget')
  exactKeys(raw, Object.keys(DEFAULT_WEB_BUDGET), 'budget')
  const policy = {
    version: nonempty(raw.version, 'budget.version', 120),
    maxInputBytes: integer(raw.maxInputBytes, 'maxInputBytes', 4096, 4 * 1024 * 1024),
    outputReserveBytes: integer(raw.outputReserveBytes, 'outputReserveBytes', 1024, 1024 * 1024),
    maxResponseBytes: integer(raw.maxResponseBytes, 'maxResponseBytes', 1024, 4 * 1024 * 1024),
    maxHistoryBytes: integer(raw.maxHistoryBytes, 'maxHistoryBytes', 8192, 16 * 1024 * 1024),
    maxTurns: integer(raw.maxTurns, 'maxTurns', 1, 256),
    maxGenerations: integer(raw.maxGenerations, 'maxGenerations', 1, 256),
    maxToolCalls: integer(raw.maxToolCalls, 'maxToolCalls', 1, 64),
    maxJsonDepth: integer(raw.maxJsonDepth, 'maxJsonDepth', 4, 64),
    wallTimeoutMs: integer(raw.wallTimeoutMs, 'wallTimeoutMs', 1000, 24 * 60 * 60 * 1000),
  }
  if (policy.maxInputBytes - policy.outputReserveBytes < 4096) throw new WebPolicyError('input budget must leave at least 4096 bytes after the output reserve')
  if (policy.maxHistoryBytes < policy.maxInputBytes + policy.outputReserveBytes) throw new WebPolicyError('history budget must include input and output reserve')
  return policy
}

/** Deterministic, lossless-JSON fingerprints; reject values JSON.stringify would silently discard. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
  }
  throw new WebPolicyError('request contains a non-JSON value')
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

export function webModel(provider: string, policy = DEFAULT_WEB_BUDGET) {
  return {
    provider, id: WEB_MODEL_ID, name: 'GPT-6 Pro · Web',
    description: 'ChatGPT website · GPT-6 + Pro · separate browser connection; local byte budget',
    // Text only until the actual attachment path has passed its own acceptance.
    inputModalities: ['text'] as const,
    badge: { text: 'Web', tone: 'info' as const },
    // Local token-meter hint, not a vendor window claim. The byte guard also
    // measures protocol/tool overhead and remains the final admission check.
    context: { contextWindow: Math.floor((policy.maxInputBytes - policy.outputReserveBytes) / 4) },
    reasoning: { efforts: [{ id: WEB_EFFORT, name: 'Pro' }], defaultEffort: WEB_EFFORT },
    systemPromptUpdate: 'in-history' as const,
  }
}
