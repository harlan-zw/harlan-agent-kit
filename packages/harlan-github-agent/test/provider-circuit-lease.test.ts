import type { AgentEvent, AgentProvider } from '../src/agent-provider.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { createCircuitProtectedProvider } from '../src/provider-circuit.ts'
import { openJournalStore } from '../src/store.ts'

const stores: ReturnType<typeof openJournalStore>[] = []

afterEach(() => {
  vi.useRealTimers()
  stores.splice(0).forEach(store => store.close())
})

function fixture(provider: AgentProvider) {
  vi.useFakeTimers()
  const store = openJournalStore(':memory:')
  stores.push(store)
  const key = { provider: provider.name, credential: 'fixture', model: 'fixture/model' }
  for (const at of ['2026-10-18T00:00:00.000Z', '2026-10-18T00:00:01.000Z', '2026-10-18T00:00:02.000Z'])
    store.recordProviderFailure({ ...key, failureClass: 'authentication', detail: 'Fixture unauthorized', at })
  vi.setSystemTime(new Date('2026-10-18T00:05:02.000Z'))
  const protectedProvider = createCircuitProtectedProvider({ credential: key.credential, now: () => new Date(), store, provider })
  const controller = new AbortController()
  const request = { model: key.model, outputSchema: {}, prompt: '', sessionId: null, signal: controller.signal, workspace: '/fixture' }
  const start = (taskId: string) => protectedProvider.runTurn({ ...request, taskId })[Symbol.asyncIterator]()
  return { store, key, controller, start }
}

it.each(['quiet', 'yielded'] as const)('retains a %s canary beyond its original lease and accepts its success', async (mode) => {
  const finish = Promise.withResolvers<void>()
  const { store, start } = fixture({
    name: 'codex',
    async* runTurn() {
      yield { _tag: 'SessionStarted', sessionId: 'fixture' }
      await finish.promise
      yield { _tag: 'TurnCompleted' }
    },
  })
  const first = start('first')
  await first.next()
  const pending = mode === 'quiet' ? first.next() : null
  const second = start('second')
  try {
    await vi.advanceTimersByTimeAsync(121_000)
    expect((await second.next()).value).toMatchObject({ _tag: 'Failed' })
    finish.resolve()
    expect((await (pending ?? first.next())).value).toEqual({ _tag: 'TurnCompleted' })
    expect(vi.getTimerCount()).toBe(0)
    await first.next()
    expect(store.listProviderCircuits()[0]?.state._tag).toBe('Closed')
    expect(vi.getTimerCount()).toBe(0)
  }
  finally {
    finish.resolve()
    await first.return?.()
    await second.return?.()
  }
})

it.each(['lost', 'store-error'] as const)('stops a quiet turn after renewal %s without changing provider health', async (failure) => {
  let providerSignal: AbortSignal | undefined
  const { store, start } = fixture({
    name: 'codex',
    async* runTurn(request) {
      providerSignal = request.signal
      yield { _tag: 'SessionStarted', sessionId: 'fixture' }
      await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
      yield { _tag: 'TurnCompleted' }
    },
  })
  const error = new Error('Fixture storage failure')
  vi.spyOn(store, 'renewProviderStart').mockImplementation(() => {
    if (failure === 'store-error')
      throw error
    return false
  })
  const first = start('first')
  await first.next()
  const pending = first.next()
  const rejected = expect(pending).rejects.toThrow(failure === 'store-error' ? error : 'reservation was lost')
  await vi.advanceTimersByTimeAsync(40_000)
  await rejected
  expect(providerSignal?.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  expect(store.listProviderCircuits()[0]).toMatchObject({ failures: 3, state: { _tag: 'Open' } })
})

it('stops renewal when an iterator closes while waiting for provider output', async () => {
  const waiting = Promise.withResolvers<void>()
  const { store, controller, start } = fixture({
    name: 'codex',
    async* runTurn(request) {
      yield { _tag: 'SessionStarted', sessionId: 'fixture' }
      await new Promise<void>((resolve) => {
        request.signal.addEventListener('abort', () => resolve(), { once: true })
        waiting.resolve()
      })
    },
  })
  const first = start('first')
  await first.next()
  const pending = first.next()
  await waiting.promise
  const closed = first.return?.()
  try {
    expect(vi.getTimerCount()).toBe(0)
    await pending
    await closed
    expect(store.listProviderCircuits()[0]).toMatchObject({ failures: 3, state: { _tag: 'Open' } })
  }
  finally {
    controller.abort()
    await pending
    await closed
  }
})

it.each(['return', 'abort', 'failure', 'throw', 'host-failure'] as const)('stops renewal after %s without claiming success', async (ending) => {
  const { store, key, controller, start } = fixture({
    name: 'codex',
    async* runTurn(): AsyncGenerator<AgentEvent> {
      yield { _tag: 'SessionStarted', sessionId: 'fixture' }
      if (ending === 'throw')
        throw new Error('Fixture network failure')
      yield { _tag: 'Failed', reason: 'Fixture network failure', ...(ending === 'host-failure' ? { cause: 'host-cancelled' as const } : {}) }
    },
  })
  const first = start('first')
  await first.next()
  if (ending === 'abort')
    controller.abort()
  else if (ending === 'return')
    await first.return?.()
  else
    await first.next()
  expect(vi.getTimerCount()).toBe(0)
  await first.return?.()
  await vi.advanceTimersByTimeAsync(121_000)
  expect(store.listProviderCircuits()[0]?.state._tag).toBe('Open')
  const later = store.reserveProviderStart({ ...key, workerId: 'later', at: new Date(Date.now() + 300_000).toISOString(), leaseMilliseconds: 120_000 })
  expect(later._tag).toBe('Allowed')
})
