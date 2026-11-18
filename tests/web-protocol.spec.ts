import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { WebToolProtocol, answerBlocks, strictJson } from '../src/web/protocol.ts'
import { DEFAULT_WEB_BUDGET, WEB_PROTOCOL } from '../src/web/policy.ts'

const protocol = new WebToolProtocol([{ name: 'read_file', description: 'Read one file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } }])
const identity = { protocol: WEB_PROTOCOL, requestId: 'request-1', generation: 2 }
const valid = { ...identity, kind: 'tool_calls', calls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'src/main.ts' } }] }

describe('Web response protocol admission', () => {
  it('validates the complete batch before exposing namespaced tool blocks', () => {
    const answer = protocol.parse(JSON.stringify(valid), 'request-1', 2, DEFAULT_WEB_BUDGET)
    assert.deepEqual(answerBlocks(answer), [{ type: 'tool-call', id: 'request-1_call_1', name: 'read_file', arguments: '{"path":"src/main.ts"}' }])
  })
  it('rejects wrong identity, unknown keys, invalid schemas and partially valid batches', () => {
    const invalid = [
      { ...valid, requestId: 'old' }, { ...valid, generation: 1 }, { ...valid, extra: true },
      { ...valid, calls: [{ ...valid.calls[0], name: 'shell' }] },
      { ...valid, calls: [{ ...valid.calls[0], arguments: { path: 1 } }] },
      { ...valid, calls: [{ ...valid.calls[0], arguments: { path: 'x', execute: 'rm' } }] },
      { ...valid, calls: [valid.calls[0], valid.calls[0]] },
      { ...valid, calls: [valid.calls[0], { id: 'other', name: 'missing', arguments: {} }] },
    ]
    for (const value of invalid) assert.throws(() => protocol.parse(JSON.stringify(value), 'request-1', 2, DEFAULT_WEB_BUDGET))
  })
  it('does not extract executable JSON from fences, text, duplicate fields or truncated output', () => {
    for (const value of ['```json\n' + JSON.stringify(valid) + '\n```', JSON.stringify(valid) + ' trailing', JSON.stringify(valid).slice(0, -1), '{"a":1,"a":2}', '{"a":{"x":1,"x":2}}', '{"a":1e999}']) {
      assert.throws(() => strictJson(value, 4096, 8))
    }
    assert.throws(() => strictJson('[[[[[]]]]]', 4096, 2), /nesting/)
    assert.throws(() => strictJson('"你好"', 5, 8), /byte/)
  })
  it('accepts auxiliary final text while denying every tool call without an admitted registry', () => {
    const auxiliary = new WebToolProtocol([])
    const answer = auxiliary.parse(JSON.stringify({ ...identity, kind: 'final', text: 'Complete summary' }), 'request-1', 2, DEFAULT_WEB_BUDGET)
    assert.deepEqual(answerBlocks(answer), [{ type: 'text', text: 'Complete summary' }])
    assert.throws(() => auxiliary.parse(JSON.stringify(valid), 'request-1', 2, DEFAULT_WEB_BUDGET), /registry/)
    assert.throws(() => auxiliary.parse(JSON.stringify({ ...identity, kind: 'final', text: '' }), 'request-1', 2, DEFAULT_WEB_BUDGET), /empty/)
  })
  it('rejects duplicate tool definitions and unsupported schemas before dispatch', () => {
    assert.throws(() => new WebToolProtocol([{ name: 'x', description: '', parameters: { type: 'object' } }, { name: 'x', description: '', parameters: {} }]), /duplicate/)
    assert.throws(() => new WebToolProtocol([{ name: 'x', description: '', parameters: { unknownSchemaKeyword: true } }]), /Schema/)
  })
})
