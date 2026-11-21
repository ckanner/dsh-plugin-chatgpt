/** Verify the plugin entry against actual stock public Cordis/Loader APIs, without starting Web. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'

const { values, positionals } = parseArgs({ options: { deps: { type: 'string' } }, allowPositionals: true })
if (positionals.length !== 1) throw new Error('Pass an unmodified DSH checkout; optionally use --deps for its third-party dependencies.')
const dsh = resolve(positionals[0])
const plugin = fileURLToPath(new URL('../', import.meta.url))
const deps = resolve(values.deps ?? dsh)
const git = (...args) => execFileSync('git', ['-C', dsh, ...args], { encoding: 'utf8' }).trim()
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'Stock DSH source must be unmodified')
const revision = git('rev-parse', 'HEAD')
const directory = await mkdtemp(join(tmpdir(), 'chatgpt-stock-web-plugin-'))
try {
  const output = join(directory, 'lib', 'runtime', 'verify.mjs')
  await mkdir(dirname(output), { recursive: true })
  // Preserve each real package's version lookup relative to the bundled entry.
  await copyFile(join(plugin, 'package.json'), join(directory, 'package.json'))
  await copyFile(join(dsh, 'packages/llm/llm/package.json'), join(directory, 'lib', 'package.json'))
  const result = await build({
    entryPoints: [join(plugin, 'tests/fixtures/web-plugin-host.mjs')],
    absWorkingDir: dsh, tsconfig: join(dsh, 'tsconfig.base.json'),
    nodePaths: [join(deps, 'node_modules'), join(dsh, 'node_modules'), join(plugin, 'node_modules')],
    bundle: true, platform: 'node', format: 'esm', target: 'node24', write: false, metafile: true,
    external: ['koffi'],
    banner: { js: "import { createRequire as __hostRequire } from 'node:module'; const require = __hostRequire(import.meta.url);" },
  })
  const inputs = new Set(Object.keys(result.metafile.inputs).map(path => resolve(dsh, path)))
  for (const path of ['vendor/cordis/src/fiber.ts', 'vendor/loader/src/index.ts',
    'vendor/schemastery/src/index.ts', 'packages/llm/llm/src/index.ts']) {
    assert.ok(inputs.has(join(dsh, path)), `Verification must include the actual public host implementation: ${path}`)
  }
  assert.ok(inputs.has(join(plugin, 'src/index.ts')), 'Verification must activate the actual plugin entry')
  await writeFile(output, result.outputFiles[0].contents)
  // Keep import.meta.url distinct from argv[1], as with the installed package;
  // otherwise bundling an imported CLI would accidentally make it the entrypoint.
  const runner = join(directory, 'run.mjs')
  await writeFile(runner, "import './lib/runtime/verify.mjs'\n")
  execFileSync(process.execPath, [runner, directory], { cwd: directory, stdio: 'inherit', timeout: 30_000 })
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'Verification must not alter stock DSH source')
  console.log(`PASS: stock DSH ${revision}; actual plugin activation, async disposal and config remount`)
} finally { await rm(directory, { recursive: true, force: true }) }
