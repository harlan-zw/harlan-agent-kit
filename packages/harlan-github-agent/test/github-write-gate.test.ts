import type { GitHubRepositoryAccess } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { createGitHubWriteGate, repositoryQuarantineReason, withGitHubWritePreflight } from '../src/github-write-gate.ts'
import { err, ok } from '../src/result.ts'

describe('gitHub write gate', () => {
  it('refuses every write credential to a repository nobody enabled', async () => {
    const requested: GitHubRepositoryAccess[] = []
    const refused: string[] = []
    const gate = createGitHubWriteGate({
      mayWrite: () => false,
      onRefused: github => refused.push(github),
      source: {
        getToken: (_repository, access) => {
          requested.push(access)
          return Promise.resolve(ok({ token: 'token', expiresAt: '2126-01-01T00:00:00.000Z' }))
        },
        invalidate: () => undefined,
      },
    })

    const results = await Promise.all([
      gate.getToken('harlan-zw/example', 'item_write'),
      gate.getToken('harlan-zw/example', 'contents_write'),
    ])

    expect(results).toEqual(Array.from({ length: 2 }, () => ({
      _tag: 'Err',
      error: {
        repository: 'harlan-zw/example',
        message: repositoryQuarantineReason('harlan-zw/example'),
      },
    })))
    expect(requested).toEqual([])
    expect(refused).toEqual(['harlan-zw/example', 'harlan-zw/example'])
  })

  it('passes reads and trusted writes through unchanged', async () => {
    const requested: GitHubRepositoryAccess[] = []
    const gate = createGitHubWriteGate({
      mayWrite: github => github === 'harlan-zw/example',
      onRefused: () => { throw new Error('An enabled repository must not be refused.') },
      source: {
        getToken: (_repository, access) => {
          requested.push(access)
          return Promise.resolve(ok({ token: access, expiresAt: '2126-01-01T00:00:00.000Z' }))
        },
        invalidate: () => undefined,
      },
    })

    expect(await gate.getToken('outside/example', 'read')).toEqual(ok({
      token: 'read',
      expiresAt: '2126-01-01T00:00:00.000Z',
    }))
    expect(await gate.getToken('harlan-zw/example', 'item_write')).toEqual(ok({
      token: 'item_write',
      expiresAt: '2126-01-01T00:00:00.000Z',
    }))
    expect(requested).toEqual(['read', 'item_write'])
  })

  it('stops before agent work when GitHub refuses required access', async () => {
    const requested: GitHubRepositoryAccess[] = []
    let runs = 0
    const worker = withGitHubWritePreflight({
      accesses: ['item_write', 'contents_write'],
      source: {
        getToken: (repository, access) => {
          requested.push(access)
          return Promise.resolve(access === 'contents_write'
            ? err({ repository, message: 'The GitHub App needs Contents write permission.' })
            : ok({ token: access, expiresAt: '2126-01-01T00:00:00.000Z' }))
        },
        invalidate: () => undefined,
      },
      worker: {
        run: () => {
          runs += 1
          return Promise.resolve(ok({ evidence: 'Agent ran.' }))
        },
      },
    })

    expect(await worker.run({ repository: 'harlan-zw/example' }, new AbortController().signal))
      .toEqual(err('The GitHub App needs Contents write permission.'))
    expect(requested).toEqual(['item_write', 'contents_write'])
    expect(runs).toBe(0)
  })
})
