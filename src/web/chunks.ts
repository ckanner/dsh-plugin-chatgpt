import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { WebDelivery } from './session-coordinator.ts'

/** One immutable captured response, projected only after whole-answer validation. */
export function deliveryChunks(delivery: WebDelivery): StreamChunk[] {
  const chunks: StreamChunk[] = []
  for (const [index, block] of delivery.blocks.entries()) {
    if (block.type === 'text') {
      chunks.push({ type: 'block-start', index, blockType: 'text' }, { type: 'text-delta', index, text: String(block.text) })
    } else {
      chunks.push({ type: 'block-start', index, blockType: 'tool-call' }, { type: 'tool-call-delta', index, id: String(block.id) as never, name: String(block.name), argumentsDelta: String(block.arguments) })
    }
    chunks.push({ type: 'block-end', index, block: block as never })
  }
  // The website exposes no authoritative token count. No usage chunk is emitted.
  chunks.push({ type: 'finish', reason: { kind: delivery.blocks.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' }, replayState: { response: delivery.reference } })
  return chunks
}
