import type { ClaimedIssueTriageTask } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { createIssueTriageCommentController } from '../src/issue-triage-comment-controller.ts'
import { ok } from '../src/result.ts'
import { issueItem, repositoryMapping } from './fixtures.ts'

describe('issue triage publication', () => {
  it('publishes one matching comment and routing label', async () => {
    const repository = repositoryMapping()
    const issue = issueItem()
    const task = {
      id: 'triage-task',
      kind: 'issue_triage',
      repository: repository.github,
      issueNumber: issue.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'triage-worker', fence: 2, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      updatedAt: issue.updatedAt,
      repositoryMapping: repository,
      issue,
    } satisfies ClaimedIssueTriageTask
    const stamped: string[] = []
    let body = ''
    let stagedBody = ''
    const controller = createIssueTriageCommentController({
      github: {
        getIssueTriageSnapshot: () => Promise.resolve(ok({
          body: 'Reproduction',
          comments: [],
          state: 'open',
          title: issue.title,
          updatedAt: issue.updatedAt,
        })),
        stampAgentLabel: (_repository, _number, state) => {
          stamped.push(state)
          return Promise.resolve(ok(undefined))
        },
        upsertIssueTriageComment: (_repository, _number, _commentId, publishedBody) => {
          body = publishedBody
          return Promise.resolve(ok({ commentId: 42, url: 'https://github.com/harlan-zw/example/issues/12#issuecomment-42' }))
        },
      },
      leaseMilliseconds: 60_000,
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        stageIssueTriageComment: (input) => {
          stagedBody = input.body
          return { _tag: 'Staged', commandId: 'triage-comment' }
        },
        claimIssueTriageComment: () => ({
          id: 'triage-comment',
          taskId: task.id,
          repository: repository.github,
          issueNumber: issue.number,
          revisionId: task.revisionId,
          expectedUpdatedAt: issue.updatedAt,
          body: stagedBody,
          outcomeUnknown: false,
          commentId: null,
          workerId: 'comment-worker',
          fence: 1,
          leaseExpiresAt: '2026-08-13T02:00:00.000Z',
          repositoryMapping: repository,
        }),
        completeIssueTriageComment: () => true,
        deferIssueTriageComment: () => true,
      },
      workerId: 'comment-worker',
    })

    const result = await controller.publish(task, {
      _tag: 'READY_TO_SPEC',
      difficulty: 4,
      impact: 4,
      hasReproduction: true,
      needsCodebaseReview: true,
      summary: 'The goal is clear, but the API shape is undecided.',
      nextAction: 'Write a technical specification.',
    }, new AbortController().signal)

    expect(result).toEqual(ok({ commentId: 42, url: 'https://github.com/harlan-zw/example/issues/12#issuecomment-42' }))
    expect(stamped).toEqual(['READY_TO_SPEC'])
    expect(body).toContain('- **Route:** Ready to spec')
  })
})
