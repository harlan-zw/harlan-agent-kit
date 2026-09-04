import type { ReviewGates } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []

afterEach(() => stores.splice(0).forEach(store => store.close()))

function createStore() {
  const store = openJournalStore(':memory:')
  stores.push(store)
  return store
}

function passedReviewGates(): ReviewGates {
  return {
    merge: { _tag: 'Passed', evidence: [{ label: 'mergeability', sha256: 'b'.repeat(64) }] },
    review: { _tag: 'Passed', evidence: [{ label: 'review', sha256: 'c'.repeat(64) }] },
    ci: { _tag: 'Passed', evidence: [{ label: 'required-ci', sha256: 'e'.repeat(64) }] },
  }
}

const reviewRun = {
  repository: 'harlan-zw/example',
  pullRequestNumber: 24,
  headSha: 'abc123',
  provider: 'codex' as const,
  sessionId: 'session-1',
  model: 'gpt-5.6',
  agentVersion: '1.2.3',
  skillDigest: 'f'.repeat(64),
  startedAt: '2026-08-13T01:01:00.000Z',
  completedAt: '2026-08-13T01:02:00.000Z',
}

/** The same head commit observed again after the base branch moved. */
function baseMoved(store: ReturnType<typeof openJournalStore>, at: string, overrides: Parameters<typeof pullRequestItem>[0] = {}) {
  const observed = store.recordObservation({
    externalId: `base-moved-${at}`,
    observedAt: at,
    source: 'poll',
    subject: pullRequestItem({ mergeState: 'clean', baseSha: 'base456', ...overrides }),
  })
  if (observed._tag === 'Stale' || observed._tag === 'Conflict')
    throw new Error(`Expected the moved base to be recorded, not ${observed._tag}.`)
  return observed.revisionId
}

describe('review work follows the head commit', () => {
  it('keeps a running Review when only the base branch moves', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'running-review',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    const task = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T01:00:30.000Z', 60 * 60_000)
    if (task === null)
      throw new Error('Expected the queued Review Task.')

    baseMoved(store, '2026-08-13T01:00:45.000Z')

    expect(store.heartbeatWorkerTask({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:00:50.000Z',
      leaseMilliseconds: 60 * 60_000,
    })).toBe(true)
    expect(store.recordReviewRun({
      ...reviewRun,
      id: 'run-after-base-move',
      revisionId: task.revisionId,
      gates: passedReviewGates(),
      confidence: 91,
      findings: [],
    })).toEqual({ _tag: 'Inserted', reviewRunId: 'run-after-base-move' })
    expect(store.stageReviewStatus({
      taskKind: 'adversarial_review',
      phase: 'terminal',
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:02:30.000Z',
      revisionId: task.revisionId,
      expectedHeadSha: 'abc123',
      body: '### 🤖 READY',
      desiredOutcome: 'READY',
      reviewRunId: 'run-after-base-move',
    })._tag).toBe('Staged')
    expect(store.completeReviewTask({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:03:00.000Z',
      evidence: 'run-after-base-move',
      resolution: { _tag: 'Reviewed', reviewRunId: 'run-after-base-move' },
    })).toBe(true)

    const snapshot = store.getDashboardSnapshot('2026-08-13T01:03:30.000Z')
    expect(snapshot.tasks.filter(item => item.kind === 'adversarial_review').map(item => item.state._tag)).toEqual(['Completed'])
    expect(snapshot.queue).toEqual([])
  })

  it('keeps a READY verdict refreshing after the base branch moves', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'ready-review',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    const task = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T01:00:30.000Z', 60 * 60_000)
    if (task === null)
      throw new Error('Expected the queued Review Task.')
    store.recordReviewRun({
      ...reviewRun,
      id: 'ready-run',
      revisionId: observed.revisionId,
      gates: passedReviewGates(),
      confidence: 91,
      findings: [],
    })
    store.completeReviewTask({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:02:30.000Z',
      evidence: 'ready-run',
      resolution: { _tag: 'Reviewed', reviewRunId: 'ready-run' },
    })
    store.recordReviewPublication({
      id: 'ready-publication',
      reviewRunId: 'ready-run',
      body: '### 🤖 READY',
      at: '2026-08-13T01:03:00.000Z',
      result: { _tag: 'Published', githubCommentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' },
    })
    expect(store.listReviewGateRefreshes()).toHaveLength(1)

    const movedRevisionId = baseMoved(store, '2026-08-13T02:00:00.000Z')

    expect(store.listReviewGateRefreshes()).toEqual([expect.objectContaining({
      reviewRunId: 'ready-run',
      revisionId: movedRevisionId,
      headSha: 'abc123',
      commentId: 42,
    })])
    const snapshot = store.getDashboardSnapshot('2026-08-13T02:00:30.000Z')
    expect(snapshot.tasks.filter(item => item.kind === 'adversarial_review').map(item => item.state._tag)).toEqual(['Completed'])
    expect(snapshot.queue).toEqual([])
  })

  it('keeps a Repair and its findings after the base branch moves', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'blocked-review',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    const review = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T01:00:30.000Z', 60 * 60_000)
    if (review === null)
      throw new Error('Expected the queued Review Task.')
    const gates = passedReviewGates()
    gates.review = { _tag: 'Failed', reason: 'Unsafe input reached a command boundary.', evidence: [] }
    store.recordReviewRun({
      ...reviewRun,
      id: 'blocked-run',
      revisionId: observed.revisionId,
      gates,
      findings: [{ _tag: 'Open', summary: 'Unsafe command input.', nextAction: 'Apply the guarded fix.' }],
    })
    const queued = store.queueReviewFixTaskForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:03:00.000Z',
    })
    if (queued._tag !== 'Queued')
      throw new Error(`Expected the Repair Task, not ${queued._tag}.`)
    const repair = store.claimNextReviewFixTask('repair-1', '2026-08-13T01:03:30.000Z', 60 * 60_000)
    if (repair === null)
      throw new Error('Expected the queued Repair Task.')

    baseMoved(store, '2026-08-13T01:04:00.000Z')

    expect(store.getReviewFixFindings('harlan-zw/example', 24, repair.revisionId)).toEqual([
      { _tag: 'Open', summary: 'Unsafe command input.', nextAction: 'Apply the guarded fix.' },
    ])
    const snapshot = store.getDashboardSnapshot('2026-08-13T01:04:30.000Z')
    expect(snapshot.tasks.find(item => item.id === repair.id)?.state._tag).toBe('Running')
  })

  it('leaves one Review Task when mergeability flaps after the base branch moves', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'flapping-review',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    const task = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T01:00:30.000Z', 60 * 60_000)
    if (task === null)
      throw new Error('Expected the queued Review Task.')
    store.recordReviewRun({
      ...reviewRun,
      id: 'flapping-run',
      revisionId: observed.revisionId,
      gates: passedReviewGates(),
      confidence: 91,
      findings: [],
    })
    store.completeReviewTask({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:02:30.000Z',
      evidence: 'flapping-run',
      resolution: { _tag: 'Reviewed', reviewRunId: 'flapping-run' },
    })

    baseMoved(store, '2026-08-13T02:00:00.000Z')
    baseMoved(store, '2026-08-13T02:01:00.000Z', { mergeState: 'unknown' })
    baseMoved(store, '2026-08-13T02:02:00.000Z')

    const snapshot = store.getDashboardSnapshot('2026-08-13T02:03:00.000Z')
    expect(snapshot.tasks.filter(item => item.kind === 'adversarial_review').map(item => item.state._tag)).toEqual(['Completed'])
    expect(snapshot.queue).toEqual([])
  })
})
