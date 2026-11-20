/**
 * Exercise the experimental bridge through an unmodified, released DSH host.
 *
 * Usage: node scripts/verify-web-agent-loop.mjs /path/to/deepseek-harness
 *          [--deps /path/to/isolated-dependencies] [--expected-commit <sha>]
 *
 * The checkout must have its dependencies and native flock addon available.
 * --deps can supply third-party node_modules without installing the whole DSH
 * workspace. Build the addon using the checkout's own
 * `node native/system/scripts/build.ts --host-addon-only` first.
 * No profile, browser, login, real model, or user settings are used.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'

const RELEASED_RC5 = '9c2670d3bce5275e0d1610272958121af87787bb'
const { values, positionals } = parseArgs({
  options: { deps: { type: 'string' }, 'expected-commit': { type: 'string', default: RELEASED_RC5 } },
  allowPositionals: true,
})
if (positionals.length !== 1) {
  throw new Error('Pass one unmodified DSH checkout; optionally use --deps and --expected-commit.')
}
if (!['darwin', 'linux'].includes(process.platform)) throw new Error('The stock JSONL/flock verification requires Linux or macOS.')
const dsh = resolve(positionals[0])
const plugin = fileURLToPath(new URL('../', import.meta.url))
const deps = resolve(values.deps ?? dsh)
const git = (...args) => execFileSync('git', ['-C', dsh, ...args], { encoding: 'utf8' }).trim()
const revision = git('rev-parse', 'HEAD')
assert.equal(revision, values['expected-commit'], 'DSH checkout must match the explicitly selected evidence revision')
assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'Tracked DSH files must be unmodified')

const requiredHostSources = [
  'packages/core/agent-loop/src/agent.ts',
  'packages/llm/llm/src/index.ts',
  'packages/llm/llm/src/assembler.ts',
  'packages/core/tool-executor-native/src/index.ts',
  'packages/session/session-persistence-jsonl/src/index.ts',
  'packages/session/session-checkpoint-policy/src/index.ts',
]
await Promise.all(requiredHostSources.map(path => access(join(dsh, path))))
const nativePackage = join(dsh, 'native/system/packages', `${process.platform}-${process.arch}`)
const nativeManifest = JSON.parse(await readFile(join(nativePackage, 'package.json'), 'utf8'))
const libc = process.platform === 'linux'
  ? process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl'
  : ''
try {
  await access(join(nativePackage, 'bin', libc, 'system.node'))
} catch {
  throw new Error('Build the selected DSH checkout native addon first: node native/system/scripts/build.ts --host-addon-only')
}

const directory = await mkdtemp(join(tmpdir(), 'chatgpt-stock-web-agent-loop-'))
try {
  const output = join(directory, 'lib', 'verify.mjs')
  await mkdir(dirname(output), { recursive: true })
  // Stock LLM attribution reads ../package.json relative to its built entry.
  // Preserve that real manifest rather than mocking the package version.
  await copyFile(join(dsh, 'packages/llm/llm/package.json'), join(directory, 'package.json'))
  const nativeTarget = join(directory, 'node_modules', ...nativeManifest.name.split('/'))
  await mkdir(dirname(nativeTarget), { recursive: true })
  await symlink(nativePackage, nativeTarget, 'dir')

  const result = await build({
    entryPoints: [join(plugin, 'tests/fixtures/web-agent-loop-host.mjs')],
    absWorkingDir: dsh,
    tsconfig: join(dsh, 'tsconfig.base.json'),
    nodePaths: [join(deps, 'node_modules'), join(dsh, 'node_modules'), join(plugin, 'node_modules')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    write: false,
    metafile: true,
    // This POSIX-only check never loads the optional Windows FFI backend.
    external: ['koffi'],
    banner: { js: "import { createRequire as __verificationRequire } from 'node:module'; const require = __verificationRequire(import.meta.url);" },
  })
  const inputs = new Set(Object.keys(result.metafile.inputs).map(path => resolve(dsh, path)))
  for (const path of requiredHostSources) {
    assert.ok(inputs.has(join(dsh, path)), `Verification must include the real stock source: ${path}`)
  }
  await writeFile(output, result.outputFiles[0].contents)
  execFileSync(process.execPath, [output, directory], { cwd: directory, stdio: 'inherit', timeout: 45_000 })
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '', 'Verification must not alter DSH source')
  console.log(`PASS: unmodified stock DSH ${revision}; actual AgentLoop, LLM, BlockAssembler, native tools, JSONL and checkpoint policy`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
