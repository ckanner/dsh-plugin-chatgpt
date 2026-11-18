import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState } from 'react'
import type { WebSettings } from '../web/config.ts'
import { unwrap, type RemoteResult } from './result.ts'
import { webRequiredHostCapabilities } from '../capabilities.ts'

export interface WebStatusView {
  settings: WebSettings
  hostCapabilities: Record<string, number>
  configured: boolean
  managedByProfile: boolean
  liveVerified: boolean
  runtimeVersion: string
  pending: { sessionId: string; hostInvocationId: string; reason: string; requestIds: string[] }[]
  configurationRequired?: boolean
  connection?: { accountFingerprint?: string }
  recentConversations: { sessionId: string; kind: string; url: string }[]
}

export interface ChatGptWebRemote {
  webStatus(): Promise<RemoteResult<WebStatusView>>
  webConfigure(value: WebSettings): Promise<RemoteResult<WebStatusView>>
  webConnect(): Promise<RemoteResult<WebStatusView>>
  webRecover(requestId: string): Promise<RemoteResult<unknown>>
  webAdopt(requestId: string): Promise<RemoteResult<unknown>>
  webDiscard(requestId: string, responseDigest: string, confirmation: string): Promise<RemoteResult<unknown>>
}

/** Separate connection state, on the existing provider card; native model controls remain DSH-owned. */
export function ChatGptWebCard({ remote }: { remote: () => Promise<ChatGptWebRemote> }) {
  const [status, setStatus] = useState<WebStatusView>()
  const [draft, setDraft] = useState<WebSettings>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [rejections, setRejections] = useState<Record<string, { responseDigest: string; reason: string; preview?: string }>>({})
  const refresh = async () => {
    const next = unwrap(await (await remote()).webStatus())
    setStatus(next); setDraft(next.settings)
  }
  useEffect(() => { void refresh().catch(error => setError(String(error))) }, [])
  async function action(operation: (api: ChatGptWebRemote) => Promise<unknown>) {
    setBusy(true); setError(undefined)
    try { await operation(await remote()); await refresh() }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  const connection = draft?.connections[draft.activeConnection]
  const hostReady = Object.entries(webRequiredHostCapabilities).every(([key, version]) => status?.hostCapabilities[key] === version)
  function field(name: 'browserPath' | 'profilePath' | 'stateDir', value: string) {
    if (!draft || !connection) return
    setDraft({ ...draft, connections: { ...draft.connections, [draft.activeConnection]: { ...connection, [name]: value, ...(name === 'profilePath' ? { accountFingerprint: '' } : {}) } } })
  }
  const editable = !busy && !status?.managedByProfile
  return <section style={{ borderTop: '1px solid var(--dsw-alias-border, #ddd)', marginTop: '0.75rem', paddingTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.625rem', fontSize: '0.8125rem' }}>
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}><strong>ChatGPT Web · GPT-6 / Pro</strong><Tag tone={status?.settings.enabled ? 'success' : 'neutral'}>{status?.settings.enabled ? 'Enabled' : 'Disabled'}</Tag></div>
    <div>Use a dedicated browser profile. This connection is independent of Sign in with ChatGPT above.</div>
    {error && <div role="alert" style={{ color: 'var(--dsw-alias-text-danger, #c33)' }}>{error}</div>}
    {notice && <div role="status">{notice}</div>}
    {draft && connection && <>
      <label><input type="checkbox" checked={draft.enabled} disabled={!editable} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} /> Enable the Web model in the native model selector</label>
      <label>Connection<select value={draft.activeConnection} disabled={!editable} onChange={event => setDraft({ ...draft, activeConnection: event.target.value })}>{Object.keys(draft.connections).map(id => <option key={id} value={id}>{id}</option>)}</select></label>
      <label>Chrome executable<Input value={connection.browserPath} disabled={!editable} onChange={event => field('browserPath', event.target.value)} /></label>
      <label>Dedicated browser profile<Input value={connection.profilePath} disabled={!editable} onChange={event => field('profilePath', event.target.value)} /></label>
      <label>Private recovery directory<Input value={connection.stateDir} disabled={!editable} onChange={event => field('stateDir', event.target.value)} /></label>
      <label>Conversation context<select value={draft.contextPolicy} disabled={!editable} onChange={event => setDraft({ ...draft, contextPolicy: event.target.value as WebSettings['contextPolicy'] })}>
        <option value="project-only">Private project-only workspace</option><option value="personalized">Personalized chat (not independent Review)</option>
      </select></label>
      <label>Format corrections per response<select value={draft.budget.maxFormatRepairs} disabled={!editable} onChange={event => setDraft({ ...draft, budget: { ...draft.budget, maxFormatRepairs: Number(event.target.value) } })}>
        <option value={0}>Disabled</option><option value={1}>At most one</option><option value={2}>At most two</option>
      </select></label>
      <div>A correction reformats a completed answer within the original time and byte limits. It uses another model turn and never repeats the task or uploads its images again.</div>
      <fieldset disabled={!editable} style={{ border: '1px solid var(--dsw-alias-border, #ddd)', padding: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
        <legend>Image upload limits / 图片上传限额</legend>
        <label>Images per request / 每次最多图片数<Input type="number" min={1} max={20} step={1} value={String(draft.imagePolicy.maxImages)} onChange={event => setDraft({ ...draft, imagePolicy: { ...draft.imagePolicy, maxImages: Number(event.target.value) } })} /></label>
        <label>MiB per image / 单图 MiB<Input type="number" min={1} max={20} step={1} value={String(draft.imagePolicy.maxImageBytes / 1024 / 1024)} onChange={event => setDraft({ ...draft, imagePolicy: { ...draft.imagePolicy, maxImageBytes: Number(event.target.value) * 1024 * 1024 } })} /></label>
        <label>Total MiB / 总计 MiB<Input type="number" min={1} max={64} step={1} value={String(draft.imagePolicy.maxTotalBytes / 1024 / 1024)} onChange={event => setDraft({ ...draft, imagePolicy: { ...draft.imagePolicy, maxTotalBytes: Number(event.target.value) * 1024 * 1024 } })} /></label>
        <div>PNG, JPEG, WebP and GIF from user messages or tools. Files such as PDF are unsupported. These local limits do not guarantee website quota.</div>
      </fieldset>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <Button variant="primary" size="sm" disabled={busy || status?.managedByProfile} onClick={() => void action(async api => { unwrap(await api.webConfigure(draft)); setNotice('Saved. Select GPT-6 Pro · Web and Pro in DSH’s model picker.') })}>Save Web settings</Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void action(async api => { const next = unwrap(await api.webConnect()); setNotice(next.configurationRequired ? `Login verified. Set accountFingerprint in the owning DSH profile to: ${next.connection?.accountFingerprint ?? ''}` : next.configured ? 'Dedicated account bound. Each call still verifies its model and context.' : 'Complete login in the dedicated browser, then click Connect again.'); })}>Connect / verify login</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void action(async () => {})}>Refresh status</Button>
      </div>
      <div>Account: {status?.configured ? 'Bound to this dedicated profile' : 'Not bound'} · Host: {hostReady ? 'Required extensions present' : 'Compatibility build required'}</div>
      {status?.managedByProfile && <div>These settings are managed by the DSH profile. Edit that profile to change the connection; Connect can still verify its account.</div>}
      <div>Local budget: {draft.budget.maxInputBytes.toLocaleString()} input bytes; {draft.budget.maxTurns} turns per generation. Website usage remains unknown. No prompt is sent by status or model discovery.</div>
      {!hostReady && <div>Install the documented DSH compatibility build before running this Web model. The existing account models remain available.</div>}
    </>}
    {status?.recentConversations.length ? <div><strong>Recent Web conversations</strong>{status.recentConversations.filter(item => /^https:\/\/chatgpt\.com\//.test(item.url)).map((item, index) => <div key={`${item.url}-${index}`}><a href={item.url} target="_blank" rel="noopener noreferrer">{item.kind === 'main' ? 'Open DSH conversation' : `Open ${item.kind} conversation`}</a></div>)}</div> : null}
    {status?.pending.map(item => <div key={item.hostInvocationId}>
      <strong>Recovery needed</strong><div>{item.reason}</div>
      {item.requestIds.map(requestId => <div key={requestId} style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void action(async api => { const result = unwrap(await api.webRecover(requestId)) as { result?: { text?: string; conversation?: { url?: string } }; rejection?: { responseDigest: string; reason: string } }; setRejections(current => { const next = { ...current }; if (result.rejection) next[requestId] = { ...result.rejection, preview: result.result?.text?.slice(0, 1600) ?? '' }; else delete next[requestId]; return next }); setNotice(result.rejection ? `Rejected response: ${result.rejection.reason}. Discard preserves its evidence and ends this failed request without running tools.` : result.result?.conversation?.url ? `Captured result: ${result.result.conversation.url}` : 'Recovery evidence read. No prompt was resent and no tool was executed.') })}>Inspect captured result</Button>
        <Button size="sm" variant="outline" disabled={busy || status.hostCapabilities.recoveredResponse !== 1} onClick={() => void action(async api => { unwrap(await api.webAdopt(requestId)); setNotice('Host recovery transaction completed. Validated tool calls may have run; check the session before continuing.') })}>Adopt response and its tools</Button>
        {rejections[requestId]?.preview && <pre style={{ whiteSpace: 'pre-wrap', width: '100%', maxHeight: '10rem', overflow: 'auto' }}>{rejections[requestId]!.preview}</pre>}
        {rejections[requestId] && <Button size="sm" variant="outline" disabled={busy} onClick={() => void action(async api => { unwrap(await api.webDiscard(requestId, rejections[requestId]!.responseDigest, 'discard-rejected-response')); setRejections(current => { const next = { ...current }; delete next[requestId]; return next }); setNotice('Rejected response discarded. Evidence and unknown usage are preserved. No tools ran from it; the request ended as failed. Choose a new action explicitly.') })}>Discard rejected response</Button>}
      </div>)}
    </div>)}
  </section>
}
