import type { Octokit } from 'octokit'
import { describe, expect, it } from 'vitest'
import { createGitHubPullRequestPublisher } from '../src/github.ts'
import { ok } from '../src/result.ts'
import { repositoryMapping } from './fixtures.ts'

describe('gitHub pull request publication', () => {
  it('opens issue work ready for review', async () => {
    let draft: boolean | undefined
    const publisher = createGitHubPullRequestPublisher({
      createClient: () => ({
        rest: {
          pulls: {
            create: (input: { draft: boolean }) => {
              draft = input.draft
              return Promise.resolve({ data: { html_url: 'https://github.com/harlan-zw/example/pull/31', number: 31 } })
            },
            list: () => Promise.resolve({ data: [] }),
          },
        },
      }) as unknown as Octokit,
      tokens: {
        getToken: () => Promise.resolve(ok({ token: 'token', expiresAt: '2026-08-14T02:00:00.000Z' })),
      },
    })

    const result = await publisher.ensurePullRequest({
      repository: repositoryMapping(),
      headRef: 'fix/issue-30',
      expectedHeadSha: 'abc123',
      title: 'fix: broken thing',
      body: 'Closes #30.',
    })

    expect(draft).toBe(false)
    expect(result).toEqual(ok({ number: 31, url: 'https://github.com/harlan-zw/example/pull/31' }))
  })
})
