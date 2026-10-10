import { RequestError } from 'octokit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAfterGitHubRateLimit } from '../src/github-rate-limit.ts'

const start = new Date('2026-10-10T06:57:00Z')
const reset = new Date('2026-10-10T07:04:50Z')

function failure(headers: Record<string, string>, status = 403, message = 'API rate limit exceeded.') {
  return new RequestError(message, status, {
    request: { method: 'GET', url: 'https://api.github.com/installation/repositories', headers: {} },
    response: { status, url: 'https://api.github.com/installation/repositories', headers, data: { message } },
  })
}

afterEach(() => vi.useRealTimers())

describe('startup GitHub reads', () => {
  it('keeps discovery pending until primary quota resets, then returns the complete discovery', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(start)
    const repositories = ['harlan-zw/example']
    const read = vi.fn().mockRejectedValueOnce(failure({
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(reset.getTime() / 1000),
    })).mockResolvedValue(repositories)
    const onHold = vi.fn()
    const result = readAfterGitHubRateLimit({ read, now: () => new Date(), wait: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), onHold })
    const settled = vi.fn()
    void result.then(settled, settled)

    await vi.advanceTimersByTimeAsync(reset.getTime() - start.getTime())
    expect(read).toHaveBeenCalledTimes(1)
    expect(settled).not.toHaveBeenCalled()
    expect(onHold).toHaveBeenCalledWith(new Date(reset.getTime() + 1000))
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toEqual(repositories)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it.each([
    [{ 'retry-after': '30' }, 403, 30_000],
    [{}, 429, 60_000],
  ])('waits for secondary quota without restarting', async (headers, status, delay) => {
    vi.useFakeTimers()
    vi.setSystemTime(start)
    const read = vi.fn().mockRejectedValueOnce(failure(headers, status)).mockResolvedValue(['complete'])
    const result = readAfterGitHubRateLimit({ read, now: () => new Date(), wait: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), onHold: vi.fn() })

    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual(['complete'])
  })

  it('holds again when another discovery attempt exhausts quota', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(start)
    const read = vi.fn().mockRejectedValueOnce(failure({ 'retry-after': '1' })).mockRejectedValueOnce(failure({ 'retry-after': '2' })).mockResolvedValue(['complete'])
    const onHold = vi.fn()
    const result = readAfterGitHubRateLimit({ read, now: () => new Date(), wait: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), onHold })

    await vi.advanceTimersByTimeAsync(2999)
    expect(read).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual(['complete'])
    expect(onHold.mock.calls).toEqual([[new Date(start.getTime() + 1000)], [new Date(start.getTime() + 3000)]])
  })

  it('backs off when GitHub returns a reset time in the past', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(reset)
    const read = vi.fn().mockRejectedValueOnce(failure({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(start.getTime() / 1000) })).mockResolvedValue(['complete'])
    const result = readAfterGitHubRateLimit({ read, now: () => new Date(), wait: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), onHold: vi.fn() })

    await vi.advanceTimersByTimeAsync(999)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual(['complete'])
  })

  it.each([
    failure({}, 401, 'Bad credentials'),
    failure({}, 403, 'Resource not accessible by integration'),
    new Error('Network failed'),
  ])('surfaces failures that do not describe quota exhaustion', async (error) => {
    const wait = vi.fn()
    const onHold = vi.fn()
    const read = async () => {
      throw error
    }
    await expect(readAfterGitHubRateLimit({ read, now: () => start, wait, onHold })).rejects.toBe(error)
    expect(wait).not.toHaveBeenCalled()
    expect(onHold).not.toHaveBeenCalled()
  })
})
