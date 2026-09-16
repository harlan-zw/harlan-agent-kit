import type { AutoMergePolicy } from '../src/auto-merge.ts'
import type { MergeRiskRecord, RepositoryAutoMergeScope, ReviewGates } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { autoMergeDecision } from '../src/auto-merge.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []

afterEach(() => stores.splice(0).forEach(store => store.close()))

const looseScope: RepositoryAutoMergeScope = {
  _tag: 'Contained',
  labelOverridesRisk: true,
  minimumConfidence: 90,
  policy: { containedPaths: [], maximumChangedFiles: 12, maximumChangedLines: 300, requireTestChange: false, sensitivePaths: [] },
}
const tightScope: RepositoryAutoMergeScope = {
  ...looseScope,
  policy: { ...looseScope.policy, maximumChangedFiles: 3 },
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

describe('a Contained verdict recorded under one policy', () => {
  it('stops merging once the repository tightens that policy', () => {
    const store = openJournalStore(':memory:')
    stores.push(store)
    store.syncRepositories([repositoryMapping({ autoMerge: looseScope })], '2026-09-16T00:00:00.000Z')
    store.setRepositoryWritesEnabled('harlan-zw/example', true)
    const observed = store.recordObservation({
      externalId: 'policy-change-merge-risk',
      observedAt: '2026-09-16T00:01:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected the pull request revision.')
    const task = store.claimNextAdversarialReviewTask('reviewer-1', '2026-09-16T00:01:30.000Z', 3_600_000)
    if (task === null)
      throw new Error('Expected the Review Task.')
    expect(store.recordReviewRun({
      id: 'attempt-contained',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      headSha: 'abc123',
      provider: 'codex',
      sessionId: 'session-1',
      model: 'gpt-5.6',
      agentVersion: '1.2.3',
      skillDigest: 'f'.repeat(64),
      startedAt: '2026-09-16T00:02:00.000Z',
      completedAt: '2026-09-16T00:03:00.000Z',
      gates: readyGates(),
      confidence: 100,
      findings: [],
      mergeRisk: containedRisk,
    })).toEqual({ _tag: 'Inserted', reviewRunId: 'attempt-contained' })
    store.completeReviewTask({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-09-16T00:03:30.000Z',
      evidence: 'attempt-contained',
      resolution: { _tag: 'Reviewed', reviewRunId: 'attempt-contained' },
    })
    const staged = store.stageReviewGateStatus({
      reviewRunId: 'attempt-contained',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      expectedHeadSha: 'abc123',
      gates: readyGates(),
      body: '### 🤖 READY',
      desiredOutcome: 'READY',
      at: '2026-09-16T00:04:00.000Z',
    })
    if (staged._tag === 'Rejected')
      throw new Error(staged.reason)
    const command = store.claimNextTerminalReviewStatus('publisher', '2026-09-16T00:04:00.000Z', 60_000)
    if (command === null)
      throw new Error('Expected the review status command.')
    expect(store.completeReviewStatus({
      commandId: command.id,
      workerId: command.workerId,
      fence: command.fence,
      at: '2026-09-16T00:04:30.000Z',
      commentId: 42,
      url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
    })).toBe(true)

    const decide = () => autoMergeDecision({
      attempts: store.listReviewRuns('harlan-zw/example', 24),
      policy,
      pullRequest: pullRequestItem({ mergeState: 'clean' }),
      repository: repositoryMapping({ autoMerge: looseScope }),
    })
    expect(decide()._tag).toBe('Merge')

    store.syncRepositories([repositoryMapping({ autoMerge: tightScope })], '2026-09-16T00:10:00.000Z')

    expect(store.storedReviewForHead('harlan-zw/example', 24, 'abc123')._tag).toBe('Stale')
    const decision = decide()
    expect(decision._tag).toBe('Hold')
    if (decision._tag === 'Hold')
      expect(decision.reason).toContain('no published READY review')
  })
})
