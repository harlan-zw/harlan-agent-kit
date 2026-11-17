import type { GitHubPullRequestItem, ReviewGates } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

type Store = ReturnType<typeof openJournalStore>

const stores: Store[] = []
const at = (seconds: number) => new Date(Date.parse('2026-10-07T00:00:00.000Z') + seconds * 1000).toISOString()

afterEach(() => {
  stores.splice(0).forEach(store => store.close())
})

function setup(actionRequiredOnce: boolean, mapping = repositoryMapping({ pullRequestReview: false })): Store {
  const store = openJournalStore(':memory:', false, undefined, undefined, undefined, undefined, actionRequiredOnce)
  stores.push(store)
  store.syncRepositories([mapping], at(0))
  return store
}

function observe(store: Store, seconds: number, overrides: Partial<GitHubPullRequestItem> = {}) {
  return store.recordObservation({ externalId: `once:${seconds}`, observedAt: at(seconds), source: 'poll', subject: pullRequestItem(overrides) })
}

const claimConflict = (store: Store, seconds: number) => store.claimNextConflictTask('agent', at(seconds), 60_000)
const heldEvents = (store: Store) => store.listWorkflowEvents({ stream: 'task' }).filter(event => event.event === 'RepeatHeld')

function blockConflict(store: Store, reason: string) {
  observe(store, 0)
  const task = claimConflict(store, 0)
  if (task === null)
    throw new Error('Expected the conflict resolution Task.')
  expect(store.needsAttentionTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: at(1), reason, evidence: 'local fixture' })).toBe(true)
  return task
}

describe('action_required_once for conflict resolution', () => {
  it('holds an Agent blocker when the same pull request state returns', () => {
    const store = setup(true)
    const reason = 'Duplicate ADR-0023 fails validation.'
    const task = blockConflict(store, reason)

    observe(store, 10, { draft: true })
    observe(store, 20)
    observe(store, 30)

    expect(claimConflict(store, 400)).toBeNull()
    expect(store.getDashboardSnapshot(at(400)).tasks.filter(value => value.kind === 'resolve_conflict').map(value => [value.id, value.state]))
      .toEqual([[task.id, { _tag: 'ActionRequired', reason }]])
    expect(heldEvents(store).map(event => [event.taskId, event.from, event.to, event.reason])).toEqual([[task.id, 'Superseded', 'ActionRequired', reason]])
  })

  it('starts a held Task again on the next base move', () => {
    const store = setup(true)
    blockConflict(store, 'Verification failed.')

    observe(store, 10, { draft: true })
    observe(store, 20)
    expect(claimConflict(store, 21)).toBeNull()

    observe(store, 30, { baseSha: 'base2' })
    expect(claimConflict(store, 400)?.pullRequest.baseSha).toBe('base2')
  })

  it('starts again once the head commit changes', () => {
    const store = setup(true)
    blockConflict(store, 'Verification failed.')

    observe(store, 10, { draft: true })
    observe(store, 20, { headSha: 'new-head' })

    expect(claimConflict(store, 21)?.pullRequest.headSha).toBe('new-head')
    expect(heldEvents(store)).toEqual([])
  })

  it('starts again when the base commit moved after the blocker', () => {
    const store = setup(true)
    blockConflict(store, 'Verification failed.')

    observe(store, 10, { baseSha: 'base2' })
    observe(store, 20, { baseSha: 'base2', draft: true })
    observe(store, 30, { baseSha: 'base2' })

    expect(claimConflict(store, 400)?.pullRequest.baseSha).toBe('base2')
    expect(heldEvents(store)).toEqual([])
  })

  it('keeps the draft round trip restart while the flag is off', () => {
    const store = setup(false)
    const task = blockConflict(store, 'Verification failed.')

    observe(store, 10, { draft: true })
    observe(store, 20)

    expect(claimConflict(store, 21)?.id).toBe(task.id)
    expect(heldEvents(store)).toEqual([])
  })
})

function passedGates(): ReviewGates {
  return {
    merge: { _tag: 'Passed', evidence: [{ label: 'mergeability', sha256: 'b'.repeat(64) }] },
    review: { _tag: 'Failed', reason: 'A material finding remains.', evidence: [] },
    ci: { _tag: 'Passed', evidence: [{ label: 'required-ci', sha256: 'e'.repeat(64) }] },
  }
}

function recordFinding(store: Store, runId: string, revisionId: string, headSha: string, fingerprint: string, completedAt: string): void {
  const recorded = store.recordReviewRun({
    id: runId,
    repository: 'harlan-zw/example',
    pullRequestNumber: 24,
    revisionId,
    headSha,
    provider: 'codex',
    sessionId: `${runId}-session`,
    model: 'gpt-5.6',
    agentVersion: '1.2.3',
    skillDigest: 'f'.repeat(64),
    startedAt: completedAt,
    completedAt,
    gates: passedGates(),
    findings: [{
      _tag: 'Open',
      summary: 'Unsafe parser input.',
      nextAction: 'Parse input before use.',
      resolution: 'Repair',
      details: {
        fingerprint,
        identity: fingerprint,
        location: { path: 'src/parser.ts', line: 42 },
        proof: 'Malformed input reaches the unsafe parser branch.',
        regressionTest: 'Pass malformed input and assert a tagged rejection.',
      },
    }],
  })
  if (recorded._tag !== 'Inserted')
    throw new Error(`Expected a new Review run, got ${recorded._tag}.`)
}

/** Blocks one Repair, then runs a fresh Review of the same head commit up to its Repair handoff. */
function blockedRepairThenFreshReview(actionRequiredOnce: boolean, freshFingerprint: string, rerunSource: 'dashboard' | 'repair_dispute' = 'dashboard') {
  const store = setup(actionRequiredOnce, repositoryMapping())
  const observed = store.recordObservation({
    externalId: 'once-repair',
    observedAt: '2026-08-13T01:00:00.000Z',
    source: 'poll',
    subject: pullRequestItem({ headRef: 'fix/blocked-repair', mergeState: 'clean' }),
  })
  if (observed._tag !== 'Inserted')
    throw new Error('Expected a new pull request revision.')
  const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:00:01.000Z', 600_000)
  if (review === null)
    throw new Error('Expected the Review Task.')
  recordFinding(store, 'first-review', observed.revisionId, review.pullRequest.headSha, 'a'.repeat(64), '2026-08-13T01:00:03.000Z')
  const queued = store.queueReviewFixTaskForReview({ taskId: review.id, workerId: review.state.workerId, fence: review.state.fence, at: '2026-08-13T01:00:04.000Z' })
  if (queued._tag !== 'Queued')
    throw new Error(queued.reason)
  const repair = store.claimNextReviewFixTask('repair-agent', '2026-08-13T01:00:05.000Z', 60_000)
  if (repair === null)
    throw new Error('Expected the Repair Task.')
  const reason = 'The Repair Agent found unsafe scope.'
  expect(store.needsAttentionTask({ taskId: repair.id, workerId: repair.state.workerId, fence: repair.state.fence, at: '2026-08-13T01:00:09.000Z', reason, evidence: 'blocked' })).toBe(true)
  expect(store.completeWorkerTask({ taskId: review.id, workerId: review.state.workerId, fence: review.state.fence, at: '2026-08-13T01:00:09.100Z', evidence: 'Queued Repair.' })).toBe(true)
  expect(store.requestReviewRerun({
    repository: review.repository,
    pullRequestNumber: review.pullRequestNumber,
    revisionId: observed.revisionId,
    requestId: 'fresh-review',
    source: rerunSource,
    requestedBy: 'harlan-zw',
    at: '2026-08-13T01:00:09.500Z',
  })._tag).toBe('Queued')
  const fresh = store.claimNextAdversarialReviewTask('fresh-review-agent', '2026-08-13T01:00:10.000Z', 600_000)
  if (fresh === null)
    throw new Error('Expected the fresh Review Task.')
  recordFinding(store, 'fresh-review', observed.revisionId, fresh.pullRequest.headSha, freshFingerprint, '2026-08-13T01:00:11.000Z')
  const handoff = store.queueReviewFixTaskForReview({ taskId: fresh.id, workerId: fresh.state.workerId, fence: fresh.state.fence, at: '2026-08-13T01:00:12.000Z' })
  const handoffAgain = () => store.queueReviewFixTaskForReview({ taskId: fresh.id, workerId: fresh.state.workerId, fence: fresh.state.fence, at: '2026-08-13T01:00:13.000Z' })
  return { store, repair, reason, handoff, handoffAgain }
}

describe('action_required_once for Repair', () => {
  it('holds a blocked Repair when a fresh Review reports the same findings', () => {
    const { store, repair, reason, handoff, handoffAgain } = blockedRepairThenFreshReview(true, 'a'.repeat(64))

    expect(handoff).toEqual({ _tag: 'ActionRequired', reason })
    expect(handoffAgain()).toEqual({ _tag: 'ActionRequired', reason })
    expect(store.claimNextReviewFixTask('repair-agent', '2026-08-13T01:10:00.000Z', 60_000)).toBeNull()
    expect(heldEvents(store).map(event => [event.taskId, event.to, event.reason])).toEqual([[repair.id, 'ActionRequired', reason]])
    expect(store.listStoppedReviews()).toEqual([])
  })

  // A Repair dispute asks the fresh Review to judge the finding again, so its answer is new input.
  it('starts Repair again after a dispute Review upholds the same finding', () => {
    const { store, repair, handoff } = blockedRepairThenFreshReview(true, 'a'.repeat(64), 'repair_dispute')

    expect(handoff._tag).toBe('Queued')
    expect(store.claimNextReviewFixTask('repair-agent', '2026-08-13T01:10:00.000Z', 60_000)?.id).toBe(repair.id)
    expect(heldEvents(store)).toEqual([])
  })

  // The head CI finding is appended to a stored Review run, so the same run can carry new input.
  it('starts Repair again when a CI finding joins the Review it stopped on', () => {
    const store = setup(true, repositoryMapping())
    const observed = store.recordObservation({
      externalId: 'once-ci-finding',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ headRef: 'fix/ci-finding', mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:00:01.000Z', 600_000)
    if (review === null)
      throw new Error('Expected the Review Task.')
    recordFinding(store, 'ci-review', observed.revisionId, review.pullRequest.headSha, 'a'.repeat(64), '2026-08-13T01:00:03.000Z')
    const handoff = (at: string) => store.queueReviewFixTaskForReview({ taskId: review.id, workerId: review.state.workerId, fence: review.state.fence, at })
    expect(handoff('2026-08-13T01:00:04.000Z')._tag).toBe('Queued')
    const repair = store.claimNextReviewFixTask('repair-agent', '2026-08-13T01:00:05.000Z', 60_000)
    if (repair === null)
      throw new Error('Expected the Repair Task.')
    expect(store.needsAttentionTask({ taskId: repair.id, workerId: repair.state.workerId, fence: repair.state.fence, at: '2026-08-13T01:00:06.000Z', reason: 'Blocked.', evidence: 'blocked' })).toBe(true)

    expect(store.recordCiRepairFinding({
      reviewRunId: 'ci-review',
      finding: {
        _tag: 'Open',
        summary: 'Head CI fails.',
        nextAction: 'Fix the failing check.',
        resolution: 'Repair',
        details: { fingerprint: 'c'.repeat(64), identity: 'head-ci', location: { path: '.github/workflows/test.yml', line: null }, proof: 'The test job failed.', regressionTest: null },
      },
    })).toBe(true)

    expect(handoff('2026-08-13T01:00:10.000Z')._tag).toBe('Queued')
    expect(heldEvents(store)).toEqual([])
  })

  it('starts Repair again when a fresh Review reports a different finding', () => {
    const { store, repair, handoff } = blockedRepairThenFreshReview(true, 'b'.repeat(64))

    expect(handoff._tag).toBe('Queued')
    expect(store.claimNextReviewFixTask('repair-agent', '2026-08-13T01:10:00.000Z', 60_000)?.id).toBe(repair.id)
    expect(heldEvents(store)).toEqual([])
  })

  it('starts Repair again for the same findings while the flag is off', () => {
    const { store, repair, handoff } = blockedRepairThenFreshReview(false, 'a'.repeat(64))

    expect(handoff._tag).toBe('Queued')
    expect(store.claimNextReviewFixTask('repair-agent', '2026-08-13T01:10:00.000Z', 60_000)?.id).toBe(repair.id)
    expect(heldEvents(store)).toEqual([])
  })
})
