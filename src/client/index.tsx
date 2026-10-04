/**
 * The ChatGPT card on the Models page.
 *
 * It rides the provider row's extension area rather than drawing a card of its
 * own, so the roster, capacities, and reasoning levels below it are the harness's
 * own editor and stay in step with whatever the account reports. This adds the
 * one thing the harness cannot know: whether an account is signed in, and how to
 * sign one in.
 *
 * The Host owns every part of the flow that touches a credential. A sign-in needs
 * a listener on this machine and ends with tokens that must never reach a page, so
 * the card only asks the Host to start an attempt and reports what comes back.
 * Nothing here holds a token, and nothing here could leak one.
 *
 * @module dsh-plugin-chatgpt/client
 */

import { Button, Input, Pill, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientContextServices, Context as CordisContext } from '@deepseek-ai/cordis'
import type * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { remoteContribution } from './remote.ts'

/** The browser context this plugin runs against. */
type ClientContext = CordisContext & ClientContextServices

/** The namespace this plugin's provider row is registered under. */
const SETTINGS_NS = 'chatgpt'

/** The Remote namespace the Host exposes the sign-in surface on. */
const REMOTE_NS = 'chatgpt'

/**
 * How long the card waits for the Remote namespace before calling it unreachable.
 *
 * The namespace map arrives with the connection rather than with the bundle, so a
 * card can mount before its own namespace exists. Failing at that moment would
 * report a broken plugin for a race that resolves by itself.
 */
const REMOTE_WAIT_MS = 15_000

/** How often the card looks for the namespace while waiting. */
const REMOTE_POLL_MS = 250

/** Everything the card may show, mirrored from the Host's view type. */
interface StatusView {
  signedIn: boolean
  planUsageDenied: boolean
  email?: string
  plan?: string
  expiresAt?: number
  accounts: { subject: string, email?: string, active: boolean }[]
  pending?: { url: string, redirectUri: string }
  error?: string
}

/** What a sign-out reports beyond the resulting state. */
interface SignOutOutcome {
  status: StatusView
  revocationConfirmed: boolean
  revocationError?: string
}

/** The Remote surface this card calls. */
interface ChatGptRemote {
  status(): Promise<StatusView>
  begin(): Promise<StatusView>
  submit(value: string): Promise<StatusView>
  cancel(): Promise<StatusView>
  signOut(subject?: string): Promise<SignOutOutcome>
}

/**
 * The Remote namespace for this plugin, or `undefined` before the page knows it.
 *
 * Read on every call rather than captured when the bundle loads: the namespace is
 * supplied by the connection, so a card that resolved it once would keep the empty
 * answer it got at load for as long as the window lives.
 *
 * @param ctx - the browser plugin context.
 * @returns the namespace, once it is usable.
 */
function remoteNow(ctx: ClientContext): ChatGptRemote | undefined {
  const namespace = (ctx.remote as Record<string, ChatGptRemote | undefined>)[REMOTE_NS]
  // An unknown key may still resolve to an object, so the shape is checked rather
  // than the key's presence.
  return typeof namespace?.status === 'function' ? namespace : undefined
}

/**
 * Wait for the Remote namespace to arrive.
 * @param ctx - the browser plugin context.
 * @returns the namespace.
 * @throws When it never arrives, naming the action that fixes it.
 */
async function waitForRemote(ctx: ClientContext): Promise<ChatGptRemote> {
  const deadline = Date.now() + REMOTE_WAIT_MS
  for (;;) {
    const namespace = remoteNow(ctx)
    if (namespace !== undefined) return namespace
    if (Date.now() >= deadline) {
      throw new Error('the ChatGPT service is not reachable from this window; reload the window and try again')
    }
    await new Promise(resolve => { setTimeout(resolve, REMOTE_POLL_MS) })
  }
}

/** Services this plugin consumes from the page. */
export const inject = ['slots', 'remote']

/**
 * Register the card.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  // Nothing in the generated aggregate carries this plugin's namespace, so it is
  // mounted here. The card waits for it to appear, which also covers the mount
  // settling after the card's first render.
  const mounting = ctx.remote.$mount(remoteContribution())
  mounting.catch((error: unknown) => {
    console.error('[chatgpt] mounting the sign-in Remote namespace failed:', error)
  })

  ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register(
    { name: 'settings.models.provider-card', key: SETTINGS_NS },
    () => <ChatGptCard ctx={ctx} />,
  ))
}

/** One line of account facts. */
function Fact({ label, children }: { label: string, children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline', fontSize: '0.8125rem' }}>
      <span style={{ color: 'var(--dsw-alias-text-secondary, #888)', minWidth: '5rem' }}>{label}</span>
      <span>{children}</span>
    </div>
  )
}

/**
 * The card itself.
 * @param props.ctx - the browser plugin context carrying the Remote namespace.
 */
export function ChatGptCard({ ctx }: { ctx: ClientContext }) {
  const [status, setStatus] = useState<StatusView | undefined>(undefined)
  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState(false)
  /** Set when signing out worked locally but the server did not confirm it. */
  const [revocationNote, setRevocationNote] = useState<string | undefined>(undefined)
  const urlRef = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    try {
      const remote = await waitForRemote(ctx)
      setStatus(await remote.status())
    } catch (error) {
      setStatus({
        signedIn: false,
        planUsageDenied: false,
        accounts: [],
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }, [ctx])

  useEffect(() => { void refresh() }, [refresh])

  // A browser callback lands on the Host with no way to tell this page. While an
  // attempt is open the card asks again on a slow interval, which is cheap and
  // stops the moment the attempt settles either way.
  useEffect(() => {
    if (status?.pending === undefined) return
    const timer = setInterval(() => { void refresh() }, 2000)
    return () => { clearInterval(timer) }
  }, [status?.pending, refresh])

  const act = useCallback(async (operation: (remote: ChatGptRemote) => Promise<StatusView>) => {
    setBusy(true)
    try {
      const remote = await waitForRemote(ctx)
      setStatus(await operation(remote))
    } catch (error) {
      setStatus(previous => ({
        signedIn: false,
        planUsageDenied: false,
        accounts: [],
        ...previous,
        error: error instanceof Error ? error.message : String(error),
      }))
    } finally {
      setBusy(false)
    }
  }, [ctx])

  if (status === undefined) {
    return (
      <div style={{ fontSize: '0.8125rem', color: 'var(--dsw-alias-text-secondary, #888)' }}>
        Contacting the ChatGPT service…
      </div>
    )
  }

  const pending = status.pending
  const state = status.signedIn
    ? { tone: 'success' as const, text: 'Signed in' }
    : status.planUsageDenied
      ? { tone: 'warning' as const, text: 'Plan usage not authorized' }
      : { tone: 'neutral' as const, text: 'Signed out' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem', padding: '0.75rem 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <Tag tone={state.tone}>{state.text}</Tag>
        {status.plan === undefined ? null : <Pill>{status.plan}</Pill>}
      </div>

      {status.error === undefined ? null : (
        <div style={{ fontSize: '0.8125rem', color: 'var(--dsw-alias-text-danger, #c33)' }}>{status.error}</div>
      )}

      {revocationNote === undefined ? null : (
        <div style={{ fontSize: '0.8125rem', color: 'var(--dsw-alias-text-secondary, #888)' }}>{revocationNote}</div>
      )}

      {status.signedIn || status.planUsageDenied ? (
        <>
          <Fact label="Account">{status.email ?? status.accounts.find(entry => entry.active)?.subject ?? 'unknown'}</Fact>
          <Fact label="Models">
            {status.planUsageDenied
              ? 'Authorize plan usage to use this account'
              : 'Listed below, with the capacities your account reports'}
          </Fact>
          {status.expiresAt === undefined ? null : (
            <Fact label="Token">
              {`refreshes automatically (valid to ${new Date(status.expiresAt).toLocaleTimeString()})`}
            </Fact>
          )}
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                void act(async (remote) => {
                  const outcome = await remote.signOut()
                  // Signing out here is not the same as ending the grant at the
                  // server, and only one of those happened if this is set.
                  setRevocationNote(outcome.revocationConfirmed
                    ? undefined
                    : 'Signed out on this machine, but the server did not confirm the revocation'
                      + `${outcome.revocationError === undefined ? '' : ` (${outcome.revocationError})`}.`
                      + ' Disconnect the app in ChatGPT settings to be sure.')
                  return outcome.status
                })
              }}
            >
              Sign out
            </Button>
          </div>
        </>
      ) : pending === undefined ? (
        <>
          <div style={{ fontSize: '0.8125rem' }}>
            Use your ChatGPT subscription instead of an API key. Signing in authorizes this
            installation to spend your plan on model calls; the token stays on this machine.
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <Button variant="primary" disabled={busy} onClick={() => { void act(remote => remote.begin()) }}>
              Sign in with ChatGPT
            </Button>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontSize: '0.8125rem' }}>
            Open the authorization page. When the browser returns to{' '}
            <code>{pending.redirectUri}</code>, this card finishes on its own.
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              ref={urlRef}
              readOnly
              value={pending.url}
              onFocus={event => { event.currentTarget.select() }}
              style={{
                flex: 1,
                fontFamily: 'var(--dsw-font-mono, monospace)',
                fontSize: '0.75rem',
                padding: '0.375rem 0.5rem',
                border: '1px solid var(--dsw-alias-border, #ddd)',
                borderRadius: '6px',
                background: 'var(--dsw-alias-bg-secondary, transparent)',
              }}
            />
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                window.open(pending.url, '_blank', 'noopener')
                urlRef.current?.select()
              }}
            >
              Open
            </Button>
          </div>
          <div style={{ fontSize: '0.8125rem', color: 'var(--dsw-alias-text-secondary, #888)' }}>
            If the browser cannot reach that address, paste the final URL it landed on instead.
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <Input
              value={pasted}
              placeholder={pending.redirectUri}
              onChange={event => { setPasted(event.target.value) }}
              style={{ flex: 1 }}
            />
            <Button
              variant="outline"
              disabled={busy || pasted.trim().length === 0}
              onClick={() => {
                void act(async (remote) => {
                  const next = await remote.submit(pasted.trim())
                  setPasted('')
                  return next
                })
              }}
            >
              Finish
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => { void act(remote => remote.cancel()) }}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
