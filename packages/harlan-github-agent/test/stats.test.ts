import type { ReviewGates } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { buildStats, parseStatsRange } from '../src/stats.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []

afterEach(() => {
  stores.splice(0).forEach(store => store.close())
})

function createStore() {
  const store = openJournalStore(':memory:')
  stores.push(store)
  return store
}

function passedReviewGates(): ReviewGates {
  return {
    merge: { _tag: 'Passed', evidence: [] },
    review: { _tag: 'Passed', evidence: [] },
    ci: { _tag: 'Passed', evidence: [] },
  }
}

describe('stats range', () => {
  it('parses exact instants and rejects a reversed range', () => {
    expect(parseStatsRange({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-08T00:00:00.000Z',
      timeZone: 'Australia/Melbourne',
    })).toEqual({
      _tag: 'Ok',
      value: {
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-08T00:00:00.000Z',
        timeZone: 'Australia/Melbourne',
      },
    })
    expect(parseStatsRange({
      from: '2026-08-08T00:00:00.000Z',
      to: '2026-08-01T00:00:00.000Z',
      timeZone: 'Australia/Melbourne',
    })).toEqual({ _tag: 'Err', error: { _tag: 'EmptyRange' } })
  })
})

describe('stats aggregation', () => {
  it('counts delivered outcomes without treating commits as unique pull requests', () => {
    const range = {
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-08T00:00:00.000Z',
      timeZone: 'Australia/Melbourne',
    }
    const snapshot = buildStats({
      generatedAt: '2026-08-08T00:00:00.000Z',
      range,
      triageCoverageStartedAt: '2026-08-02T00:00:00.000Z',
      facts: [
        { _tag: 'Publication', at: '2026-07-31T23:00:00.000Z', repository: 'harlan-zw/example', itemNumber: 20, work: 'review_fix', changedFiles: 1 },
        { _tag: 'Publication', at: '2026-08-01T15:00:00.000Z', repository: 'harlan-zw/example', itemNumber: 24, work: 'review_fix', changedFiles: 2 },
        { _tag: 'Publication', at: '2026-08-02T15:00:00.000Z', repository: 'harlan-zw/example', itemNumber: 24, work: 'review_fix', changedFiles: 1 },
        { _tag: 'Publication', at: '2026-08-03T15:00:00.000Z', repository: 'harlan-zw/example', itemNumber: 24, work: 'conflict_resolution', changedFiles: 3 },
        { _tag: 'Publication', at: '2026-08-04T15:00:00.000Z', repository: 'harlan-zw/example', itemNumber: 24, work: 'baseline_repair', changedFiles: 1 },
        { _tag: 'Review', at: '2026-08-02T16:00:00.000Z', startedAt: '2026-08-02T15:50:00.000Z', outcome: 'Blocked', findings: 2 },
        { _tag: 'Task', at: '2026-08-02T15:10:00.000Z', startedAt: '2026-08-02T15:00:00.000Z', work: 'review_fix', outcome: 'Completed' },
        { _tag: 'Task', at: '2026-08-03T15:10:00.000Z', startedAt: null, work: 'conflict_resolution', outcome: 'ActionRequired' },
        { _tag: 'PullRequestTriage', at: '2026-08-02T12:00:00.000Z', startedAt: '2026-08-02T11:59:55.000Z', outcome: 'ReviewSkipped' },
      ],
    })

    expect(snapshot.summary).toEqual({
      changedPullRequests: { value: 1, previous: 1 },
      conflictResolutions: { value: 1, previous: 0 },
      fixCommits: { value: 2, previous: 1 },
      openedPullRequests: { value: 1, previous: 0 },
      reviewFindings: { value: 2, previous: 0 },
    })
    expect(snapshot.days.find(day => day.date === '2026-08-03')).toEqual({
      date: '2026-08-03',
      conflictResolutions: 0,
      fixCommits: 1,
      openedPullRequests: 0,
      reviewFindings: 2,
    })
    expect(snapshot.work.find(work => work._tag === 'PullRequestTriage')).toEqual({
      _tag: 'PullRequestTriage',
      runs: 1,
      reviewRequired: 0,
      reviewSkipped: 1,
      reviewRequiredAfterFailure: 0,
      medianDurationMs: 5_000,
    })
    expect(snapshot.coverage.pullRequestTriage).toEqual({
      _tag: 'Partial',
      startedAt: '2026-08-02T00:00:00.000Z',
    })
  })
})

describe('pull request triage Stats', () => {
  it('records one final decision for one pull request head commit', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-01T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'stats-triage',
      observedAt: '2026-08-02T00:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a pull request Revision.')
    const task = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-02T00:01:00.000Z', 60_000)
    if (task === null)
      throw new Error('Expected the Review Task.')
    const input = {
      taskId: task.id,
      repository: task.repository,
      pullRequestNumber: task.pullRequestNumber,
      revisionId: task.revisionId,
      headSha: task.pullRequest.headSha,
      startedAt: '2026-08-02T00:01:01.000Z',
      completedAt: '2026-08-02T00:01:02.000Z',
      outcome: { _tag: 'ReviewSkipped' as const, reason: 'Only prose changed.' },
    }

    expect(store.getLatestPullRequestTriageRun(task.repository, task.pullRequestNumber, task.pullRequest.headSha)).toBeNull()
    expect(store.recordPullRequestTriageRun(input)).toEqual({ _tag: 'Inserted' })
    expect(store.getLatestPullRequestTriageRun(task.repository, task.pullRequestNumber, task.pullRequest.headSha)).toEqual({
      outcome: 'ReviewSkipped',
      reason: 'Only prose changed.',
      completedAt: '2026-08-02T00:01:02.000Z',
    })
    expect(store.getLatestPullRequestTriageRun(task.repository, task.pullRequestNumber, 'f'.repeat(40))).toBeNull()
    expect(store.recordPullRequestTriageRun({
      ...input,
      startedAt: '2026-08-02T00:02:01.000Z',
      completedAt: '2026-08-02T00:02:02.000Z',
    })).toEqual({ _tag: 'Duplicate' })
    expect(store.recordPullRequestTriageRun({
      ...input,
      startedAt: '2026-08-02T00:03:01.000Z',
      completedAt: '2026-08-02T00:03:02.000Z',
      outcome: { _tag: 'ReviewSkipped' as const, reason: 'A retry reworded the same skip verdict.' },
    })).toEqual({ _tag: 'Duplicate' })
    expect(store.recordPullRequestTriageRun({
      ...input,
      outcome: { _tag: 'ReviewRequired', reason: 'Runtime code changed.' },
    })).toEqual({ _tag: 'Conflict' })
    const stats = store.getStats({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-08T00:00:00.000Z',
      timeZone: 'UTC',
    }, '2026-08-08T00:00:00.000Z')

    expect(stats.work.find(work => work._tag === 'PullRequestTriage')).toEqual(expect.objectContaining({
      runs: 1,
      reviewSkipped: 1,
    }))
  })
})

describe('journal Stats evidence', () => {
  it('counts a Publication only after it publishes', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'stats-conflict',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'conflicting' }),
    })
    const task = store.claimNextConflictTask('repair-agent', '2026-08-13T01:01:00.000Z', 10 * 60_000)
    if (task === null)
      throw new Error('Expected conflict resolution work.')
    const staged = store.stagePublication({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:02:00.000Z',
      publication: {
        _tag: 'UpdatePullRequest',
        taskKind: 'resolve_conflict',
        pullRequestNumber: task.pullRequestNumber,
        commitSha: 'resolved-commit',
        baseSha: task.pullRequest.baseSha,
        baseRef: task.pullRequest.baseRef ?? 'main',
        expectedHeadSha: task.pullRequest.headSha,
        headRef: task.pullRequest.headRef,
        artifactRef: 'refs/harlan-github-agent/publications/stats-conflict',
        patchDigest: 'stats-patch',
        changedFiles: 3,
      },
    })
    if (staged._tag !== 'Staged')
      throw new Error(`Expected a staged Publication: ${JSON.stringify(staged)}`)
    const range = { from: '2026-08-13T00:00:00.000Z', to: '2026-08-14T00:00:00.000Z', timeZone: 'UTC' }

    expect(store.getStats(range, range.to).summary.conflictResolutions.value).toBe(0)

    const claimed = store.claimNextPublication('publisher', '2026-08-13T01:03:00.000Z', 60_000)
    if (claimed === null)
      throw new Error('Expected the Publication command.')
    expect(store.completePublication({
      commandId: claimed.id,
      workerId: claimed.workerId,
      fence: claimed.fence,
      at: '2026-08-13T01:04:00.000Z',
      evidence: 'Updated pull request #24.',
    })).toBe(true)
    expect(store.getStats(range, range.to).summary).toEqual(expect.objectContaining({
      changedPullRequests: { value: 1, previous: 0 },
      conflictResolutions: { value: 1, previous: 0 },
    }))
  })

  it('counts one settled Review once', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'stats-settlement',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a pull request Revision.')
    const task = store.claimNextAdversarialReviewTask('reviewer', '2026-08-13T01:01:00.000Z', 60_000)
    if (task === null)
      throw new Error('Expected Review work.')
    store.completeWorkerTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: '2026-08-13T01:02:00.000Z', evidence: 'review-run' })
    const pendingGates = passedReviewGates()
    pendingGates.ci = { _tag: 'Pending', reason: 'Required checks are running.', evidence: [] }
    const review = {
      repository: task.repository,
      pullRequestNumber: task.pullRequestNumber,
      revisionId: task.revisionId,
      headSha: task.pullRequest.headSha,
      provider: 'codex' as const,
      sessionId: 'stats-session',
      model: 'gpt-5.6-sol',
      agentVersion: '1.0.0',
      skillDigest: 'f'.repeat(64),
      startedAt: '2026-08-13T01:01:00.000Z',
      usage: { _tag: 'Unavailable' as const },
      confidence: 90,
      findings: [],
    }
    store.recordReviewRun({ ...review, id: 'stats-pending', completedAt: '2026-08-13T01:02:00.000Z', gates: pendingGates })
    store.supersedeReviewRun({
      ...review,
      id: 'stats-settlement',
      supersedesReviewRunId: 'stats-pending',
      completedAt: '2026-08-13T01:03:00.000Z',
      gates: passedReviewGates(),
      publication: {
        id: 'stats-publication',
        body: '### 🤖 READY',
        at: '2026-08-13T01:03:00.000Z',
        result: { _tag: 'Published', githubCommentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' },
      },
    })

    const stats = store.getStats({
      from: '2026-08-13T00:00:00.000Z',
      to: '2026-08-14T00:00:00.000Z',
      timeZone: 'UTC',
    }, '2026-08-14T00:00:00.000Z')
    expect(stats.work.find(work => work._tag === 'Review')).toEqual(expect.objectContaining({ runs: 1 }))
  })
})
