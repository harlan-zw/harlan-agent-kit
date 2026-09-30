import type { Octokit } from 'octokit'
import { describe, expect, it } from 'vitest'
import { createGitHubAgentSource } from '../src/github-agent-source.ts'
import { ok } from '../src/result.ts'
import { repositoryMapping } from './fixtures.ts'

function source(client: Octokit) {
  return createGitHubAgentSource({ actorLogin: () => 'harlan-github-agent[bot]', ownAppId: 98114, createClient: () => client, tokens: {
    getToken: async () => ok({ token: 'token', expiresAt: '2026-10-01T00:00:00.000Z' }),
    invalidate: () => undefined,
  } })
}

describe('runner recovery GitHub reads', () => {
  it('reads all paginated authors and live unique bases without reading discussion or PR detail', async () => {
    const listPulls = () => undefined
    const branches: string[] = []
    const client = {
      paginate: async (method: unknown) => {
        if (method !== listPulls)
          throw new Error('Unexpected broad read.')
        return [
          { number: 24, user: { login: 'harlan-zw' }, head: { sha: 'head-a' }, base: { ref: 'main', sha: 'stale-base' } },
          { number: 25, user: { login: 'dependabot[bot]' }, head: { sha: 'head-b' }, base: { ref: 'main', sha: 'stale-base' } },
          { number: 26, user: { login: 'other' }, head: { sha: 'head-c' }, base: { ref: 'stack', sha: 'stale-stack' } },
        ]
      },
      rest: { pulls: { list: listPulls }, repos: { getBranch: async ({ branch }: { branch: string }) => {
        branches.push(branch)
        return { data: { commit: { sha: `live-${branch}` } } }
      } } },
    } as unknown as Octokit
    expect(await source(client).getOpenPullRequestCheckSources(repositoryMapping(), new AbortController().signal)).toEqual(ok([
      { number: 24, headSha: 'head-a', baseSha: 'live-main', baseRef: 'main' },
      { number: 25, headSha: 'head-b', baseSha: 'live-main', baseRef: 'main' },
      { number: 26, headSha: 'head-c', baseSha: 'live-stack', baseRef: 'stack' },
    ]))
    expect(branches).toEqual(['main', 'stack'])
  })

  it.each(['RunnerLost', 'StepFailed'] as const)('retains %s evidence in the existing base ancestor fallback', async (kind) => {
    const listChecks = () => undefined
    const listWorkflows = () => undefined
    const refs: string[] = []
    const client = {
      paginate: async (method: unknown, input: { ref: string }) => {
        if (method === listWorkflows)
          return []
        if (method !== listChecks)
          throw new Error('Unexpected broad read.')
        refs.push(input.ref)
        return input.ref === 'ancestor'
          ? [{ id: 42, name: 'test', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions', id: 15368 } }]
          : []
      },
      rest: {
        checks: { listForRef: listChecks },
        actions: { listWorkflowRunsForRepo: listWorkflows, getJobForWorkflowRun: async () => ({ data: { steps: [{ conclusion: kind === 'StepFailed' ? 'failure' : null }] } }) },
        repos: { listCommits: async () => ({ data: [{ sha: 'docs-head' }, { sha: 'ancestor' }] }) },
      },
    } as unknown as Octokit
    const github = source(client)
    expect(await github.getCommitChecks(repositoryMapping(), 'docs-head', 'head', new AbortController().signal)).toEqual({ _tag: 'Available', checks: [] })
    expect(await github.getCommitChecks(repositoryMapping(), 'docs-head', 'base', new AbortController().signal)).toMatchObject({ _tag: 'Available', checks: [{ conclusion: 'failure', failure: { _tag: kind } }] })
    expect(refs).toEqual(['docs-head', 'docs-head', 'ancestor'])
  })
})
