import { createServer } from 'node:http'
import { Octokit } from 'octokit'
import { expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { createCompletionSource } from '../src/take-ownership-github.ts'
import { repositoryMapping } from './fixtures.ts'

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
      const response = new Response(JSON.stringify({ total_count: 1, workflow_runs: [{ id: 1, name: 'deploy', path: '.github/workflows/deploy.yml', head_sha: 'merge', head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', html_url: 'https://github.com/run/1' }] }), { headers: { 'content-type': 'application/json' } })
      Object.defineProperty(response, 'url', { value: String(input) })
      return response
    } } } as never),
  })
  const result = await source.workflows(repositoryMapping(), 'merge', new AbortController().signal)
  expect(accesses).toEqual(['checks_read'])
  expect(requests[0]?.pathname).toBe('/repos/harlan-zw/example/actions/runs')
  expect(requests[0]?.searchParams.get('head_sha')).toBe('merge')
  expect(requests[0]?.searchParams.get('event')).toBe('push')
  expect(requests[0]?.searchParams.get('branch')).toBe('main')
  expect(result).toMatchObject({ _tag: 'Ok', value: [{ sha: 'merge', path: '.github/workflows/deploy.yml' }] })
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
