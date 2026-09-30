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

  it.each([
    { headSha: 'new-head' },
    { body: 'Updated description' },
    { baseRef: 'feature/parent', baseSha: 'parent-head' },
    { state: 'closed' as const },
    { state: 'closed' as const, mergedAt: at(4) },
  ])('keeps repository Baseline repair claimable when its trigger changes: %j', (change) => {
    const store = setup()
    const { baseline } = review(store, 24)
    store.recordObservation({ externalId: 'changed-trigger', observedAt: at(4), source: 'poll', subject: pullRequestItem({ number: 24, mergeState: 'clean', ...change, updatedAt: at(4) }) })
    const repair = store.claimNextBaselineRepairTask('baseline', at(5), 600_000)
    expect(repair?.id).toBe(baseline.taskId)
    expect(repair?.pullRequest.baseSha).toBe('base123')
    expect(store.completeTask({ taskId: repair!.id, workerId: 'baseline', fence: repair!.state.fence, at: at(6), evidence: 'Existing repair' })).toBe(true)
  })

  it('keeps a running Baseline repair publishable after its trigger closes', () => {
    const store = setup()
    const { baseline } = review(store, 24)
    const repair = store.claimNextBaselineRepairTask('baseline', at(4), 600_000)!
    store.recordObservation({ externalId: 'closed-trigger', observedAt: at(5), source: 'poll', subject: pullRequestItem({ number: 24, mergeState: 'clean', state: 'closed', updatedAt: at(5) }) })
    const staged = store.stagePublication({ taskId: baseline.taskId, workerId: 'baseline', fence: repair.state.fence, at: at(6), publication: {
      _tag: 'OpenPullRequest',
      taskKind: 'baseline_repair',
      pullRequestNumber: 24,
      pullRequestTitle: 'fix: repair baseline',
      pullRequestBody: 'Repair default branch CI.',
      commitSha: 'repair-commit',
      baseSha: 'base123',
      baseRef: 'main',
      expectedHeadSha: 'base123',
      headRef: 'fix/baseline-ci-base123',
      artifactRef: 'artifact',
      patchDigest: 'digest',
      changedFiles: 1,
    } })
    expect(staged._tag).toBe('Staged')
    const publication = store.claimNextPublication('publisher', at(7), 600_000)!
    expect(publication?.taskId).toBe(baseline.taskId)
    expect(store.authorizePublication({ commandId: publication.id, workerId: 'publisher', fence: publication.fence, at: at(8) })).toBe(true)
    expect(store.completePublication({ commandId: publication.id, workerId: 'publisher', fence: publication.fence, at: at(9), pullRequestNumber: 26, evidence: 'Opened repair' })).toBe(true)
  })

  it.each(['cancel', 'dismiss', 'policy'] as const)('keeps %s as a fence after its trigger changes', (fence) => {
    const store = setup()
    const { baseline } = review(store, 24)
    const repair = store.claimNextBaselineRepairTask('baseline', at(4), 600_000)!
    store.recordObservation({ externalId: 'changed-trigger', observedAt: at(5), source: 'poll', subject: pullRequestItem({ number: 24, mergeState: 'clean', headSha: 'new-head', updatedAt: at(5) }) })
    if (fence === 'cancel')
      store.cancelTask({ taskId: baseline.taskId, at: at(6) })
    if (fence === 'dismiss')
      store.dismissItem({ repository: repair.repository, itemNumber: 24, at: at(6) })
    if (fence === 'policy')
      store.syncRepositories([repositoryMapping({ pullRequestReview: false })], at(6))
    expect(store.heartbeatTask({ taskId: repair.id, workerId: 'baseline', fence: repair.state.fence, at: at(7), leaseMilliseconds: 600_000 })).toBe(false)
  })

  it('replaces a running failure when another Item reports a new default branch failure', () => {
    const store = setup()
    const first = review(store, 24)
    const repair = store.claimNextBaselineRepairTask('baseline', at(4), 600_000)!
    review(store, 25, 'new-default')
    expect(store.heartbeatTask({ taskId: first.baseline.taskId, workerId: 'baseline', fence: repair.state.fence, at: at(5), leaseMilliseconds: 600_000 })).toBe(false)
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
