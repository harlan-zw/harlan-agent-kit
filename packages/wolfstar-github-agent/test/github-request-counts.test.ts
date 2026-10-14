import type { AddressInfo } from 'node:net'
import type { GitHubTokenProvider } from '../src/github-auth.ts'
import { channel } from 'node:diagnostics_channel'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { Octokit } from 'octokit'
import { expect, it } from 'vitest'
import { createAuthenticatedClient } from '../src/github-auth.ts'
import { createGitHubRequestCounts } from '../src/github-request-counts.ts'
import { createGitHubResponseCache } from '../src/github-response-cache.ts'
import { ok } from '../src/result.ts'

const rateHeaders = {
  'x-ratelimit-resource': 'core',
  'x-ratelimit-remaining': '4998',
  'x-ratelimit-used': '2',
  'x-ratelimit-reset': '1791784800',
}
it.each([
  rateHeaders,
  Object.entries(rateHeaders).flat(),
  Object.entries(rateHeaders)
    .flat()
    .map((value) => new Uint8Array(Buffer.from(value))),
])('reads rate limits across transport header formats', (headers) => {
  const reports: unknown[] = []
  const counts = createGitHubRequestCounts({ now: () => new Date(), report: (value) => reports.push(value) })
  counts.start()
  try {
    channel('undici:request:headers').publish({
      request: { origin: 'https://api.github.com', path: '/user', method: 'GET', headers: [] },
      response: { statusCode: 200, headers },
    })
    counts.flush()
    expect(reports).toEqual([
      expect.objectContaining({
        rows: [
          expect.objectContaining({
            rateLimit: { _tag: 'Available', resource: 'core', remaining: 4998, used: 2, resetAt: 1791784800 },
          }),
        ],
      }),
    ])
  } finally {
    counts.stop()
  }
})

it('retains oversized rows in overflow totals without writing an oversized report', () => {
  const reports: { completed: number; overflow: number; rows: unknown[] }[] = []
  const counts = createGitHubRequestCounts({ now: () => new Date(), report: (value) => reports.push(value) })
  counts.start()
  try {
    channel('undici:request:headers').publish({
      request: { origin: 'https://api.github.com', path: `/user${'/issues'.repeat(3000)}`, method: 'GET', headers: [] },
      response: { statusCode: 200, headers: [] },
    })
    counts.stop()
    expect(reports).toEqual([expect.objectContaining({ completed: 1, overflow: 1, rows: [] })])
    expect(Buffer.byteLength(JSON.stringify(reports[0]))).toBeLessThan(16_384)
  } finally {
    counts.stop()
  }
})

it('keeps every request in complete reports below the journal line limit', () => {
  const reports: { completed: number; overflow: number; rows: unknown[] }[] = []
  const counts = createGitHubRequestCounts({ now: () => new Date(), report: (value) => reports.push(value) })
  counts.start()
  try {
    for (let index = 0; index < 512; index++) {
      channel('undici:request:headers').publish({
        request: {
          origin: 'https://api.github.com',
          path: `/repos/owner/repository-${index}/issues`,
          method: 'GET',
          headers: [],
        },
        response: { statusCode: 200, headers: [] },
      })
    }
    counts.flush()
    expect(reports.reduce((sum, report) => sum + report.completed, 0)).toBe(512)
    expect(reports.reduce((sum, report) => sum + report.rows.length, 0)).toBe(512)
    expect(reports.every((report) => Buffer.byteLength(JSON.stringify(report)) <= 16_384)).toBe(true)
    expect(reports.reduce((sum, report) => sum + report.overflow, 0)).toBe(0)
  } finally {
    counts.stop()
  }
})

it('counts actual HTTP responses and 304 reuse across clients sharing one credential', async () => {
  const secret = 'secret-controller-token-that-must-never-appear'
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    response.setHeader('etag', '"unchanged"')
    response.setHeader('x-ratelimit-resource', 'core')
    response.setHeader('x-ratelimit-remaining', '4998')
    response.setHeader('x-ratelimit-used', '2')
    response.setHeader('x-ratelimit-reset', '1791784800')
    response.statusCode = request.headers['if-none-match'] === '"unchanged"' ? 304 : 200
    response.end(response.statusCode === 304 ? undefined : '{"checks":[]}')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const reports: unknown[] = []
  const counts = createGitHubRequestCounts({
    origin,
    now: () => new Date('2026-10-12T06:00:00Z'),
    report: (value) => reports.push(value),
  })
  const source: GitHubTokenProvider = {
    getToken: async () => ok({ token: secret, expiresAt: '2099-01-01T00:00:00Z' }),
    invalidate() {},
  }
  const tokens = counts.tokens(source, () => ({ _tag: 'User', login: 'controller' }))
  const cache = createGitHubResponseCache()
  counts.start()
  try {
    for (let index = 0; index < 2; index++) {
      const token = await tokens.getToken('owner/private', 'checks_read')
      if (token._tag === 'Err') throw new Error(token.error.message)
      const client = createAuthenticatedClient({
        tokens,
        repository: 'owner/private',
        access: 'checks_read',
        token: token.value.token,
        responseCache: cache,
        userAgent: 'request-counts-test',
        createClient: (options) => new Octokit({ ...options, baseUrl: origin } as never),
      })
      const result = await client.request('GET /repos/owner/private/commits/sensitive-ref/check-runs', {
        private_query: secret,
      })
      expect(result.data).toEqual({ checks: [] })
    }
    counts.flush()
    expect(reports).toEqual([
      expect.objectContaining({
        completed: 2,
        overflow: 0,
        rows: [
          expect.objectContaining({
            credential: { _tag: 'User', login: 'controller' },
            repository: 'owner/private',
            endpoint: '/repos/:owner/:repo/commits/:value/check-runs',
            method: 'GET',
            completed: 2,
            conditional: 1,
            notModified: 1,
            errors: 0,
            statuses: { 200: 1, 304: 1 },
            rateLimit: { _tag: 'Available', resource: 'core', remaining: 4998, used: 2, resetAt: 1791784800 },
          }),
        ],
      }),
    ])
    expect(JSON.stringify(reports)).not.toContain(secret)
    expect(JSON.stringify(reports)).not.toContain('sensitive-ref')
    counts.flush()
    expect(reports).toHaveLength(1)
    counts.stop()
    await fetch(`${origin}/user`)
    counts.flush()
    expect(reports).toHaveLength(1)
  } finally {
    counts.stop()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

it('keeps overflow totals without retaining unbounded endpoint groups', async () => {
  const server = createServer((_request, response) => response.end('{}'))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const reports: unknown[] = []
  const counts = createGitHubRequestCounts({
    origin,
    maxGroups: 1,
    now: () => new Date(),
    report: (value) => reports.push(value),
  })
  counts.start()
  try {
    await fetch(`${origin}/user`)
    await fetch(`${origin}/repos/owner/private/pulls/123`)
    counts.flush()
    expect(reports).toEqual([
      expect.objectContaining({
        completed: 2,
        overflow: 1,
        rows: [expect.objectContaining({ completed: 1, credential: { _tag: 'Unauthenticated' } })],
      }),
    ])
  } finally {
    counts.stop()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

it('counts transport failure once and flushes on shutdown', async () => {
  const server = createServer((request) => request.socket.destroy())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const reports: unknown[] = []
  const counts = createGitHubRequestCounts({ origin, now: () => new Date(), report: (value) => reports.push(value) })
  counts.start()
  try {
    await expect(
      fetch(`${origin}/user`, { headers: { authorization: 'Bearer another-private-token' } }),
    ).rejects.toThrow()
    counts.stop()
    expect(reports).toEqual([
      expect.objectContaining({
        completed: 1,
        rows: [
          expect.objectContaining({ completed: 1, errors: 1, statuses: {}, credential: { _tag: 'Unidentified' } }),
        ],
      }),
    ])
    expect(JSON.stringify(reports)).not.toContain('another-private-token')
  } finally {
    counts.stop()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})
