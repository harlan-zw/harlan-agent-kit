import type { Octokit } from 'octokit'
import { describe, expect, it, vi } from 'vitest'
import { createGitHubAgentSource } from '../src/github-agent-source.ts'
import { ok } from '../src/result.ts'
import { repositoryMapping } from './fixtures.ts'

const OWN_APP_ID = 5319979
const headSha = '1031dc93dddca88266cb32a085c7b90dcd58ec23'
const reviewing = `<!-- wolfstar-agent-kit:pr-triage -->
<!-- reviewed-sha: ${headSha} -->
### 🤖 REVIEWING · Adversarial review`
const ready = `<!-- wolfstar-agent-kit:pr-triage -->
<!-- reviewed-sha: ${headSha} -->
### 🤖 READY · Adversarial review`

interface FakeComment {
  id: number
  body: string
  html_url: string
  author_association: string
  user: { login: string }
  performed_via_github_app: { id: number } | null
}

function comment(id: number, login: string, appId: number | null, body = reviewing, association = 'NONE'): FakeComment {
  return {
    id,
    body,
    html_url: `https://github.com/wolfstar-project/example/pull/24#issuecomment-${id}`,
    author_association: association,
    user: { login },
    performed_via_github_app: appId === null ? null : { id: appId },
  }
}

/**
 * One pull request with its comments, as GitHub would answer.
 *
 * `writtenAs` is the login GitHub reports for what the controller writes now.
 * The controller expects `expectedActor`, which a renamed App no longer is.
 */
function pullRequest(options: {
  comments: FakeComment[]
  expectedActor: string
  writtenAs: string
  authentication?: 'app' | 'user'
}) {
  const comments = [...options.comments]
  const createComment = vi.fn((input: { body: string }) => {
    const created = comment(900 + comments.length, options.writtenAs, OWN_APP_ID, input.body)
    comments.push(created)
    return Promise.resolve({ data: created })
  })
  const updateComment = vi.fn((input: { comment_id: number; body: string }) => {
    const stored = comments.find((entry) => entry.id === input.comment_id)!
    stored.body = input.body
    return Promise.resolve({ data: stored })
  })
  const getComment = vi.fn((input: { comment_id: number }) =>
    Promise.resolve({ data: comments.find((entry) => entry.id === input.comment_id)! }),
  )
  const octokit = {
    paginate: () => Promise.resolve([...comments]),
    rest: { issues: { createComment, updateComment, getComment, listComments: vi.fn() } },
  } as unknown as Octokit
  const source = createGitHubAgentSource({
    actorLogin: () => options.expectedActor,
    ownAppId: OWN_APP_ID,
    createClient: () => octokit,
    tokens: {
      getToken: () => Promise.resolve(ok({ token: 'app-token', expiresAt: '2026-12-30T00:00:00.000Z' })),
      invalidate: () => undefined,
    },
  })
  const repository = repositoryMapping({ authentication: options.authentication ?? 'app' })
  const publish = (body: string) =>
    source.upsertReviewStatus(repository, 24, null, body, false, new AbortController().signal)
  return { comments, createComment, updateComment, publish }
}

describe('the controller finds its own review comment after the App was renamed', () => {
  it('updates the one comment the App wrote under its old name, and creates nothing', async () => {
    const { comments, createComment, publish, updateComment } = pullRequest({
      comments: [comment(11, 'wolfstar-github-agent[bot]', OWN_APP_ID)],
      expectedActor: 'wolfstar-project-agent-qfew[bot]',
      writtenAs: 'wolfstar-github-agent[bot]',
    })

    const result = await publish(ready)

    expect(result).toMatchObject({ _tag: 'Ok', value: { commentId: 11 } })
    expect(updateComment).toHaveBeenCalledTimes(1)
    expect(createComment).not.toHaveBeenCalled()
    expect(comments).toHaveLength(1)
    expect(comments[0]?.body).toBe(ready)
  })

  it('confirms a comment it just created even when GitHub names its author differently', async () => {
    const { comments, createComment, publish } = pullRequest({
      comments: [],
      expectedActor: 'wolfstar-project-agent-qfew[bot]',
      writtenAs: 'wolfstar-github-agent[bot]',
    })

    const first = await publish(reviewing)
    const second = await publish(ready)

    expect(first._tag).toBe('Ok')
    expect(second._tag).toBe('Ok')
    // The second attempt edits the first comment. It never adds another.
    expect(createComment).toHaveBeenCalledTimes(1)
    expect(comments).toHaveLength(1)
    expect(comments[0]?.body).toBe(ready)
  })

  it('keeps one comment across any number of retries', async () => {
    const { comments, createComment, publish } = pullRequest({
      comments: [],
      expectedActor: 'wolfstar-project-agent-qfew[bot]',
      writtenAs: 'wolfstar-github-agent[bot]',
    })

    for (let attempt = 0; attempt < 6; attempt++) await publish(attempt % 2 === 0 ? reviewing : ready)

    expect(createComment).toHaveBeenCalledTimes(1)
    expect(comments).toHaveLength(1)
  })
})

describe('the controller does not take over comments it did not write', () => {
  it('refuses a review another App already wrote for the same head commit', async () => {
    const { comments, createComment, publish, updateComment } = pullRequest({
      // A trusted account already reviewed this head commit. Only trusted authors count as a prior review.
      comments: [comment(11, 'some-other-app[bot]', 123456, reviewing, 'MEMBER')],
      expectedActor: 'wolfstar-github-agent[bot]',
      writtenAs: 'wolfstar-github-agent[bot]',
    })

    const result = await publish(ready)

    expect(result).toEqual({
      _tag: 'Err',
      error: expect.stringContaining('already has an automated review by @some-other-app[bot]'),
    })
    expect(updateComment).not.toHaveBeenCalled()
    expect(createComment).not.toHaveBeenCalled()
    expect(comments[0]?.body).toBe(reviewing)
  })

  it('does not count the App id for a repository that acts as a user', async () => {
    const { createComment, publish, updateComment } = pullRequest({
      comments: [comment(11, 'renamed-bot[bot]', OWN_APP_ID)],
      expectedActor: 'RedStar071',
      writtenAs: 'RedStar071',
      authentication: 'user',
    })

    await publish(ready)

    expect(updateComment).not.toHaveBeenCalled()
    expect(createComment).toHaveBeenCalledTimes(1)
  })
})
