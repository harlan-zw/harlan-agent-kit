import { afterEach, describe, expect, it, vi } from 'vitest'
import { stopWithin } from '../src/shutdown.ts'

afterEach(() => vi.useRealTimers())

describe('service shutdown', () => {
  it('returns when the service stops', async () => {
    await expect(stopWithin(() => Promise.resolve(), 10_000)).resolves.toBe(true)
  })

  it('stops waiting for an unresponsive agent', async () => {
    vi.useFakeTimers()
    const stopping = stopWithin(() => new Promise(() => undefined), 10_000)

    await vi.advanceTimersByTimeAsync(10_000)

    await expect(stopping).resolves.toBe(false)
  })
})
