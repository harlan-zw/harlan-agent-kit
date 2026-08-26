import type { Octokit } from 'octokit'
import { describe, expect, it } from 'vitest'
import { createGitHubAgentSource } from '../src/github-agent-source.ts'
import { createGitHubSource } from '../src/github.ts'
import { ok } from '../src/result.ts'
import { repositoryMapping } from './fixtures.ts'

const historicBaseSha = 'a'.repeat(40)
const liveBaseSha = 'b'.repeat(40)
const headSha = 'c'.repeat(40)

function pullRequest() {
  return {
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
    labels: [],
    base: { sha: historicBaseSha, ref: 'main' },
    head: { sha: headSha, ref: 'fix/thing', repo: { full_name: 'harlan-zw/example' } },
    maintainer_can_modify: true,
    mergeable: true,
  }
}

function tokens() {
  return {
    getToken: () => Promise.resolve(ok({ token: 'token', expiresAt: '2026-08-14T02:00:00.000Z' })),
    invalidate: () => undefined,
  }
}

describe('live pull request base', () => {
  it('observes the current base branch commit instead of GitHub pull history', async () => {
    const client = {
      rest: {
        pulls: { get: () => Promise.resolve({ data: pullRequest() }) },
        repos: { getBranch: () => Promise.resolve({ data: { commit: { sha: liveBaseSha } } }) },
      },
    } as unknown as Octokit
    const source = createGitHubSource({
      actorLogin: () => 'harlan-github-agent[bot]',
      createClient: () => client,
      issueCutoff: '2026-07-01',
      tokens: tokens(),
    })

    const result = await source.getPullRequest(repositoryMapping(), 24)

    expect(result).toEqual(ok(expect.objectContaining({ baseSha: liveBaseSha })))
  })

  it('reads base checks from the current base branch commit', async () => {
    const checkedRefs: string[] = []
    const client = {
      paginate: (_method: unknown, input: { ref?: string }) => {
        if (input.ref !== undefined)
          checkedRefs.push(input.ref)
        return Promise.resolve([])
      },
      rest: {
        actions: { getJobForWorkflowRun: () => Promise.reject(new Error('Unexpected job lookup.')) },
        checks: { listForRef: () => undefined },
        issues: { listComments: () => undefined },
        pulls: {
          get: () => Promise.resolve({ data: pullRequest() }),
          listReviewComments: () => undefined,
          listReviews: () => undefined,
        },
        repos: {
          getBranch: () => Promise.resolve({ data: { commit: { sha: liveBaseSha } } }),
          getBranchRules: () => Promise.resolve({ data: [] }),
          getCombinedStatusForRef: (input: { ref: string }) => {
            checkedRefs.push(input.ref)
            return Promise.resolve({ data: { statuses: [] } })
          },
        },
      },
    } as unknown as Octokit
    const source = createGitHubAgentSource({
      actorLogin: () => 'harlan-github-agent[bot]',
      createClient: () => client,
      tokens: tokens(),
    })

    const result = await source.getPullRequestReviewSnapshot(repositoryMapping(), 24, new AbortController().signal)

    expect(result).toEqual(ok(expect.objectContaining({
      pullRequest: expect.objectContaining({ baseSha: liveBaseSha }),
    })))
    expect(checkedRefs).toContain(liveBaseSha)
    expect(checkedRefs).not.toContain(historicBaseSha)
  })
})
