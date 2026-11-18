#!/usr/bin/env node
/** Release only one tested archive, from an unchanged, reviewed source tag. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PACKAGE = 'dsh-plugin-chatgpt'
export const REPOSITORY = 'ckanner/dsh-plugin-chatgpt'
export const REGISTRY = 'https://registry.npmjs.org'
export const TOOLCHAIN = Object.freeze({ node: 'v24.22.1', npm: '12.2.1' })
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/
const SHA = /^[0-9a-f]{40}$/
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const REGISTRY_FLAGS = ['--registry', REGISTRY, '--fetch-retries=0', '--fetch-timeout=30000']

export function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, ...options })
}

export function abnormalExit(result) {
  return Boolean(result.error || result.signal || !Number.isInteger(result.status) || result.status < 0 || result.status >= 128)
}

export function checked(result, operation) {
  if (abnormalExit(result) || result.status !== 0) {
    const detail = result.error?.message || result.signal || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`
    throw new Error(`${operation} failed (exit ${result.status}): ${String(detail).slice(0, 2000)}`)
  }
  return result.stdout?.trim() ?? ''
}

export function versionPolicy(version) {
  const match = VERSION.exec(version ?? '')
  if (!match) throw new Error('Release version must be X.Y.Z or X.Y.Z-alpha.N / beta.N / rc.N without leading zeroes')
  return { version, tag: `v${version}`, channel: match[4] ?? 'latest', prerelease: match[4] !== undefined,
    candidateTag: `candidate-${version.replaceAll('.', '-')}` }
}

export function compareVersions(left, right) {
  const a = VERSION.exec(versionPolicy(left).version)
  const b = VERSION.exec(versionPolicy(right).version)
  for (const index of [1, 2, 3]) {
    if (BigInt(a[index]) !== BigInt(b[index])) return BigInt(a[index]) < BigInt(b[index]) ? -1 : 1
  }
  if (!a[4] || !b[4]) return a[4] === b[4] ? 0 : a[4] ? -1 : 1
  if (a[4] !== b[4]) return ['alpha', 'beta', 'rc'].indexOf(a[4]) < ['alpha', 'beta', 'rc'].indexOf(b[4]) ? -1 : 1
  return BigInt(a[5]) === BigInt(b[5]) ? 0 : BigInt(a[5]) < BigInt(b[5]) ? -1 : 1
}

export function validateManifest(manifest, lock) {
  if (manifest?.name !== PACKAGE || manifest.private === true || manifest.repository?.type !== 'git'
    || manifest.repository.url !== `git+https://github.com/${REPOSITORY}.git`
    || (manifest.repository.directory ?? '.') !== '.' || JSON.stringify(manifest.publishConfig) !== JSON.stringify({ access: 'public' })) {
    throw new Error('Release manifest must identify the public package, original repository, and only public access')
  }
  const policy = versionPolicy(manifest.version)
  if (lock?.lockfileVersion !== 3 || lock.name !== PACKAGE || lock.version !== policy.version
    || lock.packages?.['']?.name !== PACKAGE || lock.packages[''].version !== policy.version) {
    throw new Error('The committed lockfile must identify the exact release name and version')
  }
  return policy
}

export function parseRemoteTag(stdout, tag) {
  const values = new Map()
  for (const line of stdout.trim().split('\n').filter(Boolean)) {
    const [oid, ref, extra] = line.split(/\s+/)
    if (!SHA.test(oid ?? '') || extra || ![`refs/tags/${tag}`, `refs/tags/${tag}^{}`].includes(ref) || values.has(ref)) {
      throw new Error('Unexpected or ambiguous remote release tag')
    }
    values.set(ref, oid)
  }
  const object = values.get(`refs/tags/${tag}`)
  if (!object) throw new Error('The release tag must already exist on origin')
  return { object, commit: values.get(`refs/tags/${tag}^{}`) ?? object }
}

/** Rechecked before pack and every externally visible mutation. No tag creation. */
export function sourceGate(root = ROOT, env = process.env, execute = run) {
  const policy = validateManifest(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
    JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')))
  if (env.GITHUB_REPOSITORY !== REPOSITORY || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
    || env.GITHUB_REF !== `refs/tags/${policy.tag}` || !SHA.test(env.GITHUB_SHA ?? '')) {
    throw new Error('Release must run in the original repository from the existing exact version tag, including manual runs')
  }
  const git = (args) => checked(execute('git', args, { cwd: root }), `git ${args[0]}`)
  const head = git(['rev-parse', 'HEAD'])
  if (head !== env.GITHUB_SHA || git(['rev-parse', `refs/tags/${policy.tag}^{commit}`]) !== head) {
    throw new Error('Release tag and checkout must identify the exact workflow source commit')
  }
  if (git(['status', '--porcelain', '--untracked-files=all'])) throw new Error('Release source checkout must be clean, including untracked files')
  const origin = git(['remote', 'get-url', 'origin'])
  if (![`https://github.com/${REPOSITORY}`, `https://github.com/${REPOSITORY}.git`, `git@github.com:${REPOSITORY}.git`].includes(origin)) {
    throw new Error('Release origin must be the original GitHub repository')
  }
  git(['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'])
  checked(execute('git', ['merge-base', '--is-ancestor', head, 'refs/remotes/origin/main'], { cwd: root }), 'Released commit must be on origin/main')
  const remote = parseRemoteTag(git(['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${policy.tag}`, `refs/tags/${policy.tag}^{}`]), policy.tag)
  if (remote.commit !== head || (env.RELEASE_TAG_OBJECT && env.RELEASE_TAG_OBJECT !== remote.object)) {
    throw new Error('Remote release tag changed; refusing to publish from a stale tag lease')
  }
  return { ...policy, sourceSHA: head, tagObject: remote.object }
}

export function assertToolchain(execute = run) {
  const node = checked(execute(process.execPath, ['--version']), 'Read Node version')
  const npm = checked(execute('npm', ['--version']), 'Read npm version')
  if (node !== TOOLCHAIN.node || npm !== TOOLCHAIN.npm) {
    throw new Error(`Release toolchain must be Node ${TOOLCHAIN.node} / npm ${TOOLCHAIN.npm}`)
  }
}

export function fileIdentity(file) {
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0 || stat.size > 64 * 1024 * 1024) {
    throw new Error('Release archive must be one regular, nonempty file of at most 64 MiB')
  }
  return { bytes: stat.size, integrity: `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}` }
}

export function assertArchive(file, candidate) {
  const actual = fileIdentity(file)
  if (actual.bytes !== candidate.bytes || actual.integrity !== candidate.integrity) throw new Error('Release archive bytes changed after verification')
  return file
}

export function readCandidate(directory) {
  const candidate = JSON.parse(readFileSync(join(directory, 'candidate.json'), 'utf8'))
  const policy = versionPolicy(candidate.version)
  if (candidate.schema !== 1 || candidate.name !== PACKAGE || !SHA.test(candidate.sourceSHA ?? '') || !SHA.test(candidate.tagObject ?? '')
    || !INTEGRITY.test(candidate.integrity ?? '') || !Number.isSafeInteger(candidate.bytes) || candidate.bytes <= 0
    || Object.entries(policy).some(([key, value]) => candidate[key] !== value)
    || candidate.toolchain?.node !== TOOLCHAIN.node || candidate.toolchain?.npm !== TOOLCHAIN.npm) {
    throw new Error('Invalid release candidate identity')
  }
  assertArchive(join(directory, 'candidate.tgz'), candidate)
  return candidate
}

export function candidateGate(directory, { root = ROOT, env = process.env, execute = run } = {}) {
  const candidate = readCandidate(directory)
  if (env.RELEASE_TAG_OBJECT && env.RELEASE_TAG_OBJECT !== candidate.tagObject) throw new Error('Candidate differs from the original workflow tag lease')
  const source = sourceGate(root, { ...env, RELEASE_TAG_OBJECT: candidate.tagObject }, execute)
  if (Object.entries(source).some(([key, value]) => candidate[key] !== value)) throw new Error('Candidate is not the exact admitted release source')
  return candidate
}

export function packCandidate(directory, { root = ROOT, env = process.env, execute = run } = {}) {
  assertToolchain(execute)
  const source = sourceGate(root, env, execute)
  mkdirSync(directory, { recursive: true })
  if (readdirSync(directory).length !== 0) throw new Error('Candidate directory must be empty; never silently repack a tested release')
  checked(execute('npm', ['pack', '--ignore-scripts', '--pack-destination', directory], { cwd: root }), 'Pack the release candidate')
  const packed = readdirSync(directory)
  if (packed.length !== 1 || !packed[0].endsWith('.tgz')) throw new Error('npm pack must produce exactly one archive')
  const filename = join(directory, packed[0])
  const identity = fileIdentity(filename)
  renameSync(filename, join(directory, 'candidate.tgz'))
  const candidate = { schema: 1, name: PACKAGE, ...source, ...identity, toolchain: TOOLCHAIN }
  // The pack lifecycle is disabled; any unexpected source change remains fatal.
  const after = sourceGate(root, { ...env, RELEASE_TAG_OBJECT: source.tagObject }, execute)
  if (JSON.stringify(after) !== JSON.stringify(source)) throw new Error('Release source changed during packing')
  writeFileSync(join(directory, 'candidate.json'), `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx' })
  return candidate
}

/** Only structured npm E404 on a normal failure proves a missing version. */
export function isNotFound(result) {
  if (abnormalExit(result) || result.status === 0) return false
  const codes = []
  for (const output of [result.stdout, result.stderr]) {
    try { const code = JSON.parse(output).error?.code; if (code !== undefined) codes.push(code) } catch { /* npm also writes ordinary diagnostics. */ }
  }
  return codes.length > 0 && codes.every(code => code === 'E404')
}

export function registryValue(args, execute = run, { timeout = 30000 } = {}) {
  const result = execute('npm', ['view', ...args, '--json', '--prefer-online', ...REGISTRY_FLAGS], { timeout })
  if (abnormalExit(result) || result.status !== 0) {
    if (isNotFound(result)) return null
    checked(result, `Read npm registry ${args.join(' ')}`)
  }
  let value
  try { value = JSON.parse(result.stdout) } catch { throw new Error('Registry returned missing or invalid JSON; absence is unproven') }
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new Error('Registry returned ambiguous or missing values')
    value = value[0]
  }
  if (value && typeof value === 'object' && Object.hasOwn(value, 'error')) throw new Error('Registry returned an error object instead of a value')
  if (value === null) throw new Error('Registry returned a null value; absence is unproven')
  return value
}

export function remoteIntegrity(candidate, execute = run, options) {
  const value = registryValue([`${PACKAGE}@${candidate.version}`, 'dist.integrity'], execute, options)
  if (value !== null && (typeof value !== 'string' || !INTEGRITY.test(value))) throw new Error('Registry integrity is not one SHA-512 digest')
  if (value !== null && value !== candidate.integrity) throw new Error('Published version has different bytes from this tested source candidate')
  return value
}

export function checkChannel(candidate, execute = run) {
  const tags = registryValue([PACKAGE, 'dist-tags'], execute)
  if (tags !== null && (typeof tags !== 'object' || Array.isArray(tags)
    || Object.values(tags).some(value => typeof value !== 'string'))) throw new Error('Invalid registry dist-tags')
  if (tags?.[candidate.candidateTag] !== undefined && tags[candidate.candidateTag] !== candidate.version) throw new Error('Candidate dist-tag belongs to another version')
  const current = tags?.[candidate.channel]
  if (current !== undefined && (typeof current !== 'string' || compareVersions(current, candidate.version) > 0)) {
    throw new Error(`Refusing to move ${candidate.channel} backwards from ${String(current)} to ${candidate.version}`)
  }
  return current ?? null
}

const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms))
export async function waitForRegistry(check, { execute = run, wait = pause, now = () => performance.now() } = {}) {
  const deadline = now() + 180000
  let delay = 2000
  for (;;) {
    if (now() >= deadline) break
    const query = (command, args, options = {}) => {
      const remaining = Math.floor(deadline - now())
      if (remaining <= 0) throw new Error('Registry visibility deadline expired')
      return execute(command, args, { ...options, timeout: Math.min(remaining, 30000), killSignal: 'SIGKILL' })
    }
    const ready = check(query)
    if (now() >= deadline) break
    if (ready) return
    await wait(Math.min(delay, deadline - now()))
    delay = Math.min(delay * 2, 15000)
  }
  throw new Error('Registry did not confirm the exact release within 180 seconds')
}

export function downloadRegistryArchive(directory, candidate, execute = run) {
  const destination = join(directory, 'registry')
  mkdirSync(destination, { recursive: true })
  const final = join(destination, `${PACKAGE}.tgz`)
  if (readdirSync(destination).length !== 0) {
    if (readdirSync(destination).length !== 1) throw new Error('Unexpected files in registry archive directory')
    return assertArchive(final, candidate)
  }
  checked(execute('npm', ['pack', `${PACKAGE}@${candidate.version}`, '--ignore-scripts', '--pack-destination', destination, ...REGISTRY_FLAGS]), 'Download the exact published version')
  const files = readdirSync(destination)
  if (files.length !== 1 || !files[0].endsWith('.tgz')) throw new Error('Registry must return exactly one archive')
  assertArchive(join(destination, files[0]), candidate)
  renameSync(join(destination, files[0]), final)
  return final
}

export async function publishCandidate(directory, candidate, { execute = run, assertSource = () => {}, ...timing } = {}) {
  assertSource()
  const file = assertArchive(join(directory, 'candidate.tgz'), candidate)
  const existing = remoteIntegrity(candidate, execute)
  checkChannel(candidate, execute)
  if (existing === null) {
    assertSource()
    assertArchive(file, candidate)
    const result = execute('npm', ['publish', file, '--access', 'public', '--ignore-scripts', '--provenance', '--json', '--tag', candidate.candidateTag, ...REGISTRY_FLAGS])
    // A killed/timed-out process is an unsuccessful run even if it printed E404.
    // A normal rejected response can be reconciled only with the exact registry bytes.
    if (abnormalExit(result)) checked(result, 'Publish the exact candidate')
    if (result.status !== 0) {
      for (const output of [result.stdout, result.stderr]) {
        let error
        try { error = JSON.parse(output).error } catch { /* A lost network response need not contain JSON. */ }
        if (['E401', 'E403', 'ENEEDAUTH', 'EOTP', 'EPROVENANCE'].includes(error?.code)) checked(result, 'Publish authorization or provenance')
      }
    }
    if (result.status !== 0 && remoteIntegrity(candidate, execute) === null) checked(result, 'Publish the exact candidate')
  }
  await waitForRegistry(query => remoteIntegrity(candidate, query) !== null, { execute, ...timing })
  assertSource()
  return downloadRegistryArchive(directory, candidate, execute)
}

export async function promoteCandidate(directory, candidate, { execute = run, assertSource = () => {}, ...timing } = {}) {
  assertSource()
  assertArchive(join(directory, 'registry', `${PACKAGE}.tgz`), candidate)
  await waitForRegistry(query => remoteIntegrity(candidate, query) !== null, { execute, ...timing })
  if (checkChannel(candidate, execute) !== candidate.version) {
    assertSource()
    checked(execute('npm', ['dist-tag', 'add', `${PACKAGE}@${candidate.version}`, candidate.channel, ...REGISTRY_FLAGS]), 'Promote the verified registry archive')
  }
  await waitForRegistry(query => checkChannel(candidate, query) === candidate.version && remoteIntegrity(candidate, query) !== null, { execute, ...timing })
}

export async function main(argv) {
  const [operation, directoryArg, ...extra] = argv
  if (!['source', 'pack', 'check-github', 'publish', 'promote', 'github'].includes(operation) || extra.length || (operation !== 'source' && !directoryArg)
    || (operation === 'source' && directoryArg)) throw new Error('Usage: release.mjs source | pack/check-github/publish/promote/github <candidate-directory>')
  if (operation === 'source') {
    const source = sourceGate()
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `source_sha=${source.sourceSHA}\ntag_object=${source.tagObject}\nversion=${source.version}\n`)
    console.log(`Admitted ${source.tag} at ${source.sourceSHA}`)
    return
  }
  const directory = resolve(directoryArg)
  assertToolchain()
  if (operation === 'pack') {
    const candidate = packCandidate(directory)
    console.log(`Packed ${candidate.name}@${candidate.version}: ${candidate.integrity}`)
    return
  }
  const candidate = candidateGate(directory)
  const assertSource = () => candidateGate(directory)
  if (operation === 'publish') await publishCandidate(directory, candidate, { assertSource })
  else if (operation === 'promote') await promoteCandidate(directory, candidate, { assertSource })
  else {
    const { checkGitHubRelease, recordGitHubRelease } = await import('./release-github.mjs')
    if (operation === 'check-github') checkGitHubRelease(directory, candidate, { assertSource })
    else await recordGitHubRelease(directory, candidate, { assertSource })
  }
  console.log(`${operation}: ${candidate.name}@${candidate.version}, channel ${candidate.channel}, source ${candidate.sourceSHA}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => {
  console.error(`release: ${error.message}`)
  process.exitCode = 1
})
