import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { unwrap } from '../src/client/result.ts'

describe('unwrap', () => {
  it('returns the value a successful call carries', () => {
    // Rendering the envelope itself instead of its value is what made a running
    // sign-in look like a button that did nothing.
    assert.deepEqual(unwrap({ ok: true, value: { signedIn: true } }), { signedIn: true })
  })

  it('passes an undefined value through, rather than inventing one', () => {
    assert.equal(unwrap({ ok: true, value: undefined }), undefined)
  })

  it('throws the Host code and message when a call is refused', () => {
    assert.throws(
      () => unwrap({ ok: false, error: { code: 'gateway/unavailable', message: 'the Host is gone' } }),
      /gateway\/unavailable: the Host is gone/,
    )
  })

  it('still explains a refusal that carries only a message', () => {
    assert.throws(() => unwrap({ ok: false, error: { message: 'refused' } }), /^Error: refused$/)
  })

  it('names the endpoint when a refusal carries neither code nor message', () => {
    assert.throws(() => unwrap({ ok: false, error: {} }), /the ChatGPT service refused the request$/)
    assert.throws(() => unwrap({ ok: false, error: { code: 'gateway/internal' } }), /refused the request \(gateway\/internal\)/)
  })

  it('does not treat a falsy ok as a value', () => {
    // The whole class of bug: an envelope is a different shape from the value, and a
    // refusal must never be rendered as one.
    for (const value of [false, 0, '', null] as const) {
      assert.throws(() => unwrap({ ok: false, error: { message: `refused ${String(value)}` } }))
    }
  })
})
