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

function recordOpenFinding(
  store: ReturnType<typeof openJournalStore>,
  revisionId: string,
  headSha: string,
  resolution: 'Repair' | 'Dismissal' = 'Repair',
): void {
  const gates = passedReviewGates()
  gates.review = { _tag: 'Failed', reason: 'A material finding remains.', evidence: [] }
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
    gates,
    findings: [{
      _tag: 'Open',
      summary: 'Unsafe parser input.',
      nextAction: resolution === 'Dismissal' ? 'Dismiss this pull request.' : 'Parse input before use.',
      resolution,
      details: {
        fingerprint: 'f'.repeat(64),
        location: { path: 'src/parser.ts', line: 42 },
        proof: 'Malformed input reaches the unsafe parser branch.',
        regressionTest: resolution === 'Dismissal' ? null : 'Pass malformed input and assert a tagged rejection.',
      },
    }],
  })
}

describe('review Repair queue', () => {
  it('queues exact findings for a separate Repair Agent', () => {
    const store = createStore()
    const { review, revisionId } = runningReview(store, 'fix/broken-thing')
    recordOpenFinding(store, revisionId, review.pullRequest.headSha)

    const queued = store.queueReviewFixTaskForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:00:04.000Z',
    })

    expect(queued._tag).toBe('Queued')
    expect(store.getReviewFixFindings(review.repository, review.pullRequestNumber, revisionId)).toEqual([
      expect.objectContaining({ _tag: 'Open', resolution: 'Repair', summary: 'Unsafe parser input.' }),
    ])
    const task = store.claimNextReviewFixTask('repair-agent', '2026-08-13T01:00:04.500Z', 60_000)
    if (task === null)
      throw new Error('Expected the Repair Task.')
    expect(task.kind).toBe('review_fix')
    expect(store.stagePublication({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:00:05.000Z',
      publication: {
        _tag: 'UpdatePullRequest',
        taskKind: 'review_fix',
        baseRef: 'main',
        pullRequestNumber: task.pullRequestNumber,
        commitSha: 'repair-commit',
        baseSha: 'base123',
        expectedHeadSha: task.pullRequest.headSha,
        headRef: task.pullRequest.headRef,
        artifactRef: 'refs/harlan-github-agent/publications/repair',
        patchDigest: 'repair-patch',
        changedFiles: 2,
      },
    })._tag).toBe('Staged')
  })

  it('ends a review whose repair the controller may never publish', () => {
    const store = createStore()
    const { review, revisionId } = runningReview(store, 'wip/unwritable-branch')
    recordOpenFinding(store, revisionId, review.pullRequest.headSha)

    const queued = store.queueReviewFixTaskForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:00:04.000Z',
    })

    expect(queued).toEqual({ _tag: 'ActionRequired', reason: 'The controller cannot write this pull request branch.' })
    if (queued._tag !== 'ActionRequired')
      throw new Error('Expected a refused repair.')
    expect(classifyFailure({ message: queued.reason })._tag).toBe('Permanent')
    // One refusal ends the review. Another agent turn would read the same
    // policy, refuse again, and spend seven more minutes doing it.
    expect(store.failWorkerTask({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:00:05.000Z',
      reason: queued.reason,
    })).toBe('Failed')
    expect(store.retryRecoverableWorkerFailures('2026-08-13T02:00:00.000Z')).toBe(0)
    expect(store.claimNextAdversarialReviewTask('review-agent-2', '2026-08-13T02:00:01.000Z', 600_000)).toBeNull()
  })

  it('never queues Repair when Review recommends Dismissal', () => {
    const store = createStore()
    const { review, revisionId } = runningReview(store, 'fix/wrong-premise')
    recordOpenFinding(store, revisionId, review.pullRequest.headSha, 'Dismissal')

    expect(store.queueReviewFixTaskForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:00:04.000Z',
    })).toEqual({ _tag: 'ActionRequired', reason: 'Review recommends Dismissal: Unsafe parser input.' })
    expect(store.claimNextReviewFixTask('repair-agent', '2026-08-13T01:00:05.000Z', 60_000)).toBeNull()
  })

  it('closes Repair progress after the Task needs action', () => {
    const store = createStore()
    const { review, revisionId } = runningReview(store, 'fix/blocked-repair')
    recordOpenFinding(store, revisionId, review.pullRequest.headSha)
    const queued = store.queueReviewFixTaskForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:00:04.000Z',
    })
    if (queued._tag !== 'Queued')
      throw new Error(queued.reason)
    const repair = store.claimNextReviewFixTask('repair-agent', '2026-08-13T01:00:05.000Z', 60_000)
    if (repair === null)
      throw new Error('Expected the Repair Task.')
    const staged = store.stageReviewStatus({
      taskKind: 'review_fix',
      phase: 'repair',
      taskId: repair.id,
      workerId: repair.state.workerId,
      fence: repair.state.fence,
      at: '2026-08-13T01:00:06.000Z',
      revisionId: repair.revisionId,
      expectedHeadSha: repair.pullRequest.headSha,
      body: '### 🤖 REPAIR · Repairing review findings',
    })
    if (staged._tag === 'Rejected')
      throw new Error(staged.reason)
    const status = store.claimReviewStatus(staged.commandId, 'status-agent', '2026-08-13T01:00:07.000Z', 60_000)
    if (status === null)
      throw new Error('Expected the Repair status command.')
    expect(store.completeReviewStatus({
      commandId: status.id,
      workerId: status.workerId,
      fence: status.fence,
      at: '2026-08-13T01:00:08.000Z',
      commentId: 42,
      url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
    })).toBe(true)
    expect(store.needsAttentionTask({
      taskId: repair.id,
      workerId: repair.state.workerId,
      fence: repair.state.fence,
      at: '2026-08-13T01:00:09.000Z',
      reason: 'The Repair Agent found unsafe scope.',
      evidence: 'blocked',
    })).toBe(true)
    expect(store.completeWorkerTask({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:00:09.100Z',
      evidence: 'Queued Repair.',
    })).toBe(true)

    expect(store.listStoppedReviews()).toEqual([expect.objectContaining({
      taskId: repair.id,
      taskKind: 'review_fix',
      reason: 'The Repair Agent found unsafe scope.',
      findings: [expect.objectContaining({ summary: 'Unsafe parser input.' })],
    })])
    expect(store.requestReviewRerun({
      repository: review.repository,
      pullRequestNumber: review.pullRequestNumber,
      revisionId,
      requestId: 'blocked-repair-rerun',
      source: 'dashboard',
      requestedBy: 'harlan-zw',
      at: '2026-08-13T01:00:09.500Z',
    })._tag).toBe('Queued')
    expect(store.claimNextAdversarialReviewTask('new-review-agent', '2026-08-13T01:00:09.600Z', 60_000)).not.toBeNull()
    expect(store.listStoppedReviews()).toEqual([])
    expect(store.recordStoppedReviewStatus({
      taskId: repair.id,
      taskKind: 'review_fix',
      revisionId: repair.revisionId,
      expectedHeadSha: repair.pullRequest.headSha,
      body: '### 🤖 BLOCKED',
      at: '2026-08-13T01:00:10.000Z',
      commentId: 42,
      url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
    })).toBe(true)
    expect(store.listStoppedReviews()).toEqual([])
  })

  it('closes Repair that stops before publishing any progress comment', () => {
    const store = createStore()
    const { review, revisionId } = runningReview(store, 'fix/silent-stop')
    recordOpenFinding(store, revisionId, review.pullRequest.headSha)
    const queued = store.queueReviewFixTaskForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:00:04.000Z',
    })
    if (queued._tag !== 'Queued')
      throw new Error(queued.reason)
    const repair = store.claimNextReviewFixTask('repair-agent', '2026-08-13T01:00:05.000Z', 60_000)
    if (repair === null)
      throw new Error('Expected the Repair Task.')
    // The sibling Review published its canonical progress comment, but the
    // Repair Task dies before staging any status of its own.
    const reviewStaged = store.stageReviewStatus({
      taskKind: 'adversarial_review',
      phase: 'review',
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:00:05.500Z',
      revisionId,
      expectedHeadSha: review.pullRequest.headSha,
      body: '### 🤖 REVIEW · Reviewing pull request',
    })
    if (reviewStaged._tag === 'Rejected')
      throw new Error(reviewStaged.reason)
    const reviewStatus = store.claimReviewStatus(reviewStaged.commandId, 'status-agent', '2026-08-13T01:00:05.600Z', 60_000)
    if (reviewStatus === null)
      throw new Error('Expected the Review status command.')
    expect(store.completeReviewStatus({
      commandId: reviewStatus.id,
      workerId: reviewStatus.workerId,
      fence: reviewStatus.fence,
      at: '2026-08-13T01:00:05.700Z',
      commentId: 42,
      url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
    })).toBe(true)

    expect(store.needsAttentionTask({
      taskId: repair.id,
      workerId: repair.state.workerId,
      fence: repair.state.fence,
      at: '2026-08-13T01:00:06.000Z',
      reason: 'The Repair Agent found unsafe scope.',
      evidence: 'blocked',
    })).toBe(true)
    expect(store.completeWorkerTask({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:00:06.100Z',
      evidence: 'Queued Repair.',
    })).toBe(true)

    expect(store.listStoppedReviews()).toEqual([expect.objectContaining({
      taskId: repair.id,
      taskKind: 'review_fix',
      reason: 'The Repair Agent found unsafe scope.',
      findings: [expect.objectContaining({ summary: 'Unsafe parser input.' })],
    })])
  })

  it('stops when a published Repair leaves the same finding', () => {
    const store = createStore()
    const { review, revisionId } = runningReview(store, 'fix/repeated-finding')
    recordOpenFinding(store, revisionId, review.pullRequest.headSha)
    const queued = store.queueReviewFixTaskForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:00:04.000Z',
    })
    if (queued._tag !== 'Queued')
      throw new Error(queued.reason)
    const repair = store.claimNextReviewFixTask('repair-agent', '2026-08-13T01:00:05.000Z', 60_000)
    if (repair === null)
      throw new Error('Expected the Repair Task.')
    const repairCommit = 'd'.repeat(40)
    expect(store.stagePublication({
      taskId: repair.id,
      workerId: repair.state.workerId,
      fence: repair.state.fence,
      at: '2026-08-13T01:00:06.000Z',
      publication: {
        _tag: 'UpdatePullRequest',
        taskKind: 'review_fix',
        baseRef: 'main',
        pullRequestNumber: repair.pullRequestNumber,
        commitSha: repairCommit,
        baseSha: 'base123',
        expectedHeadSha: repair.pullRequest.headSha,
        headRef: repair.pullRequest.headRef,
        artifactRef: 'refs/harlan-github-agent/publications/repeated-finding',
        patchDigest: 'repair-patch',
        changedFiles: 2,
      },
    })._tag).toBe('Staged')
    const publication = store.claimNextPublication('publisher', '2026-08-13T01:00:07.000Z', 60_000)
    if (publication === null)
      throw new Error('Expected the Repair Publication.')
    expect(store.completePublication({
      commandId: publication.id,
      workerId: publication.workerId,
      fence: publication.fence,
      at: '2026-08-13T01:00:08.000Z',
      evidence: 'Published Repair commit.',
    })).toBe(true)

    const repaired = store.recordObservation({
      externalId: 'repeated-finding-repaired-head',
      observedAt: '2026-08-13T01:01:00.000Z',
      source: 'poll',
      subject: pullRequestItem({
        headRef: 'fix/repeated-finding',
        headSha: repairCommit,
        mergeState: 'clean',
        updatedAt: '2026-08-13T01:01:00.000Z',
      }),
    })
    if (repaired._tag !== 'Inserted')
      throw new Error('Expected a new repaired Revision.')
    const freshReview = store.claimNextAdversarialReviewTask('fresh-review-agent', '2026-08-13T01:01:01.000Z', 60_000)
    if (freshReview === null)
      throw new Error('Expected a fresh Review Task.')
    recordOpenFinding(store, repaired.revisionId, repairCommit)

    expect(store.queueReviewFixTaskForReview({
      taskId: freshReview.id,
      workerId: freshReview.state.workerId,
      fence: freshReview.state.fence,
      at: '2026-08-13T01:01:02.000Z',
    })).toEqual({ _tag: 'ActionRequired', reason: 'A repaired head still has the same Review finding: Unsafe parser input.' })
  })
})
