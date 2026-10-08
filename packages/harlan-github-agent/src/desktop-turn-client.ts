import { setTimeout as delay } from 'node:timers/promises'
import { DESKTOP_TURN_LEASE_MILLISECONDS } from './desktop-protocol.ts'

/** A failed request does not revoke authority. An expired lease always does. */
export function createDesktopTurnLease(options: { signal: AbortSignal, stop: () => void, now: () => number }) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  const revoke = () => {
    if (controller.signal.aborted)
      return
    controller.abort(new Error('The desktop turn no longer holds its authority lease.'))
    options.stop()
  }
  const renew = (startedAt: number) => {
    if (controller.signal.aborted)
      return
    clearTimeout(timer)
    const remaining = startedAt + DESKTOP_TURN_LEASE_MILLISECONDS - options.now()
    if (remaining <= 0)
      revoke()
    else
      timer = setTimeout(revoke, remaining)
  }
  options.signal.addEventListener('abort', revoke, { once: true })
  renew(options.now())
  if (options.signal.aborted)
    revoke()
  const request = async <T>(send: () => Promise<T>): Promise<T> => {
    while (true) {
      controller.signal.throwIfAborted()
      let abort: () => void = () => {}
      try {
        const cancelled = new Promise<never>((_, reject) => {
          abort = () => reject(controller.signal.reason)
          controller.signal.addEventListener('abort', abort, { once: true })
        })
        const answer = await Promise.race([send(), cancelled])
        controller.signal.throwIfAborted()
        return answer
      }
      catch (error) {
        controller.signal.throwIfAborted()
        console.error('Desktop controller request will retry within its authority lease.', error)
      }
      finally {
        controller.signal.removeEventListener('abort', abort)
      }
      await delay(250, undefined, { signal: controller.signal })
    }
  }
  return {
    signal: controller.signal,
    request,
    heartbeat: async (send: () => Promise<{ active: boolean } | null>) => {
      await request(async () => {
        const startedAt = options.now()
        const answer = await send()
        if (answer?.active === true)
          renew(startedAt)
        else
          revoke()
        return answer
      }).catch((error: unknown) => {
        // Lease expiry and cancellation already stop the child. Surface unexpected failures.
        if (!controller.signal.aborted)
          throw error
      })
    },
    close: () => {
      clearTimeout(timer)
      options.signal.removeEventListener('abort', revoke)
      controller.abort(new Error('The desktop turn finished.'))
    },
  }
}
