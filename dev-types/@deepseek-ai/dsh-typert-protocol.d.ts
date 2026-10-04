/**
 * Development-only declaration for the harness's Remote protocol.
 *
 * Transcribed from `packages/typert/protocol/src/index.ts`, covering only what
 * this plugin's controller uses. Not published; the host supplies the real
 * package at runtime.
 *
 * @module dsh-plugin-chatgpt/dev-types/typert-protocol
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  /** One method exported to browser callers. */
  type RemoteMethodDecorator = <This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ) => void

  /** Mark one public method as a direct Remote invocation, or a logical stream. */
  export function Remote(option?: string | { mode: 'stream' }): RemoteMethodDecorator
  export function Remote<This extends object, Args extends unknown[], Result>(
    method: (this: This, ...args: Args) => Result,
    context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Result>,
  ): void

  /** Options binding a service key to a wire namespace. */
  export interface TypertGatewayBindingOptions {
    /** Wire namespace; defaults to the service key. */
    namespace?: string
  }

  /** Cordis service base that exposes its methods through the Typert gateway. */
  export abstract class TypertRemoteService<out T = never> {
    /**
     * @param ctx - owning context.
     * @param serviceKey - Cordis service key and default wire namespace.
     * @param options - optional distinct wire namespace.
     */
    protected constructor(ctx: unknown, serviceKey: string, options?: TypertGatewayBindingOptions)
  }
}
