import type { Octokit } from 'octokit'
import { describe, expect, it } from 'vitest'
import { createGitHubAgentSource } from '../src/github-agent-source.ts'
import { ok } from '../src/result.ts'
import { repositoryMapping } from './fixtures.ts'

const baseSha = 'b'.repeat(40)

function client(labels: string[]): Octokit {
  return {
    paginate: () => Promise.resolve([]),
    rest: {
      actions: { getJobForWorkflowRun: () => Promise.reject(new Error('Unexpected job lookup.')) },
      checks: { listForRef: () => undefined },
      issues: { listComments: () => undefined },
      pulls: {
        get: () => Promise.resolve({
          data: {
            number: 24,
            state: 'open',
            merged_at: null,
            title: 'Fix the broken thing',
            body: 'Fixes the bug.',
            user: { login: 'harlan-zw' },
            html_url: 'https://github.com/harlan-zw/example/pull/24',
            created_at: '2026-08-01T00:00:00.000Z',
            updated_at: '2026-08-13T00:00:00.000Z',
            draft: false,
            labels: labels.map(name => ({ name })),
            base: { sha: baseSha, ref: 'main' },
            head: { sha: 'c'.repeat(40), ref: 'fix/thing', repo: { full_name: 'harlan-zw/example' } },
            maintainer_can_modify: true,
            mergeable: true,
          },
        }),
        listReviewComments: () => undefined,
        listReviews: () => undefined,
      },
      repos: {
        getBranch: () => Promise.resolve({ data: { commit: { sha: baseSha } } }),
        getBranchRules: () => Promise.resolve({ data: [] }),
        getCombinedStatusForRef: () => Promise.resolve({ data: { statuses: [] } }),
      },
    },
  } as unknown as Octokit
}

describe('review snapshot approval labels', () => {
  it('reads the manual Review label the poller reads', async () => {
    const source = createGitHubAgentSource({
      actorLogin: () => 'harlan-github-agent[bot]',
      createClient: () => client(['harlan-agent-review', 'bug']),
      tokens: {
        getToken: () => Promise.resolve(ok({ token: 'token', expiresAt: '2026-08-14T02:00:00.000Z' })),
        invalidate: () => undefined,
      },
    })

    const result = await source.getPullRequestReviewSnapshot(repositoryMapping(), 24, new AbortController().signal)

    expect(result).toEqual(ok(expect.objectContaining({
      pullRequest: expect.objectContaining({ approvalLabels: ['review'] }),
    })))
  })
})
