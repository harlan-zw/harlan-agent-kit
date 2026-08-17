import { describe, expect, it, vi } from 'vitest'
import { createPullRequestStatusController } from '../src/index.ts'
import { ok } from '../src/result.ts'
import { dashboardSnapshot, pullRequestItem, repositoryMapping } from './fixtures.ts'

describe('pull request status controller', () => {
  it('shows a merged pull request on its completed review', async () => {
    const getPullRequest = vi.fn(() => Promise.resolve(ok(pullRequestItem({
      state: 'closed',
      mergedAt: '2026-08-13T11:00:00.000Z',
    }))))
    const controller = createPullRequestStatusController({
      github: { getPullRequest },
      now: () => new Date('2026-08-13T12:00:00.000Z'),
      repositories: [repositoryMapping()],
    })
    const review = {
      _tag: 'ReviewAgent' as const,
      role: 'adversarial_review' as const,
      id: 'attempt-1',
      repository: 'harlan-zw/example',
      repositoryUrl: 'https://github.com/harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: 'revision-1',
      headSha: 'abc123',
      provider: 'codex' as const,
      sessionId: 'session-1',
      model: 'gpt-5.6-sol',
      agentVersion: '1',
      skillDigest: 'digest',
      startedAt: '2026-08-13T10:00:00.000Z',
      completedAt: '2026-08-13T10:30:00.000Z',
      gates: {
        head: { _tag: 'Passed' as const, evidence: [] },
        merge: { _tag: 'Passed' as const, evidence: [] },
        metadata: { _tag: 'Passed' as const, evidence: [] },
        review: { _tag: 'Passed' as const, evidence: [] },
        verification: { _tag: 'Passed' as const, evidence: [] },
        ci: { _tag: 'Passed' as const, evidence: [] },
      },
      outcome: { _tag: 'Ready' as const, confidence: 98 },
      findings: [],
      publications: [],
      title: 'Fix the broken thing',
      subjectUrl: 'https://github.com/harlan-zw/example/pull/24',
      commitUrl: 'https://github.com/harlan-zw/example/commit/abc123',
      updatedAt: '2026-08-13T10:30:00.000Z',
      pullRequestStatus: { _tag: 'Unknown' as const },
    }
    const snapshot = dashboardSnapshot({ agents: [review] })

    expect(await controller.sync(snapshot)).toEqual({ checked: 1, errors: [] })
    expect(controller.apply(snapshot).agents[0]).toEqual(expect.objectContaining({
      pullRequestStatus: { _tag: 'Merged', mergedAt: '2026-08-13T11:00:00.000Z' },
    }))
    expect(getPullRequest).toHaveBeenCalledOnce()
  })
})
