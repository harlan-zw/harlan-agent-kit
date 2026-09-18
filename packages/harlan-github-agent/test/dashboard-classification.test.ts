import { afterEach, describe, expect, it } from 'vitest'
import { openJournalStore } from '../src/store.ts'
import { issueItem, pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []

afterEach(() => {
  stores.splice(0).forEach(store => store.close())
})

function createStore() {
  const store = openJournalStore(':memory:')
  stores.push(store)
  return store
}

describe('classification on the dashboard snapshot', () => {
  it('counts triage decisions from the last 24 hours only', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-09-17T00:00:00.000Z')
    const subject = pullRequestItem({ mergeState: 'clean' })
    const inserted = store.recordObservation({
      externalId: 'classification-recent',
      observedAt: '2026-09-18T00:00:00.000Z',
      source: 'poll',
      subject,
      pullRequestTriage: { _tag: 'Skipped', reason: 'model: classification chose skip with confidence 0.93.', source: 'model' },
    })
    if (inserted._tag !== 'Inserted')
      throw new Error('Expected one inserted Revision.')
    const older = { ...subject, headSha: 'e'.repeat(40), updatedAt: '2026-09-10T00:00:00.000Z' }
    store.recordObservation({
      externalId: 'classification-old',
      observedAt: '2026-09-10T00:00:00.000Z',
      source: 'poll',
      subject: older,
      pullRequestTriage: { _tag: 'Required', reason: 'rule: runtime code changed.', source: 'rule' },
    })

    const snapshot = store.getDashboardSnapshot('2026-09-18T12:00:00.000Z')

    expect(snapshot.triageDecisions).toEqual({ reviewRequired: 0, reviewSkipped: 1, couldNotDecide: 0 })
  })

  it('carries the recorded decision on the pull request item', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-09-17T00:00:00.000Z')
    const subject = pullRequestItem({ mergeState: 'clean' })
    store.recordObservation({
      externalId: 'classification-item',
      observedAt: '2026-09-18T00:00:00.000Z',
      source: 'poll',
      subject,
      pullRequestTriage: { _tag: 'Skipped', reason: 'model: classification chose skip with confidence 0.93.', source: 'model' },
    })
    const issue = store.recordObservation({
      externalId: 'classification-issue',
      observedAt: '2026-09-18T00:00:00.000Z',
      source: 'poll',
      subject: issueItem(),
    })
    if (issue._tag !== 'Inserted')
      throw new Error('Expected one inserted issue Revision.')

    const snapshot = store.getDashboardSnapshot('2026-09-18T12:00:00.000Z')
    const pullRequest = snapshot.items.find(item => item.kind === 'pull_request')
    const issueSummary = snapshot.items.find(item => item.kind === 'issue')

    expect(pullRequest?.kind === 'pull_request' && pullRequest.triage).toEqual({
      outcome: 'ReviewSkipped',
      reason: 'model: classification chose skip with confidence 0.93.',
    })
    expect(issueSummary?.kind === 'issue' && 'triage' in issueSummary).toBe(false)
  })
})
