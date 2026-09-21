import type { ReviewGates } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []

afterEach(() => stores.splice(0).forEach(store => store.close()))

function passedGates(): ReviewGates {
  return {
    merge: { _tag: 'Passed', evidence: [{ label: 'mergeability', sha256: 'b'.repeat(64) }] },
    review: { _tag: 'Passed', evidence: [{ label: 'review', sha256: 'c'.repeat(64) }] },
    ci: { _tag: 'Passed', evidence: [{ label: 'required-ci', sha256: 'e'.repeat(64) }] },
  }
}

function reviewAt(effort: 'low' | undefined) {
  const store = openJournalStore(':memory:')
  stores.push(store)
  store.syncRepositories([repositoryMapping()], '2026-09-22T00:00:00.000Z')
  const observed = store.recordObservation({
    externalId: 'dashboard-reasoning-effort',
    observedAt: '2026-09-22T00:01:00.000Z',
    source: 'poll',
    subject: pullRequestItem({ mergeState: 'clean' }),
  })
  if (observed._tag !== 'Inserted')
    throw new Error('Expected the pull request revision.')
  const task = store.claimNextAdversarialReviewTask('reviewer-1', '2026-09-22T00:01:30.000Z', 3_600_000)
  if (task === null)
    throw new Error('Expected the Review Task.')
  store.recordReviewRun({
    id: 'attempt-banded',
    repository: 'harlan-zw/example',
    pullRequestNumber: 24,
    revisionId: observed.revisionId,
    headSha: 'abc123',
    provider: 'codex',
    sessionId: 'session-1',
    model: 'gpt-5.6-sol',
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    agentVersion: '1.2.3',
    skillDigest: 'f'.repeat(64),
    startedAt: '2026-09-22T00:02:00.000Z',
    completedAt: '2026-09-22T00:03:00.000Z',
    gates: passedGates(),
    confidence: 100,
    findings: [],
  })
  store.completeReviewTask({
    taskId: task.id,
    workerId: task.state.workerId,
    fence: task.state.fence,
    at: '2026-09-22T00:03:30.000Z',
    evidence: 'attempt-banded',
    resolution: { _tag: 'Reviewed', reviewRunId: 'attempt-banded' },
  })
  return store.getDashboardSnapshot('2026-09-22T00:04:00.000Z').agents.find(candidate => candidate._tag === 'ReviewAgent' && candidate.id === 'attempt-banded')
}

describe('the Reasoning effort a Review answered at stays visible', () => {
  it('reaches the dashboard agents payload', () => {
    expect(reviewAt('low')).toMatchObject({ reasoningEffort: 'low' })
  })

  it('reads as absent for a run recorded without one', () => {
    expect(reviewAt(undefined)).toMatchObject({ reasoningEffort: null })
  })
})
