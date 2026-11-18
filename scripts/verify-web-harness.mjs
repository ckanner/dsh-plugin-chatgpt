/**
 * Exercise the real DSH AgentLoop/BasicCompaction and this plugin's Web stack.
 * Only the browser page is a fixture; transport journals, provider conversion,
 * public hooks, host transactions, tool execution, and JSONL persistence are real.
 * Usage: node scripts/verify-web-harness.mjs /path/to/patched/deepseek-harness [/path/to/flywheel]
 */
import { build } from 'esbuild'
import { access, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

if (!process.argv[2]) throw new Error('Pass the source checkout with the documented DSH compatibility patch applied.')
const dsh = resolve(process.argv[2])
const flywheel = process.argv[3] ? join(resolve(process.argv[3]), 'plugins/dsh/src/web-policy.js') : undefined
if (flywheel) await access(flywheel)
const plugin = fileURLToPath(new URL('../', import.meta.url))
await access(join(dsh, 'packages/core/agent-loop/src/recovered-response.ts'))
const root = await mkdtemp(join(tmpdir(), 'chatgpt-web-harness-'))
try {
  await symlink(join(plugin, 'node_modules'), join(root, 'node_modules'), 'junction')
  // DSH's attribution module resolves ../package.json relative to its emitted
  // module. Preserve that relationship with the actual checkout manifest.
  await copyFile(join(dsh, 'packages/llm/llm/package.json'), join(root, 'package.json'))
  await mkdir(join(root, 'lib'))
  const source = `
    import assert from 'node:assert/strict';
    import { mkdir, readFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { Context } from '@deepseek-ai/cordis';
    import AgentRegistry from '@deepseek-ai/dsh-agent';
    import AgentLoop from '@deepseek-ai/dsh-agent-loop';
    import LlmRuntime, { createUserMessage, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
    import SessionStore from '@deepseek-ai/dsh-session';
    import SessionProjections from '@deepseek-ai/dsh-session-projection';
    import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
    import FsLocal from '@deepseek-ai/dsh-fs-local';
    import WorkingDirectory from '@deepseek-ai/dsh-working-directory';
    import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
    import ToolRuntime from '@deepseek-ai/dsh-tools';
    import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
    import TokenMeter from '@deepseek-ai/dsh-token-meter';
    import BasicCompaction from '@deepseek-ai/dsh-compaction-basic';
    import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit';
    import { HarnessAdapter } from ${JSON.stringify(join(plugin, 'src/index.ts'))};
    import * as ChatGPTPlugin from ${JSON.stringify(join(plugin, 'src/index.ts'))};
    import { installWebHost } from ${JSON.stringify(join(plugin, 'src/web/integration.ts'))};
    import { defaultWebSettings } from ${JSON.stringify(join(plugin, 'src/web/config.ts'))};
    import { WEB_MODEL_ID, WEB_EFFORT, WEB_PROTOCOL } from ${JSON.stringify(join(plugin, 'src/web/policy.ts'))};

    const root = ${JSON.stringify(root)};
    const flywheelModule = ${flywheel === undefined ? 'undefined' : JSON.stringify(pathToFileURL(flywheel).href)};
    const composition = new Context();
    try {
      await composition.plugin(LlmRuntime);
      await composition.plugin(ChatGPTPlugin, { provider: 'chatgpt-default', stateDir: join(root, 'default-plugin') });
      const status = await composition.get('chatgptWebHost').status();
      assert.equal(status.settings.enabled, false);
      assert.equal(status.managedByProfile, false);
      assert.deepEqual(await composition.llm.listModels('chatgpt-default'), [], 'unsigned SIWC discovery retains its normal empty roster');
      assert.ok(composition.llm.listProviders().some(provider => provider.id === 'chatgpt-default'));
      console.log('PASS real plugin composition: omitted Web config preserves defaults and unsigned SIWC discovery');
    } finally { await composition.fiber.dispose(); }

    class AlwaysAdapter extends HarnessAdapter {
      providerRetryPolicy() { return resolveRetryPolicy({ mode: 'always' }, 'integration-fixture'); }
    }
    function pages(answer) {
      const requests = [];
      const counts = { opens: 0, submits: 0, closes: 0, stops: 0 };
      return {
        requests, counts,
        factory: {
          async connect() { throw new Error('connection UI is outside this offline scenario'); },
          async open(connection, request) {
            counts.opens++;
            requests.push(request);
            const index = requests.length;
            const conversation = request.conversation ?? { id: 'chat-' + index, url: 'https://chatgpt.com/c/chat-' + index, title: request.title };
            const evidence = { adapter: 'chatgpt-dom/1', model: 'GPT-6', effort: 'Pro', accountFingerprint: connection.accountFingerprint, contextPolicy: request.contextPolicy, conversationUrl: conversation.url, capturedAt: Date.now(), bindingDigest: request.bindingDigest };
            const response = await answer(request, index);
            const text = JSON.stringify({ protocol: WEB_PROTOCOL, requestId: request.requestId, generation: request.generation, ...response });
            return {
              targetId: 'fixture-tab-' + index,
              async prepare(_request, beforeMutation) { await beforeMutation?.(); return { conversation, evidence }; },
              async inspect() { return { conversation, evidence }; },
              async submit(prompt) { counts.submits++; assert.equal(prompt, request.prompt); if (response.submitFailure) throw new Error('observer lost after submit click'); },
              async sample() { return { conversation, userMessageId: 'user-' + index, acceptedPrompt: request.prompt, responseId: 'answer-' + index, text, stopVisible: false, thinking: false, finishedActions: true }; },
              async stop() { counts.stops++; return false; },
              async close() { counts.closes++; },
            };
          },
        },
      };
    }

    async function fixture(name, page, automatic = false, always = false) {
      const directory = join(root, name);
      await mkdir(directory, { recursive: true });
      const ctx = new Context();
      try {
        for (const definition of [LlmRuntime, SessionStore, SessionProjections, SystemPrompt, ToolRuntime, NativeToolExecutor, AgentRegistry, TokenMeter]) await ctx.plugin(definition);
        await ctx.plugin(FsLocal, { cwd: directory });
        await ctx.plugin(WorkingDirectory);
        await ctx.plugin(JsonlSessionPersistence, { root: join(directory, 'sessions'), compression: 'none' });
        await ctx.plugin(BasicCompaction, { auto: automatic });
        await ctx.plugin(AgentLoop, { agents: [] });
        const settings = defaultWebSettings(directory);
        settings.enabled = true;
        if (automatic) settings.budget = { ...settings.budget, maxInputBytes: 24 * 1024, outputReserveBytes: 8 * 1024 };
        settings.connections.default.accountFingerprint = 'a'.repeat(64);
        const host = installWebHost(ctx, directory, 'chatgpt-test', () => settings, { pageFactory: page.factory });
        const inner = {
          providerInfo(provider) { return { id: provider, name: 'Fixture' }; },
          async listModels() { throw new Error('SIWC catalog must not serve Web'); },
          async resolveModel() { throw new Error('SIWC metadata must not serve Web'); },
          async *stream() { throw new Error('SIWC transport must not serve Web'); },
        };
        const Adapter = always ? AlwaysAdapter : HarnessAdapter;
        ctx.llm.registerAdapter(['chatgpt-test'], new Adapter(inner, 'chatgpt-test', host));
        const agent = await ctx.agentLoop.create('session-' + name, { provider: 'chatgpt-test', model: WEB_MODEL_ID, reasoningEffort: WEB_EFFORT }, { cwd: directory });
        const send = async (text) => { agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })); await agent.whenIdle(); };
        return { ctx, agent, host, settings, directory, send,
          async durableEvents() { await using handle = await ctx.sessionPersistence.open(agent.id, 'read'); return (await handle.read()).events; },
          async dispose() { await agent.whenIdle(); await ctx.fiber.dispose(); },
        };
      } catch (error) { await ctx.fiber.dispose(); throw error; }
    }

    const toolPages = pages((_request, index) => index === 1
      ? { kind: 'tool_calls', calls: [{ id: 'read1', name: 'read_file', arguments: { path: 'main.ts' } }] }
      : { kind: 'final', text: 'Reviewed main.ts successfully.' });
    const tools = await fixture('tools', toolPages);
    try {
      let executions = 0;
      tools.ctx.tools.register(defineContentToolFixture({
        name: 'read_file', description: 'Read the local fixture',
        parameters: { path: { type: 'string', description: 'Local fixture path' } },
        async execute(args) {
          executions++;
          assert.equal(args.path, 'main.ts');
          const durable = await tools.durableEvents();
          assert.ok(durable.some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'tool-call')));
          assert.equal((await tools.host.status()).pending.length, 0, 'provider response must be acknowledged before tool effects');
          return [{ type: 'text', text: 'export const value = 1;' }];
        },
      }));
      await tools.send('Read main.ts and review the implementation.');
      assert.equal(executions, 1);
      assert.equal(toolPages.counts.submits, 2);
      assert.equal(toolPages.counts.closes, toolPages.counts.opens);
      const last = tools.agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message');
      assert.equal(last.data.message.content[0].text, 'Reviewed main.ts successfully.');
      const second = JSON.parse(toolPages.requests[1].prompt);
      assert.equal(second.history, 'append-only-delta');
      assert.ok(second.messages.some(message => message.role === 'tool'));
      await tools.host.guardSession(tools.agent.id, tools.directory);
      console.log('PASS real AgentLoop: captured response -> durable ACK -> one tool -> result -> final');
    } finally { await tools.dispose(); }

    const recoveryPages = pages(() => ({ kind: 'tool_calls', calls: [{ id: 'recover-read1', name: 'read_file', arguments: { path: 'captured.ts' } }] }));
    const recovered = await fixture('recovery', recoveryPages);
    try {
      let executions = 0;
      recovered.ctx.tools.register(defineContentToolFixture({
        name: 'read_file', description: 'Read the recovered fixture', parameters: { path: { type: 'string', description: 'Local fixture path' } },
        async execute(args) {
          executions++;
          assert.equal(args.path, 'captured.ts');
          assert.equal((await recovered.host.status()).pending.length, 0, 'recovery must ACK the durable response before executing tools');
          assert.ok((await recovered.durableEvents()).some(event => event.type === 'assistant/message' && event.data.recovered));
          return [{ type: 'text', text: 'Recovered local contents.' }];
        },
      }));
      const detach = recovered.ctx.on('llm/stream', (options, next) => ({ async *[Symbol.asyncIterator]() {
        yield* next();
        throw new Error('fixture consumer disconnected after the complete remote artifact was captured');
      } }));
      await recovered.send('Read captured.ts once.');
      detach();
      assert.equal(executions, 0);
      assert.equal(recovered.agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 0);
      const pending = (await recovered.host.status()).pending;
      if (pending.length !== 1) console.error('recovery diagnostic', JSON.stringify({ submits: recoveryPages.counts.submits, pending, events: recovered.agent.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data) }));
      assert.equal(pending.length, 1, 'the captured response must remain pending after consumer disconnection');
      const requestId = pending[0].requestIds[0];
      const adopted = await recovered.host.recover(requestId, true);
      assert.equal(adopted.alreadyCommitted, false);
      assert.equal(adopted.needsContinuation, true);
      assert.equal(executions, 1, 'adoption must execute the captured tool once');
      // Let the real idle settlement verify the durable tool result, then an
      // explicit repeat may only re-ACK the same original host message.
      await recovered.host.guardSession(recovered.agent.id, recovered.directory);
      const duplicate = await recovered.host.recover(requestId, true);
      assert.equal(duplicate.alreadyCommitted, true);
      assert.equal(duplicate.messageId, adopted.messageId);
      assert.equal(executions, 1);
      assert.equal(recoveryPages.counts.submits, 1);
      console.log('PASS real recovery: captured artifact -> JSONL-backed adoption -> one tool, idempotent duplicate');
    } finally { await recovered.dispose(); }

    const compactPages = pages((request) => {
      const payload = JSON.parse(request.prompt);
      const isSummary = payload.messages.some(message => message.content?.some(block => block.type === 'text' && block.text.includes('You are now acting as a compaction engine')));
      return { kind: 'final', text: isSummary ? 'Checkpoint: preserve the requested implementation and verify it.' : 'Implementation details. '.repeat(140) };
    });
    const compact = await fixture('compaction', compactPages, true);
    try {
      for (let index = 0; index < 3; index++) await compact.send(('Task ' + index + ': retained requirement. ').repeat(100));
      const automatic = compact.agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary');
      if (automatic.length === 0) console.error('compaction diagnostic', JSON.stringify({ requests: compactPages.requests.map(request => ({title:request.title, bytes:Buffer.byteLength(request.prompt)})), events:compact.agent.session.snapshotEvents().filter(event => event.type === 'compaction/end' || event.type === 'turn/end').map(event => event.data), pending:(await compact.host.status()).pending }));
      assert.ok(automatic.length > 0, 'automatic pre-step compaction must use the Web route');
      for (const event of automatic) assert.equal(event.data.reasoningEffort, WEB_EFFORT);
      const before = compact.agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').length;
      const result = await compact.ctx.compaction.compactNow(compact.agent, new AbortController().signal);
      assert.ok(result, 'manual compaction must commit a useful checkpoint');
      const summary = compact.agent.session.eventAt(result.summarySeq);
      assert.equal(summary.data.model, WEB_MODEL_ID);
      assert.equal(summary.data.reasoningEffort, WEB_EFFORT);
      assert.equal(compact.agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, before);
      assert.equal((await compact.host.status()).pending.length, 0, 'summary needs its own durable ACK');
      assert.equal(compactPages.counts.closes, compactPages.counts.opens);
      console.log('PASS real BasicCompaction: automatic + manual Web/Pro summaries and separate durable ACK');
    } finally { await compact.dispose(); }

    const failedPages = pages(() => ({ kind: 'final', text: 'never delivered', submitFailure: true }));
    const failed = await fixture('always-veto', failedPages, false, true);
    try {
      const retries = [];
      failed.ctx.on('agent/request-error', () => { retries.push('attempted retry recovery'); return { kind: 'retry' }; });
      await failed.send('Perform the requested task exactly once.');
      assert.equal(failedPages.counts.submits, 1);
      assert.equal(retries.length, 0, 'hard replay veto must precede an always retry policy');
      assert.equal(failed.agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').length, 0);
      const pending = (await failed.host.status()).pending;
      assert.equal(pending.length, 1);
      await failed.send('Do not start a second remote call while the domain is unresolved.');
      assert.equal(failedPages.counts.submits, 1);
      assert.equal(failedPages.counts.closes, failedPages.counts.opens);
      console.log('PASS real hard veto: ambiguous submission blocks always retry and later domain dispatch');
    } finally { await failed.dispose(); }

    if (flywheelModule) {
      const { createWebPolicy } = await import(flywheelModule);
      const workerPages = pages(() => ({ kind: 'final', text: 'The admitted Flywheel invocation completed.' }));
      const worker = await fixture('flywheel-policy', workerPages);
      let disposed = false;
      try {
        const receipts = join(worker.directory, 'worker-receipts');
        await mkdir(receipts);
        const identity = { sessionId: worker.agent.id, executionDomainId: 'flywheel-real-domain', hostInvocationId: 'flywheel-real-invocation' };
        const config = { provider: 'chatgpt-test', model: WEB_MODEL_ID, reasoningEffort: WEB_EFFORT,
          requestId: 'flywheel-real-request', nonce: 'flywheel-real-nonce', workspaceCwd: worker.directory,
          receiptPath: join(receipts, 'receipt.json'), web: { version: 1, executionDomainId: identity.executionDomainId, requireIsolation: true } };
        const policy = await createWebPolicy(worker.ctx, config);
        await policy.admit(worker.agent, identity.hostInvocationId, policy.binding, Date.now() + 30_000);
        await worker.send('Complete this invocation through the public plugin contract.');
        const facts = await worker.host.invocationFacts(identity);
        assert.equal(facts.dispatch, 'dispatched');
        assert.equal(facts.outcome, 'completed');
        assert.equal(facts.localCleanupConfirmed, true);
        await worker.dispose(); disposed = true;
        const admission = JSON.parse(await readFile(join(receipts, 'web-admission.json'), 'utf8'));
        const terminal = JSON.parse(await readFile(join(receipts, 'web-terminal.json'), 'utf8'));
        assert.deepEqual(admission.binding, policy.binding);
        assert.equal(terminal.requestId, config.requestId);
        assert.equal(terminal.nonce, config.nonce);
        assert.equal(terminal.facts.hostInvocationId, identity.hostInvocationId);
        assert.equal(terminal.facts.executionDomainId, identity.executionDomainId);
        assert.equal(terminal.facts.outcome, 'completed');
        assert.equal(terminal.facts.remoteGeneration, 'idle');
        assert.equal(terminal.facts.usageStatus, 'unknown');
        assert.equal(workerPages.counts.submits, 1);
        console.log('PASS actual Flywheel policy: public admission -> real host facts -> durable terminal receipt');
      } finally { if (!disposed) await worker.dispose(); }
    }
  `
  const result = await build({
    stdin: { contents: source, resolveDir: dsh, loader: 'ts' },
    tsconfig: join(dsh, 'tsconfig.base.json'),
    bundle: true, platform: 'node', format: 'esm', target: 'node24', write: false,
    nodePaths: [join(plugin, 'node_modules'), join(dsh, 'node_modules')],
    banner: { js: `import { createRequire as fixtureCreateRequire } from 'node:module'; const require = fixtureCreateRequire(${JSON.stringify(join(plugin, 'package.json'))});` },
    external: ['ajv', 'undici', 'ws'],
    plugins: [{ name: 'native-flock-source', setup(builder) {
      // Preserve the repository module's own native-package resolution; bundling
      // it would resolve its platform addon relative to the temporary verifier.
      builder.onResolve({ filter: /^@deepseek-ai\/node-addon-system\/flock$/ }, () => ({ path: join(dsh, 'native/system/packages/entry/src/flock.ts'), external: true }));
    } }],
  })
  const entry = join(root, 'lib', 'verify.mjs')
  await writeFile(entry, result.outputFiles[0].contents)
  execFileSync(process.execPath, [entry], { stdio: 'inherit', timeout: 120_000 })
} finally {
  await rm(root, { recursive: true, force: true })
}
