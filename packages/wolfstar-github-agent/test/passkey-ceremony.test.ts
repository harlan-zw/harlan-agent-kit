import { afterEach, expect, it, vi } from 'vitest'
import { runPasskeyOperation } from '../dashboard/app/utils/passkey-ceremony.ts'

afterEach(() => vi.useRealTimers())
it('bounds a browser ceremony that never responds and aborts it', async () => {
  vi.useFakeTimers()
  const abortBrowser = vi.fn()
  const operation = runPasskeyOperation({
    prepare: async () => ({}),
    browser: () => new Promise(() => {}),
    verify: vi.fn(),
    abortBrowser,
    phase: vi.fn(),
  })
  await vi.advanceTimersByTimeAsync(120001)
  expect(await operation.result).toEqual({ _tag: 'TimedOut', phase: 'WaitingForBrowser' })
  expect(abortBrowser).toHaveBeenCalledOnce()
})
it('discards late browser completion after explicit cancellation before verification', async () => {
  let resolve!: (value: string) => void
  const verify = vi.fn()
  const abortBrowser = vi.fn()
  const phases: unknown[] = []
  const operation = runPasskeyOperation({
    prepare: async () => ({}),
    browser: () =>
      new Promise<string>((done) => {
        resolve = done
      }),
    verify,
    abortBrowser,
    phase: (phase) => phases.push(phase),
  })
  await vi.waitFor(() => expect(phases).toContain('WaitingForBrowser'))
  operation.cancel()
  resolve('late-credential')
  expect(await operation.result).toEqual({ _tag: 'Cancelled' })
  await Promise.resolve()
  expect(verify).not.toHaveBeenCalled()
  expect(abortBrowser).toHaveBeenCalledOnce()
})
it.each(['Preparing', 'Verifying'] as const)('aborts HTTP at %s and ignores its late completion', async (phase) => {
  let resolve!: () => void
  let signal!: AbortSignal
  const phases: unknown[] = []
  const operation = runPasskeyOperation({
    prepare: async (request) => {
      if (phase === 'Preparing') {
        signal = request
        await new Promise<void>((done) => {
          resolve = done
        })
      }
      return {}
    },
    browser: async () => ({}),
    verify: async (_, request) => {
      signal = request
      await new Promise<void>((done) => {
        resolve = done
      })
    },
    abortBrowser: vi.fn(),
    phase: (phase) => phases.push(phase),
  })
  await vi.waitFor(() => expect(phases).toContain(phase))
  operation.cancel()
  expect(signal.aborted).toBe(true)
  resolve()
  expect(await operation.result).toEqual({ _tag: 'Cancelled' })
  await Promise.resolve()
  expect(phases.at(-1)).toBeNull()
})
it('bounds a stalled preparation request without opening a browser prompt', async () => {
  vi.useFakeTimers()
  const browser = vi.fn()
  let signal!: AbortSignal
  const operation = runPasskeyOperation({
    prepare: (request) => {
      signal = request
      return new Promise(() => {})
    },
    browser,
    verify: vi.fn(),
    abortBrowser: vi.fn(),
    phase: vi.fn(),
  })
  await vi.advanceTimersByTimeAsync(15001)
  expect(await operation.result).toEqual({ _tag: 'TimedOut', phase: 'Preparing' })
  expect(signal.aborted).toBe(true)
  expect(browser).not.toHaveBeenCalled()
})
it('verifies only a completed browser response and clears the visible phase', async () => {
  const phases: unknown[] = []
  const verify = vi.fn(async (_credential: string, _signal: AbortSignal) => ({}))
  const operation = runPasskeyOperation({
    prepare: async () => 'options',
    browser: async (options) => `${options}-credential`,
    verify,
    abortBrowser: vi.fn(),
    phase: (phase) => phases.push(phase),
  })
  expect(await operation.result).toEqual({ _tag: 'Ok', value: {} })
  expect(verify.mock.calls[0]?.[0]).toBe('options-credential')
  expect(phases).toEqual(['Preparing', 'WaitingForBrowser', 'Verifying', null])
})
it('keeps post-verification synchronization bounded and refuses a late session result', async () => {
  vi.useFakeTimers()
  let resolve!: (value: { authenticated: boolean }) => void
  let signal!: AbortSignal
  const operation = runPasskeyOperation({
    prepare: async () => ({}),
    browser: async () => 'credential',
    verify: async (_, request) => {
      signal = request
      return new Promise<{ authenticated: boolean }>((done) => {
        resolve = done
      })
    },
    abortBrowser: vi.fn(),
    phase: vi.fn(),
  })
  await vi.advanceTimersByTimeAsync(15001)
  expect(await operation.result).toEqual({ _tag: 'TimedOut', phase: 'Verifying' })
  expect(signal.aborted).toBe(true)
  resolve({ authenticated: true })
  await Promise.resolve()
  expect(await operation.result).toEqual({ _tag: 'TimedOut', phase: 'Verifying' })
})
