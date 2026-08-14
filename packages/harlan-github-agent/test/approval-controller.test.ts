import { describe, expect, it } from 'vitest'
import { createApprovalController } from '../src/approval-controller.ts'
import { err, ok } from '../src/result.ts'
import { issueSubject, pullRequestSubject, repositoryMapping } from './fixtures.ts'

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
        hasPullRequestApproval: () => false,
        approvePullRequest: () => {
          calls.push('approve')
          return { _tag: 'Rejected', reason: { _tag: 'ApprovalNotRequired' } }
        },
      },
    })

    expect(await controller.reconcile(repositoryMapping(), pullRequestSubject({ author: 'harlan-zw' }), 'a'.repeat(64), new AbortController().signal)).toEqual(ok(undefined))
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
      store: { ...unusedIssueApproval, hasPullRequestApproval: () => false, approvePullRequest: () => { throw new Error('Unexpected Approval.') } },
    })

    expect(await controller.reconcile(repositoryMapping(), pullRequestSubject({ author: 'contributor' }), 'a'.repeat(64), new AbortController().signal)).toEqual(ok(undefined))
    expect(body).toContain('Harlan GitHub Agent posted this automated comment.')
    expect(body).toContain('<!-- reviewed-sha: abc123 -->')
    expect(body).toContain('`harlan-agent-review` label')
    expect(body).toContain('head commit `abc123`')
  })

  it('consumes the label before approving its exact head commit', async () => {
    const calls: string[] = []
    let consumedSubjectKind: unknown
    const revisionId = 'a'.repeat(64)
    const controller = createApprovalController({
      github: {
        consumeApprovalLabel: (...args: unknown[]) => {
          consumedSubjectKind = args[1]
          calls.push('consume')
          return Promise.resolve(ok(undefined))
        },
        ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label creation.')),
        upsertReviewStatus: () => Promise.reject(new Error('Unexpected comment.')),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        ...unusedIssueApproval,
        hasPullRequestApproval: () => false,
        approvePullRequest(input) {
          calls.push('approve')
          expect(input.revisionId).toBe(revisionId)
          return { _tag: 'Approved', approval: { _tag: 'ReviewApproved', approvedAt: input.at } }
        },
      },
    })

    expect(await controller.reconcile(repositoryMapping(), pullRequestSubject({ author: 'contributor', approvalLabels: ['review'] }), revisionId, new AbortController().signal)).toEqual(ok(undefined))
    expect(calls).toEqual(['consume', 'approve'])
    expect(consumedSubjectKind).toBe('pull_request')
  })

  it('fails closed when label consumption cannot be confirmed', async () => {
    let approved = false
    const controller = createApprovalController({
      github: {
        consumeApprovalLabel: () => Promise.resolve(err('Label remains.')),
        ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label creation.')),
        upsertReviewStatus: () => Promise.reject(new Error('Unexpected comment.')),
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      store: {
        ...unusedIssueApproval,
        hasPullRequestApproval: () => false,
        approvePullRequest: () => {
          approved = true
          return { _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }
        },
      },
    })

    expect(await controller.reconcile(repositoryMapping(), pullRequestSubject({ author: 'contributor', approvalLabels: ['review'] }), 'a'.repeat(64), new AbortController().signal)).toEqual(err('Label remains.'))
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
        hasPullRequestApproval: () => true,
        approvePullRequest: () => { throw new Error('Unexpected Approval.') },
      },
    })

    expect(await controller.reconcile(repositoryMapping(), pullRequestSubject({ author: 'contributor' }), 'a'.repeat(64), new AbortController().signal)).toEqual(ok(undefined))
  })

  it('leaves an outside issue Approval label until valid triage finishes', async () => {
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
        hasPullRequestApproval: () => false,
        isIssueWorkApprovalReady: () => false,
        approveIssueWork: () => { throw new Error('Unexpected Approval.') },
        approvePullRequest: () => { throw new Error('Unexpected Approval.') },
      },
    })

    const issue = issueSubject({ approvalLabels: ['review'] })
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
        hasPullRequestApproval: () => false,
        isIssueWorkApprovalReady: () => true,
        approveIssueWork: () => { throw new Error('Unexpected Approval.') },
        approvePullRequest: () => { throw new Error('Unexpected Approval.') },
      },
    })

    expect(await controller.reconcile(repositoryMapping(), issueSubject({ author: 'contributor' }), 'a'.repeat(64), new AbortController().signal)).toEqual(ok(undefined))
    expect(calls).toEqual(['ensure'])
  })

  it('consumes the shared label before approving the exact outside issue state', async () => {
    const calls: string[] = []
    let consumedSubjectKind: unknown
    const revisionId = 'a'.repeat(64)
    const controller = createApprovalController({
      github: {
        consumeApprovalLabel: (...args: unknown[]) => {
          consumedSubjectKind = args[1]
          calls.push('consume')
          return Promise.resolve(ok(undefined))
        },
        ensureApprovalLabel: () => Promise.reject(new Error('Unexpected label creation.')),
        upsertReviewStatus: () => Promise.reject(new Error('Unexpected comment.')),
      },
      now: () => new Date('2026-08-14T01:00:00.000Z'),
      store: {
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

    const issue = issueSubject({ approvalLabels: ['review'] })
    expect(await controller.reconcile(repositoryMapping(), issue, revisionId, new AbortController().signal)).toEqual(ok(undefined))
    expect(calls).toEqual(['consume', 'approve'])
    expect(consumedSubjectKind).toBe('issue')
  })
})
