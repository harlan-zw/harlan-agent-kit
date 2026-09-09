import type { ReviewGates } from '../src/types.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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

function recordRetryingReview(store: ReturnType<typeof openJournalStore>) {
  const repository = repositoryMapping()
  store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
  store.setRepositoryWritesEnabled(repository.github, true)
  store.recordObservation({ externalId: 'original', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject: pullRequestItem({ mergeState: 'clean' }) })
  const task = store.claimNextAdversarialReviewTask('reviewer', '2026-08-13T01:00:30.000Z', 60 * 60_000)!
  expect(store.recordReviewRun({ ...reviewRun, id: 'retained-review', revisionId: task.revisionId, gates: passedReviewGates(), confidence: 96, findings: [] })._tag).toBe('Inserted')
  store.recordReviewPublication({ id: 'legacy-publication', reviewRunId: 'retained-review', body: '### READY', at: '2026-08-13T01:03:00.000Z', result: { _tag: 'Published', githubCommentId: 42, url: 'url' } })
  expect(store.failWorkerTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: '2026-08-13T01:04:00.000Z', reason: 'GitHub request timed out.' })).toBe('Retrying')
  return task
}

function retainedGateInput(store: ReturnType<typeof openJournalStore>) {
  baseMoved(store, '2026-08-13T02:00:00.000Z', { mergeState: 'conflicting' })
  const revisionId = baseMoved(store, '2026-08-13T02:01:00.000Z', { baseSha: 'base789' })
  return { reviewRunId: 'retained-review', repository: 'harlan-zw/example', pullRequestNumber: 24, revisionId, expectedHeadSha: 'abc123', gates: passedReviewGates(), body: '### READY', desiredOutcome: 'READY' as const, at: '2026-08-13T02:02:00.000Z' }
}

describe('review work follows the head commit', () => {
  it('publishes retained Review gates after a retrying worker is superseded by base changes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'retained-review-publication-'))
    const path = join(directory, 'journal.sqlite')
    const store = openJournalStore(path, true)
    const repository = repositoryMapping()
    try {
      const task = recordRetryingReview(store)

      const input = retainedGateInput(store)
      expect(store.getDashboardSnapshot('2026-08-13T02:01:01.000Z').tasks.find(candidate => candidate.id === task.id)?.state._tag).toBe('Superseded')
      expect(store.listReviewGateRefreshes()).toEqual([expect.objectContaining({ reviewRunId: 'retained-review', revisionId: input.revisionId, gatePublication: { _tag: 'Unpublished' } })])
      const staged = store.stageReviewGateStatus(input)
      expect(staged._tag).toBe('Staged')
      const publication = store.claimNextTerminalReviewStatus('publisher', '2026-08-13T02:02:00.000Z', 60_000)!
      expect(publication).not.toBeNull()
      expect(store.claimNextTerminalReviewStatus('another-publisher', '2026-08-13T02:02:30.000Z', 60_000)).toBeNull()
      expect(store.stageReviewGateStatus({ ...input, at: '2026-08-13T02:03:00.000Z' })).toEqual({ _tag: 'Duplicate', commandId: publication.id })
      const recovered = store.claimNextTerminalReviewStatus('another-publisher', '2026-08-13T02:03:00.000Z', 60_000)!
      expect(recovered).not.toBeNull()
      expect(recovered).toMatchObject({ id: publication.id, outcomeUnknown: true, fence: publication.fence + 1 })
      expect(store.completeReviewStatus({ commandId: publication.id, workerId: publication.workerId, fence: publication.fence, at: '2026-08-13T02:03:01.000Z', commentId: 42, url: 'url' })).toBe(false)
      expect(store.completeReviewStatus({ commandId: recovered.id, workerId: recovered.workerId, fence: recovered.fence, at: '2026-08-13T02:03:02.000Z', commentId: 42, url: 'url' })).toBe(true)

      const reopened = openJournalStore(path, true)
      try {
        expect(reopened.storedReviewForHead(repository.github, 24, 'abc123')).toMatchObject({ _tag: 'Current', run: { id: 'retained-review', gatePublication: { _tag: 'Published', publicationId: publication.id } } })
        expect(reopened.listReviewRuns(repository.github, 24)).toEqual([expect.objectContaining({ id: 'retained-review', startedAt: reviewRun.startedAt, completedAt: reviewRun.completedAt })])
        expect(reopened.claimNextAdversarialReviewTask('another-reviewer', '2026-08-13T02:03:00.000Z', 60_000)).toBeNull()
      }
      finally {
        reopened.close()
      }
    }
    finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects retained gate staging after explicit Cancel', () => {
    const store = createStore()
    const task = recordRetryingReview(store)
    expect(store.cancelTask({ taskId: task.id, at: '2026-08-13T01:05:00.000Z' })._tag).toBe('Cancelled')
    const input = retainedGateInput(store)
    expect(store.listReviewGateRefreshes()).toEqual([])
    expect(store.stageReviewGateStatus(input)._tag).toBe('Rejected')
    expect(store.claimNextTerminalReviewStatus('publisher', input.at, 60_000)).toBeNull()
  })

  describe.each(['Pending', 'Running'] as const)('retained gate Publication while %s', (state) => {
    it.each(['head', 'target', 'policy', 'Dismissal', 'writes', 'Pause', 'closed', 'active Review', 'newer Review'] as const)('rejects authority lost through %s', (change) => {
      const store = openJournalStore(':memory:', true)
      stores.push(store)
      recordRetryingReview(store)
      const input = retainedGateInput(store)
      const staged = store.stageReviewGateStatus(input)
      if (staged._tag !== 'Staged')
        throw new Error('Expected staged retained gates.')
      const publication = state === 'Running' ? store.claimNextTerminalReviewStatus('publisher', input.at, 60_000)! : null
      if (state === 'Running')
        expect(publication).not.toBeNull()
      const at = '2026-08-13T02:02:01.000Z'
      switch (change) {
        case 'head':
          baseMoved(store, at, { headSha: 'new-head', baseSha: 'base789' })
          break
        case 'target':
          baseMoved(store, at, { baseRef: 'another-target', baseSha: 'base789' })
          break
        case 'closed':
          baseMoved(store, at, { state: 'closed', baseSha: 'base789' })
          break
        case 'policy':
          store.syncRepositories([repositoryMapping({ writablePullRequestHeadPrefixes: ['different/'] })], at)
          break
        case 'Dismissal':
          store.dismissItem({ repository: input.repository, itemNumber: 24, at })
          break
        case 'writes':
          store.setRepositoryWritesEnabled(input.repository, false)
          break
        case 'Pause':
          store.setRepositoryPaused(input.repository, true)
          break
        case 'active Review':
          store.requestReviewRerun({ repository: input.repository, pullRequestNumber: 24, revisionId: input.revisionId, requestId: 'rerun', source: 'dashboard', requestedBy: 'harlan-zw', at })
          expect(store.claimNextAdversarialReviewTask('new-reviewer', at, 60_000)).not.toBeNull()
          break
        case 'newer Review':
          expect(store.recordReviewRun({ ...reviewRun, id: 'newer-review', revisionId: input.revisionId, completedAt: at, gates: passedReviewGates(), confidence: 97, findings: [] })._tag).toBe('Inserted')
          break
      }
      if (publication === null) {
        expect(store.claimReviewStatus(staged.commandId, 'publisher', at, 60_000)).toBeNull()
        expect(store.claimNextTerminalReviewStatus('publisher', at, 60_000)).toBeNull()
      }
      else {
        expect(store.completeReviewStatus({ commandId: publication.id, workerId: publication.workerId, fence: publication.fence, at, commentId: 42, url: 'url' })).toBe(false)
        expect(store.claimNextTerminalReviewStatus('replacement-publisher', '2026-08-13T02:03:00.000Z', 60_000)).toBeNull()
        expect(store.completeReviewStatus({ commandId: publication.id, workerId: publication.workerId, fence: publication.fence, at: '2026-08-13T02:03:01.000Z', commentId: 42, url: 'url' })).toBe(false)
      }
      expect(store.listReviewRuns(input.repository, 24).find(run => run.id === input.reviewRunId)?.gatePublication).toEqual({ _tag: 'Unpublished' })
    })
  })

  it('refreshes retained Review evidence on the current base without changing its provenance', () => {
    const directory = mkdtempSync(join(tmpdir(), 'review-gate-delivery-'))
    const path = join(directory, 'journal.sqlite')
    const before = openJournalStore(path)
    const repository = repositoryMapping()
    before.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    before.recordObservation({ externalId: 'original', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject: pullRequestItem({ mergeState: 'clean' }) })
    const task = before.claimNextAdversarialReviewTask('worker', '2026-08-13T01:00:00.000Z', 60 * 60_000)!
    before.recordReviewRun({ ...reviewRun, id: 'retained-review', revisionId: task.revisionId, gates: passedReviewGates(), confidence: 96, findings: [] })
    before.completeReviewTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: '2026-08-13T01:03:00.000Z', evidence: 'retained-review', resolution: { _tag: 'Reviewed', reviewRunId: 'retained-review' } })
    before.recordReviewPublication({ id: 'original-publication', reviewRunId: 'retained-review', body: '### READY', at: '2026-08-13T01:04:00.000Z', result: { _tag: 'Published', githubCommentId: 42, url: 'url' } })
    const currentRevision = baseMoved(before, '2026-08-13T02:00:00.000Z')
    before.close()

    // Historical journals can retain the Review's original Revision after a later base observation.
    const legacy = new DatabaseSync(path)
    legacy.prepare('UPDATE review_runs SET revision_id = ? WHERE id = ?').run(task.revisionId, 'retained-review')
    legacy.exec('ALTER TABLE review_gate_projections DROP COLUMN command_id; PRAGMA user_version = 69;')
    legacy.close()
    const store = openJournalStore(path)
    try {
      expect(store.listReviewRuns(repository.github, 24)[0]?.gatePublication).toEqual({ _tag: 'Unpublished' })
      expect(store.listReviewGateRefreshes()).toEqual([expect.objectContaining({ reviewRunId: 'retained-review', revisionId: currentRevision, baseRef: 'main' })])
      const staged = store.stageReviewGateStatus({ reviewRunId: 'retained-review', repository: repository.github, pullRequestNumber: 24, revisionId: currentRevision, expectedHeadSha: 'abc123', gates: passedReviewGates(), body: '### READY', desiredOutcome: 'READY', at: '2026-08-13T02:01:00.000Z' })
      expect(staged._tag).toBe('Staged')
      const publication = store.claimNextTerminalReviewStatus('publisher', '2026-08-13T02:01:00.000Z', 60_000)!
      expect(publication).not.toBeNull()
      expect(store.completeReviewStatus({ commandId: publication.id, workerId: publication.workerId, fence: publication.fence, at: '2026-08-13T02:01:01.000Z', commentId: 42, url: 'url' })).toBe(true)
      expect(store.listReviewRuns(repository.github, 24)[0]).toMatchObject({ revisionId: task.revisionId, startedAt: reviewRun.startedAt, completedAt: reviewRun.completedAt, gatePublication: { _tag: 'Published', publicationId: publication.id } })
      const reopened = openJournalStore(path)
      try {
        expect(reopened.listReviewRuns(repository.github, 24)[0]?.gatePublication).toEqual({ _tag: 'Published', publicationId: publication.id })
      }
      finally {
        reopened.close()
      }
    }
    finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

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
