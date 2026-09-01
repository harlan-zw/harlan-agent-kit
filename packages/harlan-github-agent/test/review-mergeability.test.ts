import { afterEach, describe, expect, it } from 'vitest'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []

afterEach(() => {
  stores.splice(0).forEach(store => store.close())
})

/** An open pull request whose review is claimed and has published its progress. */
function reviewingPullRequest() {
  const store = openJournalStore(':memory:')
  stores.push(store)
  const pullRequest = pullRequestItem({ mergeState: 'clean' })
  store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
  const observed = store.recordObservation({
    externalId: 'pull-request-mergeability',
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
    at: '2026-08-13T01:01:10.000Z',
    revisionId: review.revisionId,
    expectedHeadSha: pullRequest.headSha,
    body: '### 🤖 REVIEWING · 70% · Running tests and checks',
  })
  if (staged._tag === 'Rejected')
    throw new Error(staged.reason)
  const command = store.claimReviewStatus(staged.commandId, 'status-agent', '2026-08-13T01:01:11.000Z', 60_000)
  if (command === null)
    throw new Error('Expected the review status command.')
  store.completeReviewStatus({
    commandId: command.id,
    workerId: command.workerId,
    fence: command.fence,
    at: '2026-08-13T01:01:12.000Z',
    commentId: 42,
    url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
  })

  return { store, pullRequest, review }
}

describe('review mergeability', () => {
  it('keeps the review running when GitHub has not resolved mergeability', () => {
    const { store, pullRequest } = reviewingPullRequest()

    // GitHub computes mergeability lazily, so a poll seconds after a push reads
    // unknown on the same head. That is not yet, not a reason to stop.
    store.recordObservation({
      externalId: 'pull-request-mergeability-2',
      observedAt: '2026-08-13T01:02:00.000Z',
      source: 'poll',
      subject: { ...pullRequest, mergeState: 'unknown' },
    })

    expect(store.listStoppedReviews()).toEqual([])
  })

  it('stops the review when the pull request conflicts', () => {
    const { store, pullRequest, review } = reviewingPullRequest()

    store.recordObservation({
      externalId: 'pull-request-mergeability-2',
      observedAt: '2026-08-13T01:02:00.000Z',
      source: 'poll',
      subject: { ...pullRequest, mergeState: 'conflicting' },
    })

    expect(store.listStoppedReviews()).toEqual([expect.objectContaining({
      taskId: review.id,
      reason: 'The pull request is not ready for review.',
    })])
  })

  it('stops the review when the pull request turns into a draft', () => {
    const { store, pullRequest, review } = reviewingPullRequest()

    store.recordObservation({
      externalId: 'pull-request-mergeability-2',
      observedAt: '2026-08-13T01:02:00.000Z',
      source: 'poll',
      subject: { ...pullRequest, draft: true },
    })

    expect(store.listStoppedReviews()).toEqual([expect.objectContaining({
      taskId: review.id,
      reason: 'The pull request is not ready for review.',
    })])
  })
})
