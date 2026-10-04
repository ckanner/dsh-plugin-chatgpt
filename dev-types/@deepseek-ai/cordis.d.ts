/**
 * Development-only declaration for the harness's Cordis context.
 *
 * Transcribed from `vendor/cordis`, covering only what this plugin uses. Not
 * published; the host supplies the real package at runtime.
 *
 * @module dsh-plugin-chatgpt/dev-types/cordis
 */

declare module '@deepseek-ai/cordis' {
  import type { AdapterRegistrationHandle, LlmAdapter } from '@deepseek-ai/dsh-llm'

  /** One registered route's owning adapter. */
  export interface LlmRouteRegistry {
    registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle
  }

  /** The plugin context, narrowed to the services this plugin consumes. */
  export interface Context {
    llm: LlmRouteRegistry
    effect(callback: () => () => void): () => void
    get(name: string): unknown
  }
}
