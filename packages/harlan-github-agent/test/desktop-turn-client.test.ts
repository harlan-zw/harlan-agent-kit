import { afterEach, expect, it, vi } from 'vitest'
import { createDesktopTurnLease } from '../src/desktop-turn-client.ts'

afterEach(() => vi.useRealTimers())

it('recovers one failed heartbeat while its authority lease remains live', async () => {
  vi.useFakeTimers()
  const stop = vi.fn()
  let calls = 0
  const lease = createDesktopTurnLease({ signal: new AbortController().signal, stop, now: Date.now })
  const api = async () => {
    if (++calls === 1) {
      await new Promise(resolve => setTimeout(resolve, 10_000))
      throw new Error('Temporary connection failure.')
    }
    return { active: true }
  }
  const recovering = lease.heartbeat(api)
  await vi.advanceTimersByTimeAsync(10_250)
  await recovering
  await vi.advanceTimersByTimeAsync(3000)
  await lease.heartbeat(api)
  await vi.advanceTimersByTimeAsync(12_001)
  expect(stop).not.toHaveBeenCalled()
  lease.close()
})

it('stops at lease expiry even when a heartbeat request never returns', async () => {
  vi.useFakeTimers()
  const stop = vi.fn()
  const lease = createDesktopTurnLease({ signal: new AbortController().signal, stop, now: Date.now })
  void lease.heartbeat(() => new Promise(() => {}))
  await vi.advanceTimersByTimeAsync(15_000)
  expect(stop).toHaveBeenCalledOnce()
  expect(lease.signal.aborted).toBe(true)
  lease.close()
})

it('honours explicit cancellation immediately and never retries its result', async () => {
  const stop = vi.fn()
  const lease = createDesktopTurnLease({ signal: new AbortController().signal, stop, now: Date.now })
  await lease.heartbeat(async () => ({ active: false }))
  const send = vi.fn(async () => true)
  await expect(lease.request(send)).rejects.toThrow()
  expect(stop).toHaveBeenCalledOnce()
  expect(send).not.toHaveBeenCalled()
  lease.close()
})

it('retries the same event after an acknowledgement disappears', async () => {
  vi.useFakeTimers()
  const sent: unknown[] = []
  const event = { sequence: 0, events: [{ _tag: 'Message', text: 'one' }] }
  const lease = createDesktopTurnLease({ signal: new AbortController().signal, stop: vi.fn(), now: Date.now })
  const response = lease.request(async () => {
    sent.push(event)
    if (sent.length === 1)
      throw new Error('Response lost after acceptance.')
    return { accepted: true }
  })
  await vi.advanceTimersByTimeAsync(300)
  await expect(response).resolves.toEqual({ accepted: true })
  expect(sent).toEqual([event, event])
  lease.close()
})
