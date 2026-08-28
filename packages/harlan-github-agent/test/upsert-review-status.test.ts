import type { Octokit } from 'octokit'
import { describe, expect, it, vi } from 'vitest'
import { createGitHubAgentSource } from '../src/github-agent-source.ts'
import { ok } from '../src/result.ts'
import { repositoryMapping } from './fixtures.ts'

const headSha = '1031dc93dddca88266cb32a085c7b90dcd58ec23'
const oldBody = `<!-- harlan-agent-kit:pr-triage -->
<!-- reviewed-sha: ${headSha} -->
### 🤖 REVIEWING · Adversarial review`
const newBody = `<!-- harlan-agent-kit:pr-triage -->
<!-- reviewed-sha: ${headSha} -->
### 🤖 READY · Adversarial review`

describe('upsertReviewStatus actor handoff', () => {
  it('updates an active automated review through its original user actor', async () => {
    const comment = {
      id: 5,
      author_association: 'OWNER',
      body: oldBody,
      html_url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-5',
      issue_url: 'https://api.github.com/repos/harlan-zw/example/issues/24',
      user: { login: 'harlan-zw' },
    }
    const appUpdate = vi.fn((_input: { body: string }) => Promise.resolve({ data: comment }))
    const userUpdate = vi.fn((input: { body: string }) => {
      comment.body = input.body
      return Promise.resolve({ data: comment })
    })
    const client = (updateComment: typeof userUpdate) => ({
      paginate: () => Promise.resolve([comment]),
      rest: {
        issues: {
          createComment: vi.fn(),
          getComment: () => Promise.resolve({ data: comment }),
          listComments: vi.fn(),
          updateComment,
        },
      },
    }) as unknown as Octokit
    const source = createGitHubAgentSource({
      actorLogin: () => 'harlan-github-agent[bot]',
      createClient: token => token === 'user-token' ? client(userUpdate) : client(appUpdate),
      legacyActor: {
        login: 'harlan-zw',
        tokens: {
          getToken: () => Promise.resolve(ok({ token: 'user-token', expiresAt: '2026-08-30T00:00:00.000Z' })),
          invalidate: () => undefined,
        },
      },
      tokens: {
        getToken: () => Promise.resolve(ok({ token: 'app-token', expiresAt: '2026-08-30T00:00:00.000Z' })),
        invalidate: () => undefined,
      },
    })

    const result = await source.upsertReviewStatus(repositoryMapping(), 24, null, newBody, false, new AbortController().signal)

    expect(result).toEqual(ok({ commentId: 5, url: comment.html_url }))
    expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({ comment_id: 5, body: newBody }))
    expect(appUpdate).not.toHaveBeenCalled()
  })
})
