/** Caller cancellation is a terminal fact, never an authentication failure. */
export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw Object.assign(new Error('the ChatGPT request was aborted by its caller'), { name: 'AbortError', code: 'ABORTED' })
  }
}

/** Stop waiting promptly even when an optional host service ignores its signal. */
export async function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return await pending
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          try { assertNotAborted(signal) } catch (error) { reject(error) }
        }
        signal.addEventListener('abort', onAbort, { once: true })
        onAbort()
      }),
    ])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}
