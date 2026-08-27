import type { GitHubCheck } from '../src/github-agent-source.ts'
import type { CiPendingReview } from '../src/store.ts'
import type { ReviewGates } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { publishResolvedCiReviews } from '../src/review-ci-sweep.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

function passed(label: string) {
  return { _tag: 'Passed' as const, evidence: [{ label, sha256: 'a'.repeat(64) }] }
}

function waitingOnBaseCi(): ReviewGates {
  return {
    head: passed('head'),
    merge: passed('mergeability'),
    metadata: passed('metadata'),
    review: passed('review'),
    verification: passed('verification'),
    ci: {
      _tag: 'Pending',
      reason: 'Base branch CI: deploy (pro-admin) is still running.',
      evidence: [{ label: 'base-ci', sha256: 'b'.repeat(64) }],
    },
  }
}

function pendingReview(overrides: Partial<CiPendingReview> = {}): CiPendingReview {
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
    gates: waitingOnBaseCi(),
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
  runs: Array<{ id: string, confidence: number | undefined, ci: string }>
  stamped: string[]
}

function harness(options: {
  review?: CiPendingReview
  live?: ReturnType<typeof snapshot>
  edit?: () => Promise<any>
}) {
  const recorded: Recorded = { runs: [], stamped: [] }
  const run = async () => publishResolvedCiReviews({
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
      stampReviewOutcome: (_repository, _number, outcome) => {
        recorded.stamped.push(outcome)
        return Promise.resolve(ok(undefined))
      },
    },
    now: () => new Date('2026-08-27T11:15:00.000Z'),
    repositories: [repositoryMapping()],
    store: {
      listCiPendingReviews: () => [options.review ?? pendingReview()],
      recordReviewRun: (input) => {
        recorded.runs.push({ id: input.id, confidence: input.confidence, ci: input.gates.ci._tag })
        return { _tag: 'Inserted', reviewRunId: input.id }
      },
      recordReviewPublication: input => ({ _tag: 'Inserted', publicationId: input.id }),
    },
  }, new AbortController().signal)
  return { recorded, run }
}

describe('publishResolvedCiReviews', () => {
  it('turns a review waiting on base branch CI into READY once CI passes', async () => {
    const { recorded, run } = harness({})

    const results = await run()

    expect(results).toEqual([ok({
      _tag: 'Republished',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      outcome: 'READY',
    })])
    expect(recorded.edited?.commentId).toBe(42)
    expect(recorded.edited?.expectedBody).toBe('### 🤖 PENDING')
    expect(recorded.edited?.body).toContain('### 🤖 READY · 88/100')
    expect(recorded.edited?.body).not.toContain('Waiting:')
    expect(recorded.stamped).toEqual(['READY'])
  })

  it('records the settled verdict so auto merge reads it', async () => {
    const { recorded, run } = harness({})

    await run()

    expect(recorded.runs).toEqual([{ id: expect.any(String), confidence: 88, ci: 'Passed' }])
    expect(recorded.runs[0]?.id).not.toBe('run-1')
  })

  it('leaves the comment alone while base branch CI is still running', async () => {
    const { recorded, run } = harness({
      live: snapshot([check({ status: 'in_progress', conclusion: null })]),
    })

    const results = await run()

    expect(results).toEqual([ok({
      _tag: 'StillWaiting',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      reason: 'Base branch CI: deploy (pro-admin) is still running.',
    })])
    expect(recorded.edited).toBeUndefined()
    expect(recorded.runs).toEqual([])
  })

  it('reports BLOCKED when the fresh CI read fails', async () => {
    const { recorded, run } = harness({
      live: snapshot([check()], [check({ name: 'code', conclusion: 'failure' })]),
    })

    const results = await run()

    expect(results).toEqual([ok({
      _tag: 'Republished',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      outcome: 'BLOCKED',
    })])
    expect(recorded.edited?.body).toContain('### 🤖 BLOCKED')
    // The score belongs to a passing verdict, so a blocked one never names it.
    expect(recorded.edited?.body).not.toContain('88/100')
    expect(recorded.stamped).toEqual(['BLOCKED'])
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
    expect(recorded.runs).toEqual([])
  })

  it('writes nothing when a person deleted the canonical comment', async () => {
    const { recorded, run } = harness({
      edit: () => Promise.resolve(ok({ _tag: 'Missing' })),
    })

    const results = await run()

    expect(results).toEqual([ok({
      _tag: 'CommentGone',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
    })])
    expect(recorded.stamped).toEqual([])
  })
})
