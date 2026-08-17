import { describe, expect, it, vi } from 'vitest'
import { createPoller } from '../src/poller.ts'

describe('poller', () => {
  it('abandons a pass that never settles so later passes still run', async () => {
    vi.useFakeTimers()
    try {
      const errors: unknown[] = []
      let started = 0
      let aborted = false
      const poller = createPoller({
        intervalMilliseconds: 1_000,
        timeoutMilliseconds: 5_000,
        random: () => 0,
        onError: error => errors.push(error),
        poll: (signal) => {
          started += 1
          if (started > 1)
            return Promise.resolve()
          return new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => {
              aborted = true
              resolve()
            }, { once: true })
          })
        },
      })

      poller.start()
      await vi.advanceTimersByTimeAsync(5_100)
      expect(aborted).toBe(true)
      expect(errors).toHaveLength(1)
      expect(String(errors[0])).toContain('was abandoned')

      // The chained pass promise is free again, so the next pass runs.
      await vi.advanceTimersByTimeAsync(4_000)
      expect(started).toBeGreaterThan(1)
      await poller.stop()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('does not abandon a pass that finishes inside its budget', async () => {
    vi.useFakeTimers()
    try {
      const errors: unknown[] = []
      const poller = createPoller({
        intervalMilliseconds: 1_000,
        timeoutMilliseconds: 5_000,
        random: () => 0,
        onError: error => errors.push(error),
        poll: () => new Promise<void>((resolve) => {
          setTimeout(resolve, 1_000)
        }),
      })

      poller.start()
      await vi.advanceTimersByTimeAsync(1_100)
      expect(errors).toEqual([])
      await poller.stop()
    }
    finally {
      vi.useRealTimers()
    }
  })
})

describe('abandoned pass containment', () => {
  it('skips a pass instead of piling onto passes that never settle', async () => {
    vi.useFakeTimers()
    try {
      const errors: string[] = []
      let started = 0
      const release: Array<() => void> = []
      const poller = createPoller({
        intervalMilliseconds: 1_000,
        // Keep backoff flat so the assertions describe containment, not delay.
        maxIntervalMilliseconds: 1_000,
        timeoutMilliseconds: 2_000,
        maximumAbandonedPasses: 1,
        random: () => 0,
        onError: error => errors.push(String(error)),
        poll: () => {
          started += 1
          return new Promise<void>((resolve) => {
            release.push(resolve)
          })
        },
      })

      poller.start()
      await vi.advanceTimersByTimeAsync(30_000)

      // One abandoned pass is tolerated, so at most two ever run at once.
      expect(started).toBe(2)
      expect(errors.some(error => error.includes('was skipped'))).toBe(true)
      // A skip still reschedules, so the loop is slowed and never stopped.
      expect(errors.filter(error => error.includes('was skipped')).length).toBeGreaterThan(1)

      release.forEach(resolve => resolve())
      await vi.advanceTimersByTimeAsync(5_000)
      expect(started).toBeGreaterThan(2)

      poller.stop().catch(() => undefined)
    }
    finally {
      vi.useRealTimers()
    }
  })
})
