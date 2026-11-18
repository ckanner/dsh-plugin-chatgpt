import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState } from 'react'
import type { WebSettings } from '../web/config.ts'
import { unwrap, type RemoteResult } from './result.ts'

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
}

/** Separate connection state, on the existing provider card; native model controls remain DSH-owned. */
export function ChatGptWebCard({ remote }: { remote: () => Promise<ChatGptWebRemote> }) {
  const [status, setStatus] = useState<WebStatusView>()
  const [draft, setDraft] = useState<WebSettings>()
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState(false)
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
  const required = ['replayVeto', 'durableResponseAck', 'summaryRoute', 'durableSummaryAck', 'pressurePolicy']
  const hostReady = required.every(key => status?.hostCapabilities[key] === 1)
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
      {item.requestIds.map(requestId => <div key={requestId} style={{ display: 'flex', gap: '0.5rem' }}>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void action(async api => { const result = unwrap(await api.webRecover(requestId)) as { result?: { conversation?: { url?: string } } }; setNotice(result.result?.conversation?.url ? `Captured result: ${result.result.conversation.url}` : 'Recovery evidence read. No prompt was resent and no tool was executed.') })}>Inspect captured result</Button>
        <Button size="sm" variant="outline" disabled={busy || status.hostCapabilities.recoveredResponse !== 1} onClick={() => void action(async api => { unwrap(await api.webAdopt(requestId)); setNotice('Host recovery transaction completed. Validated tool calls may have run; check the session before continuing.') })}>Adopt response and its tools</Button>
      </div>)}
    </div>)}
  </section>
}
