import type { GitHubReviewRerunRequest } from '../src/github.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { syncReviewRerunRequests } from '../src/review-rerun-controller.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
afterEach(() => stores.splice(0).forEach(store => store.close()))

const at = '2026-11-24T01:00:00.000Z'
const later = '2026-11-24T01:05:00.000Z'
const head = 'a'.repeat(40)

function setup() {
  const store = openJournalStore(':memory:')
  stores.push(store)
  store.syncRepositories([repositoryMapping()], at)
  store.recordObservation({ externalId: 'pr', observedAt: at, source: 'poll', subject: pullRequestItem({ mergeState: 'clean', headSha: head }) })
  return store
}

function stop(overrides: { author?: string, updatedAt?: string } = {}): GitHubReviewRerunRequest {
  return { author: 'harlan-zw', commentId: 7001, origin: 'Stop', pullRequestNumber: 24, updatedAt: at, ...overrides }
}

function poll(store: ReturnType<typeof setup>, requests: GitHubReviewRerunRequest[], now = at) {
  return syncReviewRerunRequests(repositoryMapping(), {
    github: { listReviewRerunRequests: async () => ok(requests) },
    store,
    allowedAuthors: ['harlan-zw'],
    now: () => new Date(now),
  })
}

describe('stop command', () => {
  it('stops the queued Review for the observed head and queues no Repair', async () => {
    const store = setup()
    expect(await poll(store, [stop()])).toEqual(ok({
      repository: 'harlan-zw/example',
      results: [{ _tag: 'Stopped', pullRequestNumber: 24, headSha: head }],
    }))
    expect(store.claimNextAdversarialReviewTask('review', at, 60_000)).toBeNull()
    expect(store.claimNextReviewFixTask('repair', at, 60_000)).toBeNull()
    store.recordObservation({ externalId: 'again', observedAt: later, source: 'poll', subject: pullRequestItem({ mergeState: 'clean', headSha: head }) })
    expect(store.claimNextAdversarialReviewTask('review', later, 60_000)).toBeNull()
  })

  it('stops a running Review and a queued owner change request', async () => {
    const store = setup()
    const change = await poll(store, [{ author: 'harlan-zw', commentId: 7000, origin: 'ChangeRequest', instruction: 'Rename the option.', pullRequestNumber: 24, updatedAt: at }])
    const repair = change._tag === 'Ok' ? change.value.results[0] : undefined
    if (repair?._tag !== 'Queued')
      throw new Error('Expected a queued change request.')
    const review = store.claimNextAdversarialReviewTask('review', at, 3_600_000)!
    await poll(store, [stop({ updatedAt: later })], later)
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
    expect(second).toEqual(ok({ repository: 'harlan-zw/example', results: [] }))
  })

  it.each(['contributor', 'harlan-agent'])('ignores a stop from %s', async (author) => {
    const store = setup()
    expect(await poll(store, [stop({ author })])).toEqual(ok({ repository: 'harlan-zw/example', results: [] }))
    expect(store.claimNextAdversarialReviewTask('review', at, 60_000)?.kind).toBe('adversarial_review')
  })

  it('leaves a later head alone when a poll reads an old stop again', async () => {
    const store = setup()
    await poll(store, [stop()])
    const next = 'b'.repeat(40)
    store.recordObservation({ externalId: 'next-head', observedAt: later, source: 'poll', subject: pullRequestItem({ mergeState: 'clean', headSha: next, updatedAt: later }) })
    expect(await poll(store, [stop()], later)).toEqual(ok({ repository: 'harlan-zw/example', results: [] }))
    expect(store.claimNextAdversarialReviewTask('review', later, 60_000)?.pullRequest.headSha).toBe(next)
  })

  it('applies a stop and a later rerun in the order they were written', async () => {
    const store = setup()
    const rerun: GitHubReviewRerunRequest = { author: 'harlan-zw', commentId: 7002, origin: 'Command', pullRequestNumber: 24, updatedAt: later }
    // GitHub lists the newest comment first.
    await poll(store, [rerun, stop()], later)
    expect(store.claimNextAdversarialReviewTask('review', later, 60_000)?.pullRequest.headSha).toBe(head)
  })

  it.each([
    { order: 'a rerun after the stop', rerunAt: later, stopAt: at, base: 'base456' },
    { order: 'a stop after the rerun', rerunAt: at, stopAt: later, base: null },
  ])('keeps $order through a base branch move', async ({ rerunAt, stopAt, base }) => {
    const store = setup()
    const rerun: GitHubReviewRerunRequest = { author: 'harlan-zw', commentId: 7002, origin: 'Command', pullRequestNumber: 24, updatedAt: rerunAt }
    await poll(store, [rerun, stop({ updatedAt: stopAt })], later)
    const moved = '2026-11-24T01:10:00.000Z'
    store.recordObservation({ externalId: 'base-move', observedAt: moved, source: 'poll', subject: pullRequestItem({ mergeState: 'clean', headSha: head, baseSha: 'base456', updatedAt: moved }) })
    expect(store.claimNextAdversarialReviewTask('review', moved, 60_000)?.pullRequest.baseSha ?? null).toBe(base)
  })
})
