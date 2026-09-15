import { Octokit } from 'octokit'
import { describe, expect, it } from 'vitest'
import { createAuthenticatedClient } from '../src/github-auth.ts'
import { createGitHubResponseCache } from '../src/github-response-cache.ts'
import { ok } from '../src/result.ts'

function setup(cache = createGitHubResponseCache()) {
  const seen: Array<{ url: string, headers: Record<string, string> }> = []
  const responses: Response[] = []
  const client = (token = 'first', access: 'read' | 'item_write' = 'read') => createAuthenticatedClient({
    access,
    repository: 'harlan-zw/example',
    token,
    tokens: { getToken: async () => ok({ token: 'refreshed', expiresAt: '2126-01-01T00:00:00Z' }), invalidate: () => {} },
    userAgent: 'test',
    responseCache: cache,
    createClient: options => new Octokit({
      ...options,
      retry: { enabled: false },
      request: { fetch: async (url: string, init: { headers: Record<string, string> }) => {
        seen.push({ url, headers: init.headers })
        const response = responses.shift()
        if (response === undefined)
          throw new Error('Unexpected request')
        return response
      } },
    }),
  })
  return { seen, responses, client }
}

function json(data: unknown, etag?: string, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', ...(etag === undefined ? {} : { etag }), ...extra } })
}

const route = 'GET /repos/harlan-zw/example/issues'

describe('authenticated conditional reads', () => {
  it('revalidates across clients and returns isolated data with fresh response headers', async () => {
    const { responses, client, seen } = setup()
    responses.push(json([{ number: 1 }], '"v1"'), new Response(null, { status: 304, headers: { 'x-ratelimit-remaining': '4000' } }))
    const first = await client().request(route)
    first.data[0].number = 99
    const second = await client().request(route)
    expect(second.data).toEqual([{ number: 1 }])
    expect(second.headers['x-ratelimit-remaining']).toBe('4000')
    expect(seen.map(call => call.headers['if-none-match'])).toEqual([undefined, '"v1"'])
    expect(seen.every(call => call.headers.authorization === 'token first')).toBe(true)
  })

  it('refreshes changed data and stops reusing a response without an ETag', async () => {
    const { responses, client, seen } = setup()
    responses.push(json([1], '"v1"'), json([2], '"v2"'), json([3]), json([4]))
    const octokit = client()
    for (const value of [1, 2, 3, 4])
      expect((await octokit.request(route)).data).toEqual([value])
    expect(seen.map(call => call.headers['if-none-match'])).toEqual([undefined, '"v1"', '"v2"', undefined])
  })

  it('keeps pagination links when GitHub omits them on 304 responses', async () => {
    const { responses, client, seen } = setup()
    const next = 'https://api.github.com/repos/harlan-zw/example/issues?page=2'
    responses.push(json([{ number: 1 }], '"page1"', { link: `<${next}>; rel="next"` }), json([{ number: 2 }], '"page2"'))
    expect(await client().paginate(route)).toEqual([{ number: 1 }, { number: 2 }])
    responses.push(new Response(null, { status: 304 }), new Response(null, { status: 304 }))
    expect(await client().paginate(route)).toEqual([{ number: 1 }, { number: 2 }])
    expect(seen.slice(2).map(call => call.headers['if-none-match'])).toEqual(['"page1"', '"page2"'])
    expect(seen[3]?.url).toBe(next)
  })

  it('separates tokens, query parameters, and media types', async () => {
    const { responses, client, seen } = setup()
    for (let index = 0; index < 4; index++)
      responses.push(json([index], `"${index}"`))
    expect((await client().request(route)).data).toEqual([0])
    expect((await client('other').request(route)).data).toEqual([1])
    expect((await client().request(route, { page: 2 })).data).toEqual([2])
    expect((await client().request(route, { headers: { accept: 'application/vnd.github.full+json' } })).data).toEqual([3])
    expect(seen.map(call => call.headers['if-none-match'])).toEqual([undefined, undefined, undefined, undefined])
  })

  it('does not carry a rejected token validator into the authentication retry', async () => {
    const { responses, client, seen } = setup()
    responses.push(json([1], '"private"'), new Response('{"message":"Bad credentials"}', { status: 401 }), json([2], '"new"'))
    const octokit = client()
    await octokit.request(route)
    expect((await octokit.request(route)).data).toEqual([2])
    expect(seen.map(call => [call.headers.authorization, call.headers['if-none-match']])).toEqual([
      ['token first', undefined],
      ['token first', '"private"'],
      ['token refreshed', undefined],
    ])
  })

  it.each([404, 422, 500])('propagates %s and forgets the old response', async (status) => {
    const { responses, client, seen } = setup()
    responses.push(json([1], '"v1"'), new Response('{"message":"Request failed"}', { status }), json([2]))
    const octokit = client()
    await octokit.request(route)
    await expect(octokit.request(route)).rejects.toMatchObject({ status })
    expect((await octokit.request(route)).data).toEqual([2])
    expect(seen.at(-1)?.headers['if-none-match']).toBeUndefined()
  })

  it('propagates an unsolicited 304', async () => {
    const { responses, client } = setup()
    responses.push(new Response(null, { status: 304 }))
    await expect(client().request(route)).rejects.toMatchObject({ status: 304 })
  })

  it('evicts the least recently used response at the entry bound', async () => {
    const { responses, client, seen } = setup(createGitHubResponseCache({ maxEntries: 2 }))
    responses.push(json([1], '"one"'), json([2], '"two"'), new Response(null, { status: 304 }), json([3], '"three"'), json([2]))
    const octokit = client()
    for (const page of [1, 2, 1, 3, 2])
      await octokit.request(route, { page })
    expect(seen.map(call => call.headers['if-none-match'])).toEqual([undefined, undefined, '"one"', undefined, undefined])
  })

  it('skips oversized responses and no-store responses', async () => {
    const { responses, client, seen } = setup(createGitHubResponseCache({ maxBytes: 1 }))
    responses.push(json([1], '"large"'), json([2], '"large"'))
    await client().request(route)
    expect((await client().request(route)).data).toEqual([2])
    expect(seen[1]?.headers['if-none-match']).toBeUndefined()
    const noStore = setup()
    noStore.responses.push(json([1], '"secret"', { 'cache-control': 'no-store' }), json([2]))
    await noStore.client().request(route)
    await noStore.client().request(route)
    expect(noStore.seen[1]?.headers['if-none-match']).toBeUndefined()
  })

  it('leaves write clients and caller-supplied conditions unchanged', async () => {
    const { responses, client, seen } = setup()
    responses.push(json([1], '"v1"'), json([2]), new Response(null, { status: 304 }), json([3]))
    await client().request(route)
    expect((await client('first', 'item_write').request(route)).data).toEqual([2])
    await expect(client().request(route, { headers: { 'if-none-match': '"caller"' } })).rejects.toMatchObject({ status: 304 })
    await client().request('POST /repos/harlan-zw/example/issues', { title: 'example' })
    expect(seen.map(call => call.headers['if-none-match'])).toEqual([undefined, undefined, '"caller"', undefined])
  })
})
