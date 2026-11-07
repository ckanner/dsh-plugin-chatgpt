import { ProxyAgent, fetch as undiciFetch } from 'undici'

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
  // Use undici's own fetch with its own dispatcher. Node's global fetch may be
  // built from a different undici version and reject this agent's internals
  // (for example Node 26 rejects undici 6's `onError` method).
  const scopedFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as unknown as Parameters<typeof undiciFetch>[0], {
      ...init,
      dispatcher: agent,
    } as unknown as Parameters<typeof undiciFetch>[1])) as unknown as typeof fetch
  // Plugin disposal must not wait indefinitely for an active SSE response.
  // Destroying the private dispatcher interrupts only this plugin's requests.
  return { fetch: scopedFetch, close: () => agent.destroy(new Error('ChatGPT plugin disposed')) }
}
