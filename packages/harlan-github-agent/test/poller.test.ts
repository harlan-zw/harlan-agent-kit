import { describe, expect, it, vi } from 'vitest'
import { createPoller } from '../src/poller.ts'

describe('poller', () => {
  it('coalesces requests during a pass into one fresh follow-up', async () => {
    vi.useFakeTimers()
    const releases: Array<() => void> = []
    const reads: number[] = []
    let revision = 1
    const poller = createPoller({
      intervalMilliseconds: 60_000,
      onError: (error) => { throw error },
      poll: async () => {
        reads.push(revision)
        if (reads.length === 1)
          await new Promise<void>(resolve => releases.push(resolve))
      },
    })
    try {
      const initial = poller.runNow()
      await vi.advanceTimersByTimeAsync(0)
      revision = 2
      const deliveries = Array.from({ length: 20 }, () => poller.runNow())
      releases[0]!()
      await Promise.all([initial, ...deliveries])
      expect(reads).toEqual([1, 2])
    }
    finally {
      await poller.stop()
      vi.useRealTimers()
    }
  })

  it('waits for the follow-up read before resolving its callers', async () => {
    const releases: Array<() => void> = []
    const poll = vi.fn(() => new Promise<void>(resolve => releases.push(resolve)))
    const poller = createPoller({
      intervalMilliseconds: 60_000,
      poll,
      onError: (error) => { throw error },
    })
    const initial = poller.runNow()
    await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(1))
    const next = poller.runNow()
    const settled = vi.fn()
    void next.then(settled)
    releases[0]!()
    await initial
    await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(2))
    expect(settled).not.toHaveBeenCalled()
    releases[1]!()
    await next
    expect(settled).toHaveBeenCalledTimes(1)
    await poller.stop()
  })

  it('aborts the active read and discards queued reads when stopped', async () => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const signals: AbortSignal[] = []
    const poller = createPoller({
      intervalMilliseconds: 60_000,
      onError: (error) => { throw error },
      poll: signal => new Promise<void>((resolve) => {
        signals.push(signal)
        signal.addEventListener('abort', () => resolve(), { once: true })
        entered()
      }),
    })
    const initial = poller.runNow()
    await started
    const next = poller.runNow()
    await poller.stop()
    await Promise.all([initial, next, poller.runNow()])
    expect(signals).toHaveLength(1)
    expect(signals[0]!.aborted).toBe(true)
  })

  it('can start again after shutdown', async () => {
    const poll = vi.fn(async () => {})
    const poller = createPoller({
      intervalMilliseconds: 60_000,
      poll,
      onError: (error) => { throw error },
    })
    await poller.runNow()
    await poller.stop()
    poller.start()
    await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(2))
    await poller.stop()
  })

  it.each([undefined, 900_000])('keeps hourly polling when the maximum is %s', async (maxIntervalMilliseconds) => {
    vi.useFakeTimers()
    const poll = vi.fn(async () => {})
    const poller = createPoller({
      intervalMilliseconds: 3_600_000,
      ...(maxIntervalMilliseconds === undefined ? {} : { maxIntervalMilliseconds }),
      random: () => 0,
      onError: (error) => { throw error },
      poll,
    })
    try {
      poller.start()
      await vi.advanceTimersByTimeAsync(3_599_999)
      expect(poll).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(poll).toHaveBeenCalledTimes(2)
    }
    finally {
      await poller.stop()
      vi.useRealTimers()
    }
  })

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

      poller.stop().catch(() => {
        // This teardown cannot affect the overlap assertions above.
      })
    }
    finally {
      vi.useRealTimers()
    }
  })
})
