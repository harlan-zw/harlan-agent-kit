import type { Octokit } from 'octokit'
import { describe, expect, it, vi } from 'vitest'
import { ok } from '../src/result.ts'
import { repositoryMapping } from './fixtures.ts'

const hoisted = vi.hoisted(() => {
  const state = {
    remoteBody: '',
    reads: 0,
    writes: 0,
  }
  const octokit = {
    rest: {
      issues: {
        getComment: () => Promise.resolve({
          data: {
            id: 5,
            html_url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-5',
            issue_url: 'https://github.com/harlan-zw/example/issues/24',
            user: { login: 'harlan-agent[bot]' },
            body: state.remoteBody,
          },
        }),
        updateComment: (input: { body: string }) => {
          state.writes += 1
          state.remoteBody = input.body
          return Promise.resolve({
            data: {
              id: 5,
              user: { login: 'harlan-agent[bot]' },
              body: input.body,
              html_url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-5',
            },
          })
        },
      },
    },
  }
  return { state, octokit }
})

vi.mock('../src/github-auth.ts', () => ({
  createAuthenticatedClient: () => hoisted.octokit as unknown as Octokit,
}))

const { createGitHubAgentSource } = await import('../src/github-agent-source.ts')

const publishedBody = '<!-- harlan-agent-review --> published review'
const progressBody = '<!-- harlan-agent-progress --> claimed agent progress'

function source() {
  return createGitHubAgentSource({
    actorLogin: () => 'harlan-agent[bot]',
    tokens: {
      getToken: () => Promise.resolve(ok({ token: 'token', expiresAt: '2026-08-14T02:00:00.000Z' })),
      invalidate: () => undefined,
    },
  })
}

describe('editReviewStatus compare and swap', () => {
  it('reports Edited when the written body survives', async () => {
    hoisted.state.remoteBody = publishedBody
    hoisted.state.reads = 0
    const result = await source().editReviewStatus(repositoryMapping(), 24, 5, publishedBody, 'updated body', new AbortController().signal)
    expect(hoisted.state.writes).toBe(1)
    expect(result).toEqual(ok({ _tag: 'Edited', commentId: 5, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-5' }))
  })

  it('reports Changed when a concurrent writer replaces the comment around the edit', async () => {
    hoisted.state.remoteBody = publishedBody
    hoisted.octokit.rest.issues.updateComment = (input: { body: string }) => {
      // The write lands, then a claimed agent publishes its own progress over it.
      hoisted.state.writes += 1
      hoisted.state.remoteBody = progressBody
      return Promise.resolve({
        data: {
          id: 5,
          user: { login: 'harlan-agent[bot]' },
          body: input.body,
          html_url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-5',
        },
      })
    }
    const result = await source().editReviewStatus(repositoryMapping(), 24, 5, publishedBody, 'updated body', new AbortController().signal)
    expect(result).toEqual(ok({ _tag: 'Changed' }))
  })

  it('reports Foreign without writing when another actor owns the comment', async () => {
    hoisted.state.remoteBody = publishedBody
    hoisted.state.writes = 0
    hoisted.octokit.rest.issues.getComment = () => Promise.resolve({
      data: {
        id: 5,
        html_url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-5',
        issue_url: 'https://github.com/harlan-zw/example/issues/24',
        user: { login: 'someone-else' },
        body: publishedBody,
      },
    })
    const result = await source().editReviewStatus(repositoryMapping(), 24, 5, publishedBody, 'updated body', new AbortController().signal)
    expect(hoisted.state.writes).toBe(0)
    expect(result).toEqual(ok({ _tag: 'Foreign', reason: 'The stored automated review comment belongs to another GitHub actor.' }))
  })
})
