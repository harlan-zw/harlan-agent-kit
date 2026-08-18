import type { ReviewWorkerOptions } from '../src/item-agent.ts'
import type { ClaimedAdversarialReviewTask, GitHubPullRequestItem, RecordReviewRunInput, ReviewFixClaim } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { classifyFailure } from '../src/failure.ts'
import { createReviewWorker } from '../src/item-agent.ts'
import { err, ok } from '../src/result.ts'
import { pullRequestItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

const passingGate = { state: 'passed' as const, reason: '', evidence: 'checked' }

function reviewSnapshot(pullRequest: GitHubPullRequestItem, comments: string[] = []) {
  const check = { id: 1, source: { _tag: 'CheckRun' as const, appId: 15368 }, name: 'test', status: 'completed', conclusion: 'success' }
  return {
    baseChecks: { _tag: 'Available' as const, checks: [check] },
    body: 'Fixes the bug.',
    checks: { _tag: 'Available' as const, checks: [check] },
    comments,
    priorAutomatedReview: { _tag: 'None' as const },
    pullRequest,
    requiredChecks: { _tag: 'None' as const },
    reviews: [],
  }
}

function reviewTask(pullRequest: GitHubPullRequestItem): ClaimedAdversarialReviewTask {
  return {
    id: 'review-task',
    kind: 'adversarial_review',
    repository: 'harlan-zw/example',
    pullRequestNumber: 24,
    revisionId: 'revision-1',
    state: { _tag: 'Running', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
    updatedAt: '2026-08-13T01:00:00.000Z',
    repositoryMapping: repositoryMapping(),
    pullRequest,
    rerun: { _tag: 'NotRequested' },
  }
}

interface Harness {
  attempts: RecordReviewRunInput[]
  comments: string[]
  progressFailures: string[]
  staged: number
  options: ReviewWorkerOptions
}

function repairTask(pullRequest: GitHubPullRequestItem) {
  return {
    id: 'repair-task',
    kind: 'review_fix' as const,
    repository: 'harlan-zw/example',
    pullRequestNumber: 24,
    revisionId: 'revision-1',
    state: { _tag: 'Running' as const, workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
    updatedAt: '2026-08-13T01:00:00.000Z',
    repositoryMapping: repositoryMapping(),
    pullRequest,
  }
}

/** One review worker whose only moving parts are the ones a test names. */
function harness(input: {
  pullRequest: GitHubPullRequestItem
  response: unknown
  snapshots?: Array<ReturnType<typeof reviewSnapshot>>
  publish?: () => ReturnType<ReviewWorkerOptions['status']['publish']>
  claimRepair?: () => ReviewFixClaim
}): Harness {
  const attempts: RecordReviewRunInput[] = []
  const comments: string[] = []
  const progressFailures: string[] = []
  const publications = { staged: 0 }
  const snapshots = input.snapshots ?? [reviewSnapshot(input.pullRequest)]
  let read = 0

  const options: ReviewWorkerOptions = {
    profile: CODEX_AGENT_PROFILE,
    provider: stubProvider(turnEvents(input.response)),
    github: {
      consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
      ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
      getIssueTriageSnapshot: () => Promise.reject(new Error('Unexpected issue request.')),
      getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
      getPullRequestReviewSnapshot: () => {
        const snapshot = snapshots[Math.min(read, snapshots.length - 1)]!
        read += 1
        return Promise.resolve(ok(snapshot))
      },
      upsertIssueTriageComment: () => Promise.reject(new Error('Review must not post issue triage.')),
      upsertReviewStatus: () => Promise.reject(new Error('The Worker must use the status controller.')),
    },
    now: () => new Date('2026-08-13T01:00:00.000Z'),
    onProgressPublishFailure: (_task, reason) => progressFailures.push(reason),
    store: {
      claimReviewFixTaskForReview: input.claimRepair ?? (() => { throw new Error('Unexpected repair claim.') }),
      failTask: () => { throw new Error('Unexpected repair failure.') },
      getWorkerSession: () => null,
      isBaselineRepairPullRequest: () => false,
      queueBaselineRepairForReview: () => { throw new Error('Unexpected Baseline repair.') },
      retireBaselineRepairForReview: () => 0,
      saveWorkerSession: () => undefined,
      stagePublication: () => {
        publications.staged += 1
        return { _tag: 'Staged', commandId: 'publication-1' }
      },
      updateAgentProgress: () => true,
      recordReviewRun: (attempt) => {
        attempts.push(attempt)
        return { _tag: 'Inserted', reviewRunId: attempt.id }
      },
      recordReviewPublication: publication => ({ _tag: 'Inserted', publicationId: publication.id }),
    },
    status: {
      publish: input.publish ?? ((_task, _phase, body) => {
        comments.push(body)
        return Promise.resolve(ok({ commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' }))
      }),
      publishRepair: () => Promise.resolve(ok(undefined)),
    },
    triageStatus: { publish: () => Promise.reject(new Error('Review must not publish issue triage.')) },
    workspaces: {
      prepareIssue: () => Promise.reject(new Error('Unexpected issue workspace.')),
      prepareReview: () => Promise.resolve(ok({
        path: '/tmp/review-worktree',
        baseSha: input.pullRequest.baseSha,
        headSha: input.pullRequest.headSha,
      })),
    },
    repairs: {
      commit: () => Promise.resolve(ok({
        commitSha: 'repair-commit',
        baseSha: input.pullRequest.baseSha,
        artifactRef: 'refs/harlan-github-agent/publications/repair',
        digest: 'patch-digest',
        changedFiles: 2,
      })),
      verify: () => Promise.resolve(ok({ digest: 'patch-digest', changedFiles: 2 })),
    },
  }
  return {
    attempts,
    comments,
    progressFailures,
    get staged() {
      return publications.staged
    },
    options,
  }
}

describe('review resilience', () => {
  it('keeps a finished review when a human comments while it runs', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const test = harness({
      pullRequest,
      response: {
        metadata: passingGate,
        review: passingGate,
        verification: passingGate,
        findings: [],
        repair: { outcome: 'not_needed', summary: 'Nothing to fix.', checks: [], commitMessage: '' },
        confidence: 91,
      },
      snapshots: [
        reviewSnapshot(pullRequest, []),
        reviewSnapshot(pullRequest, ['A human commented while the agent worked.']),
      ],
    })

    const result = await createReviewWorker(test.options).run(reviewTask(pullRequest), new AbortController().signal)

    expect(result._tag).toBe('Ok')
    expect(test.attempts).toHaveLength(1)
    expect(test.comments.at(-1)).toContain('READY · 91/100')
  })

  it('abandons a review when the head commit moves, because it describes another diff', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const test = harness({
      pullRequest,
      response: {
        metadata: passingGate,
        review: passingGate,
        verification: passingGate,
        findings: [],
        repair: { outcome: 'not_needed', summary: 'Nothing to fix.', checks: [], commitMessage: '' },
        confidence: 91,
      },
      snapshots: [
        reviewSnapshot(pullRequest),
        reviewSnapshot({ ...pullRequest, headSha: 'def456' }),
      ],
    })

    const result = await createReviewWorker(test.options).run(reviewTask(pullRequest), new AbortController().signal)

    expect(result).toEqual({ _tag: 'Err', error: 'The pull request changed before the review completed.' })
    expect(test.attempts).toEqual([])
  })

  it('finishes a review whose progress comments GitHub refused', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const test = harness({
      pullRequest,
      response: {
        metadata: passingGate,
        review: passingGate,
        verification: passingGate,
        findings: [],
        repair: { outcome: 'not_needed', summary: 'Nothing to fix.', checks: [], commitMessage: '' },
        confidence: 88,
      },
      publish: () => Promise.resolve(err('Resource not accessible by integration')),
    })

    const result = await createReviewWorker(test.options).run(reviewTask(pullRequest), new AbortController().signal)

    expect(test.attempts).toHaveLength(1)
    expect(test.progressFailures).toContain('Resource not accessible by integration')
    // The terminal comment still failed, which the Task reports, but the review
    // itself was completed and stored rather than thrown away at 10 percent.
    expect(result).toEqual({ _tag: 'Err', error: 'Resource not accessible by integration' })
  })

  it('accepts a review that fixed every defect and reported none left', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const test = harness({
      pullRequest,
      response: {
        metadata: passingGate,
        review: passingGate,
        verification: passingGate,
        findings: [],
        repair: { outcome: 'blocked', summary: 'Fixed the off by one.', checks: ['pnpm test'], commitMessage: '' },
        confidence: 84,
      },
    })

    const result = await createReviewWorker(test.options).run(reviewTask(pullRequest), new AbortController().signal)

    expect(result._tag).toBe('Ok')
    expect(test.attempts).toHaveLength(1)
  })

  it('publishes a passing review that named no confidence', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const test = harness({
      pullRequest,
      response: {
        metadata: passingGate,
        review: passingGate,
        verification: passingGate,
        findings: [],
        repair: { outcome: 'not_needed', summary: 'Nothing to fix.', checks: [], commitMessage: '' },
        confidence: null,
      },
    })

    const result = await createReviewWorker(test.options).run(reviewTask(pullRequest), new AbortController().signal)

    expect(result._tag).toBe('Ok')
    expect(test.attempts[0]?.confidence).toBeUndefined()
    expect(test.comments.at(-1)).toContain('### 🤖 READY')
    expect(test.comments.at(-1)).not.toContain('/100')
  })
  it('publishes the repair of a review that reported no finding left', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const test = harness({
      pullRequest,
      response: {
        metadata: passingGate,
        review: passingGate,
        verification: passingGate,
        findings: [],
        repair: { outcome: 'repaired', summary: 'Fixed the off by one.', checks: ['pnpm test'], commitMessage: 'fix(core): stop the off by one' },
        confidence: 90,
      },
      claimRepair: () => ({ _tag: 'Claimed', task: repairTask(pullRequest) }),
    })

    const result = await createReviewWorker(test.options).run(reviewTask(pullRequest), new AbortController().signal)

    // The repair lives only in the review worktree until this publication is
    // staged, so a lost claim throws the whole agent turn away.
    expect(result._tag).toBe('Ok')
    expect(test.staged).toBe(1)
  })

  it('stops a review whose repair the controller refused', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const refusal = 'The controller cannot write this pull request branch.'
    const test = harness({
      pullRequest,
      response: {
        metadata: passingGate,
        review: passingGate,
        verification: passingGate,
        findings: [],
        repair: { outcome: 'repaired', summary: 'Fixed the off by one.', checks: ['pnpm test'], commitMessage: 'fix(core): stop the off by one' },
        confidence: 90,
      },
      claimRepair: () => ({ _tag: 'Refused', reason: refusal }),
    })

    const result = await createReviewWorker(test.options).run(reviewTask(pullRequest), new AbortController().signal)

    expect(result).toEqual({ _tag: 'Err', error: refusal })
    expect(test.staged).toBe(0)
    // A refusal reads the same policy on every attempt, so it must never requeue.
    expect(classifyFailure({ message: refusal })._tag).toBe('Permanent')
  })
})
