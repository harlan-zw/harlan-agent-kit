import type { GitHubReviewRerunRequest } from '../src/github.ts'
import type { GitHubPullRequestItem } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { syncReviewRerunRequests } from '../src/review-rerun-controller.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
afterEach(() => stores.splice(0).forEach(store => store.close()))

// GitHub stamps comments to the second. The Service stamps its own reads.
const earlier = '2026-11-24T00:58:00Z'
const written = '2026-11-24T00:59:00Z'
const at = '2026-11-24T01:00:00.000Z'
const later = '2026-11-24T01:05:00.000Z'
const head = 'a'.repeat(40)

function observe(store: ReturnType<typeof openJournalStore>, observedAt: string, overrides: Partial<GitHubPullRequestItem> = {}) {
  const subject = pullRequestItem({ mergeState: 'clean', headSha: head, ...overrides })
  store.recordObservation({ externalId: `${subject.number}:${subject.headSha}:${subject.state}:${observedAt}`, observedAt, source: 'poll', subject })
}

function setup(overrides: Partial<GitHubPullRequestItem> = {}) {
  const store = openJournalStore(':memory:')
  stores.push(store)
  store.syncRepositories([repositoryMapping()], at)
  observe(store, at, overrides)
  return store
}

function stop(overrides: { author?: string, updatedAt?: string } = {}): GitHubReviewRerunRequest {
  return { author: 'harlan-zw', commentId: 7001, origin: 'Stop', pullRequestNumber: 24, updatedAt: written, ...overrides }
}

function rerun(updatedAt: string): GitHubReviewRerunRequest {
  return { author: 'harlan-zw', commentId: 7002, origin: 'Command', pullRequestNumber: 24, updatedAt }
}

function poll(store: ReturnType<typeof setup>, requests: GitHubReviewRerunRequest[], now = at) {
  return syncReviewRerunRequests(repositoryMapping(), {
    github: { listReviewRerunRequests: async () => ok(requests) },
    store,
    allowedAuthors: ['harlan-zw'],
    now: () => new Date(now),
  })
}

const stopped = (headSha = head) => ok({ repository: 'harlan-zw/example', results: [{ _tag: 'Stopped', pullRequestNumber: 24, headSha }] })
const nothing = ok({ repository: 'harlan-zw/example', results: [] })

describe('stop command', () => {
  it('stops the queued Review for the observed head and queues no Repair', async () => {
    const store = setup()
    expect(await poll(store, [stop()])).toEqual(stopped())
    expect(store.claimNextAdversarialReviewTask('review', at, 60_000)).toBeNull()
    expect(store.claimNextReviewFixTask('repair', at, 60_000)).toBeNull()
    store.recordObservation({ externalId: 'again', observedAt: later, source: 'poll', subject: pullRequestItem({ mergeState: 'clean', headSha: head }) })
    expect(store.claimNextAdversarialReviewTask('review', later, 60_000)).toBeNull()
  })

  it('stops a running Review and a queued owner change request', async () => {
    const store = setup()
    const change = await poll(store, [{ author: 'harlan-zw', commentId: 7000, origin: 'ChangeRequest', instruction: 'Rename the option.', pullRequestNumber: 24, updatedAt: earlier }])
    const repair = change._tag === 'Ok' ? change.value.results[0] : undefined
    if (repair?._tag !== 'Queued')
      throw new Error('Expected a queued change request.')
    const review = store.claimNextAdversarialReviewTask('review', at, 3_600_000)!
    await poll(store, [stop()], later)
    expect(store.heartbeatWorkerTask({ taskId: review.id, workerId: 'review', fence: review.state.fence, at: later, leaseMilliseconds: 60_000 })).toBe(false)
    expect(store.getTask(repair.taskId)?.state._tag).toBe('Superseded')
    expect(store.claimNextReviewFixTask('repair', later, 60_000)).toBeNull()
  })

  it('keeps the head stopped when the base branch moves', async () => {
    const store = setup()
    const before = store.listOpenPullRequestRevisions('harlan-zw/example')[0]!.revisionId
    await poll(store, [stop()])
    store.recordObservation({ externalId: 'base-move', observedAt: later, source: 'poll', subject: pullRequestItem({ mergeState: 'clean', headSha: head, baseSha: 'base456', updatedAt: later }) })
    expect(store.listOpenPullRequestRevisions('harlan-zw/example')[0]!.revisionId).not.toBe(before)
    expect(store.claimNextAdversarialReviewTask('review', later, 60_000)).toBeNull()
  })

  it('acts once when later polls read the same comment', async () => {
    const store = setup()
    await poll(store, [stop()])
    const second = await poll(store, [stop()], later)
    expect(second).toEqual(nothing)
  })

  it.each(['contributor', 'harlan-agent'])('ignores a stop from %s', async (author) => {
    const store = setup()
    expect(await poll(store, [stop({ author })])).toEqual(nothing)
    expect(store.claimNextAdversarialReviewTask('review', at, 60_000)?.kind).toBe('adversarial_review')
  })

  it('leaves a later head alone when a poll reads an old stop again', async () => {
    const store = setup()
    await poll(store, [stop()])
    const next = 'b'.repeat(40)
    store.recordObservation({ externalId: 'next-head', observedAt: later, source: 'poll', subject: pullRequestItem({ mergeState: 'clean', headSha: next, updatedAt: later }) })
    expect(await poll(store, [stop()], later)).toEqual(nothing)
    expect(store.claimNextAdversarialReviewTask('review', later, 60_000)?.pullRequest.headSha).toBe(next)
  })

  it.each([
    { when: 'in the same second as the last read', updatedAt: '2026-11-24T01:00:00Z' },
    { when: 'after the last read', updatedAt: '2026-11-24T01:02:00Z' },
  ])('binds a stop written $when to the head the next read records', async ({ updatedAt }) => {
    const store = setup()
    // The pushed head is on GitHub, but no repository poll has recorded it yet.
    expect(await poll(store, [stop({ updatedAt })], later)).toEqual(nothing)
    const pushed = 'b'.repeat(40)
    observe(store, later, { headSha: pushed, updatedAt: later })
    expect(await poll(store, [stop({ updatedAt })], later)).toEqual(stopped(pushed))
    expect(store.claimNextAdversarialReviewTask('review', later, 60_000)).toBeNull()
  })

  it('holds a rerun written after a waiting stop until the stop applies', async () => {
    const store = setup()
    const requests = [rerun('2026-11-24T01:03:00Z'), stop({ updatedAt: '2026-11-24T01:02:00Z' })]
    expect(await poll(store, requests, later)).toEqual(nothing)
    observe(store, later)
    await poll(store, requests, later)
    expect(store.claimNextAdversarialReviewTask('review', later, 60_000)?.pullRequest.headSha).toBe(head)
  })

  it('applies a stop and a later rerun in the order they were written', async () => {
    const store = setup()
    // GitHub lists the newest comment first.
    await poll(store, [rerun(later), stop()], later)
    expect(store.claimNextAdversarialReviewTask('review', later, 60_000)?.pullRequest.headSha).toBe(head)
  })

  it.each([
    { order: 'a rerun after the stop', rerunAt: written, stopAt: earlier, base: 'base456' },
    { order: 'a stop after the rerun', rerunAt: earlier, stopAt: written, base: null },
  ])('keeps $order through a base branch move', async ({ rerunAt, stopAt, base }) => {
    const store = setup()
    await poll(store, [rerun(rerunAt), stop({ updatedAt: stopAt })], later)
    const moved = '2026-11-24T01:10:00.000Z'
    store.recordObservation({ externalId: 'base-move', observedAt: moved, source: 'poll', subject: pullRequestItem({ mergeState: 'clean', headSha: head, baseSha: 'base456', updatedAt: moved }) })
    expect(store.claimNextAdversarialReviewTask('review', moved, 60_000)?.pullRequest.baseSha ?? null).toBe(base)
  })

  it('keeps the head stopped when its Baseline repair closes unmerged', async () => {
    const store = setup()
    // A draft keeps the Baseline repair pull request out of Review.
    const baselineRepair = { number: 26, headSha: 'c'.repeat(40), headRef: 'fix/baseline-ci', draft: true, controllerOwned: true, purpose: { _tag: 'BaselineRepair' as const, baseShaPrefix: 'base123' } }
    observe(store, at, baselineRepair)
    const review = store.claimNextAdversarialReviewTask('review', at, 600_000)!
    // The open repair pull request completes the Baseline repair Task.
    const baseline = store.queueBaselineRepairForReview({ taskId: review.id, workerId: 'review', fence: review.state.fence, baseSha: 'base123', at })
    if (baseline._tag !== 'Existing')
      throw new Error('Expected the open Baseline repair.')
    store.completeReviewTask({ taskId: review.id, workerId: 'review', fence: review.state.fence, at, evidence: 'Waiting for Baseline repair.', resolution: { _tag: 'WaitingForBaselineRepair', taskId: baseline.taskId } })

    expect(await poll(store, [stop()], later)).toEqual(stopped())
    observe(store, later, { ...baselineRepair, state: 'closed', updatedAt: later })
    observe(store, later)
    expect(store.claimNextAdversarialReviewTask('review', later, 60_000)).toBeNull()

    await poll(store, [rerun(later)], later)
    expect(store.claimNextAdversarialReviewTask('review', later, 60_000)?.pullRequest.headSha).toBe(head)
  })

  it('keeps the head stopped when the manual Review label is on a completed Review', async () => {
    const store = setup({ approvalLabels: ['review'] })
    const review = store.claimNextAdversarialReviewTask('review', at, 600_000)!
    store.completeWorkerTask({ taskId: review.id, workerId: 'review', fence: review.state.fence, at, evidence: 'Done.' })
    expect(await poll(store, [stop()], later)).toEqual(stopped())
    observe(store, later, { approvalLabels: ['review'] })
    expect(store.claimNextAdversarialReviewTask('review', later, 60_000)).toBeNull()
  })
})
