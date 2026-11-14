/** Install the exact candidate with real host peers; no peer-resolution bypass. */
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'chatgpt-consumer-'))
try {
  const packed = process.argv[2] === undefined
    ? JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary], { cwd: root, encoding: 'utf8' }))[0]
    : undefined
  const candidate = packed === undefined ? resolve(process.argv[2]) : join(temporary, packed.filename)
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
