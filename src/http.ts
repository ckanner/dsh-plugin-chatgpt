import { ProxyAgent } from 'undici'

/** A fetch owned by one plugin instance, without changing Node's global dispatcher. */
export function createScopedFetch(proxyUrl: string | undefined): {
  fetch: typeof fetch
  close: () => Promise<void>
} {
  const value = proxyUrl?.trim()
  if (value === undefined || value === '') {
    return { fetch: globalThis.fetch, close: async () => {} }
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('chatgpt: proxyUrl must be an absolute http:// or https:// URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('chatgpt: proxyUrl must use http:// or https://')
  }
  const agent = new ProxyAgent(value)
  // Node's fetch accepts an Undici dispatcher at runtime. Keep the cast local
  // because the standard DOM RequestInit type does not declare that extension.
  const scopedFetch: typeof fetch = (input, init) => globalThis.fetch(input, {
    ...init,
    dispatcher: agent,
  } as RequestInit)
  // Plugin disposal must not wait indefinitely for an active SSE response.
  // Destroying the private dispatcher interrupts only this plugin's requests.
  return { fetch: scopedFetch, close: () => agent.destroy(new Error('ChatGPT plugin disposed')) }
}
