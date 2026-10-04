import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { REFUSED_FIELDS, toResponsesBody } from '../src/convert/request.ts'

/** The body's own keys, for asserting on refusals. */
function keysOf(body: object): string[] {
  return Object.keys(body)
}

describe('toResponsesBody', () => {
  it('always carries the two flags the plan-usage route requires', () => {
    const body = toResponsesBody({ model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'hi' }] })

    assert.equal(body.stream, true)
    assert.equal(body.store, false)
  })

  it('lifts a leading system message into instructions instead of forwarding it', () => {
    const body = toResponsesBody({
      model: 'm',
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'hi' },
      ],
    })

    assert.equal(body.instructions, 'You are terse.')
    // A system-role item inside `input` is refused, so none may appear.
    assert.deepEqual(body.input, [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ])
  })

  it('joins several system messages, preserving their order', () => {
    const body = toResponsesBody({
      model: 'm',
      messages: [
        { role: 'system', content: 'first' },
        { role: 'system', content: 'second' },
        { role: 'user', content: 'hi' },
      ],
    })

    assert.equal(body.instructions, 'first\n\nsecond')
  })

  it('uses the out-of-band system prompt when the messages carry none', () => {
    const body = toResponsesBody({
      model: 'm',
      system: 'One-shot prompt',
      messages: [{ role: 'user', content: 'hi' }],
    })

    assert.equal(body.instructions, 'One-shot prompt')
  })

  it('prefers the messages\' system text over the out-of-band prompt', () => {
    const body = toResponsesBody({
      model: 'm',
      system: 'ignored',
      messages: [{ role: 'system', content: 'from history' }, { role: 'user', content: 'hi' }],
    })

    assert.equal(body.instructions, 'from history')
  })

  it('omits instructions entirely when there is no system text', () => {
    const body = toResponsesBody({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })

    assert.equal('instructions' in body, false)
  })

  it('maps a text part and an image part to their wire content items', () => {
    const body = toResponsesBody({
      model: 'm',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', url: 'https://example.com/a.png' },
        ],
      }],
    })

    assert.deepEqual(body.input[0]?.content, [
      { type: 'input_text', text: 'look at this' },
      { type: 'input_image', image_url: 'https://example.com/a.png' },
    ])
  })

  it('delivers tool results as top-level items correlated by call id', () => {
    const body = toResponsesBody({
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolTraffic: [{ kind: 'result', result: { callId: 'call_1', output: 'file contents' } }],
    })

    // Not a message role: the wire format correlates by call_id, not position.
    assert.deepEqual(body.input[1], {
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'file contents',
    })
  })

  it('replays a call as a function_call item, before the result answering it', () => {
    const body = toResponsesBody({
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolTraffic: [
        { kind: 'call', call: { callId: 'call_1', name: 'read_file', arguments: '{"path":"a"}' } },
        { kind: 'result', result: { callId: 'call_1', output: 'hello' } },
      ],
    })

    assert.deepEqual(body.input.slice(1), [
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'hello' },
    ])
  })

  it('marks a failed tool result rather than throwing', () => {
    const body = toResponsesBody({
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      toolTraffic: [{ kind: 'result', result: { callId: 'call_1', output: 'not found', isError: true } }],
    })

    assert.equal(body.input[1]?.output, 'Error: not found')
  })

  it('maps tools to function declarations', () => {
    const body = toResponsesBody({
      model: 'm',
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
    })

    assert.deepEqual(body.tools, [
      { type: 'function', name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
    ])
  })

  it('omits an empty tool list rather than sending one', () => {
    const body = toResponsesBody({ model: 'm', messages: [], tools: [] })

    assert.equal('tools' in body, false)
  })

  it('maps the reasoning effort to the wire field', () => {
    const body = toResponsesBody({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      reasoningEffort: 'high',
    })

    // The summary is always asked for: without it this route streams nothing at
    // all until the answer begins, so a thinking model looks like a hang.
    assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' })
  })

  it('labels an assistant turn as output, which is the only thing the endpoint accepts', () => {
    // A replayed assistant turn sent as `input_text` is refused with invalid_value,
    // which fails every request after the first — only the first has no history.
    const body = toResponsesBody({
      model: 'm',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
        { role: 'user', content: 'third' },
      ],
    })

    const roles = body.input.map(item => {
      const content = item['content']
      return Array.isArray(content) && content.length > 0
        ? (content[0] as { type: string }).type
        : undefined
    })
    assert.deepEqual(roles, ['input_text', 'output_text', 'input_text'])
  })

  it('keeps an image out of an assistant turn, which cannot carry one', () => {
    const body = toResponsesBody({
      model: 'm',
      messages: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'seen' }, { type: 'image', url: 'https://example.test/a.png' }],
      }],
    })

    assert.deepEqual(body.input[0]?.['content'], [{ type: 'output_text', text: 'seen' }])
  })

  it('omits reasoning when no effort was chosen', () => {
    const body = toResponsesBody({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })

    assert.equal('reasoning' in body, false)
  })

  it('drops an empty message rather than sending an empty content array', () => {
    const body = toResponsesBody({
      model: 'm',
      messages: [{ role: 'user', content: '' }, { role: 'user', content: 'real' }],
    })

    assert.equal(body.input.length, 1)
    assert.deepEqual(body.input[0]?.content, [{ type: 'input_text', text: 'real' }])
  })

  it('never carries a field the plan-usage route refuses', () => {
    const body = toResponsesBody({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      // Asked for, and refused by the route: passing it through would fail the
      // request before the model saw it.
      maxTokens: 4096,
    })

    for (const refused of REFUSED_FIELDS) {
      assert.equal(keysOf(body).includes(refused), false, `${refused} must not be sent`)
    }
  })
})
