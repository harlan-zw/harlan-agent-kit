import { describe, expect, it } from 'vitest'
import { createApprovalController } from '../src/approval-controller.ts'
import { ok } from '../src/result.ts'
import { issueItem, pullRequestItem, repositoryMapping } from './fixtures.ts'

const unusedIssueApproval = {
  approveIssueWork: () => { throw new Error('Unexpected issue Approval.') },
  isIssueWorkApprovalReady: () => false,
}

describe('approval controller', () => {
  it('always accepts Harlan-authored pull requests without an Approval label', async () => {
    const calls: string[] = []
    const controller = createApprovalController({
      github: {
        consumeApprovalLabel: () => {
          calls.push('consume')
          return Promise.resolve(ok(undefined))
        },
        ensureApprovalLabel: () => {
          calls.push('ensure')
          return Promise.resolve(ok(undefined))
        },
        upsertReviewStatus: () => {
          calls.push('comment')
          return Promise.resolve(ok({ commentId: 1, url: 'url' }))
        },
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        ...unusedIssueApproval,
        recordApprovalPromptComment: () => true,
        getSelectionMode: () => 'auto' as const,
        hasPullRequestApproval: () => false,
        approvePullRequest: () => {
          calls.push('approve')
          return { _tag: 'Rejected', reason: { _tag: 'ApprovalNotRequired' } }
        },
      },
    })

    expect(await controller.reconcile(repositoryMapping(), pullRequestItem({ author: 'harlan-zw' }), 'a'.repeat(64), new AbortController().signal)).toEqual(ok(undefined))
    expect(calls).toEqual([])
  })

  it('posts one self-identified instruction for an outside contributor', async () => {
    let body = ''
    const controller = createApprovalController({
      github: {
        consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label consumption.')),
        ensureApprovalLabel: () => Promise.resolve(ok(undefined)),
        upsertReviewStatus: (_repository, _number, _commentId, value) => {
          body = value
          return Promise.resolve(ok({ commentId: 1, url: 'url' }))
        },
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: { ...unusedIssueApproval, recordApprovalPromptComment: () => true, getSelectionMode: () => 'auto' as const, hasPullRequestApproval: () => false, approvePullRequest: () => { throw new Error('Unexpected Approval.') } },
    })

    expect(await controller.reconcile(repositoryMapping(), pullRequestItem({ author: 'contributor' }), 'a'.repeat(64), new AbortController().signal)).toEqual(ok(undefined))
    expect(body).toContain('[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) posted this automated status.')
    expect(body).toContain('<!-- reviewed-sha: abc123 -->')
    expect(body).toContain('`harlan-agent-review` label')
    expect(body).toContain('head commit `abc123`')
  })

  it('keeps the label and approves the exact head commit', async () => {
    const calls: string[] = []
    const revisionId = 'a'.repeat(64)
    const controller = createApprovalController({
      github: {
        consumeApprovalLabel: () => {
          calls.push('consume')
          return Promise.resolve(ok(undefined))
        },
        ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label creation.')),
        upsertReviewStatus: () => Promise.reject(new Error('Unexpected comment.')),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        ...unusedIssueApproval,
        recordApprovalPromptComment: () => true,
        getSelectionMode: () => 'auto' as const,
        hasPullRequestApproval: () => false,
        approvePullRequest(input) {
          calls.push('approve')
          expect(input.revisionId).toBe(revisionId)
          return { _tag: 'Approved', approval: { _tag: 'ReviewApproved', approvedAt: input.at } }
        },
      },
    })

    expect(await controller.reconcile(repositoryMapping(), pullRequestItem({ author: 'contributor', approvalLabels: ['review'] }), revisionId, new AbortController().signal)).toEqual(ok(undefined))
    expect(calls).toEqual(['approve'])
  })

  it('approves a later head commit when the label is still present', async () => {
    const calls: string[] = []
    const firstRevision = 'a'.repeat(64)
    const secondRevision = 'b'.repeat(64)
    const approvals = new Set<string>()
    const controller = createApprovalController({
      github: {
        consumeApprovalLabel: () => {
          calls.push('consume')
          return Promise.resolve(ok(undefined))
        },
        ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label creation.')),
        upsertReviewStatus: () => Promise.reject(new Error('Unexpected comment.')),
      },
      now: () => new Date('2026-08-14T01:00:00.000Z'),
      store: {
        ...unusedIssueApproval,
        recordApprovalPromptComment: () => true,
        getSelectionMode: () => 'auto' as const,
        hasPullRequestApproval: (_repository, _number, revisionId) => approvals.has(revisionId),
        approvePullRequest(input) {
          calls.push('approve')
          approvals.add(input.revisionId)
          return { _tag: 'Approved', approval: { _tag: 'ReviewApproved', approvedAt: input.at } }
        },
      },
    })
    const pullRequest = pullRequestItem({ author: 'contributor', approvalLabels: ['review'] })

    expect(await controller.reconcile(repositoryMapping(), pullRequest, firstRevision, new AbortController().signal)).toEqual(ok(undefined))
    expect(calls).toEqual(['approve'])
    calls.length = 0
    expect(await controller.reconcile(repositoryMapping(), pullRequest, secondRevision, new AbortController().signal)).toEqual(ok(undefined))
    expect(calls).toEqual(['approve'])
  })

  it('fails closed when the label disappears before approval', async () => {
    let approved = false
    const controller = createApprovalController({
      github: {
        consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label consumption.')),
        ensureApprovalLabel: () => Promise.resolve(ok(undefined)),
        upsertReviewStatus: () => Promise.resolve(ok({ commentId: 1, url: 'url' })),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        ...unusedIssueApproval,
        recordApprovalPromptComment: () => true,
        getSelectionMode: () => 'auto' as const,
        hasPullRequestApproval: () => false,
        approvePullRequest: () => {
          approved = true
          return { _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }
        },
      },
    })

    expect(await controller.reconcile(repositoryMapping(), pullRequestItem({ author: 'contributor' }), 'a'.repeat(64), new AbortController().signal)).toEqual(ok(undefined))
    expect(approved).toBe(false)
  })

  it('keeps an existing head commit Approval without posting again', async () => {
    const controller = createApprovalController({
      github: {
        consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label consumption.')),
        ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label creation.')),
        upsertReviewStatus: () => Promise.reject(new Error('Unexpected comment.')),
      },
      now: () => new Date('2026-08-14T01:00:00.000Z'),
      store: {
        ...unusedIssueApproval,
        recordApprovalPromptComment: () => true,
        getSelectionMode: () => 'auto' as const,
        hasPullRequestApproval: () => true,
        approvePullRequest: () => { throw new Error('Unexpected Approval.') },
      },
    })

    expect(await controller.reconcile(repositoryMapping(), pullRequestItem({ author: 'contributor' }), 'a'.repeat(64), new AbortController().signal)).toEqual(ok(undefined))
  })

  it('leaves an outside issue Approval label until Ready to implement triage finishes', async () => {
    const calls: string[] = []
    const controller = createApprovalController({
      github: {
        consumeApprovalLabel: () => {
          calls.push('consume')
          return Promise.resolve(ok(undefined))
        },
        ensureApprovalLabel: () => {
          calls.push('ensure')
          return Promise.resolve(ok(undefined))
        },
        upsertReviewStatus: () => Promise.reject(new Error('Unexpected comment.')),
      },
      now: () => new Date('2026-08-14T01:00:00.000Z'),
      store: {
        recordApprovalPromptComment: () => true,
        getSelectionMode: () => 'auto' as const,
        hasPullRequestApproval: () => false,
        isIssueWorkApprovalReady: () => false,
        approveIssueWork: () => { throw new Error('Unexpected Approval.') },
        approvePullRequest: () => { throw new Error('Unexpected Approval.') },
      },
    })

    const issue = issueItem({ approvalLabels: ['review'] })
    expect(await controller.reconcile(repositoryMapping(), issue, 'a'.repeat(64), new AbortController().signal)).toEqual(ok(undefined))
    expect(calls).toEqual([])
  })

  it('makes the shared Approval label available after valid issue triage', async () => {
    const calls: string[] = []
    const controller = createApprovalController({
      github: {
        consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label consumption.')),
        ensureApprovalLabel: () => {
          calls.push('ensure')
          return Promise.resolve(ok(undefined))
        },
        upsertReviewStatus: () => Promise.reject(new Error('Unexpected comment.')),
      },
      now: () => new Date('2026-08-14T01:00:00.000Z'),
      store: {
        recordApprovalPromptComment: () => true,
        getSelectionMode: () => 'auto' as const,
        hasPullRequestApproval: () => false,
        isIssueWorkApprovalReady: () => true,
        approveIssueWork: () => { throw new Error('Unexpected Approval.') },
        approvePullRequest: () => { throw new Error('Unexpected Approval.') },
      },
    })

    expect(await controller.reconcile(repositoryMapping(), issueItem({ author: 'contributor' }), 'a'.repeat(64), new AbortController().signal)).toEqual(ok(undefined))
    expect(calls).toEqual(['ensure'])
  })

  it('fails when the prompt comment cannot be recorded', async () => {
    const controller = createApprovalController({
      github: {
        consumeApprovalLabel: () => Promise.reject(new Error('Unexpected label consumption.')),
        ensureApprovalLabel: () => Promise.resolve(ok(undefined)),
        upsertReviewStatus: () => Promise.resolve(ok({ commentId: 1, url: 'url' })),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        ...unusedIssueApproval,
        recordApprovalPromptComment: () => false,
        getSelectionMode: () => 'auto' as const,
        hasPullRequestApproval: () => false,
        approvePullRequest: () => { throw new Error('Unexpected Approval.') },
      },
    })

    const result = await controller.reconcile(repositoryMapping(), pullRequestItem({ author: 'contributor' }), 'a'.repeat(64), new AbortController().signal)
    expect(result._tag).toBe('Err')
  })

  it('consumes the shared label before approving the exact outside issue state', async () => {
    const calls: string[] = []
    let consumedItemKind: unknown
    const revisionId = 'a'.repeat(64)
    const controller = createApprovalController({
      github: {
        consumeApprovalLabel: (...args: unknown[]) => {
          consumedItemKind = args[1]
          calls.push('consume')
          return Promise.resolve(ok(undefined))
        },
        ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label creation.')),
        upsertReviewStatus: () => Promise.reject(new Error('Unexpected comment.')),
      },
      now: () => new Date('2026-08-14T01:00:00.000Z'),
      store: {
        recordApprovalPromptComment: () => true,
        getSelectionMode: () => 'auto' as const,
        hasPullRequestApproval: () => false,
        isIssueWorkApprovalReady: () => true,
        approveIssueWork(input) {
          calls.push('approve')
          expect(input.revisionId).toBe(revisionId)
          return { _tag: 'Approved', taskId: 'task' }
        },
        approvePullRequest: () => { throw new Error('Unexpected pull request Approval.') },
      },
    })

    const issue = issueItem({ approvalLabels: ['review'] })
    expect(await controller.reconcile(repositoryMapping(), issue, revisionId, new AbortController().signal)).toEqual(ok(undefined))
    expect(calls).toEqual(['consume', 'approve'])
    expect(consumedItemKind).toBe('issue')
  })
})
