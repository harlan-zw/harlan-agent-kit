import { afterEach, describe, expect, it } from 'vitest'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []

afterEach(() => {
  stores.splice(0).forEach(store => store.close())
})

function createStore() {
  const store = openJournalStore(':memory:')
  stores.push(store)
  return store
}

function storeWithQueuedReview() {
  const store = createStore()
  store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
  const observed = store.recordObservation({
    externalId: 'pause-observation',
    observedAt: '2026-08-13T01:00:00.000Z',
    source: 'poll',
    subject: pullRequestItem({ mergeState: 'clean' }),
  })
  if (observed._tag !== 'Inserted')
    throw new Error('Expected a new pull request.')
  return store
}

describe('per repository pause', () => {
  it('stops a paused repository from starting new work', () => {
    const store = storeWithQueuedReview()
    expect(store.setRepositoryPaused(repositoryMapping().github, true)).toBe(true)
    expect(store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T01:01:00.000Z', 10_000)).toBeNull()
  })

  it('starts work again once the repository resumes', () => {
    const store = storeWithQueuedReview()
    store.setRepositoryPaused(repositoryMapping().github, true)
    store.setRepositoryPaused(repositoryMapping().github, false)
    expect(store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T01:01:00.000Z', 10_000)).not.toBeNull()
  })

  it('leaves other repositories claimable', () => {
    const store = createStore()
    store.syncRepositories([
      repositoryMapping(),
      repositoryMapping({ github: 'harlan-zw/other', checkout: '/tmp/other' }),
    ], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'other-observation',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ repository: 'harlan-zw/other', mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request.')
    store.setRepositoryPaused(repositoryMapping().github, true)
    const task = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T01:01:00.000Z', 10_000)
    expect(task?.repository).toBe('harlan-zw/other')
  })

  it('leaves work that already started running, so a pause never kills in-flight agents', () => {
    const store = storeWithQueuedReview()
    const task = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T01:01:00.000Z', 10_000)
    if (task === null)
      throw new Error('Expected a review task.')
    store.setRepositoryPaused(repositoryMapping().github, true)

    // The lease still renews, which is what keeps the running agent alive.
    expect(store.heartbeatWorkerTask({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:01:05.000Z',
      leaseMilliseconds: 10_000,
    })).toBe(true)

    const snapshot = store.getDashboardSnapshot('2026-08-13T01:01:06.000Z')
    const running = snapshot.agents.filter(agent => agent._tag === 'ActiveAgent')
    expect(running).toHaveLength(1)
  })

  it('reports an unknown repository rather than silently doing nothing', () => {
    const store = createStore()
    expect(store.setRepositoryPaused('harlan-zw/not-mapped', true)).toBe(false)
  })

  it('surfaces the paused state on the dashboard so the repository stays visible', () => {
    const store = storeWithQueuedReview()
    store.setRepositoryPaused(repositoryMapping().github, true)
    const snapshot = store.getDashboardSnapshot('2026-08-13T01:02:00.000Z')
    const repository = snapshot.repositories.find(candidate => candidate.github === repositoryMapping().github)
    expect(repository?.paused).toBe(true)
    expect(snapshot.queue.length).toBeGreaterThan(0)
  })
})
