import { afterEach, expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { createReviewStatusScheduler } from '../src/review-status-scheduler.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []
afterEach(() => stores.splice(0).forEach(store => store.close()))

it('requires fresh Review before publishing a READY label for an unscoped comment', async () => {
  const store = openJournalStore(':memory:')
  stores.push(store)
  const pullRequest = pullRequestItem({
    mergeState: 'clean',
    priorAutomatedReview: {
      _tag: 'Found',
      authorLogin: 'harlan-zw',
      state: 'complete',
      url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
    },
  })
  store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
  const labels: string[] = []
  const scheduler = createReviewStatusScheduler({
    github: {
      getPullRequestReviewSnapshot: () => Promise.resolve(ok({
        baseChecks: { _tag: 'Available', checks: [] },
        body: '',
        checks: { _tag: 'Available', checks: [] },
        comments: [],
        priorAutomatedReview: pullRequest.priorAutomatedReview,
        pullRequest,
        requiredChecks: { _tag: 'None' },
        reviews: [],
      })),
      readExistingReviewLabel: () => Promise.resolve(ok({ commentId: 42, url: pullRequest.url, label: 'READY' })),
      upsertReviewStatus: () => { throw new Error('The existing comment must stay unchanged.') },
      stampAgentLabel: (_repository, _number, label) => {
        labels.push(label)
        return Promise.resolve(ok(undefined))
      },
    },
    intervalMilliseconds: 5_000,
    leaseMilliseconds: 60_000,
    now: () => new Date('2026-08-13T01:01:00.000Z'),
    onError: (error) => { throw error },
    onFailure: (_repository, _number, reason) => { throw new Error(reason) },
    onPublished: () => undefined,
    store,
    workerId: 'label-publisher',
  })
  for (const externalId of ['first', 'repeat']) {
    store.recordObservation({ externalId, observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject: pullRequest })
    await scheduler.runNow()
  }

  expect(labels).toEqual([])
  expect(store.claimNextAdversarialReviewTask('reviewer', '2026-08-13T01:02:00.000Z', 60_000)?.pullRequest.baseRef).toBe('main')
})
