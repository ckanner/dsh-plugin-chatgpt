/**
 * Verify the browser bundle against the loader contract.
 *
 * The card cannot be checked by reading it: what matters is whether the page can
 * load it at all. So this runs the same bundling the build does, evaluates the
 * artifact with the loader facade the HTML installs, and calls `apply` with a
 * context that records what it registers. A bundle that fails here fails in the
 * browser with a console error nobody reads.
 *
 *   node scripts/verify-client-bundle.mjs
 *
 * @module dsh-plugin-chatgpt/scripts/verify-client-bundle
 */

import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const require = createRequire(import.meta.url)
const packageName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name

const EXTERNAL = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const result = await build({
  entryPoints: [join(root, 'src', 'client', 'index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: EXTERNAL,
  write: false,
  logLevel: 'warning',
  legalComments: 'none',
})

const body = result.outputFiles[0]?.text ?? ''
/** The same wrapper the build emits. */
const bundle = `window.__ModuleLoader__.load({ id: ${JSON.stringify(packageName)}, factory: function (require) {
  var module = { exports: {} }; var exports = module.exports;
  (function (module, exports, require) {
${body}
  })(module, exports, require);
  return module.exports;
} });`

/** The registrations the bundle made, for assertion. */
const registered = []
const registrations = []

/** Stand-ins for the module table, so the bundle's requires resolve. */
const table = {
  'react': require('react'),
  'react/jsx-runtime': require('react/jsx-runtime'),
  '@deepseek-ai/dsh-client-ui-primitives': {
    Button: 'Button', Pill: 'Pill', Tag: 'Tag', Input: 'Input',
  },
  '@deepseek-ai/dsh-client-ui-slots': {},
  '@deepseek-ai/cordis': {},
  '@deepseek-ai/dsh-client-store': {},
  '@deepseek-ai/dsh-client-ui-dockkit': {},
}

const window = {
  __ModuleLoader__: {
    mode: 'queue',
    pendingQueue: [],
    load(registration) { registrations.push(registration) },
    create() { throw new Error('the verifier does not boot the module system') },
  },
}

// The bundle is a classic script: evaluating it is exactly what the page does.
new Function('window', 'require', 'module', 'exports', bundle)(
  window,
  specifier => {
    if (!(specifier in table)) throw new Error(`bundle required an unavailable module: ${specifier}`)
    return table[specifier]
  },
  { exports: {} },
  {},
)

assert.equal(registrations.length, 1, 'the bundle must register exactly once')
const registration = registrations[0]
assert.equal(registration.id, packageName, 'the registration id must be the package name')
assert.equal(typeof registration.factory, 'function', 'the registration must carry a factory')

const exports = registration.factory(specifier => {
  if (!(specifier in table)) throw new Error(`factory required an unavailable module: ${specifier}`)
  return table[specifier]
})

assert.equal(typeof exports.apply, 'function', 'the bundle must export apply')
assert.deepEqual(exports.inject, ['slots', 'remote'], 'the bundle must declare its services')

/** A context recording what the card registers. */
const ctx = {
  remote: { chatgpt: { status: () => Promise.resolve({}) } },
  slots: {
    inject(name, register) { registered.push({ name, entries: [] }); register() },
    register(options) { registered.at(-1)?.entries.push(options); return () => {} },
  },
}

exports.apply(ctx)

assert.equal(registered.length, 1, 'apply must inject into exactly one slot')
assert.equal(registered[0].name, 'settings.models.provider-card')
assert.deepEqual(
  registered[0].entries.map(entry => entry.key),
  ['chatgpt'],
  'the card must key on the namespace the host registered its provider row under',
)
console.log(`client bundle verified: ${registration.id} registers ${registered[0].name}:${registered[0].entries[0].key}`)
