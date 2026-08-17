import type { ClaimedAdversarialReviewTask } from '../src/types.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPermitPool } from '../src/agent-permit-pool.ts'
import { err } from '../src/result.ts'
import { createWorkerTaskScheduler } from '../src/worker-task-scheduler.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

afterEach(() => vi.useRealTimers())

describe('agent task scheduler', () => {
  it('does not claim new work while agents are paused', async () => {
    const claim = vi.fn(() => null)
    const worker = { run: vi.fn() }
    const scheduler = createWorkerTaskScheduler({
      canClaim: () => false,
      claim,
      complete: () => false,
      fail: () => 'Rejected',
      heartbeat: () => false,
      intervalMilliseconds: 60_000,
      leaseMilliseconds: 45 * 60_000,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      onError: (error) => { throw error },
      permits: createAgentPermitPool(1),
      worker,
      workerId: 'review-1',
    })

    await scheduler.runNow()

    expect(claim).not.toHaveBeenCalled()
    expect(worker.run).not.toHaveBeenCalled()
    await scheduler.stop()
  })

  it('stops an agent within five seconds after its task is revoked', async () => {
    vi.useFakeTimers()
    const task: ClaimedAdversarialReviewTask = {
      id: 'review-task',
      kind: 'adversarial_review',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'review-1', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: repositoryMapping(),
      pullRequest: pullRequestItem(),
      rerun: { _tag: 'NotRequested' },
    }
    let stopped = false
    const failures: string[] = []
    const scheduler = createWorkerTaskScheduler({
      claim: () => task,
      complete: () => false,
      fail: (input) => {
        failures.push(input.reason)
        return 'Rejected'
      },
      heartbeat: () => false,
      intervalMilliseconds: 60_000,
      leaseMilliseconds: 45 * 60_000,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      onError: (error) => { throw error },
      permits: createAgentPermitPool(1),
      worker: {
        run: (_task, signal) => new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            stopped = true
            resolve(err('The pull request closed.'))
          }, { once: true })
        }),
      },
      workerId: 'review-1',
    })

    const running = scheduler.runNow()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await running

    expect(stopped).toBe(true)
    expect(failures).toEqual([])
    await scheduler.stop()
  })

  it('fails the claimed task when an agent throws', async () => {
    const task: ClaimedAdversarialReviewTask = {
      id: 'review-task',
      kind: 'adversarial_review',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'review-1', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: repositoryMapping(),
      pullRequest: pullRequestItem(),
      rerun: { _tag: 'NotRequested' },
    }
    const failures: string[] = []
    const errors: unknown[] = []
    const scheduler = createWorkerTaskScheduler({
      claim: () => task,
      complete: () => false,
      fail: (input) => {
        failures.push(input.reason)
        return 'Retrying'
      },
      heartbeat: () => true,
      intervalMilliseconds: 60_000,
      leaseMilliseconds: 45 * 60_000,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      onError: error => errors.push(error),
      permits: createAgentPermitPool(1),
      worker: { run: () => Promise.reject(new Error('Codex process exited.')) },
      workerId: 'review-1',
    })

    await scheduler.runNow()

    expect(failures).toEqual(['Codex process exited.'])
    expect(errors).toEqual([expect.objectContaining({ message: 'Codex process exited.' })])
    await scheduler.stop()
  })
})
