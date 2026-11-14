/** Install the exact candidate with real host peers; no peer-resolution bypass. */
import { mkdtemp, mkdir, readdir, rm, writeFile, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'chatgpt-consumer-'))
try {
  let candidate
  if (process.argv[2] === undefined) {
    const packed = join(temporary, 'packed')
    await mkdir(packed)
    // npm 10 can run prepare even with --ignore-scripts and mix its output
    // into --json. Run the real pack lifecycle with ordinary build logs, then
    // identify the single artifact in its initially empty destination. No
    // lifecycle stdout is interpreted as a machine-readable pack report.
    execFileSync('npm', ['pack', '--pack-destination', packed], { cwd: root, stdio: 'inherit' })
    const files = await readdir(packed, { withFileTypes: true })
    if (files.length !== 1 || !files[0].isFile() || !files[0].name.endsWith('.tgz')) {
      throw new Error('npm pack did not produce exactly one candidate tarball')
    }
    candidate = join(packed, files[0].name)
  } else candidate = resolve(process.argv[2])
  const dependencies = {
    'dsh-plugin-chatgpt': `file:${candidate}`,
    '@deepseek-ai/cordis': '4.1.0',
    '@deepseek-ai/dsh-llm': '0.2.2-rc.3',
    '@deepseek-ai/dsh-typert-protocol': '0.2.2-rc.3',
    '@deepseek-ai/schemastery': '3.19.0',
  }
  await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }))
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: temporary, stdio: 'inherit' })
  const lock = JSON.parse(await readFile(join(temporary, 'package-lock.json'), 'utf8'))
  for (const [name, version] of Object.entries(dependencies)) {
    if (name !== 'dsh-plugin-chatgpt' && lock.packages[`node_modules/${name}`]?.version !== version) {
      throw new Error(`Consumer did not resolve the exact host peer ${name}@${version}`)
    }
  }
  const check = join(temporary, 'verify.mjs')
  await writeFile(check, `
    import assert from 'node:assert/strict'
    import { apply, HarnessAdapter } from 'dsh-plugin-chatgpt'
    import { LlmAdapter } from '@deepseek-ai/dsh-llm'
    import { contentCapabilities } from 'dsh-plugin-chatgpt/capabilities'
    assert.equal(typeof apply, 'function')
    assert.ok(HarnessAdapter.prototype instanceof LlmAdapter)
    assert.equal(contentCapabilities.version, 1)
    assert.deepEqual(contentCapabilities.imageInputRoles, ['user', 'tool'])
  `)
  execFileSync(process.execPath, [check], { cwd: temporary, stdio: 'inherit' })
  console.log('PASS: exact candidate installed and imported with real Cordis 4.1.0, Schemastery 3.19.0 and DSH 0.2.2-rc.3 peers')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
