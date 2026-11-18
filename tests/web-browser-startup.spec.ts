import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openBrowser } from '../src/web/browser/cdp.ts'
import { atomicPrivateWrite, BrowserStore, digest, privateRead } from '../src/web/browser/storage.ts'
import type { WebConnection } from '../src/web/browser/types.ts'

test('a cancelled startup waits for its existing Chrome owner instead of launching the same profile twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'web-startup-owner-'))
  const browserPath = join(root, 'fixture-browser')
  const connection: WebConnection = { id: 'fixture', browserPath, profilePath: join(root, 'profile'), stateDir: join(root, 'state'), accountFingerprint: digest('fixture@example.invalid') }
  await writeFile(browserPath, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
const profile = process.argv.find(value => value.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
appendFileSync(join(profile, 'fixture-launches'), 'launch\\n');
setInterval(() => {}, 1000);
`, { mode: 0o700 })
  let browserPid: number | undefined
  try {
    const cancellation = new AbortController()
    const original = assert.rejects(openBrowser(connection, Date.now() + 5000, cancellation.signal), /fixture cancellation/)
    const startedAt = Date.now()
    for (;;) {
      try { if ((await readFile(join(connection.profilePath, 'fixture-launches'), 'utf8')).length) break }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (Date.now() - startedAt > 3000) throw new Error('fixture process did not start')
      await new Promise<void>(resolve => setTimeout(resolve, 20))
    }
    const store = await BrowserStore.open(connection)
    browserPid = (JSON.parse(await privateRead(join(store.coordinationDir, 'chrome-owner.json'))) as { pid: number }).pid
    cancellation.abort(new Error('fixture cancellation')); await original
    await assert.rejects(openBrowser(connection, Date.now() + 180), /deadline/)
    assert.equal((await readFile(join(connection.profilePath, 'fixture-launches'), 'utf8')).split('launch').length - 1, 1)
    process.kill(browserPid, 0)
  } finally {
    if (browserPid) try { process.kill(browserPid, 'SIGTERM') } catch { /* already exited */ }
    await rm(root, { recursive: true, force: true })
  }
})

test('an uncertain launch intent cannot create a second Chrome process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'web-startup-intent-'))
  const connection: WebConnection = { id: 'fixture', browserPath: '/a/browser/that/must/not/launch', profilePath: join(root, 'profile'), stateDir: join(root, 'state'), accountFingerprint: digest('fixture@example.invalid') }
  try {
    const store = await BrowserStore.open(connection)
    await atomicPrivateWrite(join(store.coordinationDir, 'chrome-owner.json'), JSON.stringify({ version: 1, phase: 'launch-intent', launcherPid: process.pid, profilePath: store.profilePath }))
    await assert.rejects(openBrowser(connection, Date.now() + 150), /deadline/)
    assert.equal((JSON.parse(await privateRead(join(store.coordinationDir, 'chrome-owner.json'))) as { phase: string }).phase, 'launch-intent')
  } finally { await rm(root, { recursive: true, force: true }) }
})
