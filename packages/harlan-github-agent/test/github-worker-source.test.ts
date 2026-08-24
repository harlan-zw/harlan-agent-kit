import { describe, expect, it } from 'vitest'
import { chronologicalPullRequestComments, currentGitHubChecks } from '../src/github-agent-source.ts'

describe('current GitHub checks', () => {
  it('uses the latest run when one check context ran more than once', () => {
    const checks = currentGitHubChecks([
      { id: 20, failure: { _tag: 'NotAsked' as const }, source: { _tag: 'CheckRun', appId: 15368 }, name: 'test', status: 'completed', conclusion: 'success' },
      { id: 10, failure: { _tag: 'NotAsked' as const }, source: { _tag: 'CheckRun', appId: 15368 }, name: 'test', status: 'completed', conclusion: 'cancelled' },
      { id: 30, failure: { _tag: 'NotAsked' as const }, source: { _tag: 'CheckRun', appId: 15368 }, name: 'release', status: 'completed', conclusion: 'success' },
    ])

    expect(checks).toEqual([
      { id: 20, failure: { _tag: 'NotAsked' as const }, source: { _tag: 'CheckRun', appId: 15368 }, name: 'test', status: 'completed', conclusion: 'success' },
      { id: 30, failure: { _tag: 'NotAsked' as const }, source: { _tag: 'CheckRun', appId: 15368 }, name: 'release', status: 'completed', conclusion: 'success' },
    ])
  })
})

describe('pull request discussion', () => {
  it('orders issue comments and review comments together by creation time', () => {
    expect(chronologicalPullRequestComments([
      { body: 'review comment', createdAt: '2026-08-13T02:00:00.000Z' },
      { body: 'issue comment', createdAt: '2026-08-13T01:00:00.000Z' },
      { body: 'newest issue comment', createdAt: '2026-08-13T03:00:00.000Z' },
    ])).toEqual(['issue comment', 'review comment', 'newest issue comment'])
  })
})
