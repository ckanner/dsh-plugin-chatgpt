import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ManagedWebRuntime } from '../src/web-runtime/index.ts'
import { HANDSHAKE_FILE } from '../src/web-runtime/types.ts'

test('a detached daemon survives its first client process and exits only after the remaining client releases it', { timeout: 15_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-runtime-process-'))
  const stateDirectory = join(root, 'state')
  const pidFile = join(root, 'fixture-daemon-pid')
  const stoppedFile = join(root, 'fixture-daemon-stopped')
  const daemonScript = `
    import { startRuntimeDaemon } from ${JSON.stringify(new URL('../src/web-runtime/daemon.ts', import.meta.url).href)};
    import { assertProfileOwnership } from ${JSON.stringify(new URL('../src/web-bridge/journal.ts', import.meta.url).href)};
    import { writeFile } from 'node:fs/promises';
    const evidence = { ready: true, visibleAccount: 'process@example.test', accountBinding: 'process-account', model: 'GPT-6', effort: 'Pro', proAvailable: true, isPro: true, issues: [] };
    const runtime = await startRuntimeDaemon({ stateDirectory: process.argv[process.argv.indexOf('--state-directory') + 1], dependencies: {
      async launchChrome({ profileDirectory, ownership }) { assertProfileOwnership(ownership, profileDirectory); return { cdpUrl: 'http://127.0.0.1:12345', profileDirectory, ownerNonce: 'fixture', pid: -1, async close() {} }; },
      async inspectSetup() { return evidence; },
      async createTransport() { return { async inspectSetup() { return evidence; }, async prepare() {}, async submit() { return { promptId: 'fixture' }; }, async observe() { return { version: 1, complete: true, blocks: [{ type: 'text', text: 'ok' }] }; }, async recover() { return { kind: 'unknown' }; }, async discard() {}, async close() {} }; }
    }});
    await writeFile(${JSON.stringify(pidFile)}, String(process.pid), { mode: 0o600 });
    const stop = () => { void runtime.close(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    await runtime.closed;
    await writeFile(${JSON.stringify(stoppedFile)}, 'stopped', { mode: 0o600 });
  `
  const actorScript = `
    import { ManagedWebRuntime } from ${JSON.stringify(new URL('../src/web-runtime/index.ts', import.meta.url).href)};
    const manager = new ManagedWebRuntime({ stateDirectory: ${JSON.stringify(stateDirectory)}, provider: 'chatgpt', idleTimeoutMs: 1500,
      bridgeCommand: { executable: process.execPath, args: ['--input-type=module', '-e', ${JSON.stringify(daemonScript)}] } });
    await manager.setup(); await manager.verify(); await manager.setEnabled(true);
    const connection = await manager.connection();
    process.stdout.write(JSON.stringify({ instanceId: connection.instanceId }));
    await manager.dispose();
  `
  const actor = spawn(process.execPath, ['--input-type=module', '-e', actorScript], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  actor.stdout.on('data', chunk => { stdout += String(chunk) })
  actor.stderr.on('data', chunk => { stderr += String(chunk) })
  const second = new ManagedWebRuntime({ stateDirectory, provider: 'chatgpt' })
  t.after(async () => {
    await second.dispose()
    // Only this exact fixture's command line is eligible for emergency test
    // cleanup. Production code has no PID-based reclamation path.
    const pid = Number(await readFile(pidFile, 'utf8').catch(() => ''))
    if (pid > 0 && process.platform === 'linux') {
      const argv = await readFile(`/proc/${pid}/cmdline`).catch(() => Buffer.alloc(0))
      if (argv.toString().includes(daemonScript)) {
        try { process.kill(pid, 'SIGTERM') } catch {}
        for (let attempt = 0; attempt < 80; attempt++) {
          if (await readFile(stoppedFile).then(() => true, () => false)) break
          await delay(25)
        }
      }
    }
    if (actor.exitCode === null && actor.signalCode === null) actor.kill('SIGTERM')
    await rm(root, { recursive: true, force: true })
  })
  const [exit] = await once(actor, 'close')
  assert.equal(exit, 0, stderr)
  const original = JSON.parse(stdout) as { instanceId: string }
  const daemonPid = Number(await readFile(pidFile, 'utf8'))
  assert.notEqual(daemonPid, actor.pid)
  const connection = await second.connection()
  assert.equal(connection.instanceId, original.instanceId)
  await delay(1800)
  assert.equal((await second.status()).ready, true)
  await second.dispose()
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    if (await readFile(stoppedFile).then(() => true, () => false)) {
      await assert.rejects(readFile(join(stateDirectory, HANDSHAKE_FILE)), { code: 'ENOENT' })
      return
    }
    await delay(50)
  }
  assert.fail('Detached daemon did not complete its idle shutdown')
})
