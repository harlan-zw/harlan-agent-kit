import type { AutoMergePolicy } from '../src/auto-merge.ts'
import type { MergeRiskRecord, RepositoryAutoMergeScope, ReviewGates } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { autoMergeDecision } from '../src/auto-merge.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []

afterEach(() => {
  stores.splice(0).forEach(store => store.close())
})

const containedScope: RepositoryAutoMergeScope = {
  _tag: 'Contained',
  labelOverridesRisk: true,
  minimumConfidence: 90,
  policy: { containedPaths: [], maximumChangedFiles: 12, maximumChangedLines: 300, requireTestChange: false, sensitivePaths: [] },
}

const policy: AutoMergePolicy = { _tag: 'Enabled', method: 'squash', minimumConfidence: 100 }

function readyGates(): ReviewGates {
  return {
    merge: { _tag: 'Passed', evidence: [{ label: 'mergeability', sha256: 'b'.repeat(64) }] },
    review: { _tag: 'Passed', evidence: [{ label: 'review', sha256: 'c'.repeat(64) }] },
    ci: { _tag: 'Passed', evidence: [{ label: 'required-ci', sha256: 'e'.repeat(64) }] },
  }
}

const containedRisk: MergeRiskRecord = {
  claim: { _tag: 'Contained' },
  combined: { _tag: 'Contained' },
  floor: { _tag: 'Contained' },
}

describe('a settlement carries the parent Review run Merge risk', () => {
  it('merges an unlabelled Contained pull request once controller gates settle', () => {
    const store = openJournalStore(':memory:')
    stores.push(store)
    store.syncRepositories([repositoryMapping({ autoMerge: containedScope })], '2026-09-16T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'settlement-merge-risk',
      observedAt: '2026-09-16T00:01:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    const review = store.claimNextAdversarialReviewTask('review-agent', '2026-09-16T00:01:30.000Z', 3_600_000)
    if (review === null)
      throw new Error('Expected the Review Task.')
    const seed = {
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      headSha: 'abc123',
      provider: 'codex' as const,
      sessionId: 'session-1',
      model: 'gpt-5.6',
      agentVersion: '1.2.3',
      skillDigest: 'f'.repeat(64),
      startedAt: '2026-09-16T00:02:00.000Z',
    }
    expect(store.recordReviewRun({
      ...seed,
      id: 'attempt-contained',
      completedAt: '2026-09-16T00:03:00.000Z',
      gates: readyGates(),
      confidence: 100,
      findings: [],
      mergeRisk: containedRisk,
    })).toEqual({ _tag: 'Inserted', reviewRunId: 'attempt-contained' })

    expect(store.supersedeReviewRun({
      ...seed,
      id: 'settlement-1',
      supersedesReviewRunId: 'attempt-contained',
      completedAt: '2026-09-16T01:00:00.000Z',
      gates: readyGates(),
      confidence: 100,
      findings: [],
      publication: {
        id: 'publication-supersede',
        body: '### 🤖 READY',
        at: '2026-09-16T00:30:00.000Z',
        result: {
          _tag: 'Published' as const,
          githubCommentId: 42,
          url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
        },
      },
    })).toEqual({ _tag: 'Inserted', reviewRunId: 'settlement-1' })

    const staged = store.stageReviewStatus({
      taskKind: 'adversarial_review',
      phase: 'terminal',
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-09-16T00:40:00.000Z',
      revisionId: observed.revisionId,
      expectedHeadSha: 'abc123',
      body: '### 🤖 READY',
      desiredOutcome: 'READY',
      reviewRunId: 'settlement-1',
      gates: readyGates(),
    })
    if (staged._tag === 'Rejected')
      throw new Error(staged.reason)
    const command = store.claimReviewStatus(staged.commandId, 'status-worker', '2026-09-16T00:41:00.000Z', 60_000)
    if (command === null)
      throw new Error('Expected the review status command.')
    expect(store.completeReviewStatus({
      commandId: command.id,
      workerId: command.workerId,
      fence: command.fence,
      at: '2026-09-16T00:50:00.000Z',
      commentId: 43,
      url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-43',
    })).toBe(true)

    const decision = autoMergeDecision({
      attempts: store.listReviewRuns('harlan-zw/example', 24),
      policy,
      pullRequest: pullRequestItem({ autoMerge: false, mergeState: 'clean' }),
      repository: repositoryMapping({ autoMerge: containedScope }),
    })
    expect(decision).toEqual({ _tag: 'Merge', headSha: 'abc123', method: 'squash', reviewRunId: 'settlement-1' })
  })
})
