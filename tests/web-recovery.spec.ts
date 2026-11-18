import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, link, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { readWebInvocationRecovery, type WebRecoveryCheckpoint } from '../src/web/recovery.ts'
import { WebStore } from '../src/web/store.ts'
import { digest } from '../src/web/policy.ts'
import { WEB_PROTOCOL } from '../src/web/policy.ts'

const run = promisify(execFile)
async function fixture(mode: string) {
  const root = await mkdtemp(join(tmpdir(), 'web-read-only-recovery-'))
  await chmod(root, 0o755) // Valid host-owned parent; private stores remain 0700.
  const { stdout } = await run(process.execPath, [fileURLToPath(new URL('./fixtures/web-recovery-owner.ts', import.meta.url)), root, mode])
  return { root, checkpoint: JSON.parse(stdout) as WebRecoveryCheckpoint, dispose: () => rm(root, { recursive: true, force: true }) }
}
async function snapshot(root: string): Promise<string> {
  const entries: [string, string][] = []
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile()) entries.push([full, (await readFile(full)).toString('base64')])
    }
  }
  await visit(root)
  return JSON.stringify(entries.sort())
}

test('reads original completed host and browser evidence after process exit without writing, replaying or adopting', async () => {
  const f = await fixture('final')
  try {
    const before = await snapshot(f.root)
    const first = await readWebInvocationRecovery(f.checkpoint)
    assert.equal(first.disposition, 'committed')
    assert.equal(first.facts.outcome, 'completed')
    assert.equal(first.facts.usageStatus, 'unknown')
    assert.equal(first.terminalMain[0]?.text, 'Original durable answer')
    assert.deepEqual(await readWebInvocationRecovery(f.checkpoint), first)
    assert.equal(await snapshot(f.root), before)
    // Existing BrowserStore publishers can leave a private temporary hard link
    // after a crash. The immutable committed path remains valid and read-only.
    const artifacts = join(f.checkpoint.settings.connections.default!.stateDir, 'artifacts')
    const artifact = join(artifacts, (await readdir(artifacts))[0]!)
    await link(artifact, artifact + '.pending')
    assert.deepEqual(await readWebInvocationRecovery(f.checkpoint), first)
    await assert.rejects(readWebInvocationRecovery({ ...f.checkpoint, ownerPid: process.pid }), /still live/)
    await assert.rejects(readWebInvocationRecovery({ ...f.checkpoint, settingsDigest: 'b'.repeat(64) }), /settings changed/)
    await assert.rejects(readWebInvocationRecovery({ ...f.checkpoint, identity: { ...f.checkpoint.identity, hostInvocationId: 'different' } }), /another owner/)
    const store = new WebStore(join(f.root, 'web-host'))
    const registry = await store.read<any>('registry', 'current')
    registry.invocations.original.toolIntents.pending = { sessionId: 'root', rootCallId: 'pending', completed: false }
    await store.write('registry', 'current', registry)
    assert.equal((await readWebInvocationRecovery(f.checkpoint)).disposition, 'blocked')
    registry.invocations.original.toolIntents.pending.completed = true
    await store.write('registry', 'current', registry)
    assert.equal((await readWebInvocationRecovery(f.checkpoint)).disposition, 'blocked', 'legacy ID-only completion cannot establish the original tool occurrence')
    delete registry.invocations.original.toolIntents.pending
    registry.invocations.other = { ...registry.invocations.original, hostInvocationId: 'other' }
    await store.write('registry', 'current', registry)
    await assert.rejects(readWebInvocationRecovery(f.checkpoint), /domain revision changed/)
  } finally { await f.dispose() }
})

for (const mode of ['empty','unsent','captured','tool','summary','unknown-tool']) {
  test(`preserves ${mode} as its actual effect boundary`, async () => {
    const f = await fixture(mode)
    try {
      const before = await snapshot(f.root)
      const evidence = await readWebInvocationRecovery(f.checkpoint)
      if (mode === 'empty' || mode === 'unsent') {
        assert.equal(evidence.disposition, 'not-dispatched')
        assert.equal(evidence.facts.outcome, 'failed')
      } else if (mode === 'captured' || mode === 'unknown-tool') {
        assert.equal(evidence.disposition, 'blocked')
        assert.equal(evidence.facts.outcome, 'unknown')
      } else {
        assert.equal(evidence.disposition, 'committed')
        assert.equal(evidence.facts.outcome, 'failed', 'a tool/summary ACK is not the original business completion')
        assert.equal(evidence.terminalMain.length, 0)
      }
      assert.equal(await snapshot(f.root), before)
    } finally { await f.dispose() }
  })
}

for (const mode of ['repaired-final','retired','retired-repair','retired-unsent-repair']) {
  test(`validates the original format-correction chain and ${mode} without replay`, async () => {
    const f = await fixture(mode)
    try {
      const before = await snapshot(f.root)
      const evidence = await readWebInvocationRecovery(f.checkpoint)
      assert.equal(evidence.disposition, mode === 'repaired-final' ? 'committed' : 'retired')
      assert.equal(evidence.facts.outcome, mode === 'repaired-final' ? 'completed' : 'failed')
      assert.equal(evidence.facts.dispatch, 'dispatched')
      assert.equal(evidence.facts.localCleanupConfirmed, true)
      assert.equal(await snapshot(f.root), before)
      if (mode === 'repaired-final') {
        const registry = await new WebStore(join(f.root, 'web-host')).read<any>('registry', 'current')
        const call = registry.invocations.original.calls[0]
        const store = new WebStore(join(f.root, 'web-connections', call.connectionKey, 'sessions'))
        const pending = await store.read<any>('request', call.requestId)
        assert.equal(pending.repairs.length, 1)
        pending.repairs[0].parentDigest = 'b'.repeat(64)
        await store.write('request', call.requestId, pending)
        await assert.rejects(readWebInvocationRecovery(f.checkpoint), /parent artifact changed/)
      }
    } finally { await f.dispose() }
  })
}

test('rejects modified artifacts and symlinked private evidence', async () => {
  const f = await fixture('final')
  try {
    const connection = f.checkpoint.settings.connections.default!
    const path = join(connection.stateDir, 'artifacts', (await readdir(join(connection.stateDir, 'artifacts')))[0]!)
    const original = await readFile(path)
    await writeFile(path, 'changed', { mode: 0o600 })
    await assert.rejects(readWebInvocationRecovery(f.checkpoint), /artifact changed/)
    await writeFile(path, original, { mode: 0o600 })
    const registry = join(f.root, 'web-host', `registry-${digest('current')}.json`)
    const bytes = await readFile(registry)
    await rm(registry)
    const other = join(f.root, 'foreign.json')
    await writeFile(other, bytes, { mode: 0o600 })
    await symlink(other, registry)
    await assert.rejects(readWebInvocationRecovery(f.checkpoint), /ELOOP/)
  } finally { await f.dispose() }
})

test('retirement flags and matching digests cannot discard a protocol-valid response', async () => {
  const f = await fixture('retired')
  try {
    const registryStore = new WebStore(join(f.root, 'web-host'))
    const registry = await registryStore.read<any>('registry', 'current')
    const call = registry.invocations.original.calls[0]
    const sessions = new WebStore(join(f.root, 'web-connections', call.connectionKey, 'sessions'))
    const pending = await sessions.read<any>('request', call.requestId)
    const runtime = f.checkpoint.settings.connections.default!.stateDir
    const journalPath = join(runtime, 'calls', createHash('sha256').update(call.requestId).digest('hex') + '.json')
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    const artifact = JSON.stringify({ protocol: WEB_PROTOCOL, requestId: call.requestId, generation: pending.generation, kind: 'final', text: 'Protocol-valid response' })
    const sha256 = createHash('sha256').update(artifact).digest('hex')
    await writeFile(journal.artifact.path, artifact, { mode: 0o600 })
    journal.artifact.sha256 = sha256; journal.artifact.bytes = Buffer.byteLength(artifact); journal.disposition.responseDigest = sha256
    call.retired.responseDigest = sha256; pending.retired.responseDigest = sha256
    await writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 })
    await registryStore.write('registry', 'current', registry)
    await sessions.write('request', call.requestId, pending)
    await assert.rejects(readWebInvocationRecovery(f.checkpoint), /not rejected by the original protocol/)
  } finally { await f.dispose() }
})

for (const mode of ['media-final','media-repaired']) {
  test(`${mode} validates original image bytes and acceptance before trusting a final or repair tail`, async () => {
    const f = await fixture(mode)
    try {
      const before = await snapshot(f.root)
      assert.equal((await readWebInvocationRecovery(f.checkpoint)).disposition, 'committed')
      assert.equal(await snapshot(f.root), before)
      const images = join(f.checkpoint.settings.connections.default!.stateDir, 'images')
      const image = join(images, (await readdir(images))[0]!)
      const bytes = await readFile(image)
      await writeFile(image, Buffer.alloc(bytes.length, 0), { mode: 0o600 })
      await assert.rejects(readWebInvocationRecovery(f.checkpoint), /artifact bytes changed/)
      await writeFile(image, bytes, { mode: 0o600 })
      const calls = join(f.checkpoint.settings.connections.default!.stateDir, 'calls')
      for (const name of await readdir(calls)) {
        const path = join(calls, name), journal = JSON.parse(await readFile(path, 'utf8'))
        if (journal.request.repairOf) continue
        journal.media.acceptedUploadNames = []
        await writeFile(path, JSON.stringify(journal), { mode: 0o600 })
      }
      await assert.rejects(readWebInvocationRecovery(f.checkpoint), /attachments do not match/)
    } finally { await f.dispose() }
  })
}
