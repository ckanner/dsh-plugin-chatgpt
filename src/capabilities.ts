/**
 * Static adapter contract, not account entitlement or a successful live probe.
 * Import this subpath without mounting a DSH host or reading credentials.
 */
export const contentCapabilities = Object.freeze({
  version: 1,
  imageInputRoles: Object.freeze(['user', 'tool'] as const),
  imageSource: 'durable-attachment-service',
  toolOutput: 'text-or-responses-content-array',
  fileInput: false,
})

/** Descriptive only. Consumers must resolve the model through their live DSH host. */
export const webCapabilities = Object.freeze({
  version: 1,
  model: 'gpt-6-pro-web',
  reasoningEfforts: Object.freeze(['pro'] as const),
  defaultEffort: 'pro',
  transport: 'local-browser',
  usage: 'unknown',
  generationControls: Object.freeze({ maxTokens: false, temperature: false, stop: false }),
  requiresAuxiliaryRoute: true,
  recoveryCodes: Object.freeze(['WEB_UNCERTAIN', 'WEB_DELIVERY_CLAIMED', 'WEB_CONNECTION_LOST', 'WEB_PROTOCOL_ERROR'] as const),
})
