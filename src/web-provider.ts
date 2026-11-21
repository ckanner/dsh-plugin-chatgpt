/** Existing-provider integration. DSH owns compaction, title routes and all tools. */
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { WebBridgeClient, type WebBridgeClientOptions } from './web-bridge/client.ts'
import { WEB_MODEL, WEB_EFFORT, WebBridgeError, type TurnInspection, type WebBinding } from './web-bridge/contracts.ts'
import { captureWebRequest, type CapturedWebRequest, type WebGenerateOptions } from './web-bridge/request.ts'
import type { WebRuntimeStatus } from './web-runtime/index.ts'

export interface WebRuntime {
  status(): Promise<WebRuntimeStatus>
  setup(): Promise<WebRuntimeStatus>
  verify(): Promise<WebRuntimeStatus>
  setEnabled(enabled: boolean): Promise<WebRuntimeStatus>
  connection(): Promise<{ url: string, token: string, binding: WebBinding, instanceId: string }>
  listTurns(): Promise<TurnInspection[]>
  inspectTurn(turnId: string): Promise<TurnInspection>
  recoverTurn(turnId: string): Promise<TurnInspection>
  discardTurn(turnId: string): Promise<TurnInspection>
  dispose(): Promise<void>
}

export interface WebProviderStatus extends WebRuntimeStatus {
  contextBudget?: number
}

export interface WebProviderOptions {
  provider: string
  runtime: WebRuntime
  /** Explicit local input budget, not an assertion of ChatGPT's context capacity. */
  contextBudget(): number | undefined
  resolveAttachments?: () => unknown
  errorFactory?: WebBridgeClientOptions['errorFactory']
  onChanged?(): void
}

function required(message: string): never { throw new WebBridgeError('WEB_AUXILIARY_UNSUPPORTED', message, 409) }

export class WebProvider {
  private readonly options: WebProviderOptions
  private client: { instanceId: string, value: WebBridgeClient } | undefined
  private connecting: Promise<WebBridgeClient> | undefined
  private closed = false
  private disposePromise: Promise<void> | undefined

  constructor(options: WebProviderOptions) { this.options = options }

  private budget(): number {
    const value = this.options.contextBudget()
    if (!Number.isSafeInteger(value) || Number(value) < 1024) {
      throw new WebBridgeError('WEB_CONTEXT_BUDGET_REQUIRED', 'Set modelContextWindowLimits.gpt-6-pro-web (or contextWindowLimit) to an explicit local token budget before enabling Web.', 400)
    }
    return value!
  }

  async status(): Promise<WebProviderStatus> {
    const state = await this.options.runtime.status()
    try {
      return { ...state, contextBudget: this.budget(), ready: state.ready && state.enabled }
    } catch (cause) {
      return { ...state, ready: false, issues: [...state.issues, cause instanceof Error ? cause.message : String(cause)] }
    }
  }

  private async ready(signal?: AbortSignal): Promise<{ contextBudget: number }> {
    if (this.closed) throw new WebBridgeError('WEB_CLIENT_CLOSED', 'This Web provider was disposed.', 409)
    signal?.throwIfAborted()
    const state = await this.options.runtime.status()
    if (!state.enabled) throw new WebBridgeError('WEB_DISABLED', 'Enable GPT-6 Pro Web in the ChatGPT provider card.', 409)
    // A stopped verified runtime can be started by connection(). Other failed readiness is explicit.
    if (!state.ready && state.phase !== 'stopped') throw new WebBridgeError('WEB_SETUP_REQUIRED', state.issues.join(' ') || 'Complete and verify Web setup first.', 409)
    return { contextBudget: this.budget() }
  }

  async resolveModel(signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const { contextBudget } = await this.ready(signal)
    await this.connection()
    return { provider: this.options.provider, id: WEB_MODEL, name: 'GPT-6 Pro Web',
      description: 'Dedicated local Chrome · Pro · local input budget · token usage unavailable',
      inputModalities: ['text', 'image'], context: { contextWindow: contextBudget },
      reasoning: { efforts: [{ id: WEB_EFFORT as never, name: 'Pro' }], defaultEffort: WEB_EFFORT as never } }
  }

  async listModels(): Promise<LlmResolvedModelInfo[]> {
    try { return [await this.resolveModel()] } catch { return [] }
  }

  private connection(): Promise<WebBridgeClient> {
    if (!this.connecting) {
      const pending = (async () => {
        const connection = await this.options.runtime.connection()
        if (this.closed) throw new WebBridgeError('WEB_CLIENT_CLOSED', 'This Web provider was disposed.', 409)
        if (this.client?.instanceId === connection.instanceId) {
          const cached = this.client.value
          try { await cached.connect(); return cached } catch (cause) {
            this.client = undefined
            await cached.dispose()
            // No model request is replayed. A later readiness check may acquire a fresh lease.
            throw cause
          }
        }
        await this.client?.value.dispose()
        const value = new WebBridgeClient({ url: connection.url, token: connection.token, expectedBinding: connection.binding,
          ...this.options.errorFactory === undefined ? {} : { errorFactory: this.options.errorFactory },
          ...this.options.resolveAttachments === undefined ? {} : { resolveAttachments: this.options.resolveAttachments } })
        this.client = { instanceId: connection.instanceId, value }
        try {
          const health = await value.connect()
          if (health.instanceId !== connection.instanceId || health.transport !== 'browser') {
            throw new WebBridgeError('WEB_BINDING_MISMATCH', 'The connected bridge is not the verified browser runtime instance.', 409)
          }
        } catch (cause) { this.client = undefined; await value.dispose(); throw cause }
        if (this.closed) { await value.dispose(); throw new WebBridgeError('WEB_CLIENT_CLOSED', 'This Web provider was disposed.', 409) }
        return value
      })()
      this.connecting = pending
      void pending.then(() => { if (this.connecting === pending) this.connecting = undefined },
        () => { if (this.connecting === pending) this.connecting = undefined })
    }
    return this.connecting
  }

  /** Capture mutable host content before awaiting any setup, metadata or attachment reads. */
  stream(options: WebGenerateOptions): AsyncIterable<StreamChunk> {
    try { return this.generate(captureWebRequest(options)) }
    catch (cause) { return this.failed(cause) }
  }

  private async *failed(cause: unknown): AsyncGenerator<StreamChunk> { throw this.hostError(cause) }
  private hostError(cause: unknown): unknown {
    return cause instanceof WebBridgeError ? this.options.errorFactory?.(cause.message, cause.code, cause.status, cause.requestId) ?? cause : cause
  }

  private async *generate(snapshot: CapturedWebRequest): AsyncGenerator<StreamChunk> {
    try {
      if (snapshot.body.provider !== this.options.provider) throw new WebBridgeError('WEB_BINDING_MISMATCH', 'The request provider differs from this Web installation.', 400)
      if (snapshot.body.purpose !== undefined && snapshot.body.purpose !== 'normal') {
        required('Web auxiliary calls cannot enforce output-token limits; configure an explicit supported DSH summary/title route.')
      }
      await this.ready(snapshot.signal)
      const client = await this.connection()
      for await (const chunk of client.streamSnapshot(snapshot)) yield chunk
    } catch (cause) { throw this.hostError(cause) }
  }

  private async changed(action: () => Promise<unknown>): Promise<WebProviderStatus> {
    try { await action() } finally { this.options.onChanged?.() }
    return this.status()
  }
  setup(): Promise<WebProviderStatus> { return this.changed(() => this.options.runtime.setup()) }
  verify(): Promise<WebProviderStatus> { return this.changed(() => this.options.runtime.verify()) }
  async setEnabled(enabled: boolean): Promise<WebProviderStatus> {
    if (typeof enabled !== 'boolean') throw new WebBridgeError('WEB_INVALID_REQUEST', 'enabled must be a boolean.', 400)
    if (enabled) this.budget()
    return this.changed(() => this.options.runtime.setEnabled(enabled))
  }
  listTurns(): Promise<TurnInspection[]> { return this.options.runtime.listTurns() }
  inspectTurn(turnId: string): Promise<TurnInspection> { return this.options.runtime.inspectTurn(turnId) }
  recoverTurn(turnId: string): Promise<TurnInspection> { return this.options.runtime.recoverTurn(turnId) }
  discardTurn(turnId: string): Promise<TurnInspection> { return this.options.runtime.discardTurn(turnId) }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.closed = true
    this.disposePromise = (async () => {
      await this.connecting?.catch(() => {})
      let dataFailure: { cause: unknown } | undefined
      try { await this.client?.value.dispose() } catch (cause) { dataFailure = { cause } }
      // Management heartbeats must stop even after an expired data lease rejects DELETE.
      try { await this.options.runtime.dispose() } catch (cause) { if (!dataFailure) throw cause }
      if (dataFailure) throw dataFailure.cause
    })()
    return this.disposePromise
  }
}
