/**
 * Exercise the real DSH AgentLoop/BasicCompaction and this plugin's Web stack.
 * Only the browser page is a fixture; transport journals, provider conversion,
 * public hooks, host transactions, tool execution, and JSONL persistence are real.
 * Usage: node scripts/verify-web-harness.mjs /path/to/patched/deepseek-harness [/path/to/flywheel]
 */
import { build } from 'esbuild'
import { access, copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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
  // The source attachment backend lazy-loads its actual native image decoder.
  // Keep its installed dependency beside the bundled verifier without changing
  // either checkout's dependency directory.
  await mkdir(join(root, 'lib', 'node_modules'))
  await symlink(await realpath(join(dsh, 'packages/attachment/attachment-local/node_modules/sharp')), join(root, 'lib', 'node_modules', 'sharp'), 'junction')
  const source = `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    import { mkdir, readFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { Context } from '@deepseek-ai/cordis';
    import AgentRegistry from '@deepseek-ai/dsh-agent';
    import AgentLoop from '@deepseek-ai/dsh-agent-loop';
    import LlmRuntime, { createUserMessage, LlmAdapter, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
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
    import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local';
    import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit';
    import { HarnessAdapter } from ${JSON.stringify(join(plugin, 'src/index.ts'))};
    import * as ChatGPTPlugin from ${JSON.stringify(join(plugin, 'src/index.ts'))};
    import { installWebHost } from ${JSON.stringify(join(plugin, 'src/web/integration.ts'))};
    import { ChatGptWebHost } from ${JSON.stringify(join(plugin, 'src/web/host.ts'))};
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

    for (const repairs of [0, 2, undefined]) {
      const profile = new Context();
      try {
        const stateDir = join(root, 'profile-repairs-' + String(repairs));
        const settings = defaultWebSettings(stateDir);
        if (repairs === undefined) delete settings.budget.maxFormatRepairs;
        else settings.budget.maxFormatRepairs = repairs;
        await profile.plugin(LlmRuntime);
        await profile.plugin(ChatGPTPlugin, { provider: 'profile-chatgpt', stateDir, web: settings });
        const status = await profile.get('chatgptWebHost').status();
        assert.equal(status.managedByProfile, true);
        assert.equal(status.settings.budget.maxFormatRepairs, repairs ?? 1);
      } finally { await profile.fiber.dispose(); }
    }
    for (const repairs of [-1, 0.5, 3]) {
      const profile = new Context();
      try {
        const stateDir = join(root, 'invalid-profile-repairs-' + String(repairs));
        const settings = defaultWebSettings(stateDir);
        settings.budget.maxFormatRepairs = repairs;
        await profile.plugin(LlmRuntime);
        await assert.rejects(async () => {
          await profile.plugin(ChatGPTPlugin, { provider: 'profile-chatgpt', stateDir, web: settings });
        }, 'the host profile schema must reject unsupported correction budgets before activation');
      } finally { await profile.fiber.dispose(); }
    }
    console.log('PASS real profile configuration: disabled/bounded/default format corrections, invalid values rejected before activation');

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
            const text = response.rawText ?? JSON.stringify({ protocol: WEB_PROTOCOL, requestId: request.requestId, generation: request.generation, ...response });
            return {
              targetId: 'fixture-tab-' + index,
              async prepare(_request, beforeMutation) { await beforeMutation?.(); return { conversation, evidence }; },
              async inspect() { return { conversation, evidence }; },
              async submit(prompt) { counts.submits++; assert.equal(prompt, request.prompt); if (response.submitFailure) throw new Error('observer lost after submit click'); },
              async sample() { return { conversation, userMessageId: 'user-' + index, acceptedPrompt: request.prompt, acceptedMedia: request.media?.map(item => item.uploadName) ?? [], responseId: 'answer-' + index, text, stopVisible: false, thinking: false, finishedActions: true }; },
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

    // A managed auxiliary/non-Web provider may reuse a model-supplied tool ID.
    // Keep the actual second body open while a real auxiliary LLM request
    // makes the production integration rescan the first turn's durable result.
    const historyPages = pages(() => { throw new Error('this local tool-evidence scenario must not use a browser'); });
    const history = await fixture('tool-occurrence-history', historyPages);
    const enteredTool = Promise.withResolvers();
    const finishTool = Promise.withResolvers();
    try {
      let modelRequests = 0;
      let executions = 0;
      history.ctx.llm.registerAdapter(['short-id-fixture'], new class extends LlmAdapter {
        async resolveModel(provider, model) { return { provider, id: model, name: model }; }
        async *stream(options) {
          if (options.purpose === 'session-title') {
            yield { type: 'block-start', index: 0, blockType: 'text' };
            yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Read-only history probe' } };
            yield { type: 'finish', reason: { kind: 'stop' } };
            return;
          }
          modelRequests++;
          if (modelRequests % 2 === 1) {
            yield { type: 'block-start', index: 0, blockType: 'tool-call' };
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'history_probe', arguments: '{}' } };
            yield { type: 'finish', reason: { kind: 'tool-calls' } };
          } else {
            yield { type: 'block-start', index: 0, blockType: 'text' };
            yield { type: 'block-end', index: 0, block: { type: 'text', text: 'This tool occurrence completed.' } };
            yield { type: 'finish', reason: { kind: 'stop' } };
          }
        }
      }());
      history.agent.model.select({ provider: 'short-id-fixture', model: 'fixture' });
      history.ctx.tools.register(defineContentToolFixture({
        name: 'history_probe', description: 'Exercise the original durable tool occurrence', parameters: {},
        async execute() {
          executions++;
          if (executions === 2) { enteredTool.resolve(); await finishTool.promise; }
          return [{ type: 'text', text: 'Tool body completed.' }];
        },
      }));
      const identity = { sessionId: history.agent.id, executionDomainId: 'history-domain', workspace: history.directory };
      await history.host.beginInvocation({ ...identity, hostInvocationId: 'history-old' });
      await history.send('Complete the first local tool occurrence.');
      assert.equal(executions, 1);
      const firstResult = (await history.durableEvents()).find(event => event.type === 'tool/result');
      assert.equal(firstResult.data.message.toolCallId, 'call_1');
      assert.equal(firstResult.sourceEventSeqs.length, 1);
      await history.host.beginInvocation({ ...identity, hostInvocationId: 'history-current' });
      history.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Start the next tool occurrence with the same short ID.' }] }));
      await Promise.race([
        enteredTool.promise,
        history.agent.whenIdle().then(() => { throw new Error('the second managed tool body did not start'); }),
      ]);
      await history.ctx.agents.withInitiator(history.agent, async () => {
        for await (const _chunk of history.ctx.llm.stream({
          provider: 'short-id-fixture', model: 'fixture', sessionId: history.agent.id,
          purpose: 'session-title', messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect the current history.' }] })],
        })) { /* Exhaust the real llm/stream middleware without another tool. */ }
      });
      const during = await history.durableEvents();
      const calls = during.filter(event => event.type === 'tool/call' && event.data.callId === 'call_1');
      assert.equal(calls.length, 2);
      assert.notEqual(calls[0].seq, calls[1].seq);
      assert.deepEqual(firstResult.sourceEventSeqs, [calls[0].seq]);
      assert.equal(during.filter(event => event.type === 'tool/result').length, 1, 'the second body is still running and has no result');
      const current = await history.host.invocationFacts({ ...identity, hostInvocationId: 'history-current' });
      assert.equal(current.outcome, 'unknown', 'historical call_1 success must not settle the current unfinished call_1');
      const reopened = new ChatGptWebHost(history.directory, 'chatgpt-test', { capabilities: () => ({}), activity() {} }, () => history.settings);
      await assert.rejects(reopened.guardSession('fresh-session', history.directory), /needs recovery/, 'a new host without live ownership must retain the pending tool');
      finishTool.resolve();
      await history.agent.whenIdle();
      assert.equal(executions, 2);
      assert.equal(modelRequests, 4);
      const results = (await history.durableEvents()).filter(event => event.type === 'tool/result');
      assert.equal(results.length, 2);
      assert.deepEqual(results[1].sourceEventSeqs, [calls[1].seq]);
      await reopened.guardSession('fresh-session', history.directory);
      assert.equal(historyPages.counts.opens, 0);
      console.log('PASS real tool occurrence: reused call ID -> historical rescan cannot settle the live body -> its own result unblocks a reopened host');
    } finally { finishTool.resolve(); await history.dispose(); }

    const imagePages = pages(async (request, index) => {
      assert.equal(request.media.length, 1, 'each delta uploads only its newly owned image');
      const image = request.media[0];
      const data = await readFile(image.artifact.path);
      assert.equal(data.length, image.artifact.bytes);
      assert.equal(createHash('sha256').update(data).digest('hex'), image.artifact.sha256);
      assert.equal(image.role, index === 1 ? 'user' : 'tool');
      assert.ok(request.prompt.includes(image.uploadName), 'the protocol must retain the upload association');
      if (index === 1) return { kind: 'tool_calls', calls: [{ id: 'capture', name: 'capture_image', arguments: {} }] };
      assert.equal(typeof image.toolCallId, 'string');
      assert.equal(JSON.parse(request.prompt).history, 'append-only-delta');
      return { kind: 'final', text: 'Both owned image occurrences were received by the fixture.' };
    });
    const images = await fixture('durable-images', imagePages);
    try {
      await images.ctx.plugin(LocalAttachmentStore, { dshHome: join(images.directory, 'attachment-home') });
      images.settings.imagePolicy.maxImages = 1;
      const ref = await images.ctx.attachments.saveImage({ mediaType: 'image/png', data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64') });
      let captures = 0;
      images.ctx.tools.register(defineContentToolFixture({
        name: 'capture_image', description: 'Return a durable screenshot fixture', parameters: {},
        async execute() { captures++; return [{ type: 'image', attachment: ref }]; },
      }));
      images.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect this image and then obtain the screenshot.' }, { type: 'image', attachment: ref }] }));
      await images.agent.whenIdle();
      assert.equal(imagePages.counts.submits, 2);
      assert.equal(captures, 1);
      assert.equal(imagePages.requests[0].media[0].attachmentId, ref.attachmentId);
      assert.equal(imagePages.requests[1].media[0].attachmentId, ref.attachmentId);
      assert.notEqual(imagePages.requests[0].media[0].uploadName, imagePages.requests[1].media[0].uploadName);
      assert.equal((await images.host.status()).pending.length, 0);
      assert.ok((await images.durableEvents()).some(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text' && block.text.includes('Both owned image'))));
      console.log('PASS real attachments: stored user image -> model -> tool image -> delta, original history and associations retained');
    } finally { await images.dispose(); }

    let correctedRoot;
    const formatPages = pages((request, index) => {
      const answer = { protocol: WEB_PROTOCOL, requestId: correctedRoot ?? request.requestId, generation: request.generation, kind: 'final', text: 'Exact completed answer, including punctuation.' };
      if (index === 1) {
        correctedRoot = request.requestId;
        assert.equal(request.media.length, 1);
        return { rawText: '\\x60\\x60\\x60json\\n' + JSON.stringify(answer) + '\\n\\x60\\x60\\x60' };
      }
      assert.equal(request.repairOf.requestId, correctedRoot);
      assert.equal(JSON.parse(request.prompt).purpose, 'format-repair');
      assert.equal(request.media, undefined);
      return answer;
    });
    const format = await fixture('format-correction', formatPages);
    try {
      await format.ctx.plugin(LocalAttachmentStore, { dshHome: join(format.directory, 'attachment-home') });
      const ref = await format.ctx.attachments.saveImage({ mediaType: 'image/png', data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64') });
      format.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Return the completed answer in the required response format.' }, { type: 'image', attachment: ref }] }));
      await format.agent.whenIdle();
      assert.equal(formatPages.counts.submits, 2);
      assert.equal((await format.host.status()).pending.length, 0);
      const answer = (await format.durableEvents()).filter(event => event.type === 'assistant/message');
      assert.equal(answer.length, 1, 'only the validated correction becomes an authoritative assistant message');
      assert.equal(answer[0].data.message.content[0].text, 'Exact completed answer, including punctuation.');
      assert.equal(answer[0].data.message.source.replayState.response.requestId, correctedRoot);
      await format.host.recover(correctedRoot, false);
      const artifact = formatPages.requests[0].media[0].artifact;
      await writeFile(artifact.path, Buffer.from('changed image bytes'));
      await assert.rejects(format.host.recover(correctedRoot, false), /artifact|digest|image/i);
      console.log('PASS real image + format correction: original media receipt -> child without re-upload -> one durable host response, changed media rejected on recovery');
    } finally { await format.dispose(); }

    const rejectedPages = pages(() => ({ kind: 'tool_calls', calls: [{ id: 'invalid', name: 'unregistered_tool', arguments: {} }] }));
    const rejected = await fixture('explicit-discard', rejectedPages);
    try {
      await rejected.send('Use only the tools admitted by this host.');
      const pending = (await rejected.host.status()).pending;
      assert.equal(pending.length, 1);
      const requestId = pending[0].requestIds[0];
      const inspected = await rejected.host.recover(requestId, false);
      assert.ok(inspected.rejection);
      const discarded = await rejected.host.retire(requestId, inspected.rejection.responseDigest, 'discard-rejected-response');
      assert.equal(discarded.outcome, 'failed');
      assert.equal(discarded.usage, 'unknown');
      assert.equal((await rejected.host.status()).pending.length, 0);
      await assert.rejects(rejected.host.recover(requestId, true), /discarded/);
      assert.equal(rejectedPages.counts.submits, 1, 'inspection and discard cannot send another prompt');
      assert.equal((await rejected.durableEvents()).filter(event => event.type === 'assistant/message').length, 0);
      console.log('PASS real rejected response: inspect -> explicit failed disposition, no fabricated assistant commit or tool execution');
    } finally { await rejected.dispose(); }

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
