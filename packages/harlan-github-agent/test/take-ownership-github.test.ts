import { createServer } from 'node:http'
import { Octokit } from 'octokit'
import { expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { verifyCompletion } from '../src/take-ownership-completion.ts'
import { createCompletionSource } from '../src/take-ownership-github.ts'
import { repositoryMapping } from './fixtures.ts'

it.each([
  ['legacy title', 'Deploy', 'workflow_run'],
  ['pull request trigger', `Deploy [take_ownership:harlan-zw/example:pull_request:main:${'a'.repeat(40)}]`, 'workflow_run'],
  ['foreign repository', `Deploy [take_ownership:harlan-zw/other:push:main:${'a'.repeat(40)}]`, 'workflow_run'],
  ['foreign branch', `Deploy [take_ownership:harlan-zw/example:push:feature:${'a'.repeat(40)}]`, 'workflow_run'],
  ['different commit', `Deploy [take_ownership:harlan-zw/example:push:main:${'b'.repeat(40)}]`, 'workflow_run'],
  ['short SHA', 'Deploy [take_ownership:harlan-zw/example:push:main:aaaaaaa]', 'workflow_run'],
  ['manual dispatch', `Deploy [take_ownership:harlan-zw/example:push:main:${'a'.repeat(40)}]`, 'workflow_dispatch'],
])('rejects %s even when downstream metadata names the merge commit', async (_reason, title, event) => {
  let smokeRequests = 0
  const source = createCompletionSource({
    tokens: { getToken: async () => ok({ token: 'test-token', expiresAt: '2099-01-01T00:00:00Z' }), invalidate: () => {} },
    fetch: async () => {
      smokeRequests++
      return new Response('healthy')
    },
    createClient: options => new Octokit({ ...options, request: { fetch: async (input: string | URL | Request) => {
      const runs = new URL(String(input)).searchParams.get('event') === 'workflow_run'
        ? [{ id: 1, name: 'deploy', path: '.github/workflows/deploy.yml', head_sha: 'a'.repeat(40), head_branch: 'main', event, display_title: title, status: 'completed', conclusion: 'success', html_url: 'https://github.com/run/1' }]
        : []
      const response = new Response(JSON.stringify({ total_count: runs.length, workflow_runs: runs }), { headers: { 'content-type': 'application/json' } })
      Object.defineProperty(response, 'url', { value: String(input) })
      return response
    } } } as never),
  })
  const result = await verifyCompletion(repositoryMapping({ takeOwnership: { _tag: 'Enabled', productionUrl: 'https://example.com', requiredWorkflows: ['deploy.yml'], smokePaths: ['/health'] } }), { mergeSha: 'a'.repeat(40), mergedAt: '2026-10-05T00:00:00Z', headSha: 'head', pullRequestNumber: 24 }, source, new AbortController().signal)
  expect(result._tag).toBe('Pending')
  expect(smokeRequests).toBe(0)
})

it('uses triggering push evidence when a downstream run starts on a newer commit', async () => {
  const sha = 'a'.repeat(40)
  const requests: URL[] = []
  const source = createCompletionSource({
    tokens: { getToken: async () => ok({ token: 'test-token', expiresAt: '2099-01-01T00:00:00Z' }), invalidate: () => {} },
    fetch,
    createClient: options => new Octokit({ ...options, request: { fetch: async (input: string | URL | Request) => {
      const url = new URL(String(input))
      requests.push(url)
      const runs = url.searchParams.get('event') === 'workflow_run'
        ? [{ id: 2, name: 'deploy', path: '.github/workflows/deploy.yml', head_sha: 'b'.repeat(40), head_branch: 'main', event: 'workflow_run', display_title: `Deploy [take_ownership:harlan-zw/example:push:main:${sha}]`, status: 'completed', conclusion: 'success', html_url: 'https://github.com/run/2' }]
        : []
      const response = new Response(JSON.stringify({ total_count: runs.length, workflow_runs: runs }), { headers: { 'content-type': 'application/json' } })
      Object.defineProperty(response, 'url', { value: String(input) })
      return response
    } } } as never),
  })
  const result = await source.workflows(repositoryMapping(), { mergeSha: sha, mergedAt: '2026-10-05T00:00:00Z', headSha: 'c'.repeat(40), pullRequestNumber: 24 }, new AbortController().signal)
  expect(result).toMatchObject({ _tag: 'Ok', value: [{ id: 2, source: { _tag: 'WorkflowRun', repository: 'harlan-zw/example', branch: 'main', sha } }] })
  const downstream = requests.find(url => url.searchParams.get('event') === 'workflow_run')!
  expect(downstream.searchParams.has('head_sha')).toBe(false)
  expect(downstream.searchParams.get('created')).toBe('>=2026-10-05T00:00:00Z')
})

it('reads workflow runs for the exact default branch merge with Actions read access', async () => {
  const accesses: string[] = []
  const requests: URL[] = []
  const source = createCompletionSource({
    tokens: {
      getToken: async (_repository, access) => {
        accesses.push(access)
        return ok({ token: 'test-token', expiresAt: '2099-01-01T00:00:00Z' })
      },
      invalidate: () => {},
    },
    fetch,
    createClient: options => new Octokit({ ...options, request: { fetch: async (input: string | URL | Request) => {
      requests.push(new URL(String(input)))
      const runs = new URL(String(input)).searchParams.get('event') === 'push' ? [{ id: 1, name: 'deploy', path: '.github/workflows/deploy.yml', head_sha: 'merge', head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', html_url: 'https://github.com/run/1' }] : []
      const response = new Response(JSON.stringify({ total_count: runs.length, workflow_runs: runs }), { headers: { 'content-type': 'application/json' } })
      Object.defineProperty(response, 'url', { value: String(input) })
      return response
    } } } as never),
  })
  const result = await source.workflows(repositoryMapping(), { mergeSha: 'merge', mergedAt: '2026-10-05T00:00:00Z', headSha: 'head', pullRequestNumber: 24 }, new AbortController().signal)
  expect(accesses).toEqual(['checks_read'])
  expect(requests[0]?.pathname).toBe('/repos/harlan-zw/example/actions/runs')
  expect(requests[0]?.searchParams.get('head_sha')).toBe('merge')
  expect(requests[0]?.searchParams.get('event')).toBe('push')
  expect(requests[0]?.searchParams.get('branch')).toBe('main')
  expect(result).toMatchObject({ _tag: 'Ok', value: [{ source: { _tag: 'Push', sha: 'merge' }, path: '.github/workflows/deploy.yml' }] })
})

it('sends a real smoke request without credentials and does not follow redirects', async () => {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url!)
    expect(request.headers.authorization).toBeUndefined()
    response.writeHead(request.url === '/redirect' ? 302 : 200, { location: '/health' })
    response.end('healthy')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string')
    throw new Error('The smoke server has no address.')
  const source = createCompletionSource({ tokens: {
    getToken: async () => {
      throw new Error('Smoke must not request a token.')
    },
    invalidate: () => {},
  }, fetch })
  try {
    expect(await source.smoke(`http://127.0.0.1:${address.port}/health`, new AbortController().signal)).toEqual(ok(200))
    expect(await source.smoke(`http://127.0.0.1:${address.port}/redirect`, new AbortController().signal)).toEqual(ok(302))
    expect(requests).toEqual(['/health', '/redirect'])
  }
  finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
