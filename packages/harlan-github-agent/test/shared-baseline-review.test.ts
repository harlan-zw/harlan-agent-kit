import { afterEach, describe, expect, it } from 'vitest'
import { createAgentPermitPool } from '../src/agent-permit-pool.ts'
import { ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { createWorkerTaskScheduler } from '../src/worker-task-scheduler.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
afterEach(() => stores.splice(0).forEach(store => store.close()))
const at = (second: number) => new Date(Date.parse('2026-09-08T04:00:00Z') + second * 1000).toISOString()

function setup() {
  const store = openJournalStore(':memory:')
  stores.push(store)
  store.syncRepositories([repositoryMapping(), repositoryMapping({ github: 'harlan-zw/other' })], at(0))
  return store
}

function review(store: ReturnType<typeof openJournalStore>, number: number, baseSha = 'base123', repository = 'harlan-zw/example') {
  store.recordObservation({ externalId: `${repository}-${number}-${baseSha}`, observedAt: at(1), source: 'poll', subject: pullRequestItem({ number, repository, baseSha, mergeState: 'clean' }) })
  const task = store.claimNextAdversarialReviewTask('reviewer', at(2), 600_000)!
  const baseline = store.queueBaselineRepairForReview({ taskId: task.id, workerId: 'reviewer', fence: task.state.fence, at: at(3), baseSha })
  if (baseline._tag !== 'Queued' && baseline._tag !== 'Existing')
    throw new Error('Expected Baseline repair.')
  return { task, baseline }
}

describe('shared Baseline repair completion', () => {
  it('lets two pull requests wait for one repair of the same repository and base commit', () => {
    const store = setup()
    const first = review(store, 24)
    const second = review(store, 25)
    expect(second.baseline).toEqual({ _tag: 'Existing', taskId: first.baseline.taskId })

    for (const { task, baseline } of [first, second]) {
      expect(store.completeReviewTask({ taskId: task.id, workerId: 'reviewer', fence: task.state.fence, at: at(4), evidence: 'Waiting for Baseline repair.', resolution: { _tag: 'WaitingForBaselineRepair', taskId: baseline.taskId } })).toBe(true)
    }
    expect(store.getDashboardSnapshot(at(5)).tasks.filter(task => task.kind === 'adversarial_review').map(task => task.state._tag)).toEqual(['Completed', 'Completed'])
    expect(store.isSafeToRestart(at(5))).toBe(true)
  })

  it.each([
    ['another repository', 'base123', 'harlan-zw/other'],
    ['another base commit', 'changed-base', 'harlan-zw/example'],
  ])('rejects a repair for %s', (_label, baseSha, repository) => {
    const store = setup()
    const first = review(store, 24)
    const second = review(store, 25, baseSha, repository)

    expect(() => store.completeReviewTask({ taskId: second.task.id, workerId: 'reviewer', fence: second.task.state.fence, at: at(4), evidence: 'Waiting for Baseline repair.', resolution: { _tag: 'WaitingForBaselineRepair', taskId: first.baseline.taskId } })).toThrow('different Baseline repair Task')
  })

  it('settles the owned lease when completion throws so a restart can proceed', async () => {
    const store = setup()
    store.recordObservation({ externalId: 'review', observedAt: at(1), source: 'poll', subject: pullRequestItem({ mergeState: 'clean' }) })
    const error = new Error('The Review resolution references a different Baseline repair Task.')
    const errors: unknown[] = []
    const scheduler = createWorkerTaskScheduler({
      claim: store.claimNextAdversarialReviewTask,
      complete: () => { throw error },
      fail: store.failWorkerTask,
      heartbeat: store.heartbeatWorkerTask,
      intervalMilliseconds: 60_000,
      leaseMilliseconds: 45 * 60_000,
      now: () => new Date(at(2)),
      onError: error => errors.push(error),
      permits: createAgentPermitPool(1),
      worker: { run: async () => ok({ evidence: 'Waiting for Baseline repair.' }) },
      workerId: 'reviewer',
    })

    await scheduler.runNow()

    expect(errors).toEqual([error])
    expect(store.isSafeToRestart(at(3))).toBe(true)
    expect(store.getDashboardSnapshot(at(3)).tasks[0]?.state._tag).not.toBe('Running')
    await scheduler.stop()
  })
})
