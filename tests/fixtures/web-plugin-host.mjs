/** Real public host integration. No profile login, browser, provider request or daemon is started. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ConfigEditor } from '@deepseek-ai/dsh-config-editor'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { ProxyAgent } from 'undici'
import * as chatgpt from '../../src/index.ts'
import { ManagedWebRuntime } from '../../src/web-runtime/index.ts'

const root = process.argv[2]
assert.ok(root, 'The verifier must provide a temporary directory')

function deferred() {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}

async function host(t, name) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  await ctx.plugin(LlmRuntime)
  return { ctx, config: { provider: 'chatgpt', stateDir: join(root, name) } }
}

for (const resource of ['Web management client', 'proxy transport']) {
  await test(`actual plugin unload awaits its ${resource}`, { timeout: 5000 }, async t => {
    const { ctx, config } = await host(t, resource.replaceAll(' ', '-'))
    const prototype = resource === 'Web management client' ? ManagedWebRuntime.prototype : ProxyAgent.prototype
    const method = resource === 'Web management client' ? 'dispose' : 'destroy'
    const original = prototype[method]
    const entered = deferred()
    const release = deferred()
    prototype[method] = async function (...args) {
      entered.resolve()
      await release.promise
      return original.apply(this, args)
    }
    let unloading
    try {
      const fiber = await ctx.plugin(chatgpt, { ...config, ...resource === 'proxy transport' ? { proxyUrl: 'http://127.0.0.1:9' } : {} })
      assert.equal(fiber.state, FiberState.ACTIVE, 'The real plugin must activate against the real registry')
      let finished = false
      unloading = fiber.dispose().then(() => { finished = true })
      await entered.promise
      await nextTurn()
      assert.equal(finished, false, 'Cordis must retain ownership until asynchronous cleanup settles')
      release.resolve()
      await unloading
      assert.equal(finished, true)
    } finally {
      release.resolve()
      await unloading
      prototype[method] = original
    }
  })
}

await test('actual Loader remounts for Web startup settings and preserves live budget updates', { timeout: 5000 }, async t => {
  const { ctx, config } = await host(t, 'configuration')
  const seen = []
  ctx.loader.builtins.chatgpt = { ...chatgpt, apply(owner, resolved) {
    seen.push(resolved)
    chatgpt.apply(owner, resolved)
  } }
  const first = { ...config, webChromeExecutable: '/fixture/chrome-a', webMaxInputBytes: 4096 }
  const id = await ctx.loader.create({ name: 'cordis:chatgpt', config: first })
  const entry = ctx.loader.resolve(id)
  await entry.fiber.await()
  assert.equal(entry.fiber.state, FiberState.ACTIVE)
  assert.equal(seen.length, 1)
  const initialExecutable = seen[0].webChromeExecutable
  assert.equal(typeof initialExecutable?.get === 'function' ? initialExecutable.get() : initialExecutable, '/fixture/chrome-a')
  const second = { ...first, webChromeExecutable: '/fixture/chrome-b' }
  await entry.update({ config: second })
  await entry.fiber.await()
  assert.equal(seen.length, 2, 'Changing Chrome path must replace the runtime options captured by apply')
  assert.equal(seen[1].webChromeExecutable, '/fixture/chrome-b')
  const third = { ...second, webMaxInputBytes: 8192 }
  await entry.update({ config: third })
  await entry.fiber.await()
  assert.equal(seen.length, 3, 'Changing prompt bytes must replace the runtime options captured by apply')
  assert.equal(seen[2].webMaxInputBytes, 8192)
  await entry.update({ config: { ...third, contextWindowLimit: 100000 } })
  await entry.fiber.await()
  assert.equal(seen.length, 3, 'The existing live token budget must retain its volatile behavior')
  assert.equal(seen[2].contextWindowLimit.get(), 100000)
})

await test('title inventory sees actual nested Include entries excluded by ConfigEditor', { timeout: 5000 }, async t => {
  const { ctx } = await host(t, 'titles')
  const directory = join(root, 'title-profile')
  await mkdir(directory)
  const nested = join(directory, 'nested.json')
  const profile = join(directory, 'profile.json')
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.title = { name: 'session-title-first-prompt-llm',
    Config: z.object({ provider: z.string(), model: z.string() }), apply() {} }
  await writeFile(nested, JSON.stringify([{ id: 'title', name: 'cordis:title', config: {} }]))
  await writeFile(profile, JSON.stringify([
    { id: 'title', name: 'cordis:title', config: { provider: 'api', model: 'title-model' } },
    { id: 'disabled-title', name: 'cordis:title', disabled: true },
    { id: 'nested', name: 'cordis:include', config: { path: pathToFileURL(nested).href } },
  ]))
  await ctx.loader.create({ id: 'include', name: 'cordis:include', config: { path: pathToFileURL(profile).href } })
  await ctx.loader.await()
  const editor = new ConfigEditor(ctx)
  assert.ok(editor.entries().some(entry => entry.id === 'include:title'))
  assert.equal(editor.entries().some(entry => entry.id === 'include:nested:title'), false,
    'The real ConfigEditor deliberately excludes nested Includes')
  assert.ok([...ctx.loader.entries()].some(entry => entry.id === 'include:nested:title'))
  assert.deepEqual(chatgpt.titleRoutes(ctx), [
    { name: 'session-title-first-prompt-llm', provider: 'api', model: 'title-model' },
    { name: 'session-title-first-prompt-llm' },
  ], 'The nested fallback title route must reach Web readiness validation; inactive rows stay excluded')
})
