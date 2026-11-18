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

/** Shared by runtime admission and the browser settings card; contains no host code. */
export const webRequiredHostCapabilities = Object.freeze({
  replayVeto: 1,
  durableResponseAck: 1,
  // Version 2 distinguishes an explicitly configured summary route from history.
  summaryRoute: 2,
  durableSummaryAck: 1,
  pressurePolicy: 1,
})
