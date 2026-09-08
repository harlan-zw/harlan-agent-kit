import type { Octokit } from 'octokit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRepositoryTokenProvider } from '../src/github-auth.ts'
import { createGitHubWriteGate, repositoryQuarantineReason } from '../src/github-write-gate.ts'
import { createGitHubPullRequestMerger } from '../src/github.ts'
import { ok } from '../src/result.ts'
import { repositoryMapping } from './fixtures.ts'

interface FakeGitHub {
  headSha?: string
  /** Thrown by the auto-merge mutation, if anything. */
  autoMergeError?: Error
  mergeResponse?: { merged: boolean, sha?: string, message?: string }
}

interface Recorded {
  graphql: Array<Record<string, unknown>>
  merges: Array<Record<string, unknown>>
}

function merger(github: FakeGitHub, recorded: Recorded) {
  return createGitHubPullRequestMerger({
    createClient: () => ({
      graphql: (_query: string, variables: Record<string, unknown>) => {
        recorded.graphql.push(variables)
        return github.autoMergeError === undefined
          ? Promise.resolve({})
          : Promise.reject(github.autoMergeError)
      },
      rest: {
        pulls: {
          get: () => Promise.resolve({
            data: { node_id: 'PR_node_1', head: { sha: github.headSha ?? 'abc123' } },
          }),
          merge: (input: Record<string, unknown>) => {
            recorded.merges.push(input)
            const response = github.mergeResponse ?? { merged: true, sha: 'merge-sha' }
            return Promise.resolve({ data: response })
          },
        },
      },
    }) as unknown as Octokit,
    tokens: {
      getToken: () => Promise.resolve(ok({ token: 'token', expiresAt: '2126-01-01T00:00:00.000Z' })),
      invalidate: () => undefined,
    },
  })
}

const input = {
  repository: repositoryMapping(),
  number: 24,
  expectedHeadSha: 'abc123',
  method: 'squash' as const,
}

describe('gitHub auto-merge handoff', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([false, true])('mints merge access for a direct merge, authentication retry: %s', async (retry) => {
    const minted: Array<Record<string, string>> = []
    const merged: unknown[] = []
    const tokens = createRepositoryTokenProvider({
      getInstallationId: () => Promise.resolve(42),
      mintToken: ({ permissions }) => {
        minted.push(permissions)
        return Promise.resolve({ token: `token-${minted.length}`, expiresAt: '2126-01-01T00:00:00.000Z', permissions })
      },
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const headers = new Headers(init?.headers)
      const token = headers.get('authorization') ?? ''
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json' },
      })
      if (retry && token === 'token token-1')
        return json({ message: 'Bad credentials' }, 401)
      if (String(url).endsWith('/graphql'))
        return json({ data: null, errors: [{ message: 'Pull request is in clean status' }] })
      if (String(url).endsWith('/merge')) {
        const permissions = minted[Number(token.split('-').at(-1)) - 1]
        if (permissions?.contents !== 'write')
          return json({ message: 'Resource not accessible by integration' }, 403)
        merged.push(JSON.parse(String(init?.body)))
        return json({ merged: true, sha: 'merge-sha' })
      }
      return json({ node_id: 'PR_node_1', head: { sha: 'abc123' } })
    })

    const result = await createGitHubPullRequestMerger({ tokens }).merge(input)

    expect(result).toEqual(ok({ _tag: 'Merged', sha: 'merge-sha' }))
    expect(minted).toEqual(Array.from({ length: retry ? 2 : 1 }, () => ({
      contents: 'write',
      metadata: 'read',
      pull_requests: 'write',
    })))
    expect(merged).toEqual([{ sha: 'abc123', merge_method: 'squash' }])
  })

  it('refuses a merge before minting credentials when repository writes are disabled', async () => {
    const minted: unknown[] = []
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected GitHub request'))
    const tokens = createGitHubWriteGate({
      mayWrite: () => false,
      source: createRepositoryTokenProvider({
        getInstallationId: () => Promise.resolve(42),
        mintToken: (request) => {
          minted.push(request)
          return Promise.resolve({ token: 'token', expiresAt: '2126-01-01T00:00:00.000Z', permissions: request.permissions })
        },
      }),
    })

    const result = await createGitHubPullRequestMerger({ tokens }).merge(input)

    expect(result).toEqual({
      _tag: 'Err',
      error: { repository: input.repository.github, message: repositoryQuarantineReason(input.repository.github) },
    })
    expect(minted).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('hands the merge to GitHub, pinned to the reviewed head commit', async () => {
    const recorded: Recorded = { graphql: [], merges: [] }
    const result = await merger({}, recorded).merge(input)

    expect(result).toEqual(ok({ _tag: 'AutoMergeEnabled' }))
    expect(recorded.graphql).toEqual([{
      pullRequestId: 'PR_node_1',
      mergeMethod: 'SQUASH',
      expectedHeadOid: 'abc123',
    }])
    // GitHub performs the merge, so the controller must not merge as well.
    expect(recorded.merges).toEqual([])
  })

  it('merges immediately when GitHub says there is nothing to wait for', async () => {
    const recorded: Recorded = { graphql: [], merges: [] }
    const result = await merger(
      { autoMergeError: new Error('Pull request is in clean status') },
      recorded,
    ).merge(input)

    expect(result).toEqual(ok({ _tag: 'Merged', sha: 'merge-sha' }))
    expect(recorded.merges).toEqual([expect.objectContaining({
      pull_number: 24,
      sha: 'abc123',
      merge_method: 'squash',
    })])
  })

  it('reports any other GitHub refusal instead of merging behind its back', async () => {
    const recorded: Recorded = { graphql: [], merges: [] }
    const result = await merger(
      { autoMergeError: new Error('Auto-merge is not allowed for this repository') },
      recorded,
    ).merge(input)

    expect(result._tag).toBe('Err')
    expect(recorded.merges).toEqual([])
  })

  it('refuses when the head commit moved after the review', async () => {
    const recorded: Recorded = { graphql: [], merges: [] }
    const result = await merger({ headSha: 'def456' }, recorded).merge(input)

    expect(result).toEqual({
      _tag: 'Err',
      error: {
        repository: 'harlan-zw/example',
        message: 'The head commit moved before the merge was handed to GitHub.',
      },
    })
    expect(recorded.graphql).toEqual([])
    expect(recorded.merges).toEqual([])
  })

  it('reports a refused direct merge', async () => {
    const recorded: Recorded = { graphql: [], merges: [] }
    const result = await merger({
      autoMergeError: new Error('Pull request is in clean status'),
      mergeResponse: { merged: false, message: 'Base branch was modified' },
    }, recorded).merge(input)

    expect(result).toEqual({
      _tag: 'Err',
      error: { repository: 'harlan-zw/example', message: 'Base branch was modified' },
    })
  })
})
