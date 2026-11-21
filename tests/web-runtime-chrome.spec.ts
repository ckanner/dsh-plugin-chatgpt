import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { acquireProfileOwnership } from '../src/web-bridge/journal.ts'
import { chromeArguments, launchOwnedChrome, type OwnedChrome } from '../src/web-runtime/chrome.ts'

async function fixture(t: TestContext, mode = 'normal') {
  const root = await mkdtemp(join(tmpdir(), 'web-owned-chrome-'))
  const profileDirectory = join(root, 'profile')
  const owner = await acquireProfileOwnership({ profileDirectory, initialize: true })
  const executable = join(root, 'fixture-chrome')
  const script = `#!${process.execPath}
    const { createServer } = require('node:http');
    const { createHash } = require('node:crypto');
    const { writeFileSync } = require('node:fs');
    const { spawn } = require('node:child_process');
    const { join } = require('node:path');
    const mode = ${JSON.stringify(mode)};
    const profile = process.argv.find(value => value.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
    const server = createServer((request, response) => {
      if (request.url === '/orphan') {
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        writeFileSync(join(profile, 'descendant-pid'), String(child.pid), { mode: 0o600 });
        response.end('exiting parent'); setTimeout(() => process.exit(0), 20); return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:' + server.address().port + '/devtools/browser/fixture' }));
    });
    server.on('upgrade', (request, socket) => {
      const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
      socket.once('data', () => {
        const args = [...process.argv];
        if (mode === 'duplicate-profile') args.push('--user-data-dir=/different/profile');
        if (mode === 'duplicate-owner') args.push('--dsh-web-owner=another-owner');
        const data = Buffer.from(JSON.stringify({ id: 1, result: { arguments: args } }));
        const head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(data.length, 2);
        socket.write(Buffer.concat([head, data]));
        socket.on('data', frame => { if ((frame[0] & 15) === 8) socket.end(Buffer.from([0x88, 0])); });
        if (mode.startsWith('duplicate')) setTimeout(() => process.exit(0), 40);
      });
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      writeFileSync(join(profile, 'DevToolsActivePort'), server.address().port + '\\n/devtools/browser/fixture', { mode: 0o600 });
      writeFileSync(join(profile, 'fixture-pid'), String(process.pid), { mode: 0o600 });
    });
  `
  await writeFile(executable, script, { mode: 0o700 })
  let chrome: OwnedChrome | undefined
  t.after(async () => {
    await chrome?.close().catch(() => undefined)
    // An orphan fixture deliberately makes automatic owner cleanup impossible.
    // The test acts as the offline operator only for its recorded descendant.
    const descendant = Number(await readFile(join(profileDirectory, 'descendant-pid'), 'utf8').catch(() => ''))
    if (descendant > 0) {
      const argv = await readFile(`/proc/${descendant}/cmdline`).catch(() => Buffer.alloc(0))
      if (argv.toString().includes('setInterval(() => {}, 1000)')) { try { process.kill(descendant, 'SIGKILL') } catch {} }
      for (let attempt = 0; attempt < 40; attempt++) {
        const stat = await readFile(`/proc/${descendant}/stat`, 'utf8').catch(() => '')
        if (!stat || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) break
        await delay(25)
      }
    }
    await owner.release()
    await rm(root, { recursive: true, force: true })
  })
  // acquireProfileOwnership() returns the physical directory. Keep the launch
  // and cleanup paths identical on systems where /var is a symlink.
  return { profileDirectory: owner.profileDirectory, owner, executable,
    async launch() { chrome = await launchOwnedChrome({ profileDirectory: owner.profileDirectory, ownership: owner, executable }); return chrome } }
}

test('owned launcher rejects a forged profile capability before invoking any executable', async t => {
  const f = await fixture(t)
  await assert.rejects(launchOwnedChrome({ profileDirectory: f.profileDirectory, ownership: { ...f.owner }, executable: f.executable }), { code: 'WEB_PROFILE_OWNERSHIP' })
  await assert.rejects(readFile(join(f.profileDirectory, 'fixture-pid')), { code: 'ENOENT' })
})

test('owned Chrome verifies public argv and waits for its detached process group to become quiescent', async t => {
  const f = await fixture(t)
  const chrome = await f.launch()
  const args = await chromeArguments(chrome.cdpUrl)
  assert.ok(args.includes(`--dsh-web-owner=${chrome.ownerNonce}`))
  assert.ok(args.includes(`--user-data-dir=${f.profileDirectory}`))
  assert.equal(args.includes('--remote-debugging-port=0'), true)
  await chrome.close()
  assert.throws(() => process.kill(-chrome.pid, 0), { code: 'ESRCH' })
})

test('duplicate Chrome profile or owner overrides are never accepted as ownership proof', async t => {
  for (const mode of ['duplicate-profile', 'duplicate-owner']) {
    const f = await fixture(t, mode)
    await assert.rejects(f.launch(), { code: 'WEB_CHROME_START' })
  }
})

test('a departed Chrome parent does not authorize releasing or signaling its surviving descendants', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t)
  const chrome = await f.launch()
  const response = await fetch(`${chrome.cdpUrl}/orphan`)
  await response.text()
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await readFile(`/proc/${chrome.pid}/cmdline`).then(() => false, () => true)) break
    await delay(20)
  }
  const descendant = Number(await readFile(join(f.profileDirectory, 'descendant-pid'), 'utf8'))
  process.kill(descendant, 0)
  await assert.rejects(chrome.close(), { code: 'WEB_CHROME_OWNERSHIP' })
  process.kill(descendant, 0)
  await assert.rejects(acquireProfileOwnership({ profileDirectory: f.profileDirectory }), { code: 'WEB_PROFILE_LOCKED' })
})

test('Chrome discovery stops after 64 KiB instead of buffering an unbounded response', async t => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('x'.repeat(70 * 1024))
    // Deliberately no EOF: the limit must reject before the fetch timeout.
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() }))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await assert.rejects(chromeArguments(`http://127.0.0.1:${address.port}`), /oversized/)
})
