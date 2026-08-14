import { describe, expect, it } from 'vitest'
import { currentGitHubChecks } from '../src/github-worker-source.ts'

describe('current GitHub checks', () => {
  it('uses the latest run when one check context ran more than once', () => {
    const checks = currentGitHubChecks([
      { id: 20, source: { _tag: 'CheckRun', appId: 15368 }, name: 'test', status: 'completed', conclusion: 'success' },
      { id: 10, source: { _tag: 'CheckRun', appId: 15368 }, name: 'test', status: 'completed', conclusion: 'cancelled' },
      { id: 30, source: { _tag: 'CheckRun', appId: 15368 }, name: 'release', status: 'completed', conclusion: 'success' },
    ])

    expect(checks).toEqual([
      { id: 20, source: { _tag: 'CheckRun', appId: 15368 }, name: 'test', status: 'completed', conclusion: 'success' },
      { id: 30, source: { _tag: 'CheckRun', appId: 15368 }, name: 'release', status: 'completed', conclusion: 'success' },
    ])
  })
})
