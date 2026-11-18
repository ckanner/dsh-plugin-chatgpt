import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ChatGptWebHost, webHostCapabilities } from '../../src/web/host.ts'
import { defaultWebSettings } from '../../src/web/config.ts'
import { deliveryChunks } from '../../src/web/chunks.ts'
import { WEB_MODEL_ID, WEB_PROTOCOL } from '../../src/web/policy.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { WebDelivery } from '../../src/web/session-coordinator.ts'
import type { WebPageFactory } from '../../src/web/browser/types.ts'

const [stateDir, mode] = process.argv.slice(2)
if (!stateDir || !mode) throw new Error('state root and scenario required')
const settings = defaultWebSettings(stateDir)
settings.enabled = true
settings.connections.default!.accountFingerprint = 'a'.repeat(64)
if (mode === 'retired') settings.budget.maxFormatRepairs = 0
let firstRequest = ''
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/an8AAAAASUVORK5CYII=', 'base64')
const pages: WebPageFactory = {
  async connect() { throw new Error('recovery fixture must never connect') },
  async open(connection, request) {
    firstRequest ||= request.requestId
    if (mode === 'retired-unsent-repair' && request.repairOf) throw new Error('repair never opened a page')
    const conversation = request.conversation ?? { id: request.requestId, url: `https://chatgpt.com/c/${request.requestId}`, projectUrl: 'https://chatgpt.com/g/g-fixture/project' }
    const evidence = { adapter: 'chatgpt-dom/1' as const, model: 'GPT-6' as const, effort: 'Pro' as const,
      accountFingerprint: connection.accountFingerprint, contextPolicy: request.contextPolicy, conversationUrl: conversation.url,
      ...(conversation.projectUrl ? { projectUrl: conversation.projectUrl } : {}), bindingDigest: request.bindingDigest, capturedAt: Date.now() }
    const prepare = async () => {
      if (mode === 'unsent') throw new Error('fixture fails before prompt')
      return { conversation, evidence }
    }
    return { targetId: 'offline-fixture', prepare, inspect: prepare, async submit() {}, async close() {}, async stop() { return false },
      async sample() {
        let text = JSON.stringify({ protocol: WEB_PROTOCOL, requestId: JSON.parse(request.prompt).requestId, generation: request.generation,
          ...(mode === 'tool' ? { kind: 'tool_calls', calls: [{ id: 'tool', name: 'fixture', arguments: {} }] } : { kind: 'final', text: mode === 'retired-repair' && request.repairOf ? 'Changed by invalid correction' : 'Original durable answer' }) })
        if (mode === 'retired') text = 'invalid response'
        if (['repaired-final','retired-repair','retired-unsent-repair','media-repaired'].includes(mode) && !request.repairOf) text = '```json\n' + text + '\n```'
        return { conversation, userMessageId: 'user-' + request.requestId, acceptedPrompt: request.prompt, responseId: 'answer-' + request.requestId, text,
        ...(request.media ? { acceptedMedia: request.media.map(item => item.uploadName) } : {}),
        stopVisible: false, thinking: false, finishedActions: true } },
    }
  },
}
const host = new ChatGptWebHost(stateDir, 'chatgpt', { capabilities: () => webHostCapabilities.requiredHost, activity() {}, pageFactory: pages,
  resolveAttachments: () => ({ async readImage(ref: unknown) { return { ref, data: imageBytes } } }) }, () => settings)
const owner = { sessionId: 'root', hostInvocationId: 'original', executionDomainId: 'task-domain' }
await host.beginInvocation({ ...owner, requireIsolation: true, workspace: stateDir })
const checkpoint = await host.recoveryCheckpoint(owner)
await writeFile(join(stateDir, 'checkpoint.json'), JSON.stringify(checkpoint), { mode: 0o600 })
if (mode !== 'empty') {
  const options = { provider: 'chatgpt', model: WEB_MODEL_ID, reasoningEffort: 'pro', sessionId: 'root',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Original task' }, ...(mode.startsWith('media') ? [{ type: 'image', attachment: { attachmentId: 'original-image', mediaType: 'image/png', bytes: imageBytes.byteLength, width: 1, height: 1 } }] : [])] }],
    ...(mode === 'tool' ? { tools: [{ name: 'fixture', description: 'offline fixture', parameters: { type: 'object', properties: {}, additionalProperties: false } }] } : {}),
  } as unknown as GenerateOptions
  const context = await host.callContext(options, mode === 'summary' ? 'compaction' : 'main', { sessionId: 'root', rootSessionId: 'root', workspace: stateDir })
  let delivery: WebDelivery | undefined
  try {
    for await (const _chunk of host.wrap(context, async function* () { delivery = await host.generate(); yield* deliveryChunks(delivery) })) { /* stream complete before ACK */ }
  } catch (error) { if (mode !== 'unsent' && !mode.startsWith('retired')) throw error }
  if (delivery && mode !== 'captured') await host.committed(delivery.reference, delivery.blocks, 'original-host-commit', true)
  if (mode === 'unknown-tool') { await host.toolStarted('root', 'unknown-local-tool'); await host.toolObserved('root', 'unknown-local-tool', true) }
  if (mode.startsWith('retired')) {
    const observed = await host.recover(firstRequest) as { rejection: { responseDigest: string } }
    await host.retire(firstRequest, observed.rejection.responseDigest, 'discard-rejected-response')
  }
}
await host.agentIdle('root')
process.stdout.write(JSON.stringify(checkpoint))
