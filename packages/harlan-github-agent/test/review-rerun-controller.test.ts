import { describe, expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { syncReviewRerunRequests } from '../src/review-rerun-controller.ts'
import { dashboardSnapshot, pullRequestItem, repositoryMapping } from './fixtures.ts'

describe('review rerun controller', () => {
  it('requests the current pull request head once for a GitHub command', async () => {
    const requests: unknown[] = []
    const subject = { ...pullRequestItem({ mergeState: 'clean' }), revisionId: 'a'.repeat(64), observedAt: '2026-08-13T01:00:00.000Z', approval: { _tag: 'NotRequired' as const } }
    const result = await syncReviewRerunRequests(repositoryMapping(), {
      allowedAuthors: ['harlan-zw'],
      github: {
        listReviewRerunRequests: () => Promise.resolve(ok([{
          author: 'harlan-zw',
          commentId: 42,
          pullRequestNumber: 24,
          updatedAt: '2026-08-13T01:01:00.000Z',
        }])),
      },
      store: {
        getDashboardSnapshot: () => dashboardSnapshot({ items: [subject] }),
        requestReviewRerun(input) {
          requests.push(input)
          return { _tag: 'Queued', taskId: 'b'.repeat(64) }
        },
      },
      now: () => new Date('2026-08-13T01:02:00.000Z'),
    })

    expect(result._tag).toBe('Ok')
    expect(requests).toEqual([expect.objectContaining({
      revisionId: subject.revisionId,
      requestId: 'github-comment:harlan-zw/example:42:2026-08-13T01:01:00.000Z',
      requestedBy: 'harlan-zw',
    })])
  })
})
