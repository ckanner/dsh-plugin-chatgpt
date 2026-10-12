import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BlockTranslator, type AdapterChunk } from '../src/convert/blocks.ts'
import { decodeEvent } from '../src/api/events.ts'
import { streamCases } from './fixtures/stream-cases.ts'

describe('Responses stream identity and terminal reconciliation', () => {
  for (const fixture of streamCases) {
    it(fixture.name, () => {
      const translator = new BlockTranslator({ provider: 'chatgpt', model: 'm', scope: 'test-scope' })
      const chunks: AdapterChunk[] = []
      for (const payload of fixture.events) {
        const event = decodeEvent(JSON.stringify(payload))
        if (event !== undefined) chunks.push(...translator.push(event))
      }
      const starts = chunks.filter(c => c.type === 'block-start')
      const ends = chunks.filter(c => c.type === 'block-end')
      assert.deepEqual(starts.map(c => c.index), fixture.blocks.map((_, i) => i))
      assert.deepEqual(starts.map(start => ends.find(end => end.index === start.index)?.block), fixture.blocks)
      assert.equal(ends.length, starts.length)
      const finish = chunks.at(-1)
      assert.ok(finish?.type === 'finish')
      assert.notEqual(finish.reason.kind, 'error')
      assert.equal(finish.replayState !== undefined, fixture.replay)
    })
  }
})
