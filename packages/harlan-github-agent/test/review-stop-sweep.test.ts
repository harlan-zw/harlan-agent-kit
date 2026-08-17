import type { StoppedReview } from '../src/store.ts'
import { describe, expect, it } from 'vitest'
import { err, ok } from '../src/result.ts'
import { publishStoppedReviews, stoppedReviewComment } from '../src/review-stop-sweep.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stopped: StoppedReview = {
  taskId: 'review-task',
  repository: 'harlan-zw/example',
  pullRequestNumber: 24,
  revisionId: 'revision-1',
  headSha: 'abc123',
  reason: 'The pull request is not ready for review.',
  commentId: 42,
}

function snapshot(overrides: Parameters<typeof pullRequestItem>[0] = {}) {
  return ok({
    baseChecks: { _tag: 'Available' as const, checks: [] },
    body: '',
    checks: { _tag: 'Available' as const, checks: [] },
    comments: [],
    priorAutomatedReview: { _tag: 'None' as const },
    pullRequest: pullRequestItem({ headSha: 'abc123', ...overrides }),
    reviews: [],
  })
}

describe('stoppedReviewComment', () => {
  it('replaces the progress claim with a final state and its reason', () => {
    const body = stoppedReviewComment(stopped, '2026-08-15T04:00:00.000Z')

    expect(body).toContain('### 🤖 STOPPED')
    expect(body).toContain('The pull request is not ready for review.')
    expect(body).not.toContain('REVIEWING')
  })
})

describe('publishStoppedReviews', () => {
  it('rewrites the canonical comment and records it once', async () => {
    let upserted: { commentId: number | null, body: string } | undefined
    let recorded = 0
    const results = await publishStoppedReviews({
      github: {
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot()),
        upsertReviewStatus: (_repository, _number, commentId, body) => {
          upserted = { commentId, body }
          return Promise.resolve(ok({ commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' }))
        },
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      repositories: [repositoryMapping()],
      store: {
        listStoppedReviews: () => [stopped],
        recordStoppedReviewStatus: () => {
          recorded += 1
          return true
        },
      },
    }, new AbortController().signal)

    expect(results).toEqual([ok({ repository: 'harlan-zw/example', pullRequestNumber: 24 })])
    expect(upserted?.commentId).toBe(42)
    expect(upserted?.body).toContain('### 🤖 STOPPED')
    expect(recorded).toBe(1)
  })

  it('leaves the comment alone once the pull request moves on', async () => {
    let upserts = 0
    const results = await publishStoppedReviews({
      github: {
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot({ headSha: 'def456' })),
        upsertReviewStatus: () => {
          upserts += 1
          return Promise.resolve(err('Unexpected comment write.'))
        },
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      repositories: [repositoryMapping()],
      store: {
        listStoppedReviews: () => [stopped],
        recordStoppedReviewStatus: () => true,
      },
    }, new AbortController().signal)

    expect(upserts).toBe(0)
    expect(results).toEqual([{ _tag: 'Err', error: 'harlan-zw/example#24: the pull request changed before the final comment.' }])
  })
})
