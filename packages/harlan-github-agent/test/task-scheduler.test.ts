import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPermitPool } from '../src/agent-permit-pool.ts'
import { err, ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { createTaskScheduler } from '../src/task-scheduler.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

afterEach(() => vi.useRealTimers())

describe('task scheduler', () => {
  it('does not claim new work while agents are paused', async () => {
    const claim = vi.fn(() => null)
    const worker = { run: vi.fn() }
    const scheduler = createTaskScheduler({
      canClaim: () => false,
      claim,
      intervalMilliseconds: 60_000,
      leaseMilliseconds: 10_000,
      now: () => new Date('2026-08-13T02:00:00.000Z'),
      onError: (error) => { throw error },
      permits: createAgentPermitPool(1),
      store: openJournalStore(':memory:'),
      worker,
      workerId: 'worker-1',
    })

    await scheduler.runNow()

    expect(claim).not.toHaveBeenCalled()
    expect(worker.run).not.toHaveBeenCalled()
    await scheduler.stop()
  })

  it('stages a durable publication after conflict work', async () => {
    const store = openJournalStore(':memory:')
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'conflicting',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })
    const scheduler = createTaskScheduler({
      intervalMilliseconds: 60_000,
      leaseMilliseconds: 10_000,
      now: () => new Date('2026-08-13T02:00:00.000Z'),
      onError: (error) => { throw error },
      permits: createAgentPermitPool(1),
      store,
      worker: {
        run: () => Promise.resolve(ok({
          _tag: 'Publish',
          publication: {
            _tag: 'UpdatePullRequest',
            taskKind: 'resolve_conflict',
            pullRequestNumber: 24,
            commitSha: 'commit123',
            baseSha: 'base123',
            expectedHeadSha: 'abc123',
            headRef: 'fix/broken-thing',
            artifactRef: 'refs/harlan-github-agent/publications/task-1',
            patchDigest: 'patch123',
            changedFiles: 1,
          },
        })),
      },
      workerId: 'worker-1',
    })

    await scheduler.runNow()

    expect(store.getDashboardSnapshot('2026-08-13T02:00:00.000Z').tasks[0]?.state).toEqual({
      _tag: 'Publishing',
      commandId: expect.any(String),
    })
    await scheduler.stop()
    store.close()
  })

  it('completes a Task whose work the world already did', async () => {
    const store = openJournalStore(':memory:')
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'obsolete-conflict',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })
    const scheduler = createTaskScheduler({
      intervalMilliseconds: 60_000,
      leaseMilliseconds: 10_000,
      now: () => new Date('2026-08-13T02:00:00.000Z'),
      onError: (error) => { throw error },
      permits: createAgentPermitPool(1),
      store,
      worker: { run: () => Promise.resolve(ok({ _tag: 'Obsolete', evidence: 'The conflict resolved itself.' })) },
      workerId: 'worker-1',
    })

    await scheduler.runNow()

    expect(store.getDashboardSnapshot('2026-08-13T02:00:00.000Z').tasks[0]?.state)
      .toEqual({ _tag: 'Completed', evidence: 'The conflict resolved itself.' })
    await scheduler.stop()
    store.close()
  })

  it('returns a thrown Worker error to the durable Queue', async () => {
    const store = openJournalStore(':memory:')
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'throwing-conflict',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })
    const errors: unknown[] = []
    const scheduler = createTaskScheduler({
      intervalMilliseconds: 60_000,
      leaseMilliseconds: 10_000,
      now: () => new Date('2026-08-13T02:00:00.000Z'),
      onError: error => errors.push(error),
      permits: createAgentPermitPool(1),
      store,
      worker: { run: () => Promise.reject(new Error('Codex process exited.')) },
      workerId: 'worker-1',
    })

    await scheduler.runNow()

    expect(store.getDashboardSnapshot('2026-08-13T02:00:00.000Z').tasks[0]?.state._tag).toBe('Queued')
    expect(errors).toEqual([expect.objectContaining({ message: 'Codex process exited.' })])
    await scheduler.stop()
    store.close()
  })

  it('leaves an aborted task for restart recovery', async () => {
    const store = openJournalStore(':memory:')
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'stopped-conflict',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const scheduler = createTaskScheduler({
      intervalMilliseconds: 60_000,
      leaseMilliseconds: 10_000,
      now: () => new Date('2026-08-13T02:00:00.000Z'),
      onError: (error) => { throw error },
      permits: createAgentPermitPool(1),
      store,
      worker: {
        run: (_task, signal) => new Promise((resolve) => {
          markStarted?.()
          signal.addEventListener('abort', () => resolve(err('The operation was aborted')), { once: true })
        }),
      },
      workerId: 'worker-1',
    })

    void scheduler.runNow()
    await started
    await scheduler.stop()

    expect(store.getDashboardSnapshot('2026-08-13T02:00:00.000Z').tasks[0]?.state._tag).toBe('Running')
    store.close()
  })

  it('stops conflict work within five seconds after cancellation', async () => {
    vi.useFakeTimers()
    const store = openJournalStore(':memory:')
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'cancelled-running-conflict',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })
    let taskId: string | undefined
    let stopped = false
    const scheduler = createTaskScheduler({
      intervalMilliseconds: 60_000,
      leaseMilliseconds: 10 * 60_000,
      now: () => new Date('2026-08-13T02:00:00.000Z'),
      onError: (error) => { throw error },
      permits: createAgentPermitPool(1),
      store,
      worker: {
        run: (task, signal) => new Promise((resolve) => {
          taskId = task.id
          signal.addEventListener('abort', () => {
            stopped = true
            resolve(err('The operation was aborted'))
          }, { once: true })
        }),
      },
      workerId: 'worker-1',
    })

    const running = scheduler.runNow()
    await vi.advanceTimersByTimeAsync(0)
    if (taskId === undefined)
      throw new Error('Expected a running conflict task.')
    store.cancelTask({ taskId, at: '2026-08-13T02:00:01.000Z' })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await running

    expect(stopped).toBe(true)
    await scheduler.stop()
    store.close()
  })
})
