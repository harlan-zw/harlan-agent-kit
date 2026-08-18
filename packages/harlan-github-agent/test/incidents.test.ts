import { describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

function createStore() {
  return openJournalStore(':memory:', true, CODEX_AGENT_PROFILE)
}

describe('incident log', () => {
  it('folds a repeated failure into one incident instead of one row per poll', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')

    store.recordPollFailure('harlan-zw/example', '2026-08-18T00:01:00.000Z', 'Resource not accessible by integration')
    store.recordPollFailure('harlan-zw/example', '2026-08-18T00:02:00.000Z', 'Resource not accessible by integration')
    store.recordPollFailure('harlan-zw/example', '2026-08-18T00:03:00.000Z', 'Resource not accessible by integration')

    const incidents = store.listIncidents()
    expect(incidents).toHaveLength(1)
    expect(incidents[0]).toMatchObject({
      scope: { _tag: 'Repository', repository: 'harlan-zw/example' },
      kind: 'github_access',
      severity: 'warning',
      operation: 'poll',
      occurrences: 3,
      firstSeenAt: '2026-08-18T00:01:00.000Z',
      lastSeenAt: '2026-08-18T00:03:00.000Z',
    })
  })

  it('separates two different failures on the same repository', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')

    store.recordPollFailure('harlan-zw/example', '2026-08-18T00:01:00.000Z', 'Resource not accessible by integration')
    store.recordPollFailure('harlan-zw/example', '2026-08-18T00:02:00.000Z', 'Request quota exhausted')

    expect(store.listIncidents().map(incident => incident.kind).sort()).toEqual(['github_access', 'rate_limit'])
  })

  it('clears a repository incident once the repository polls cleanly', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')

    store.recordPollFailure('harlan-zw/example', '2026-08-18T00:01:00.000Z', 'fetch failed')
    expect(store.listIncidents()).toHaveLength(1)

    store.recordPollSuccess('harlan-zw/example', '2026-08-18T00:02:00.000Z')
    expect(store.listIncidents()).toEqual([])
  })

  it('names a failed task and says the controller will retry it', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.recordObservation({
      externalId: 'incident-pr',
      observedAt: '2026-08-18T00:01:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })

    for (const attempt of [1, 2, 3]) {
      const at = `2026-08-18T00:01:0${attempt}.000Z`
      const task = store.claimNextAdversarialReviewTask(`worker-${attempt}`, at, 10_000)
      if (task === null)
        throw new Error(`Expected review attempt ${attempt}.`)
      store.failWorkerTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        reason: 'Resource not accessible by integration',
      })
    }

    const incidents = store.listIncidents()
    expect(incidents).toHaveLength(1)
    expect(incidents[0]).toMatchObject({
      scope: { _tag: 'Task', repository: 'harlan-zw/example', itemNumber: 24 },
      kind: 'github_access',
      operation: 'adversarial_review',
      severity: 'warning',
    })
    expect(incidents[0]?.recovery._tag).toBe('Retrying')
  })

  it('reports an unrecognised task failure as needing attention', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.recordObservation({
      externalId: 'attention-pr',
      observedAt: '2026-08-18T00:01:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })

    for (const attempt of [1, 2, 3]) {
      const at = `2026-08-18T00:01:0${attempt}.000Z`
      const task = store.claimNextAdversarialReviewTask(`worker-${attempt}`, at, 10_000)
      if (task === null)
        throw new Error(`Expected review attempt ${attempt}.`)
      store.failWorkerTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        reason: 'The worker deleted a file it was told to keep.',
      })
    }

    expect(store.listIncidents()[0]).toMatchObject({
      kind: 'unknown',
      severity: 'error',
      recovery: { _tag: 'ActionRequired' },
    })
  })

  it('clears a task incident once the task completes', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.recordObservation({
      externalId: 'recovering-pr',
      observedAt: '2026-08-18T00:01:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    for (const attempt of [1, 2, 3]) {
      const at = `2026-08-18T00:01:0${attempt}.000Z`
      const failing = store.claimNextAdversarialReviewTask(`worker-${attempt}`, at, 10_000)
      if (failing === null)
        throw new Error(`Expected review attempt ${attempt}.`)
      store.failWorkerTask({
        taskId: failing.id,
        workerId: failing.state.workerId,
        fence: failing.state.fence,
        at,
        reason: 'fetch failed',
      })
    }
    expect(store.listIncidents()).toHaveLength(1)

    expect(store.retryRecoverableWorkerFailures('2026-08-18T00:01:05.000Z')).toBe(1)
    const recovered = store.claimNextAdversarialReviewTask('worker-4', '2026-08-18T00:01:06.000Z', 10_000)
    if (recovered === null)
      throw new Error('Expected the recovered review.')
    store.completeWorkerTask({
      taskId: recovered.id,
      workerId: recovered.state.workerId,
      fence: recovered.state.fence,
      at: '2026-08-18T00:01:07.000Z',
      evidence: 'attempt-1',
    })

    expect(store.listIncidents()).toEqual([])
  })

  it('publishes open incidents on the dashboard snapshot', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.recordPollFailure('harlan-zw/example', '2026-08-18T00:01:00.000Z', 'fetch failed')

    expect(store.getDashboardSnapshot('2026-08-18T00:02:00.000Z').incidents).toHaveLength(1)
  })
})

describe('recoverable failure budget', () => {
  it('stops requeuing one task after its recovery budget runs out', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.recordObservation({
      externalId: 'budget-pr',
      observedAt: '2026-08-18T00:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })

    let recoveries = 0
    // Far enough ahead of each failure that backoff never blocks a recovery.
    for (let round = 0; round < 12; round += 1) {
      const at = new Date(Date.parse('2026-08-18T00:00:00.000Z') + round * 60 * 60_000).toISOString()
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const task = store.claimNextAdversarialReviewTask(`worker-${round}-${attempt}`, at, 10_000)
        if (task === null)
          break
        store.failWorkerTask({
          taskId: task.id,
          workerId: task.state.workerId,
          fence: task.state.fence,
          at,
          reason: 'Resource not accessible by integration',
        })
      }
      recoveries += store.retryRecoverableWorkerFailures(at)
    }

    expect(recoveries).toBe(5)
    expect(store.listIncidents()[0]?.recovery).toEqual({ _tag: 'Exhausted' })
  })

  it('never requeues a task whose failure describes a policy, not the world', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.recordObservation({
      externalId: 'policy-pr',
      observedAt: '2026-08-18T00:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    for (const attempt of [1, 2, 3]) {
      const at = `2026-08-18T00:00:0${attempt}.000Z`
      const task = store.claimNextAdversarialReviewTask(`worker-${attempt}`, at, 10_000)
      if (task === null)
        throw new Error(`Expected review attempt ${attempt}.`)
      store.failWorkerTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        reason: 'Repository policy does not authorize an automated review comment.',
      })
    }

    expect(store.retryRecoverableWorkerFailures('2026-08-18T01:00:00.000Z')).toBe(0)
  })
})

describe('task incidents from the mutation journal', () => {
  /**
   * Conflict resolution, repair, Baseline repair, and issue work all settle
   * through `failTask`, which is a different path from the review and triage
   * tasks. Both have to reach the System pane or half the work fails silently.
   */
  it('names a failed conflict resolution task', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.recordObservation({
      externalId: 'conflicting-pr',
      observedAt: '2026-08-18T00:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'conflicting' }),
    })

    for (const attempt of [1, 2, 3]) {
      const at = `2026-08-18T00:00:0${attempt}.000Z`
      const task = store.claimNextConflictTask(`worker-${attempt}`, at, 10_000)
      if (task === null)
        throw new Error(`Expected conflict resolution attempt ${attempt}.`)
      store.failTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        reason: 'The worker changed a file that was not conflicted: src/main.rs.',
      })
    }

    const incidents = store.listIncidents()
    expect(incidents).toHaveLength(1)
    expect(incidents[0]).toMatchObject({
      scope: { _tag: 'Task', repository: 'harlan-zw/example', itemNumber: 24 },
      operation: 'resolve_conflict',
      kind: 'unknown',
      severity: 'error',
      recovery: { _tag: 'ActionRequired' },
    })
  })

  it('clears a conflict resolution incident once the task completes', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.recordObservation({
      externalId: 'recovering-conflict',
      observedAt: '2026-08-18T00:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'conflicting' }),
    })
    for (const attempt of [1, 2, 3]) {
      const at = `2026-08-18T00:00:0${attempt}.000Z`
      const failing = store.claimNextConflictTask(`worker-${attempt}`, at, 10_000)
      if (failing === null)
        throw new Error(`Expected conflict resolution attempt ${attempt}.`)
      store.failTask({
        taskId: failing.id,
        workerId: failing.state.workerId,
        fence: failing.state.fence,
        at,
        reason: 'fetch failed',
      })
    }
    expect(store.listIncidents()).toHaveLength(1)

    expect(store.retryRecoverableWorkerFailures('2026-08-18T00:00:05.000Z')).toBe(1)
    const recovered = store.claimNextConflictTask('worker-4', '2026-08-18T00:00:06.000Z', 10_000)
    if (recovered === null)
      throw new Error('Expected the recovered conflict resolution task.')
    store.completeTask({
      taskId: recovered.id,
      workerId: recovered.state.workerId,
      fence: recovered.state.fence,
      at: '2026-08-18T00:00:07.000Z',
      evidence: 'resolved',
    })

    expect(store.listIncidents()).toEqual([])
  })
})

describe('recovery budget after a GitHub outage', () => {
  /** Exhausts one review task's whole recovery budget with the given reason. */
  function exhaust(store: ReturnType<typeof createStore>, reason: string): void {
    for (let round = 0; round < 12; round += 1) {
      const at = new Date(Date.parse('2026-08-18T00:00:00.000Z') + round * 60 * 60_000).toISOString()
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const task = store.claimNextAdversarialReviewTask(`worker-${round}-${attempt}`, at, 10_000)
        if (task === null)
          break
        store.failWorkerTask({
          taskId: task.id,
          workerId: task.state.workerId,
          fence: task.state.fence,
          at,
          reason,
        })
      }
      store.retryRecoverableWorkerFailures(at)
    }
  }

  function storeWithExhaustedReview(reason: string) {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.recordObservation({
      externalId: 'outage-pr',
      observedAt: '2026-08-18T00:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    exhaust(store, reason)
    return store
  }

  it('frees a task the outage exhausted once the repository polls again', () => {
    const store = storeWithExhaustedReview('Resource not accessible by integration')
    expect(store.listIncidents()[0]?.recovery).toEqual({ _tag: 'Exhausted' })

    // The failing poll, then the poll that recovers.
    store.recordPollFailure('harlan-zw/example', '2026-08-18T12:00:00.000Z', 'Resource not accessible by integration')
    store.recordPollSuccess('harlan-zw/example', '2026-08-18T12:01:00.000Z')

    expect(store.listIncidents()).toEqual([])
    expect(store.retryRecoverableWorkerFailures('2026-08-18T12:02:00.000Z')).toBe(1)
  })

  it('leaves a task that exhausted itself on a real defect alone', () => {
    const store = storeWithExhaustedReview('The worker deleted a file it was told to keep.')

    store.recordPollFailure('harlan-zw/example', '2026-08-18T12:00:00.000Z', 'fetch failed')
    store.recordPollSuccess('harlan-zw/example', '2026-08-18T12:01:00.000Z')

    // The repository incident cleared, but the defect still needs a person.
    expect(store.retryRecoverableWorkerFailures('2026-08-18T12:02:00.000Z')).toBe(0)
  })

  it('does not free the budget again on an ordinary healthy poll', () => {
    const store = storeWithExhaustedReview('Resource not accessible by integration')
    store.recordPollFailure('harlan-zw/example', '2026-08-18T12:00:00.000Z', 'Resource not accessible by integration')
    store.recordPollSuccess('harlan-zw/example', '2026-08-18T12:01:00.000Z')
    expect(store.retryRecoverableWorkerFailures('2026-08-18T12:02:00.000Z')).toBe(1)

    // Exhaust it again, then poll healthily without an intervening failure.
    exhaust(store, 'Resource not accessible by integration')
    store.recordPollSuccess('harlan-zw/example', '2026-08-19T00:00:00.000Z')
    expect(store.retryRecoverableWorkerFailures('2026-08-19T00:01:00.000Z')).toBe(0)
  })

  it('keeps a narrow installation exhausted, because a healthy poll does not widen it', () => {
    const store = storeWithExhaustedReview('The permissions requested are not granted to this installation.')

    store.recordPollFailure('harlan-zw/example', '2026-08-18T12:00:00.000Z', 'fetch failed')
    store.recordPollSuccess('harlan-zw/example', '2026-08-18T12:01:00.000Z')

    expect(store.retryRecoverableWorkerFailures('2026-08-18T12:02:00.000Z')).toBe(0)
    expect(store.listIncidents()[0]?.recovery).toEqual({ _tag: 'Exhausted' })
  })

  it('sweeps every healthy repository at startup', () => {
    const store = storeWithExhaustedReview('Resource not accessible by integration')
    store.recordPollSuccess('harlan-zw/example', '2026-08-18T12:00:00.000Z')

    expect(store.restoreOutageRecoveryBudget('2026-08-18T12:01:00.000Z')).toBe(1)
    expect(store.retryRecoverableWorkerFailures('2026-08-18T12:02:00.000Z')).toBe(1)
  })
})

describe('stale task incidents', () => {
  it('closes an incident once a newer revision supersedes its task', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.recordObservation({
      externalId: 'superseded-pr',
      observedAt: '2026-08-18T00:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    for (const attempt of [1, 2, 3]) {
      const at = `2026-08-18T00:00:0${attempt}.000Z`
      const task = store.claimNextAdversarialReviewTask(`worker-${attempt}`, at, 10_000)
      if (task === null)
        throw new Error(`Expected review attempt ${attempt}.`)
      store.failWorkerTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        reason: 'fetch failed',
      })
    }
    store.retryRecoverableWorkerFailures('2026-08-18T00:00:05.000Z')
    expect(store.listIncidents()).toHaveLength(1)

    // A new head commit replaces the queued review.
    store.recordObservation({
      externalId: 'superseded-pr-2',
      observedAt: '2026-08-18T00:01:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean', headSha: 'def456' }),
    })

    expect(store.listIncidents()).toEqual([])
  })

  it('sweeps incidents left behind by work that can no longer run', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.recordObservation({
      externalId: 'stale-pr',
      observedAt: '2026-08-18T00:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    for (const attempt of [1, 2, 3]) {
      const at = `2026-08-18T00:00:0${attempt}.000Z`
      const task = store.claimNextAdversarialReviewTask(`worker-${attempt}`, at, 10_000)
      if (task === null)
        throw new Error(`Expected review attempt ${attempt}.`)
      store.failWorkerTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        reason: 'fetch failed',
      })
    }
    expect(store.listIncidents()).toHaveLength(1)

    // Nothing to sweep while the task is still Failed on the current revision.
    expect(store.resolveStaleTaskIncidents('2026-08-18T00:00:06.000Z')).toBe(0)
    expect(store.listIncidents()).toHaveLength(1)
  })
})
