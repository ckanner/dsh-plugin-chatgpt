import assert from 'node:assert/strict'
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

// The release commands are plain JavaScript CLI programs, also exercised by the
// real subprocess and local bare-Git fixtures below. No registry writes occur.
const release = await import(new URL('../scripts/release.mjs', import.meta.url).href)
const github = await import(new URL('../scripts/release-github.mjs', import.meta.url).href)
type Result = Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'stderr'> & Partial<Pick<SpawnSyncReturns<string>, 'error' | 'signal'>>
type Execute = (command: string, args: string[], options?: Record<string, unknown>) => Result
const ok = (value: unknown): Result => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })
const missing = (): Result => ({ status: 1, stdout: JSON.stringify({ error: { code: 'E404' } }), stderr: '' })
const sha = 'a'.repeat(40)

function temporary(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'chatgpt-release-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function candidateFixture(t: TestContext, version = '0.2.0-alpha.1') {
  const directory = temporary(t)
  const bytes = Buffer.from('one immutable tested archive\n')
  writeFileSync(join(directory, 'candidate.tgz'), bytes)
  const candidate = { schema: 1, name: release.PACKAGE, ...release.versionPolicy(version), sourceSHA: sha,
    tagObject: 'b'.repeat(40), ...release.fileIdentity(join(directory, 'candidate.tgz')), toolchain: release.TOOLCHAIN }
  writeFileSync(join(directory, 'candidate.json'), JSON.stringify(candidate))
  const state: { published: boolean, tags: Record<string, string>, bytes: Buffer, integrity: string, commands: string[][], publishResult?: Result } = {
    published: false, tags: {}, bytes, integrity: candidate.integrity, commands: [],
  }
  const execute: Execute = (command, args) => {
    assert.equal(command, 'npm')
    state.commands.push([...args])
    assert.ok(args.includes(release.REGISTRY), 'Every registry request selects the canonical public registry')
    if (args[0] === 'view' && args[2] === 'dist.integrity') return state.published ? ok([state.integrity]) : missing()
    if (args[0] === 'view' && args[2] === 'dist-tags') return ok([state.tags])
    if (args[0] === 'publish') {
      assert.equal(args[1], join(directory, 'candidate.tgz'))
      assert.deepEqual(readFileSync(args[1]!), bytes)
      assert.equal(args[args.indexOf('--tag') + 1], candidate.candidateTag)
      assert.ok(args.includes('--ignore-scripts'))
      assert.ok(args.includes('--provenance'))
      state.published = true
      state.tags[candidate.candidateTag] = candidate.version
      return state.publishResult ?? ok({})
    }
    if (args[0] === 'pack') {
      assert.equal(args[1], `${release.PACKAGE}@${candidate.version}`)
      const destination = args[args.indexOf('--pack-destination') + 1]!
      writeFileSync(join(destination, 'download.tgz'), state.bytes)
      return ok({})
    }
    if (args[0] === 'dist-tag') {
      assert.equal(args[1], 'add')
      state.tags[args[3]!] = candidate.version
      return ok({})
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
  }
  return { directory, candidate, bytes, state, execute }
}

test('stable, alpha, beta and rc versions have separate explicit channels and ordered versions', () => {
  for (const [version, channel] of [['1.2.3', 'latest'], ['1.2.3-alpha.2', 'alpha'], ['1.2.3-beta.0', 'beta'], ['1.2.3-rc.1', 'rc']]) {
    const policy = release.versionPolicy(version)
    assert.equal(policy.channel, channel)
    assert.equal(policy.prerelease, channel !== 'latest')
    assert.equal(policy.tag, `v${version}`)
  }
  for (const invalid of ['v1.2.3', '01.2.3', '1.2.3-dev.1', '1.2.3-rc.01', '1.2.3+build', '1.2.3\n', '1.2', 'latest']) {
    assert.throws(() => release.versionPolicy(invalid))
  }
  assert.equal(release.compareVersions('1.2.3-alpha.9', '1.2.3-alpha.10'), -1)
  assert.equal(release.compareVersions('1.2.3-beta.0', '1.2.3-alpha.99'), 1)
  assert.equal(release.compareVersions('1.2.3', '1.2.3-rc.9'), 1)
  assert.equal(release.compareVersions('2.0.0-alpha.1', '1.9.99'), 1)
})

test('release toolchain rejects Node/npm drift', () => {
  const fixed: Execute = (command) => ({ status: 0, stdout: command === 'npm' ? '12.2.1\n' : 'v24.22.1\n', stderr: '' })
  release.assertToolchain(fixed)
  assert.throws(() => release.assertToolchain(() => ({ status: 0, stdout: '12.3.0', stderr: '' })), /toolchain/)
})

test('only structured E404 from a normal process exit proves registry absence', () => {
  const processResult = (code: number, body: unknown, stderr = '') => spawnSync(process.execPath,
    ['-e', 'process.stdout.write(process.argv[1]); process.stderr.write(process.argv[2]); process.exit(Number(process.argv[3]))', JSON.stringify(body), stderr, String(code)], { encoding: 'utf8' })
  assert.equal(release.isNotFound(processResult(1, { error: { code: 'E404' } })), true)
  for (const code of ['E401', 'E403', 'ENOTFOUND', 'ETIMEDOUT', 'E500']) {
    const result = processResult(1, { error: { code } })
    assert.equal(release.isNotFound(result), false)
    assert.throws(() => release.registryValue(['package@1.0.0', 'dist.integrity'], () => result))
  }
  for (const result of [
    processResult(0, { error: { code: 'E404' } }),
    processResult(130, { error: { code: 'E404' } }),
    processResult(1, { message: '404 Not Found' }),
    processResult(1, { error: { code: 'E404' } }, JSON.stringify({ error: { code: 'E401' } })),
    spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({error:{code:"E404"}}));process.kill(process.pid,"SIGTERM")'], { encoding: 'utf8' }),
    spawnSync(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { encoding: 'utf8', timeout: 25, killSignal: 'SIGKILL' }),
    spawnSync('/no/such/npm', [], { encoding: 'utf8' }),
  ]) assert.equal(release.isNotFound(result), false)
})

test('registry JSON ambiguity and incomplete metadata cannot become missing versions', t => {
  const { candidate } = candidateFixture(t)
  for (const value of [null, [], ['one', 'two'], {}, '', 'sha1-abc']) {
    assert.throws(() => release.remoteIntegrity(candidate, () => ok(value)))
  }
  assert.throws(() => release.remoteIntegrity(candidate, () => ({ status: 0, stdout: 'warning\n"sha512-abc"', stderr: '' })))
  assert.equal(release.remoteIntegrity(candidate, () => missing()), null)
  assert.equal(release.remoteIntegrity(candidate, () => ok([candidate.integrity])), candidate.integrity)
  assert.throws(() => release.checkChannel(candidate, () => ok({ error: { code: 'E401' } })), /error object/)
  assert.throws(() => release.checkChannel(candidate, () => ok({ latest: {} })), /dist-tags/)
})

test('new versions publish the tested archive once under candidate, then download and explicitly promote alpha', async t => {
  const f = candidateFixture(t)
  const registryFile = await release.publishCandidate(f.directory, f.candidate, { execute: f.execute })
  assert.equal(registryFile, join(f.directory, 'registry', `${release.PACKAGE}.tgz`))
  assert.deepEqual(readFileSync(registryFile), f.bytes)
  assert.equal(f.state.tags.alpha, undefined)
  assert.equal(f.state.tags.latest, undefined)
  await release.promoteCandidate(f.directory, f.candidate, { execute: f.execute })
  assert.equal(f.state.tags.alpha, f.candidate.version)
  assert.equal(f.state.tags.latest, undefined)
  assert.equal(f.state.commands.filter(args => args[0] === 'publish').length, 1)
})

test('stable promotion moves latest only after the registry archive has been obtained', async t => {
  const f = candidateFixture(t, '1.2.3')
  await assert.rejects(release.promoteCandidate(f.directory, f.candidate, { execute: f.execute }), /ENOENT/)
  await release.publishCandidate(f.directory, f.candidate, { execute: f.execute })
  assert.equal(f.state.tags.latest, undefined)
  await release.promoteCandidate(f.directory, f.candidate, { execute: f.execute })
  assert.equal(f.state.tags.latest, '1.2.3')
})

test('an existing version is never republished and its verified registry bytes are reused', async t => {
  const f = candidateFixture(t)
  f.state.published = true
  await release.publishCandidate(f.directory, f.candidate, { execute: f.execute })
  await release.publishCandidate(f.directory, f.candidate, { execute: f.execute })
  assert.equal(f.state.commands.some(args => args[0] === 'publish'), false)
  assert.equal(f.state.commands.filter(args => args[0] === 'pack').length, 1)
  assert.deepEqual(readFileSync(join(f.directory, 'registry', `${release.PACKAGE}.tgz`)), f.bytes)
})

test('existing version integrity, downloaded bytes and candidate tampering all fail before promotion', async t => {
  const mismatch = candidateFixture(t)
  mismatch.state.published = true
  mismatch.state.integrity = `sha512-${Buffer.alloc(64).toString('base64')}`
  await assert.rejects(release.publishCandidate(mismatch.directory, mismatch.candidate, { execute: mismatch.execute }), /different bytes/)
  assert.equal(mismatch.state.commands.some(args => ['publish', 'pack', 'dist-tag'].includes(args[0]!)), false)
  const download = candidateFixture(t)
  download.state.published = true
  download.state.bytes = Buffer.alloc(download.bytes.length)
  await assert.rejects(release.publishCandidate(download.directory, download.candidate, { execute: download.execute }), /bytes changed/)
  const changed = candidateFixture(t)
  writeFileSync(join(changed.directory, 'candidate.tgz'), 'changed')
  assert.throws(() => release.readCandidate(changed.directory), /bytes changed/)
  await assert.rejects(release.publishCandidate(changed.directory, changed.candidate, { execute: changed.execute }), /bytes changed/)
  assert.equal(changed.state.commands.length, 0)
})

test('candidate symlinks and conflicting candidate/channel tags are rejected', async t => {
  const f = candidateFixture(t)
  const file = join(f.directory, 'candidate.tgz')
  rmSync(file)
  writeFileSync(join(f.directory, 'elsewhere'), f.bytes)
  symlinkSync(join(f.directory, 'elsewhere'), file)
  assert.throws(() => release.readCandidate(f.directory), /regular/)
  const conflict = candidateFixture(t)
  conflict.state.tags[conflict.candidate.candidateTag] = '9.0.0'
  await assert.rejects(release.publishCandidate(conflict.directory, conflict.candidate, { execute: conflict.execute }), /another version/)
  const backwards = candidateFixture(t, '1.0.0')
  backwards.state.tags.latest = '1.0.1'
  await assert.rejects(release.publishCandidate(backwards.directory, backwards.candidate, { execute: backwards.execute }), /backwards/)
  assert.equal(backwards.state.commands.some(args => args[0] === 'publish'), false)
})

test('normal publish response loss reconciles exact registry bytes; abnormal exits remain failed', async t => {
  const accepted = candidateFixture(t)
  accepted.state.publishResult = { status: 1, stdout: '', stderr: 'response connection closed' }
  await release.publishCandidate(accepted.directory, accepted.candidate, { execute: accepted.execute })
  for (const result of [
    { status: null, stdout: '', stderr: '', signal: 'SIGTERM' as const },
    { status: 130, stdout: '', stderr: '' },
    { status: null, stdout: '', stderr: '', error: new Error('spawn failed') },
  ]) {
    const f = candidateFixture(t)
    f.state.publishResult = result
    await assert.rejects(release.publishCandidate(f.directory, f.candidate, { execute: f.execute }), /Publish the exact candidate/)
    assert.equal(f.state.commands.some(args => ['pack', 'dist-tag'].includes(args[0]!)), false)
  }
  const unauthorized = candidateFixture(t)
  unauthorized.state.publishResult = { status: 1, stdout: JSON.stringify({ error: { code: 'E401' } }), stderr: '' }
  await assert.rejects(release.publishCandidate(unauthorized.directory, unauthorized.candidate, { execute: unauthorized.execute }), /authorization/)
  assert.equal(unauthorized.state.commands.some(args => ['pack', 'dist-tag'].includes(args[0]!)), false)
})

test('tag lease is rechecked after registry reads and before publish or promotion', async t => {
  const f = candidateFixture(t)
  let checks = 0
  await assert.rejects(release.publishCandidate(f.directory, f.candidate, { execute: f.execute,
    assertSource() { if (++checks === 2) throw new Error('remote tag changed') } }), /remote tag changed/)
  assert.equal(f.state.commands.some(args => args[0] === 'publish'), false)
  await release.publishCandidate(f.directory, f.candidate, { execute: f.execute })
  checks = 0
  await assert.rejects(release.promoteCandidate(f.directory, f.candidate, { execute: f.execute,
    assertSource() { if (++checks === 2) throw new Error('remote tag changed') } }), /remote tag changed/)
  assert.equal(f.state.commands.some(args => args[0] === 'dist-tag'), false)
})

test('registry visibility has a shared bounded deadline and never retries authentication errors', async () => {
  let clock = 0
  let calls = 0
  await assert.rejects(release.waitForRegistry((execute: Execute) => {
    execute('npm', [])
    return false
  }, { now: () => clock, wait: async (ms: number) => { clock += ms }, execute(_command: string, _args: string[], options: { timeout: number }) {
    calls++
    assert.ok(options.timeout > 0 && options.timeout <= 30000)
    clock += 10000
    return missing()
  } }), /180 seconds/)
  assert.ok(calls < 20)
  calls = 0
  await assert.rejects(release.waitForRegistry((execute: Execute) => release.registryValue(['x'], execute), { execute() {
    calls++
    return { status: 1, stdout: JSON.stringify({ error: { code: 'E401' } }), stderr: '' }
  } }), /E401/)
  assert.equal(calls, 1)
})

function sourceFixture(t: TestContext) {
  const directory = temporary(t)
  const root = join(directory, 'checkout')
  const remote = join(directory, 'origin.git')
  mkdirSync(root)
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(['init', '-b', 'main'])
  git(['config', 'user.name', 'Release test'])
  git(['config', 'user.email', 'release-test@example.invalid'])
  git(['init', '--bare', remote])
  git(['remote', 'add', 'origin', remote])
  const manifest = { name: release.PACKAGE, version: '0.2.0-alpha.1', repository: { type: 'git', url: `git+https://github.com/${release.REPOSITORY}.git` }, publishConfig: { access: 'public' } }
  const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: { '': { name: manifest.name, version: manifest.version } } }
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock))
  git(['add', '.'])
  git(['commit', '-m', 'reviewed source'])
  git(['tag', '-a', 'v0.2.0-alpha.1', '-m', 'original release'])
  git(['push', 'origin', 'main', '--tags'])
  const env = { GITHUB_REPOSITORY: release.REPOSITORY, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v0.2.0-alpha.1', GITHUB_SHA: git(['rev-parse', 'HEAD']) }
  const execute: Execute = (command, args, options) => {
    // Only the expected origin spelling is adapted for a network-free bare Git
    // remote. Fetch, ancestry checks and remote tag reads execute real Git.
    if (command === 'git' && args[0] === 'remote' && args[1] === 'get-url') return { status: 0, stdout: `https://github.com/${release.REPOSITORY}.git`, stderr: '' }
    return spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options })
  }
  return { directory, root, git, env, execute, manifest, lock }
}

test('source admission uses a real remote tag, exact commit and main ancestry; manual branch runs fail', t => {
  const f = sourceFixture(t)
  const source = release.sourceGate(f.root, f.env, f.execute)
  assert.equal(source.sourceSHA, f.env.GITHUB_SHA)
  assert.notEqual(source.tagObject, source.sourceSHA, 'Annotated tag object is retained as a separate lease')
  release.sourceGate(f.root, { ...f.env, GITHUB_EVENT_NAME: 'workflow_dispatch' }, f.execute)
  assert.throws(() => release.sourceGate(f.root, { ...f.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main' }, f.execute), /existing exact version tag/)
  assert.throws(() => release.sourceGate(f.root, { ...f.env, GITHUB_REPOSITORY: 'someone/fork' }, f.execute), /original repository/)
  assert.throws(() => release.sourceGate(f.root, { ...f.env, GITHUB_SHA: sha }, f.execute), /exact workflow source/)
  writeFileSync(join(f.root, 'untracked'), 'not reviewed')
  assert.throws(() => release.sourceGate(f.root, f.env, f.execute), /clean/)
})

test('real annotated-tag replacement at the same commit breaks the persisted lease', t => {
  const f = sourceFixture(t)
  const source = release.sourceGate(f.root, f.env, f.execute)
  f.git(['tag', '-f', '-a', source.tag, '-m', 'replacement at same commit'])
  f.git(['push', '--force', 'origin', source.tag])
  assert.throws(() => release.sourceGate(f.root, { ...f.env, RELEASE_TAG_OBJECT: source.tagObject }, f.execute), /stale tag lease/)
})

test('unmerged source and mismatched lock/package identity cannot be released', t => {
  const f = sourceFixture(t)
  assert.throws(() => release.validateManifest(f.manifest, { ...f.lock, version: '9.9.9' }), /lockfile/)
  assert.throws(() => release.validateManifest({ ...f.manifest, publishConfig: { access: 'public', tag: 'latest' } }, f.lock), /manifest/)
  f.git(['checkout', '-b', 'unreviewed'])
  writeFileSync(join(f.root, 'new-source'), 'not merged')
  f.git(['add', '.'])
  f.git(['commit', '-m', 'unreviewed changes'])
  f.git(['tag', '-f', '-a', 'v0.2.0-alpha.1', '-m', 'unreviewed tag'])
  f.git(['push', '--force', 'origin', 'v0.2.0-alpha.1'])
  assert.throws(() => release.sourceGate(f.root, { ...f.env, GITHUB_SHA: f.git(['rev-parse', 'HEAD']) }, f.execute), /on origin\/main/)
})

test('packing happens once and persists exact bytes, fixed tools and the original source lease', t => {
  const f = sourceFixture(t)
  const directory = join(f.directory, 'candidate')
  let packs = 0
  const execute: Execute = (command, args, options) => {
    if (command === process.execPath && args[0] === '--version') return { status: 0, stdout: release.TOOLCHAIN.node, stderr: '' }
    if (command === 'npm' && args[0] === '--version') return { status: 0, stdout: release.TOOLCHAIN.npm, stderr: '' }
    if (command === 'npm' && args[0] === 'pack') {
      packs++
      assert.ok(args.includes('--ignore-scripts'))
      writeFileSync(join(directory, 'packed.tgz'), 'fixed build bytes')
      return ok({})
    }
    return f.execute(command, args, options)
  }
  const candidate = release.packCandidate(directory, { root: f.root, env: f.env, execute })
  assert.deepEqual(release.readCandidate(directory), candidate)
  release.candidateGate(directory, { root: f.root, env: f.env, execute })
  assert.throws(() => release.candidateGate(directory, { root: f.root, env: { ...f.env, RELEASE_TAG_OBJECT: sha }, execute }), /original workflow tag lease/)
  assert.throws(() => release.packCandidate(directory, { root: f.root, env: f.env, execute }), /empty/)
  assert.equal(packs, 1)
  assert.deepEqual(readdirSync(directory).sort(), ['candidate.json', 'candidate.tgz'])
})

function githubFixture(t: TestContext, version?: string) {
  const f = candidateFixture(t, version)
  f.state.published = true
  f.state.tags[f.candidate.channel] = f.candidate.version
  mkdirSync(join(f.directory, 'registry'))
  writeFileSync(join(f.directory, 'registry', `${release.PACKAGE}.tgz`), f.bytes)
  const expected = { id: 123, tag_name: f.candidate.tag, target_commitish: f.candidate.sourceSHA, prerelease: f.candidate.prerelease, draft: false,
    assets: [{ id: 456, name: `${release.PACKAGE}.tgz`, size: f.bytes.length, state: 'uploaded' }] }
  const state: { release: typeof expected | null, bytes: Buffer, commands: string[][], failAfter?: 'create' | 'upload' | 'publish' } = { release: null, bytes: f.bytes, commands: [] }
  const http = (value: unknown, status = 200): Result => ({ status: status === 200 ? 0 : 1,
    stdout: `HTTP/2.0 ${status} Status\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(value)}`, stderr: '' })
  const after = (phase: 'create' | 'upload' | 'publish') => {
    if (state.failAfter !== phase) return ok({})
    delete state.failAfter
    return http({ message: `injected failure after ${phase}` }, 500)
  }
  const execute: Execute = (command, args, options) => {
    if (command !== 'gh') return f.execute(command, args, options)
    state.commands.push([...args])
    if (args[0] === 'api') {
      if (args.includes('PATCH')) {
        assert.ok(args.includes(`repos/${release.REPOSITORY}/releases/${state.release!.id}`))
        assert.ok(args.includes('draft=false'))
        assert.ok(args.includes(`make_latest=${f.candidate.prerelease ? 'false' : 'true'}`))
        state.release!.draft = false
        return state.failAfter === 'publish' ? after('publish') : http(state.release)
      }
      if (args.includes('graphql')) return http({ data: { repository: { release: state.release ? { databaseId: state.release.id, isDraft: state.release.draft } : null } } })
      const byId = args.includes(`repos/${release.REPOSITORY}/releases/${state.release?.id}`)
      return state.release && (!state.release.draft || byId) ? http(state.release) : http({ message: 'Not Found' }, 404)
    }
    if (args[1] === 'create') {
      assert.ok(args.includes('--draft'))
      state.release = { ...structuredClone(expected), draft: true, assets: [] }
      return after('create')
    }
    if (args[1] === 'upload') {
      assert.ok(!args.includes('--clobber'))
      assert.equal(args[3], join(f.directory, 'registry', `${release.PACKAGE}.tgz`))
      state.release!.assets = structuredClone(expected.assets)
      return after('upload')
    }
    if (args[1] === 'download') { writeFileSync(join(args[args.indexOf('--dir') + 1]!, `${release.PACKAGE}.tgz`), state.bytes); return ok({}) }
    throw new Error(`Unexpected GitHub command ${args.join(' ')}`)
  }
  return { ...f, expected, githubState: state, execute }
}

test('GitHub alpha/rc Releases are explicit prereleases and carry the exact registry archive', async t => {
  for (const version of ['0.2.0-alpha.1', '0.2.0-rc.1', '1.0.0']) {
    const f = githubFixture(t, version)
    await github.recordGitHubRelease(f.directory, f.candidate, { execute: f.execute })
    const created = f.githubState.commands.find(args => args[1] === 'create')!
    assert.equal(created.includes('--prerelease'), f.candidate.prerelease)
    assert.ok(created.includes('--latest=false'), 'A draft must not affect latest before verified publication')
    assert.ok(created.includes('--draft'))
    assert.ok(created.includes('--verify-tag'))
    assert.equal(created[created.indexOf('--target') + 1], f.candidate.sourceSHA)
    const uploaded = f.githubState.commands.find(args => args[1] === 'upload')!
    assert.equal(uploaded[3], join(f.directory, 'registry', `${release.PACKAGE}.tgz`))
    const published = f.githubState.commands.find(args => args.includes('PATCH'))!
    assert.ok(published.includes(`make_latest=${f.candidate.prerelease ? 'false' : 'true'}`))
    assert.equal(f.githubState.release!.draft, false)
  }
})

test('existing Release retries verify content; only absent assets are uploaded and nothing is clobbered', async t => {
  const f = githubFixture(t)
  f.githubState.release = structuredClone(f.expected)
  await github.recordGitHubRelease(f.directory, f.candidate, { execute: f.execute })
  assert.equal(f.githubState.commands.some(args => ['upload', 'create'].includes(args[1]!)), false)
  f.githubState.release.assets = []
  await github.recordGitHubRelease(f.directory, f.candidate, { execute: f.execute })
  assert.equal(f.githubState.commands.filter(args => args[1] === 'upload').length, 1)
  f.githubState.bytes = Buffer.alloc(f.bytes.length)
  await assert.rejects(github.recordGitHubRelease(f.directory, f.candidate, { execute: f.execute }), /bytes changed/)
  assert.equal(f.githubState.commands.filter(args => args[1] === 'upload').length, 1)
  f.githubState.release.target_commitish = 'c'.repeat(40)
  assert.throws(() => github.checkGitHubRelease(f.directory, f.candidate, { execute: f.execute }), /different source/)
  await assert.rejects(github.recordGitHubRelease(f.directory, f.candidate, { execute: f.execute }), /different source/)
})

test('GitHub lookup requires a structured REST 404 and a successful empty draft lookup to prove absence', () => {
  const invoke = (status: number, body: unknown, exit: number) => spawnSync(process.execPath, ['-e',
    'process.stdout.write(process.argv[1]);process.exit(Number(process.argv[2]))',
    `HTTP/2.0 ${status} Status\nContent-Type: application/json\n\n${JSON.stringify(body)}`, String(exit)], { encoding: 'utf8' })
  assert.equal(github.githubRelease('v1.0.0', (_command: string, args: string[]) => args.includes('graphql')
    ? invoke(200, { data: { repository: { release: null } } }, 0) : invoke(404, { message: 'Not Found' }, 1)), null)
  for (const result of [invoke(401, { message: 'Bad credentials' }, 1), invoke(500, { message: 'Oops' }, 1),
    invoke(404, { message: 'Not Found' }, 130), invoke(200, { message: 'Not Found' }, 1),
    { status: 1, stdout: '404 Not Found', stderr: '' }]) {
    assert.throws(() => github.githubRelease('v1.0.0', () => result))
  }
  for (const body of [{ errors: [{ message: 'forbidden' }] }, { data: { repository: null } }, { data: { repository: {} } },
    { data: { repository: { release: { databaseId: -1, isDraft: true } } } }]) {
    assert.throws(() => github.githubRelease('v1.0.0', (_command: string, args: string[]) => args.includes('graphql')
      ? invoke(200, body, 0) : invoke(404, { message: 'Not Found' }, 1)))
  }
})

test('GitHub draft creation, upload and publication response losses reconcile on the next run without overwrites', async t => {
  for (const phase of ['create', 'upload', 'publish'] as const) {
    const f = githubFixture(t)
    f.githubState.failAfter = phase
    await assert.rejects(github.recordGitHubRelease(f.directory, f.candidate, { execute: f.execute }), /injected failure/)
    assert.equal(f.githubState.release!.draft, phase !== 'publish')
    assert.equal(f.githubState.release!.assets.length, phase === 'create' ? 0 : 1)
    const before = f.githubState.commands.length
    const pending = github.checkGitHubRelease(f.directory, f.candidate, { execute: f.execute })
    assert.equal(pending.id, 123)
    assert.equal(f.githubState.commands.slice(before).some(args => ['create', 'upload'].includes(args[1]!) || args.includes('PATCH')), false)
    await github.recordGitHubRelease(f.directory, f.candidate, { execute: f.execute })
    assert.equal(f.githubState.release!.draft, false)
    assert.equal(f.githubState.commands.filter(args => args[1] === 'create').length, 1)
    assert.equal(f.githubState.commands.filter(args => args[1] === 'upload').length, 1)
    assert.equal(f.githubState.commands.filter(args => args.includes('PATCH')).length, 1)
    assert.equal(f.githubState.commands.some(args => args.includes('--clobber')), false)
  }
})

test('a matching existing draft resumes after strict checks; conflicting or incomplete drafts remain unpublished', async t => {
  const f = githubFixture(t)
  f.githubState.release = { ...structuredClone(f.expected), draft: true }
  const existing = github.checkGitHubRelease(f.directory, f.candidate, { execute: f.execute })
  assert.equal(existing.draft, true)
  await github.recordGitHubRelease(f.directory, f.candidate, { execute: f.execute })
  assert.equal(f.githubState.commands.some(args => ['create', 'upload'].includes(args[1]!)), false)
  assert.equal(f.githubState.release.draft, false)
  for (const conflict of ['source', 'prerelease', 'asset', 'incomplete', 'extra'] as const) {
    const bad = githubFixture(t)
    bad.githubState.release = { ...structuredClone(bad.expected), draft: true }
    if (conflict === 'source') bad.githubState.release.target_commitish = 'c'.repeat(40)
    if (conflict === 'prerelease') bad.githubState.release.prerelease = !bad.candidate.prerelease
    if (conflict === 'asset') bad.githubState.bytes = Buffer.alloc(bad.bytes.length)
    if (conflict === 'incomplete') bad.githubState.release.assets[0]!.state = 'starter'
    if (conflict === 'extra') bad.githubState.release.assets.push({ ...bad.expected.assets[0]!, id: 999, name: 'unknown.tgz' })
    assert.throws(() => github.checkGitHubRelease(bad.directory, bad.candidate, { execute: bad.execute }))
    await assert.rejects(github.recordGitHubRelease(bad.directory, bad.candidate, { execute: bad.execute }))
    assert.equal(bad.githubState.release.draft, true)
    assert.equal(bad.githubState.commands.some(args => args[1] === 'upload' || args.includes('PATCH')), false)
  }
})

test('a draft release or asset replaced during byte verification is not published', async t => {
  for (const replaced of ['release', 'asset'] as const) {
    const f = githubFixture(t)
    f.githubState.release = { ...structuredClone(f.expected), draft: true }
    const execute: Execute = (command, args, options) => {
      const result = f.execute(command, args, options)
      if (command === 'gh' && args[1] === 'download') {
        if (replaced === 'release') f.githubState.release!.id = 999
        else f.githubState.release!.assets[0]!.id = 999
      }
      return result
    }
    await assert.rejects(github.recordGitHubRelease(f.directory, f.candidate, { execute }), /identity changed/)
    assert.equal(f.githubState.commands.some(args => args.includes('PATCH')), false)
  }
})

test('draft publication rechecks the original source lease after downloading the uploaded archive', async t => {
  const f = githubFixture(t)
  f.githubState.release = { ...structuredClone(f.expected), draft: true }
  let checks = 0
  await assert.rejects(github.recordGitHubRelease(f.directory, f.candidate, { execute: f.execute,
    assertSource() { if (++checks > 1) throw new Error('remote source lease changed') } }), /lease changed/)
  assert.ok(f.githubState.commands.some(args => args[1] === 'download'))
  assert.equal(f.githubState.commands.some(args => args.includes('PATCH')), false)
  assert.equal(f.githubState.release.draft, true)
})
