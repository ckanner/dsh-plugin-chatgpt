/**
 * Development-only declaration for the harness's Cordis context.
 *
 * Transcribed from `vendor/cordis`, covering only what this plugin uses. Not
 * published; the host supplies the real package at runtime.
 *
 * @module dsh-plugin-chatgpt/dev-types/cordis
 */

declare module '@deepseek-ai/cordis' {
  import type {
    AdapterRegistrationHandle, DirectoryRegistrationHandle, LlmAdapter, LlmConfigurableProvider,
  } from '@deepseek-ai/dsh-llm'

  /** One registered route's owning adapter. */
  export interface LlmRouteRegistry {
    registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle
    /** Publish provider rows the Models page renders and edits. */
    registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): DirectoryRegistrationHandle
  }

  /** The plugin context, narrowed to the services this plugin consumes. */
  export interface Context {
    llm: LlmRouteRegistry
    effect(callback: () => () => void): () => void
    get(name: string): unknown
  }
}

declare module '@deepseek-ai/cordis' {
  import type { SlotRegistry } from '@deepseek-ai/dsh-client-ui-slots'

  /**
   * The browser context, narrowed to the services the card consumes. Declared
   * separately from the host face above because the two halves share one package
   * name in TypeScript's view while running against different services.
   */
  export interface ClientContextServices {
    /** The slot registry the card registers its provider-card cell into. */
    slots: SlotRegistry
    /** The generated Remote namespace host, keyed by wire namespace. */
    remote: Record<string, unknown>
  }
}
