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

  /** The plugin instance a service's policy is registered against. */
  export interface Fiber {
    /** The loader entry's own options, whose id names this plugin's settings namespace. */
    entry?: { options?: { id?: string } }
  }

  /** Instance-level settings policy. */
  export interface SettingsService {
    /**
     * Register this plugin instance's page policy without changing its Config.
     * @param presentation - automatic-page policy for this instance.
     * @param owner - the plugin instance the policy belongs to.
     * @returns a disposer.
     */
    configure(presentation: { auto?: boolean }, owner?: Fiber): () => void
  }

  /** The plugin context, narrowed to the services this plugin consumes. */
  export interface Context {
    llm: LlmRouteRegistry
    settings: SettingsService
    fiber: Fiber
    effect(callback: () => () => void): () => void
    get(name: string): unknown
    /**
     * Run `callback` once the named services are available, against a context
     * that carries them. Used for a service the plugin needs only to configure,
     * so a composition without it still activates everything else.
     * @param deps - service keys to wait for.
     * @param callback - runs with the injected context.
     */
    inject(deps: readonly string[], callback: (child: Context) => void): void
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
    /**
     * The Remote namespace host, keyed by wire namespace.
     *
     * `$mount` is the Gateway's own entry point for installing a namespace from a
     * package's descriptors. It is how a plugin outside the generated aggregate
     * gets a namespace at all.
     */
    remote: Record<string, unknown> & {
      $mount(contribution: unknown): Promise<() => Promise<void>>
    }
  }
}
