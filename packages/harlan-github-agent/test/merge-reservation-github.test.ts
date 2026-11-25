import { Octokit } from 'octokit'
import { expect, it } from 'vitest'
import { createReservationSource } from '../src/merge-reservation-github.ts'
import { ok } from '../src/result.ts'
import { repositoryMapping } from './fixtures.ts'

const repository = repositoryMapping({ github: 'harlan-zw/nuxtseo.com' })
const sha = 'a'.repeat(40)
const otherSha = 'b'.repeat(40)
const mergedAt = '2026-11-25T03:00:00Z'
const current = { head_sha: sha, created_at: mergedAt, updated_at: mergedAt, status: 'in_progress', conclusion: null, html_url: 'https://github.com/run/1' }

function sourceFor(options: { moved?: boolean, incomplete?: boolean, oldActive?: boolean } = {}) {
  const credentials: string[] = []
  const source = createReservationSource({
    tokens: {
      getToken: async (_repository, access) => {
        credentials.push(access)
        return ok({ token: 'fixture', expiresAt: '2099-01-01T00:00:00Z' })
      },
      invalidate: () => {},
    },
    fetch: async (url, init) => {
      expect(url).toBe('https://nuxtseo.com/')
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      return new Response(null, { headers: { 'x-release-sha': sha } })
    },
    createClient: clientOptions => new Octokit({ ...clientOptions, request: { fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      const reply = (data: unknown) => {
        const response = Response.json(data)
        Object.defineProperty(response, 'url', { value: url.href })
        return response
      }
      if (url.pathname === '/graphql') {
        expect(JSON.parse(String(init?.body)).query.trim()).toMatch(/^query /)
        return reply({ data: { repository: {
          defaultBranchRef: { name: 'main', target: { oid: sha, associatedPullRequests: { nodes: [{ mergedAt, mergeCommit: { oid: sha }, baseRefName: 'main', baseRepository: { nameWithOwner: repository.github } }] } } },
          pullRequests: {
            pageInfo: { hasNextPage: options.incomplete ?? false },
            nodes: [{ number: 41, url: 'https://github.com/pull/41', autoMergeRequest: { enabledAt: mergedAt } }],
          },
        } } })
      }
      expect(init?.method ?? 'GET').toBe('GET')
      if (url.pathname.endsWith('/branches/main'))
        return reply({ commit: { sha: options.moved ? otherSha : sha } })
      expect(url.searchParams.get('branch')).toBe('main')
      if (url.pathname.endsWith('/actions/runs')) {
        const status = url.searchParams.get('status')
        const workflowRuns = options.oldActive && status === 'in_progress'
          ? [
              { ...current, id: 66, head_sha: otherSha, path: '.github/workflows/code.yml@main', event: 'push' },
              { ...current, id: 67, head_sha: otherSha, path: '.github/workflows/docs-poll.yml', event: 'schedule' },
            ]
          : []
        return reply({ total_count: workflowRuns.length, workflow_runs: workflowRuns })
      }
      if (url.pathname.endsWith('/code.yml/runs')) {
        expect(url.searchParams.get('event')).toBe('push')
        return reply({ workflow_runs: [{ ...current, id: 1 }] })
      }
      expect(url.pathname).toMatch(/\/deploy-prod\.yml\/runs$/)
      return reply({ workflow_runs: [
        { ...current, id: 2, event: 'workflow_run', head_sha: otherSha, display_title: `Deploy [take_ownership:${repository.github}:push:main:${sha}]` },
        { ...current, id: 3, event: 'workflow_run', display_title: `Deploy [take_ownership:${repository.github}:pull_request:main:${sha}]` },
        { ...current, id: 4, event: 'workflow_dispatch', display_title: 'Deploy' },
        { ...current, id: 5, event: 'workflow_run', display_title: 'Deploy with unknown source' },
      ] })
    } } } as never),
  })
  return { source, credentials }
}

it('collects default branch evidence with read access and uses only trusted push provenance', async () => {
  const { source, credentials } = sourceFor()
  const evidence = await source(repository, new AbortController().signal)
  expect(credentials.toSorted()).toEqual(['checks_read', 'read'])
  expect(evidence).toMatchObject({
    mainSha: sha,
    mergedAt,
    servedRevision: sha,
    handoffs: [{ number: 41, url: 'https://github.com/pull/41' }],
    code: [{ id: 1 }],
    deploys: [{ run: { id: 2, sha: otherSha }, sourceSha: sha }, { run: { id: 4 }, sourceSha: null }, { run: { id: 5 }, sourceSha: null }],
  })
})

it('includes an active rerun outside the recent workflow history', async () => {
  const evidence = await sourceFor({ oldActive: true }).source(repository, new AbortController().signal)
  expect(evidence.code).toContainEqual(expect.objectContaining({ id: 66, sha: otherSha, status: 'in_progress' }))
  expect(evidence.activeDocsPolls).toEqual([expect.objectContaining({ id: 67, status: 'in_progress' })])
})

it.each([
  [{ moved: true }, 'default branch changed'],
  [{ incomplete: true }, 'handoffs could not be verified'],
])('refuses incomplete pipeline evidence', async (options, message) => {
  await expect(sourceFor(options).source(repository, new AbortController().signal)).rejects.toThrow(message)
})
