import type { RestartRequest } from '../src/types.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveAgentStartState } from '../src/capacity.ts'
import { createRestartController } from '../src/restart-request.ts'
import { openJournalStore } from '../src/store.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []
const directories: string[] = []

afterEach(() => {
  vi.useRealTimers()
  stores.splice(0).forEach(store => store.close())
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
})

function createStore() {
  const store = openJournalStore(':memory:')
  stores.push(store)
  return store
}

describe('restart request', () => {
  it('stops new Task claims without changing Pause', () => {
    const state = resolveAgentStartState({
      mutationsEnabled: true,
      agentControl: { _tag: 'Running' },
      restartRequest: {
        _tag: 'Requested',
        id: 'restart-1',
        source: 'dashboard',
        requestedAt: '2026-08-29T01:00:00.000Z',
      },
      agentSelection: { _tag: 'FollowsConfiguration' },
      providerCapacities: [],
    })

    expect(state).toEqual({ _tag: 'RestartRequested' })
  })

  it('keeps one active request when two clients ask', () => {
    const store = createStore()

    const first = store.requestRestart({
      id: 'restart-1',
      source: 'dashboard',
      at: '2026-08-29T01:00:00.000Z',
    })
    const duplicate = store.requestRestart({
      id: 'restart-2',
      source: 'tray',
      at: '2026-08-29T01:00:01.000Z',
    })

    expect(first).toEqual({
      _tag: 'Requested',
      id: 'restart-1',
      source: 'dashboard',
      requestedAt: '2026-08-29T01:00:00.000Z',
    })
    expect(duplicate).toEqual(first)
  })

  it('uses insertion order when the system clock moves backwards', () => {
    const store = createStore()
    store.requestRestart({
      id: 'restart-1',
      source: 'dashboard',
      at: '2026-08-29T01:00:00.000Z',
    })
    store.beginRestart({
      id: 'restart-1',
      processId: 'old-process',
      at: '2026-08-29T01:00:01.000Z',
    })
    store.completeRestart('2026-08-29T01:00:02.000Z')

    const latest = store.requestRestart({
      id: 'restart-2',
      source: 'tray',
      at: '2026-08-29T00:59:00.000Z',
    })

    expect(store.getRestartRequest()).toEqual(latest)
  })

  it('continues an accepted request after the process disappears', () => {
    const directory = mkdtempSync(join(tmpdir(), 'harlan-restart-request-'))
    directories.push(directory)
    const path = join(directory, 'state.sqlite')
    const firstProcess = openJournalStore(path)
    firstProcess.requestRestart({
      id: 'restart-1',
      source: 'helper',
      at: '2026-08-29T01:00:00.000Z',
    })
    firstProcess.close()

    const nextProcess = openJournalStore(path)
    stores.push(nextProcess)

    expect(nextProcess.getRestartRequest()).toEqual({
      _tag: 'Requested',
      id: 'restart-1',
      source: 'helper',
      requestedAt: '2026-08-29T01:00:00.000Z',
    })
  })

  it('preserves manual Pause across a completed restart', () => {
    const store = createStore()
    store.pauseAgents('2026-08-29T01:00:00.000Z')
    store.requestRestart({
      id: 'restart-1',
      source: 'helper',
      at: '2026-08-29T01:00:01.000Z',
    })

    store.beginRestart({
      id: 'restart-1',
      processId: 'old-process',
      at: '2026-08-29T01:00:02.000Z',
    })
    const completed = store.completeRestart('2026-08-29T01:00:03.000Z')

    expect(completed).toEqual({
      _tag: 'Completed',
      id: 'restart-1',
      source: 'helper',
      requestedAt: '2026-08-29T01:00:01.000Z',
      restartingAt: '2026-08-29T01:00:02.000Z',
      completedAt: '2026-08-29T01:00:03.000Z',
    })
    expect(store.getAgentControl()).toEqual({
      _tag: 'Paused',
      pausedAt: '2026-08-29T01:00:00.000Z',
    })
  })

  it('finishes active work before asking the process to stop', async () => {
    vi.useFakeTimers()
    let safe = false
    let request: RestartRequest = {
      _tag: 'Requested' as const,
      id: 'restart-1',
      source: 'dashboard' as const,
      requestedAt: '2026-08-29T01:00:00.000Z',
    }
    const controller = createRestartController({
      processId: 'old-process',
      now: () => new Date('2026-08-29T01:00:10.000Z'),
      intervalMilliseconds: 1_000,
      maximumWaitMilliseconds: 50 * 60_000,
      store: {
        getRestartRequest: () => request,
        prepareForRestart: () => safe,
        beginRestart(input) {
          request = {
            _tag: 'Restarting',
            id: request.id,
            source: request.source,
            requestedAt: request.requestedAt,
            restartingAt: input.at,
          }
          return request
        },
        requireRestartAction: () => null,
      },
      onActionRequired: vi.fn(),
    })

    controller.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(request._tag).toBe('Requested')

    safe = true
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(controller.waitForRestart()).resolves.toBeUndefined()
    expect(request).toEqual({
      _tag: 'Restarting',
      id: 'restart-1',
      source: 'dashboard',
      requestedAt: '2026-08-29T01:00:00.000Z',
      restartingAt: '2026-08-29T01:00:10.000Z',
    })
    controller.stop()
  })

  it('requires action instead of stopping a long-running Agent', async () => {
    vi.useFakeTimers()
    const actionRequired = vi.fn()
    let request: RestartRequest = {
      _tag: 'Requested' as const,
      id: 'restart-1',
      source: 'dashboard' as const,
      requestedAt: '2026-08-29T01:00:00.000Z',
    }
    const controller = createRestartController({
      processId: 'old-process',
      now: () => new Date('2026-08-29T01:50:01.000Z'),
      intervalMilliseconds: 1_000,
      maximumWaitMilliseconds: 50 * 60_000,
      store: {
        getRestartRequest: () => request,
        prepareForRestart: () => false,
        beginRestart: () => null,
        requireRestartAction(input) {
          request = {
            _tag: 'ActionRequired',
            id: request.id,
            source: request.source,
            requestedAt: request.requestedAt,
            actionRequiredAt: input.at,
            reason: input.reason,
          }
          return request
        },
      },
      onActionRequired: actionRequired,
    })

    controller.start()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(request).toEqual({
      _tag: 'ActionRequired',
      id: 'restart-1',
      source: 'dashboard',
      requestedAt: '2026-08-29T01:00:00.000Z',
      actionRequiredAt: '2026-08-29T01:50:01.000Z',
      reason: 'Active work did not finish within 50 minutes.',
    })
    expect(actionRequired).toHaveBeenCalledWith('Active work did not finish within 50 minutes.')
    controller.stop()
  })
})
