import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { syncReviewRerunRequests } from '../src/review-rerun-controller.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
afterEach(() => stores.splice(0).forEach(store => store.close()))

function setup(path = ':memory:') {
  const store = openJournalStore(path)
  stores.push(store)
  const at = '2026-10-09T01:00:00.000Z'
  store.syncRepositories([repositoryMapping()], at)
  store.recordObservation({ externalId: 'pr', observedAt: at, source: 'poll', subject: pullRequestItem({ mergeState: 'clean' }) })
  const revisionId = store.getDashboardSnapshot(at).items[0]!.revisionId
  const request = { repository: 'harlan-zw/example', pullRequestNumber: 24, revisionId, requestId: 'comment:42', instruction: 'Change trailingSlash to false.', requestedBy: 'harlan-zw', at }
  return { store, request, at }
}

describe('owner pull request changes', () => {
  it('routes the linked comment into Repair rather than another Review', async () => {
    const { store, request, at } = setup()
    const result = await syncReviewRerunRequests(repositoryMapping(), {
      github: { listReviewRerunRequests: async () => ok([{
        author: 'harlan-zw',
        commentId: 6072523996,
        origin: 'ChangeRequest',
        instruction: 'can we just changing trailingSlash to false',
        pullRequestNumber: 24,
        updatedAt: at,
      }]) },
      store,
      allowedAuthors: ['harlan-zw'],
      now: () => new Date(at),
    })
    expect(result).toEqual(ok({ repository: request.repository, results: [expect.objectContaining({ _tag: 'Queued' })] }))
    const review = store.claimNextAdversarialReviewTask('review', at, 60_000)!
    store.completeWorkerTask({ taskId: review.id, workerId: 'review', fence: review.state.fence, at, evidence: 'done' })
    expect(store.claimNextReviewFixTask('repair', at, 60_000)?.request?.instruction)
      .toBe('can we just changing trailingSlash to false')
  })

  it('queues one durable Repair with the exact request after Review finishes', () => {
    const { store, request, at } = setup()
    const result = store.requestPullRequestChange(request)
    expect(result._tag).toBe('Queued')
    expect(store.claimNextReviewFixTask('repair', at, 60_000)).toBeNull()
    const review = store.claimNextAdversarialReviewTask('review', at, 60_000)!
    store.completeWorkerTask({ taskId: review.id, workerId: 'review', fence: review.state.fence, at, evidence: 'done' })
    const repair = store.claimNextReviewFixTask('repair', at, 60_000)
    expect(repair?.request).toEqual({ _tag: 'OwnerComment', instruction: request.instruction, requestedBy: 'harlan-zw', requestId: request.requestId })
    expect(store.requestPullRequestChange(request)).toEqual({ _tag: 'Duplicate', taskId: repair!.id })
  })

  it('rejects non-owner instructions', () => {
    const { store, request } = setup()
    expect(store.requestPullRequestChange({ ...request, requestedBy: 'contributor' }))
      .toEqual({ _tag: 'Rejected', reason: { _tag: 'AuthorNotAllowed' } })
  })

  it('preserves the owner request when a clean Review finishes', () => {
    const { store, request, at } = setup()
    store.requestPullRequestChange(request)
    const review = store.claimNextAdversarialReviewTask('review', at, 60_000)!
    store.recordReviewRun({
      id: 'clean-review',
      repository: review.repository,
      pullRequestNumber: review.pullRequestNumber,
      revisionId: review.revisionId,
      headSha: review.pullRequest.headSha,
      provider: 'codex',
      sessionId: 'clean-review-session',
      model: 'test',
      agentVersion: 'test',
      skillDigest: 'f'.repeat(64),
      startedAt: at,
      completedAt: at,
      gates: {
        merge: { _tag: 'Passed', evidence: [] },
        review: { _tag: 'Passed', evidence: [] },
        ci: { _tag: 'Passed', evidence: [] },
      },
      confidence: 95,
      findings: [],
    })
    store.completeWorkerTask({ taskId: review.id, workerId: 'review', fence: review.state.fence, at, evidence: 'clean-review' })
    expect(store.claimNextReviewFixTask('repair', at, 60_000)?.request?.instruction).toBe(request.instruction)
  })

  it('does not carry a request onto a different head', () => {
    const { store, request, at } = setup()
    store.requestPullRequestChange(request)
    store.recordObservation({ externalId: 'new-head', observedAt: at, source: 'poll', subject: pullRequestItem({ mergeState: 'clean', headSha: 'f'.repeat(40) }) })
    expect(store.claimNextReviewFixTask('repair', at, 60_000)).toBeNull()
    expect(store.requestPullRequestChange(request)._tag).toBe('Duplicate')
  })

  it('keeps request identity and text across a Service restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'owner-request-'))
    const path = join(directory, 'journal.sqlite')
    const { store, request, at } = setup(path)
    const result = store.requestPullRequestChange(request)
    store.close()
    stores.splice(stores.indexOf(store), 1)
    const restored = openJournalStore(path)
    try {
      expect(restored.requestPullRequestChange(request)).toEqual({ _tag: 'Duplicate', taskId: result._tag === 'Queued' ? result.taskId : '' })
      const review = restored.claimNextAdversarialReviewTask('review', at, 60_000)!
      restored.completeWorkerTask({ taskId: review.id, workerId: 'review', fence: review.state.fence, at, evidence: 'done' })
      expect(restored.claimNextReviewFixTask('repair', at, 60_000)?.request?.instruction).toBe(request.instruction)
    }
    finally {
      restored.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    { state: 'closed' as const },
    { draft: true },
    { headRef: 'main' },
    { headRef: 'untrusted/change' },
  ])('rejects a pull request without Repair authority: %j', (override) => {
    const { store, request, at } = setup()
    const observation = store.recordObservation({ externalId: 'unsafe', observedAt: at, source: 'poll', subject: pullRequestItem({ mergeState: 'clean', ...override }) })
    if (observation._tag === 'Conflict')
      throw new Error('Unexpected observation conflict.')
    const revisionId = observation.revisionId
    expect(store.requestPullRequestChange({ ...request, revisionId })._tag).toBe('Rejected')
  })
})
