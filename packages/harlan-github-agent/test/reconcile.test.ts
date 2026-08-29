import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { reconcileRepository } from '../src/reconcile.ts'
import { err, ok } from '../src/result.ts'
import { AGENT_ACTOR_LOGIN } from '../src/review-comment.ts'
import { openJournalStore } from '../src/store.ts'
import { issueItem, pullRequestItem, repositoryMapping } from './fixtures.ts'

const noPullRequestRead = {
  getPullRequest: () => Promise.reject(new Error('No pull request should need a final read.')),
}

describe('gitHub reconciliation', () => {
  it('ignores issues authored by automated accounts', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')

    const result = await reconcileRepository(repository, {
      github: { ...noPullRequestRead, listOpenItems: () => Promise.resolve(ok([issueItem({ author: 'github-actions[bot]' })])) },
      store,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
    })

    expect(result).toEqual({
      _tag: 'Ok',
      value: { repository: repository.github, subjects: 0, inserted: 0, duplicates: 0, stale: 0, closed: 0 },
    })
    expect(store.getDashboardSnapshot('2026-08-13T01:00:00.000Z').items).toEqual([])
    store.close()
  })

  it('closes an allowed bot issue and clears its failed triage incident', async () => {
    const store = openJournalStore(':memory:')
    const botIssue = issueItem({ author: AGENT_ACTOR_LOGIN })
    const repository = repositoryMapping({ writablePullRequestAuthors: ['harlan-zw', AGENT_ACTOR_LOGIN] })
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'allowed-bot-issue',
      observedAt: '2026-08-13T00:01:00.000Z',
      source: 'poll',
      subject: botIssue,
    })

    for (const attempt of [1, 2, 3]) {
      const at = `2026-08-13T00:01:0${attempt}.000Z`
      const task = store.claimNextIssueTriageTask(`worker-${attempt}`, at, 10_000)
      if (task === null)
        throw new Error(`Expected Issue triage attempt ${attempt}.`)
      store.failWorkerTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        reason: 'The issue changed before triage started.',
      })
    }
    expect(store.listIncidents()).toHaveLength(1)

    const result = await reconcileRepository(repository, {
      github: { ...noPullRequestRead, listOpenItems: () => Promise.resolve(ok([botIssue])) },
      store,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
    })

    expect(result).toEqual({
      _tag: 'Ok',
      value: { repository: repository.github, subjects: 0, inserted: 0, duplicates: 0, stale: 0, closed: 1 },
    })
    expect(store.resolveStaleTaskIncidents('2026-08-13T01:00:01.000Z')).toBe(1)
    expect(store.listIncidents()).toEqual([])
    store.close()
  })

  it('keeps a Routine candidate issue eligible for Issue triage', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')

    const result = await reconcileRepository(repository, {
      github: { ...noPullRequestRead, listOpenItems: () => Promise.resolve(ok([
        issueItem({ number: 41, author: AGENT_ACTOR_LOGIN, routineFiled: true, url: 'https://github.com/harlan-zw/example/issues/41' }),
      ])) },
      store,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
    })

    expect(result).toEqual({
      _tag: 'Ok',
      value: { repository: repository.github, subjects: 1, inserted: 1, duplicates: 0, stale: 0, closed: 0 },
    })
    expect(store.claimNextIssueTriageTask('triage', '2026-08-13T01:00:01.000Z', 10_000)).not.toBeNull()
    store.close()
  })

  it('keeps an orphaned Routine tracking issue out of Issue triage', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    const trackingIssue = issueItem({
      number: 42,
      author: AGENT_ACTOR_LOGIN,
      title: 'sentry-checkin: run log for harlan-zw/example',
      routineFiled: true,
    })
    store.recordObservation({
      externalId: 'orphaned-routine-tracking-issue',
      observedAt: '2026-08-13T00:01:00.000Z',
      source: 'poll',
      subject: trackingIssue,
    })
    for (const attempt of [1, 2, 3]) {
      const at = `2026-08-13T00:01:0${attempt}.000Z`
      const task = store.claimNextIssueTriageTask(`triage-${attempt}`, at, 10_000)
      if (task === null)
        throw new Error(`Expected Issue triage attempt ${attempt}.`)
      store.failWorkerTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        reason: 'The issue changed before triage started.',
      })
    }
    expect(store.listIncidents()).toHaveLength(1)

    const result = await reconcileRepository(repository, {
      github: { ...noPullRequestRead, listOpenItems: () => Promise.resolve(ok([
        { ...trackingIssue, routineTracking: true },
      ])) },
      store,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
    })

    expect(result).toEqual({
      _tag: 'Ok',
      value: { repository: repository.github, subjects: 1, inserted: 1, duplicates: 0, stale: 0, closed: 0 },
    })
    expect(store.claimNextIssueTriageTask('triage', '2026-08-13T01:00:01.000Z', 10_000)).toBeNull()
    expect(store.listIncidents()).toEqual([])
    store.close()
  })

  it('counts only open pull requests in enabled repositories', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    expect(store.countOpenPullRequests()).toBe(0)

    const github = {
      ...noPullRequestRead,
      listOpenItems: () => Promise.resolve(ok([
        pullRequestItem({ number: 24 }),
        pullRequestItem({ number: 25 }),
        issueItem({ number: 12, author: 'harlan-zw' }),
      ])),
    }
    await reconcileRepository(repository, { github, store, now: () => new Date('2026-08-13T01:00:00.000Z') })
    expect(store.countOpenPullRequests()).toBe(2)

    // A pull request that disappears from the open list closes, so it stops counting.
    await reconcileRepository(repository, {
      github: {
        getPullRequest: () => Promise.resolve(ok({
          ...pullRequestItem({ number: 25 }),
          state: 'closed' as const,
          mergedAt: null,
        })),
        listOpenItems: () => Promise.resolve(ok([pullRequestItem({ number: 24 })])),
      },
      store,
      now: () => new Date('2026-08-13T02:00:00.000Z'),
    })
    expect(store.countOpenPullRequests()).toBe(1)

    store.syncRepositories([{ ...repository, enabled: false }], '2026-08-13T03:00:00.000Z')
    expect(store.countOpenPullRequests()).toBe(0)
    store.close()
  })

  it('reads a missing pull request before recording its final GitHub state', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'pull-request-before-merge',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequest,
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected the open pull request.')
    const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:01:00.000Z', 600_000)
    if (review === null)
      throw new Error('Expected the Review Task.')
    const staged = store.stageReviewStatus({
      taskKind: 'adversarial_review',
      phase: 'terminal',
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:02:00.000Z',
      revisionId: review.revisionId,
      expectedHeadSha: pullRequest.headSha,
      body: '### 🤖 PENDING',
    })
    if (staged._tag === 'Rejected')
      throw new Error(staged.reason)
    const command = store.claimReviewStatus(staged.commandId, 'status-agent', '2026-08-13T01:02:01.000Z', 60_000)
    if (command === null)
      throw new Error('Expected the review status command.')
    store.completeReviewStatus({
      commandId: command.id,
      workerId: command.workerId,
      fence: command.fence,
      at: '2026-08-13T01:02:02.000Z',
      commentId: 42,
      url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
    })
    store.completeWorkerTask({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:02:03.000Z',
      evidence: 'Review completed with a PENDING CI gate.',
    })

    const result = await reconcileRepository(repository, {
      github: {
        listOpenItems: () => Promise.resolve(ok([])),
        getPullRequest: () => Promise.resolve(ok({
          ...pullRequest,
          state: 'closed',
          mergedAt: '2026-08-13T01:03:00.000Z',
          updatedAt: '2026-08-13T01:03:00.000Z',
        })),
      },
      store,
      now: () => new Date('2026-08-13T01:04:00.000Z'),
    })

    expect(result).toEqual({
      _tag: 'Ok',
      value: { repository: repository.github, subjects: 0, inserted: 0, duplicates: 0, stale: 0, closed: 1 },
    })
    expect(store.listStoppedReviews()).toEqual([expect.objectContaining({
      disposition: { _tag: 'Merged' },
      pullRequestNumber: 24,
    })])
    store.close()
  })

  it('keeps a pull request open when its exact final read fails', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'pull-request-before-read-failure',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })

    const result = await reconcileRepository(repository, {
      github: {
        listOpenItems: () => Promise.resolve(ok([])),
        getPullRequest: () => Promise.resolve(err({
          repository: repository.github,
          message: 'GitHub did not return the pull request.',
          status: 503,
        })),
      },
      store,
      now: () => new Date('2026-08-13T01:04:00.000Z'),
    })

    expect(result).toEqual({
      _tag: 'Err',
      error: { repository: repository.github, message: 'GitHub did not return the pull request.' },
    })
    expect(store.countOpenPullRequests()).toBe(1)
    expect(store.getDashboardSnapshot('2026-08-13T01:04:00.000Z').repositories[0]?.lastError)
      .toBe('GitHub did not return the pull request.')
    store.close()
  })

  it('rechecks a legacy CLOSED status before trusting its final state', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'legacy-closure-open',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequest,
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected the open pull request.')
    const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:01:00.000Z', 600_000)
    if (review === null)
      throw new Error('Expected the Review Task.')
    const staged = store.stageReviewStatus({
      taskKind: 'adversarial_review',
      phase: 'review',
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:02:00.000Z',
      revisionId: review.revisionId,
      expectedHeadSha: pullRequest.headSha,
      body: '### 🤖 REVIEWING',
    })
    if (staged._tag === 'Rejected')
      throw new Error(staged.reason)
    const command = store.claimReviewStatus(staged.commandId, 'status-agent', '2026-08-13T01:02:01.000Z', 60_000)
    if (command === null)
      throw new Error('Expected the Review status command.')
    store.completeReviewStatus({
      commandId: command.id,
      workerId: command.workerId,
      fence: command.fence,
      at: '2026-08-13T01:02:02.000Z',
      commentId: 42,
      url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
    })
    store.completeWorkerTask({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:02:03.000Z',
      evidence: 'Review stopped before a final outcome.',
    })
    store.closeMissingItems(repository.github, [], '2026-08-13T01:03:00.000Z')
    expect(store.recordStoppedReviewStatus({
      taskId: review.id,
      taskKind: 'adversarial_review',
      revisionId: observed.revisionId,
      expectedHeadSha: pullRequest.headSha,
      body: '<!-- workflow-state: {"_tag":"PullRequestClosed","headSha":"abc123"} -->\n### 🤖 CLOSED',
      at: '2026-08-13T01:03:01.000Z',
      commentId: 42,
      url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
    })).toBe(true)
    expect(store.listStoppedReviews()).toEqual([expect.objectContaining({ disposition: { _tag: 'Closed' } })])
    let exactReads = 0

    await reconcileRepository(repository, {
      github: {
        listOpenItems: () => Promise.resolve(ok([])),
        getPullRequest: () => {
          exactReads += 1
          return Promise.resolve(ok({
            ...pullRequest,
            state: 'closed',
            mergedAt: '2026-08-13T01:04:00.000Z',
            updatedAt: '2026-08-13T01:04:00.000Z',
          }))
        },
      },
      store,
      now: () => new Date('2026-08-13T01:05:00.000Z'),
    })

    expect(exactReads).toBe(1)
    expect(store.listStoppedReviews()).toEqual([expect.objectContaining({ disposition: { _tag: 'Merged' } })])
    store.close()
  })

  it('records a pull request from an explicitly allowed GitHub App', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping({ writablePullRequestAuthors: ['harlan-zw', 'harlan-github-agent[bot]'] })
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')

    const result = await reconcileRepository(repository, {
      github: { ...noPullRequestRead, listOpenItems: () => Promise.resolve(ok([pullRequestItem({ author: 'harlan-github-agent[bot]' })])) },
      store,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
    })

    expect(result).toEqual({
      _tag: 'Ok',
      value: { repository: repository.github, subjects: 1, inserted: 1, duplicates: 0, stale: 0, closed: 0 },
    })
    store.close()
  })

  it('records subjects idempotently and updates poll health', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    const github = { ...noPullRequestRead, listOpenItems: () => Promise.resolve(ok([issueItem()])) }
    const now = () => new Date('2026-08-13T01:00:00.000Z')

    const first = await reconcileRepository(repository, { github, store, now })
    const second = await reconcileRepository(repository, { github, store, now })

    expect(first).toEqual({
      _tag: 'Ok',
      value: { repository: repository.github, subjects: 1, inserted: 1, duplicates: 0, stale: 0, closed: 0 },
    })
    expect(second).toEqual({
      _tag: 'Ok',
      value: { repository: repository.github, subjects: 1, inserted: 0, duplicates: 1, stale: 0, closed: 0 },
    })
    expect(store.getDashboardSnapshot(now().toISOString()).repositories[0]?.lastError).toBeNull()
    store.close()
  })

  it('reconciles Approval labels for issues', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    const issue = issueItem({ approvalLabels: ['review'] })
    const approved: Array<{ kind: string, revisionId: string }> = []
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')

    const result = await reconcileRepository(repository, {
      approvals: {
        reconcile: (_mapping, subject, revisionId) => {
          approved.push({ kind: subject.kind, revisionId })
          return Promise.resolve(ok(undefined))
        },
      },
      github: { ...noPullRequestRead, listOpenItems: () => Promise.resolve(ok([issue])) },
      store,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
    })

    expect(result._tag).toBe('Ok')
    expect(approved).toEqual([{ kind: 'issue', revisionId: expect.stringMatching(/^[a-f\d]{64}$/) }])
    store.close()
  })

  it('surfaces GitHub failures in repository health', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    const github = { ...noPullRequestRead, listOpenItems: () => Promise.resolve(err({ repository: repository.github, message: 'Rate limited' })) }
    const now = () => new Date('2026-08-13T01:00:00.000Z')

    const result = await reconcileRepository(repository, { github, store, now })

    expect(result).toEqual({ _tag: 'Err', error: { repository: repository.github, message: 'Rate limited' } })
    expect(store.getDashboardSnapshot(now().toISOString()).repositories[0]?.lastError).toBe('Rate limited')
    store.close()
  })

  it('does not report shutdown cancellation as repository failure', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    const controller = new AbortController()
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    controller.abort()

    const result = await reconcileRepository(repository, {
      github: { ...noPullRequestRead, listOpenItems: () => Promise.resolve(err({ repository: repository.github, message: 'This operation was aborted' })) },
      store,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      signal: controller.signal,
    })

    expect(result).toEqual({ _tag: 'Err', error: { repository: repository.github, message: 'This operation was aborted' } })
    expect(store.getDashboardSnapshot('2026-08-13T01:00:00.000Z').repositories[0]?.lastError).toBeNull()
    expect(store.listIncidents()).toEqual([])
    store.close()
  })

  it('does not reuse legacy observation identities after revision schema changes', async () => {
    const store = openJournalStore(':memory:')
    const repository = repositoryMapping()
    const incoming = issueItem()
    const legacyExternalId = createHash('sha256')
      .update(`${repository.github}:${incoming.kind}:${incoming.number}:${JSON.stringify(incoming)}`)
      .digest('hex')
    store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: legacyExternalId,
      observedAt: '2026-08-13T00:30:00.000Z',
      source: 'poll',
      subject: issueItem({ title: 'Legacy snapshot' }),
    })

    const result = await reconcileRepository(repository, {
      github: { ...noPullRequestRead, listOpenItems: () => Promise.resolve(ok([incoming])) },
      store,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
    })

    expect(result).toEqual({
      _tag: 'Ok',
      value: { repository: repository.github, subjects: 1, inserted: 1, duplicates: 0, stale: 0, closed: 0 },
    })
    store.close()
  })
})
