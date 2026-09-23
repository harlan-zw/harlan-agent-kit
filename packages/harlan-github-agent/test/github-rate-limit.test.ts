import type { GitHubQuota } from '../src/github-rate-limit.ts'
import { Octokit } from 'octokit'
import { describe, expect, it } from 'vitest'
import { createAuthenticatedClient } from '../src/github-auth.ts'
import { createGitHubRateLimitGate } from '../src/github-rate-limit.ts'
import { ok } from '../src/result.ts'

const installation = (repository: string): GitHubQuota => ({ _tag: 'Installation', owner: repository.split('/')[0]! })

function setup(response: { status: number, message: string, headers: Record<string, string> }) {
  let clock = new Date('2026-09-23T10:00:00.000Z')
  const gate = createGitHubRateLimitGate({ now: () => clock })
  const tokens = gate.guard({
    getToken: () => Promise.resolve(ok({ token: 'valid-token', expiresAt: '2126-01-01T00:00:00.000Z' })),
    invalidate: () => {},
  }, installation)
  let requests = 0
  const octokit = createAuthenticatedClient({
    access: 'read',
    repository: 'harlan-zw/example',
    token: 'valid-token',
    tokens,
    userAgent: 'test',
    createClient: clientOptions => new Octokit({
      ...clientOptions,
      retry: { enabled: false },
      request: { fetch: async () => {
        requests += 1
        return new Response(JSON.stringify({ message: response.message }), {
          status: response.status,
          headers: { 'content-type': 'application/json', ...response.headers },
        })
      } },
    }),
  })
  return {
    gate,
    octokit,
    tokens,
    requests: () => requests,
    advanceTo: (at: string) => {
      clock = new Date(at)
    },
  }
}

const reset = String(Date.parse('2026-09-23T10:40:00.000Z') / 1000)

describe('gitHub rate limit gate', () => {
  it('fails fast on an exhausted primary quota and holds the installation until the reset', async () => {
    const github = setup({ status: 403, message: 'API rate limit exceeded for installation ID 7.', headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } })

    await expect(github.octokit.rest.pulls.list({ owner: 'harlan-zw', repo: 'example' })).rejects.toMatchObject({ status: 403 })
    expect(github.requests()).toBe(1)

    const held = await github.tokens.getToken('harlan-zw/other', 'read')
    expect(held).toEqual({ _tag: 'Err', error: {
      repository: 'harlan-zw/other',
      message: 'The App installation on harlan-zw hit the primary GitHub rate limit. Requests pause until 2026-09-23T10:40:00.000Z.',
    } })
    expect(github.gate.active()).toEqual([held._tag === 'Err' ? held.error.message : ''])

    github.advanceTo('2026-09-23T10:40:00.001Z')
    expect((await github.tokens.getToken('harlan-zw/other', 'read'))._tag).toBe('Ok')
    expect(github.gate.active()).toEqual([])
  })

  it('leaves another installation readable', async () => {
    const github = setup({ status: 403, message: 'API rate limit exceeded.', headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } })

    await expect(github.octokit.rest.pulls.list({ owner: 'harlan-zw', repo: 'example' })).rejects.toMatchObject({ status: 403 })

    expect((await github.tokens.getToken('nuxt/nuxt', 'read'))._tag).toBe('Ok')
  })

  it('fails fast on a secondary rate limit and holds for the retry delay', async () => {
    const github = setup({ status: 403, message: 'You have exceeded a secondary rate limit.', headers: { 'retry-after': '30' } })

    await expect(github.octokit.rest.pulls.list({ owner: 'harlan-zw', repo: 'example' })).rejects.toMatchObject({ status: 403 })

    expect(github.gate.active()).toEqual(['The App installation on harlan-zw hit a secondary GitHub rate limit. Requests pause until 2026-09-23T10:00:30.000Z.'])
    github.advanceTo('2026-09-23T10:00:30.001Z')
    expect(github.gate.active()).toEqual([])
  })

  it('holds nothing for a credential GitHub rejected', async () => {
    const github = setup({ status: 404, message: 'Not Found', headers: {} })

    await expect(github.octokit.rest.pulls.list({ owner: 'harlan-zw', repo: 'example' })).rejects.toMatchObject({ status: 404 })

    expect(github.gate.active()).toEqual([])
  })
})
