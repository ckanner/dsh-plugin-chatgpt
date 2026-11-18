import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebTransport, WebTransportError, advanceTerminal } from '../src/web/transport.ts'
import { BrowserStore, digest } from '../src/web/browser/storage.ts'
import type { WebConnection, WebPage, WebPageFactory, WebPageSample, WebTurnRequest } from '../src/web/browser/types.ts'
import { prepareWebMedia } from '../src/web/media.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

const account = digest('fixture@example.invalid')
const bindingDigest = digest('chatgpt|gpt-6-pro-web|pro|permissions-v1')
const conversation = { id: 'owned-chat', url: 'https://chatgpt.com/c/owned-chat', title: 'Review session' }
const sample = (text = 'complete response'): WebPageSample => ({ conversation, userMessageId: 'user-1', acceptedPrompt: 'unique prompt', responseId: 'assistant-1', text, stopVisible: false, thinking: false, finishedActions: true })

async function environment() {
  const root = await mkdtemp(join(tmpdir(),'dsh-web-test-'))
  const connection: WebConnection = { id: 'test', browserPath: '/unused/browser', profilePath: join(root,'profile'), stateDir: join(root,'state'), accountFingerprint: account }
  const request = (id: string, changes: Partial<WebTurnRequest> = {}): WebTurnRequest => ({ requestId: id, executionDomainId: 'domain', sessionId: 'session', generation: 0, bindingDigest, prompt: 'unique prompt', title: 'Review session', contextPolicy: 'personalized', deadlineMs: Date.now()+10_000, maxPromptBytes: 10_000, maxResponseBytes: 10_000, ...changes })
  return { root, connection, request, dispose: () => rm(root,{ recursive:true, force:true }) }
}

function factory(options: { conversation?: typeof conversation; samples?: () => WebPageSample; submit?: () => Promise<void>; prepare?: () => Promise<void>; close?: () => Promise<void> } = {}) {
  const calls = { opens: 0, prepares: 0, submits: 0, closes: 0, stops: 0 }
  const implementation: WebPageFactory = {
    async connect() { return { targetId: 'owned-tab' } },
    async open(connection, request) {
      calls.opens++
      const prepare = async () => {
        calls.prepares++; await options.prepare?.()
        const owned = options.conversation ?? conversation
        return { conversation: owned, evidence: { adapter: 'chatgpt-dom/1' as const, model: 'GPT-6' as const, effort: 'Pro' as const, accountFingerprint: connection.accountFingerprint, contextPolicy: request.contextPolicy, conversationUrl: owned.url, capturedAt: Date.now(), bindingDigest: request.bindingDigest } }
      }
      return {
        targetId: 'owned-tab', prepare, inspect: prepare,
        async submit() { calls.submits++; await options.submit?.() },
        async sample() { return options.samples?.() ?? { ...sample(), conversation: options.conversation ?? conversation } },
        async stop() { calls.stops++; return false },
        async close() { calls.closes++; await options.close?.() },
      } satisfies WebPage
    },
  }
  return { implementation, calls }
}

async function mediaFor(stateDir: string) {
  const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/an8AAAAASUVORK5CYII=', 'base64')
  const attachment = { attachmentId: 'lcu-screenshot', mediaType: 'image/png', bytes: data.length, width: 1, height: 1 }
  const options = { messages: [{ role: 'tool', toolCallId: 'host_screenshot', content: [{ type: 'image', attachment }] }] } as unknown as GenerateOptions
  return await prepareWebMedia(options, join(stateDir, 'images'), () => ({ async readImage() { return { ref: attachment, data } } }), Date.now() + 5000)
}

test('image acceptance receipts bind the exact user message and survive local recovery without another upload', async () => {
  const env = await environment()
  try {
    const media = await mediaFor(env.connection.stateDir)
    const f = factory({ samples: () => ({ ...sample(), acceptedMedia: media.map(item => item.uploadName) }) })
    const transport = new WebTransport(env.connection, { pageFactory: f.implementation })
    const result = await transport.run(env.request('images', { media }))
    assert.equal(result.media?.userMessageId, 'user-1')
    assert.equal(result.media?.attachments[0]!.toolCallId, 'host_screenshot')
    assert.equal(result.media?.modelConsumption, 'unverified')
    assert.equal(result.text, 'complete response', 'image bytes are separate from the model text artifact')
    const recovered = await transport.recover('images', { observe: true })
    assert.deepEqual(recovered.result?.media, result.media)
    assert.equal(f.calls.submits, 1); assert.equal(f.calls.opens, 1)
    const store = await BrowserStore.open(env.connection)
    const journal = (await store.get('images'))!
    journal.media!.acceptedUploadNames = ['another-image.png']; await store.put(journal)
    await assert.rejects(() => transport.recover('images'), /do not match/)
  } finally { await env.dispose() }
})

test('missing accepted images stay unknown and altered files fail before opening a browser', async () => {
  const env = await environment()
  try {
    const media = await mediaFor(env.connection.stateDir)
    const f = factory()
    const transport = new WebTransport(env.connection, { pageFactory: f.implementation })
    await assert.rejects(() => transport.run(env.request('missing-images', { media })), (error: unknown) => {
      assert.ok(error instanceof WebTransportError); assert.match(error.message, /attachments do not match/)
      assert.equal(error.facts.dispatch, 'unknown'); assert.equal(error.facts.outcome, 'unknown'); assert.equal(error.facts.replayAllowed, false)
      return true
    })
    await writeFile(media[0]!.artifact.path, 'truncated', { mode: 0o600 })
    await assert.rejects(() => transport.run(env.request('changed-images', { media })), /size|changed/)
    assert.equal(f.calls.opens, 1, 'altered media is refused before page allocation')
    assert.equal(f.calls.submits, 1)
  } finally { await env.dispose() }
})

test('positive terminal controls and stable identity are both required; a quiet preamble never completes', () => {
  let state
  for(let i=0;i<20;i++) {
    const result = advanceTerminal(state,{...sample('preamble'),finishedActions:false}, i*1000)
    assert.equal(result.complete,false); state=result.state
  }
  state=undefined
  for(let i=0;i<5;i++) {
    const result=advanceTerminal(state,sample(),i*400)
    assert.equal(result.complete,i>=3); state=result.state
  }
  const rewrite=advanceTerminal(state,sample('different response'),2500)
  assert.equal(rewrite.complete,false)
  assert.equal(advanceTerminal(state,{...sample(),thinking:true},3000).complete,false)
  assert.equal(advanceTerminal(state,{...sample(),error:{code:'SERVER',reason:'web-ui-error'}},3000).complete,false)
  assert.equal(advanceTerminal(state,{...sample(),userMessageId:undefined} as unknown as WebPageSample,3000).complete,false)
})

test('a complete artifact ends the stream; only a matching durable host ACK opens the conversation', async () => {
  const env=await environment(); const f=factory(); const transport=new WebTransport(env.connection,{ pageFactory:f.implementation })
  try {
    const activities: string[]=[]
    const result=await transport.run(env.request('first',{onActivity:e=>activities.push(e.kind)}))
    assert.equal(result.text,'complete response')
    assert.equal(result.facts.localCleanup,'confirmed')
    assert.equal(result.facts.usage,'unknown')
    assert.equal(await readFile(result.artifact.path,'utf8'),result.text)
    assert.deepEqual(activities,['accepted','content','completed'])
    await assert.rejects(transport.run(env.request('next-before-ack',{conversation})),/awaiting a durable host ACK/)
    assert.equal(f.calls.submits,1)
    await assert.rejects(transport.acknowledge('first',{hostCommitId:'commit-1',responseDigest:digest('wrong')}),/does not match/)
    const recovered=await transport.recover('first')
    assert.equal(recovered.result?.responseId,result.responseId)
    const openedBeforeRecovery=f.calls.opens
    assert.equal((await transport.recover('first',{observe:true})).result?.text,result.text)
    assert.equal(f.calls.opens,openedBeforeRecovery,'a durable captured result does not require reopening Chrome')
    await transport.acknowledge('first',{hostCommitId:'commit-1',responseDigest:result.artifact.sha256})
    await transport.acknowledge('first',{hostCommitId:'commit-1',responseDigest:result.artifact.sha256})
    await assert.rejects(transport.acknowledge('first',{hostCommitId:'another-commit',responseDigest:result.artifact.sha256}),/conflicts/)
    await transport.run(env.request('after-ack',{conversation}))
    assert.equal(f.calls.submits,2)
  } finally { await env.dispose() }
})

test('a failed submit remains unknown, survives duplicate calls, and cannot consume another connection turn', async () => {
  const env=await environment(); const f=factory({submit:async()=>{throw new Error('lost connection after click')}})
  const transport=new WebTransport(env.connection,{ pageFactory:f.implementation })
  try {
    const request=env.request('uncertain')
    await assert.rejects(transport.run(request),(error:unknown)=>{
      assert.ok(error instanceof WebTransportError)
      assert.equal(error.facts.dispatch,'unknown'); assert.equal(error.facts.localCleanup,'confirmed')
      assert.equal(error.facts.replayAllowed,false); return true
    })
    await assert.rejects(transport.run(request),(error:unknown)=>error instanceof WebTransportError && error.facts.dispatch==='unknown')
    const saved=await transport.recover('uncertain')
    assert.equal(saved.facts.dispatch,'unknown')
    await assert.rejects(transport.run(env.request('other',{deadlineMs:Date.now()+100})),/unresolved remote call/)
    assert.equal(f.calls.submits,1)
  } finally { await env.dispose() }
})

test('different conversations wait for captured host ACK before consuming shared profile capacity', async () => {
  const env = await environment()
  const other = { id: 'other-chat', url: 'https://chatgpt.com/c/other-chat', title: 'Other session' }
  const first = factory(); const second = factory({ conversation: other })
  const firstTransport = new WebTransport(env.connection, { pageFactory: first.implementation })
  const secondTransport = new WebTransport(env.connection, { pageFactory: second.implementation })
  try {
    const captured = await firstTransport.run(env.request('captured-first'))
    const waiting = secondTransport.run(env.request('queued-second', { conversation: other }))
    await new Promise<void>(resolve => setTimeout(resolve, 120))
    assert.equal(second.calls.opens, 0, 'capture does not release capacity before host validation and commit')
    await firstTransport.acknowledge('captured-first', { hostCommitId: 'first-commit', responseDigest: captured.artifact.sha256 })
    const next = await waiting
    assert.equal(second.calls.submits, 1)
    await secondTransport.acknowledge('queued-second', { hostCommitId: 'second-commit', responseDigest: next.artifact.sha256 })
  } finally { await env.dispose() }
})

test('an active queued sibling never submits after the first turn becomes unknown', async () => {
  const env = await environment()
  let submitted!: () => void
  const ready = new Promise<void>(resolve => { submitted = resolve })
  const first = factory({ submit: async () => { submitted() }, samples: () => ({ ...sample('preamble'), finishedActions: false }) })
  const second = factory({ conversation: { id: 'queued-chat', url: 'https://chatgpt.com/c/queued-chat', title: 'Queued session' } })
  try {
    const firstTransport = new WebTransport(env.connection, { pageFactory: first.implementation })
    const secondTransport = new WebTransport(env.connection, { pageFactory: second.implementation })
    const original = assert.rejects(firstTransport.run(env.request('unknown-first', { deadlineMs: Date.now() + 700 })), error => error instanceof WebTransportError && error.facts.remoteGeneration === 'unknown')
    await ready
    const queued = assert.rejects(secondTransport.run(env.request('must-not-send', { deadlineMs: Date.now() + 3000 })), /unresolved remote call/)
    await Promise.all([original, queued])
    assert.equal(second.calls.opens, 0)
    assert.equal(second.calls.submits, 0)
  } finally { await env.dispose() }
})

test('timed out preamble is recovered without re-sending, preserves dispatch, and releases retained capacity only after ACK', async () => {
  const env=await environment(); let finished=false
  const f=factory({samples:()=>({...sample(finished?'complete response':'preamble'),finishedActions:finished})})
  const transport=new WebTransport(env.connection,{ pageFactory:f.implementation })
  try {
    await assert.rejects(transport.run(env.request('recoverable',{deadlineMs:Date.now()+600})),(error:unknown)=>error instanceof WebTransportError && error.code==='TIMEOUT' && error.facts.dispatch==='confirmed')
    finished=true
    const recovered=await transport.recover('recoverable',{observe:true})
    assert.equal(recovered.facts.dispatch,'confirmed')
    assert.equal(recovered.result?.text,'complete response')
    assert.equal(f.calls.submits,1)
    await transport.acknowledge('recoverable',{hostCommitId:'adoption-1',responseDigest:recovered.result!.artifact.sha256})
    await transport.run(env.request('continued',{conversation}))
    assert.equal(f.calls.submits,2)
  } finally { await env.dispose() }
})

test('recovery cannot adopt a partial answer while the page reports a generation error', async () => {
  const env = await environment()
  let state: 'running' | 'failed' | 'complete' = 'running'
  const f = factory({ samples: () => ({
    ...sample(state === 'complete' ? 'complete response' : 'partial response'),
    finishedActions: state !== 'running',
    ...(state === 'failed' ? { error: { code: 'SERVER' as const, reason: 'web-ui-error' } } : {}),
  }) })
  const transport = new WebTransport(env.connection, { pageFactory: f.implementation })
  try {
    await assert.rejects(transport.run(env.request('error-during-recovery', { deadlineMs: Date.now() + 500 })),
      error => error instanceof WebTransportError && error.code === 'TIMEOUT' && error.facts.dispatch === 'confirmed')
    state = 'failed'
    await assert.rejects(transport.recover('error-during-recovery', { observe: true }), (error: unknown) => {
      assert.ok(error instanceof WebTransportError)
      assert.equal(error.code, 'SERVER')
      assert.equal(error.facts.dispatch, 'confirmed')
      assert.equal(error.facts.outcome, 'unknown')
      assert.equal(error.facts.remoteGeneration, 'unknown')
      assert.equal(error.facts.replayAllowed, false)
      return true
    })
    const journal = (await (await BrowserStore.open(env.connection)).get('error-during-recovery'))!
    assert.equal(journal.artifact, undefined, 'an errored partial answer must never become an adoptable artifact')
    assert.equal(journal.facts.outcome, 'unknown')
    await assert.rejects(transport.run(env.request('still-fenced')), /unresolved remote call/)
    state = 'complete'
    const recovered = await transport.recover('error-during-recovery', { observe: true })
    assert.equal(recovered.result?.text, 'complete response')
    assert.equal(f.calls.submits, 1, 'observing the original turn never resends the prompt')
    await transport.acknowledge('error-during-recovery', { hostCommitId: 'recovered-complete', responseDigest: recovered.result!.artifact.sha256 })
  } finally { await env.dispose() }
})

test('cancel during resource acquisition closes the late page and never prepares or submits', async () => {
  const env=await environment(); const f=factory(); const controller=new AbortController()
  const delayed:WebPageFactory={...f.implementation,async open(connection,request,targetId){const page=await f.implementation.open(connection,request,targetId);controller.abort();return page}}
  try {
    const transport=new WebTransport(env.connection,{pageFactory:delayed})
    await assert.rejects(transport.run(env.request('cancelled',{signal:controller.signal})),(error:unknown)=>error instanceof WebTransportError && error.facts.dispatch==='not-dispatched' && error.facts.localCleanup==='confirmed' && error.facts.stopReason==='cancelled')
    assert.equal(f.calls.prepares,0); assert.equal(f.calls.submits,0); assert.equal(f.calls.closes,1)
  } finally { await env.dispose() }
})

test('profile aliases share capacity; unrelated state directories cannot oversubscribe the actual profile', async () => {
  const env=await environment()
  try {
    const first=await BrowserStore.open(env.connection)
    const alias=join(env.root,'profile-alias'); await symlink(env.connection.profilePath,alias,'dir')
    const second=await BrowserStore.open({...env.connection,id:'another-name',profilePath:alias,stateDir:join(env.root,'other-state')})
    assert.equal(first.coordinationDir,second.coordinationDir)
    const owned=await first.acquire(env.request('owner'))
    await assert.rejects(second.acquire(env.request('waiter',{deadlineMs:Date.now()+80})),/deadline/)
    await owned.release()
    const next=await second.acquire(env.request('next'));await next.release()
  } finally { await env.dispose() }
})

test('artifact reads reject truncation, changed content, symlinks and path escapes', async () => {
  const env=await environment()
  try {
    const store=await BrowserStore.open(env.connection)
    const artifact=await store.artifact('artifact','original')
    await writeFile(artifact.path,'edited',{mode:0o600})
    await assert.rejects(store.readArtifact(artifact,1000),/truncated or changed/)
    await rm(artifact.path);await symlink(join(env.root,'outside'),artifact.path)
    await assert.rejects(store.readArtifact(artifact,1000))
    await assert.rejects(store.readArtifact({...artifact,path:join(env.root,'outside')},1000),/escapes/)
  } finally { await env.dispose() }
})

test('capture before a process crash remains adoptable only after its original local owner has exited', async () => {
  const env = await environment()
  const request = env.request('crash-after-capture')
  const source = `
    import { WebTransport } from ${JSON.stringify(new URL('../src/web/transport.ts', import.meta.url).href)};
    const connection = ${JSON.stringify(env.connection)};
    const request = ${JSON.stringify(request)};
    const conversation = ${JSON.stringify(conversation)};
    const pageFactory = {
      async connect() { return { targetId: 'fixture' }; },
      async open() {
        return {
          targetId: 'fixture',
          async prepare() { return { conversation, evidence: { adapter: 'chatgpt-dom/1', model: 'GPT-6', effort: 'Pro', accountFingerprint: connection.accountFingerprint, contextPolicy: request.contextPolicy, conversationUrl: conversation.url, capturedAt: Date.now(), bindingDigest: request.bindingDigest } }; },
          async inspect() { throw new Error('Recovery must use the captured artifact'); },
          async submit() {},
          async sample() { return ${JSON.stringify(sample())}; },
          async stop() { return false; },
          async close() { process.send('captured-before-cleanup'); await new Promise(() => setInterval(() => {}, 1000)); },
        };
      },
    };
    await new WebTransport(connection, { pageFactory }).run(request);
  `
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let errors = ''; child.stderr?.on('data', chunk => { errors += String(chunk) })
  try {
    const message = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => { throw new Error(`Fixture exited before capture: ${errors}`) }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Fixture capture timed out')), 8000); timer.unref() }),
    ])
    assert.equal(message[0], 'captured-before-cleanup')
    const f = factory()
    const transport = new WebTransport(env.connection, { pageFactory: f.implementation })
    const live = await transport.recover(request.requestId, { observe: true })
    assert.equal(live.facts.localCleanup, 'unknown')
    assert.equal(f.calls.opens, 0)
    await assert.rejects(transport.acknowledge(request.requestId, { hostCommitId: 'host-commit', responseDigest: live.result!.artifact.sha256 }), /confirmed local cleanup/)
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    const recovered = await transport.recover(request.requestId, { observe: true })
    assert.equal(recovered.facts.dispatch, live.facts.dispatch)
    assert.equal(recovered.facts.localCleanup, 'confirmed')
    assert.equal(recovered.result?.facts.localCleanup, 'confirmed')
    assert.equal(recovered.result?.text, 'complete response')
    assert.equal(f.calls.opens, 0)
    await transport.acknowledge(request.requestId, { hostCommitId: 'host-commit', responseDigest: recovered.result!.artifact.sha256 })
    const store = await BrowserStore.open(env.connection)
    const next = await store.acquire(env.request('next-after-crash')); await next.release()
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
    await env.dispose()
  }
})

test('a dead owner before container intent is proven not dispatched and releases only its unused capacity', async () => {
  const env = await environment()
  const request = env.request('prepared-crash')
  const source = `
    import { BrowserStore } from ${JSON.stringify(new URL('../src/web/browser/storage.ts', import.meta.url).href)};
    import { initialWebFacts } from ${JSON.stringify(new URL('../src/web/browser/types.ts', import.meta.url).href)};
    const connection = ${JSON.stringify(env.connection)};
    const request = ${JSON.stringify(request)};
    const store = await BrowserStore.open(connection);
    await store.create({ version: 1, ownerPid: process.pid, request, connectionId: connection.id, accountFingerprint: connection.accountFingerprint, phase: 'prepared', updatedAt: Date.now(), facts: initialWebFacts() });
    await store.acquire(request);
    process.send('prepared');
    setInterval(() => {}, 1000);
  `
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  try {
    await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(() => { throw new Error('Fixture exited before prepare') }),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Fixture prepare timed out')), 8000); timer.unref() }),
    ])
    const f = factory(); const transport = new WebTransport(env.connection, { pageFactory: f.implementation })
    await assert.rejects(transport.recover(request.requestId, { observe: true }), /concurrent recovery/)
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    const recovered = await transport.recover(request.requestId, { observe: true })
    assert.equal(recovered.result, undefined)
    assert.deepEqual(recovered.facts, { dispatch: 'not-dispatched', outcome: 'unknown', localCleanup: 'confirmed', remoteGeneration: 'not-started', usage: 'unknown', replayAllowed: true })
    assert.equal(f.calls.opens, 0)
    const store = await BrowserStore.open(env.connection)
    const next = await store.acquire(env.request('next-after-prepared')); await next.release()
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited }
    await env.dispose()
  }
})
