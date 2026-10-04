/**
 * Build the browser half into the module loader's registration format.
 *
 * The page loads a plugin bundle as a classic script that calls
 * `window.__ModuleLoader__.load({ id, factory })`, and the factory receives the
 * module table's `require` — the loader hands a plugin React and the shared UI
 * libraries and nothing else. So a bundle is a CommonJS module wearing one
 * wrapper: this script bundles to CJS, leaves the module-table specifiers as
 * external `require` calls, and wraps the result in the registration.
 *
 * The alternative is the repository's own tsdown pipeline, which also compiles
 * CSS through lightningcss and runs purity gates. This plugin's card is a single
 * component styled with the harness's own primitives and tokens, so the wrapper
 * is the whole difference that matters and one dev dependency covers it.
 *
 *   node scripts/build-client.mjs
 *
 * @module dsh-plugin-chatgpt/scripts/build-client
 */

import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outFile = join(root, 'lib', 'client.js')

/**
 * The module-table specifiers the loader answers.
 *
 * These stay as `require()` calls in the output so the factory resolves them
 * against the page's table rather than bundling a second React. They are exactly
 * the platform baseline, so the package needs no `dsh.client.external` entry.
 */
const EXTERNAL = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const packageName = JSON.parse(
  (await import('node:fs')).readFileSync(join(root, 'package.json'), 'utf8'),
).name

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

const body = result.outputFiles[0]?.text
if (body === undefined) throw new Error('esbuild produced no output')

/**
 * The registration wrapper.
 *
 * `factory(require)` is called once, at materialization, and returns the
 * bundle's exports — which is how a plugin's `apply` reaches the page.
 */
const bundle = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(packageName)},
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    (function (module, exports, require) {
${body}
    })(module, exports, require);
    return module.exports;
  },
});
`

mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, bundle, 'utf8')
console.log(`wrote ${outFile} (${bundle.length} bytes)`)
