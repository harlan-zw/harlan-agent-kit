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

  it('reads a closed pull request after its base branch was deleted', async () => {
    const closed = {
      ...pullRequest(),
      state: 'closed',
      merged_at: '2026-08-13T11:00:00.000Z',
      base: { sha: historicBaseSha, ref: 'deleted-stack-base' },
    }
    const client = {
      rest: {
        pulls: { get: () => Promise.resolve({ data: closed }) },
        repos: { getBranch: () => Promise.reject(new Error('Branch not found')) },
      },
    } as unknown as Octokit
    const source = createGitHubSource({
      actorLogin: () => 'harlan-github-agent[bot]',
      createClient: () => client,
      issueCutoff: '2026-07-01',
      tokens: tokens(),
    })

    const result = await source.getPullRequest(repositoryMapping(), 24)

    expect(result).toEqual(ok(expect.objectContaining({
      state: 'closed',
      baseSha: historicBaseSha,
    })))
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

  it('drops base check runs that a workflow_run event attached to the base commit', async () => {
    const listForRef = () => undefined
    const listWorkflowRunsForRepo = () => undefined
    const client = {
      paginate: (method: unknown, input: { ref?: string, head_sha?: string }) => {
        if (method === listForRef && input.ref === liveBaseSha) {
          return Promise.resolve([
            { id: 1, name: 'comment', status: 'in_progress', conclusion: null, app: { id: 15368, slug: 'github-actions' }, check_suite: { id: 7 } },
            { id: 2, name: 'test', status: 'completed', conclusion: 'success', app: { id: 15368, slug: 'github-actions' }, check_suite: { id: 8 } },
          ])
        }
        if (method === listWorkflowRunsForRepo && input.head_sha === liveBaseSha) {
          return Promise.resolve([
            { id: 70, event: 'workflow_run', check_suite_id: 7 },
            { id: 80, event: 'push', check_suite_id: 8 },
          ])
        }
        return Promise.resolve([])
      },
      rest: {
        actions: { getJobForWorkflowRun: () => Promise.reject(new Error('Unexpected job lookup.')), listWorkflowRunsForRepo },
        checks: { listForRef },
        issues: { listComments: () => undefined },
        pulls: {
          get: () => Promise.resolve({ data: pullRequest() }),
          listReviewComments: () => undefined,
          listReviews: () => undefined,
        },
        repos: {
          getBranch: () => Promise.resolve({ data: { commit: { sha: liveBaseSha } } }),
          getBranchRules: () => Promise.resolve({ data: [] }),
          getCombinedStatusForRef: () => Promise.resolve({ data: { statuses: [] } }),
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
      baseChecks: {
        _tag: 'Available',
        checks: [expect.objectContaining({ name: 'test', status: 'completed', conclusion: 'success' })],
      },
    })))
  })

  it('drops base check runs that a schedule event attached to the base commit', async () => {
    const listForRef = () => undefined
    const listWorkflowRunsForRepo = () => undefined
    const client = {
      paginate: (method: unknown, input: { ref?: string, head_sha?: string }) => {
        if (method === listForRef && input.ref === liveBaseSha) {
          return Promise.resolve([
            { id: 1, name: 'cancel', status: 'queued', conclusion: null, app: { id: 15368, slug: 'github-actions' }, check_suite: { id: 7 } },
            { id: 2, name: 'test', status: 'completed', conclusion: 'success', app: { id: 15368, slug: 'github-actions' }, check_suite: { id: 8 } },
          ])
        }
        if (method === listWorkflowRunsForRepo && input.head_sha === liveBaseSha) {
          return Promise.resolve([
            { id: 70, event: 'schedule', status: 'queued', check_suite_id: 7 },
            { id: 80, event: 'push', status: 'completed', check_suite_id: 8 },
          ])
        }
        return Promise.resolve([])
      },
      rest: {
        actions: { getJobForWorkflowRun: () => Promise.reject(new Error('Unexpected job lookup.')), listWorkflowRunsForRepo },
        checks: { listForRef },
        issues: { listComments: () => undefined },
        pulls: {
          get: () => Promise.resolve({ data: pullRequest() }),
          listReviewComments: () => undefined,
          listReviews: () => undefined,
        },
        repos: {
          getBranch: () => Promise.resolve({ data: { commit: { sha: liveBaseSha } } }),
          getBranchRules: () => Promise.resolve({ data: [] }),
          getCombinedStatusForRef: () => Promise.resolve({ data: { statuses: [] } }),
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
      baseChecks: {
        _tag: 'Available',
        checks: [expect.objectContaining({ name: 'test', status: 'completed', conclusion: 'success' })],
      },
    })))
  })

  it('keeps a concluded failed scheduled run as base evidence', async () => {
    const listForRef = () => undefined
    const listWorkflowRunsForRepo = () => undefined
    const client = {
      paginate: (method: unknown, input: { ref?: string, head_sha?: string }) => {
        if (method === listForRef && input.ref === liveBaseSha) {
          return Promise.resolve([
            { id: 1, name: 'Fuzz', status: 'completed', conclusion: 'failure', app: { id: 15368, slug: 'github-actions' }, check_suite: { id: 7 } },
            { id: 2, name: 'test', status: 'completed', conclusion: 'success', app: { id: 15368, slug: 'github-actions' }, check_suite: { id: 8 } },
          ])
        }
        if (method === listWorkflowRunsForRepo && input.head_sha === liveBaseSha) {
          return Promise.resolve([
            { id: 70, event: 'schedule', status: 'completed', check_suite_id: 7 },
            { id: 80, event: 'push', status: 'completed', check_suite_id: 8 },
          ])
        }
        return Promise.resolve([])
      },
      rest: {
        actions: { getJobForWorkflowRun: () => Promise.reject(new Error('Unexpected job lookup.')), listWorkflowRunsForRepo },
        checks: { listForRef },
        issues: { listComments: () => undefined },
        pulls: {
          get: () => Promise.resolve({ data: pullRequest() }),
          listReviewComments: () => undefined,
          listReviews: () => undefined,
        },
        repos: {
          getBranch: () => Promise.resolve({ data: { commit: { sha: liveBaseSha } } }),
          getBranchRules: () => Promise.resolve({ data: [] }),
          getCombinedStatusForRef: () => Promise.resolve({ data: { statuses: [] } }),
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
      baseChecks: {
        _tag: 'Available',
        checks: expect.arrayContaining([
          expect.objectContaining({ name: 'Fuzz', status: 'completed', conclusion: 'failure' }),
        ]),
      },
    })))
  })

  it('drops base check runs of a scheduled run that has not completed', async () => {
    const listForRef = () => undefined
    const listWorkflowRunsForRepo = () => undefined
    const client = {
      paginate: (method: unknown, input: { ref?: string, head_sha?: string }) => {
        if (method === listForRef && input.ref === liveBaseSha) {
          return Promise.resolve([
            { id: 1, name: 'cancel', status: 'queued', conclusion: null, app: { id: 15368, slug: 'github-actions' }, check_suite: { id: 7 } },
            { id: 2, name: 'test', status: 'completed', conclusion: 'success', app: { id: 15368, slug: 'github-actions' }, check_suite: { id: 8 } },
          ])
        }
        if (method === listWorkflowRunsForRepo && input.head_sha === liveBaseSha) {
          return Promise.resolve([
            { id: 70, event: 'schedule', status: 'requested', check_suite_id: 7 },
            { id: 80, event: 'push', status: 'completed', check_suite_id: 8 },
          ])
        }
        return Promise.resolve([])
      },
      rest: {
        actions: { getJobForWorkflowRun: () => Promise.reject(new Error('Unexpected job lookup.')), listWorkflowRunsForRepo },
        checks: { listForRef },
        issues: { listComments: () => undefined },
        pulls: {
          get: () => Promise.resolve({ data: pullRequest() }),
          listReviewComments: () => undefined,
          listReviews: () => undefined,
        },
        repos: {
          getBranch: () => Promise.resolve({ data: { commit: { sha: liveBaseSha } } }),
          getBranchRules: () => Promise.resolve({ data: [] }),
          getCombinedStatusForRef: () => Promise.resolve({ data: { statuses: [] } }),
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
      baseChecks: {
        _tag: 'Available',
        checks: [expect.objectContaining({ name: 'test', status: 'completed', conclusion: 'success' })],
      },
    })))
  })

  it('drops base check runs that a dynamic Dependabot run attached to the base commit', async () => {
    const listForRef = () => undefined
    const listWorkflowRunsForRepo = () => undefined
    const client = {
      paginate: (method: unknown, input: { ref?: string, head_sha?: string }) => {
        if (method === listForRef && input.ref === liveBaseSha) {
          return Promise.resolve([
            { id: 1, name: 'Dependabot', status: 'completed', conclusion: 'failure', app: { id: 15368, slug: 'github-actions' }, check_suite: { id: 7 } },
            { id: 2, name: 'test', status: 'completed', conclusion: 'success', app: { id: 15368, slug: 'github-actions' }, check_suite: { id: 8 } },
          ])
        }
        if (method === listWorkflowRunsForRepo && input.head_sha === liveBaseSha) {
          return Promise.resolve([
            { id: 70, event: 'dynamic', check_suite_id: 7 },
            { id: 80, event: 'push', check_suite_id: 8 },
          ])
        }
        return Promise.resolve([])
      },
      rest: {
        actions: { getJobForWorkflowRun: () => Promise.reject(new Error('Unexpected job lookup.')), listWorkflowRunsForRepo },
        checks: { listForRef },
        issues: { listComments: () => undefined },
        pulls: {
          get: () => Promise.resolve({ data: pullRequest() }),
          listReviewComments: () => undefined,
          listReviews: () => undefined,
        },
        repos: {
          getBranch: () => Promise.resolve({ data: { commit: { sha: liveBaseSha } } }),
          getBranchRules: () => Promise.resolve({ data: [] }),
          getCombinedStatusForRef: () => Promise.resolve({ data: { statuses: [] } }),
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
      baseChecks: {
        _tag: 'Available',
        checks: [expect.objectContaining({ name: 'test', status: 'completed', conclusion: 'success' })],
      },
    })))
  })
})
