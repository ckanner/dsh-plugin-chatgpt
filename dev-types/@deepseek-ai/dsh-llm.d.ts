/**
 * Development-only declarations for the harness's LLM seam.
 *
 * These exist so `npm run typecheck` can check this plugin without a harness
 * checkout. They are **not** published and never shipped: at runtime the host
 * supplies the real packages, declared as peer dependencies.
 *
 * The shapes below are transcribed from the harness's own sources
 * (`packages/llm/llm/src/types.ts`, `packages/llm/llm/src/message.ts`). Only the
 * members this plugin touches are declared, so a drift that matters shows up as
 * a compile error here rather than as a silent mismatch in the host.
 *
 * An end-to-end mount in a real harness is the authoritative check; this file
 * narrows the gap, it does not close it.
 *
 * @module dsh-plugin-chatgpt/dev-types/dsh-llm
 */

declare module '@deepseek-ai/dsh-llm' {
  /** A branded provider-issued identifier. */
  export type Branded<T extends string> = string & { readonly __brand: T }

  /** One provider route's display identity. */
  export interface LlmProviderInfo {
    id: string
    name: string
  }

  /** An accepted request modality. */
  export type ModelModality = 'text' | 'image'

  /** One model as a catalog listing reports it. */
  export interface LlmModelInfo {
    provider: string
    id: string
    name: string
    description?: string
    inputModalities?: readonly ModelModality[]
  }

  /** Capacity facts about one model. */
  export interface LlmModelContext {
    contextWindow: number
  }

  /** Display metadata for one adapter-owned reasoning effort. */
  export interface LlmReasoningEffortInfo {
    id: Branded<'ReasoningEffortId'>
    name: string
    description?: string
  }

  /** Selectable reasoning efforts for one model. */
  export interface LlmModelReasoningInfo {
    efforts: readonly LlmReasoningEffortInfo[]
    defaultEffort?: Branded<'ReasoningEffortId'>
  }

  /** Everything known about one resolved model. */
  export interface LlmResolvedModelInfo extends LlmModelInfo {
    context?: LlmModelContext
    defaultMaxTokens?: number
    reasoning?: LlmModelReasoningInfo
  }

  /** Token accounting for one call. */
  export interface TokenUsage {
    inputTokens: number
    outputTokens: number
    totalTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
  }

  /** Why a model response stopped. */
  export type FinishReason =
    | { kind: 'stop' }
    | { kind: 'tool-calls' }
    | { kind: 'max-tokens' }
    | { kind: 'aborted', failure: { message: string } }
    | { kind: 'error', failure: { message: string } }

  /** One content block the harness stores. */
  export type ContentBlock =
    | { type: 'text', text: string }
    | { type: 'reasoning', text: string }
    | { type: 'image', attachment: unknown }
    | { type: 'file', attachment: unknown }
    | { type: 'tool-call', id: Branded<'ToolCallId'>, name: string, arguments: string }
    | { type: 'tool-addition', toolName: string }
    | { type: 'tool-removal', toolName: string }

  /** One conversation message. */
  export interface Message {
    readonly id: Branded<'MessageId'>
    readonly role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
    readonly content: readonly ContentBlock[]
    readonly source: unknown
    readonly toolCallId?: Branded<'ToolCallId'>
    readonly isError?: boolean
  }

  /** One tool schema as sent to a provider. */
  export interface ToolSchema {
    deferLoading?: true
    name: string
    description: string
    parameters: Record<string, unknown>
  }

  /** One fully-assembled model request. */
  export interface GenerateOptions {
    provider: string
    model: string
    reasoningEffort?: Branded<'ReasoningEffortId'>
    messages: readonly Message[]
    system?: string
    tools?: readonly ToolSchema[]
    temperature?: number
    maxTokens?: number
    stop?: string[]
    signal?: AbortSignal
    sessionId?: Branded<'SessionId'>
    purpose?: 'compaction' | 'session-title'
  }

  /** One chunk of a streaming model call. */
  export type StreamChunk =
    | { type: 'block-start', index: number, blockType: 'text' | 'reasoning' | 'image' | 'file' | 'tool-call' }
    | { type: 'text-delta', index: number, text: string }
    | { type: 'reasoning-delta', index: number, text: string }
    | { type: 'tool-call-delta', index: number, id: Branded<'ToolCallId'>, name?: string, argumentsDelta: string }
    | { type: 'block-end', index: number, block: ContentBlock }
    | { type: 'usage', usage: TokenUsage }
    | { type: 'finish', reason: FinishReason, replayState?: unknown }

  /** Model metadata plus a one-generation stream entry point. */
  export interface PreparedAdapterCall {
    model: LlmResolvedModelInfo
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  }

  /**
   * Provider-wire adapter for the harness message and stream vocabulary.
   *
   * Only `stream` is abstract, matching the harness's own declaration.
   */
  export abstract class LlmAdapter {
    providerInfo(provider: string): LlmProviderInfo
    providerRetryPolicy(provider: string): unknown
    listModels(provider: string): Promise<readonly LlmModelInfo[]>
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>
    abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  }

  /** What registering an adapter returns. */
  export interface AdapterRegistrationHandle {
    (): void
    replace(providers: string[]): void
  }

  /** Optional validated facts carried beside a structured failure. */
  export interface LlmErrorOptions extends ErrorOptions {
    /** Valid HTTP status observed at the provider boundary. */
    status?: number
    providerRetryAfterMs?: number
    requestId?: string
    offloadImages?: number
  }

  /**
   * The harness's structured error.
   *
   * The harness reads `code` and any status off a thrown error to classify a
   * provider failure, so a plugin must throw this rather than its own class.
   */
  export class LlmError extends Error {
    constructor(message: string, code: string, options?: LlmErrorOptions)
    readonly code: string
    readonly failure: { status?: number }
  }
}
