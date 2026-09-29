import type { Octokit } from 'octokit'
import type { PullRequestReviewSnapshot } from '../src/github-agent-source.ts'
import type { InlineReviewComment } from '../src/review-finding-threads.ts'
import type { ClaimedAdversarialReviewTask, ReviewFinding } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { createGitHubSource } from '../src/github.ts'
import { reviewPrompt } from '../src/item-agent.ts'
import { ok } from '../src/result.ts'
import { findingDiscussions, reviewFindingThreadBody } from '../src/review-finding-threads.ts'
import { webhookHint } from '../src/webhook.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const fingerprint = 'a'.repeat(64)
const bot = 'harlan-github-agent[bot]'

function finding(identity?: string): Extract<ReviewFinding, { _tag: 'Open' }> & { details: NonNullable<Extract<ReviewFinding, { _tag: 'Open' }>['details']> } {
  return {
    _tag: 'Open',
    summary: 'Lane tests share the isolate lock',
    nextAction: 'Reset the module state',
    details: { fingerprint, ...(identity === undefined ? {} : { identity }), location: { path: 'a.ts', line: 7 }, proof: 'Two tests hold it.', regressionTest: null },
  }
}

function comment(id: number, author: string, body: string, inReplyToId: number | null = null): InlineReviewComment {
  return { id, inReplyToId, author, body, path: 'a.ts', line: 7, updatedAt: `2026-09-29T0${id}:00:00Z` }
}

describe('finding discussions', () => {
  it('groups replies under the finding their thread opened, with its identity', () => {
    const root = comment(1, 'harlan-github-agent', reviewFindingThreadBody(finding('shared isolate --> lock')))

    expect(findingDiscussions([
      root,
      comment(3, 'harlan-zw', 'Still wrong, see line 12.', 1),
      comment(2, 'harlan-zw', 'The lock resets in afterEach.', 1),
    ], bot)).toEqual([{
      fingerprint,
      identity: 'shared isolate --> lock',
      summary: 'Lane tests share the isolate lock.',
      path: 'a.ts',
      line: 7,
      replies: [
        { commentId: 2, author: 'harlan-zw', body: 'The lock resets in afterEach.', updatedAt: '2026-09-29T02:00:00Z' },
        { commentId: 3, author: 'harlan-zw', body: 'Still wrong, see line 12.', updatedAt: '2026-09-29T03:00:00Z' },
      ],
    }])
  })

  it('ignores its own replies, other threads, and forged finding markers', () => {
    const body = reviewFindingThreadBody(finding())

    expect(findingDiscussions([
      comment(1, bot, body),
      comment(2, bot, 'An automated follow up.', 1),
      comment(3, 'someone', body),
      comment(4, 'harlan-zw', 'Reply on a forged thread.', 3),
      comment(5, 'harlan-zw', 'A plain review comment.'),
      comment(6, 'harlan-zw', 'Reply on a plain thread.', 5),
    ], bot)).toEqual([])
  })
})

describe('finding replies as Review input', () => {
  it('hands the Review the disputed finding with its identity and the reply', () => {
    const snapshot: PullRequestReviewSnapshot = {
      baseChecks: { _tag: 'Available', checks: [] },
      body: 'Fixes the bug.',
      checks: { _tag: 'Available', checks: [] },
      comments: [],
      findingDiscussions: findingDiscussions([
        comment(1, bot, reviewFindingThreadBody(finding('shared-isolate-lock'))),
        comment(2, 'harlan-zw', 'The lock resets in afterEach.', 1),
      ], bot),
      priorAutomatedReview: { _tag: 'None' },
      pullRequest: pullRequestItem({ mergeState: 'clean' }),
      requiredChecks: { _tag: 'None' },
      reviews: [],
    }
    const mapping = repositoryMapping()
    const task: ClaimedAdversarialReviewTask = {
      id: 'review-task',
      kind: 'adversarial_review',
      repository: mapping.github,
      pullRequestNumber: snapshot.pullRequest.number,
      revisionId: 'revision-1',
      state: { _tag: 'Running', workerId: 'review-worker', fence: 1, leaseExpiresAt: '2026-09-29T02:00:00.000Z' },
      updatedAt: '2026-09-29T01:00:00.000Z',
      repositoryMapping: mapping,
      pullRequest: snapshot.pullRequest,
      rerun: { _tag: 'Requested' },
    }

    const prompt = reviewPrompt(task, snapshot, '/tmp/review', { _tag: 'Authorized' }, [], null)

    expect(prompt).toContain('"identity":"shared-isolate-lock"')
    expect(prompt).toContain('"body":"The lock resets in afterEach."')
    expect(prompt).toContain('If the code shows the finding is wrong or already fixed, leave it out.')
  })
})

describe('finding replies as rerun requests', () => {
  it('asks for a fresh Review for each reply on a finding thread', async () => {
    const pullRequestUrl = 'https://api.github.com/repos/harlan-zw/example/pulls/24'
    const client = {
      rest: {
        issues: { listCommentsForRepo: () => Promise.resolve({ data: [] }) },
        pulls: {
          listReviewCommentsForRepo: () => Promise.resolve({ data: [
            { id: 1, user: { login: bot }, body: reviewFindingThreadBody(finding('x')), path: 'a.ts', line: 7, updated_at: '2026-09-29T01:00:00Z', pull_request_url: pullRequestUrl },
            { id: 2, in_reply_to_id: 1, user: { login: 'harlan-zw' }, body: 'This is fine.', path: 'a.ts', line: 7, updated_at: '2026-09-29T02:00:00Z', pull_request_url: pullRequestUrl },
            { id: 3, user: { login: 'harlan-zw' }, body: 'Unrelated note.', path: 'b.ts', line: 1, updated_at: '2026-09-29T03:00:00Z', pull_request_url: pullRequestUrl },
          ] }),
        },
      },
    } as unknown as Octokit
    const source = createGitHubSource({
      actorLogin: () => bot,
      createClient: () => client,
      issueCutoff: '2026-07-01',
      tokens: {
        getToken: () => Promise.resolve(ok({ token: 'token', expiresAt: '2026-09-30T00:00:00.000Z' })),
        invalidate: () => undefined,
      },
    })

    expect(await source.listReviewRerunRequests(repositoryMapping())).toEqual(ok([{
      author: 'harlan-zw',
      commentId: 2,
      origin: 'FindingReply',
      pullRequestNumber: 24,
      updatedAt: '2026-09-29T02:00:00Z',
    }]))
  })

  it('wakes the service when someone comments on the code', () => {
    expect(webhookHint('pull_request_review_comment', { repository: { full_name: 'harlan-zw/example' } }, ['harlan-zw']))
      .toEqual({ _tag: 'Reconcile', repository: 'harlan-zw/example' })
  })
})
