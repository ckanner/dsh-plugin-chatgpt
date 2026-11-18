/** Verify the exact compatibility source tree; --apply only accepts a clean base. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
const hex = /^[a-f0-9]{40}$/
if (manifest.formatVersion !== 1 || !hex.test(manifest.upstream?.commit) || !hex.test(manifest.patch?.patchedTree)
    || !/^[a-f0-9]{64}$/.test(manifest.patch?.sha256) || !Number.isSafeInteger(manifest.patch?.bytes)
    || !/^[\w.-]+\.patch$/.test(manifest.patch?.file) || !/^pnpm@\d+\.\d+\.\d+$/.test(manifest.upstream?.packageManager)) {
  throw new Error('Invalid compatibility manifest')
}
const patchPath = join(directory, manifest.patch.file)
const patch = await readFile(patchPath)
if (patch.length !== manifest.patch.bytes || createHash('sha256').update(patch).digest('hex') !== manifest.patch.sha256) {
  throw new Error('Compatibility patch bytes do not match the manifest')
}
if (process.argv.length === 3 && process.argv[2] === '--metadata') {
  console.log(`upstream_commit=${manifest.upstream.commit}`)
  console.log(`package_manager=${manifest.upstream.packageManager}`)
} else {
  const [source, option, ...extra] = process.argv.slice(2)
  if (!source || (option !== undefined && option !== '--apply') || extra.length) {
    throw new Error('Usage: node compat/verify.mjs /absolute/path/to/dsh [--apply]')
  }
  const checkout = await realpath(resolve(source))
  const git = (args, env = process.env) => execFileSync('git', ['-C', checkout, ...args], {
    env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  if (await realpath(git(['rev-parse', '--show-toplevel'])) !== checkout) throw new Error('Pass the root of the DSH checkout')
  if (git(['rev-parse', 'HEAD']) !== manifest.upstream.commit) throw new Error('DSH checkout is not at the exact compatibility base')
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-web-compat-'))
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(temporary, 'index') }
    // This index is independent of the developer's staged changes.
    git(['read-tree', manifest.upstream.commit], env)
    git(['apply', '--cached', '--check', patchPath], env)
    git(['apply', '--cached', patchPath], env)
    if (git(['write-tree'], env) !== manifest.patch.patchedTree) throw new Error('Patch produces a different source tree than the manifest')
    if (option === '--apply') {
      if (git(['status', '--porcelain', '--untracked-files=all'])) throw new Error('Applying compatibility requires a clean isolated DSH checkout')
      git(['apply', '--check', patchPath])
      git(['apply', patchPath])
    }
    git(['read-tree', manifest.upstream.commit], env)
    git(['add', '--all'], env)
    if (git(['write-tree'], env) !== manifest.patch.patchedTree) throw new Error('Working source does not match the complete compatibility tree')
    console.log(JSON.stringify({ verified: true, upstream: manifest.upstream.commit, tree: manifest.patch.patchedTree, patchSha256: manifest.patch.sha256 }))
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
