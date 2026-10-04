/**
 * Development-only declarations for the client half.
 *
 * Transcribed from the harness's browser packages, covering only what this
 * plugin's card uses. Not published; the host supplies the real packages at
 * runtime, and this plugin's own build leaves them external.
 *
 * @module dsh-plugin-chatgpt/dev-types/client
 */

declare module '@deepseek-ai/dsh-api-remotes/client' {
  import type { Context } from '@deepseek-ai/cordis'
  // The real package merges a generated `ctx.remote` namespace onto the client
  // Context. This plugin calls that namespace through a narrow local interface,
  // so the only thing needed here is that the file exists to be imported.
  export type RemoteContext = Context
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  import type { ReactNode } from 'react'

  /** One entry's registration options, discriminated by the slot's kind. */
  export interface SlotRegistrationOptions {
    /** Exact slot key this entry registers into. */
    name: string
    /** Cell key a `keyed` slot dispatches by. */
    key?: string
    /** Entry id a `list` slot orders and deduplicates by. */
    id?: string
    /** Sort position within the slot. */
    order?: number
    /** Label the owner may render beside the cell. */
    label?: () => string
    /** Locale namespace this entry's text belongs to. */
    locale?: string
  }

  /** The browser slot registry. */
  export interface SlotRegistry {
    /** Register a renderer for one exact slot occurrence. */
    register(options: SlotRegistrationOptions, render: () => ReactNode): () => void
    /**
     * Run `register` for every occurrence of one slot key.
     * @param name - the slot key.
     * @param register - registration callback.
     */
    inject(name: string, register: () => unknown): () => void
  }
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

  /** Visual families a button can take. */
  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'

  /** A token-styled button. */
  export function Button(props: {
    variant?: ButtonVariant
    size?: 'md' | 'sm'
    icon?: ReactNode
    className?: string
    children?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>): ReactNode

  /** A token-styled pill, optionally interactive. */
  export function Pill(props: {
    active?: boolean
    className?: string
    children?: ReactNode
    onClick?: () => void
  }): ReactNode

  /** A small status tag. */
  export function Tag(props: {
    tone?: 'neutral' | 'success' | 'warning' | 'danger'
    children?: ReactNode
  }): ReactNode

  /** A token-styled text input. */
  export function Input(props: {
    className?: string
  } & InputHTMLAttributes<HTMLInputElement>): ReactNode
}
