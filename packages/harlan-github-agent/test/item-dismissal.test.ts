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
  store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
  return store
}

function observe(store: ReturnType<typeof openJournalStore>, headSha: string, at: string) {
  return store.recordObservation({
    externalId: `dismissal-${headSha}`,
    observedAt: at,
    source: 'poll',
    subject: pullRequestItem({ author: 'harlan-zw', mergeState: 'clean', headSha }),
  })
}

const dismiss = { repository: repositoryMapping().github, itemNumber: 24, at: '2026-08-13T02:00:00.000Z' }

describe('item dismissal', () => {
  it('queues no work for a dismissed pull request', () => {
    const store = createStore()
    observe(store, 'abc123', '2026-08-13T01:00:00.000Z')
    expect(store.dismissItem(dismiss)).toEqual({ _tag: 'Dismissed' })
    observe(store, 'abc123', '2026-08-13T03:00:00.000Z')
    expect(store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T04:00:00.000Z', 10_000)).toBeNull()
  })

  it('cancels work that is already queued', () => {
    const store = createStore()
    observe(store, 'abc123', '2026-08-13T01:00:00.000Z')
    store.dismissItem(dismiss)
    expect(store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T02:30:00.000Z', 10_000)).toBeNull()
  })

  it('survives a new head commit, which is the whole point', () => {
    const store = createStore()
    observe(store, 'abc123', '2026-08-13T01:00:00.000Z')
    store.dismissItem(dismiss)
    observe(store, 'def456', '2026-08-13T03:00:00.000Z')
    expect(store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T04:00:00.000Z', 10_000)).toBeNull()
  })

  it('lets the next observation queue work again once restored', () => {
    const store = createStore()
    observe(store, 'abc123', '2026-08-13T01:00:00.000Z')
    store.dismissItem(dismiss)
    expect(store.restoreItem({ ...dismiss, at: '2026-08-13T03:00:00.000Z' })).toEqual({ _tag: 'Restored' })
    observe(store, 'def456', '2026-08-13T04:00:00.000Z')
    expect(store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T05:00:00.000Z', 10_000)).not.toBeNull()
  })

  it('takes the item off the Queue but keeps it visible as dismissed', () => {
    const store = createStore()
    observe(store, 'abc123', '2026-08-13T01:00:00.000Z')
    store.dismissItem(dismiss)
    const snapshot = store.getDashboardSnapshot('2026-08-13T03:00:00.000Z')
    expect(snapshot.queue).toEqual([])
    expect(snapshot.items.map(item => item.dismissed)).toEqual([true])
  })

  it('reports a second dismissal as a duplicate rather than a change', () => {
    const store = createStore()
    observe(store, 'abc123', '2026-08-13T01:00:00.000Z')
    store.dismissItem(dismiss)
    expect(store.dismissItem(dismiss)).toEqual({ _tag: 'Duplicate' })
  })

  it('refuses an item it does not track', () => {
    const store = createStore()
    expect(store.dismissItem({ ...dismiss, itemNumber: 999 })).toEqual({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } })
  })
})
