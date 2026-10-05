import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REMOTE_METHODS, REMOTE_NAMESPACE, REMOTE_SERVICE_KEY } from '../src/remote-methods.ts'
import { remoteContribution } from '../src/client/remote.ts'

const here = dirname(fileURLToPath(import.meta.url))
const controller = readFileSync(join(here, '..', 'src', 'controller.ts'), 'utf8')

/** One decorated method as the controller declares it. */
interface DeclaredMethod {
  method: string
  parameters: string[]
}

/**
 * Read the controller's Remote surface out of its source.
 *
 * The descriptors the client mounts are hand-written, because nothing generates
 * them for a package outside the workspace. That makes this list and the
 * controller's two copies of one fact, and this is the check that keeps them
 * equal: a method added to the Host and forgotten on the client would otherwise
 * fail only when a user clicks.
 *
 * @returns every `@Remote` method with its parameter names.
 */
function declaredMethods(): DeclaredMethod[] {
  const found: DeclaredMethod[] = []
  const pattern = /@Remote\s+(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g
  for (const match of controller.matchAll(pattern)) {
    const method = match[1]
    const raw = match[2] ?? ''
    if (method === undefined) continue
    const parameters = raw
      .split(',')
      .map(part => part.trim())
      .filter(part => part.length > 0)
      .map(part => ({
        wire: part.split(/[?:=]/, 1)[0]?.trim() ?? '',
        // A `?` before the type marker is what makes the argument optional, and the
        // descriptor has to agree: the Gateway counts arguments exactly, so a
        // required wire name for an optional parameter rejects every call that omits it.
        optional: part.includes('?'),
      }))
      .filter(parameter => parameter.wire.length > 0)
    found.push({ method, parameters })
  }
  return found
}

describe('the client Remote table', () => {
  it('is read from the same source that exposes it', () => {
    const declared = declaredMethods()

    assert.ok(declared.length > 0, 'the controller must declare at least one Remote method')
    assert.deepEqual(
      declared,
      REMOTE_METHODS.map(({ method, parameters }) => ({
        method,
        parameters: parameters.map(({ wire, optional }) => ({ wire, optional: optional === true })),
      })),
      'the mounted descriptors must match the Host surface exactly, arguments included',
    )
  })

  it('addresses the namespace and service the controller registered', () => {
    // Read from the controller so a rename cannot leave the client calling a
    // namespace nobody serves.
    assert.match(controller, new RegExp(`super\\(ctx, '${REMOTE_SERVICE_KEY}'`))
    assert.match(controller, new RegExp(`namespace: '${REMOTE_NAMESPACE}'`))
  })

  it('builds one descriptor per method, addressed by wire name', () => {
    const contribution = remoteContribution()

    assert.equal(contribution.descriptors.length, REMOTE_METHODS.length)
    for (const descriptor of contribution.descriptors) {
      assert.equal(descriptor.namespace, REMOTE_NAMESPACE)
      assert.equal(descriptor.service, REMOTE_SERVICE_KEY)
      assert.equal(descriptor.invocation.kind, 'direct')
      const declared = REMOTE_METHODS.find(entry => entry.method === descriptor.method)?.parameters ?? []
      assert.deepEqual(
        descriptor.parameters.map(parameter => parameter.wire),
        declared.map(({ wire }) => wire),
      )
      // The Gateway counts arguments exactly, so a parameter the Host declares
      // optional must say so here; declaring it required rejects every call that
      // omits it with "expected 1 argument(s), got 0".
      assert.deepEqual(
        descriptor.parameters.map(parameter => parameter.acceptsUndefined === true),
        declared.map(({ optional }) => optional === true),
      )
    }
  })

  it('satisfies the Gateway, which demands a strict codec on every parameter', () => {
    // Reproduced from the client Gateway's own admission check. A parameter whose
    // codec is not strict is refused, and the whole contribution with it — which is
    // exactly how the card came to report an unreachable service.
    for (const descriptor of remoteContribution().descriptors) {
      for (const parameter of descriptor.parameters) {
        assert.equal(
          parameter.codec.mode,
          'strict',
          `${descriptor.method}(${parameter.name}) must declare a strict codec`,
        )
      }
    }
  })

  it('satisfies the Typert registry, which demands more of a strict codec', () => {
    // Also reproduced from the registry. It accepts `src-json` as-is, and otherwise
    // requires a type symbol and a create() factory — the second half of the
    // contract the Gateway says nothing about.
    const describe = (codec: { mode?: string, typeSymbol?: string, create?: unknown }): string | undefined => {
      if (codec.mode === 'src-json') return undefined
      if (typeof codec.typeSymbol !== 'string' || codec.typeSymbol.length === 0) return 'no type symbol'
      if (typeof codec.create !== 'function') return 'no create() factory'
      return undefined
    }

    for (const descriptor of remoteContribution().descriptors) {
      assert.equal(describe(descriptor.result), undefined, `${descriptor.method} result codec`)
      for (const parameter of descriptor.parameters) {
        assert.equal(describe(parameter.codec), undefined, `${descriptor.method}(${parameter.name}) codec`)
      }
    }
  })

  it('names a nonempty service key and an id without a hash', () => {
    // The registry rejects an empty segment, and a service key containing the id
    // separator, before it looks at anything else.
    for (const descriptor of remoteContribution().descriptors) {
      assert.ok(descriptor.service.length > 0)
      assert.ok(!descriptor.service.includes('#'))
      assert.match(descriptor.id, /^dsh-plugin-chatgpt#chatgpt\/[A-Za-z]+$/)
    }
  })

  it('names each endpoint as the Gateway composes it', () => {
    const endpoints = remoteContribution().descriptors.map(d => `${d.namespace}/${d.method}`)

    assert.deepEqual(endpoints, [
      'chatgpt/status',
      'chatgpt/begin',
      'chatgpt/submit',
      'chatgpt/cancel',
      'chatgpt/signOut',
    ])
  })
})
