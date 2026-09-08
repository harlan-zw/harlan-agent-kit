import { afterEach, expect, it, vi } from 'vitest'
import { createAgentPermitPool } from '../src/agent-permit-pool.ts'
import { createBatchScheduler } from '../src/batch-scheduler.ts'
import { ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { issueItem, pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
const earlier = '2026-09-08T00:00:00.000Z'
const later = '2026-09-08T00:01:00.000Z'
const priority = 'harlan-zw/melbjs-clone'

afterEach(() => stores.splice(0).forEach(store => store.close()))

function setup(mutationsEnabled = false) {
  const store = openJournalStore(':memory:', mutationsEnabled)
  stores.push(store)
  store.syncRepositories([
    repositoryMapping(),
    repositoryMapping({ github: priority, priority: 100 }),
  ], earlier)
  store.setRepositoryWritesEnabled('harlan-zw/example', true)
  store.setRepositoryWritesEnabled(priority, true)
  return store
}

function readyIssues(store: ReturnType<typeof openJournalStore>, repository: string, observedAt: string, numbers = [101, 102]) {
  for (const number of numbers) {
    store.recordObservation({
      externalId: `${repository}-${number}`,
      observedAt,
      source: 'poll',
      subject: issueItem({ repository, number, author: 'harlan-zw' }),
    })
    const task = store.claimNextIssueTriageTask('triage', observedAt, 60_000)
    if (task === null)
      throw new Error('Expected issue triage.')
    store.completeWorkerTask({
      taskId: task.id,
      workerId: 'triage',
      fence: task.state.fence,
      at: observedAt,
      evidence: JSON.stringify({ _tag: 'READY_TO_IMPLEMENT', difficulty: 1, impact: 3, hasReproduction: true, needsCodebaseReview: false, summary: 'Fix the issue.', nextAction: 'Apply the fix.', relatedIssues: [] }),
    })
  }
}

it('claims newer priority issues before older background issues', () => {
  const store = setup()
  store.recordObservation({ externalId: 'background', observedAt: earlier, source: 'poll', subject: issueItem() })
  store.recordObservation({ externalId: 'priority', observedAt: later, source: 'poll', subject: issueItem({ repository: priority }) })

  expect(store.claimNextIssueTriageTask('first', later, 60_000)?.repository).toBe(priority)
  expect(store.claimNextIssueTriageTask('second', later, 60_000)?.repository).toBe('harlan-zw/example')
})

it('gives priority issues the next permit before background conflict work', () => {
  const store = setup()
  store.recordObservation({ externalId: 'background', observedAt: earlier, source: 'poll', subject: pullRequestItem() })
  store.recordObservation({ externalId: 'priority', observedAt: later, source: 'poll', subject: issueItem({ repository: priority }) })

  expect(store.claimNextConflictTask('background', later, 60_000)).toBeNull()
  expect(store.claimNextIssueTriageTask('priority', later, 60_000)?.repository).toBe(priority)
  expect(store.claimNextConflictTask('background', later, 60_000)?.repository).toBe('harlan-zw/example')
})

it('lets background work run while a priority repository is paused', () => {
  const store = setup()
  store.recordObservation({ externalId: 'background', observedAt: earlier, source: 'poll', subject: issueItem() })
  store.recordObservation({ externalId: 'priority', observedAt: later, source: 'poll', subject: issueItem({ repository: priority }) })
  store.setRepositoryPaused(priority, true)

  expect(store.claimNextIssueTriageTask('background', later, 60_000)?.repository).toBe('harlan-zw/example')
})

it('claims a newer priority batch before an older background batch', () => {
  const store = setup()
  readyIssues(store, 'harlan-zw/example', earlier)
  store.planBatches(earlier)
  readyIssues(store, priority, later)
  store.planBatches(later)

  expect(store.claimNextBatch('first', later, 60_000)?.repository).toBe(priority)
  expect(store.claimNextBatch('second', later, 60_000)?.repository).toBe('harlan-zw/example')
})

it('gives queued priority batches the next permit before background work across roles', () => {
  const store = setup()
  readyIssues(store, 'harlan-zw/example', earlier, [101])
  readyIssues(store, priority, later)
  store.planBatches(later)
  store.recordObservation({ externalId: 'conflict', observedAt: later, source: 'poll', subject: pullRequestItem() })
  store.recordObservation({ externalId: 'triage', observedAt: later, source: 'poll', subject: issueItem() })

  expect(store.hasPriorityAgentTask()).toBe(true)
  expect(store.claimNextConflictTask('conflict', later, 60_000)).toBeNull()
  expect(store.claimNextIssueTriageTask('triage', later, 60_000)).toBeNull()
  expect(store.claimNextIssueWorkTask('issue', later, 60_000)).toBeNull()
  expect(store.claimNextBatch('batch', later, 60_000)?.repository).toBe(priority)
  expect(store.claimNextConflictTask('conflict', later, 60_000)?.repository).toBe('harlan-zw/example')
  expect(store.claimNextIssueWorkTask('issue', later, 60_000)?.repository).toBe('harlan-zw/example')
})

it.each(['paused', 'capped', 'writes disabled'] as const)('lets background work run when a priority batch is %s', (blocked) => {
  const store = setup(true)
  readyIssues(store, priority, earlier)
  store.planBatches(earlier)
  if (blocked === 'paused')
    store.setRepositoryPaused(priority, true)
  else if (blocked === 'writes disabled')
    store.setRepositoryWritesEnabled(priority, false)
  else
    store.syncRepositories([repositoryMapping(), repositoryMapping({ github: priority, priority: 100, maxOpenPullRequests: 0 })], later)
  store.recordObservation({ externalId: 'triage', observedAt: later, source: 'poll', subject: issueItem() })

  expect(store.hasPriorityAgentTask()).toBe(false)
  expect(store.claimNextIssueTriageTask('triage', later, 60_000)?.repository).toBe('harlan-zw/example')
})

it('keeps background batches queued while higher priority issue triage waits', () => {
  const store = setup()
  readyIssues(store, 'harlan-zw/example', earlier)
  store.planBatches(earlier)
  store.recordObservation({ externalId: 'priority', observedAt: later, source: 'poll', subject: issueItem({ repository: priority }) })

  expect(store.claimNextBatch('batch', later, 60_000)).toBeNull()
  expect(store.claimNextIssueTriageTask('triage', later, 60_000)?.repository).toBe(priority)
  expect(store.claimNextBatch('batch', later, 60_000)?.repository).toBe('harlan-zw/example')
})

it('lets an active batch start its next unit when higher priority work arrives', () => {
  const store = setup()
  readyIssues(store, 'harlan-zw/example', earlier)
  store.planBatches(earlier)
  const batch = store.claimNextBatch('batch', earlier, 600_000)
  if (batch === null)
    throw new Error('Expected a batch.')
  const plan = store.recordBatchPlan({
    batchId: batch.id,
    workerId: 'batch',
    fence: batch.state.fence,
    at: earlier,
    units: [{ issueNumbers: [101, 102], dependsOn: null, rationale: 'One fix covers both issues.' }],
  })
  if (plan._tag === 'Err' || plan.value[0] === undefined)
    throw new Error('Expected a batch unit.')
  store.recordObservation({ externalId: 'priority', observedAt: later, source: 'poll', subject: issueItem({ repository: priority }) })

  expect(store.claimBatchUnitTask({ unitId: plan.value[0].id, workerId: 'batch', now: later, leaseMilliseconds: 60_000 })?.issueNumber).toBe(101)
  expect(store.claimNextIssueTriageTask('triage', later, 60_000)?.repository).toBe(priority)
})

it('uses a free permit for a priority batch while a background batch keeps running', async () => {
  const store = setup()
  const permits = createAgentPermitPool(2)
  const errors: unknown[] = []
  const running: Array<{ repository: string, signal: AbortSignal }> = []
  let release = () => {}
  const finished = new Promise<void>((resolve) => {
    release = resolve
  })
  const schedulers = ['first', 'second'].map(workerId => createBatchScheduler({
    canClaim: () => true,
    intervalMilliseconds: 5_000,
    leaseMilliseconds: 60_000,
    now: () => new Date(later),
    onError: error => errors.push(error),
    permits,
    store,
    workerId,
    worker: {
      async run(batch, signal) {
        running.push({ repository: batch.repository, signal })
        await finished
        return ok({ units: batch.issues.length })
      },
    },
  }))
  const executions: Promise<void>[] = []
  try {
    readyIssues(store, 'harlan-zw/example', earlier)
    store.planBatches(earlier)
    executions.push(schedulers[0]!.runNow())
    await vi.waitFor(() => expect(running.map(batch => batch.repository)).toEqual(['harlan-zw/example']))
    readyIssues(store, priority, later)
    store.planBatches(later)
    executions.push(schedulers[1]!.runNow())

    await vi.waitFor(() => expect(running.map(batch => batch.repository)).toEqual(['harlan-zw/example', priority]))
    expect(running.map(batch => batch.signal.aborted)).toEqual([false, false])
    expect(permits.tryAcquire()).toBeNull()
  }
  finally {
    release()
    await Promise.all(executions)
    await Promise.all(schedulers.map(scheduler => scheduler.stop()))
  }
  expect(errors).toEqual([])
})
