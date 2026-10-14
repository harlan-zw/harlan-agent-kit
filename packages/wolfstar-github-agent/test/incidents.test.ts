import { describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { contextBudgetExhaustedReason, MEMORY_BUDGET_EXHAUSTED } from '../src/failure.ts'
import { replaceServiceIncidents } from '../src/service.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

function createStore() {
  const store = openJournalStore(':memory:', true, CODEX_AGENT_PROFILE)
  const syncRepositories = store.syncRepositories
  store.syncRepositories = (repositories, at) => {
    syncRepositories(repositories, at)
    repositories.forEach((repository) => store.setRepositoryWritesEnabled(repository.github, true))
  }
  return store
}

describe('incident log', () => {
  it('preserves scheduled deadlines and identifies operations without a retry scheduler', () => {
    const store = createStore()
    const at = '2026-10-11T00:00:00Z'
    const record = (message: string, nextAttemptAt: string) =>
      store.recordIncident({
        scope: { _tag: 'Service' },
        kind: 'network',
        operation: 'probe',
        message,
        severity: 'warning',
        recovery: { _tag: 'Retrying', attempt: 0, nextAttemptAt },
        at,
      })
    record('Earlier Controller operation', at)
    record('Scheduled retry', '2026-10-11T00:01:00Z')
    expect(
      store.listIncidents().find((incident) => incident.message === 'Earlier Controller operation')?.recovery,
    ).toEqual({ _tag: 'OnNextOperation' })
    expect(store.listIncidents().find((incident) => incident.message === 'Scheduled retry')?.recovery).toEqual({
      _tag: 'Retrying',
      attempt: 0,
      nextAttemptAt: '2026-10-11T00:01:00Z',
    })
    store.close()
  })
  it('keeps an older blocking Incident visible through a larger warning burst', () => {
    const store = createStore()
    for (let index = 0; index < 51; index++) {
      store.recordIncident({
        scope: { _tag: 'Service' },
        kind: 'network',
        operation: 'probe',
        message: `Failure ${index}`,
        severity: index === 0 ? 'error' : 'warning',
        recovery: { _tag: 'ActionRequired' },
        at: new Date(Date.parse('2026-10-11T00:00:00Z') + index * 1000).toISOString(),
      })
    }
    expect(store.listIncidents()[0]?.message).toBe('Failure 0')
    expect(store.getDashboardSnapshot('2026-10-11T00:01:00Z').incidents).toHaveLength(51)
    store.close()
  })

  it.each(['review', 'conflict'] as const)('keeps memory recovery bounded during %s observations', (kind) => {
    const store = createStore()
    const at = (second: number) => new Date(Date.parse('2026-08-18T00:00:00Z') + second * 1000).toISOString()
    store.syncRepositories([repositoryMapping()], at(0))
    const subject = pullRequestItem({ mergeState: kind === 'review' ? 'clean' : 'conflicting' })
    const observe = (second: number) =>
      store.recordObservation({ externalId: `memory-${second}`, observedAt: at(second), source: 'poll', subject })
    const claim = (second: number) =>
      kind === 'review'
        ? store.claimNextAdversarialReviewTask('worker', at(second), 600_000)
        : store.claimNextConflictTask('worker', at(second), 600_000)
    observe(1)
    const task = claim(2)!
    const fail = kind === 'review' ? store.failWorkerTask : store.failTask
    expect(
      fail({
        taskId: task.id,
        workerId: 'worker',
        fence: task.state.fence,
        at: at(3),
        reason: MEMORY_BUDGET_EXHAUSTED,
      }),
    ).toBe('Failed')
    observe(4)
    expect(claim(5)).toBeNull()
    observe(63)
    const retry = claim(64)!
    expect(retry).toMatchObject({ id: task.id, state: { fence: task.state.fence + 1 } })
    expect(
      fail({
        taskId: retry.id,
        workerId: 'worker',
        fence: retry.state.fence,
        at: at(65),
        reason: MEMORY_BUDGET_EXHAUSTED,
      }),
    ).toBe('Failed')
    observe(1000)
    store.recordPollFailure(subject.repository, at(1001), 'fetch failed')
    store.recordPollSuccess(subject.repository, at(1002))
    expect(store.restoreOutageRecoveryBudget(at(1003))).toBe(0)
    expect(store.retryRecoverableWorkerFailures(at(1004))).toBe(0)
    expect(claim(1005)).toBeNull()
    expect(store.listIncidents()).toMatchObject([{ kind: 'resource_limit', recovery: { _tag: 'Exhausted' } }])
    store.close()
  })

  it('clears a worktree sweep incident after the next clean sweep', () => {
    const store = createStore()

    replaceServiceIncidents(store, '2026-08-18T00:01:00.000Z', 'agent_worktree_sweep', ['wt list failed'])
    expect(store.listIncidents()).toHaveLength(1)

    replaceServiceIncidents(store, '2026-08-18T00:02:00.000Z', 'agent_worktree_sweep', [])
    expect(store.listIncidents()).toEqual([])
  })

  it('folds a repeated failure into one incident instead of one row per poll', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')

    store.recordPollFailure(
      'wolfstar-project/example',
      '2026-08-18T00:01:00.000Z',
      'Resource not accessible by integration',
    )
    store.recordPollFailure(
      'wolfstar-project/example',
      '2026-08-18T00:02:00.000Z',
      'Resource not accessible by integration',
    )
    store.recordPollFailure(
      'wolfstar-project/example',
      '2026-08-18T00:03:00.000Z',
      'Resource not accessible by integration',
    )

    const incidents = store.listIncidents()
    expect(incidents).toHaveLength(1)
    expect(incidents[0]).toMatchObject({
      scope: { _tag: 'Repository', repository: 'wolfstar-project/example' },
      kind: 'github_access',
      severity: 'warning',
      operation: 'poll',
      occurrences: 3,
      firstSeenAt: '2026-08-18T00:01:00.000Z',
      lastSeenAt: '2026-08-18T00:03:00.000Z',
    })
  })

  it('resolves one repository publication failure without touching another repository', () => {
    const store = createStore()
    store.syncRepositories(
      [
        repositoryMapping(),
        repositoryMapping({ github: 'wolfstar-project/other', checkout: '/home/wolfstar/sites/other' }),
      ],
      '2026-08-18T00:00:00.000Z',
    )
    const failure = (repository: string, at: string): void => {
      store.recordIncident({
        scope: { _tag: 'Repository', repository },
        kind: 'unknown',
        severity: 'error',
        operation: 'review_status_publication',
        message: 'GitHub did not stamp the wolfstar-agent-ready label.',
        recovery: { _tag: 'ActionRequired' },
        at,
      })
    }
    failure('wolfstar-project/example', '2026-08-18T00:01:00.000Z')
    failure('wolfstar-project/other', '2026-08-18T00:01:30.000Z')

    // The success signal for one repository. It answers only for that one, so
    // the other repository keeps the Incident nobody has fixed yet.
    const resolved = store.resolveIncidents(
      { _tag: 'Repository', repository: 'wolfstar-project/example' },
      '2026-08-18T00:02:00.000Z',
      'review_status_publication',
    )

    expect(resolved).toBe(1)
    expect(store.listIncidents().map((incident) => incident.scope)).toEqual([
      { _tag: 'Repository', repository: 'wolfstar-project/other' },
    ])
  })

  it('separates two different failures on the same repository', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')

    store.recordPollFailure(
      'wolfstar-project/example',
      '2026-08-18T00:01:00.000Z',
      'Resource not accessible by integration',
    )
    store.recordPollFailure('wolfstar-project/example', '2026-08-18T00:02:00.000Z', 'Request quota exhausted')

    expect(
      store
        .listIncidents()
        .map((incident) => incident.kind)
        .sort(),
    ).toEqual(['github_access', 'rate_limit'])
  })

  it('clears only the service operation that recovered', () => {
    const store = createStore()
    store.recordIncident({
      scope: { _tag: 'Service' },
      kind: 'network',
      severity: 'warning',
      operation: 'review_rerun',
      message: 'fetch failed',
      recovery: { _tag: 'Retrying', attempt: 0, nextAttemptAt: '2026-08-18T00:01:00.000Z' },
      at: '2026-08-18T00:01:00.000Z',
    })
    store.recordIncident({
      scope: { _tag: 'Service' },
      kind: 'network',
      severity: 'warning',
      operation: 'pull_request_status',
      message: 'fetch failed',
      recovery: { _tag: 'Retrying', attempt: 0, nextAttemptAt: '2026-08-18T00:01:00.000Z' },
      at: '2026-08-18T00:01:00.000Z',
    })

    store.resolveIncidents({ _tag: 'Service' }, '2026-08-18T00:02:00.000Z', 'review_rerun')

    expect(store.listIncidents().map((incident) => incident.operation)).toEqual(['pull_request_status'])
  })

  it('keeps the current service failure while clearing the prior failure', () => {
    const store = createStore()
    for (const [message, at] of [
      ['first failure', '2026-08-18T00:01:00.000Z'],
      ['current failure', '2026-08-18T00:02:00.000Z'],
      ['current failure', '2026-08-18T00:03:00.000Z'],
    ] as const) {
      store.recordIncident({
        scope: { _tag: 'Service' },
        kind: 'network',
        severity: 'warning',
        operation: 'review_rerun',
        message,
        recovery: { _tag: 'Retrying', attempt: 0, nextAttemptAt: at },
        at,
      })
    }

    store.resolveIncidents({ _tag: 'Service' }, '2026-08-18T00:03:00.000Z', 'review_rerun', ['current failure'])

    expect(store.listIncidents()).toMatchObject([
      {
        message: 'current failure',
        occurrences: 2,
      },
    ])
  })

  it('clears a repository incident once the repository polls cleanly', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')

    store.recordPollFailure('wolfstar-project/example', '2026-08-18T00:01:00.000Z', 'fetch failed')
    expect(store.listIncidents()).toHaveLength(1)

    store.recordPollSuccess('wolfstar-project/example', '2026-08-18T00:02:00.000Z')
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
      if (task === null) throw new Error(`Expected review attempt ${attempt}.`)
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
      scope: { _tag: 'Task', repository: 'wolfstar-project/example', itemNumber: 24 },
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
      if (task === null) throw new Error(`Expected review attempt ${attempt}.`)
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

  it('names the pull request whose review spent its whole Context budget', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.recordObservation({
      externalId: 'runaway-pr',
      observedAt: '2026-08-18T00:01:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    const task = store.claimNextAdversarialReviewTask('worker-1', '2026-08-18T00:01:01.000Z', 10_000)
    if (task === null) throw new Error('Expected one review task.')

    const outcome = store.failWorkerTask({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-18T00:01:01.000Z',
      reason: contextBudgetExhaustedReason({
        cachedTokensRead: 20_400_128,
        itemNumber: 24,
        repository: 'wolfstar-project/example',
      }),
    })

    // One attempt only. A retry reads the same context and spends the budget again.
    expect(outcome).toBe('Failed')
    const incidents = store.listIncidents()
    expect(incidents).toHaveLength(1)
    expect(incidents[0]).toMatchObject({
      scope: { _tag: 'Task', repository: 'wolfstar-project/example', itemNumber: 24 },
      kind: 'context_budget',
      operation: 'adversarial_review',
      severity: 'error',
      recovery: { _tag: 'ActionRequired' },
    })
    expect(incidents[0]?.message).toContain('20.4 million')
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
      if (failing === null) throw new Error(`Expected review attempt ${attempt}.`)
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
    if (recovered === null) throw new Error('Expected the recovered review.')
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
    store.recordPollFailure('wolfstar-project/example', '2026-08-18T00:01:00.000Z', 'fetch failed')

    const snapshot = store.getDashboardSnapshot('2026-08-18T00:02:00.000Z')
    expect(snapshot.incidents).toHaveLength(1)
    expect(snapshot.status).toBe('degraded')
  })

  it('reports a controller Incident as degraded without a repository failure', () => {
    const store = createStore()
    replaceServiceIncidents(store, '2026-08-18T00:01:00.000Z', 'review_rerun', ['fetch failed'])

    expect(store.getDashboardSnapshot('2026-08-18T00:02:00.000Z').status).toBe('degraded')
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
        if (task === null) break
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
    const task = store.claimNextAdversarialReviewTask('worker-1', '2026-08-18T00:00:01.000Z', 10_000)
    if (task === null) throw new Error('Expected the review Task.')

    // One attempt settles it. Two more would read the same policy, refuse
    // again, and spend one whole agent turn each time.
    expect(
      store.failWorkerTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at: '2026-08-18T00:00:02.000Z',
        reason: 'Repository policy does not authorize an automated review comment.',
      }),
    ).toBe('Failed')
    expect(store.claimNextAdversarialReviewTask('worker-2', '2026-08-18T00:00:03.000Z', 10_000)).toBeNull()
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
      if (task === null) throw new Error(`Expected conflict resolution attempt ${attempt}.`)
      store.failTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        reason: 'The worker changed a file the merge did not touch: src/main.rs.',
      })
    }

    const incidents = store.listIncidents()
    expect(incidents).toHaveLength(1)
    expect(incidents[0]).toMatchObject({
      scope: { _tag: 'Task', repository: 'wolfstar-project/example', itemNumber: 24 },
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
      if (failing === null) throw new Error(`Expected conflict resolution attempt ${attempt}.`)
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
    if (recovered === null) throw new Error('Expected the recovered conflict resolution task.')
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
        if (task === null) break
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

  function storeWithProviderFailureAtRecoveryLimit() {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.recordObservation({
      externalId: 'provider-outage-pr',
      observedAt: '2026-08-18T00:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    for (let round = 0; round <= 5; round += 1) {
      const at = new Date(Date.parse('2026-08-18T00:00:00.000Z') + round * 2 * 60 * 60_000).toISOString()
      if (round > 0) expect(store.retryRecoverableWorkerFailures(at)).toBe(1)
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const task = store.claimNextAdversarialReviewTask(`provider-${round}-${attempt}`, at, 10_000)
        if (task === null) throw new Error(`Expected provider recovery ${round}, attempt ${attempt}.`)
        store.failWorkerTask({
          taskId: task.id,
          workerId: task.state.workerId,
          fence: task.state.fence,
          at,
          reason: 'The opencode session failed: Unexpected server error.',
        })
      }
    }
    return store
  }

  it('frees a task the outage exhausted once the repository polls again', () => {
    const store = storeWithExhaustedReview('Resource not accessible by integration')
    expect(store.listIncidents()[0]?.recovery).toEqual({ _tag: 'Exhausted' })

    // The failing poll, then the poll that recovers.
    store.recordPollFailure(
      'wolfstar-project/example',
      '2026-08-18T12:00:00.000Z',
      'Resource not accessible by integration',
    )
    store.recordPollSuccess('wolfstar-project/example', '2026-08-18T12:01:00.000Z')

    expect(store.listIncidents()).toEqual([])
    expect(store.retryRecoverableWorkerFailures('2026-08-18T12:02:00.000Z')).toBe(1)
  })

  it('leaves a task that exhausted itself on a real defect alone', () => {
    const store = storeWithExhaustedReview('The worker deleted a file it was told to keep.')

    store.recordPollFailure('wolfstar-project/example', '2026-08-18T12:00:00.000Z', 'fetch failed')
    store.recordPollSuccess('wolfstar-project/example', '2026-08-18T12:01:00.000Z')

    // The repository incident cleared, but the defect still needs a person.
    expect(store.retryRecoverableWorkerFailures('2026-08-18T12:02:00.000Z')).toBe(0)
  })

  it('does not free the budget again on an ordinary healthy poll', () => {
    const store = storeWithExhaustedReview('Resource not accessible by integration')
    store.recordPollFailure(
      'wolfstar-project/example',
      '2026-08-18T12:00:00.000Z',
      'Resource not accessible by integration',
    )
    store.recordPollSuccess('wolfstar-project/example', '2026-08-18T12:01:00.000Z')
    expect(store.retryRecoverableWorkerFailures('2026-08-18T12:02:00.000Z')).toBe(1)

    // Exhaust it again, then poll healthily without an intervening failure.
    exhaust(store, 'Resource not accessible by integration')
    store.recordPollSuccess('wolfstar-project/example', '2026-08-19T00:00:00.000Z')
    expect(store.retryRecoverableWorkerFailures('2026-08-19T00:01:00.000Z')).toBe(0)
  })

  it('keeps a narrow installation exhausted, because a healthy poll does not widen it', () => {
    const store = storeWithExhaustedReview('The permissions requested are not granted to this installation.')

    store.recordPollFailure('wolfstar-project/example', '2026-08-18T12:00:00.000Z', 'fetch failed')
    store.recordPollSuccess('wolfstar-project/example', '2026-08-18T12:01:00.000Z')

    expect(store.retryRecoverableWorkerFailures('2026-08-18T12:02:00.000Z')).toBe(0)
    expect(store.listIncidents()[0]?.recovery).toEqual({ _tag: 'Exhausted' })
  })

  it('sweeps every healthy repository at startup', () => {
    const store = storeWithExhaustedReview('Resource not accessible by integration')
    store.recordPollSuccess('wolfstar-project/example', '2026-08-18T12:00:00.000Z')

    expect(store.restoreOutageRecoveryBudget('2026-08-18T12:01:00.000Z')).toBe(1)
    expect(store.retryRecoverableWorkerFailures('2026-08-18T12:02:00.000Z')).toBe(1)
  })

  it('keeps retrying a provider failure at capped backoff', () => {
    const store = storeWithProviderFailureAtRecoveryLimit()

    expect(store.listIncidents()[0]?.recovery).toEqual(expect.objectContaining({ _tag: 'Retrying' }))
    expect(store.retryRecoverableWorkerFailures('2026-08-18T12:00:00.000Z')).toBe(1)
  })

  it('reports one shared Incident when one Agent provider fails across Tasks', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    for (const number of [24, 25]) {
      store.recordObservation({
        externalId: `provider-outage-pr-${number}`,
        observedAt: '2026-08-18T00:00:00.000Z',
        source: 'poll',
        subject: pullRequestItem({ number, mergeState: 'clean' }),
      })
    }

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const at = `2026-08-18T00:00:0${attempt}.000Z`
      const task = store.claimNextAdversarialReviewTask(`provider-${attempt}`, at, 10_000)
      if (task === null) throw new Error(`Expected provider failure ${attempt}.`)
      store.failWorkerTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        reason: 'The opencode session failed: Unexpected server error.',
      })
    }

    expect(store.listIncidents()).toMatchObject([
      {
        scope: { _tag: 'Service' },
        kind: 'agent_provider',
        operation: 'agent_provider',
        occurrences: 2,
        recovery: { _tag: 'Retrying' },
      },
    ])
    expect(
      store
        .getDashboardSnapshot('2026-08-18T00:00:07.000Z')
        .queue.filter((entry) => entry.number === 24 || entry.number === 25)
        .map((entry) => entry.state),
    ).toEqual([
      { _tag: 'Pending', reason: 'The opencode session failed: Unexpected server error. The controller will retry.' },
      { _tag: 'Pending', reason: 'The opencode session failed: Unexpected server error. The controller will retry.' },
    ])
  })

  it('keeps provider failures isolated from an unrelated Agent success', () => {
    const store = storeWithProviderFailureAtRecoveryLimit()
    expect(store.listIncidents()[0]?.recovery).toEqual(expect.objectContaining({ _tag: 'Retrying' }))

    store.recordObservation({
      externalId: 'healthy-provider-pr',
      observedAt: '2026-08-18T10:00:01.000Z',
      source: 'poll',
      subject: pullRequestItem({ number: 25, mergeState: 'clean' }),
    })
    const healthy = store.claimNextAdversarialReviewTask('healthy-provider', '2026-08-18T10:00:02.000Z', 10_000)
    if (healthy === null) throw new Error('Expected a Review Task for the healthy Agent provider.')
    expect(
      store.completeWorkerTask({
        taskId: healthy.id,
        workerId: healthy.state.workerId,
        fence: healthy.state.fence,
        at: '2026-08-18T10:00:03.000Z',
        evidence: 'The Agent provider completed a Review.',
      }),
    ).toBe(true)

    expect(store.listIncidents()).toHaveLength(1)
    expect(store.retryRecoverableWorkerFailures('2026-08-18T10:00:04.000Z')).toBe(0)
  })
})

describe('stale task incidents', () => {
  it('clears an older failure when the Task now needs a different action', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.recordObservation({
      externalId: 'changed-action-pr',
      observedAt: '2026-08-18T00:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })
    const task = store.claimNextConflictTask('worker', '2026-08-18T00:00:01.000Z', 10_000)
    if (task === null) throw new Error('Expected a conflict Task.')
    const reason = 'The contributor must permit maintainer edits.'
    store.needsAttentionTask({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-18T00:00:02.000Z',
      reason,
      evidence: 'Current permission check.',
    })
    for (const [message, at] of [
      ['fetch failed', '2026-08-18T00:00:01.000Z'],
      [reason, '2026-08-18T00:00:03.000Z'],
      ['A new upload failed.', '2026-08-18T00:00:03.000Z'],
    ] as const) {
      store.recordIncident({
        scope: { _tag: 'Task', taskId: task.id, repository: task.repository, itemNumber: task.pullRequestNumber },
        kind: 'unknown',
        severity: 'error',
        operation: 'resolve_conflict',
        message,
        recovery: { _tag: 'ActionRequired' },
        at,
      })
    }

    expect(store.resolveStaleTaskIncidents('2026-08-18T00:00:04.000Z')).toBe(1)
    expect(store.listIncidents()).toMatchObject([{ message: reason }, { message: 'A new upload failed.' }])
    expect(
      store.getDashboardSnapshot('2026-08-18T00:00:04.000Z').tasks.find((candidate) => candidate.id === task.id)?.state,
    ).toEqual({ _tag: 'ActionRequired', reason })
    store.close()
  })

  it.each(['removed', 'disabled'] as const)('closes incidents after a Repository mapping is %s', (change) => {
    const store = createStore()
    const retired = repositoryMapping()
    const active = repositoryMapping({ github: 'wolfstar-project/active', checkout: '/home/wolfstar/sites/active' })
    store.syncRepositories([retired, active], '2026-08-18T00:00:00.000Z')
    for (const repository of [retired.github, active.github]) {
      for (const scope of [
        { _tag: 'Repository', repository } as const,
        { _tag: 'Task', repository, taskId: `retained:${repository}`, itemNumber: 24 } as const,
      ]) {
        store.recordIncident({
          scope,
          kind: 'installation_access',
          severity: 'error',
          operation: 'adversarial_review',
          message: 'The GitHub App installation cannot access this repository.',
          recovery: { _tag: 'ActionRequired' },
          at: '2026-08-18T00:00:01.000Z',
        })
      }
    }
    store.syncRepositories(
      change === 'removed' ? [active] : [{ ...retired, enabled: false }, active],
      '2026-08-18T00:00:02.000Z',
    )
    store.setRepositoryPaused(active.github, true)

    expect(store.resolveStaleTaskIncidents('2026-08-18T00:00:03.000Z')).toBe(1)
    expect(store.listIncidents().map((incident) => incident.scope)).toEqual([
      { _tag: 'Repository', repository: active.github },
      { _tag: 'Task', repository: active.github, taskId: `retained:${active.github}`, itemNumber: 24 },
    ])
    expect(store.resolveStaleTaskIncidents('2026-08-18T00:00:04.000Z')).toBe(0)
    store.close()
  })

  it('refreshes a legacy exhausted provider Incident to Retrying', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.recordObservation({
      externalId: 'legacy-provider-incident-pr',
      observedAt: '2026-08-18T00:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    const reason = 'The opencode session failed: Unexpected server error.'
    let taskId = ''
    for (const attempt of [1, 2, 3]) {
      const task = store.claimNextAdversarialReviewTask(
        `provider-${attempt}`,
        `2026-08-18T00:00:0${attempt}.000Z`,
        10_000,
      )
      if (task === null) throw new Error(`Expected provider failure attempt ${attempt}.`)
      taskId = task.id
      store.failWorkerTask({
        taskId,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at: `2026-08-18T00:00:0${attempt}.000Z`,
        reason,
      })
    }
    store.recordIncident({
      scope: { _tag: 'Task', taskId, repository: 'wolfstar-project/example', itemNumber: 24 },
      kind: 'agent_provider',
      severity: 'error',
      operation: 'adversarial_review',
      message: reason,
      recovery: { _tag: 'Exhausted' },
      at: '2026-08-18T00:00:04.000Z',
    })
    expect(store.listIncidents()[0]?.recovery).toEqual({ _tag: 'Exhausted' })

    expect(store.resolveStaleTaskIncidents('2026-08-18T00:00:05.000Z')).toBe(1)
    expect(store.listIncidents()[0]?.recovery).toEqual(expect.objectContaining({ _tag: 'Retrying' }))
  })

  it('restores a missing incident for the current failed task', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.recordObservation({
      externalId: 'missing-incident-pr',
      observedAt: '2026-08-18T00:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    let taskId = ''
    for (const attempt of [1, 2, 3]) {
      const task = store.claimNextAdversarialReviewTask(
        `worker-${attempt}`,
        `2026-08-18T00:00:0${attempt}.000Z`,
        10_000,
      )
      if (task === null) throw new Error(`Expected failure attempt ${attempt}.`)
      taskId = task.id
      store.failWorkerTask({
        taskId,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at: `2026-08-18T00:00:0${attempt}.000Z`,
        reason: 'The GitHub App needs Contents write permission.',
      })
    }
    store.resolveIncidents(
      { _tag: 'Task', taskId, repository: 'wolfstar-project/example', itemNumber: 24 },
      '2026-08-18T00:00:04.000Z',
    )
    expect(store.listIncidents()).toEqual([])

    store.resolveStaleTaskIncidents('2026-08-18T00:00:05.000Z')

    expect(store.listIncidents()).toMatchObject([
      {
        message: 'The GitHub App needs Contents write permission.',
        scope: { _tag: 'Task', taskId },
      },
    ])
  })

  it('closes an incident that no longer matches the task failure', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.recordObservation({
      externalId: 'old-incident-pr',
      observedAt: '2026-08-18T00:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    let taskId = ''
    for (const attempt of [1, 2, 3]) {
      const task = store.claimNextAdversarialReviewTask(
        `worker-${attempt}`,
        `2026-08-18T00:00:0${attempt}.000Z`,
        10_000,
      )
      if (task === null) throw new Error(`Expected failure attempt ${attempt}.`)
      taskId = task.id
      store.failWorkerTask({
        taskId,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at: `2026-08-18T00:00:0${attempt}.000Z`,
        reason: 'The current failure.',
      })
    }
    store.recordIncident({
      scope: { _tag: 'Task', taskId, repository: 'wolfstar-project/example', itemNumber: 24 },
      kind: 'policy',
      severity: 'error',
      operation: 'adversarial_review',
      message: 'An old failure.',
      recovery: { _tag: 'ActionRequired' },
      at: '2026-08-18T00:00:04.000Z',
    })
    expect(store.listIncidents()).toHaveLength(2)

    expect(store.resolveStaleTaskIncidents('2026-08-18T00:00:05.000Z')).toBe(1)

    expect(store.listIncidents()).toMatchObject([{ message: 'The current failure.' }])
  })

  it('keeps only the current failure for one task', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.recordObservation({
      externalId: 'changed-failure-pr',
      observedAt: '2026-08-18T00:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    for (const attempt of [1, 2, 3]) {
      const task = store.claimNextAdversarialReviewTask(
        `worker-a-${attempt}`,
        `2026-08-18T00:00:0${attempt}.000Z`,
        10_000,
      )
      if (task === null) throw new Error(`Expected first failure attempt ${attempt}.`)
      store.failWorkerTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at: `2026-08-18T00:00:0${attempt}.000Z`,
        reason: 'fetch failed',
      })
    }
    expect(store.retryRecoverableWorkerFailures('2026-08-18T00:00:05.000Z')).toBe(1)
    for (const attempt of [1, 2, 3]) {
      const task = store.claimNextAdversarialReviewTask(
        `worker-b-${attempt}`,
        `2026-08-18T01:00:0${attempt}.000Z`,
        10_000,
      )
      if (task === null) throw new Error(`Expected second failure attempt ${attempt}.`)
      store.failWorkerTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at: `2026-08-18T01:00:0${attempt}.000Z`,
        reason: 'The agent returned malformed review JSON.',
      })
    }

    expect(store.listIncidents()).toMatchObject([
      {
        kind: 'agent_result',
        message: 'The agent returned malformed review JSON.',
      },
    ])
  })

  it('clears incidents for a repository removed from the service', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.recordPollFailure('wolfstar-project/example', '2026-08-18T00:01:00.000Z', 'fetch failed')

    store.syncRepositories([], '2026-08-18T00:02:00.000Z')

    expect(store.listIncidents()).toEqual([])
  })

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
      if (task === null) throw new Error(`Expected review attempt ${attempt}.`)
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
      if (task === null) throw new Error(`Expected review attempt ${attempt}.`)
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

  it('shows an exhausted transient non-provider review as ActionRequired, not retrying', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.recordObservation({
      externalId: 'exhausted-result-pr',
      observedAt: '2026-08-18T00:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    for (let round = 0; round < 12; round += 1) {
      const at = new Date(Date.parse('2026-08-18T00:00:00.000Z') + round * 60 * 60_000).toISOString()
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const task = store.claimNextAdversarialReviewTask(`worker-${round}-${attempt}`, at, 10_000)
        if (task === null) break
        store.failWorkerTask({
          taskId: task.id,
          workerId: task.state.workerId,
          fence: task.state.fence,
          at,
          reason: 'The agent returned malformed adversarial review JSON.',
        })
      }
      store.retryRecoverableWorkerFailures(at)
    }
    expect(store.retryRecoverableWorkerFailures('2026-08-19T00:00:00.000Z')).toBe(0)

    expect(store.getDashboardSnapshot('2026-08-19T00:00:01.000Z').queue[0]?.state).toEqual({
      _tag: 'ActionRequired',
      reason: 'The agent returned malformed adversarial review JSON.',
    })
  })

  it('resolves a Service provider Incident once the task that raised it no longer runs', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.recordObservation({
      externalId: 'service-incident-pr',
      observedAt: '2026-08-18T00:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    const reason = 'The opencode session failed: Unexpected server error.'
    for (const attempt of [1, 2, 3]) {
      const at = `2026-08-18T00:00:0${attempt}.000Z`
      const task = store.claimNextAdversarialReviewTask(`provider-${attempt}`, at, 10_000)
      if (task === null) throw new Error(`Expected review attempt ${attempt}.`)
      store.failWorkerTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        reason,
      })
    }
    expect(store.listIncidents()).toMatchObject([{ scope: { _tag: 'Service' }, kind: 'agent_provider' }])

    // A new head commit moves the failing review off the current revision, so
    // no work still depends on this shared provider Incident.
    store.recordObservation({
      externalId: 'service-incident-pr-new-head',
      observedAt: '2026-08-18T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean', headSha: 'def456' }),
    })

    expect(store.resolveStaleTaskIncidents('2026-08-18T01:00:01.000Z')).toBe(1)
    expect(store.listIncidents()).toEqual([])
  })
})

describe('explicit Incident resolution', () => {
  it('records evidence once and rejects stale or different requests', () => {
    const store = createStore()
    const input = {
      scope: { _tag: 'Service' as const },
      kind: 'unknown' as const,
      severity: 'warning' as const,
      operation: 'probe',
      message: 'Old warning',
      recovery: { _tag: 'ActionRequired' as const },
      at: '2026-10-12T00:00:00.000Z',
    }
    const incident = store.recordIncident(input)
    const request = {
      incidentId: incident.id,
      lastSeenAt: incident.lastSeenAt,
      evidence: 'Verified merged fix abc123.',
      at: '2026-10-12T01:00:00.000Z',
    }
    expect(store.resolveIncident({ ...request, incidentId: 'a'.repeat(64) })).toEqual({
      _tag: 'Err',
      error: { _tag: 'NotFound' },
    })
    expect(store.resolveIncident({ ...request, lastSeenAt: '2026-10-11T00:00:00.000Z' })).toEqual({
      _tag: 'Err',
      error: { _tag: 'Changed' },
    })
    expect(store.resolveIncident(request)).toEqual({ _tag: 'Ok', value: { _tag: 'Resolved' } })
    expect(store.resolveIncident(request)).toEqual({ _tag: 'Ok', value: { _tag: 'AlreadyResolved' } })
    expect(store.resolveIncident({ ...request, evidence: 'Different evidence.' })).toEqual({
      _tag: 'Err',
      error: { _tag: 'Changed' },
    })
    expect(store.listIncidents()).toEqual([])
    expect(store.listWorkflowEvents({ stream: 'incident' })).toMatchObject([
      { entityId: incident.id, event: 'resolved', reason: request.evidence },
    ])
    store.recordIncident({ ...input, at: '2026-10-12T02:00:00.000Z' })
    expect(store.resolveIncident(request)).toEqual({ _tag: 'Err', error: { _tag: 'Changed' } })
    expect(store.listIncidents()[0]?.occurrences).toBe(2)
    store.close()
  })

  it('refuses a Running owning Task without changing its history', () => {
    const store = createStore()
    const at = '2026-10-12T00:00:00.000Z'
    store.syncRepositories([repositoryMapping()], at)
    store.recordObservation({
      externalId: 'resolution-task',
      observedAt: at,
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    const task = store.claimNextAdversarialReviewTask('worker', at, 10000)
    if (task === null) throw new Error('Expected Review Task.')
    const incident = store.recordIncident({
      scope: { _tag: 'Task', taskId: task.id, repository: 'wolfstar-project/example', itemNumber: 24 },
      kind: 'unknown',
      severity: 'error',
      operation: 'adversarial_review',
      message: 'Retained failure',
      recovery: { _tag: 'ActionRequired' },
      at,
    })
    const before = store.getDashboardSnapshot(at).tasks
    expect(
      store.resolveIncident({
        incidentId: incident.id,
        lastSeenAt: incident.lastSeenAt,
        evidence: 'Verified fix.',
        at,
      }),
    ).toEqual({ _tag: 'Err', error: { _tag: 'TaskActive' } })
    expect(store.getDashboardSnapshot(at).tasks).toEqual(before)
    expect(store.listIncidents()).toEqual([incident])
    store.close()
  })
})

describe('resolved Incident recovery history', () => {
  it('keeps a verified Failed Task unchanged without recreating its incident', () => {
    const store = createStore()
    const at = '2026-10-12T00:00:00.000Z'
    store.syncRepositories([repositoryMapping()], at)
    store.recordObservation({
      externalId: 'failed-resolution',
      observedAt: at,
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    for (const attempt of [1, 2, 3]) {
      const task = store.claimNextAdversarialReviewTask(`worker-${attempt}`, at, 10000)
      if (task === null) throw new Error('Expected Review Task.')
      store.failWorkerTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        reason: 'The old repair failed.',
      })
    }
    const incident = store.listIncidents()[0]
    if (incident === undefined) throw new Error('Expected failed Task Incident.')
    const before = store.getDashboardSnapshot(at).tasks
    const request = {
      incidentId: incident.id,
      lastSeenAt: incident.lastSeenAt,
      evidence: 'Verified merged fix.',
      at: '2026-10-12T01:00:00.000Z',
    }
    expect(store.resolveIncident(request)).toEqual({ _tag: 'Ok', value: { _tag: 'Resolved' } })
    store.resolveStaleTaskIncidents('2026-10-12T02:00:00.000Z')
    expect(store.listIncidents()).toEqual([])
    expect(store.getDashboardSnapshot(at).tasks).toEqual(before)
    expect(store.listWorkflowEvents({ stream: 'incident' }).map((event) => event.reason)).toEqual([request.evidence])
    store.close()
  })
})
