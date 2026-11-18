import { exactKeys, integer, objectValue, WebPolicyError } from './policy.ts'

export interface WebImageLimits { maxImages: number; maxImageBytes: number; maxTotalBytes: number }
export const DEFAULT_WEB_IMAGE_LIMITS: Readonly<WebImageLimits> = Object.freeze({ maxImages: 10, maxImageBytes: 20 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024 })
/** Memory/upload admission ceilings, independent of account-dependent website limits. */
export const MAX_WEB_IMAGE_LIMITS: Readonly<WebImageLimits> = Object.freeze({ maxImages: 20, maxImageBytes: 20 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 })

export function imageLimits(value: unknown = DEFAULT_WEB_IMAGE_LIMITS): WebImageLimits {
  const raw = objectValue(value, 'image limits')
  exactKeys(raw, ['maxImages', 'maxImageBytes', 'maxTotalBytes'], 'image limits')
  const limits = {
    maxImages: integer(raw.maxImages, 'maxImages', 1, MAX_WEB_IMAGE_LIMITS.maxImages),
    maxImageBytes: integer(raw.maxImageBytes, 'maxImageBytes', 1024, MAX_WEB_IMAGE_LIMITS.maxImageBytes),
    maxTotalBytes: integer(raw.maxTotalBytes, 'maxTotalBytes', 1024, MAX_WEB_IMAGE_LIMITS.maxTotalBytes),
  }
  if (limits.maxTotalBytes < limits.maxImageBytes) throw new WebPolicyError('image total budget must include one maximum-sized image')
  return limits
}
