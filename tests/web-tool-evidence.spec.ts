import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ChatGptWebHost, webHostCapabilities } from '../src/web/host.ts'
import { WebStore } from '../src/web/store.ts'
import { toolCommitFromEvent, toolRootFromEvents, type WebSessionEvent, type WebToolCommit } from '../src/web/tool-evidence.ts'

const call = (seq: number, step: number): WebSessionEvent => ({ type: 'tool/call', seq, data: { turn: 1, step, callId: 'call_1' } })
const result = (seq: number, source: number, step: number): WebSessionEvent => ({ type: 'tool/result', seq, data: { turn: 1, step, message: { toolCallId: 'call_1' } }, sourceEventSeqs: [source] })
const proof = (sessionId: string, rootCallSeq: number, rootCallId = 'call_1'): WebToolCommit => ({ sessionId, rootCallId, rootCallSeq, resultEventSeq: rootCallSeq + 1 })

test('uses the active step and persisted source link when a model reuses its short tool ID', () => {
  const events: WebSessionEvent[] = [
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } }, call(2, 1), result(3, 2, 1),
    { type: 'step/end', seq: 4, data: { turn: 1, step: 1 } },
    { type: 'step/start', seq: 5, data: { turn: 1, step: 2 } }, call(6, 2), result(7, 6, 2),
  ]
  const bySeq = new Map(events.map(event => [event.seq, event]))
  assert.deepEqual(toolRootFromEvents('session', 'call_1', events), { sessionId: 'session', rootCallId: 'call_1', rootCallSeq: 6 })
  assert.deepEqual(toolCommitFromEvent('session', events[2]!, bySeq), proof('session', 2))
  assert.deepEqual(toolCommitFromEvent('session', events[6]!, bySeq), proof('session', 6))
  assert.equal(toolRootFromEvents('session', 'call_1', events.slice(0, 4)), undefined, 'an ended step cannot authorize a new dispatch')
  assert.equal(toolRootFromEvents('session', 'call_1', events.slice(0, 5)), undefined, 'a current step cannot borrow a historical call')
  for (const malformed of [
    { type: 'tool/result', seq: 7, data: events[6]!.data },
    { ...events[6]!, sourceEventSeqs: [2] },
    { ...events[6]!, sourceEventSeqs: [6, 2] },
    { ...events[6]!, sourceEventSeqs: [7] },
    { ...events[6]!, data: { turn: 1, step: 2, message: { toolCallId: 'another-call' } } },
  ]) assert.equal(toolCommitFromEvent('session', malformed, bySeq), undefined)
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'web-tool-evidence-'))
  const create = () => new ChatGptWebHost(directory, 'chatgpt', { capabilities: () => webHostCapabilities.requiredHost, activity() {} })
  const host = create()
  const identity = { sessionId: 'root', executionDomainId: 'domain', workspace: directory }
  await host.beginInvocation({ ...identity, hostInvocationId: 'original' })
  return { directory, host, create, identity, dispose: () => rm(directory, { recursive: true, force: true }) }
}

test('a completed historical call cannot settle a new invocation with the same call ID', async () => {
  const f = await fixture()
  try {
    const old = await f.host.toolStarted('root', 'call_1', 'call_1', 2)
    assert.ok(old)
    await f.host.toolObserved(old, false)
    await f.host.toolCommitted(proof('root', 2), true, false)
    await f.host.agentIdle('root')
    await f.host.beginInvocation({ ...f.identity, hostInvocationId: 'next' })
    const current = await f.host.toolStarted('root', 'call_1', 'call_1', 6)
    assert.ok(current)
    await f.host.toolCommitted(proof('root', 2), true, false)
    await assert.rejects(() => f.create().guardSession('fresh', f.directory), /needs recovery/)
    await f.host.toolObserved(current, false)
    await f.host.toolCommitted(proof('root', 6), true, false)
    await f.create().guardSession('fresh', f.directory)
  } finally { await f.dispose() }
})

test('successive steps and sibling sessions can reuse IDs without sharing completion evidence', async () => {
  const f = await fixture()
  try {
    for (const sessionId of ['first', 'second']) await f.host.inheritOwner({ sessionId, parentSessionId: 'root', rootSessionId: 'root', workspace: f.directory })
    await f.host.toolStarted('first', 'call_1', 'call_1', 2)
    await f.host.toolStarted('second', 'call_1', 'call_1', 2)
    await f.host.toolCommitted(proof('first', 2), true, false)
    await assert.rejects(() => f.create().guardSession('fresh', f.directory), /needs recovery/)
    await f.host.toolCommitted(proof('second', 2), true, false)
    await f.create().guardSession('fresh', f.directory)
    await f.host.toolStarted('first', 'call_1', 'call_1', 8)
    await f.host.toolCommitted(proof('first', 2), true, false)
    await assert.rejects(() => f.create().guardSession('fresh', f.directory), /needs recovery/)
    await f.host.toolCommitted(proof('first', 8), true, false)
    await f.create().guardSession('fresh', f.directory)
    await assert.rejects(() => f.host.toolStarted('first', 'call_1', 'call_1', 8), /already dispatched/)
  } finally { await f.dispose() }
})

test('nested tools belong to one root occurrence and an unknown nested outcome remains sticky', async () => {
  const f = await fixture()
  try {
    await assert.rejects(() => f.host.toolStarted('root', 'nested', 'call_1', 2), /live original root/)
    await f.host.toolStarted('root', 'call_1', 'call_1', 2)
    const first = await f.host.toolStarted('root', 'nested', 'call_1', 2)
    assert.ok(first)
    await f.host.toolObserved(first, false)
    await f.host.toolCommitted(proof('root', 2), true, false)
    await f.host.toolStarted('root', 'call_1', 'call_1', 8)
    const second = await f.host.toolStarted('root', 'nested', 'call_1', 8)
    assert.ok(second)
    await f.host.toolCommitted(proof('root', 2), true, false)
    await assert.rejects(() => f.create().guardSession('fresh', f.directory), /needs recovery/)
    await f.host.toolObserved(second, true)
    await f.host.toolObserved(second, false)
    await f.host.toolCommitted(proof('root', 8), true, false)
    await assert.rejects(() => f.create().guardSession('fresh', f.directory), /needs recovery/)
  } finally { await f.dispose() }
})

test('missing or legacy occurrence evidence stays blocked instead of borrowing history', async () => {
  const f = await fixture()
  try {
    await assert.rejects(() => f.host.toolStarted('root', 'call_1'), /current durable Session call event/)
    await assert.rejects(() => f.host.toolCommitted({ ...proof('root', 2), resultEventSeq: 2 }, true, false), /source-event link/)
    const store = new WebStore(join(f.directory, 'web-host'))
    const registry = await store.read<{ invocations: Record<string, { toolIntents: Record<string, unknown> }> }>('registry', 'current')
    assert.ok(registry)
    registry.invocations.original!.toolIntents.call_1 = { sessionId: 'root', rootCallId: 'call_1', completed: true }
    await store.write('registry', 'current', registry)
    await f.host.toolCommitted(proof('root', 2), true, false)
    await assert.rejects(() => f.create().guardSession('fresh', f.directory), /needs recovery/)
  } finally { await f.dispose() }
})

test('identical result scans are idempotent while contradictory or unknown results stay blocked', async () => {
  for (const conflictingSequence of [false, true]) {
    const f = await fixture()
    try {
      await f.host.toolStarted('root', 'call_1', 'call_1', 2)
      await f.host.toolCommitted(proof('root', 2), true, false)
      await f.host.toolCommitted(proof('root', 2), false, false)
      await f.create().guardSession('fresh', f.directory)
      await f.host.toolCommitted({ ...proof('root', 2), resultEventSeq: conflictingSequence ? 4 : 3 }, true, !conflictingSequence)
      await assert.rejects(() => f.create().guardSession('fresh', f.directory), /needs recovery/)
      await f.host.toolCommitted(proof('root', 2), true, false)
      await assert.rejects(() => f.create().guardSession('fresh', f.directory), /needs recovery/)
    } finally { await f.dispose() }
  }
})

test('a late contradictory result remains attributed to the original invocation after Session reuse', async () => {
  const f = await fixture()
  try {
    await f.host.toolStarted('root', 'call_1', 'call_1', 2)
    await f.host.toolCommitted(proof('root', 2), true, false)
    await f.host.agentIdle('root')
    await f.host.beginInvocation({ ...f.identity, hostInvocationId: 'next' })
    await f.host.toolStarted('root', 'call_1', 'call_1', 6)
    await f.host.toolCommitted(proof('root', 6), true, false)
    await f.create().guardSession('fresh', f.directory)
    await f.host.toolCommitted({ ...proof('root', 2), resultEventSeq: 4 }, true, true)
    const store = new WebStore(join(f.directory, 'web-host'))
    const registry = await store.read<{ invocations: Record<string, { fence?: string }> }>('registry', 'current')
    assert.match(registry!.invocations.original!.fence!, /contradictory/)
    assert.equal(registry!.invocations.next!.fence, undefined)
    await assert.rejects(() => f.create().guardSession('fresh', f.directory), /needs recovery/)
  } finally { await f.dispose() }
})
