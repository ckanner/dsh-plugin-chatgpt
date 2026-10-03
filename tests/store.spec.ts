import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyDocument, readDocument, removeDocument, writeDocument } from '../src/auth/store.ts'
import type { ChatGptCredential } from '../src/auth/credential.ts'

const dirs: string[] = []

async function file(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'chatgpt-store-'))
  dirs.push(created)
  return join(created, 'chatgpt-auth.json')
}

const GRANT: ChatGptCredential = {
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresAt: 1_800_000_000_000,
  clientId: 'oaiapp_x',
  scopes: ['chatgpt.tokens.use.direct'],
  subject: 'subject-1',
  savedAt: 1,
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(entry => rm(entry, { recursive: true, force: true })))
})

describe('credential store', () => {
  it('round-trips a document', async () => {
    const path = await file()
    const document = { ...emptyDocument('urn:uuid:x'), accounts: { 'subject-1': GRANT }, active: 'subject-1' }

    writeDocument(path, document)

    assert.deepEqual(readDocument(path), document)
  })

  it('answers undefined for an absent file rather than throwing', async () => {
    assert.equal(readDocument(await file()), undefined)
  })

  it('refuses a corrupt document by name, so the human can act', async () => {
    const path = await file()
    await writeFile(path, '{ not json', 'utf8')

    assert.throws(() => readDocument(path), /not valid JSON.*delete it and sign in again/s)
  })

  it('refuses an unrecognised shape instead of guessing', async () => {
    const path = await file()
    await writeFile(path, JSON.stringify({ version: 99, accounts: {} }), 'utf8')

    assert.throws(() => readDocument(path), /unrecognised shape/)
  })

  it('writes owner-only', async () => {
    const path = await file()
    writeDocument(path, emptyDocument('urn:uuid:x'))

    const mode = (await stat(path)).mode & 0o777
    assert.equal(mode, 0o600)
  })

  it('replaces atomically, leaving no temporary file behind', async () => {
    const path = await file()
    writeDocument(path, { ...emptyDocument('urn:uuid:x'), active: 'a' })
    writeDocument(path, { ...emptyDocument('urn:uuid:x'), active: 'b' })

    assert.equal((readDocument(path))?.active, 'b')
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(join(path, '..'))
    assert.deepEqual(entries, ['chatgpt-auth.json'])
  })

  it('stores tokens as opaque strings, never re-serialised', async () => {
    const path = await file()
    writeDocument(path, { ...emptyDocument('urn:uuid:x'), accounts: { s: GRANT }, active: 's' })

    const text = await readFile(path, 'utf8')
    assert.match(text, /"accessToken": "access"/)
  })

  it('removes the document on sign-out', async () => {
    const path = await file()
    writeDocument(path, emptyDocument('urn:uuid:x'))

    removeDocument(path)

    assert.equal(readDocument(path), undefined)
  })
})
