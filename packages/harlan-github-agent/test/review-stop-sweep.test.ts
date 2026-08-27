import type { StoppedReview } from '../src/store.ts'
import { describe, expect, it } from 'vitest'
import { err, ok } from '../src/result.ts'
import { publishStoppedReviews, stoppedReviewComment } from '../src/review-stop-sweep.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stopped: StoppedReview = {
  taskId: 'review-task',
  taskKind: 'adversarial_review',
  repository: 'harlan-zw/example',
  pullRequestNumber: 24,
  revisionId: 'revision-1',
  headSha: 'abc123',
  reason: 'The pull request is not ready for review.',
  disposition: { _tag: 'Stopped' },
  commentId: 42,
  publishedBody: '### 🤖 REVIEWING · Reviewing changed files',
  findings: [],
}

const stoppedRepair: StoppedReview = {
  ...stopped,
  taskId: 'repair-task',
  taskKind: 'review_fix',
  reason: 'The Repair Agent found an unsafe scope.',
  findings: [
    { _tag: 'Open', summary: 'First exact finding.', nextAction: 'Fix the first boundary.', resolution: 'Repair' },
    { _tag: 'Open', summary: 'Second exact finding.', nextAction: 'Fix the second boundary.', resolution: 'Repair' },
  ],
}

function snapshot(overrides: Parameters<typeof pullRequestItem>[0] = {}) {
  return ok({
    baseChecks: { _tag: 'Available' as const, checks: [] },
    body: '',
    checks: { _tag: 'Available' as const, checks: [] },
    comments: [],
    priorAutomatedReview: { _tag: 'None' as const },
    pullRequest: pullRequestItem({ headSha: 'abc123', ...overrides }),
    requiredChecks: { _tag: 'None' as const },
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

  it('replaces Repair progress with BLOCKED and every exact finding', () => {
    const body = stoppedReviewComment(stoppedRepair, '2026-08-15T04:00:00.000Z')

    expect(body).toContain('### 🤖 BLOCKED')
    expect(body).toContain('First exact finding. Next: Fix the first boundary.')
    expect(body).toContain('Second exact finding. Next: Fix the second boundary.')
    expect(body).toContain('The Repair Agent found an unsafe scope.')
    expect(body).not.toContain('### 🤖 REPAIR')
  })
})

describe('publishStoppedReviews', () => {
  it('reads stopped reviews one at a time to protect the GitHub request quota', async () => {
    let active = 0
    let maximumActive = 0
    const reviews = Array.from({ length: 8 }, (_, index): StoppedReview => ({
      ...stopped,
      taskId: `review-task-${index}`,
      pullRequestNumber: 24 + index,
    }))

    await publishStoppedReviews({
      github: {
        getPullRequestReviewSnapshot: async () => {
          active += 1
          maximumActive = Math.max(maximumActive, active)
          await new Promise(resolve => setTimeout(resolve, 5))
          active -= 1
          return snapshot()
        },
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' })),
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      repositories: [repositoryMapping()],
      store: {
        recordDeletedReviewComment: () => true,
        listStoppedReviews: () => reviews,
        recordStoppedReviewStatus: () => true,
      },
    }, new AbortController().signal)

    expect(maximumActive).toBe(1)
  })

  it('rewrites the canonical comment and records it once', async () => {
    let edited: { commentId: number, body: string } | undefined
    let recorded = 0
    const { results } = await publishStoppedReviews({
      github: {
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot()),
        editReviewStatus: (_repository, _number, commentId, _expectedBody, body) => {
          edited = { commentId, body }
          return Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' }))
        },
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      repositories: [repositoryMapping()],
      store: {
        recordDeletedReviewComment: () => true,
        listStoppedReviews: () => [stopped],
        recordStoppedReviewStatus: () => {
          recorded += 1
          return true
        },
      },
    }, new AbortController().signal)

    expect(results).toEqual([ok({ _tag: 'Published', repository: 'harlan-zw/example', pullRequestNumber: 24 })])
    expect(edited?.commentId).toBe(42)
    expect(edited?.body).toContain('### 🤖 STOPPED')
    expect(recorded).toBe(1)
  })

  it('closes a stale progress comment after GitHub merges the pull request', async () => {
    let body = ''
    const { results } = await publishStoppedReviews({
      github: {
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot({
          state: 'closed',
          mergedAt: '2026-08-15T03:00:00.000Z',
          headSha: 'def456',
        })),
        editReviewStatus: (_repository, _number, _commentId, _expectedBody, value) => {
          body = value
          return Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' }))
        },
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      repositories: [repositoryMapping()],
      store: {
        recordDeletedReviewComment: () => true,
        listStoppedReviews: () => [stopped],
        recordStoppedReviewStatus: () => true,
      },
    }, new AbortController().signal)

    expect(results).toEqual([ok({ _tag: 'Published', repository: 'harlan-zw/example', pullRequestNumber: 24 })])
    expect(body).toContain('### 🤖 MERGED')
    expect(body).not.toContain('REVIEWING')
  })

  it('closes the comment on a merged pull request whose head branch GitHub deleted', async () => {
    let body = ''
    const { results } = await publishStoppedReviews({
      github: {
        getPullRequestReviewSnapshot: () => Promise.resolve(err('Branch not found - https://docs.github.com/rest/branches/branches#get-a-branch')),
        editReviewStatus: (_repository, _number, _commentId, _expectedBody, value) => {
          body = value
          return Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' }))
        },
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      repositories: [repositoryMapping()],
      store: {
        recordDeletedReviewComment: () => true,
        listStoppedReviews: () => [{ ...stopped, disposition: { _tag: 'Merged' } }],
        recordStoppedReviewStatus: () => true,
      },
    }, new AbortController().signal)

    expect(results).toEqual([ok({ _tag: 'Published', repository: 'harlan-zw/example', pullRequestNumber: 24 })])
    expect(body).toContain('### 🤖 MERGED')
  })

  it('stops on its own budget and leaves the rest for the next pass', async () => {
    const backlog = Array.from({ length: 5 }, (_, index) => ({
      ...stopped,
      taskId: `review-task-${index}`,
      pullRequestNumber: 24 + index,
      disposition: { _tag: 'Merged' as const },
    }))
    let edits = 0
    // Every closed comment costs a GitHub round trip. This clock spends one
    // second on each, so the budget runs out partway through the backlog.
    let clock = Date.parse('2026-08-15T04:00:00.000Z')
    const { results, remaining } = await publishStoppedReviews({
      github: {
        getPullRequestReviewSnapshot: () => Promise.reject(new Error('A merged pull request needs no snapshot.')),
        editReviewStatus: () => {
          edits += 1
          clock += 1_000
          return Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' }))
        },
      },
      now: () => new Date(clock),
      repositories: [repositoryMapping()],
      store: {
        recordDeletedReviewComment: () => true,
        listStoppedReviews: () => backlog,
        recordStoppedReviewStatus: () => true,
      },
      budgetMilliseconds: 3_000,
    }, new AbortController().signal)

    expect(results).toHaveLength(3)
    expect(remaining).toBe(2)
    expect(edits).toBe(3)
  })

  it('reports a backlog it never started, so a spent pass is never silent', async () => {
    const { results, remaining } = await publishStoppedReviews({
      github: {
        getPullRequestReviewSnapshot: () => Promise.reject(new Error('The budget was spent before any row ran.')),
        editReviewStatus: () => Promise.reject(new Error('The budget was spent before any row ran.')),
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      repositories: [repositoryMapping()],
      store: {
        recordDeletedReviewComment: () => true,
        listStoppedReviews: () => [stopped, stopped],
        recordStoppedReviewStatus: () => true,
      },
      budgetMilliseconds: 0,
    }, new AbortController().signal)

    expect(results).toEqual([])
    expect(remaining).toBe(2)
  })

  it('retires the publication a person deleted, so no later pass asks again', async () => {
    const retired: number[] = []
    let recorded = 0
    const { results } = await publishStoppedReviews({
      github: {
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot()),
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Missing' })),
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      repositories: [repositoryMapping()],
      store: {
        recordDeletedReviewComment: (input) => {
          retired.push(input.commentId)
          return true
        },
        listStoppedReviews: () => [stopped],
        recordStoppedReviewStatus: () => {
          recorded += 1
          return true
        },
      },
    }, new AbortController().signal)

    expect(results).toEqual([ok({ _tag: 'CommentGone', repository: 'harlan-zw/example', pullRequestNumber: 24 })])
    expect(recorded).toBe(0)
    expect(retired).toEqual([42])
  })
  it('leaves the comment alone once the pull request moves on', async () => {
    let writes = 0
    const { results } = await publishStoppedReviews({
      github: {
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot({ headSha: 'def456' })),
        editReviewStatus: () => {
          writes += 1
          return Promise.resolve(err('Unexpected comment write.'))
        },
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      repositories: [repositoryMapping()],
      store: {
        recordDeletedReviewComment: () => true,
        listStoppedReviews: () => [stopped],
        recordStoppedReviewStatus: () => true,
      },
    }, new AbortController().signal)

    expect(writes).toBe(0)
    expect(results).toEqual([ok({ _tag: 'Superseded', repository: 'harlan-zw/example', pullRequestNumber: 24 })])
  })
})
