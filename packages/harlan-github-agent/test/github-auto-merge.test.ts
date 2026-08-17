import type { Octokit } from 'octokit'
import { describe, expect, it } from 'vitest'
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
