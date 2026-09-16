import type { MergeRiskRecord, RepositoryAutoMergeScope, ReviewGates } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { terminalComment } from '../src/item-agent.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []

afterEach(() => stores.splice(0).forEach(store => store.close()))

const containedScope: RepositoryAutoMergeScope = {
  _tag: 'Contained',
  labelOverridesRisk: true,
  minimumConfidence: 90,
  policy: { containedPaths: [], maximumChangedFiles: 12, maximumChangedLines: 300, requireTestChange: false, sensitivePaths: [] },
}

function passedGates(): ReviewGates {
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

function reviewWithVerdict(store: ReturnType<typeof openJournalStore>): void {
  store.syncRepositories([repositoryMapping({ autoMerge: containedScope })], '2026-09-16T00:00:00.000Z')
  const observed = store.recordObservation({
    externalId: 'dashboard-merge-risk',
    observedAt: '2026-09-16T00:01:00.000Z',
    source: 'poll',
    subject: pullRequestItem({ mergeState: 'clean' }),
  })
  if (observed._tag !== 'Inserted')
    throw new Error('Expected the pull request revision.')
  const task = store.claimNextAdversarialReviewTask('reviewer-1', '2026-09-16T00:01:30.000Z', 3_600_000)
  if (task === null)
    throw new Error('Expected the Review Task.')
  store.recordReviewRun({
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
    gates: passedGates(),
    confidence: 100,
    findings: [],
    mergeRisk: containedRisk,
  })
  store.completeReviewTask({
    taskId: task.id,
    workerId: task.state.workerId,
    fence: task.state.fence,
    at: '2026-09-16T00:03:30.000Z',
    evidence: 'attempt-contained',
    resolution: { _tag: 'Reviewed', reviewRunId: 'attempt-contained' },
  })
}

describe('a recorded Merge risk verdict stays visible', () => {
  it('reaches the dashboard agents payload', () => {
    const store = openJournalStore(':memory:')
    stores.push(store)
    reviewWithVerdict(store)

    const agent = store.getDashboardSnapshot('2026-09-16T00:04:00.000Z').agents.find(candidate => candidate._tag === 'ReviewAgent' && candidate.id === 'attempt-contained')
    expect(agent).toMatchObject({ mergeRisk: containedRisk })
  })

  it('carries a describeMergeRisk line beside the gate lines in the published body', () => {
    const body = terminalComment('abc123', 'base123', passedGates(), [], 100, [], containedRisk.combined)
    expect(body).toContain('- **Merge risk:** Contained')
  })
})
