import { describe, expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { syncOpenReviewRerunRequests, syncReviewRerunRequests } from '../src/review-rerun-controller.ts'
import { dashboardSnapshot, pullRequestItem, repositoryMapping } from './fixtures.ts'

describe('review rerun controller', () => {
  it('polls only repositories with open pull requests, one at a time', async () => {
    let active = 0
    let maximumActive = 0
    const repositories = Array.from({ length: 8 }, (_, index) => repositoryMapping({
      github: `harlan-zw/example-${index}`,
    }))
    const quiet = repositoryMapping({ github: 'harlan-zw/quiet' })
    const items = repositories.map((repository, index) => ({
      ...pullRequestItem({ repository: repository.github, number: 24 + index }),
      revisionId: `${index}`.repeat(64),
      observedAt: '2026-08-13T01:00:00.000Z',
      dismissed: false,
      approval: { _tag: 'NotRequired' as const },
    }))
    const requested: string[] = []

    const results = await syncOpenReviewRerunRequests([...repositories, quiet], {
      allowedAuthors: ['harlan-zw'],
      github: {
        listReviewRerunRequests: async (repository) => {
          active += 1
          maximumActive = Math.max(maximumActive, active)
          await new Promise(resolve => setTimeout(resolve, 5))
          active -= 1
          requested.push(repository.github)
          return ok([])
        },
      },
      store: {
        getDashboardSnapshot: () => dashboardSnapshot({ items }),
        requestReviewRerun: () => ({ _tag: 'Duplicate', taskId: 'b'.repeat(64) }),
      },
      now: () => new Date('2026-08-13T01:02:00.000Z'),
    })

    expect(results).toHaveLength(8)
    expect(requested).toEqual(repositories.map(repository => repository.github))
    expect(maximumActive).toBe(1)
  })

  it('requests the current pull request head once for a GitHub command', async () => {
    const requests: unknown[] = []
    const subject = { ...pullRequestItem({ mergeState: 'clean' }), revisionId: 'a'.repeat(64), observedAt: '2026-08-13T01:00:00.000Z', dismissed: false, approval: { _tag: 'NotRequired' as const } }
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
