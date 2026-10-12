/**
 * Native Responses history carried through DSH's adapter-private ReplayEnvelope.
 * Transcript edits, pruning, route/model switches and account changes invalidate
 * native replay; durable visible content remains authoritative.
 */
import { createHash } from 'node:crypto'

export type OutputItem = Record<string, unknown> & { type: 'message' | 'reasoning' | 'function_call' }
export type ReplayBlock =
  | { type: 'text' | 'reasoning', text: string }
  | { type: 'tool-call', id: string, name: string, arguments: string }

export interface ReplayContext {
  provider: string
  model: string
  /** Hash of endpoint and stable account registration, never a token. */
  scope: string
}

export interface ReplayEnvelope {
  response: {
    kind: 'chatgpt-responses'
    version: 1
    provider: string
    model: string
    scope: string
    blockCount: number
    output: OutputItem[]
  }
  blocks: { fingerprint: string }[]
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** Validate complete supported items while retaining native IDs, phases and opaque state. */
export function outputItem(value: unknown): OutputItem | undefined {
  const item = record(value)
  if (item === undefined) return undefined
  if (item['id'] !== undefined && typeof item['id'] !== 'string') return undefined
  switch (item['type']) {
    case 'message':
      if (item['role'] !== 'assistant' || !Array.isArray(item['content'])) return undefined
      if (!item['content'].every(part => {
        const p = record(part)
        return p?.['type'] === 'output_text' && typeof p['text'] === 'string'
          || p?.['type'] === 'refusal' && typeof p['refusal'] === 'string'
      })) return undefined
      break
    case 'reasoning':
      if (!Array.isArray(item['summary']) || !item['summary'].every(part => {
        const p = record(part)
        return p?.['type'] === 'summary_text' && typeof p['text'] === 'string'
      })) return undefined
      if (item['encrypted_content'] != null && typeof item['encrypted_content'] !== 'string') return undefined
      break
    case 'function_call':
      if (['call_id', 'name', 'arguments'].some(key => typeof item[key] !== 'string')) return undefined
      break
    default: return undefined
  }
  return structuredClone(item) as OutputItem
}

export function outputItems(value: unknown): OutputItem[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.map(outputItem)
  return items.every((item): item is OutputItem => item !== undefined) ? items : undefined
}

/** One native item is one durable block, including reasoning without a visible summary. */
export function outputBlock(item: OutputItem): ReplayBlock {
  if (item.type === 'function_call') {
    return { type: 'tool-call', id: String(item['call_id']), name: String(item['name']), arguments: String(item['arguments']) }
  }
  const parts = (item[item.type === 'message' ? 'content' : 'summary'] ?? []) as Record<string, unknown>[]
  const text = parts.map(part => String(part['text'] ?? part['refusal'] ?? '')).join(item.type === 'reasoning' ? '\n\n' : '')
  return { type: item.type === 'message' ? 'text' : 'reasoning', text }
}

/** Ignore host-only annotations; bind replay to every visible block's content. */
function fingerprint(block: { type: string, [key: string]: unknown }): string {
  const content = block.type === 'tool-call'
    ? [block.type, block['id'], block['name'], block['arguments']]
    : [block.type, block['text']]
  return createHash('sha256').update(JSON.stringify(content)).digest('hex')
}

export function createReplay(context: ReplayContext, output: OutputItem[], blocks: ReplayBlock[]): ReplayEnvelope | undefined {
  if (output.length !== blocks.length) return undefined
  // Terminal snapshots may add encryption, but cannot silently change finalized
  // text or executable arguments in the host's transcript.
  if (output.some((item, index) => fingerprint(outputBlock(item)) !== fingerprint(blocks[index]!))) return undefined
  return {
    response: { kind: 'chatgpt-responses', version: 1, ...context, blockCount: blocks.length, output: structuredClone(output) },
    blocks: blocks.map(block => ({ fingerprint: fingerprint(block) })),
  }
}

export function replayOutput(
  value: unknown,
  blocks: readonly { type: string, [key: string]: unknown }[],
  context: ReplayContext | undefined,
): OutputItem[] | undefined {
  if (context === undefined) return undefined
  const envelope = record(value)
  const response = record(envelope?.['response'])
  const metadata = envelope?.['blocks']
  if (response?.['kind'] !== 'chatgpt-responses' || response['version'] !== 1
    || response['provider'] !== context.provider || response['model'] !== context.model
    || response['scope'] !== context.scope || response['blockCount'] !== blocks.length
    || !Array.isArray(metadata) || metadata.length !== blocks.length) return undefined
  if (blocks.some((block, index) => record(metadata[index])?.['fingerprint'] !== fingerprint(block))) return undefined
  const output = outputItems(response['output'])
  if (output === undefined || output.length !== blocks.length) return undefined
  if (output.some((item, index) => fingerprint(outputBlock(item)) !== fingerprint(blocks[index]!))) return undefined
  // store:false cannot resolve a reasoning ID without its encrypted contents.
  return output.filter(item => item.type !== 'reasoning'
    || typeof item['encrypted_content'] === 'string' && item['encrypted_content'].length > 0)
}

/** Stable across token renewal and isolated across account registrations/endpoints. */
export function accountScope(endpoint: string, clientId: string, subject?: string): string {
  return createHash('sha256').update(JSON.stringify([endpoint.replace(/\/+$/, ''), clientId, subject ?? ''])).digest('hex')
}

/** Sessionless calls use implicit caching without a global shared key. */
export function sessionCacheKey(scope: string, provider: string, sessionId?: string, purpose?: string): string | undefined {
  if (!sessionId) return undefined
  return createHash('sha256').update(JSON.stringify([scope, provider, sessionId, purpose ?? 'agent'])).digest('hex')
}
