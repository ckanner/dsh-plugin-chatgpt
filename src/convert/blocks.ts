/**
 * Turning decoded Responses events into an ordered block stream.
 *
 * The harness reads a response as numbered content blocks that each start, emit
 * deltas, and end with the block's *final* content. The wire format numbers its
 * own items instead, and a model may interleave them — reasoning, then text,
 * then a tool call, then more text. So something has to decide when one block
 * closes and the next opens, and getting that wrong is visible: text arriving
 * under a tool call's index, or a block that never ends, corrupts the transcript
 * rather than merely looking odd.
 *
 * The rules here are deliberately simple and stated once:
 *
 * - Block numbers are allocated in first-seen order and never reused, because
 *   the harness reads blocks in order.
 * - A block ends when its content is complete, and its closing chunk carries the
 *   accumulated content — for a cut-off stream that is what keeps the partial
 *   answer rather than discarding it.
 * - Text and reasoning each own at most one open block at a time. A text delta
 *   arriving after a tool call opens a *new* text block rather than reopening
 *   the closed one; a model that speaks, calls a tool, and speaks again produced
 *   three blocks, not one.
 * - A failed or incomplete response still closes every open block, so the
 *   caller's `finish` never follows a dangling block.
 *
 * @module dsh-plugin-chatgpt/convert/blocks
 */

import type { ResponsesEvent } from '../api/events.ts'

/** A closed tool-call block, as the harness reads it. */
export interface ToolCallBlock {
  type: 'tool-call'
  id: string
  name: string
  arguments: string
}

/** A closed text block. */
export interface TextBlock {
  type: 'text'
  text: string
}

/** A closed reasoning block. */
export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

/** One chunk the harness will read, addressed by block index. */
export type AdapterChunk =
  | { type: 'block-start', index: number, blockType: 'text' | 'reasoning' | 'tool-call' }
  | { type: 'text-delta', index: number, text: string }
  | { type: 'reasoning-delta', index: number, text: string }
  | { type: 'tool-call-delta', index: number, id: string, name?: string, argumentsDelta: string }
  | { type: 'block-end', index: number, block: TextBlock | ReasoningBlock | ToolCallBlock }
  | {
    type: 'finish'
    reason: { kind: 'stop' } | { kind: 'tool-calls' } | { kind: 'max-tokens' }
      | { kind: 'error', failure: { message: string, code?: string } }
  }

/** An open block, whatever kind it is. */
type OpenBlock =
  | { kind: 'text', index: number, text: string }
  | { kind: 'reasoning', index: number, text: string }
  | { kind: 'tool-call', index: number, id: string, name: string, arguments: string }

/**
 * Stateful translation of one response's event sequence.
 *
 * One instance serves exactly one response: the numbering it allocates is
 * meaningful only within that response, so reusing an instance across calls
 * would continue numbering into the next answer.
 */
export class BlockTranslator {
  private nextIndex = 0
  private text: OpenBlock | undefined
  private reasoning: OpenBlock | undefined
  private readonly toolCalls = new Map<number, OpenBlock>()
  /** Wire item index to the block allocated for it. */
  private readonly wireToBlock = new Map<number, number>()
  private sawToolCall = false

  /**
   * Translate one decoded event.
   * @param event - the decoded wire event.
   * @returns the chunks it produces, in order; empty when it produces none.
   */
  push(event: ResponsesEvent): AdapterChunk[] {
    switch (event.kind) {
      case 'text':
        return this.appendText(event.delta)
      case 'reasoning':
        return this.appendReasoning(event.delta)
      case 'toolCallStart': {
        // Closing the text block first keeps the transcript in the order the
        // model produced it: whatever it said before the call precedes it.
        const chunks = this.endText()
        const index = this.nextIndex++
        this.toolCalls.set(index, { kind: 'tool-call', index, id: event.callId, name: event.name, arguments: '' })
        this.wireToBlock.set(event.index, index)
        this.sawToolCall = true
        chunks.push({ type: 'block-start', index, blockType: 'tool-call' })
        return chunks
      }
      case 'toolCallDelta': {
        const open = this.toolFor(event.index)
        if (open === undefined) return []
        open.arguments += event.delta
        return [{
          type: 'tool-call-delta',
          index: open.index,
          id: open.id,
          name: open.name,
          argumentsDelta: event.delta,
        }]
      }
      case 'toolCallEnd': {
        const open = this.toolFor(event.index)
        if (open === undefined) return []
        // The done event carries the authoritative argument string. Prefer it
        // over the accumulation, which a server that re-sends a delta would
        // otherwise leave doubled.
        if (event.arguments.length > 0) open.arguments = event.arguments
        return this.endTool(open)
      }
      case 'completed':
        return [
          ...this.endAll(),
          { type: 'finish', reason: this.sawToolCall ? { kind: 'tool-calls' } : { kind: 'stop' } },
        ]
      case 'incomplete':
        return [...this.endAll(), { type: 'finish', reason: { kind: 'max-tokens' } }]
      case 'failed':
        return [
          ...this.endAll(),
          { type: 'finish', reason: { kind: 'error', failure: { message: event.message, code: event.code } } },
        ]
      default:
        return []
    }
  }

  /**
   * Close every open block.
   *
   * A caller whose turn was cancelled must still end the blocks it opened, or
   * the harness holds one that never closes. Public because that is a decision
   * the stream loop makes, not something the final wire event implies.
   *
   * Endings are emitted in block order regardless of which kind was open: the
   * harness reads blocks as a sequence, so a reasoning block numbered below an
   * open text block must close first.
   * @returns the closing chunks, in block order.
   */
  endAll(): AdapterChunk[] {
    const chunks = [...this.endText(), ...this.endReasoning()]
    // A tool call still open at the end of a stream was cut off mid-call; end it
    // so the caller sees the partial arguments rather than nothing.
    for (const open of this.activeTools()) chunks.push(...this.endTool(open))
    return chunks.sort((left, right) => left.index - right.index)
  }

  /** Open or continue the text block. */
  private appendText(delta: string): AdapterChunk[] {
    const chunks: AdapterChunk[] = []
    if (this.text === undefined) {
      const index = this.nextIndex++
      this.text = { kind: 'text', index, text: '' }
      chunks.push({ type: 'block-start', index, blockType: 'text' })
    }
    this.text.text += delta
    chunks.push({ type: 'text-delta', index: this.text.index, text: delta })
    return chunks
  }

  /** Open or continue the reasoning block. */
  private appendReasoning(delta: string): AdapterChunk[] {
    const chunks: AdapterChunk[] = []
    if (this.reasoning === undefined) {
      const index = this.nextIndex++
      this.reasoning = { kind: 'reasoning', index, text: '' }
      chunks.push({ type: 'block-start', index, blockType: 'reasoning' })
    }
    this.reasoning.text += delta
    chunks.push({ type: 'reasoning-delta', index: this.reasoning.index, text: delta })
    return chunks
  }

  /** Close the text block, reporting its complete text. */
  private endText(): AdapterChunk[] {
    const open = this.text
    if (open === undefined) return []
    this.text = undefined
    return [{ type: 'block-end', index: open.index, block: { type: 'text', text: open.text } }]
  }

  /** Close the reasoning block, reporting its complete text. */
  private endReasoning(): AdapterChunk[] {
    const open = this.reasoning
    if (open === undefined) return []
    this.reasoning = undefined
    return [{ type: 'block-end', index: open.index, block: { type: 'reasoning', text: open.text } }]
  }

  /** The still-open tool calls, in allocation order. */
  private activeTools(): OpenBlock[] {
    return [...this.toolCalls.values()].sort((left, right) => left.index - right.index)
  }

  /** The tool call allocated for one wire item index, when it is still open. */
  private toolFor(wireIndex: number): OpenBlock | undefined {
    const allocated = this.wireToBlock.get(wireIndex)
    return allocated === undefined ? undefined : this.toolCalls.get(allocated)
  }

  /** Close one tool call, removing it so it cannot close twice. */
  private endTool(open: OpenBlock): AdapterChunk[] {
    if (!this.toolCalls.delete(open.index)) return []
    for (const [wire, block] of this.wireToBlock) {
      if (block === open.index) this.wireToBlock.delete(wire)
    }
    return [{
      type: 'block-end',
      index: open.index,
      block: { type: 'tool-call', id: open.id, name: open.name, arguments: open.arguments },
    }]
  }
}
