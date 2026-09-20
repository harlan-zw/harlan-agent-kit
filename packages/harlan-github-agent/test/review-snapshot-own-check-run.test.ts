import type { Octokit } from 'octokit'
import { describe, expect, it } from 'vitest'
import { createGitHubAgentSource } from '../src/github-agent-source.ts'
import { ok } from '../src/result.ts'
import { REVIEW_CHECK_RUN_NAME } from '../src/review-check-run.ts'
import { repositoryMapping } from './fixtures.ts'

const baseSha = 'a'.repeat(40)
const headSha = 'c'.repeat(40)
const ownAppId = 98114

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
    base: { sha: baseSha, ref: 'main' },
    head: { sha: headSha, ref: 'fix/thing', repo: { full_name: 'harlan-github-example' } },
    maintainer_can_modify: true,
    mergeable: true,
  }
}

describe('review snapshot own check runs', () => {
  it('reads no check run this app wrote, so the Review never gates on itself', async () => {
    const listForRef = () => undefined
    const listWorkflowRunsForRepo = () => undefined
    const client = {
      paginate: (method: unknown, input: { ref?: string }) => {
        if (method === listForRef && input.ref === headSha) {
          return Promise.resolve([
            { id: 1, name: 'build', status: 'completed', conclusion: 'success', app: { id: 15368, slug: 'github-actions' } },
            { id: 2, name: REVIEW_CHECK_RUN_NAME, status: 'in_progress', conclusion: null, app: { id: ownAppId, slug: 'harlan-github-agent' } },
          ])
        }
        return Promise.resolve([])
      },
      rest: {
        actions: { listWorkflowRunsForRepo },
        checks: { listForRef },
        issues: { listComments: () => undefined },
        pulls: {
          get: () => Promise.resolve({ data: pullRequest() }),
          listReviewComments: () => undefined,
          listReviews: () => undefined,
        },
        repos: {
          getBranch: () => Promise.resolve({ data: { commit: { sha: baseSha } } }),
          getBranchRules: () => Promise.resolve({ data: [] }),
          getCombinedStatusForRef: () => Promise.resolve({ data: { statuses: [] } }),
          listCommits: () => Promise.resolve({ data: [{ sha: baseSha }] }),
        },
      },
    } as unknown as Octokit
    const source = createGitHubAgentSource({
      actorLogin: () => 'harlan-github-agent[bot]',
      createClient: () => client,
      ownAppId,
      tokens: {
        getToken: () => Promise.resolve(ok({ token: 'token', expiresAt: '2026-08-14T02:00:00.000Z' })),
        invalidate: () => undefined,
      },
    })

    const result = await source.getPullRequestReviewSnapshot(repositoryMapping(), 24, new AbortController().signal)

    expect(result).toEqual(expect.objectContaining({ _tag: 'Ok' }))
    expect(result._tag === 'Ok' ? result.value.checks : null).toEqual({
      _tag: 'Available',
      checks: [expect.objectContaining({ id: 1, name: 'build' })],
    })
  })
})
