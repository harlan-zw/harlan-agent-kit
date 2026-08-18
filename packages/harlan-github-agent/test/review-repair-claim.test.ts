import type { ReviewGates } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyFailure } from '../src/failure.ts'
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
    head: { _tag: 'Passed', evidence: [{ label: 'head', sha256: 'a'.repeat(64) }] },
    merge: { _tag: 'Passed', evidence: [{ label: 'mergeability', sha256: 'b'.repeat(64) }] },
    metadata: { _tag: 'Passed', evidence: [] },
    review: { _tag: 'Passed', evidence: [{ label: 'review', sha256: 'c'.repeat(64) }] },
    verification: { _tag: 'Passed', evidence: [{ label: 'tests', sha256: 'd'.repeat(64) }] },
    ci: { _tag: 'Passed', evidence: [{ label: 'required-ci', sha256: 'e'.repeat(64) }] },
  }
}

/** One review Task running against one open pull request. */
function runningReview(store: ReturnType<typeof openJournalStore>, headRef: string) {
  store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
  const observed = store.recordObservation({
    externalId: `repair-claim-${headRef}`,
    observedAt: '2026-08-13T01:00:00.000Z',
    source: 'poll',
    subject: pullRequestItem({ headRef, mergeState: 'clean' }),
  })
  if (observed._tag !== 'Inserted')
    throw new Error('Expected a new pull request revision.')
  const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:00:01.000Z', 600_000)
  if (review === null)
    throw new Error('Expected the review Task.')
  return { review, revisionId: observed.revisionId }
}

function recordRepairedReview(store: ReturnType<typeof openJournalStore>, revisionId: string, headSha: string): void {
  store.recordReviewRun({
    id: `review-run-${revisionId}`,
    repository: 'harlan-zw/example',
    pullRequestNumber: 24,
    revisionId,
    headSha,
    provider: 'codex',
    sessionId: 'repair-claim-session',
    model: 'gpt-5.6',
    agentVersion: '1.2.3',
    skillDigest: 'f'.repeat(64),
    startedAt: '2026-08-13T01:00:02.000Z',
    completedAt: '2026-08-13T01:00:03.000Z',
    gates: passedReviewGates(),
    // The agent repaired every defect in this turn, so it reports none left.
    findings: [],
  })
}

describe('review repair claim', () => {
  it('claims the repair a review made after it fixed every finding', () => {
    const store = createStore()
    const { review, revisionId } = runningReview(store, 'fix/broken-thing')
    recordRepairedReview(store, revisionId, review.pullRequest.headSha)

    const claim = store.claimReviewFixTaskForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:00:04.000Z',
      leaseMilliseconds: 60_000,
    })

    expect(claim._tag).toBe('Claimed')
    if (claim._tag !== 'Claimed')
      throw new Error('Expected the repair Task.')
    expect(claim.task.kind).toBe('review_fix')
    // The repair only exists in the review worktree until its publication is
    // staged, so a claim that fails here throws the agent's work away.
    expect(store.stagePublication({
      taskId: claim.task.id,
      workerId: claim.task.state.workerId,
      fence: claim.task.state.fence,
      at: '2026-08-13T01:00:05.000Z',
      publication: {
        _tag: 'UpdatePullRequest',
        taskKind: 'review_fix',
        pullRequestNumber: claim.task.pullRequestNumber,
        commitSha: 'repair-commit',
        baseSha: 'base123',
        expectedHeadSha: claim.task.pullRequest.headSha,
        headRef: claim.task.pullRequest.headRef,
        artifactRef: 'refs/harlan-github-agent/publications/repair',
        patchDigest: 'repair-patch',
        changedFiles: 2,
      },
    })._tag).toBe('Staged')
  })

  it('ends a review whose repair the controller may never publish', () => {
    const store = createStore()
    const { review, revisionId } = runningReview(store, 'wip/unwritable-branch')
    recordRepairedReview(store, revisionId, review.pullRequest.headSha)

    const claim = store.claimReviewFixTaskForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:00:04.000Z',
      leaseMilliseconds: 60_000,
    })

    expect(claim).toEqual({ _tag: 'Refused', reason: 'The controller cannot write this pull request branch.' })
    if (claim._tag !== 'Refused')
      throw new Error('Expected a refused repair.')
    expect(classifyFailure({ message: claim.reason })._tag).toBe('Permanent')
    // One refusal ends the review. Another agent turn would read the same
    // policy, refuse again, and spend seven more minutes doing it.
    expect(store.failWorkerTask({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:00:05.000Z',
      reason: claim.reason,
    })).toBe('Failed')
    expect(store.retryRecoverableWorkerFailures('2026-08-13T02:00:00.000Z')).toBe(0)
    expect(store.claimNextAdversarialReviewTask('review-agent-2', '2026-08-13T02:00:01.000Z', 600_000)).toBeNull()
  })
})
