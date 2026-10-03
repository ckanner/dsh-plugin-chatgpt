import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureHostId } from '../src/auth/host-id.ts'

const dirs: string[] = []

async function dir(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'chatgpt-host-id-'))
  dirs.push(created)
  return created
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(entry => rm(entry, { recursive: true, force: true })))
})

describe('ensureHostId', () => {
  it('mints a UUID on first use and persists the bare value', async () => {
    const stateDir = await dir()
    const file = join(stateDir, 'chatgpt-host-id')

    const hostId = ensureHostId({ file })

    assert.match(hostId, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    // The file keeps the bare UUID so it stays readable and hand-replaceable.
    const persisted = (await readFile(file, 'utf8')).trim()
    assert.match(persisted, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    assert.equal(hostId, `urn:uuid:${persisted}`)
  })

  it('answers the same id on every later call', async () => {
    const stateDir = await dir()
    const file = join(stateDir, 'chatgpt-host-id')

    const first = ensureHostId({ file })
    const second = ensureHostId({ file })

    assert.equal(second, first)
  })

  it('replaces a corrupt value instead of failing the sign-in', async () => {
    const stateDir = await dir()
    const file = join(stateDir, 'chatgpt-host-id')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, 'urn:uuid:not-a-uuid\n', 'utf8')

    assert.match(ensureHostId({ file }), /^urn:uuid:[0-9a-f-]{36}$/)
  })

  it('lowercases what it sends and stores', async () => {
    const stateDir = await dir()
    const file = join(stateDir, 'chatgpt-host-id')

    const hostId = ensureHostId({ file, randomUUID: () => '6F1C1A1E-2B3D-4C5E-8F90-1234567890AB' })

    assert.equal(hostId, 'urn:uuid:6f1c1a1e-2b3d-4c5e-8f90-1234567890ab')
  })

  it('still answers a usable id when the location is not writable', async () => {
    const stateDir = await dir()
    // A directory where the file belongs makes every write fail.
    const { mkdir } = await import('node:fs/promises')
    const file = join(stateDir, 'chatgpt-host-id')
    await mkdir(file, { recursive: true })

    assert.match(ensureHostId({ file }), /^urn:uuid:[0-9a-f-]{36}$/)
  })
})
