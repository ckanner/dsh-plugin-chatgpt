/** Responses item indexes remain distinct across interleaved text, reasoning and tools. */
import type { ResponsesEvent, ResponsesUsage, WireIdentity } from '../api/events.ts'
import { createReplay, outputBlock, outputMatchesBlock, type OutputItem, type ReplayBlock, type ReplayContext, type ReplayEnvelope } from './replay.ts'

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

type BlockChunk = Extract<AdapterChunk, { index: number }>
interface BlockState {
  block: ReplayBlock
  closed: boolean
  localIndex?: number
  wireIndex?: number
  itemId?: string
  native?: OutputItem
  pending: BlockChunk[]
}

export class BlockTranslator {
  private readonly states: BlockState[] = []
  private readonly emitted: BlockState[] = []
  private readonly byIndex = new Map<number, BlockState>()
  private readonly byId = new Map<string, BlockState>()
  private readonly byCall = new Map<string, BlockState>()
  private anonymous: BlockState | undefined
  private hasAnonymous = false
  private replayable = true
  private terminal = false
  private readonly context: ReplayContext | undefined

  constructor(context?: ReplayContext) {
    this.context = context
  }

  private find(identity: WireIdentity, callId?: string): BlockState | undefined {
    const identified = identity.itemId === undefined ? undefined : this.byId.get(identity.itemId)
    const called = callId === undefined ? undefined : this.byCall.get(callId)
    const indexed = identity.index === undefined ? undefined : this.byIndex.get(identity.index)
    if (identified !== undefined) return identified
    if (called !== undefined) return called
    return indexed !== undefined && identity.itemId !== undefined && indexed.itemId !== undefined
      && indexed.itemId !== identity.itemId ? undefined : indexed
  }

  private bind(state: BlockState, identity: WireIdentity): void {
    if (identity.itemId !== undefined && state.itemId === undefined) {
      state.itemId = identity.itemId
      this.byId.set(identity.itemId, state)
    }
    if (identity.index !== undefined) {
      const indexed = this.byIndex.get(identity.index)
      if (indexed !== undefined && indexed !== state
        || state.wireIndex !== undefined && state.wireIndex !== identity.index) {
        this.replayable = false
      } else {
        state.wireIndex = identity.index
        this.byIndex.set(identity.index, state)
      }
    }
  }

  private open(block: ReplayBlock, identity: WireIdentity): BlockState {
    const state: BlockState = { block, closed: false, pending: [] }
    this.states.push(state)
    this.bind(state, identity)
    if (block.type === 'tool-call') this.byCall.set(block.id, state)
    if (identity.index === undefined && identity.itemId === undefined && block.type !== 'tool-call') {
      this.hasAnonymous = true
      this.anonymous = state
    }
    return state
  }

  private close(state: BlockState): void {
    if (state.closed) return
    state.closed = true
    state.pending.push({ type: 'block-end', index: -1, block: { ...state.block } })
  }

  /** A gap is buffered so a late earlier item can still precede it in DSH's first-seen order. */
  private flush(force = false): AdapterChunk[] {
    let ordered: BlockState[]
    if (this.hasAnonymous) ordered = this.states
    else if (force) {
      ordered = this.states.every(state => state.wireIndex !== undefined)
        ? [...this.states].sort((a, b) => a.wireIndex! - b.wireIndex!) : this.states
    } else {
      ordered = []
      // Unnumbered identified items await an index or the terminal snapshot.
      if (this.states.some(state => state.wireIndex === undefined)) return []
      for (let index = 0; this.byIndex.has(index); index++) ordered.push(this.byIndex.get(index)!)
    }
    const chunks: AdapterChunk[] = []
    for (const state of ordered) {
      if (state.localIndex === undefined) {
        state.localIndex = this.emitted.length
        this.emitted.push(state)
        chunks.push({ type: 'block-start', index: state.localIndex, blockType: state.block.type })
      }
      for (const chunk of state.pending.splice(0)) chunks.push({ ...chunk, index: state.localIndex })
    }
    return chunks
  }

  private fits(state: BlockState, item: OutputItem): boolean {
    const block = outputBlock(item)
    if (block.type !== state.block.type) return false
    if (state.closed || block.type === 'reasoning' && block.text.length === 0) return outputMatchesBlock(item, state.block)
    if (block.type === 'tool-call' && state.block.type === 'tool-call') {
      return block.id === state.block.id && block.name === state.block.name && block.arguments.startsWith(state.block.arguments)
    }
    return block.type !== 'tool-call' && state.block.type !== 'tool-call' && block.text.startsWith(state.block.text)
  }

  private finishItem(state: BlockState, item: OutputItem): void {
    const block = outputBlock(item)
    if (state.block.type !== block.type) { this.replayable = false; return }
    if (!state.closed) {
      // Reasoning previews can exist only in deltas; a metadata-only done item
      // must not erase that already streamed display text.
      if (!(block.type === 'reasoning' && block.text.length === 0)) state.block = block
      this.close(state)
    }
    if (outputMatchesBlock(item, state.block)) state.native = item
    else this.replayable = false
  }

  private item(identity: WireIdentity, item: OutputItem, done: boolean): void {
    const block = outputBlock(item)
    let state = this.find(identity, block.type === 'tool-call' ? block.id : undefined)
    if (state === undefined && done) {
      // Recover an anonymous delta stream only when a unique unfinished block
      // agrees with the final content; never correlate two arbitrary item-zero fallbacks.
      const candidates = this.states.filter(s => !s.closed && s.itemId === undefined
        && s.wireIndex === undefined && this.fits(s, item))
      if (candidates.length === 1) state = candidates[0]
    }
    if (state === undefined) {
      state = this.open(block.type === 'tool-call' ? { ...block, arguments: '' } : { ...block, text: '' }, identity)
    } else this.bind(state, identity)
    if (state.block.type !== block.type) { this.replayable = false; return }
    if (done) this.finishItem(state, item)
  }

  private append(kind: 'text' | 'reasoning', delta: string, identity: WireIdentity): void {
    const identified = identity.index !== undefined || identity.itemId !== undefined
    let state = identified ? this.find(identity) : this.anonymous
    if (state === undefined || !identified && (state.closed || state.block.type !== kind)) {
      state = this.open({ type: kind, text: '' }, identity)
    } else this.bind(state, identity)
    if (!identified) this.anonymous = state
    if (state.closed) return
    if (state.block.type !== kind) { this.replayable = false; return }
    state.block.text += delta
    state.pending.push({ type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index: -1, text: delta })
  }

  /** Positions may introduce missing items only after the snapshot agrees with every known identity. */
  private completeSnapshot(output: OutputItem[]): boolean {
    const ids = output.map(item => typeof item['id'] === 'string' ? item['id'] : undefined).filter(id => id !== undefined)
    if (new Set(ids).size !== ids.length) return false
    // Without streamed positions, an array may itself be reordered. Its IDs
    // can backfill metadata but cannot replace the observed item order.
    if (this.states.some(state => state.wireIndex === undefined)) return false
    return this.states.every(state => {
      const callId = state.block.type === 'tool-call' ? state.block.id : undefined
      const index = state.itemId !== undefined ? output.findIndex(item => item['id'] === state.itemId)
        : callId !== undefined ? output.findIndex(item => item.type === 'function_call' && item['call_id'] === callId)
          : state.wireIndex
      return index !== undefined && index >= 0 && output[index] !== undefined
        && (state.wireIndex === undefined || state.wireIndex === index)
        && (state.localIndex === undefined || state.localIndex === index)
        && this.fits(state, output[index])
    })
  }

  private snapshot(output: OutputItem[] | undefined): void {
    if (!output?.length) return // SIWC's empty terminal output does not erase item.done data.
    if (this.completeSnapshot(output)) {
      // Position/content agreement can recover display text after a missing
      // start event, but cannot prove a missing native identity for opaque replay.
      if (this.states.some(state => state.itemId === undefined && state.block.type !== 'tool-call')) this.replayable = false
      output.forEach((item, index) => this.item({ index, ...typeof item['id'] === 'string' ? { itemId: item['id'] } : {} }, item, true))
      return
    }
    // Partial/reordered snapshots contribute metadata only by native identity.
    for (const item of output) {
      const state = typeof item['id'] === 'string' ? this.byId.get(item['id'])
        : item.type === 'function_call' ? this.byCall.get(String(item['call_id'])) : undefined
      if (state === undefined || state.block.type !== outputBlock(item).type) { this.replayable = false; continue }
      if (state.native?.type === 'reasoning' && item.type === 'reasoning') {
        if (!state.native['encrypted_content'] && typeof item['encrypted_content'] === 'string') {
          state.native = { ...state.native, encrypted_content: item['encrypted_content'] }
        }
      } else if (!this.fits(state, item)) this.replayable = false
      else if (state.native === undefined) this.finishItem(state, item)
    }
  }

  push(event: ResponsesEvent): AdapterChunk[] {
    if (this.terminal) return []
    switch (event.kind) {
      case 'text': this.append('text', event.delta, event); break
      case 'reasoning': this.append('reasoning', event.delta, event); break
      case 'itemStart': this.item(event, event.item, false); break
      case 'itemEnd': this.item(event, event.item, true); break
      case 'toolCallStart': {
        if (this.anonymous?.block.type === 'text') this.close(this.anonymous)
        this.anonymous = undefined
        const state = this.find(event, event.callId)
        if (state === undefined) this.open({ type: 'tool-call', id: event.callId, name: event.name, arguments: '' }, event)
        else this.bind(state, event)
        break
      }
      case 'toolCallDelta':
      case 'toolCallEnd': {
        const state = this.find(event)
        if (state === undefined || state.closed || state.block.type !== 'tool-call') break
        this.bind(state, event)
        if (event.kind === 'toolCallDelta') {
          state.block.arguments += event.delta
          state.pending.push({ type: 'tool-call-delta', index: -1, id: state.block.id, name: state.block.name, argumentsDelta: event.delta })
        } else {
          state.block.arguments = event.arguments
          this.close(state)
        }
        break
      }
      case 'completed': {
        this.snapshot(event.output)
        const chunks = this.endAll()
        const output = this.emitted.map(state => state.native)
        const replayState = this.context === undefined || !this.replayable || output.some(item => item === undefined)
          ? undefined : createReplay(this.context, output as OutputItem[], this.emitted.map(state => state.block))
        if (event.usage !== undefined) chunks.push({ type: 'usage', usage: event.usage })
        chunks.push({
          type: 'finish',
          reason: { kind: this.emitted.some(state => state.block.type === 'tool-call') ? 'tool-calls' : 'stop' },
          ...replayState === undefined ? {} : { replayState },
        })
        this.terminal = true
        return chunks
      }
      case 'incomplete':
      case 'failed': {
        this.terminal = true
        return [
          ...this.endAll(),
          ...event.usage === undefined ? [] : [{ type: 'usage' as const, usage: event.usage }],
          { type: 'finish', reason: event.kind === 'incomplete' ? { kind: 'max-tokens' } : { kind: 'error', failure: { message: event.message, code: event.code } } },
        ]
      }
      default: break
    }
    return this.flush()
  }

  /** Preserve all received display content when a stream terminates or is interrupted. */
  endAll(): AdapterChunk[] {
    this.states.forEach(state => this.close(state))
    return this.flush(true)
  }
}
