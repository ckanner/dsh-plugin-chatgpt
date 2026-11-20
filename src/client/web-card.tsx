/** Browser setup and read-only recovery evidence on the existing provider card. */
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { useCallback, useEffect, useState } from 'react'
import type { WebProviderStatus } from '../web-provider.ts'
import type { TurnInspection } from '../web-bridge/contracts.ts'
import { unwrap, type RemoteResult } from './result.ts'

export interface WebRemote {
  webStatus(): Promise<RemoteResult<WebProviderStatus>>
  webSetup(): Promise<RemoteResult<WebProviderStatus>>
  webVerify(): Promise<RemoteResult<WebProviderStatus>>
  webSetEnabled(enabled: boolean): Promise<RemoteResult<WebProviderStatus>>
  webTurns(): Promise<RemoteResult<TurnInspection[]>>
  webInspect(turnId: string): Promise<RemoteResult<TurnInspection>>
  webRecover(turnId: string): Promise<RemoteResult<TurnInspection>>
  webDiscard(turnId: string): Promise<RemoteResult<TurnInspection>>
}

const phaseNames: Record<WebProviderStatus['phase'], string> = {
  'not-initialized': 'Setup required', stopped: 'Ready to start', starting: 'Starting Chrome',
  'login-required': 'Sign in in Chrome', 'verification-required': 'Verification required', ready: 'Verified',
  'recovery-required': 'A turn needs inspection', error: 'Setup needs attention',
}

export function WebCard({ getRemote, mounting }: { getRemote: () => Promise<WebRemote>, mounting: Promise<string | undefined> }) {
  const [status, setStatus] = useState<WebProviderStatus>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [turns, setTurns] = useState<TurnInspection[]>()
  const [selected, setSelected] = useState<TurnInspection>()
  const [acknowledged, setAcknowledged] = useState(false)
  const refresh = useCallback(async () => {
    try {
      const mountError = await mounting
      if (mountError) throw new Error(mountError)
      setStatus(unwrap(await (await getRemote()).webStatus()))
      setError(undefined)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }, [getRemote, mounting])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (status?.phase !== 'starting' && status?.phase !== 'login-required' && status?.phase !== 'verification-required') return
    const timer = setInterval(() => { void refresh() }, 3000)
    return () => { clearInterval(timer) }
  }, [refresh, status?.phase])

  const action = async (run: (remote: WebRemote) => Promise<void>) => {
    setBusy(true)
    setError(undefined)
    let operationError: string | undefined
    try { await run(await getRemote()) } catch (cause) { operationError = cause instanceof Error ? cause.message : String(cause) }
    finally {
      await refresh()
      if (operationError !== undefined) setError(operationError)
      setBusy(false)
    }
  }
  const inspect = (turn: TurnInspection) => action(async remote => {
    setSelected(unwrap(await remote.webInspect(turn.turnId)))
    setAcknowledged(false)
  })

  return <section aria-label="GPT-6 Pro Web setup" style={{ borderTop: '1px solid var(--dsw-alias-border, #ddd)', padding: '1rem 0', display: 'grid', gap: '0.75rem', fontSize: '0.8125rem' }}>
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
      <strong>GPT-6 Pro Web</strong>
      <Tag tone={status?.ready ? 'success' : status?.issues.length ? 'warning' : 'neutral'}>{status ? phaseNames[status.phase] : 'Checking setup…'}</Tag>
      {status?.enabled ? <span>Enabled</span> : null}
    </div>
    <p style={{ margin: 0 }}>Use Pro in a dedicated Chrome window on this machine. Sign in there, select GPT-6 and Pro, then verify this account. DSH keeps the conversation history and runs tools.</p>
    {status?.account ? <div>Web account: {status.account}</div> : null}
    {status?.contextBudget ? <div>Local input budget: {status.contextBudget.toLocaleString()} tokens. Web token usage is unavailable.</div> : null}
    {error ? <div role="alert" style={{ color: 'var(--dsw-alias-text-danger, #c33)' }}>{error}</div> : null}
    {status?.issues.length ? <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>{status.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul> : null}
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => { void action(async remote => { setStatus(unwrap(await remote.webSetup())) }) }}>Open dedicated Chrome</Button>
      <Button variant="outline" size="sm" disabled={busy || !status || status.phase === 'not-initialized'} onClick={() => { void action(async remote => { setStatus(unwrap(await remote.webVerify())) }) }}>Verify account and Pro</Button>
      <Button variant={status?.enabled ? 'ghost' : 'primary'} size="sm" disabled={busy || !status || !status.enabled && (!status.binding || status.issues.length > 0)} onClick={() => { void action(async remote => { setStatus(unwrap(await remote.webSetEnabled(!status?.enabled))) }) }}>{status?.enabled ? 'Disable Web' : 'Enable Web model'}</Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void refresh() }}>Refresh</Button>
    </div>
    <details>
      <summary>Inspect and recover Web turns</summary>
      <p>A disconnected request may still have finished in Chrome. Recovery only reads saved page evidence. It does not send another prompt or execute tools.</p>
      <Button variant="outline" size="sm" disabled={busy || !status?.binding} onClick={() => { void action(async remote => { setTurns(unwrap(await remote.webTurns())) }) }}>Load turns</Button>
      {turns?.length === 0 ? <p>No admitted turns.</p> : null}
      {turns?.map(turn => <div key={turn.turnId} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.5rem', overflowWrap: 'anywhere' }}>
        <span>{turn.sessionId} · {turn.state}{turn.discarded ? ' · abandoned' : ''}</span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void inspect(turn) }}>Inspect</Button>
      </div>)}
      {selected ? <div style={{ display: 'grid', gap: '0.5rem', marginTop: '0.75rem' }}>
        <code style={{ overflowWrap: 'anywhere' }}>{selected.turnId}</code>
        <div>{selected.state} · delivery: {selected.deliveryState}{selected.discarded ? ' · abandoned' : ''}</div>
        {selected.fenceReason ? <div>{selected.fenceReason}</div> : null}
        {selected.response ? <pre style={{ maxHeight: '20rem', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(selected.response, null, 2)}</pre> : null}
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { void action(async remote => { setSelected(unwrap(await remote.webRecover(selected.turnId))); setAcknowledged(false) }) }}>Recover from page evidence</Button>
        {selected.discarded && selected.state === 'uncertain' ? <div>The result is abandoned. New Web submissions remain blocked until recovery proves this remote request ended.</div> : null}
        {['uncertain', 'failed', 'cancelled'].includes(selected.state) && !selected.discarded ? <>
          <label><input type="checkbox" checked={acknowledged} onChange={event => { setAcknowledged(event.target.checked) }} /> I inspected this turn and choose to abandon its result. This does not stop the remote request or clear an unknown outcome.</label>
          <Button variant="outline" size="sm" disabled={busy || !acknowledged} onClick={() => { void action(async remote => { setSelected(unwrap(await remote.webDiscard(selected.turnId))); setAcknowledged(false); setTurns(unwrap(await remote.webTurns())) }) }}>Abandon this turn and keep its evidence</Button>
        </> : null}
      </div> : null}
    </details>
  </section>
}
