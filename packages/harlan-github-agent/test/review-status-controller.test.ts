import type { ClaimedReviewFixTask } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { createReviewStatusController } from '../src/review-status-controller.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

describe('review status controller', () => {
  it('replaces the blocked review comment with repair progress', async () => {
    const repository = repositoryMapping()
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const task: ClaimedReviewFixTask = {
      id: 'repair-task',
      kind: 'review_fix',
      repository: repository.github,
      pullRequestNumber: pullRequest.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'repair-worker', fence: 1, leaseExpiresAt: '2026-08-13T01:10:00.000Z' },
      updatedAt: '2026-08-13T01:00:00.000Z',
      repositoryMapping: repository,
      pullRequest,
    }
    let replaced = false
    let body = ''
    let stagedBody = ''
    const controller = createReviewStatusController({
      github: {
        getPullRequestReviewSnapshot: () => Promise.resolve(ok({
          baseChecks: { _tag: 'Available', checks: [] },
          body: '',
          checks: { _tag: 'Available', checks: [] },
          comments: [],
          priorAutomatedReview: { _tag: 'None' },
          pullRequest,
          reviews: [],
        })),
        upsertReviewStatus: (_repository, _number, _commentId, value, replacePriorReview) => {
          body = value
          replaced = replacePriorReview
          return Promise.resolve(ok({ commentId: 29, url: pullRequest.url }))
        },
      },
      leaseMilliseconds: 60_000,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        stageReviewStatus: (input) => {
          stagedBody = input.body
          return { _tag: 'Staged', commandId: 'status-command' }
        },
        claimReviewStatus: () => ({
          id: 'status-command',
          taskKind: 'review_fix',
          taskId: task.id,
          repository: repository.github,
          pullRequestNumber: pullRequest.number,
          revisionId: task.revisionId,
          expectedHeadSha: pullRequest.headSha,
          phase: 'repair',
          body: stagedBody,
          outcomeUnknown: false,
          commentId: null,
          workerId: 'status-worker',
          fence: 1,
          leaseExpiresAt: '2026-08-13T01:10:00.000Z',
          repositoryMapping: repository,
        }),
        completeReviewStatus: () => true,
        deferReviewStatus: () => { throw new Error('Unexpected defer.') },
      },
      workerId: 'status-worker',
    })

    expect(await controller.publishRepair(task, { percent: 35, label: 'Git worktree ready' }, new AbortController().signal)).toEqual(ok(undefined))
    expect(replaced).toBe(true)
    expect(body).toContain('### 🤖 REPAIR · Git worktree ready')
  })
})
