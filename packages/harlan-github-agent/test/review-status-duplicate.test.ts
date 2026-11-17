import { expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { createReviewStatusController } from '../src/review-status-controller.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

it('returns the confirmed receipt when the same Review progress is published twice', async () => {
  const store = openJournalStore(':memory:', true)
  try {
    const repository = repositoryMapping()
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const at = '2026-08-13T01:00:00.000Z'
    store.syncRepositories([repository], at)
    store.setRepositoryWritesEnabled(repository.github, true)
    store.recordObservation({ externalId: 'duplicate-progress', observedAt: at, source: 'poll', subject: pullRequest })
    const task = store.claimNextAdversarialReviewTask('reviewer', at, 60_000)
    if (task === null)
      throw new Error('Expected a Review Task.')
    let writes = 0
    const receipt = { commentId: 42, url: `${pullRequest.url}#issuecomment-42` }
    const controller = createReviewStatusController({
      github: {
        readExistingReviewLabel: () => { throw new Error('Unexpected existing Review.') },
        getPullRequestStatusIdentity: async () => ok({ state: pullRequest.state, headSha: pullRequest.headSha, baseRef: pullRequest.baseRef! }),
        getPullRequestReviewSnapshot: () => { throw new Error('Progress does not need a snapshot.') },
        upsertReviewStatus: async () => {
          writes++
          return ok(receipt)
        },
        stampAgentLabel: async () => ok(undefined),
      },
      store,
      now: () => new Date(at),
      leaseMilliseconds: 60_000,
      workerId: 'publisher',
    })
    const body = '<!-- harlan-agent-kit:pr-triage -->\nReviewing the diff.'
    const signal = new AbortController().signal

    expect(await controller.publish(task, 'review', body, signal)).toEqual(ok(receipt))
    expect(await controller.publish(task, 'review', body, signal)).toEqual(ok(receipt))
    expect(writes).toBe(1)
    store.setRepositoryWritesEnabled(repository.github, false)
    expect((await controller.publish(task, 'review', body, signal))._tag).toBe('Err')
  }
  finally {
    store.close()
  }
})
