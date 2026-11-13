import type { GitHubChecksSnapshot } from '../src/github-agent-source.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { retireObsoleteBaselineRepairs } from '../src/baseline-repair-sweep.ts'
import { ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
afterEach(() => stores.splice(0).forEach(store => store.close()))
const at = (second: number) => new Date(Date.parse('2026-11-12T10:00:00Z') + second * 1000).toISOString()
const failing: GitHubChecksSnapshot = { _tag: 'Available', checks: [{ id: 1, name: 'reconcile', conclusion: 'failure', status: 'completed', failure: { _tag: 'NotAsked' }, source: { _tag: 'CheckRun', appId: 15368 } }] }
const reason = 'Cause unknown. The private journal download returns HTTP 404.'

/** One Review of #24 waits on the Baseline repair for the red base commit. */
function waitingReview() {
  const store = openJournalStore(':memory:', true)
  stores.push(store)
  const mapping = repositoryMapping()
  store.syncRepositories([mapping], at(0))
  store.setRepositoryWritesEnabled(mapping.github, true)
  store.recordObservation({ externalId: 'pr-24', observedAt: at(1), source: 'poll', subject: pullRequestItem({ number: 24, baseSha: 'red-base', mergeState: 'clean' }) })
  const review = store.claimNextAdversarialReviewTask('reviewer', at(2), 600_000)!
  const queued = store.queueBaselineRepairForReview({ taskId: review.id, workerId: 'reviewer', fence: review.state.fence, baseSha: 'red-base', at: at(3) })
  if (queued._tag !== 'Queued')
    throw new Error('Expected a queued Baseline repair.')
  const repair = store.claimNextBaselineRepairTask('baseline', at(4), 600_000)!
  expect(store.completeReviewTask({ taskId: review.id, workerId: 'reviewer', fence: review.state.fence, at: at(5), evidence: 'Waiting for Baseline repair.', resolution: { _tag: 'WaitingForBaselineRepair', taskId: repair.id } })).toBe(true)
  return { store, mapping, review, repair }
}

describe('a Baseline repair that ends without a repair', () => {
  it('raises a named Incident and releases the waiting Review when it needs a person', () => {
    const { store, review, repair } = waitingReview()

    expect(store.needsAttentionTask({ taskId: repair.id, workerId: 'baseline', fence: repair.state.fence, at: at(6), reason, evidence: 'Repair confidence: 0/100.' })).toBe(true)

    expect(store.listIncidents()).toEqual([expect.objectContaining({
      kind: 'baseline_repair_action_required',
      operation: 'baseline_repair',
      scope: { _tag: 'Task', taskId: repair.id, repository: 'harlan-zw/example', itemNumber: 24 },
      recovery: { _tag: 'ActionRequired' },
      message: reason,
    })])
    expect(store.claimNextAdversarialReviewTask('reviewer', at(7), 600_000)?.id).toBe(review.id)
  })

  it('lets the released Review run against the red base instead of waiting again', () => {
    const { store, review, repair } = waitingReview()
    store.needsAttentionTask({ taskId: repair.id, workerId: 'baseline', fence: repair.state.fence, at: at(6), reason, evidence: 'Repair confidence: 0/100.' })
    const resumed = store.claimNextAdversarialReviewTask('reviewer', at(7), 600_000)!

    expect(store.queueBaselineRepairForReview({ taskId: resumed.id, workerId: 'reviewer', fence: resumed.state.fence, baseSha: 'red-base', at: at(8) }))
      .toEqual({ _tag: 'ActionRequired', taskId: repair.id, reason })
    expect(resumed.id).toBe(review.id)
    expect(store.claimNextBaselineRepairTask('baseline', at(9), 600_000)).toBe(null)
  })

  it('releases the waiting Review when the repair fails for good, and does not requeue it from that Review', () => {
    const { store, repair } = waitingReview()
    let attempt = repair
    while (store.failTask({ taskId: attempt.id, workerId: 'baseline', fence: attempt.state.fence, at: at(6), reason: 'The worker cannot build this commit.' }) === 'Retrying')
      attempt = store.claimNextBaselineRepairTask('baseline', at(6), 600_000)!

    const resumed = store.claimNextAdversarialReviewTask('reviewer', at(7), 600_000)!

    expect(resumed).not.toBe(null)
    expect(store.queueBaselineRepairForReview({ taskId: resumed.id, workerId: 'reviewer', fence: resumed.state.fence, baseSha: 'red-base', at: at(8) }))
      .toEqual({ _tag: 'ActionRequired', taskId: repair.id, reason: 'The worker cannot build this commit.' })
    expect(store.listIncidents()).toEqual([expect.objectContaining({ scope: expect.objectContaining({ taskId: repair.id }), recovery: { _tag: 'ActionRequired' } })])
  })

  it('releases a Review that started waiting after the repair already needed a person', async () => {
    const { store, mapping, repair } = waitingReview()
    store.needsAttentionTask({ taskId: repair.id, workerId: 'baseline', fence: repair.state.fence, at: at(6), reason, evidence: 'Repair confidence: 0/100.' })
    store.recordObservation({ externalId: 'pr-25', observedAt: at(7), source: 'poll', subject: pullRequestItem({ number: 25, baseSha: 'red-base', mergeState: 'clean' }) })
    const claimed = [store.claimNextAdversarialReviewTask('reviewer', at(8), 600_000)!, store.claimNextAdversarialReviewTask('second', at(8), 600_000)!]
    const late = claimed.find(task => task.pullRequestNumber === 25)!
    // A journal written before this fix holds exactly this wait.
    expect(store.completeReviewTask({ taskId: late.id, workerId: late.state.workerId, fence: late.state.fence, at: at(9), evidence: 'Waiting for Baseline repair.', resolution: { _tag: 'WaitingForBaselineRepair', taskId: repair.id } })).toBe(true)

    const swept = await retireObsoleteBaselineRepairs({ store, repository: mapping, now: () => new Date(at(10)), github: {
      getDefaultBranchSnapshot: () => Promise.resolve(ok({ baseSha: 'red-base', baseChecks: failing })),
    } }, new AbortController().signal)

    expect(swept).toEqual(ok(0))
    expect(store.claimNextAdversarialReviewTask('reviewer', at(11), 600_000)?.id).toBe(late.id)
    expect(store.listIncidents()).toHaveLength(1)
  })

  it('keeps the Incident while the trigger pull request moves on', () => {
    const { store, repair } = waitingReview()
    store.needsAttentionTask({ taskId: repair.id, workerId: 'baseline', fence: repair.state.fence, at: at(6), reason, evidence: 'Repair confidence: 0/100.' })
    store.recordObservation({ externalId: 'pr-24-moved', observedAt: at(7), source: 'poll', subject: pullRequestItem({ number: 24, baseSha: 'red-base', headSha: 'moved-head', mergeState: 'clean', updatedAt: at(7) }) })

    store.resolveStaleTaskIncidents(at(8))

    expect(store.listIncidents()).toEqual([expect.objectContaining({ kind: 'baseline_repair_action_required' })])
  })
})
