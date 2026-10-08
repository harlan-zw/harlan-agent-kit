import { afterEach, expect, it, vi } from 'vitest'
import { createAgentPermitPool, createRoutinePermitPools } from '../src/agent-permit-pool.ts'
import { createBatchScheduler } from '../src/batch-scheduler.ts'
import { createBatchWorker } from '../src/batch-worker.ts'
import { ok } from '../src/result.ts'
import { canClaimRoutineRun } from '../src/service.ts'
import { openJournalStore } from '../src/store.ts'
import { createWorkerTaskScheduler } from '../src/worker-task-scheduler.ts'
import { issueItem, pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
const earlier = '2026-09-08T00:00:00.000Z'
const later = '2026-09-08T00:01:00.000Z'
const priority = 'harlan-zw/melbjs-clone'

afterEach(() => stores.splice(0).forEach(store => store.close()))

function setup(mutationsEnabled = false, maximumOpenPullRequests = 8) {
  const store = openJournalStore(':memory:', mutationsEnabled, undefined, maximumOpenPullRequests)
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
  store.recordObservation({ externalId: 'background', observedAt: earlier, source: 'poll', subject: issueItem({ author: 'harlan-zw' }) })
  store.recordObservation({ externalId: 'priority', observedAt: later, source: 'poll', subject: issueItem({ repository: priority, author: 'harlan-zw' }) })

  expect(store.claimNextIssueTriageTask('first', later, 60_000)?.repository).toBe(priority)
  expect(store.claimNextIssueTriageTask('second', later, 60_000)?.repository).toBe('harlan-zw/example')
})

it('gives Review the next claim before older Issue work and Issue triage', () => {
  const store = setup(true)
  readyIssues(store, priority, earlier, [101])
  store.recordObservation({ externalId: 'next-issue', observedAt: earlier, source: 'poll', subject: issueItem({ repository: priority, number: 102, author: 'harlan-zw' }) })
  store.recordObservation({ externalId: 'review', observedAt: later, source: 'poll', subject: pullRequestItem({ repository: priority, mergeState: 'clean' }) })

  expect(store.claimNextIssueWorkTask('implementation', later, 60_000)).toBeNull()
  expect(store.claimNextIssueTriageTask('triage', later, 60_000)).toBeNull()
  expect(store.claimNextAdversarialReviewTask('review', later, 60_000)?.pullRequestNumber).toBe(24)
  expect(store.claimNextIssueWorkTask('implementation', later, 60_000)?.issueNumber).toBe(101)
  expect(store.claimNextIssueTriageTask('triage', later, 60_000)?.issueNumber).toBe(102)
})

it('gives Conflict resolution the next claim before older Issue work', () => {
  const store = setup(true)
  readyIssues(store, priority, earlier, [101])
  store.recordObservation({ externalId: 'conflict', observedAt: later, source: 'poll', subject: pullRequestItem({ repository: priority, headRepository: priority }) })

  expect(store.claimNextIssueWorkTask('implementation', later, 60_000)).toBeNull()
  expect(store.claimNextConflictTask('conflict', later, 60_000)?.pullRequestNumber).toBe(24)
})

it('lets issue triage and implementation proceed after thirty minutes despite new reviews', () => {
  const store = setup(true)
  readyIssues(store, priority, earlier, [101])
  store.recordObservation({ externalId: 'next-issue', observedAt: earlier, source: 'poll', subject: issueItem({ repository: priority, number: 102, author: 'harlan-zw' }) })
  const afterWait = '2026-09-08T00:31:00.000Z'
  store.recordObservation({ externalId: 'review', observedAt: afterWait, source: 'poll', subject: pullRequestItem({ repository: priority, mergeState: 'clean' }) })

  expect(store.claimNextAdversarialReviewTask('review', afterWait, 60_000)).toBeNull()
  expect(store.claimNextIssueTriageTask('triage', afterWait, 60_000)?.issueNumber).toBe(102)
  expect(store.claimNextAdversarialReviewTask('review', afterWait, 60_000)).toBeNull()
  expect(store.claimNextIssueWorkTask('implementation', afterWait, 60_000)?.issueNumber).toBe(101)
  expect(store.claimNextAdversarialReviewTask('review', afterWait, 60_000)?.pullRequestNumber).toBe(24)
})

it('keeps a new Batch queued until Review takes its claim', () => {
  const store = setup(true)
  readyIssues(store, priority, earlier)
  store.planBatches(earlier)
  store.recordObservation({ externalId: 'review', observedAt: later, source: 'poll', subject: pullRequestItem({ repository: priority, mergeState: 'clean' }) })

  expect(store.claimNextBatch('batch', later, 60_000)).toBeNull()
  expect(store.claimNextAdversarialReviewTask('review', later, 60_000)?.pullRequestNumber).toBe(24)
  expect(store.claimNextBatch('batch', later, 60_000)?.repository).toBe(priority)
})

it('preserves overdue Issue age when planning a new Batch', () => {
  const store = setup(true)
  readyIssues(store, priority, earlier)
  const afterWait = '2026-09-08T00:31:00.000Z'
  store.planBatches(afterWait)
  store.recordObservation({ externalId: 'review', observedAt: afterWait, source: 'poll', subject: pullRequestItem({ repository: priority, mergeState: 'clean' }) })

  expect(store.claimNextBatch('batch', afterWait, 60_000)?.repository).toBe(priority)
  expect(store.claimNextAdversarialReviewTask('review', afterWait, 60_000)?.pullRequestNumber).toBe(24)
})

it('does not hold Issue work behind a Review that lacks Approval', () => {
  const store = setup(true)
  readyIssues(store, priority, earlier, [101])
  store.recordObservation({ externalId: 'unapproved-review', observedAt: later, source: 'poll', subject: pullRequestItem({ repository: priority, mergeState: 'clean', author: 'outside-contributor' }) })

  expect(store.claimNextAdversarialReviewTask('review', later, 60_000)).toBeNull()
  expect(store.claimNextIssueWorkTask('implementation', later, 60_000)?.issueNumber).toBe(101)
})

it('lets an older Batch claim a permit while fresh reviews wait', () => {
  const store = setup(true)
  readyIssues(store, priority, earlier)
  store.planBatches(earlier)
  const afterWait = '2026-09-08T00:31:00.000Z'
  store.recordObservation({ externalId: 'review', observedAt: afterWait, source: 'poll', subject: pullRequestItem({ repository: priority, mergeState: 'clean' }) })

  expect(store.claimNextAdversarialReviewTask('review', afterWait, 60_000)).toBeNull()
  expect(store.claimNextBatch('batch', afterWait, 60_000)?.repository).toBe(priority)
  expect(store.claimNextAdversarialReviewTask('review', afterWait, 60_000)?.pullRequestNumber).toBe(24)
})

it('keeps ordinary Review outside the repository priority override for Routines', () => {
  const store = setup(true)
  store.recordObservation({ externalId: 'review', observedAt: later, source: 'poll', subject: pullRequestItem({ mergeState: 'clean' }) })

  expect(store.hasPriorityAgentTask(later)).toBe(false)
  expect(store.claimNextAdversarialReviewTask('review', later, 60_000)?.pullRequestNumber).toBe(24)
})

it('gives priority issues the next permit before background conflict work', () => {
  const store = setup()
  store.recordObservation({ externalId: 'background', observedAt: earlier, source: 'poll', subject: pullRequestItem() })
  store.recordObservation({ externalId: 'priority', observedAt: later, source: 'poll', subject: issueItem({ repository: priority, author: 'harlan-zw' }) })

  expect(store.claimNextConflictTask('background', later, 60_000)).toBeNull()
  expect(store.claimNextIssueTriageTask('priority', later, 60_000)?.repository).toBe(priority)
  expect(store.claimNextConflictTask('background', later, 60_000)?.repository).toBe('harlan-zw/example')
})

it('lets background work run while a priority repository is paused', () => {
  const store = setup()
  store.recordObservation({ externalId: 'background', observedAt: earlier, source: 'poll', subject: issueItem({ author: 'harlan-zw' }) })
  store.recordObservation({ externalId: 'priority', observedAt: later, source: 'poll', subject: issueItem({ repository: priority, author: 'harlan-zw' }) })
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
  store.recordObservation({ externalId: 'triage', observedAt: later, source: 'poll', subject: issueItem({ author: 'harlan-zw' }) })

  expect(store.hasPriorityAgentTask(later)).toBe(true)
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
  store.recordObservation({ externalId: 'triage', observedAt: later, source: 'poll', subject: issueItem({ author: 'harlan-zw' }) })

  expect(store.hasPriorityAgentTask(later)).toBe(false)
  expect(store.claimNextIssueTriageTask('triage', later, 60_000)?.repository).toBe('harlan-zw/example')
})

it('keeps background batches queued while higher priority issue triage waits', () => {
  const store = setup()
  readyIssues(store, 'harlan-zw/example', earlier)
  store.planBatches(earlier)
  store.recordObservation({ externalId: 'priority', observedAt: later, source: 'poll', subject: issueItem({ repository: priority, author: 'harlan-zw' }) })

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
  store.recordObservation({ externalId: 'priority', observedAt: later, source: 'poll', subject: issueItem({ repository: priority, author: 'harlan-zw' }) })

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
        return ok({ _tag: 'Completed', units: batch.issues.length })
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

it('leaves permits for reviews when the global pull request limit already holds every batch', async () => {
  const store = setup(true, 1)
  readyIssues(store, 'harlan-zw/example', earlier)
  readyIssues(store, priority, earlier)
  store.planBatches(earlier)
  store.recordObservation({ externalId: 'open-review', observedAt: later, source: 'poll', subject: pullRequestItem({ controllerOwned: true, mergeState: 'clean' }) })
  const permits = createAgentPermitPool(2)
  const started: string[] = []
  const schedulers = ['first', 'second'].map(workerId => createBatchScheduler({
    canClaim: () => true,
    intervalMilliseconds: 5_000,
    leaseMilliseconds: 60_000,
    now: () => new Date(later),
    onError: (error) => { throw error },
    permits,
    store,
    workerId,
    worker: { run: async (batch) => {
      started.push(batch.repository)
      return ok({ _tag: 'Completed', units: 0 })
    } },
  }))
  await Promise.all(schedulers.map(scheduler => scheduler.runNow()))
  expect(started).toEqual([])
  const permit = permits.tryAcquire()
  expect(permit).not.toBeNull()
  expect(store.claimNextAdversarialReviewTask('review', later, 60_000)?.pullRequestNumber).toBe(24)
  permit?.release()
  await Promise.all(schedulers.map(scheduler => scheduler.stop()))
})

it.each(['capped', 'writes disabled'] as const)('skips a %s priority batch to claim an eligible background batch', (blocked) => {
  const store = setup(true)
  readyIssues(store, 'harlan-zw/example', earlier)
  readyIssues(store, priority, earlier)
  store.planBatches(earlier)
  if (blocked === 'capped')
    store.syncRepositories([repositoryMapping(), repositoryMapping({ github: priority, priority: 100, maxOpenPullRequests: 0 })], later)
  else
    store.setRepositoryWritesEnabled(priority, false)

  expect(store.claimNextBatch('batch', later, 60_000)?.repository).toBe('harlan-zw/example')
})

it('suspends idle batches at the pull request limit and resumes their remaining units after review', async () => {
  const store = setup(true, 1)
  readyIssues(store, 'harlan-zw/example', earlier)
  readyIssues(store, priority, earlier)
  store.planBatches(earlier)
  const permits = createAgentPermitPool(2)
  const errors: unknown[] = []
  const started: string[] = []
  const signals: AbortSignal[] = []
  const releases: Array<() => void> = []
  const schedulers = ['first', 'second'].map((workerId) => {
    const worker = createBatchWorker({
      canClaimIssueWork: () => store.countOpenPullRequests() < 1,
      github: { getIssueTriageSnapshot: () => Promise.reject(new Error('Single units need no combined issue.')) },
      issueWork: { run: async (task, signal) => {
        started.push(`${task.repository}#${task.issueNumber}`)
        signals.push(signal)
        if (task.issueNumber === 101)
          await new Promise<void>(resolve => releases.push(resolve))
        return ok({ _tag: 'ActionRequired', reason: 'The first unit needs input.', evidence: 'The remaining units can continue.' })
      } },
      leaseMilliseconds: 60_000,
      logger: { info: () => undefined, error: error => errors.push(error) },
      now: () => new Date(later),
      runtime: {} as never,
      store,
      unitConcurrency: 1,
      validateMapping: async mapping => ok(mapping),
      workerId,
      workspaces: { prepareBatch: () => Promise.reject(new Error('The existing plan needs no workspace.')) },
    })
    return createBatchScheduler({
      canClaim: () => true,
      intervalMilliseconds: 5_000,
      leaseMilliseconds: 60_000,
      now: () => new Date(later),
      onError: error => errors.push(error),
      permits,
      store,
      workerId,
      worker: { run: async (batch, signal) => {
        const plan = batch.units === null
          ? store.recordBatchPlan({
              batchId: batch.id,
              workerId,
              fence: batch.state.fence,
              at: later,
              units: batch.issues.map(issue => ({ issueNumbers: [issue.issueNumber], dependsOn: null, rationale: 'Independent fix.' })),
            })
          : ok(batch.units)
        if (plan._tag === 'Err')
          throw new Error(plan.error)
        return worker.run({ ...batch, units: plan.value }, signal)
      } },
    })
  })
  const running = schedulers.map(scheduler => scheduler.runNow())
  try {
    await vi.waitFor(() => expect(started).toHaveLength(2))
    store.recordObservation({ externalId: 'open-review', observedAt: later, source: 'poll', subject: pullRequestItem({ controllerOwned: true, mergeState: 'clean' }) })
    releases.forEach(release => release())
    await vi.waitFor(() => expect(store.listBatches().map(batch => batch.state._tag)).toEqual(['Queued', 'Queued']))
    await Promise.all(running)
    expect(started).toHaveLength(2)
    expect(signals.map(signal => signal.aborted)).toEqual([false, false])
    expect(store.listBatches().map(batch => batch.units?.map(unit => unit.state._tag))).toEqual([
      ['ActionRequired', 'Waiting'],
      ['ActionRequired', 'Waiting'],
    ])
    const reviewed: number[] = []
    const review = createWorkerTaskScheduler({
      claim: store.claimNextAdversarialReviewTask,
      complete: () => true,
      fail: () => 'Rejected',
      heartbeat: store.heartbeatWorkerTask,
      intervalMilliseconds: 5_000,
      leaseMilliseconds: 60_000,
      now: () => new Date(later),
      onError: error => errors.push(error),
      permits,
      worker: { run: async (task) => {
        reviewed.push(task.pullRequestNumber)
        return ok({ evidence: 'Reviewed.' })
      } },
      workerId: 'review',
    })
    await review.runNow()
    expect(reviewed).toEqual([24])
    await review.stop()
    store.recordObservation({ externalId: 'closed-review', observedAt: later, source: 'poll', subject: pullRequestItem({ controllerOwned: true, mergeState: 'clean', state: 'closed' }) })
    await Promise.all(schedulers.map(scheduler => scheduler.runNow()))
    expect(started.filter(task => task.endsWith('#101'))).toHaveLength(2)
    expect(started.filter(task => task.endsWith('#102'))).toHaveLength(2)
    expect(store.listBatches().map(batch => batch.state._tag)).toEqual(['Completed', 'Completed'])
    expect(errors).toEqual([])
  }
  finally {
    releases.forEach(release => release())
    await Promise.all(schedulers.map(scheduler => scheduler.stop()))
    await Promise.all(running)
  }
})

it.each([
  { triggers: ['routine'] as const, now: later, canClaim: true, expected: ['sentry-checkin'] },
  { triggers: ['github', 'routine'] as const, now: later, canClaim: true, expected: [] },
  { triggers: ['github', 'routine'] as const, now: '2026-09-08T00:29:59.999Z', canClaim: true, expected: [] },
  { triggers: ['github', 'routine'] as const, now: '2026-09-08T00:30:00.000Z', canClaim: true, expected: ['sentry-checkin'] },
  { triggers: ['github', 'routine'] as const, now: '2026-09-08T00:30:00.000Z', canClaim: false, expected: [] },
])('runs waiting routines despite priority work after thirty minutes: $triggers at $now, claims $canClaim', async ({ triggers, now, canClaim, expected }) => {
  const store = setup(true)
  store.recordObservation({ externalId: 'priority', observedAt: later, source: 'poll', subject: issueItem({ repository: priority, author: 'harlan-zw' }) })
  const [routine] = store.syncRoutines({ repository: 'harlan-zw/example', specSha: 'spec', entries: [{ name: 'sentry-checkin', crons: ['0 0 * * *'], timeZone: 'UTC', mode: 'report', enabled: true }], at: earlier })
  if (routine === undefined)
    throw new Error('Expected a Routine.')
  store.openRoutineRun({ routineId: routine.id, scheduledFor: earlier, specSha: 'spec', at: earlier })
  const started: string[] = []
  const scheduler = createWorkerTaskScheduler({
    canClaim: () => canClaimRoutineRun(canClaim, triggers, store, now),
    claim: store.claimNextRoutineRun,
    complete: store.completeRoutineRun,
    fail: store.failRoutineRun,
    heartbeat: store.heartbeatRoutineRun,
    intervalMilliseconds: 5_000,
    leaseMilliseconds: 60_000,
    now: () => new Date(now),
    onError: (error) => { throw error },
    permits: createAgentPermitPool(1),
    worker: { run: async (task) => {
      started.push(task.name)
      return ok({ evidence: 'Scan complete.' })
    } },
    workerId: 'routine',
  })
  await scheduler.runNow()
  expect(started).toEqual(expected)
  await scheduler.stop()
})

it.each([
  { enabled: true, repositoryEnabled: true, retired: false, openedAt: earlier, expected: true },
  { enabled: true, repositoryEnabled: true, retired: false, openedAt: later, expected: false },
  { enabled: false, repositoryEnabled: true, retired: false, openedAt: earlier, expected: false },
  { enabled: true, repositoryEnabled: false, retired: false, openedAt: earlier, expected: false },
  { enabled: true, repositoryEnabled: true, retired: true, openedAt: earlier, expected: false },
])('reserves only eligible Routine runs after thirty minutes in the queue: $enabled, $repositoryEnabled, $retired, $openedAt', ({ enabled, repositoryEnabled, retired, openedAt, expected }) => {
  const store = setup(true)
  store.syncRepositories([repositoryMapping({ enabled: repositoryEnabled })], earlier)
  const [routine] = store.syncRoutines({ repository: 'harlan-zw/example', specSha: 'spec', entries: [{ name: 'daily-checkin', crons: ['0 0 * * *'], timeZone: 'UTC', mode: 'report', enabled }], at: earlier })
  if (routine === undefined)
    throw new Error('Expected a Routine.')
  store.openRoutineRun({ routineId: routine.id, scheduledFor: earlier, specSha: 'spec', at: openedAt })
  if (retired)
    store.retireRoutines({ repository: 'harlan-zw/example', reason: 'Definition removed.', at: later })

  expect(store.hasOverdueRoutineRun('2026-09-08T00:30:00.000Z')).toBe(expected)
})

it('hands the next free permit to an overdue Routine before Review, then allows Review alongside it', async () => {
  const store = setup(true)
  const now = '2026-09-08T00:30:00.000Z'
  const [routine] = store.syncRoutines({ repository: 'harlan-zw/example', specSha: 'spec', entries: [{ name: 'daily-checkin', crons: ['0 0 * * *'], timeZone: 'UTC', mode: 'report', enabled: true }], at: earlier })
  if (routine === undefined)
    throw new Error('Expected a Routine.')
  store.openRoutineRun({ routineId: routine.id, scheduledFor: earlier, specSha: 'spec', at: earlier })
  store.recordObservation({ externalId: 'review', observedAt: now, source: 'poll', subject: pullRequestItem({ repository: priority, mergeState: 'clean' }) })
  const pools = createRoutinePermitPools(createAgentPermitPool(2), () => store.hasOverdueRoutineRun(now))
  const started: string[] = []
  let releaseRoutine: () => void = () => {}
  const routineScheduler = createWorkerTaskScheduler({
    canClaim: () => canClaimRoutineRun(true, ['github', 'routine'], store, now),
    claim: store.claimNextRoutineRun,
    complete: store.completeRoutineRun,
    fail: store.failRoutineRun,
    heartbeat: store.heartbeatRoutineRun,
    intervalMilliseconds: 5_000,
    leaseMilliseconds: 60_000,
    now: () => new Date(now),
    onError: (error) => { throw error },
    permits: pools.routines,
    worker: { run: async () => {
      started.push('routine')
      await new Promise<void>((resolve) => {
        releaseRoutine = resolve
      })
      return ok({ evidence: 'Scan complete.' })
    } },
    workerId: 'routine',
  })
  const reviewScheduler = createWorkerTaskScheduler({
    claim: store.claimNextAdversarialReviewTask,
    complete: store.completeWorkerTask,
    fail: store.failWorkerTask,
    heartbeat: store.heartbeatWorkerTask,
    intervalMilliseconds: 5_000,
    leaseMilliseconds: 60_000,
    now: () => new Date(now),
    onError: (error) => { throw error },
    permits: pools.items,
    worker: { run: async () => {
      started.push('review')
      return ok({ evidence: 'Reviewed.' })
    } },
    workerId: 'review',
  })
  // The competing Review timer gets the first chance, like the real Service.
  await reviewScheduler.runNow()
  expect(started).toEqual([])
  const running = routineScheduler.runNow()
  try {
    await vi.waitFor(() => expect(started).toContain('routine'))
    expect(store.listRoutineRuns(routine.id)[0]?.state._tag).toBe('Running')
    await reviewScheduler.runNow()
    expect(started).toEqual(['routine', 'review'])
    releaseRoutine()
    await running
    expect(store.listRoutineRuns(routine.id)[0]?.state._tag).toBe('Completed')
  }
  finally {
    releaseRoutine()
    await Promise.all([routineScheduler.stop(), reviewScheduler.stop(), running])
  }
})

it('recovers expired issue-work leases before deciding whether a batch can resume', () => {
  const store = setup(true)
  readyIssues(store, priority, earlier)
  store.planBatches(earlier)
  const batch = store.claimNextBatch('expired', earlier, 30_000)
  if (batch === null)
    throw new Error('Expected a Batch.')
  const plan = store.recordBatchPlan({ batchId: batch.id, workerId: 'expired', fence: batch.state.fence, at: earlier, units: [{ issueNumbers: [101, 102], dependsOn: null, rationale: 'Shared fix.' }] })
  if (plan._tag === 'Err' || plan.value[0] === undefined)
    throw new Error('Expected a Batch unit.')
  store.claimBatchUnitTask({ unitId: plan.value[0].id, workerId: 'expired', now: earlier, leaseMilliseconds: 30_000 })

  const resumed = store.claimNextBatch('resumed', later, 60_000)
  expect(resumed?.id).toBe(batch.id)
  expect(store.claimBatchUnitTask({ unitId: plan.value[0].id, workerId: 'resumed', now: later, leaseMilliseconds: 60_000 })?.issueNumber).toBe(101)
})

it('ignores combined issues from settled units when a suspended batch asks for priority', () => {
  const store = setup(true)
  readyIssues(store, priority, earlier, [101, 102, 103])
  store.planBatches(earlier)
  const batch = store.claimNextBatch('batch', earlier, 600_000)
  if (batch === null)
    throw new Error('Expected a Batch.')
  const plan = store.recordBatchPlan({ batchId: batch.id, workerId: 'batch', fence: batch.state.fence, at: earlier, units: [
    { issueNumbers: [101, 102], dependsOn: null, rationale: 'Shared fix.' },
    { issueNumbers: [103], dependsOn: null, rationale: 'Independent.' },
  ] })
  if (plan._tag === 'Err' || plan.value[0] === undefined)
    throw new Error('Expected a Batch unit.')
  const task = store.claimBatchUnitTask({ unitId: plan.value[0].id, workerId: 'batch', now: earlier, leaseMilliseconds: 60_000 })
  if (task === null)
    throw new Error('Expected Issue work.')
  store.needsAttentionTask({ taskId: task.id, workerId: 'batch', fence: task.state.fence, at: earlier, reason: 'Needs input.', evidence: 'The combined fix needs input.' })
  store.settleBatchUnit({ unitId: plan.value[0].id, at: earlier, state: { _tag: 'ActionRequired', reason: 'Needs input.' } })
  store.recordObservation({ externalId: 'closed-unit', observedAt: later, source: 'poll', subject: issueItem({ repository: priority, number: 103, author: 'harlan-zw', state: 'closed' }) })
  store.suspendBatch({ batchId: batch.id, workerId: 'batch', fence: batch.state.fence, at: later })
  store.recordObservation({ externalId: 'background', observedAt: later, source: 'poll', subject: issueItem({ author: 'harlan-zw' }) })

  expect(store.hasPriorityAgentTask(later)).toBe(false)
  expect(store.claimNextIssueTriageTask('triage', later, 60_000)?.repository).toBe('harlan-zw/example')
})
