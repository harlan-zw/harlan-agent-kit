import type { PullRequestReviewSnapshot } from '../src/github-agent-source.ts'
import type { ReviewWorkerOptions } from '../src/item-agent.ts'
import type { ClaimedAdversarialReviewTask, GitHubPullRequestItem, RecordReviewRunInput, ReviewFixQueueResult } from '../src/types.ts'
import type { ProviderCapture } from './fixtures.ts'
import { describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { classifyFailure } from '../src/failure.ts'
import { createReviewWorker, REVIEW_CONVERSATION_CHARACTER_BUDGET, reviewConversationContext, reviewFindingFingerprint } from '../src/item-agent.ts'
import { err, ok } from '../src/result.ts'
import { agentRuntime, pullRequestItem, repositoryMapping, stubProvider, turnEvents } from './fixtures.ts'

const passingGate = { state: 'passed' as const, reason: '', evidence: 'checked' }

function materialFinding(resolution: 'repair' | 'dismiss' = 'repair') {
  return {
    identity: 'unsafe-parser-boundary',
    path: 'src/parser.ts',
    line: 42,
    proof: 'Malformed input reaches the unsafe parser branch.',
    regressionTest: resolution === 'dismiss' ? null : 'Pass malformed input and assert a tagged rejection.',
    resolution,
    summary: 'Malformed input crosses the parser boundary.',
    nextAction: resolution === 'dismiss' ? 'Dismiss this pull request.' : 'Parse input before use.',
  }
}

function reviewSnapshot(pullRequest: GitHubPullRequestItem, comments: string[] = []): PullRequestReviewSnapshot {
  const check = { id: 1, failure: { _tag: 'NotAsked' as const }, source: { _tag: 'CheckRun' as const, appId: 15368 }, name: 'test', status: 'completed', conclusion: 'success' }
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
  provider: ProviderCapture
  queued: number
  options: ReviewWorkerOptions
}

/** One review worker whose only moving parts are the ones a test names. */
function harness(input: {
  pullRequest: GitHubPullRequestItem
  response: unknown
  snapshots?: Array<ReturnType<typeof reviewSnapshot>>
  publish?: () => ReturnType<ReviewWorkerOptions['status']['publish']>
  queueRepair?: () => ReviewFixQueueResult
  verifyReview?: () => ReturnType<ReviewWorkerOptions['workspaces']['verifyReview']>
}): Harness {
  const attempts: RecordReviewRunInput[] = []
  const comments: string[] = []
  const progressFailures: string[] = []
  const provider: ProviderCapture = { requests: [] }
  const repairs = { queued: 0 }
  const snapshots = input.snapshots ?? [reviewSnapshot(input.pullRequest)]
  let read = 0

  const options: ReviewWorkerOptions = {
    runtime: agentRuntime(CODEX_AGENT_PROFILE, stubProvider(turnEvents(input.response), provider)),
    github: {
      consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
      ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label mutation.')),
      getIssueTriageSnapshot: () => Promise.reject(new Error('Unexpected issue request.')),
      getPullRequestTemplate: () => Promise.resolve(ok({ _tag: 'Missing' })),
      listPullRequestFiles: () => Promise.resolve(ok([])),
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
      queueReviewFixTaskForReview: input.queueRepair ?? (() => {
        repairs.queued += 1
        return { _tag: 'Queued', taskId: 'repair-task' }
      }),
      getWorkerSession: () => null,
      isBaselineRepairPullRequest: () => false,
      recordIncident: () => { throw new Error('Unexpected Incident.') },
      queueBaselineRepairForReview: () => { throw new Error('Unexpected Baseline repair.') },
      retireBaselineRepairForReview: () => 0,
      saveWorkerSession: () => undefined,
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
    },
    triageStatus: { publish: () => Promise.reject(new Error('Review must not publish issue triage.')) },
    workspaces: {
      prepareIssue: () => Promise.reject(new Error('Unexpected issue workspace.')),
      prepareReview: () => Promise.resolve(ok({
        path: '/tmp/review-worktree',
        baseSha: input.pullRequest.baseSha,
        headSha: input.pullRequest.headSha,
      })),
      verifyReview: input.verifyReview ?? (() => Promise.resolve(ok(undefined))),
    },
  }
  return {
    attempts,
    comments,
    progressFailures,
    provider,
    get queued() {
      return repairs.queued
    },
    options,
  }
}

describe('review resilience', () => {
  it('keeps the newest discussion inside one bounded Review context', () => {
    const oldComment = `old-comment-${'a'.repeat(8_000)}`
    const newComment = `new-comment-${'b'.repeat(8_000)}`
    const oldReview = `old-review-${'c'.repeat(8_000)}`
    const newReview = `new-review-${'d'.repeat(8_000)}`

    const context = reviewConversationContext({
      body: `body-${'b'.repeat(12_000)}`,
      comments: [oldComment, ...Array.from({ length: 10 }, (_, index) => `middle-comment-${index}-${'m'.repeat(4_000)}`), newComment],
      reviews: [oldReview, ...Array.from({ length: 10 }, (_, index) => `middle-review-${index}-${'n'.repeat(4_000)}`), newReview],
    })

    expect(context.comments.join('\n')).toContain('new-comment')
    expect(context.reviews.join('\n')).toContain('new-review')
    expect(context.comments.join('\n')).not.toContain('old-comment')
    expect(context.reviews.join('\n')).not.toContain('old-review')
    expect(context.body).toContain('[... content omitted ...]')
    expect([...context.comments, ...context.reviews].join('\n')).toContain('[... content omitted ...]')
    expect([context.body, ...context.comments, ...context.reviews].reduce((total, value) => total + value.length, 0))
      .toBeLessThanOrEqual(REVIEW_CONVERSATION_CHARACTER_BUDGET)
    expect(context).toEqual(expect.objectContaining({ totalComments: 12, totalReviews: 12, truncated: true }))
  })

  it('dispatches only the compact disproof contract', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const test = harness({
      pullRequest,
      response: { metadata: passingGate, review: passingGate, verification: passingGate, findings: [], confidence: 91 },
    })

    await createReviewWorker(test.options).run(reviewTask(pullRequest), new AbortController().signal)

    expect(test.provider.requests[0]?.prompt).toContain('The controller already applied the review workflow')
    expect(test.provider.requests[0]?.prompt).toContain('Fetch the full GitHub conversation only if omitted history matters')
    expect(test.provider.requests[0]?.prompt).not.toContain('Apply the adversarial-review skill completely')
  })

  it('keeps distinct long finding identities distinct', () => {
    const shared = 'same-boundary-'.repeat(20)

    expect(reviewFindingFingerprint(`${shared}first`)).not.toBe(reviewFindingFingerprint(`${shared}second`))
  })

  it('does not truncate finding identity before repeat detection', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const shared = 'same-boundary-'.repeat(20)
    const first = materialFinding()
    const second = materialFinding()
    const test = harness({
      pullRequest,
      response: {
        metadata: passingGate,
        review: passingGate,
        verification: passingGate,
        findings: [
          { ...first, identity: `${shared}first` },
          { ...second, identity: `${shared}second` },
        ],
        confidence: 91,
      },
    })

    await createReviewWorker(test.options).run(reviewTask(pullRequest), new AbortController().signal)

    const fingerprints = test.attempts[0]?.findings.flatMap(finding => finding._tag === 'Open' ? [finding.details?.fingerprint] : [])
    expect(new Set(fingerprints).size).toBe(2)
  })

  it('publishes nothing when the agent answers that it did not review', async () => {
    // An unreliable model answers waiting on its own review gate after its
    // first answer fails the schema. Publishing that reports a verdict nobody
    // produced. nuxtseo.com#285 shipped BLOCKED with no findings that way.
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const test = harness({
      pullRequest,
      response: {
        metadata: { state: 'waiting', reason: 'No prior review context was retained from the rejected response.', evidence: '' },
        review: { state: 'waiting', reason: 'No adversarial review was completed before the previous answer was rejected.', evidence: '' },
        verification: { state: 'waiting', reason: 'No verification run was performed in this session.', evidence: '' },
        findings: [],
        confidence: null,
      },
    })

    const result = await createReviewWorker(test.options).run(reviewTask(pullRequest), new AbortController().signal)

    expect(result._tag).toBe('Err')
    expect(test.comments.some(comment => comment.includes('BLOCKED') || comment.includes('READY'))).toBe(false)
    // Attempts bound the retry, and no Recovery extends it.
    expect(classifyFailure({ message: result._tag === 'Err' ? result.error : '' }))
      .toEqual({ _tag: 'Permanent', kind: 'unknown' })
  })

  it('keeps a finished review when a human comments while it runs', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const test = harness({
      pullRequest,
      response: {
        metadata: passingGate,
        review: passingGate,
        verification: passingGate,
        findings: [],
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
    expect(test.attempts[0]?.usage).toEqual({ _tag: 'Unavailable' })
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

  it('rejects a Review Agent that changed the worktree', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const test = harness({
      pullRequest,
      response: {
        metadata: passingGate,
        review: passingGate,
        verification: passingGate,
        findings: [],
        confidence: 84,
      },
      verifyReview: () => Promise.resolve(err('The Review Agent changed files. Review must stay read only.')),
    })

    const result = await createReviewWorker(test.options).run(reviewTask(pullRequest), new AbortController().signal)

    expect(result).toEqual(err('The Review Agent changed files. Review must stay read only.'))
    expect(test.attempts).toHaveLength(0)
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
        confidence: null,
      },
    })

    const result = await createReviewWorker(test.options).run(reviewTask(pullRequest), new AbortController().signal)

    expect(result._tag).toBe('Ok')
    expect(test.attempts[0]?.confidence).toBeUndefined()
    expect(test.comments.at(-1)).toContain('### 🤖 READY')
    expect(test.comments.at(-1)).not.toContain('/100')
  })
  it('queues exact findings for a fresh Repair Agent', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const test = harness({
      pullRequest,
      response: {
        metadata: passingGate,
        review: { state: 'failed', reason: 'A material finding remains.', evidence: 'reproduction' },
        verification: passingGate,
        findings: [materialFinding()],
        confidence: null,
      },
    })

    const result = await createReviewWorker(test.options).run(reviewTask(pullRequest), new AbortController().signal)

    expect(result._tag).toBe('Ok')
    expect(test.queued).toBe(1)
    expect(test.comments.at(-1)).toContain('REVIEWING · Repair queued')
  })

  it('keeps a stable finding identity when its code moves', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const first = harness({
      pullRequest,
      response: {
        metadata: passingGate,
        review: { state: 'failed', reason: 'A material finding remains.', evidence: 'first proof' },
        verification: passingGate,
        findings: [materialFinding()],
        confidence: null,
      },
    })
    const moved = harness({
      pullRequest,
      response: {
        metadata: passingGate,
        review: { state: 'failed', reason: 'A material finding remains.', evidence: 'second proof' },
        verification: passingGate,
        findings: [{ ...materialFinding(), path: 'src/new/parser.ts', line: 9 }],
        confidence: null,
      },
    })

    await createReviewWorker(first.options).run(reviewTask(pullRequest), new AbortController().signal)
    await createReviewWorker(moved.options).run(reviewTask(pullRequest), new AbortController().signal)

    const firstFinding = first.attempts[0]?.findings[0]
    const movedFinding = moved.attempts[0]?.findings[0]
    expect(firstFinding?._tag === 'Open' ? firstFinding.details?.fingerprint : undefined)
      .toBe(movedFinding?._tag === 'Open' ? movedFinding.details?.fingerprint : undefined)
  })

  it('queues Repair when the base branch has no CI', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const snapshot = reviewSnapshot(pullRequest)
    snapshot.baseChecks = { _tag: 'Available', checks: [] }
    const test = harness({
      pullRequest,
      snapshots: [snapshot],
      response: {
        metadata: passingGate,
        review: { state: 'failed', reason: 'A material finding remains.', evidence: 'proof' },
        verification: passingGate,
        findings: [materialFinding()],
        confidence: null,
      },
    })

    await createReviewWorker(test.options).run(reviewTask(pullRequest), new AbortController().signal)

    expect(test.queued).toBe(1)
  })

  it('does not queue Repair when base CI could not be read', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const snapshot = reviewSnapshot(pullRequest)
    snapshot.baseChecks = { _tag: 'Unavailable', reason: 'GitHub checks timed out.' }
    const test = harness({
      pullRequest,
      snapshots: [snapshot],
      response: {
        metadata: passingGate,
        review: { state: 'failed', reason: 'A material finding remains.', evidence: 'proof' },
        verification: passingGate,
        findings: [materialFinding()],
        confidence: null,
      },
    })

    await createReviewWorker(test.options).run(reviewTask(pullRequest), new AbortController().signal)

    expect(test.queued).toBe(0)
    expect(test.comments.at(-1)).toContain('The base branch must pass CI before Repair starts.')
  })

  it('hands every material finding to Repair without a count cap', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const findings = Array.from({ length: 6 }, (_, index) => ({
      ...materialFinding(),
      identity: `material-finding-${index + 1}`,
      line: index + 1,
      summary: `Material finding ${index + 1}.`,
    }))
    const test = harness({
      pullRequest,
      response: {
        metadata: passingGate,
        review: { state: 'failed', reason: 'Material findings remain.', evidence: 'reproductions' },
        verification: passingGate,
        findings,
        confidence: null,
      },
    })

    const result = await createReviewWorker(test.options).run(reviewTask(pullRequest), new AbortController().signal)

    expect(result._tag).toBe('Ok')
    expect(test.attempts[0]?.findings).toHaveLength(6)
    expect(test.queued).toBe(1)
  })

  it('publishes Action required when the controller refuses Repair', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const refusal = 'The controller cannot write this pull request branch.'
    const test = harness({
      pullRequest,
      response: {
        metadata: passingGate,
        review: { state: 'failed', reason: 'A material finding remains.', evidence: 'reproduction' },
        verification: passingGate,
        findings: [materialFinding()],
        confidence: null,
      },
      queueRepair: () => ({ _tag: 'ActionRequired', reason: refusal }),
    })

    const result = await createReviewWorker(test.options).run(reviewTask(pullRequest), new AbortController().signal)

    expect(result._tag).toBe('Ok')
    expect(test.queued).toBe(0)
    expect(test.comments.at(-1)).toContain(refusal)
  })

  it('recommends Dismissal instead of repairing a wrong premise', async () => {
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const test = harness({
      pullRequest,
      response: {
        metadata: passingGate,
        review: { state: 'failed', reason: 'The pull request premise is wrong.', evidence: 'architecture trace' },
        verification: passingGate,
        findings: [materialFinding('dismiss')],
        confidence: null,
      },
    })

    const result = await createReviewWorker(test.options).run(reviewTask(pullRequest), new AbortController().signal)

    expect(result._tag).toBe('Ok')
    expect(test.queued).toBe(0)
    expect(test.comments.at(-1)).toContain('Dismissal recommended')
  })
})
