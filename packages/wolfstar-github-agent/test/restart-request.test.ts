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
  stores.splice(0).forEach((store) => store.close())
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})

function createStore() {
  const store = openJournalStore(':memory:')
  stores.push(store)
  return store
}

describe('restart request', () => {
  it('preserves Pending preparation after process replacement', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wolfstar-update-preparation-'))
    directories.push(directory)
    const path = join(directory, 'state.sqlite')
    const at = '2026-10-12T01:00:00.000Z'
    const first = openJournalStore(path)
    first.requestRestart({
      id: 'pending-update',
      source: 'helper',
      operation: { _tag: 'Update', targetCommit: 'a'.repeat(40), preparation: 'Pending' },
      at,
    })
    first.close()
    const next = openJournalStore(path)
    stores.push(next)
    expect(next.getRestartRequest()).toMatchObject({ _tag: 'Requested', operation: { preparation: 'Pending' } })
    expect(next.beginRestart({ id: 'pending-update', processId: 'next', at })).toBeNull()
    expect(next.finishUpdatePreparation({ id: 'pending-update', _tag: 'Ready', at })).toMatchObject({
      operation: { preparation: 'Ready' },
    })
    expect(next.finishUpdatePreparation({ id: 'pending-update', _tag: 'Ready', at })).toMatchObject({
      operation: { preparation: 'Ready' },
    })
  })

  it('blocks claims during Update file sync and waits for its exact preparation receipt', async () => {
    vi.useFakeTimers()
    const store = createStore()
    const at = '2026-10-12T01:00:00.000Z'
    store.requestRestart({
      id: 'preparing-update',
      source: 'helper',
      operation: { _tag: 'Update', targetCommit: 'a'.repeat(40), preparation: 'Pending' },
      at,
    })
    const prepareUpdate = vi.fn(async () => ({ _tag: 'Ok' as const, value: undefined }))
    const controller = createRestartController({
      store,
      processId: 'process',
      now: () => new Date(at),
      prepareUpdate,
      onActionRequired: vi.fn(),
      intervalMilliseconds: 1_000,
    })
    controller.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(prepareUpdate).not.toHaveBeenCalled()
    expect(store.beginRestart({ id: 'preparing-update', processId: 'wrong-process', at })).toBeNull()
    expect(store.finishUpdatePreparation({ id: 'wrong', _tag: 'Ready', at })).toBeNull()
    expect(store.finishUpdatePreparation({ id: 'preparing-update', _tag: 'Ready', at })).toMatchObject({
      operation: { preparation: 'Ready' },
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await controller.waitForRestart()
    expect(prepareUpdate).toHaveBeenCalledWith('a'.repeat(40))
    controller.stop()
  })

  it('releases a failed preparation without changing manual Pause', () => {
    const store = createStore()
    const at = '2026-10-12T01:00:00.000Z'
    store.requestRestart({
      id: 'failed-update',
      source: 'helper',
      operation: { _tag: 'Update', targetCommit: 'a'.repeat(40), preparation: 'Pending' },
      at,
    })
    store.pauseAgents(at)
    expect(
      store.finishUpdatePreparation({ id: 'failed-update', _tag: 'Failed', reason: 'File sync failed.', at }),
    ).toMatchObject({ _tag: 'ActionRequired', reason: 'File sync failed.' })
    expect(store.finishUpdatePreparation({ id: 'failed-update', _tag: 'Ready', at })).toBeNull()
    expect(store.getDashboardSnapshot(at).agentControl).toMatchObject({ _tag: 'Paused' })
  })

  it('waits for native Sessions before preparing an Update', async () => {
    vi.useFakeTimers()
    const store = createStore()
    store.requestRestart({
      id: 'session-update',
      source: 'dashboard',
      operation: { _tag: 'Update', targetCommit: 'a'.repeat(40), preparation: 'Ready' },
      at: '2026-08-29T01:00:00.000Z',
    })
    let ready = false
    const prepareUpdate = vi.fn(async () => ({ _tag: 'Ok' as const, value: undefined }))
    const controller = createRestartController({
      store,
      processId: 'session-process',
      now: () => new Date('2026-08-29T01:00:10.000Z'),
      ready: () => ready,
      prepareUpdate,
      onActionRequired: vi.fn(),
      intervalMilliseconds: 1_000,
    })
    controller.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(store.getRestartRequest()?._tag).toBe('Requested')
    expect(prepareUpdate).not.toHaveBeenCalled()
    ready = true
    await vi.advanceTimersByTimeAsync(1_000)
    await controller.waitForRestart()
    expect(store.getRestartRequest()?._tag).toBe('Restarting')
    expect(prepareUpdate).toHaveBeenCalledWith('a'.repeat(40))
    controller.stop()
  })

  it('stops new Task claims without changing Pause', () => {
    const state = resolveAgentStartState({
      mutationsEnabled: true,
      agentControl: { _tag: 'Running' },
      restartRequest: {
        _tag: 'Requested',
        id: 'restart-1',
        source: 'dashboard',
        operation: { _tag: 'Restart' },
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
      operation: { _tag: 'Restart' },
      at: '2026-08-29T01:00:00.000Z',
    })
    const duplicate = store.requestRestart({
      id: 'restart-2',
      source: 'tray',
      operation: { _tag: 'Restart' },
      at: '2026-08-29T01:00:01.000Z',
    })

    expect(first).toEqual({
      _tag: 'Requested',
      id: 'restart-1',
      source: 'dashboard',
      operation: { _tag: 'Restart' },
      requestedAt: '2026-08-29T01:00:00.000Z',
    })
    expect(duplicate).toEqual(first)
  })

  it('uses insertion order when the system clock moves backwards', () => {
    const store = createStore()
    store.requestRestart({
      id: 'restart-1',
      source: 'dashboard',
      operation: { _tag: 'Restart' },
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
      operation: { _tag: 'Restart' },
      at: '2026-08-29T00:59:00.000Z',
    })

    expect(store.getRestartRequest()).toEqual(latest)
  })

  it('keeps the pinned commit with an Update request', () => {
    const store = createStore()
    const targetCommit = 'b'.repeat(40)

    store.requestRestart({
      id: 'update-1',
      source: 'dashboard',
      operation: { _tag: 'Update', targetCommit, preparation: 'Ready' },
      at: '2026-09-02T03:00:00.000Z',
    })

    expect(store.getRestartRequest()).toMatchObject({
      _tag: 'Requested',
      operation: { _tag: 'Update', targetCommit, preparation: 'Ready' },
    })
  })

  it('continues an accepted request after the process disappears', () => {
    const directory = mkdtempSync(join(tmpdir(), 'wolfstar-restart-request-'))
    directories.push(directory)
    const path = join(directory, 'state.sqlite')
    const firstProcess = openJournalStore(path)
    firstProcess.requestRestart({
      id: 'restart-1',
      source: 'helper',
      operation: { _tag: 'Restart' },
      at: '2026-08-29T01:00:00.000Z',
    })
    firstProcess.close()

    const nextProcess = openJournalStore(path)
    stores.push(nextProcess)

    expect(nextProcess.getRestartRequest()).toEqual({
      _tag: 'Requested',
      id: 'restart-1',
      source: 'helper',
      operation: { _tag: 'Restart' },
      requestedAt: '2026-08-29T01:00:00.000Z',
    })
  })

  it('preserves manual Pause across a completed restart', () => {
    const store = createStore()
    store.pauseAgents('2026-08-29T01:00:00.000Z')
    store.requestRestart({
      id: 'restart-1',
      source: 'helper',
      operation: { _tag: 'Restart' },
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
      operation: { _tag: 'Restart' },
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
      operation: { _tag: 'Restart' as const },
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
            operation: request.operation,
            requestedAt: request.requestedAt,
            restartingAt: input.at,
          }
          return request
        },
        requireRestartAction: () => null,
      },
      onActionRequired: vi.fn(),
      prepareUpdate: () => Promise.resolve({ _tag: 'Ok', value: undefined }),
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
      operation: { _tag: 'Restart' },
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
      operation: { _tag: 'Restart' as const },
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
            operation: request.operation,
            requestedAt: request.requestedAt,
            actionRequiredAt: input.at,
            reason: input.reason,
          }
          return request
        },
      },
      onActionRequired: actionRequired,
      prepareUpdate: () => Promise.resolve({ _tag: 'Ok', value: undefined }),
    })

    controller.start()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(request).toEqual({
      _tag: 'ActionRequired',
      id: 'restart-1',
      source: 'dashboard',
      operation: { _tag: 'Restart' },
      requestedAt: '2026-08-29T01:00:00.000Z',
      actionRequiredAt: '2026-08-29T01:50:01.000Z',
      reason: 'Active work did not finish within 50 minutes.',
    })
    expect(actionRequired).toHaveBeenCalledWith('Active work did not finish within 50 minutes.')
    controller.stop()
  })

  it('prepares an Update after active work and before restart', async () => {
    vi.useFakeTimers()
    const targetCommit = 'b'.repeat(40)
    const prepareUpdate = vi.fn(() => Promise.resolve({ _tag: 'Ok' as const, value: undefined }))
    let request: RestartRequest = {
      _tag: 'Requested',
      id: 'update-1',
      source: 'dashboard',
      operation: { _tag: 'Update', targetCommit, preparation: 'Ready' },
      requestedAt: '2026-09-02T03:00:00.000Z',
    }
    const controller = createRestartController({
      processId: 'old-process',
      now: () => new Date('2026-09-02T03:00:10.000Z'),
      intervalMilliseconds: 1_000,
      store: {
        getRestartRequest: () => request,
        prepareForRestart: () => true,
        beginRestart(input) {
          request = { ...request, _tag: 'Restarting', restartingAt: input.at }
          return request
        },
        requireRestartAction: () => null,
      },
      prepareUpdate,
      onActionRequired: vi.fn(),
    })

    controller.start()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(prepareUpdate).toHaveBeenCalledWith(targetCommit)
    await expect(controller.waitForRestart()).resolves.toBeUndefined()
    expect(request._tag).toBe('Restarting')
    controller.stop()
  })
})
