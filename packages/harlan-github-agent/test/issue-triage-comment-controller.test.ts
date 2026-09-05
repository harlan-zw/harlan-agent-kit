import type { IssueTriageSnapshot } from '../src/github-agent-source.ts'
import type { ClaimedIssueTriageTask } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { createIssueTriageCommentController } from '../src/issue-triage-comment-controller.ts'
import { err, ok } from '../src/result.ts'
import { issueItem, repositoryMapping } from './fixtures.ts'

function triageTask(): ClaimedIssueTriageTask {
  const repository = repositoryMapping()
  const issue = issueItem()
  return {
    id: 'triage-task',
    kind: 'issue_triage',
    repository: repository.github,
    issueNumber: issue.number,
    revisionId: 'revision-1',
    state: { _tag: 'Running', workerId: 'triage-worker', fence: 2, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
    updatedAt: issue.updatedAt,
    repositoryMapping: repository,
    issue,
  }
}

const readyResult = {
  _tag: 'READY_TO_SPEC',
  difficulty: 4,
  impact: 4,
  hasReproduction: true,
  needsCodebaseReview: true,
  summary: 'The goal is clear, but the API shape is undecided.',
  nextAction: 'Write a technical specification.',
  relatedIssues: [],
} as const

function controllerWithSnapshot(snapshot: IssueTriageSnapshot) {
  const deferred: string[] = []
  const published: number[] = []
  const task = triageTask()
  const controller = createIssueTriageCommentController({
    github: {
      getIssueTriageSnapshot: () => Promise.resolve(ok(snapshot)),
      stampAgentLabel: () => Promise.resolve(ok(undefined)),
      upsertIssueTriageComment: (_repository, _number, _commentId, _body) => {
        published.push(1)
        return Promise.resolve(ok({ commentId: 42, url: 'https://github.com/harlan-zw/example/issues/12#issuecomment-42' }))
      },
    },
    leaseMilliseconds: 60_000,
    now: () => new Date('2026-08-13T01:00:00.000Z'),
    store: {
      stageIssueTriageComment: () => ({ _tag: 'Staged', commandId: 'triage-comment' }),
      claimIssueTriageComment: () => ({
        id: 'triage-comment',
        taskId: task.id,
        repository: task.repository,
        issueNumber: task.issueNumber,
        revisionId: task.revisionId,
        body: 'body',
        outcomeUnknown: false,
        commentId: null,
        workerId: 'comment-worker',
        fence: 1,
        leaseExpiresAt: '2026-08-13T02:00:00.000Z',
        repositoryMapping: task.repositoryMapping,
      }),
      completeIssueTriageComment: () => true,
      deferIssueTriageComment: (input) => {
        deferred.push(input.reason)
        return true
      },
    },
    workerId: 'comment-worker',
  })
  return { controller, deferred, published, task }
}

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
      relatedIssues: [],
    }, new AbortController().signal)

    expect(result).toEqual(ok({ commentId: 42, url: 'https://github.com/harlan-zw/example/issues/12#issuecomment-42' }))
    expect(stamped).toEqual(['READY_TO_SPEC'])
    expect(body).toContain('- **Route:** Ready to spec')
  })

  it('publishes after the Running label moved updatedAt', async () => {
    // The service's own Running label write bumps updatedAt, so a snapshot
    // never answers the timestamp the claim observed. Publication must not
    // wait for a timestamp that can never return.
    const { controller, deferred, published, task } = controllerWithSnapshot({
      body: 'Reproduction',
      comments: [],
      state: 'open',
      title: 'Broken thing',
      updatedAt: '2026-08-13T01:01:30.000Z',
    })

    const result = await controller.publish(task, readyResult, new AbortController().signal)

    expect(result).toEqual(ok({ commentId: 42, url: 'https://github.com/harlan-zw/example/issues/12#issuecomment-42' }))
    expect(published).toHaveLength(1)
    expect(deferred).toEqual([])
  })

  it('defers when the issue closed before publication', async () => {
    const { controller, deferred, task } = controllerWithSnapshot({
      body: 'Reproduction',
      comments: [],
      state: 'closed',
      title: 'Broken thing',
      updatedAt: '2026-08-13T01:01:30.000Z',
    })

    const result = await controller.publish(task, readyResult, new AbortController().signal)

    expect(result).toEqual(err('The issue changed before the triage comment was posted.'))
    expect(deferred).toEqual(['The issue changed before the triage comment was posted.'])
  })
})
