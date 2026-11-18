import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

test('compatibility installation verifies source identity and preserves the real Git index', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'web-compat-test-'))
  const checkout = join(root, 'host')
  const compat = join(root, 'compat')
  await mkdir(checkout); await mkdir(compat)
  const git = (...args: string[]): string => execFileSync('git', ['-C', checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const verify = (...args: string[]): string => execFileSync(process.execPath, [join(compat, 'verify.mjs'), checkout, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    git('init', '--quiet')
    git('config', 'user.name', 'Compatibility fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('config', 'commit.gpgsign', 'false')
    await writeFile(join(checkout, 'source.txt'), 'original\n')
    git('add', 'source.txt'); git('commit', '-qm', 'fixture base')
    const base = git('rev-parse', 'HEAD')
    await writeFile(join(checkout, 'source.txt'), 'patched\n')
    await writeFile(join(checkout, 'recovery.txt'), 'new recovery source\n')
    git('add', '--all')
    const patch = execFileSync('git', ['-C', checkout, 'diff', '--cached', '--binary', 'HEAD'])
    const tree = git('write-tree')
    git('reset', '--hard', 'HEAD')
    await copyFile(fileURLToPath(new URL('../compat/verify.mjs', import.meta.url)), join(compat, 'verify.mjs'))
    const manifest = { formatVersion: 1, upstream: { commit: base, packageManager: 'pnpm@11.28.5' }, patch: {
      file: 'host.patch', sha256: createHash('sha256').update(patch).digest('hex'), bytes: patch.length, patchedTree: tree,
    } }
    await writeFile(join(compat, 'host.patch'), patch)
    await writeFile(join(compat, 'manifest.json'), JSON.stringify(manifest))

    await t.test('rejects an unpatched source and a changed patch before mutating the checkout', async () => {
      assert.throws(() => verify(), /Working source does not match/)
      await writeFile(join(compat, 'host.patch'), Buffer.concat([patch, Buffer.from('\n')]))
      assert.throws(() => verify('--apply'), /patch bytes do not match/)
      assert.equal(git('status', '--porcelain'), '')
      await writeFile(join(compat, 'host.patch'), patch)
    })
    await t.test('applies the exact tree and verifies it without staging changes', () => {
      assert.equal(JSON.parse(verify('--apply')).tree, tree)
      assert.equal(JSON.parse(verify()).verified, true)
      assert.equal(git('diff', '--cached', '--name-only'), '')
      assert.throws(() => verify('--apply'), /clean isolated DSH checkout/)
    })
    await t.test('detects an extra source edit while preserving existing staging', async () => {
      git('add', 'source.txt')
      const staged = git('diff', '--cached')
      await writeFile(join(checkout, 'recovery.txt'), 'unexpected source\n')
      assert.throws(() => verify(), /Working source does not match/)
      assert.equal(git('diff', '--cached'), staged)
      assert.equal(await readFile(join(checkout, 'recovery.txt'), 'utf8'), 'unexpected source\n')
    })
    await t.test('rejects a different upstream commit even when files look similar', async () => {
      await writeFile(join(checkout, 'recovery.txt'), 'new recovery source\n')
      git('add', '--all'); git('commit', '-qm', 'different base')
      assert.throws(() => verify(), /exact compatibility base/)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
