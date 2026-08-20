import type { GitHubAgentSource } from '../src/github-agent-source.ts'
import { describe, expect, it } from 'vitest'
import { createGitHubWriteGate, repositoryQuarantineReason } from '../src/github-write-gate.ts'
import { ok } from '../src/result.ts'
import { repositoryMapping } from './fixtures.ts'

function source(calls: string[]): GitHubAgentSource {
  const record = (name: string) => {
    calls.push(name)
    return Promise.resolve(ok({ commentId: 1, url: 'url' }))
  }
  return {
    consumeApprovalLabel: () => {
      calls.push('consumeApprovalLabel')
      return Promise.resolve(ok(undefined))
    },
    ensureApprovalLabel: () => {
      calls.push('ensureApprovalLabel')
      return Promise.resolve(ok(undefined))
    },
    upsertIssueTriageComment: () => record('upsertIssueTriageComment'),
    upsertReviewStatus: () => record('upsertReviewStatus'),
  } as unknown as GitHubAgentSource
}

describe('gitHub write gate', () => {
  it('refuses every write to a repository nobody enabled writes for', async () => {
    const calls: string[] = []
    const refused: string[] = []
    const gate = createGitHubWriteGate({
      mayWrite: () => false,
      onRefused: github => refused.push(github),
      source: source(calls),
    })
    const repository = repositoryMapping()
    const signal = new AbortController().signal

    const results = [
      await gate.upsertReviewStatus(repository, 1, null, 'body', false, signal),
      await gate.upsertIssueTriageComment(repository, 1, null, 'body', signal),
      await gate.ensureApprovalLabel(repository, 'harlan-agent-review', signal),
      await gate.consumeApprovalLabel(repository, 'pull_request', 1, 'harlan-agent-review', signal),
    ]

    expect(results).toEqual(Array.from({ length: 4 }, () => ({
      _tag: 'Err',
      error: repositoryQuarantineReason('harlan-zw/example'),
    })))
    expect(calls).toEqual([])
    expect(refused).toEqual(Array.from({ length: 4 }).fill('harlan-zw/example'))
  })

  it('passes every write through once a person enables the repository', async () => {
    const calls: string[] = []
    const gate = createGitHubWriteGate({
      mayWrite: github => github === 'harlan-zw/example',
      onRefused: () => { throw new Error('An enabled repository must not be refused.') },
      source: source(calls),
    })
    const signal = new AbortController().signal

    await gate.upsertReviewStatus(repositoryMapping(), 1, null, 'body', false, signal)
    await gate.ensureApprovalLabel(repositoryMapping(), 'harlan-agent-review', signal)

    expect(calls).toEqual(['upsertReviewStatus', 'ensureApprovalLabel'])
  })
})
