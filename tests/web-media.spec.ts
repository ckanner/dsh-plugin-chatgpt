import assert from 'node:assert/strict'
import { link, lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { parseHTML } from 'linkedom'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { assertAcceptedWebMedia, prepareWebMedia, readWebMediaArtifact, validateWebMedia, webImageName, WEB_IMAGE_POLICY } from '../src/web/media.ts'
import { composerImageInput, imageUploadEvidence } from '../src/web/browser/media-dom.ts'
import { projectMessages, WebSessionCoordinator, type WebCallContext, type WebTransportPort } from '../src/web/session-coordinator.ts'
import { defaultWebSettings, parseWebSettings } from '../src/web/config.ts'
import { DEFAULT_WEB_IMAGE_LIMITS } from '../src/web/image-policy.ts'
import { WEB_EFFORT, WEB_MODEL_ID, WEB_PROTOCOL, webModel } from '../src/web/policy.ts'
import { digest } from '../src/web/browser/storage.ts'
import type { WebTurnRequest, WebTurnResult } from '../src/web/browser/types.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/an8AAAAASUVORK5CYII=', 'base64')
const ref = (attachmentId = 'screen') => ({ attachmentId, mediaType: 'image/png', bytes: png.byteLength, width: 1, height: 1 })
const request = (messages: unknown[]): GenerateOptions => ({ provider: 'chatgpt', model: WEB_MODEL_ID, reasoningEffort: WEB_EFFORT as never, messages: messages as GenerateOptions['messages'] })
const image = (id = 'screen') => ({ type: 'image', attachment: ref(id) })
const reader = () => ({ async readImage(value: unknown) { return { ref: value, data: png } } })
const input = () => request([{ role: 'user', content: [{ type: 'text', text: 'Explain this screen' }, image()] }])

test('image budgets migrate old settings and validate configurable limits under absolute ceilings', async () => {
  const settings = defaultWebSettings('/private/fixture')
  const { imagePolicy: _imagePolicy, ...old } = settings
  assert.deepEqual(parseWebSettings(old).imagePolicy, DEFAULT_WEB_IMAGE_LIMITS)
  assert.equal(parseWebSettings({ ...settings, imagePolicy: { ...settings.imagePolicy, maxImages: 20 } }).imagePolicy.maxImages, 20)
  assert.throws(() => parseWebSettings({ ...settings, imagePolicy: { ...settings.imagePolicy, maxImages: 21 } }), /range/)
  assert.throws(() => parseWebSettings({ ...settings, imagePolicy: { ...settings.imagePolicy, maxTotalBytes: 1024 } }), /maximum-sized/)
  const dir = await mkdtemp(join(tmpdir(), 'web-image-limit-'))
  try {
    await assert.rejects(() => prepareWebMedia(request([{ role: 'user', content: [image('one'), image('two')] }]), dir, reader, Date.now() + 1000, { ...settings.imagePolicy, maxImages: 1 }), /configured count/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('web image resolver retains user/tool associations, private bytes and occurrence-specific filenames', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-images-'))
  try {
    let reads = 0
    const original = request([{ role: 'user', content: [image()] }, { role: 'tool', toolCallId: 'request_call', content: [{ type: 'text', text: 'Screenshot' }, image()] }])
    const before = structuredClone(original)
    const media = await prepareWebMedia(original, dir, () => ({ async readImage(value: unknown) { reads++; return { ref: value, data: png } } }), Date.now() + 5000)
    assert.equal(reads, 1, 'one authoritative read for repeated identical references')
    assert.equal(media.length, 2)
    assert.equal(media[1]!.toolCallId, 'request_call'); assert.equal(media[1]!.messageIndex, 1); assert.equal(media[1]!.blockIndex, 1)
    assert.notEqual(media[0]!.uploadName, media[1]!.uploadName)
    assert.equal(media[0]!.artifact.sha256, digest(png))
    assert.deepEqual(await readWebMediaArtifact(media[0]!, dir), png)
    assert.equal((await stat(media[0]!.artifact.path)).mode & 0o077, 0)
    assert.deepEqual(original, before, 'raw host history keeps references')
    const projected = projectMessages(original, media)
    assert.equal((projected[1]!.content as Record<string, unknown>[])[1]!.uploadName, media[1]!.uploadName)
    assert.equal(projected[1]!.toolCallId, 'request_call')
    assert.ok(!JSON.stringify(projected).includes(png.toString('base64')), 'image bytes stay in the attachment path rather than model text')
    assertAcceptedWebMedia(media, media.map(value => value.uploadName).reverse())
    assert.throws(() => assertAcceptedWebMedia(media, [media[0]!.uploadName]), /do not match/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('offloaded images remain explicit absence notes and never read or upload bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-offload-'))
  try {
    const options = request([{ role: 'user', content: [{ ...image(), offloaded: true }] }])
    const media = await prepareWebMedia(options, dir, () => { throw new Error('must not resolve'); }, Date.now() + 5000)
    assert.deepEqual(media, [])
    assert.match(JSON.stringify(projectMessages(options, media)), /offloaded by the host/)
    assert.ok(webModel('chatgpt').inputModalities.includes('image'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('media admission rejects unsupported files, roles, orphan tool images, limits and conflicting references before reads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-media-refusal-'))
  try {
    let reads = 0
    const resolve = () => { reads++; return reader() }
    const cases = [
      request([{ role: 'user', content: [{ type: 'file', attachment: { name: 'report.pdf' } }] }]),
      request([{ role: 'assistant', content: [image()] }]),
      request([{ role: 'tool', content: [image()] }]),
      request([{ role: 'user', content: Array.from({ length: WEB_IMAGE_POLICY.maxImages + 1 }, (_, i) => image(String(i))) }]),
      request([{ role: 'user', content: [image(), { type: 'image', attachment: { ...ref(), width: 2 } }] }]),
      request([{ role: 'user', content: [{ type: 'image', attachment: { ...ref(), mediaType: 'image/svg+xml' } }] }]),
      request([{ role: 'user', content: [{ type: 'image', attachment: { ...ref(), bytes: WEB_IMAGE_POLICY.maxImageBytes + 1 } }] }]),
    ]
    for (const options of cases) await assert.rejects(() => prepareWebMedia(options, dir, resolve, Date.now() + 5000), /image media/)
    assert.equal(reads, 0)
    await assert.rejects(() => prepareWebMedia(input(), dir, undefined, Date.now() + 5000), /service is unavailable/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('durable reader metadata, lengths, format and cancellation are verified before artifacts exist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-media-integrity-'))
  try {
    await assert.rejects(() => prepareWebMedia(input(), dir, () => ({ async readImage() { return { ref: ref(), data: png.subarray(1) } } }), Date.now() + 5000), /do not match/)
    await assert.rejects(() => prepareWebMedia(input(), dir, () => ({ async readImage() { return { ref: { ...ref(), width: 2 }, data: png } } }), Date.now() + 5000), /do not match/)
    await assert.rejects(() => prepareWebMedia(input(), dir, () => ({ async readImage() { return { ref: ref(), data: Buffer.alloc(png.length) } } }), Date.now() + 5000), /format/)
    const controller = new AbortController()
    const aborted = { ...input(), signal: controller.signal }
    const reading = prepareWebMedia(aborted, dir, () => ({ async readImage(_ref: unknown, signal: AbortSignal) { return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) } }), Date.now() + 5000)
    controller.abort(new Error('caller stopped'))
    await assert.rejects(reading, /caller stopped/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('changed, truncated, linked and escaped artifacts cannot be re-uploaded or silently overwritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-media-artifact-'))
  try {
    const media = await prepareWebMedia(input(), dir, reader, Date.now() + 5000)
    const item = media[0]!
    await writeFile(item.artifact.path, Buffer.alloc(png.length), { mode: 0o600 })
    await assert.rejects(() => readWebMediaArtifact(item, dir), /changed/)
    await assert.rejects(() => prepareWebMedia(input(), dir, reader, Date.now() + 5000), /changed/)
    await writeFile(item.artifact.path, png.subarray(1))
    await assert.rejects(() => readWebMediaArtifact(item, dir), /size/)
    await rm(item.artifact.path)
    const elsewhere = join(dir, 'original.png'); await writeFile(elsewhere, png, { mode: 0o600 })
    await symlink(elsewhere, item.artifact.path)
    await assert.rejects(() => readWebMediaArtifact(item, dir), /ELOOP|symbolic/i)
    await rm(item.artifact.path); await link(elsewhere, item.artifact.path)
    await assert.rejects(() => readWebMediaArtifact(item, dir), /size, ownership or permissions/)
    await assert.rejects(() => prepareWebMedia(input(), dir, reader, Date.now() + 5000), /size, ownership or permissions/)
    assert.throws(() => validateWebMedia([{ ...item, uploadName: '../escaped.png' }]), /filename/)
    await assert.rejects(() => readWebMediaArtifact({ ...item, artifact: { ...item.artifact, path: join(dir, 'outside', item.uploadName) } }, dir), /escapes/)
    const missing = join(dir, 'missing')
    await assert.rejects(() => readWebMediaArtifact({ ...item, artifact: { ...item.artifact, path: join(missing, item.uploadName) } }, missing), /ENOENT/)
    await assert.rejects(() => lstat(missing), /ENOENT/, 'read-only recovery must not create the missing evidence directory')
    if (process.platform !== 'win32') {
      await rm(item.artifact.path)
      const fifo = spawnSync('mkfifo', ['-m', '600', item.artifact.path], { encoding: 'utf8', timeout: 3000 })
      assert.equal(fifo.status, 0, fifo.stderr || String(fifo.error ?? 'could not create fixture FIFO'))
      const source = new URL('../src/web/media.ts', import.meta.url).href
      const script = `import {readWebMediaArtifact} from ${JSON.stringify(source)};try{await readWebMediaArtifact(${JSON.stringify(item)},process.argv[1]);process.exit(2)}catch(error){if(!/size, ownership or permissions/.test(error.message))throw error;}`
      const read = spawnSync(process.execPath, ['--input-type=module', '-e', script, dir], { encoding: 'utf8', timeout: 3000 })
      assert.equal(read.status, 0, read.stderr || String(read.error ?? 'FIFO inspection blocked before its type check'))
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('exit immediately after image publication leaves one durable link that restart reuses without rewriting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-image-publish-'))
  try {
    const name = webImageName({ attachmentId: 'screen', mediaType: 'image/png', role: 'user', messageIndex: 0, blockIndex: 1 }, digest(png))
    const path = join(dir, name)
    const source = new URL('../src/web/media.ts', import.meta.url).href
    const script = `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';const original=fs.rename;fs.rename=async(...args)=>{await original(...args);if(args[1]===${JSON.stringify(path)})process.exit(86)};syncBuiltinESMExports();const {prepareWebMedia}=await import(${JSON.stringify(source)});const data=Buffer.from(${JSON.stringify(png.toString('base64'))},'base64');await prepareWebMedia(${JSON.stringify(input())},process.argv[1],()=>({async readImage(ref){return{ref,data}}}),Date.now()+5000);process.exit(2);`
    const exited = spawnSync(process.execPath, ['--input-type=module', '-e', script, dir], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(exited.status, 86, exited.stderr || String(exited.error ?? 'writer did not reach the publication exit'))
    const published = await stat(path)
    assert.equal(published.nlink, 1)
    assert.deepEqual(await readFile(path), png)
    const media = await prepareWebMedia(input(), dir, reader, Date.now() + 5000)
    const restored = await stat(path)
    assert.equal(media[0]!.artifact.path, path)
    assert.equal(restored.ino, published.ino, 'restart reuses the original artifact inode')
    assert.equal(restored.mtimeMs, published.mtimeMs, 'restart must not rewrite bytes')
    assert.deepEqual(await readWebMediaArtifact(media[0]!, dir), png)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

function dom(html: string) {
  const { document, window } = parseHTML(`<html><body>${html}</body></html>`)
  Object.defineProperty(window.HTMLElement.prototype, 'getClientRects', { configurable: true, value(this: HTMLElement) { return this.hidden ? [] : [{}] } })
  const globals = { document, HTMLImageElement: window.HTMLImageElement }
  return { document, call: (messageId?: string) => runInNewContext(`(${imageUploadEvidence.toString()})(${messageId === undefined ? '' : JSON.stringify(messageId)})`, globals) as ReturnType<typeof imageUploadEvidence> }
}

test('DOM upload admission requires positive completion, exact names and the same composer', () => {
  const name = `dsh-${'a'.repeat(20)}-${'b'.repeat(20)}.png`
  const f = dom(`<div data-testid="file-upload" data-upload-status="complete" data-filename="outside.png"></div><form data-chatgpt-composer><textarea id="prompt-textarea"></textarea><div data-testid="file-upload" data-filename="${name}"><img alt="${name}" src="blob:preview"></div><button data-testid="send-button">Send</button></form>`)
  let observed = f.call()
  assert.equal(observed.cards.length, 1)
  assert.equal(observed.cards[0]!.ready, false, 'local preview and enabled Send do not prove upload completion')
  const card = f.document.querySelector('form [data-testid="file-upload"]')!
  card.setAttribute('data-file-id', 'allocated-before-upload')
  observed = f.call(); assert.equal(observed.cards[0]!.ready, false, 'a preallocated file id without a spinner is not completion')
  card.setAttribute('data-upload-status', 'complete')
  observed = f.call(); assert.equal(observed.cards[0]!.ready, true); assert.equal(observed.cards[0]!.name, name)
  card.innerHTML += '<span role="progressbar"></span>'
  observed = f.call(); assert.equal(observed.busy, true); assert.equal(observed.cards[0]!.ready, false)
  card.innerHTML = `<img alt="${name}">`; card.setAttribute('data-upload-status', 'failed')
  observed = f.call(); assert.equal(observed.error, true); assert.equal(observed.cards[0]!.ready, false)
})

test('composer upload input includes the general picker but refuses ambiguous or out-of-scope controls', () => {
  const f = dom('<input type="file" id="outside" accept="image/*"><form data-chatgpt-composer><textarea id="prompt-textarea"></textarea><input type="file" id="owned"></form>')
  const pick = () => runInNewContext(`(${composerImageInput.toString()})().id`, { document: f.document })
  assert.equal(pick(), 'owned', 'the website general file picker can accept verified image files')
  const input = f.document.querySelector('#owned')!
  input.setAttribute('accept', 'application/pdf')
  assert.throws(pick, /ambiguous/)
  input.setAttribute('accept', 'image/*')
  assert.equal(pick(), 'owned')
  input.after(f.document.querySelector('#outside')!.cloneNode(true))
  assert.throws(pick, /ambiguous/)
})

test('accepted attachment evidence is scoped to the original user message and excludes its filename from prompt text', () => {
  const name = `dsh-${'a'.repeat(20)}-${'b'.repeat(20)}.png`
  const f = dom(`<article data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="u1"><div data-message-content>original prompt</div><div data-testid="file-card" data-file-id="remote1" data-filename="${name}"><span data-testid="file-name">${name}</span><img alt="${name}"></div></div></article><article data-testid="conversation-turn-2"><div data-message-author-role="user" data-message-id="u2"><div data-message-content>another prompt</div><div data-testid="file-card" data-file-id="remote2" data-filename="other.png">Other</div></div></article>`)
  const first = f.call('u1'), second = f.call('u2')
  assert.equal(first.cards.length, 1); assert.equal(first.cards[0]!.name, name); assert.equal(first.cards[0]!.ready, true)
  assert.equal(first.messageText, 'original prompt')
  assert.equal(second.cards[0]!.name, '')
  assert.equal(f.call('unknown').scopeReady, false)
})

test('session image deltas retain tool ownership and recover original artifacts without resolving or uploading again', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-image-session-'))
  try {
    const requests: WebTurnRequest[] = [], results = new Map<string, WebTurnResult>()
    const transport: WebTransportPort = {
      async run(value) {
        requests.push(value)
        const answer = requests.length === 1 ? { kind: 'tool_calls', calls: [{ id: 'screen', name: 'screenshot', arguments: {} }] } : { kind: 'final', text: 'Screen analysis complete' }
        const text = JSON.stringify({ protocol: WEB_PROTOCOL, requestId: value.requestId, generation: value.generation, ...answer })
        const conversation = { id: 'image-chat', url: 'https://chatgpt.com/c/image-chat' }
        const result: WebTurnResult = { requestId: value.requestId, text, responseId: `response-${value.requestId}`, conversation,
          artifact: { path: '/fixture/output.txt', bytes: Buffer.byteLength(text), sha256: digest(text) },
          facts: { dispatch: 'confirmed', outcome: 'captured', localCleanup: 'confirmed', remoteGeneration: 'completed', usage: 'unknown', replayAllowed: false },
          evidence: { adapter: 'chatgpt-dom/1', model: 'GPT-6', effort: 'Pro', accountFingerprint: 'a'.repeat(64), contextPolicy: value.contextPolicy, conversationUrl: conversation.url, capturedAt: Date.now(), bindingDigest: value.bindingDigest } }
        results.set(value.requestId, result); return result
      },
      async acknowledge() {},
      async recover(id) { const result = results.get(id)!; return { requestId: id, facts: result.facts, result } },
    }
    let reads = 0, interrupt = false
    const environment = { resolveAttachments: () => ({ async readImage(value: unknown) { reads++; return { ref: value, data: png } } }) }
    const report = async (_c: WebCallContext, _id: string, facts: WebTurnResult['facts']) => { if (interrupt && facts.outcome === 'captured') { interrupt = false; throw new Error('interrupted delivery') } }
    const coordinator = new WebSessionCoordinator(dir, transport, report, () => {}, environment)
    const settings = defaultWebSettings(dir); settings.enabled = true; settings.connections.default!.accountFingerprint = 'a'.repeat(64); settings.imagePolicy.maxImages = 1
    const context = (options: GenerateOptions): WebCallContext => ({ kind: 'main', sessionId: 's1', executionDomainId: 'domain', hostInvocationId: 'host', deadlineMs: Date.now() + 5000, active: true, requireIsolation: true, rawOptions: options, recovery: { requestHeaderSeq: 1, surfaceSeqs: [1] } })
    const firstOptions = input(); firstOptions.tools = [{ name: 'screenshot', description: 'Capture', parameters: { type: 'object', properties: {}, additionalProperties: false } }]
    const first = await coordinator.run(context(firstOptions), settings)
    await coordinator.acknowledge(first.reference, first.blocks, 'host-1')
    const secondOptions = { ...firstOptions, messages: [...firstOptions.messages, { role: 'assistant', content: first.blocks }, { role: 'tool', toolCallId: first.blocks[0]!.id, content: [image('lcu')] }] } as GenerateOptions
    const restarted = new WebSessionCoordinator(dir, transport, report, () => {}, { resolveAttachments: () => ({ async readImage(value: { attachmentId: string }) {
      assert.equal(value.attachmentId, 'lcu', 'an accepted prefix image must not be reread after restart')
      reads++; return { ref: value, data: png }
    } }) })
    interrupt = true
    await assert.rejects(() => restarted.run(context(secondOptions), settings), /interrupted delivery/)
    assert.equal(reads, 2, 'maxImages applies to each upload, even when authoritative history contains more images')
    assert.equal(requests[1]!.media?.length, 1)
    assert.equal(requests[1]!.media![0]!.role, 'tool'); assert.equal(requests[1]!.media![0]!.toolCallId, first.blocks[0]!.id)
    assert.equal(requests[1]!.media![0]!.messageIndex, 2)
    assert.equal(JSON.parse(requests[1]!.prompt).history, 'append-only-delta')
    assert.ok(!requests[1]!.prompt.includes(png.toString('base64')))
    assert.ok(!results.get(requests[1]!.requestId)!.text.includes(requests[1]!.media![0]!.uploadName), 'model response text remains separate from attachment receipts')
    const priorReads = reads
    const restored = new WebSessionCoordinator(dir, transport, async () => {}, () => {}, { resolveAttachments: () => { throw new Error('recovery must not read host attachments') } })
    await restored.recover(requests[1]!.requestId)
    const delivery = await restored.delivery(requests[1]!.requestId)
    assert.ok(delivery)
    assert.equal((delivery.recovery?.request.messages[2]!.content[0] as { attachment: { attachmentId: string } }).attachment.attachmentId, 'lcu')
    assert.equal(reads, priorReads); assert.equal(requests.length, 2)
    assert.deepEqual(await readFile(requests[1]!.media![0]!.artifact.path), png)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
