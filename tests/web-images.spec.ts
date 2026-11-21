import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureWebRequest, prepareWebRequest, type WebGenerateOptions } from '../src/web-bridge/request.ts'
import { attachmentBytes, imageDigest, resolveWebAttachments, validateAttachmentVersions } from '../src/web-bridge/attachments.ts'
import { openWebImageStore } from '../src/web-bridge/image-store.ts'
import { openWebBridge } from '../src/web-bridge/engine.ts'
import { requestHash, validateRequest } from '../src/web-bridge/protocol.ts'
import { type PageTurn, type WebBinding, type WebPageTransport } from '../src/web-bridge/contracts.ts'
import { JOURNAL_FILE } from '../src/web-bridge/journal.ts'

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64')
const binding: WebBinding = { protocolVersion: 1, installationId: 'install', provider: 'chatgpt', profileId: 'profile', accountBinding: 'account' }
const ref = { attachmentId: 'image-a', mediaType: 'image/png' as const, bytes: bytes.length, width: 1, height: 1 }
function input(): WebGenerateOptions {
  return { provider: 'chatgpt', model: 'gpt-6-pro-web', sessionId: 'session', messages: [{ id: 'user', role: 'user',
    content: [{ type: 'text', text: 'Describe it' }, { type: 'image', attachment: { ...ref } }] }] }
}
async function request() {
  const captured = captureWebRequest(input())
  const prepared = await resolveWebAttachments(captured, () => ({ readImage: async (identity: unknown) => ({ ref: identity, data: bytes }) }))
  return prepareWebRequest(prepared, binding, 'client', 'attempt')
}

test('snapshot preserves exact host image references, identity and digest before async resolution', async () => {
  const options = input()
  const captured = captureWebRequest(options)
  ;(options.messages[0]!.content[1] as { attachment: typeof ref }).attachment.bytes++
  let reads = 0
  const prepared = await resolveWebAttachments(captured, () => ({ readImage: async (identity: unknown) => {
    reads++; assert.deepEqual(identity, ref); return { ref: identity, data: bytes }
  } }))
  const value = prepareWebRequest(prepared, binding, 'client', 'attempt')
  assert.equal(reads, 1)
  assert.equal(value.messages[0]!.id, 'user')
  assert.deepEqual(value.messages[0]!.content[1], { type: 'image', attachmentVersion: imageDigest(bytes) })
  assert.deepEqual(attachmentBytes(value.attachmentVersions[0]!), bytes)
  assert.equal(value.attachmentVersions[0]!.uploadName, `dsh-${imageDigest(bytes).slice(7)}.png`)
})

test('host-offloaded image occurrences stay text and do not read or resurrect bytes', async () => {
  const options = input()
  Object.assign(options.messages[0]!.content[1]!, { offloaded: true })
  const prepared = await resolveWebAttachments(captureWebRequest(options), () => { throw new Error('must not read bytes') })
  const value = prepareWebRequest(prepared, binding, 'client', 'attempt')
  assert.deepEqual(value.attachmentVersions, [])
  assert.equal(value.messages[0]!.content[1]!.type, 'text')
})

test('the attachment reader cannot mutate captured reference metadata during asynchronous preparation', async () => {
  const snapshot = captureWebRequest(input())
  await assert.rejects(resolveWebAttachments(snapshot, () => ({ readImage: async (identity: typeof ref) => {
    identity.bytes++
    return { ref: identity, data: bytes }
  } })), { code: 'WEB_INVALID_ATTACHMENT' })
  assert.equal((snapshot.body.messages[0]!.content[1] as { attachment: typeof ref }).attachment.bytes, bytes.length)
})

test('file, wrong role, missing reader, and changed host bytes all fail before bridge admission', async () => {
  for (const mode of ['file', 'role', 'reader', 'bytes'] as const) {
    const options = input()
    if (mode === 'file') Object.assign(options.messages[0]!.content[1]!, { type: 'file' })
    if (mode === 'role') Object.assign(options.messages[0]!, { role: 'assistant' })
    await assert.rejects(resolveWebAttachments(captureWebRequest(options), mode === 'reader' ? undefined : () => ({
      readImage: async (identity: unknown) => ({ ref: identity, data: mode === 'bytes' ? bytes.subarray(0, -1) : bytes }),
    })), { code: 'WEB_INVALID_ATTACHMENT' })
  }
})

test('declared image count, per-image bytes and aggregate base64 budget are rejected before any host read', async () => {
  let reads = 0
  for (const mode of ['individual', 'count', 'aggregate']) {
    const count = mode === 'count' ? 21 : mode === 'aggregate' ? 2 : 1
    const declared = mode === 'individual' ? 20 * 1024 * 1024 + 1 : mode === 'aggregate' ? 13 * 1024 * 1024 : bytes.length
    const options = input()
    Object.assign(options.messages[0]!, { content: Array.from({ length: count }, (_, index) => ({
      type: 'image', attachment: { ...ref, attachmentId: `image-${index}`, bytes: declared },
    })) })
    await assert.rejects(resolveWebAttachments(captureWebRequest(options), () => ({ readImage: async () => {
      reads++; throw new Error('must reject declared reads before allocating image data')
    } })), { code: 'WEB_INVALID_ATTACHMENT' })
  }
  assert.equal(reads, 0)
})

test('wire versions are canonical, byte-verified, bounded and referenced exactly', async () => {
  const value = await request()
  for (const patch of [{ digest: `sha256:${'0'.repeat(64)}` }, { byteLength: bytes.length + 1 },
    { mimeType: 'image/jpeg' }, { uploadName: '../../file' }, { base64: bytes.toString('base64') + '\n' },
    { blobId: value.attachmentVersions[0]!.digest }]) {
    assert.throws(() => validateAttachmentVersions([{ ...value.attachmentVersions[0], ...patch }]), { code: 'WEB_INVALID_ATTACHMENT' })
  }
  const missing = structuredClone(value)
  missing.messages[0]!.content.pop()
  missing.idempotencyKey = requestHash(missing)
  assert.throws(() => validateRequest(missing, binding), { code: 'WEB_INVALID_ATTACHMENT' })
})

test('durable blob references keep the request identity, reuse bytes, and reopen exactly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-image-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'images')
  const store = await openWebImageStore(path, { initialize: true })
  const value = await request()
  const stored = await store.store(value)
  await store.store(value)
  assert.equal(requestHash(stored), value.idempotencyKey)
  assert.equal(stored.attachmentVersions[0]!.base64, undefined)
  assert.equal(stored.attachmentVersions[0]!.blobId, value.attachmentVersions[0]!.digest)
  assert.equal((await readdir(path)).length, 1)
  const reopened = await openWebImageStore(path)
  await reopened.verify(stored)
  assert.deepEqual(await reopened.hydrate(stored), value)
})

test('missing, corrupt, public or symlink image evidence is never silently recreated', async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-image-corrupt-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await openWebImageStore(join(root, 'images'), { initialize: true })
  const stored = await store.store(await request())
  const file = join(root, 'images', stored.attachmentVersions[0]!.digest.slice(7))
  await writeFile(file, Buffer.alloc(bytes.length))
  await assert.rejects(store.verify(stored), { code: 'WEB_ATTACHMENT_EVIDENCE' })
  await rm(file)
  await assert.rejects(store.hydrate(stored), { code: 'WEB_ATTACHMENT_EVIDENCE' })
  await writeFile(file, bytes, { mode: 0o644 })
  await assert.rejects(store.verify(stored), { code: 'WEB_ATTACHMENT_PERMISSIONS' })
  await chmod(file, 0o600)
  await rm(file)
  const outside = join(root, 'outside')
  await writeFile(outside, bytes, { mode: 0o600 })
  await symlink(outside, file)
  await assert.rejects(store.verify(stored), { code: 'WEB_ATTACHMENT_PERMISSIONS' })
})

test('engine journals only exact blob references and refuses a corrupt image on restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-engine-image-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const imageStore = await openWebImageStore(join(root, 'images'), { initialize: true })
  const seen: PageTurn[] = []
  const transport: WebPageTransport = {
    async prepare(turn) { seen.push(turn) }, async submit(turn) { seen.push(turn); return { promptId: 'prompt' } },
    async observe(turn) { seen.push(turn); return { version: 1, complete: true, blocks: [{ type: 'text', text: 'a pixel' }] } },
  }
  const options = { directory: join(root, 'journal'), profileDirectory: join(root, 'profile'), binding, transport, imageStore }
  const engine = await openWebBridge({ ...options, initialize: true })
  try { await engine.execute(await request()) } finally { await engine.close() }
  assert.equal(seen.length, 3)
  assert.ok(seen.every(turn => turn.request.attachmentVersions[0]?.base64 === bytes.toString('base64') && !turn.request.attachmentVersions[0]?.blobId))
  const journal = await readFile(join(root, 'journal', JOURNAL_FILE), 'utf8')
  assert.equal(journal.includes(bytes.toString('base64')), false)
  assert.equal(journal.includes('blobId'), true)
  await writeFile(join(root, 'images', imageDigest(bytes).slice(7)), Buffer.alloc(bytes.length))
  await assert.rejects(openWebBridge(options), { code: 'WEB_ATTACHMENT_EVIDENCE' })
})
