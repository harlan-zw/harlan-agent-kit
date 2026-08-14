import { describe, expect, it } from 'vitest'
import { createRepositoryTokenProvider } from '../src/github-auth.ts'
import { ok } from '../src/result.ts'

describe('gitHub App authentication', () => {
  it.each([
    ['read', { contents: 'read', issues: 'read', metadata: 'read', pull_requests: 'read' }],
    ['checks_read', { checks: 'read', metadata: 'read', statuses: 'read' }],
    ['contents_write', { contents: 'write', metadata: 'read', workflows: 'write' }],
    ['issues_write', { issues: 'write', metadata: 'read' }],
    ['pull_requests_write', { contents: 'read', metadata: 'read', pull_requests: 'write' }],
  ] as const)('mints one repository-scoped %s token', async (access, permissions) => {
    const requests: unknown[] = []
    const provider = createRepositoryTokenProvider({
      getInstallationId: () => Promise.resolve(42),
      mintToken: (input) => {
        requests.push(input)
        return Promise.resolve({ token: 'installation-token', expiresAt: '2026-08-13T01:00:00.000Z' })
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
    }])
  })

  it('reuses a live repository-scoped token', async () => {
    let mintCount = 0
    const provider = createRepositoryTokenProvider({
      getInstallationId: () => Promise.resolve(42),
      mintToken: () => {
        mintCount += 1
        return Promise.resolve({ token: 'installation-token', expiresAt: '2026-08-13T02:00:00.000Z' })
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
        return Promise.resolve({ token: `token-${input.installationId}`, expiresAt: '2026-08-13T01:00:00.000Z' })
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
