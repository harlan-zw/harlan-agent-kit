import type { Octokit } from 'octokit'
import type { ClaimedReviewStatusCommand } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { createGitHubAgentSource } from '../src/github-agent-source.ts'
import { NATIVE_REVIEW_MARKER, nativeReviewBody } from '../src/native-review.ts'
import { err, ok } from '../src/result.ts'
import { publishClaimedReviewStatus } from '../src/review-status-controller.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const headSha = 'a'.repeat(40)
const actor = 'harlan-github-agent[bot]'
const url = 'https://github.com/harlan-zw/example/pull/24#issuecomment-42'
const signal = new AbortController().signal

function sourceFixture() {
  const reviews: Array<{ id: number, user: { login: string }, state: string, commit_id: string, body: string }> = []
  const writes: Array<Record<string, unknown>> = []
  const source = createGitHubAgentSource({
    actorLogin: () => actor,
    ownAppId: 98114,
    tokens: { getToken: async () => ok({ token: 'token', expiresAt: '2099-01-01T00:00:00.000Z' }), invalidate: () => undefined },
    createClient: () => ({
      paginate: async () => reviews,
      rest: { pulls: {
        listReviews: () => undefined,
        createReview: async (input: { commit_id: string, body: string, event: string }) => {
          writes.push(input)
          const review = { id: reviews.length + 1, user: { login: actor }, state: 'COMMENTED', commit_id: input.commit_id, body: input.body }
          reviews.push(review)
          return { data: review }
        },
        updateReview: async (input: { review_id: number, body: string }) => {
          writes.push(input)
          const review = reviews.find(review => review.id === input.review_id)!
          review.body = input.body
          return { data: review }
        },
      } },
    } as unknown as Octokit),
  })
  return { source, reviews, writes }
}

describe('native GitHub Review', () => {
  it('submits COMMENT once per head and updates it when Review runs again', async () => {
    const { source, reviews, writes } = sourceFixture()
    const body = nativeReviewBody(headSha, 'READY', url)
    expect(await source.upsertNativeReview(repositoryMapping(), 24, headSha, body, signal, () => ok(undefined))).toEqual(ok(undefined))
    expect(writes).toEqual([expect.objectContaining({ event: 'COMMENT', commit_id: headSha, body })])
    expect(body).toContain(NATIVE_REVIEW_MARKER)
    expect(body).toContain(`[Read the Review results](${url})`)
    expect(await source.upsertNativeReview(repositoryMapping(), 24, headSha, body, signal, () => ok(undefined))).toEqual(ok(undefined))
    const changed = nativeReviewBody(headSha, 'BLOCKED', url)
    expect(await source.upsertNativeReview(repositoryMapping(), 24, headSha, changed, signal, () => ok(undefined))).toEqual(ok(undefined))
    expect(writes).toEqual([expect.objectContaining({ event: 'COMMENT' }), expect.objectContaining({ review_id: 1, body: changed })])
    expect(reviews[0]?.body).toBe(changed)
    const next = 'b'.repeat(40)
    expect(await source.upsertNativeReview(repositoryMapping(), 24, next, nativeReviewBody(next, 'READY', url), signal, () => ok(undefined))).toEqual(ok(undefined))
    expect(writes[2]).toMatchObject({ event: 'COMMENT', commit_id: next })
  })

  it('never posts through Harlan or after publication authority expires', async () => {
    const { source, writes } = sourceFixture()
    expect(await source.upsertNativeReview(repositoryMapping({ authentication: 'user' }), 24, headSha, 'body', signal, () => ok(undefined))).toEqual(ok(undefined))
    expect(await source.upsertNativeReview(repositoryMapping(), 24, headSha, 'body', signal, () => err('Lease expired'))).toEqual(err('Lease expired'))
    expect(writes).toEqual([])
  })

  it.each([false, true])('mirrors the terminal result without blocking the canonical status on failure: %s', async (fail) => {
    const repository = repositoryMapping()
    const pullRequest = pullRequestItem({ headSha, baseRef: 'main' })
    const command: ClaimedReviewStatusCommand = {
      id: 'command',
      taskKind: 'adversarial_review',
      taskId: 'task',
      repository: repository.github,
      pullRequestNumber: 24,
      revisionId: 'revision',
      expectedHeadSha: headSha,
      expectedBaseRef: 'main',
      phase: 'terminal',
      body: '### READY',
      reviewRunId: 'run',
      desiredOutcome: 'READY',
      outcomeUnknown: false,
      commentId: null,
      workerId: 'worker',
      fence: 1,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      repositoryMapping: repository,
    }
    const calls: string[] = []
    const mirrored: string[] = []
    const result = await publishClaimedReviewStatus({
      nativeReviews: {
        publisher: { upsertNativeReview: async (_repository, _number, sha, body) => {
          calls.push('native')
          expect(sha).toBe(headSha)
          expect(body).toContain(url)
          return fail ? err('GitHub unavailable') : ok(undefined)
        } },
        report: (_repository, result) => mirrored.push(result._tag),
      },
      now: () => new Date('2026-10-02T00:00:00.000Z'),
      github: {
        readExistingReviewLabel: () => { throw new Error('Unexpected foreign Review.') },
        getPullRequestStatusIdentity: async () => ok(pullRequest),
        getPullRequestReviewSnapshot: async () => ok({ pullRequest, body: '', comments: [], checks: { _tag: 'Available', checks: [] }, baseChecks: { _tag: 'Available', checks: [] }, requiredChecks: { _tag: 'None' }, priorAutomatedReview: { _tag: 'None' }, reviews: [], findingDiscussions: [] }),
        upsertReviewStatus: async () => {
          calls.push('comment')
          return ok({ commentId: 42, url })
        },
        stampAgentLabel: async () => {
          calls.push('label')
          return ok(undefined)
        },
      },
      store: {
        authorizeReviewStatus: () => true,
        recordReviewStatusReceipt: () => true,
        completeReviewStatus: () => true,
        deferReviewStatus: () => true,
        supersedeReviewStatus: () => true,
      },
    }, command, false, signal)
    expect(result).toEqual(ok({ commentId: 42, url }))
    expect(calls).toEqual(['comment', 'label', 'native'])
    expect(mirrored).toEqual([fail ? 'Err' : 'Ok'])
  })
})
