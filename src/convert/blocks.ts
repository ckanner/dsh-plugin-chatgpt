/** Responses item indexes remain distinct across interleaved text, reasoning and tools. */
import type { ResponsesEvent, ResponsesUsage } from '../api/events.ts'
import { createReplay, outputBlock, type OutputItem, type ReplayBlock, type ReplayContext, type ReplayEnvelope } from './replay.ts'

export type ToolCallBlock = Extract<ReplayBlock, { type: 'tool-call' }>
export type TextBlock = { type: 'text', text: string }
export type ReasoningBlock = { type: 'reasoning', text: string }

export type AdapterChunk =
  | { type: 'block-start', index: number, blockType: 'text' | 'reasoning' | 'tool-call' }
  | { type: 'text-delta', index: number, text: string }
  | { type: 'reasoning-delta', index: number, text: string }
  | { type: 'tool-call-delta', index: number, id: string, name?: string, argumentsDelta: string }
  | { type: 'block-end', index: number, block: ReplayBlock }
  | { type: 'usage', usage: ResponsesUsage }
  | {
    type: 'finish'
    reason: { kind: 'stop' } | { kind: 'tool-calls' } | { kind: 'max-tokens' }
      | { kind: 'error', failure: { message: string, code?: string } }
    replayState?: ReplayEnvelope
  }

interface BlockState {
  index: number
  block: ReplayBlock
  closed: boolean
}

export class BlockTranslator {
  private readonly states: BlockState[] = []
  private readonly wire = new Map<number, BlockState>()
  private readonly items = new Map<number, OutputItem>()
  private unindexed: BlockState | undefined
  private terminal = false
  private readonly context: ReplayContext | undefined

  constructor(context?: ReplayContext) {
    this.context = context
  }

  private open(block: ReplayBlock, chunks: AdapterChunk[], wireIndex?: number): BlockState {
    const state: BlockState = { index: this.states.length, block, closed: false }
    this.states.push(state)
    if (wireIndex !== undefined) this.wire.set(wireIndex, state)
    chunks.push({ type: 'block-start', index: state.index, blockType: block.type })
    return state
  }

  private close(state: BlockState | undefined): AdapterChunk[] {
    if (state === undefined || state.closed) return []
    state.closed = true
    return [{ type: 'block-end', index: state.index, block: { ...state.block } }]
  }

  private item(index: number, item: OutputItem, done: boolean): AdapterChunk[] {
    const chunks: AdapterChunk[] = []
    const block = outputBlock(item)
    const state = this.wire.get(index) ?? this.open(block, chunks, index)
    if (state.block.type !== block.type) throw new Error('Responses changed an output item type during streaming')
    if (done) {
      this.items.set(index, item)
      if (!state.closed) state.block = block
      chunks.push(...this.close(state))
    }
    return chunks
  }

  private append(kind: 'text' | 'reasoning', delta: string, wireIndex?: number): AdapterChunk[] {
    const chunks: AdapterChunk[] = []
    let state = wireIndex === undefined ? this.unindexed : this.wire.get(wireIndex)
    if (state === undefined || wireIndex === undefined && (state.closed || state.block.type !== kind)) {
      state = this.open({ type: kind, text: '' }, chunks, wireIndex)
    }
    if (wireIndex === undefined) this.unindexed = state
    if (state.closed) return chunks
    if (state.block.type !== kind) throw new Error('Responses delta does not match its output item')
    state.block.text += delta
    chunks.push({ type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index: state.index, text: delta })
    return chunks
  }

  push(event: ResponsesEvent): AdapterChunk[] {
    if (this.terminal) return []
    switch (event.kind) {
      case 'text': return this.append('text', event.delta, event.index)
      case 'reasoning': return this.append('reasoning', event.delta, event.index)
      case 'itemStart': return this.item(event.index, event.item, false)
      case 'itemEnd': return this.item(event.index, event.item, true)
      case 'toolCallStart': {
        const chunks = this.unindexed?.block.type === 'text' ? this.close(this.unindexed) : []
        this.unindexed = undefined
        if (!this.wire.has(event.index)) {
          this.open({ type: 'tool-call', id: event.callId, name: event.name, arguments: '' }, chunks, event.index)
        }
        return chunks
      }
      case 'toolCallDelta': {
        const state = this.wire.get(event.index)
        if (state === undefined || state.closed || state.block.type !== 'tool-call') return []
        state.block.arguments += event.delta
        return [{ type: 'tool-call-delta', index: state.index, id: state.block.id, name: state.block.name, argumentsDelta: event.delta }]
      }
      case 'toolCallEnd': {
        const state = this.wire.get(event.index)
        if (state === undefined || state.closed || state.block.type !== 'tool-call') return []
        state.block.arguments = event.arguments
        return this.close(state)
      }
      case 'completed': {
        const chunks: AdapterChunk[] = []
        // The terminal output is authoritative for opaque metadata. It also
        // covers streams with no deltas and encrypted reasoning without summaries.
        event.output?.forEach((item, index) => chunks.push(...this.item(index, item, true)))
        chunks.push(...this.endAll())
        // SIWC can return output: [] on response.completed even after sending
        // complete output_item.done events. An empty terminal list must not erase
        // the native items already captured from the stream.
        const output = event.output?.length ? event.output : (this.items.size === this.states.length
          ? [...this.items].sort(([a], [b]) => a - b).map(([, item]) => item) : undefined)
        const replayState = this.context === undefined || output === undefined
          ? undefined : createReplay(this.context, output, this.states.map(state => state.block))
        if (event.usage !== undefined) chunks.push({ type: 'usage', usage: event.usage })
        chunks.push({
          type: 'finish',
          reason: { kind: this.states.some(state => state.block.type === 'tool-call') ? 'tool-calls' : 'stop' },
          ...replayState === undefined ? {} : { replayState },
        })
        this.terminal = true
        return chunks
      }
      case 'incomplete':
        this.terminal = true
        return [
          ...this.endAll(),
          ...event.usage === undefined ? [] : [{ type: 'usage' as const, usage: event.usage }],
          { type: 'finish', reason: { kind: 'max-tokens' } },
        ]
      case 'failed':
        this.terminal = true
        return [
          ...this.endAll(),
          ...event.usage === undefined ? [] : [{ type: 'usage' as const, usage: event.usage }],
          { type: 'finish', reason: { kind: 'error', failure: { message: event.message, code: event.code } } },
        ]
      default: return []
    }
  }

  /** Finalize partial display content on interruption, without claiming reusable native state. */
  endAll(): AdapterChunk[] {
    return this.states.flatMap(state => this.close(state))
  }
}
