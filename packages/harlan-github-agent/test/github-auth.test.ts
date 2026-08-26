import { Octokit } from 'octokit'
import { describe, expect, it } from 'vitest'
import { createAuthenticatedClient, createRepositoryTokenProvider } from '../src/github-auth.ts'
import { ok } from '../src/result.ts'

describe('gitHub App authentication', () => {
  it.each([
    ['read', { contents: 'read', issues: 'read', metadata: 'read', pull_requests: 'read' }],
    ['checks_read', { checks: 'read', metadata: 'read', statuses: 'read' }],
    ['contents_write', { contents: 'write', metadata: 'read' }],
    ['item_write', { contents: 'read', issues: 'write', metadata: 'read', pull_requests: 'write' }],
    ['workflows_write', { contents: 'write', metadata: 'read', workflows: 'write' }],
  ] as const)('mints one repository-scoped %s token', async (access, permissions) => {
    const requests: unknown[] = []
    const provider = createRepositoryTokenProvider({
      getInstallationId: () => Promise.resolve(42),
      mintToken: (input) => {
        requests.push(input)
        return Promise.resolve({ token: 'installation-token', expiresAt: '2026-08-13T01:00:00.000Z', permissions: input.permissions })
      },
    })

    const result = await provider.getToken('harlan-zw/example', access)

    expect(result).toEqual({
      _tag: 'Ok',
      value: { token: 'installation-token', expiresAt: '2026-08-13T01:00:00.000Z' },
    })
    expect(requests).toEqual([{
      installationId: 42,
      permissions,
      repositoryName: 'example',
      refresh: false,
    }])
  })

  it('covers issues and pull requests with the one write access', async () => {
    const requests: Array<Record<string, string>> = []
    const provider = createRepositoryTokenProvider({
      getInstallationId: () => Promise.resolve(42),
      mintToken: (input) => {
        requests.push(input.permissions)
        return Promise.resolve({ token: 'installation-token', expiresAt: '2126-01-01T00:00:00.000Z', permissions: input.permissions })
      },
    })

    await provider.getToken('harlan-zw/example', 'item_write')

    // GitHub serves comments and labels for both kinds through the Issues API,
    // so one write token has to carry both permissions or half the calls fail.
    expect(requests[0]).toMatchObject({ issues: 'write', pull_requests: 'write' })
  })

  it('rejects a token GitHub scoped below the request', async () => {
    const provider = createRepositoryTokenProvider({
      getInstallationId: () => Promise.resolve(42),
      mintToken: () => Promise.resolve({
        token: 'short-token',
        expiresAt: '2126-01-01T00:00:00.000Z',
        permissions: { contents: 'read', metadata: 'read', pull_requests: 'write' },
      }),
    })

    const result = await provider.getToken('harlan-zw/example', 'item_write')

    expect(result._tag).toBe('Err')
    expect(result._tag === 'Err' ? result.error.message : '').toBe('GitHub granted less access than this token asked for: issues.')
  })

  it('never caches a token GitHub scoped below the request', async () => {
    let issued = 0
    const provider = createRepositoryTokenProvider({
      getInstallationId: () => Promise.resolve(42),
      mintToken: (input) => {
        issued += 1
        return Promise.resolve(issued === 1
          ? { token: 'short-token', expiresAt: '2126-01-01T00:00:00.000Z', permissions: { metadata: 'read' } }
          : { token: 'full-token', expiresAt: '2126-01-01T00:00:00.000Z', permissions: input.permissions })
      },
    })

    expect((await provider.getToken('harlan-zw/example', 'read'))._tag).toBe('Err')

    expect(await provider.getToken('harlan-zw/example', 'read')).toEqual(ok({
      token: 'full-token',
      expiresAt: '2126-01-01T00:00:00.000Z',
    }))
  })

  it('accepts a grant wider than the request', async () => {
    const provider = createRepositoryTokenProvider({
      getInstallationId: () => Promise.resolve(42),
      mintToken: () => Promise.resolve({
        token: 'wide-token',
        expiresAt: '2126-01-01T00:00:00.000Z',
        permissions: { checks: 'read', contents: 'write', issues: 'write', metadata: 'read', pull_requests: 'write' },
      }),
    })

    expect((await provider.getToken('harlan-zw/example', 'read'))._tag).toBe('Ok')
  })

  it('reuses a live repository-scoped token', async () => {
    let mintCount = 0
    const provider = createRepositoryTokenProvider({
      getInstallationId: () => Promise.resolve(42),
      mintToken: (input) => {
        mintCount += 1
        return Promise.resolve({ token: 'installation-token', expiresAt: '2026-08-13T02:00:00.000Z', permissions: input.permissions })
      },
      now: () => new Date('2026-08-13T01:00:00.000Z'),
    })

    await provider.getToken('harlan-zw/example', 'read')
    await provider.getToken('harlan-zw/example', 'read')

    expect(mintCount).toBe(1)
  })

  it('refreshes a stale installation after an authentication failure', async () => {
    let installationId = 1
    const requests: number[] = []
    const provider = createRepositoryTokenProvider({
      getInstallationId: () => Promise.resolve(installationId),
      mintToken: (input) => {
        requests.push(input.installationId)
        if (input.installationId === 1 && requests.length > 1) {
          installationId = 2
          return Promise.reject(Object.assign(new Error('Not found'), { status: 404 }))
        }
        return Promise.resolve({ token: `token-${input.installationId}`, expiresAt: '2026-08-13T01:00:00.000Z', permissions: input.permissions })
      },
    })

    expect((await provider.getToken('harlan-zw/example', 'read'))._tag).toBe('Ok')
    expect(await provider.getToken('harlan-zw/example', 'read')).toEqual(ok({
      token: 'token-2',
      expiresAt: '2026-08-13T01:00:00.000Z',
    }))
    expect(requests).toEqual([1, 1, 2])
  })
})

describe('rejected credential recovery', () => {
  it('mints a fresh token after a caller reports a rejection', async () => {
    const minted: Array<{ refresh: boolean }> = []
    let issued = 0
    const provider = createRepositoryTokenProvider({
      getInstallationId: () => Promise.resolve(42),
      mintToken: (input) => {
        minted.push({ refresh: input.refresh })
        issued += 1
        return Promise.resolve({ token: `token-${issued}`, expiresAt: '2126-01-01T00:00:00.000Z', permissions: input.permissions })
      },
    })

    const first = await provider.getToken('harlan-zw/example', 'read')
    const cached = await provider.getToken('harlan-zw/example', 'read')
    expect(first).toEqual(cached)
    expect(minted).toHaveLength(1)

    provider.invalidate('harlan-zw/example', 'read')
    const refreshed = await provider.getToken('harlan-zw/example', 'read')

    expect(minted).toEqual([{ refresh: false }, { refresh: true }])
    expect(refreshed).toEqual({ _tag: 'Ok', value: { token: 'token-2', expiresAt: '2126-01-01T00:00:00.000Z' } })
  })

  it('leaves other access levels of the same repository alone', async () => {
    let issued = 0
    const provider = createRepositoryTokenProvider({
      getInstallationId: () => Promise.resolve(42),
      mintToken: (input) => {
        issued += 1
        return Promise.resolve({ token: `token-${issued}`, expiresAt: '2126-01-01T00:00:00.000Z', permissions: input.permissions })
      },
    })

    await provider.getToken('harlan-zw/example', 'read')
    const write = await provider.getToken('harlan-zw/example', 'item_write')
    provider.invalidate('harlan-zw/example', 'read')

    expect(await provider.getToken('harlan-zw/example', 'item_write')).toEqual(write)
    expect(issued).toBe(2)
  })
})

describe('createAuthenticatedClient', () => {
  function tokenProvider(tokens: string[]) {
    const invalidated: string[] = []
    let index = 0
    return {
      invalidated,
      provider: {
        getToken: () => Promise.resolve(ok({ token: tokens[Math.min(index++, tokens.length - 1)]!, expiresAt: '2126-01-01T00:00:00.000Z' })),
        invalidate: (repository: string, access: string) => invalidated.push(`${repository}:${access}`),
      },
    }
  }

  /** One fake transport that reports which credential each request carried. */
  function client(accepted: string, seen: string[], tokens: ReturnType<typeof tokenProvider>) {
    return createAuthenticatedClient({
      access: 'read',
      repository: 'harlan-zw/example',
      token: 'stale-token',
      tokens: tokens.provider,
      userAgent: 'test',
      createClient: clientOptions => new Octokit({
        ...clientOptions,
        request: {
          fetch: (_url: string, init: { headers: Record<string, string> }) => {
            const authorization = init.headers.authorization ?? ''
            seen.push(authorization)
            const allowed = authorization.endsWith(accepted)
            return Promise.resolve(new Response(
              JSON.stringify(allowed ? [{ number: 1 }] : { message: 'Resource not accessible by integration' }),
              { status: allowed ? 200 : 403, headers: { 'content-type': 'application/json' } },
            ))
          },
        },
      }),
    })
  }

  it('re-mints and retries once when GitHub rejects the credential', async () => {
    const seen: string[] = []
    const tokens = tokenProvider(['fresh-token'])
    const octokit = client('fresh-token', seen, tokens)

    const response = await octokit.rest.pulls.list({ owner: 'harlan-zw', repo: 'example' })

    expect(response.data).toEqual([{ number: 1 }])
    expect(seen).toEqual(['token stale-token', 'token fresh-token'])
    expect(tokens.invalidated).toEqual(['harlan-zw/example:read'])
  })

  it('reports a second rejection instead of retrying forever', async () => {
    const seen: string[] = []
    const tokens = tokenProvider(['also-rejected'])
    const octokit = client('never', seen, tokens)

    await expect(octokit.rest.pulls.list({ owner: 'harlan-zw', repo: 'example' })).rejects.toThrow(/not accessible/)
    expect(seen).toHaveLength(2)
  })
})
