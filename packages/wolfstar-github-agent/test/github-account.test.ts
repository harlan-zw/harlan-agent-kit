import type { Octokit } from 'octokit'
import type { GitHubTokenProvider } from '../src/github-auth.ts'
import type { GitHubAccount } from '../src/types.ts'
import { expect, it, vi } from 'vitest'
import { createGitHubAccountTokenProvider, githubAccountBody } from '../src/github-account.ts'
import { createGitHubAgentSource } from '../src/github-agent-source.ts'
import { AUTOMATED_ISSUE_TRIAGE_MARKER } from '../src/issue-triage-comment.ts'
import { err, ok } from '../src/result.ts'
import { AUTOMATED_REVIEW_MARKER, automatedDisclosure } from '../src/review-comment.ts'
import { isRoutineTrackingIssue, trackingIssueBody } from '../src/routine-report-controller.ts'
import { repositoryMapping } from './fixtures.ts'

const account: GitHubAccount = {
  login: 'im-brundlefly',
  tokenPath: '/private/brundlefly-token',
  name: 'Brundlefly',
  url: 'https://github.com/wolfstar-project/brundlefly',
  instructions: 'Use short, clear sentences.',
}
const repository = 'wolfstar-project/brundlefly'
const now = () => new Date('2026-10-12T00:00:00Z')

function provider(readLogin: () => Promise<string>, readToken = async () => 'account-token') {
  const fallback: GitHubTokenProvider = {
    getToken: vi.fn(async () => ok({ token: 'fallback-token', expiresAt: '2126-01-01T00:00:00Z' })),
    invalidate: vi.fn(),
  }
  return {
    fallback,
    tokens: createGitHubAccountTokenProvider({
      fallback,
      account: (name) => (name.toLowerCase() === repository ? account : undefined),
      readToken,
      readLogin,
      now,
    }),
  }
}

it('uses the verified account for its repository and the existing route elsewhere', async () => {
  const login = vi.fn(async () => 'im-brundlefly')
  const { tokens, fallback } = provider(login)
  expect(await tokens.getToken(repository, 'item_write')).toEqual(
    ok({ token: 'account-token', expiresAt: '2026-10-12T00:05:00.000Z' }),
  )
  expect(await tokens.getToken(repository, 'read')).toEqual(
    ok({ token: 'account-token', expiresAt: '2026-10-12T00:05:00.000Z' }),
  )
  expect(login).toHaveBeenCalledTimes(1)
  expect(await tokens.getToken('wolfstar-project/other', 'read')).toEqual(
    ok({ token: 'fallback-token', expiresAt: '2126-01-01T00:00:00Z' }),
  )
  expect(fallback.getToken).toHaveBeenCalledWith('wolfstar-project/other', 'read', undefined)
})

it('refuses a credential for the wrong account without using the owner or App', async () => {
  const { tokens, fallback } = provider(async () => 'wolfstar-project')
  expect(await tokens.getToken(repository, 'item_write')).toEqual(
    err({ repository, message: 'The controller credential does not belong to @im-brundlefly.' }),
  )
  expect(fallback.getToken).not.toHaveBeenCalled()
})

it('surfaces unreadable credentials without leaking the exception or using another account', async () => {
  const { tokens, fallback } = provider(
    async () => 'im-brundlefly',
    async () => {
      throw new Error('secret diagnostic')
    },
  )
  expect(await tokens.getToken(repository, 'item_write')).toEqual(
    err({ repository, message: 'The controller credential for @im-brundlefly could not be verified.' }),
  )
  expect(fallback.getToken).not.toHaveBeenCalled()
})

it('rechecks identity after a rejected credential is invalidated', async () => {
  const login = vi.fn().mockResolvedValueOnce('im-brundlefly').mockResolvedValueOnce('wolfstar-project')
  const { tokens } = provider(login)
  await tokens.getToken(repository, 'read')
  tokens.invalidate(repository, 'item_write')
  expect((await tokens.getToken(repository, 'item_write'))._tag).toBe('Err')
})

it('changes automated attribution while preserving evidence, markers, and commands', () => {
  const disclosure = automatedDisclosure({
    kind: 'triage',
    disclaimer: "It is not Wolfstar's personal assessment or commitment.",
  })
  const evidence = `<!-- wolfstar-agent-kit:issue-triage -->\nWolfstar Agent Kit owns this code.\n\`\`\`text\n${disclosure}\n\`\`\`\n`
  const result = githubAccountBody(evidence + disclosure, account)
  expect(result).toBe(
    `${evidence}> [Brundlefly](https://github.com/wolfstar-project/brundlefly) posted this automated triage. [AI open source policy](https://harlanzw.com/blog/ai-in-open-source).`,
  )
  expect(githubAccountBody(evidence + disclosure)).toBe(evidence + disclosure)
})

it('recognises both original and branded Routine logs for the configured repository', () => {
  const input = {
    repository,
    title: 'ci-review: run log for wolfstar-project/brundlefly',
    labels: ['routine:ci-review'],
  }
  expect(isRoutineTrackingIssue({ ...input, body: trackingIssueBody('ci-review'), account })).toBe(true)
  expect(
    isRoutineTrackingIssue({ ...input, body: githubAccountBody(trackingIssueBody('ci-review'), account), account }),
  ).toBe(true)
  expect(isRoutineTrackingIssue({ ...input, body: 'Unrelated content', account })).toBe(false)
})

it('creates an account-owned issue comment after migration and updates it on the next run', async () => {
  const old = {
    id: 1,
    user: { login: 'wolfstar-github-agent[bot]' },
    body: AUTOMATED_ISSUE_TRIAGE_MARKER,
    html_url: 'https://github.com/old',
  }
  const comments = [old]
  const createComment = vi.fn(async (input: { body: string }) => {
    const comment = { id: 2, user: { login: account.login }, body: input.body, html_url: 'https://github.com/new' }
    comments.push(comment)
    return { data: comment }
  })
  const updateComment = vi.fn(async (input: { comment_id: number; body: string }) => {
    const comment = comments.find((comment) => comment.id === input.comment_id)!
    comment.body = input.body
    return { data: comment }
  })
  const source = createGitHubAgentSource({
    actorLogin: () => account.login,
    ownAppId: 123,
    tokens: {
      getToken: async () => ok({ token: 'account-token', expiresAt: '2126-01-01T00:00:00Z' }),
      invalidate: () => undefined,
    },
    createClient: () =>
      ({
        paginate: async () => comments,
        rest: {
          issues: {
            listComments: () => undefined,
            createComment,
            updateComment,
            getComment: async (input: { comment_id: number }) => ({
              data: comments.find((comment) => comment.id === input.comment_id)!,
            }),
          },
        },
      }) as unknown as Octokit,
  })
  const mapping = repositoryMapping({ github: repository, authentication: 'user', githubAccount: account })
  const signal = new AbortController().signal
  const body = `${AUTOMATED_ISSUE_TRIAGE_MARKER}\n${automatedDisclosure({ kind: 'triage' })}`
  expect(await source.upsertIssueTriageComment(mapping, 44, 1, body, signal)).toEqual(
    ok({ commentId: 2, url: 'https://github.com/new' }),
  )
  expect(createComment).toHaveBeenCalledWith(expect.objectContaining({ body: githubAccountBody(body, account) }))
  expect(updateComment).not.toHaveBeenCalled()
  const updated = `${body}\nNext action: inspect the failing job.`
  expect(await source.upsertIssueTriageComment(mapping, 44, 2, updated, signal)).toEqual(
    ok({ commentId: 2, url: 'https://github.com/new' }),
  )
  expect(updateComment).toHaveBeenCalledWith(
    expect.objectContaining({ comment_id: 2, body: githubAccountBody(updated, account) }),
  )
  expect(old.body).toBe(AUTOMATED_ISSUE_TRIAGE_MARKER)
})

it('uses the account attribution for inline review findings', async () => {
  const createReviewComment = vi.fn(async () => ({ data: { id: 3 } }))
  const source = createGitHubAgentSource({
    actorLogin: () => account.login,
    ownAppId: 123,
    tokens: {
      getToken: async () => ok({ token: 'account-token', expiresAt: '2126-01-01T00:00:00Z' }),
      invalidate: () => undefined,
    },
    createClient: () => ({ rest: { pulls: { createReviewComment } } }) as unknown as Octokit,
  })
  const mapping = repositoryMapping({ github: repository, authentication: 'user', githubAccount: account })
  const body = `Inspect the failing condition.\n${automatedDisclosure({ kind: 'review' })}`
  expect(
    await source.postReviewFindingComment(
      mapping,
      44,
      {
        headSha: 'a'.repeat(40),
        path: 'src/example.ts',
        line: 10,
        body,
      },
      new AbortController().signal,
      () => ok(undefined),
    ),
  ).toEqual(ok({ _tag: 'Posted' }))
  expect(createReviewComment).toHaveBeenCalledWith(expect.objectContaining({ body: githubAccountBody(body, account) }))
})

it('refuses owner credentials when a dedicated account edits a legacy review', async () => {
  const body = `${AUTOMATED_REVIEW_MARKER}\n<!-- reviewed-sha: ${'a'.repeat(40)} -->\nReview in progress.`
  const legacyTokens: GitHubTokenProvider = {
    getToken: vi.fn(async () => ok({ token: 'owner-token', expiresAt: '2126-01-01T00:00:00Z' })),
    invalidate: vi.fn(),
  }
  const updateComment = vi.fn(async () => undefined)
  const source = createGitHubAgentSource({
    actorLogin: () => account.login,
    ownAppId: 123,
    tokens: {
      getToken: async () => ok({ token: 'account-token', expiresAt: '2126-01-01T00:00:00Z' }),
      invalidate: () => undefined,
    },
    legacyActor: { login: 'wolfstar-project', tokens: legacyTokens },
    createClient: () =>
      ({
        rest: {
          issues: {
            getComment: async () => ({
              data: { id: 1, user: { login: 'wolfstar-project' }, body, html_url: 'https://github.com/old' },
            }),
            updateComment,
          },
        },
      }) as unknown as Octokit,
  })
  const mapping = repositoryMapping({ github: repository, authentication: 'user', githubAccount: account })
  expect(
    await source.editReviewStatus(mapping, 44, 1, body, `${body}\nComplete.`, new AbortController().signal, () =>
      ok(undefined),
    ),
  ).toEqual(
    ok({
      _tag: 'Foreign',
      reason: 'The stored automated review comment belongs to another GitHub actor.',
    }),
  )
  expect(legacyTokens.getToken).not.toHaveBeenCalled()
  expect(updateComment).not.toHaveBeenCalled()
})
