import type { GitHubCheck } from '../src/github-agent-source.ts'
import type { ReviewGateRefresh } from '../src/store.ts'
import type { ReviewGates } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { refreshControllerGates } from '../src/item-agent.ts'
import { ok } from '../src/result.ts'
import { refreshReviewGates } from '../src/review-gate-sweep.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []

function passed(label: string) {
  return { _tag: 'Passed' as const, evidence: [{ label, sha256: 'a'.repeat(64) }] }
}

function pendingControllerGates(): ReviewGates {
  return {
    merge: passed('mergeability'),
    review: passed('review'),
    ci: {
      _tag: 'Pending',
      reason: 'Base branch CI: deploy (pro-admin) is still running.',
      evidence: [{ label: 'base-ci', sha256: 'b'.repeat(64) }],
    },
  }
}

function gateRefresh(overrides: Partial<ReviewGateRefresh> = {}): ReviewGateRefresh {
  return {
    reviewRunId: 'run-1',
    repository: 'harlan-zw/example',
    pullRequestNumber: 24,
    revisionId: 'revision-1',
    headSha: 'abc123',
    provider: 'codex',
    sessionId: 'session-1',
    model: 'gpt-5.6-sol',
    agentVersion: '0.0.0',
    skillDigest: 'c'.repeat(64),
    startedAt: '2026-08-27T08:11:00.000Z',
    completedAt: '2026-08-27T08:20:00.000Z',
    usage: { _tag: 'Unavailable' },
    gates: pendingControllerGates(),
    findings: [],
    confidence: 88,
    commentId: 42,
    publishedBody: '### 🤖 PENDING',
    ...overrides,
  }
}

function check(overrides: Partial<GitHubCheck> = {}): GitHubCheck {
  return {
    name: 'deploy (pro-admin)',
    status: 'completed',
    conclusion: 'success',
    source: { _tag: 'CheckRun', appId: 1 },
    failure: { _tag: 'Unknown' },
    startedAt: '2026-08-27T08:23:00.000Z',
    ...overrides,
  } as GitHubCheck
}

function snapshot(baseChecks: GitHubCheck[], headChecks: GitHubCheck[] = [check({ name: 'code' })]) {
  return ok({
    baseChecks: { _tag: 'Available' as const, checks: baseChecks },
    body: '',
    checks: { _tag: 'Available' as const, checks: headChecks },
    comments: [],
    priorAutomatedReview: { _tag: 'None' as const },
    pullRequest: pullRequestItem({ headSha: 'abc123', mergeState: 'clean' }),
    requiredChecks: { _tag: 'None' as const },
    reviews: [],
  })
}

interface Recorded {
  edited?: { commentId: number, expectedBody: string, body: string }
  failed: Array<{ reviewRunId: string, reason: string }>
  staged: Array<{ reviewRunId: string, outcome: string, ci: string, reconciliationId?: string, body: string }>
  stamped: string[]
}

function harness(options: {
  review?: ReviewGateRefresh
  live?: ReturnType<typeof snapshot>
  edit?: () => Promise<any>
}) {
  const recorded: Recorded = { failed: [], staged: [], stamped: [] }
  const run = async () => refreshReviewGates({
    github: {
      getPullRequestReviewSnapshot: () => Promise.resolve(options.live ?? snapshot([check()])),
      editReviewStatus: (_repository, _number, commentId, expectedBody, body) => {
        recorded.edited = { commentId, expectedBody, body }
        return options.edit?.() ?? Promise.resolve(ok({
          _tag: 'Edited',
          commentId: 42,
          url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
        }))
      },
      stampAgentLabel: (_repository, _number, outcome) => {
        recorded.stamped.push(outcome)
        return Promise.resolve(ok(undefined))
      },
    },
    now: () => new Date('2026-08-27T11:15:00.000Z'),
    repositories: [repositoryMapping()],
    store: {
      listReviewGateRefreshes: () => [options.review ?? gateRefresh()],
      recordReviewPublication: (input) => {
        if (input.result._tag === 'Failed')
          recorded.failed.push({ reviewRunId: input.reviewRunId, reason: input.result.reason })
        return { _tag: 'Inserted', publicationId: input.id }
      },
      stageReviewGateStatus: (input) => {
        recorded.staged.push({
          reviewRunId: input.reviewRunId,
          outcome: input.desiredOutcome,
          ci: input.gates.ci._tag,
          ...(input.reconciliationId === undefined ? {} : { reconciliationId: input.reconciliationId }),
          body: input.body,
        })
        return { _tag: 'Staged', commandId: 'status-1' }
      },
    },
  }, new AbortController().signal)
  return { recorded, run }
}

describe('refreshReviewGates', () => {
  it('turns a review waiting on base branch CI into READY once CI passes', async () => {
    const { recorded, run } = harness({})

    const results = await run()

    expect(results).toEqual([ok({
      _tag: 'PublicationQueued',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      outcome: 'READY',
    })])
    expect(recorded.edited).toBeUndefined()
    expect(recorded.staged[0]?.body).toContain('### 🤖 READY · 88/100')
    expect(recorded.staged[0]?.body).not.toContain('Waiting:')
    expect(recorded.stamped).toEqual([])
  })

  it('stages one projection for the existing Agent run', async () => {
    const { recorded, run } = harness({})

    await run()

    expect(recorded.staged).toEqual([{
      reviewRunId: 'run-1',
      outcome: 'READY',
      ci: 'Passed',
      body: expect.stringContaining('### 🤖 READY'),
    }])
  })

  it('leaves the comment alone while base branch CI is still running', async () => {
    const live = snapshot([check({ status: 'in_progress', conclusion: null })])
    if (live._tag !== 'Ok')
      throw new Error('Expected a Review snapshot.')
    const { recorded, run } = harness({
      live,
      review: gateRefresh({
        gates: refreshControllerGates(pendingControllerGates(), live.value, repositoryMapping()).gates,
      }),
    })

    const results = await run()

    expect(results).toEqual([ok({
      _tag: 'Unchanged',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      outcome: 'PENDING',
      reason: 'Base branch CI: deploy (pro-admin) is still running.',
    })])
    expect(recorded.edited).toEqual({
      commentId: 42,
      expectedBody: '### 🤖 PENDING',
      body: '### 🤖 PENDING',
    })
    expect(recorded.staged).toEqual([])
    expect(recorded.stamped).toEqual(['PENDING'])
  })

  it('reports BLOCKED when the fresh CI read fails', async () => {
    const { recorded, run } = harness({
      live: snapshot([check()], [check({ name: 'code', conclusion: 'failure' })]),
    })

    const results = await run()

    expect(results).toEqual([ok({
      _tag: 'PublicationQueued',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      outcome: 'BLOCKED',
    })])
    expect(recorded.staged[0]?.body).toContain('### 🤖 BLOCKED')
    // The score belongs to a passing verdict, so a blocked one never names it.
    expect(recorded.staged[0]?.body).not.toContain('88/100')
    expect(recorded.stamped).toEqual([])
  })

  it('leaves a pull request whose head commit moved to its own review', async () => {
    const moved = snapshot([check()])
    if (moved._tag !== 'Ok')
      throw new Error('Expected a snapshot.')
    const { recorded, run } = harness({
      live: ok({ ...moved.value, pullRequest: pullRequestItem({ headSha: 'def456', mergeState: 'clean' }) }),
    })

    const results = await run()

    expect(results).toEqual([ok({
      _tag: 'Superseded',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
    })])
    expect(recorded.edited).toBeUndefined()
    expect(recorded.staged).toEqual([])
  })

  it('publishes BLOCKED when the merge gate becomes conflicting', async () => {
    const conflicted = snapshot([check()])
    if (conflicted._tag !== 'Ok')
      throw new Error('Expected a snapshot.')
    const { recorded, run } = harness({
      live: ok({ ...conflicted.value, pullRequest: pullRequestItem({ headSha: 'abc123', mergeState: 'conflicting' }) }),
    })

    const results = await run()

    expect(results).toEqual([ok({
      _tag: 'PublicationQueued',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      outcome: 'BLOCKED',
    })])
    expect(recorded.staged[0]?.body).toContain('**Merge gate:** BLOCKED. The pull request has merge conflicts.')
    expect(recorded.staged).toHaveLength(1)
    expect(recorded.stamped).toEqual([])
  })

  it('queues reconciliation when the canonical comment is missing', async () => {
    const live = snapshot([check({ status: 'in_progress', conclusion: null })])
    if (live._tag !== 'Ok')
      throw new Error('Expected a Review snapshot.')
    const { recorded, run } = harness({
      live,
      review: gateRefresh({
        gates: refreshControllerGates(pendingControllerGates(), live.value, repositoryMapping()).gates,
      }),
      edit: () => Promise.resolve(ok({ _tag: 'Missing' })),
    })

    const results = await run()

    expect(results).toEqual([ok({
      _tag: 'PublicationQueued',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      outcome: 'PENDING',
    })])
    expect(recorded.stamped).toEqual([])
    expect(recorded.staged[0]?.reconciliationId).toContain('Missing:42:')
  })

  it('retires the Review instead of staging a status when another actor owns the comment', async () => {
    const live = snapshot([check({ status: 'in_progress', conclusion: null })])
    if (live._tag !== 'Ok')
      throw new Error('Expected a Review snapshot.')
    const reason = 'The stored automated review comment belongs to another GitHub actor.' as const
    const { recorded, run } = harness({
      live,
      review: gateRefresh({
        gates: refreshControllerGates(pendingControllerGates(), live.value, repositoryMapping()).gates,
      }),
      edit: () => Promise.resolve(ok({ _tag: 'Foreign', reason })),
    })

    const results = await run()

    expect(results).toEqual([ok({ _tag: 'Retired', repository: 'harlan-zw/example', pullRequestNumber: 24, reason })])
    expect(recorded.staged).toEqual([])
    expect(recorded.stamped).toEqual([])
    expect(recorded.failed).toEqual([{ reviewRunId: 'run-1', reason }])
  })
})

describe('refreshReviewGates against the journal store', () => {
  afterEach(() => {
    stores.splice(0).forEach(store => store.close())
  })

  it('settles a merge gate frozen as Pending once GitHub reports the pull request mergeable', async () => {
    const store = openJournalStore(':memory:')
    stores.push(store)
    store.syncRepositories([repositoryMapping()], '2026-08-27T08:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'merge-pending-pr',
      observedAt: '2026-08-27T08:01:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    const reviewTask = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-27T08:02:00.000Z', 60_000)
    if (reviewTask === null)
      throw new Error('Expected a Review Task.')
    store.completeWorkerTask({
      taskId: reviewTask.id,
      workerId: reviewTask.state.workerId,
      fence: reviewTask.state.fence,
      at: '2026-08-27T08:02:30.000Z',
      evidence: 'run-pending',
    })

    const gates = pendingControllerGates()
    gates.merge = { _tag: 'Pending', reason: 'GitHub has not resolved mergeability.', evidence: [{ label: 'mergeability', sha256: 'd'.repeat(64) }] }
    expect(store.recordReviewRun({
      id: 'run-pending',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      headSha: 'abc123',
      provider: 'codex',
      sessionId: 'session-1',
      model: 'gpt-5.6-sol',
      agentVersion: '0.0.0',
      skillDigest: 'c'.repeat(64),
      startedAt: '2026-08-27T08:11:00.000Z',
      completedAt: '2026-08-27T08:20:00.000Z',
      usage: { _tag: 'Available', input: 10, cachedInput: 0, cacheWrite: 0, output: 5, reasoning: 0 },
      gates,
      confidence: 88,
      findings: [],
    })).toEqual({ _tag: 'Inserted', reviewRunId: 'run-pending' })
    expect(store.recordReviewPublication({
      id: 'publication-pending',
      reviewRunId: 'run-pending',
      body: '### 🤖 PENDING',
      at: '2026-08-27T08:21:00.000Z',
      result: { _tag: 'Published', githubCommentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' },
    })).toEqual({ _tag: 'Inserted', publicationId: 'publication-pending' })

    const stamped: string[] = []
    const results = await refreshReviewGates({
      github: {
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot([check()])),
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' })),
        stampAgentLabel: (_repository, _number, outcome) => {
          stamped.push(outcome)
          return Promise.resolve(ok(undefined))
        },
      },
      now: () => new Date('2026-08-27T11:15:00.000Z'),
      repositories: [repositoryMapping()],
      store,
    }, new AbortController().signal)

    expect(results).toEqual([ok({
      _tag: 'PublicationQueued',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      outcome: 'READY',
    })])
    expect(stamped).toEqual([])
    expect(store.listReviewGateRefreshes()).toEqual([expect.objectContaining({
      reviewRunId: expect.any(String),
      confidence: 88,
    })])
    const settledRun = store.getDashboardSnapshot('2026-08-27T11:16:00.000Z')
      .agents
      .find(agent => agent._tag === 'ReviewAgent')
    if (settledRun?._tag !== 'ReviewAgent')
      throw new Error('Expected the settled Review run on the dashboard.')
    expect(settledRun.id).toBe('run-pending')
    expect(settledRun.startedAt).toBe('2026-08-27T08:11:00.000Z')
    expect(settledRun.completedAt).toBe('2026-08-27T08:20:00.000Z')
    expect(settledRun.outcome).toEqual({ _tag: 'Ready', confidence: 88 })
    expect(settledRun.gates.merge._tag).toBe('Passed')
    expect(store.listWorkflowEvents({ stream: 'review_gate', limit: 10 })).toMatchObject([
      {
        event: 'Projected',
        entityId: 'run-pending',
        from: 'Pending',
        to: 'Ready',
        usage: null,
      },
    ])
    const publication = store.claimNextTerminalReviewStatus(
      'status-publisher-1',
      '2026-08-27T11:16:00.000Z',
      60_000,
    )
    expect(publication).toMatchObject({
      reviewRunId: 'run-pending',
      desiredOutcome: 'READY',
      body: expect.stringContaining('### 🤖 READY'),
    })
  })

  it('keeps one journal entry when controller gates refresh', async () => {
    const store = openJournalStore(':memory:')
    stores.push(store)
    store.syncRepositories([repositoryMapping()], '2026-08-27T08:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'ci-pending-pr',
      observedAt: '2026-08-27T08:01:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    const task = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-27T08:01:30.000Z', 60_000)
    if (task === null)
      throw new Error('Expected the queued Review Task.')
    store.completeWorkerTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: '2026-08-27T08:02:00.000Z', evidence: 'review-run' })

    expect(store.recordReviewRun({
      id: 'run-pending',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      headSha: 'abc123',
      provider: 'codex',
      sessionId: 'session-1',
      model: 'gpt-5.6-sol',
      agentVersion: '0.0.0',
      skillDigest: 'c'.repeat(64),
      startedAt: '2026-08-27T08:11:00.000Z',
      completedAt: '2026-08-27T08:20:00.000Z',
      usage: { _tag: 'Available', input: 10, cachedInput: 0, cacheWrite: 0, output: 5, reasoning: 0 },
      gates: pendingControllerGates(),
      confidence: 88,
      findings: [],
    })).toEqual({ _tag: 'Inserted', reviewRunId: 'run-pending' })
    expect(store.recordReviewPublication({
      id: 'publication-pending',
      reviewRunId: 'run-pending',
      body: '### 🤖 PENDING',
      at: '2026-08-27T08:21:00.000Z',
      result: { _tag: 'Published', githubCommentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' },
    })).toEqual({ _tag: 'Inserted', publicationId: 'publication-pending' })

    const results = await refreshReviewGates({
      github: {
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot([check()])),
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Changed' })),
        stampAgentLabel: () => Promise.resolve(ok(undefined)),
      },
      now: () => new Date('2026-08-27T11:15:00.000Z'),
      repositories: [repositoryMapping()],
      store,
    }, new AbortController().signal)

    expect(results).toEqual([ok({
      _tag: 'PublicationQueued',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      outcome: 'READY',
    })])
    expect(store.listReviewGateRefreshes()).toHaveLength(1)

    const reviewAgents = store.getDashboardSnapshot('2026-08-27T11:16:00.000Z')
      .agents
      .filter(agent => agent._tag === 'ReviewAgent')
    if (reviewAgents.length !== 1)
      throw new Error(`Expected exactly one Review run card, not ${reviewAgents.length}.`)
    const settledRun = reviewAgents[0]
    if (settledRun?._tag !== 'ReviewAgent')
      throw new Error('Expected the settled Review run on the dashboard.')
    expect(settledRun.outcome).toEqual({ _tag: 'Ready', confidence: 88 })
    expect(settledRun.gates.ci._tag).toBe('Passed')
    expect(settledRun.usage).toEqual({ _tag: 'Available', input: 10, cachedInput: 0, cacheWrite: 0, output: 5, reasoning: 0 })
  })
})
