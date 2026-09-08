import type { OpenAgentPullRequest } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { chooseStackBase } from '../src/stack.ts'

function candidate(overrides: Partial<OpenAgentPullRequest> = {}): OpenAgentPullRequest {
  return {
    pullRequestNumber: 101,
    headRef: 'fix/baseline-ci-70a5f7bd49f2',
    headSha: 'repair-head',
    baseRef: 'main',
    taskKind: 'baseline_repair',
    ...overrides,
  }
}

describe('stack base before the agent runs', () => {
  it('uses the default branch when the service has no open pull request', () => {
    expect(chooseStackBase({ defaultBranch: 'main', candidates: [] }))
      .toEqual({ _tag: 'DefaultBranch', ref: 'main' })
  })

  it('stacks on an open Baseline repair, because the default branch is broken', () => {
    expect(chooseStackBase({ defaultBranch: 'main', candidates: [candidate()] })).toEqual({
      _tag: 'Stacked',
      ref: 'fix/baseline-ci-70a5f7bd49f2',
      pullRequestNumber: 101,
      headSha: 'repair-head',
    })
  })

  it('ignores an issue work pull request, which proves nothing about the default branch', () => {
    expect(chooseStackBase({
      defaultBranch: 'main',
      candidates: [candidate({ taskKind: 'issue_work', headRef: 'fix/issue-9' })],
    })).toEqual({ _tag: 'DefaultBranch', ref: 'main' })
  })

  it('ignores a Baseline repair that is itself stacked', () => {
    expect(chooseStackBase({
      defaultBranch: 'main',
      candidates: [candidate({ baseRef: 'fix/other' })],
    })).toEqual({ _tag: 'DefaultBranch', ref: 'main' })
  })

  it('stacks on the newest Baseline repair when several are open', () => {
    const chosen = chooseStackBase({
      defaultBranch: 'main',
      candidates: [candidate({ pullRequestNumber: 101 }), candidate({ pullRequestNumber: 140, headRef: 'fix/baseline-ci-later', headSha: 'later-head' })],
    })
    expect(chosen).toEqual({ _tag: 'Stacked', ref: 'fix/baseline-ci-later', pullRequestNumber: 140, headSha: 'later-head' })
  })
})
