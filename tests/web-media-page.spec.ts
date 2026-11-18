import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { parseHTML } from 'linkedom'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { ChatGptPage } from '../src/web/browser/page.ts'
import type { CdpPage } from '../src/web/browser/cdp.ts'
import { prepareWebMedia } from '../src/web/media.ts'
import { digest } from '../src/web/browser/storage.ts'
import type { WebConnection, WebTurnRequest } from '../src/web/browser/types.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/an8AAAAASUVORK5CYII=', 'base64')

test('production page uploads, rechecks account/model and binds each image to the accepted user message', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'web-upload-page-'))
  try {
    const attachment = { attachmentId: 'screen', mediaType: 'image/png', bytes: png.length, width: 1, height: 1 }
    const options = { messages: [{ role: 'tool', toolCallId: 'host_screen', content: [{ type: 'image', attachment }] }] } as unknown as GenerateOptions
    const media = await prepareWebMedia(options, join(directory, 'images'), () => ({ async readImage() { return { ref: attachment, data: png } } }), Date.now() + 5000)
    for (const scenario of ['complete', 'failed', 'navigation', 'staged-extra'] as const) {
      const { window, document } = parseHTML('<html><body></body></html>')
      let focus: HTMLTextAreaElement | undefined
      Object.defineProperty(window.HTMLElement.prototype, 'getClientRects', { configurable: true, value() { return [{}] } })
      Object.defineProperty(window.HTMLElement.prototype, 'focus', { configurable: true, value(this: HTMLTextAreaElement) { focus = this } })
      Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' })
      const location = { href: 'https://chatgpt.com/' }
      const globals = { document, location, HTMLImageElement: window.HTMLImageElement, HTMLElement: window.HTMLElement }
      let submits = 0, selected = 0, accounts = 0
      const append = (text: string) => { const holder = document.createElement('div'); holder.innerHTML = text; const element = holder.firstElementChild!; document.body.append(element); return element }
      const render = () => {
        document.body.innerHTML = '<button data-testid="accounts-profile-button">Account</button><button data-codex-intelligence-trigger="true">Model</button><form data-chatgpt-composer><textarea id="prompt-textarea"></textarea><input type="file" accept="image/*" multiple><button type="button" data-testid="send-button">Send</button></form>'
        document.querySelector('[data-testid="accounts-profile-button"]')!.addEventListener('click', () => { accounts++; append('<div role="menu">fixture@example.invalid</div>') })
        document.querySelector('[data-codex-intelligence-trigger]')!.addEventListener('click', () => append('<div role="menu"><button role="menuitemradio" aria-checked="true">GPT-6</button><button role="menuitemradio" aria-checked="true">Pro</button></div>'))
        document.querySelector('[data-testid="send-button"]')!.addEventListener('click', () => {
          submits++
          const prompt = document.querySelector<HTMLTextAreaElement>('textarea')!.value
          const user = append('<article data-testid="conversation-turn-1"><div data-message-author-role="user" data-message-id="u1"><div data-message-content></div></div></article>')
          user.querySelector('[data-message-content]')!.textContent = prompt
          for (const tile of document.querySelectorAll('form [data-testid="file-upload"]')) user.querySelector('[data-message-author-role]')!.append(tile)
          append('<article data-testid="conversation-turn-2"><div data-message-author-role="assistant" data-message-id="a1"><div class="markdown">a model answer</div></div><button data-testid="copy-turn-action-button">Copy</button></article>')
          location.href = 'https://chatgpt.com/c/owned-image-chat'
        })
        const unrelatedSend = document.createElement('button'); unrelatedSend.setAttribute('data-testid', 'send-button')
        unrelatedSend.addEventListener('click', () => { throw new Error('Send must belong to the same composer as the uploaded images') })
        document.body.prepend(unrelatedSend)
      }
      const raw = {
        targetId: 'owned-image-page', cdp: { beginCleanup() {} },
        async evaluate<T>(expression: string) { return runInNewContext(expression, globals) as T },
        async navigate(url: string) { location.href = url; render() },
        async insertText(text: string) { assert.ok(focus); focus.value = text },
        async escape() { for (const node of document.querySelectorAll('[role="menu"],[role="dialog"]')) node.remove() },
        async setFileInputFiles(paths: string[], url: string) {
          selected++; assert.equal(url, location.href); assert.equal(paths.length, 1); assert.deepEqual(await readFile(paths[0]!), png)
          if (scenario === 'navigation') location.href = 'https://chatgpt.com/c/not-owned'
          const tile = document.createElement('div'); tile.setAttribute('data-testid', 'file-upload'); tile.setAttribute('data-filename', media[0]!.uploadName)
          tile.setAttribute('data-upload-status', scenario === 'failed' ? 'failed' : 'complete'); tile.setAttribute('data-file-id', 'remote-image')
          document.querySelector('form')!.append(tile)
        },
        async close() {},
      } as unknown as CdpPage
      const connection: WebConnection = { id: 'fixture', browserPath: '/unused', profilePath: '/unused/profile', stateDir: directory, accountFingerprint: digest('fixture@example.invalid') }
      const request: WebTurnRequest = { requestId: scenario, executionDomainId: 'domain', sessionId: 'session', generation: 1, bindingDigest: digest('bound'), prompt: 'exact image prompt', media, title: 'Image test', deadlineMs: Date.now() + 5000, contextPolicy: 'personalized', maxPromptBytes: 1000, maxResponseBytes: 1000 }
      const page = new ChatGptPage(raw, connection, request)
      await page.prepare(request)
      if (scenario === 'staged-extra') {
        const extra = document.createElement('div'); extra.setAttribute('data-testid', 'file-upload'); document.querySelector('form')!.append(extra)
      }
      if (scenario === 'complete') {
        await page.submit(request.prompt)
        const sample = await page.sample()
        assert.equal(submits, 1); assert.equal(selected, 1); assert.equal(accounts, 2)
        assert.equal(sample.userMessageId, 'u1'); assert.equal(sample.acceptedPrompt, request.prompt)
        assert.deepEqual([...sample.acceptedMedia!], [media[0]!.uploadName]); assert.equal(sample.text, 'a model answer')
      } else {
        await assert.rejects(() => page.submit(request.prompt), /upload|attachments|conversation/i)
        assert.equal(submits, 0)
        if (scenario === 'staged-extra') assert.equal(selected, 0)
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
