import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeStopOutcome, stopWithin } from '../src/shutdown.ts'

afterEach(() => vi.useRealTimers())

const now = () => Date.now()
const after = (milliseconds: number) => () => new Promise<void>(resolve => setTimeout(resolve, milliseconds))

describe('service shutdown', () => {
  it('reports the slowest stage of a stop that finishes', async () => {
    vi.useFakeTimers()
    const stopping = stopWithin(async (stages) => {
      await Promise.all([
        stages.run('Review scheduler 1', after(1_000)),
        stages.run('Control API listener', after(3_000)),
      ])
      await stages.run('Journal', () => undefined)
    }, { timeoutMilliseconds: 10_000, now })

    await vi.advanceTimersByTimeAsync(3_000)

    await expect(stopping).resolves.toEqual({
      _tag: 'Stopped',
      milliseconds: 3_000,
      slowest: { name: 'Control API listener', milliseconds: 3_000 },
    })
  })

  it('names the stage that is still running when the stop overruns', async () => {
    vi.useFakeTimers()
    const stopping = stopWithin(async (stages) => {
      await Promise.all([
        stages.run('Review scheduler 1', after(2_000)),
        stages.run('Control API listener', () => new Promise(() => undefined)),
        stages.run('webhook listener', after(4_000)),
      ])
    }, { timeoutMilliseconds: 10_000, now })

    await vi.advanceTimersByTimeAsync(10_000)

    const outcome = await stopping
    expect(outcome).toEqual({
      _tag: 'Overran',
      milliseconds: 10_000,
      running: [{ name: 'Control API listener', milliseconds: 10_000 }],
    })
    expect(describeStopOutcome(outcome)).toBe('Shutdown passed 10 seconds. Still running: Control API listener (10.0 s). The next start recovers unfinished work.')
  })

  it('says when the stop hangs outside every named stage', async () => {
    vi.useFakeTimers()
    const stopping = stopWithin(async (stages) => {
      await stages.run('Journal', () => undefined)
      await new Promise(() => undefined)
    }, { timeoutMilliseconds: 10_000, now })

    await vi.advanceTimersByTimeAsync(10_000)

    const outcome = await stopping
    expect(outcome).toEqual({ _tag: 'Overran', milliseconds: 10_000, running: [] })
    expect(describeStopOutcome(outcome)).toBe('Shutdown passed 10 seconds. No named stage was running. The next start recovers unfinished work.')
  })

  it('rejects when a stage fails', async () => {
    await expect(stopWithin(async (stages) => {
      await stages.run('Journal', () => {
        throw new Error('The Journal did not close.')
      })
    }, { timeoutMilliseconds: 10_000, now })).rejects.toThrow('The Journal did not close.')
  })
})
