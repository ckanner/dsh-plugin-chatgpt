import type { ReplayBlock } from '../../src/convert/replay.ts'

const message = (id: string, text: string) => ({
  type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text }],
})
const done = (item: unknown, index?: number) => ({
  type: 'response.output_item.done', item, ...index === undefined ? {} : { output_index: index },
})
const completed = (output: unknown[]) => ({ type: 'response.completed', response: { output } })

export interface StreamCase {
  name: string
  events: object[]
  blocks: ReplayBlock[]
  replay: boolean
}

/** Provider-shaped fixtures also consumed by the real DSH assembler contract test. */
export const streamCases: StreamCase[] = [
  {
    name: 'a reordered terminal array does not reorder unnumbered streamed items',
    events: [done(message('msg_a', 'Intro')), done(message('msg_b', 'Hello')), completed([message('msg_b', 'Hello'), message('msg_a', 'Intro')])],
    blocks: [{ type: 'text', text: 'Intro' }, { type: 'text', text: 'Hello' }],
    replay: true,
  },
  {
    name: 'index-only recovery restores display order without asserting native replay identity',
    events: [
      { type: 'response.output_text.delta', output_index: 1, delta: 'Hello' },
      completed([message('msg_a', 'Intro'), message('msg_b', 'Hello')]),
    ],
    blocks: [{ type: 'text', text: 'Intro' }, { type: 'text', text: 'Hello' }],
    replay: false,
  },
  {
    name: 'two done items without output_index remain distinct',
    events: [done(message('msg_a', 'Intro')), done(message('msg_b', 'Hello')), completed([])],
    blocks: [{ type: 'text', text: 'Intro' }, { type: 'text', text: 'Hello' }],
    replay: true,
  },
  {
    name: 'a late complete snapshot fills an earlier index without reversing visible order',
    events: [
      { type: 'response.output_text.delta', output_index: 1, item_id: 'msg_b', delta: 'Hello' },
      completed([message('msg_a', 'Intro'), message('msg_b', 'Hello')]),
    ],
    blocks: [{ type: 'text', text: 'Intro' }, { type: 'text', text: 'Hello' }],
    replay: true,
  },
  {
    name: 'a partial terminal array cannot overwrite a different streamed message',
    events: [
      { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_a', delta: 'AAA' },
      { type: 'response.output_text.delta', output_index: 1, item_id: 'msg_b', delta: 'BBB' },
      completed([message('msg_b', 'BBB')]),
    ],
    blocks: [{ type: 'text', text: 'AAA' }, { type: 'text', text: 'BBB' }],
    replay: false,
  },
  {
    name: 'a conflicting terminal item does not turn completion into an exception',
    events: [
      { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'rs_a', delta: 'Plan' },
      completed([message('msg_a', 'Different item')]),
    ],
    blocks: [{ type: 'reasoning', text: 'Plan' }],
    replay: false,
  },
  {
    name: 'reasoning without summary keeps content and encrypted state in order',
    events: [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_a' } },
      { type: 'response.output_item.added', output_index: 1, item: message('msg_a', '') },
      { type: 'response.reasoning_text.delta', output_index: 0, item_id: 'rs_a', delta: 'Plan' },
      { type: 'response.output_text.delta', output_index: 1, item_id: 'msg_a', delta: 'Hello' },
      done({ type: 'reasoning', id: 'rs_a', content: [{ type: 'reasoning_text', text: 'Plan' }], encrypted_content: 'opaque' }, 0),
      done(message('msg_a', 'Hello'), 1), completed([]),
    ],
    blocks: [{ type: 'reasoning', text: 'Plan' }, { type: 'text', text: 'Hello' }],
    replay: true,
  },
  {
    name: 'terminal-only encryption is matched by ID even when its array is reordered',
    events: [
      done({ type: 'reasoning', id: 'rs_a', summary: [{ type: 'summary_text', text: 'Plan' }] }, 0),
      done(message('msg_a', 'Hello'), 1),
      completed([message('msg_a', 'Hello'), { type: 'reasoning', id: 'rs_a', encrypted_content: 'opaque' }]),
    ],
    blocks: [{ type: 'reasoning', text: 'Plan' }, { type: 'text', text: 'Hello' }],
    replay: true,
  },
  {
    name: 'missing summary at done does not erase streamed reasoning text',
    events: [
      { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'rs_a', delta: 'Plan' },
      done({ type: 'reasoning', id: 'rs_a', encrypted_content: 'opaque' }, 0), completed([]),
    ],
    blocks: [{ type: 'reasoning', text: 'Plan' }],
    replay: true,
  },
  {
    name: 'item IDs correlate parallel calls without output indexes',
    events: [
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'a' } },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'b' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_b', delta: '{"b":2}' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: '{"a":1}' },
      done({ type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'b', arguments: '{"b":2}' }),
      done({ type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'a', arguments: '{"a":1}' }),
      completed([]),
    ],
    blocks: [{ type: 'tool-call', id: 'call_a', name: 'a', arguments: '{"a":1}' }, { type: 'tool-call', id: 'call_b', name: 'b', arguments: '{"b":2}' }],
    replay: true,
  },
]
