import type { GitHubRepositoryAccess } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import {
  createGitHubWriteGate,
  isRepositoryWriteQuarantineReason,
  repositoryQuarantineReason,
  withGitHubWritePreflight,
} from '../src/github-write-gate.ts'
import { err, ok } from '../src/result.ts'

describe('gitHub write gate', () => {
  it('recognizes only the write quarantine reason', () => {
    expect(isRepositoryWriteQuarantineReason(repositoryQuarantineReason('wolfstar-project/example'))).toBe(true)
    expect(
      isRepositoryWriteQuarantineReason(
        `wolfstar-project/example: ${repositoryQuarantineReason('wolfstar-project/example')}`,
      ),
    ).toBe(true)
    expect(isRepositoryWriteQuarantineReason('Repository policy does not authorize this write.')).toBe(false)
  })

  it('refuses every write credential to a repository nobody enabled', async () => {
    const requested: GitHubRepositoryAccess[] = []
    const gate = createGitHubWriteGate({
      mayWrite: () => false,
      source: {
        getToken: (_repository, access) => {
          requested.push(access)
          return Promise.resolve(ok({ token: 'token', expiresAt: '2126-01-01T00:00:00.000Z' }))
        },
        invalidate: () => undefined,
      },
    })

    const results = await Promise.all([
      gate.getToken('wolfstar-project/example', 'item_write'),
      gate.getToken('wolfstar-project/example', 'review_thread_write'),
      gate.getToken('wolfstar-project/example', 'contents_write'),
      gate.getToken('wolfstar-project/example', 'pull_request_merge'),
      gate.getToken('wolfstar-project/example', 'workflows_write'),
    ])

    expect(results).toEqual(
      Array.from({ length: 5 }, () => ({
        _tag: 'Err',
        error: {
          repository: 'wolfstar-project/example',
          message: repositoryQuarantineReason('wolfstar-project/example'),
        },
      })),
    )
    expect(requested).toEqual([])
  })

  it('passes reads and trusted writes through unchanged', async () => {
    const requested: GitHubRepositoryAccess[] = []
    const gate = createGitHubWriteGate({
      mayWrite: (github) => github === 'wolfstar-project/example',
      source: {
        getToken: (_repository, access) => {
          requested.push(access)
          return Promise.resolve(ok({ token: access, expiresAt: '2126-01-01T00:00:00.000Z' }))
        },
        invalidate: () => undefined,
      },
    })

    expect(await gate.getToken('outside/example', 'read')).toEqual(
      ok({
        token: 'read',
        expiresAt: '2126-01-01T00:00:00.000Z',
      }),
    )
    expect(await gate.getToken('wolfstar-project/example', 'item_write')).toEqual(
      ok({
        token: 'item_write',
        expiresAt: '2126-01-01T00:00:00.000Z',
      }),
    )
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
          return Promise.resolve(
            access === 'contents_write'
              ? err({ repository, message: 'The GitHub App needs Contents write permission.' })
              : ok({ token: access, expiresAt: '2126-01-01T00:00:00.000Z' }),
          )
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

    expect(await worker.run({ repository: 'wolfstar-project/example' }, new AbortController().signal)).toEqual(
      err('The GitHub App needs Contents write permission.'),
    )
    expect(requested).toEqual(['item_write', 'contents_write'])
    expect(runs).toBe(0)
  })
})
