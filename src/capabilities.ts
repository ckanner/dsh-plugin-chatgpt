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
