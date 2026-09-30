import { afterEach, describe, expect, it } from 'vitest'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []
afterEach(() => stores.splice(0).forEach(store => store.close()))
const at = (second: number) => new Date(Date.parse('2026-09-30T00:00:00Z') + second * 1000).toISOString()
const guardFailure = 'The Review Agent changed files. Review must stay read only.'

function setup(mutationsEnabled = true) {
  const store = openJournalStore(':memory:', mutationsEnabled)
  stores.push(store)
  const mapping = repositoryMapping()
  store.syncRepositories([mapping], at(0))
  store.setRepositoryWritesEnabled(mapping.github, true)
  store.recordPollObservation({ subject: pullRequestItem({ mergeState: 'clean' }), observedAt: at(1) })
  const task = store.claimNextAdversarialReviewTask('reviewer', at(2), 600000)!
  return { store, task }
}

function exhaust(store: ReturnType<typeof openJournalStore>, task: NonNullable<ReturnType<ReturnType<typeof openJournalStore>['claimNextAdversarialReviewTask']>>, reason = guardFailure) {
  let active = task
  for (let second = 4; second < 7; second++) {
    const result = store.failWorkerTask({ taskId: active.id, workerId: 'reviewer', fence: active.state.fence, at: at(second), reason })
    if (result === 'Retrying') {
      active = store.claimNextAdversarialReviewTask('reviewer', at(second), 600000)!
      expect(active).not.toBeNull()
    }
    else {
      expect(result).toBe('Failed')
    }
  }
  expect(store.listIncidents()).toHaveLength(1)
}

function state(store: ReturnType<typeof openJournalStore>, taskId: string) {
  return store.getDashboardSnapshot(at(10)).tasks.find(task => task.id === taskId)?.state._tag
}

describe('merged Review retirement', () => {
  it('retires a verified historical merged failure without another exact PR poll', () => {
    const { store, task } = setup()
    const merged = pullRequestItem({ mergeState: 'clean', state: 'closed', mergedAt: at(3), updatedAt: at(3) })
    const observed = store.recordExactPullRequestObservation({ externalId: 'verified-merged', subject: merged, observedAt: at(3) })
    if (observed._tag === 'Stale' || observed._tag === 'Conflict')
      throw new Error('Expected current merged observation.')
    expect(store.recordVerifiedPullRequestClosure({ repository: merged.repository, pullRequestNumber: merged.number, revisionId: observed.revisionId, headSha: merged.headSha, baseSha: merged.baseSha, disposition: { _tag: 'Merged' }, at: at(3) })).toBe(true)
    exhaust(store, task)
    expect(store.retryRecoverableWorkerFailures(at(70))).toBe(0)
    expect(state(store, task.id)).toBe('Superseded')
    expect(store.listIncidents()).toEqual([])
  })

  it.each(['unverified', 'writes-disabled', 'read-only'] as const)('defers historical retirement when %s', (mode) => {
    const { store, task } = setup(mode !== 'read-only')
    const merged = pullRequestItem({ mergeState: 'clean', state: 'closed', mergedAt: at(3), updatedAt: at(3) })
    const observed = store.recordExactPullRequestObservation({ externalId: 'historical-merged', subject: merged, observedAt: at(3) })
    if (observed._tag === 'Stale' || observed._tag === 'Conflict')
      throw new Error('Expected current merged observation.')
    if (mode !== 'unverified')
      store.recordVerifiedPullRequestClosure({ repository: merged.repository, pullRequestNumber: merged.number, revisionId: observed.revisionId, headSha: merged.headSha, baseSha: merged.baseSha, disposition: { _tag: 'Merged' }, at: at(3) })
    exhaust(store, task)
    if (mode === 'writes-disabled')
      store.setRepositoryWritesEnabled(merged.repository, false)
    expect(store.retryRecoverableWorkerFailures(at(70))).toBe(0)
    expect(state(store, task.id)).toBe('Failed')
    expect(store.listIncidents()).toHaveLength(1)
  })

  it('retires an exhausted read-only guard failure after repeated authoritative merged polls', () => {
    const { store, task } = setup()
    const merged = pullRequestItem({ mergeState: 'clean', state: 'closed', mergedAt: at(3), updatedAt: at(3) })
    store.recordPollObservation({ subject: merged, observedAt: at(3) })
    expect(state(store, task.id)).toBe('Running')
    exhaust(store, task)
    for (let second = 7; second < 10; second++)
      store.recordPollObservation({ subject: merged, observedAt: at(second) })
    expect(state(store, task.id)).toBe('Superseded')
    expect(store.listIncidents()).toEqual([])
    expect(store.claimNextAdversarialReviewTask('other', at(10), 600000)).toBeNull()
  })

  it('keeps an open Review failure visible', () => {
    const { store, task } = setup()
    exhaust(store, task)
    store.recordPollObservation({ subject: pullRequestItem({ mergeState: 'clean' }), observedAt: at(7) })
    expect(state(store, task.id)).toBe('Failed')
    expect(store.listIncidents()).toHaveLength(1)
  })

  it('preserves bounded post-merge retry and recoverable failure', () => {
    const { store, task } = setup()
    const merged = pullRequestItem({ mergeState: 'clean', state: 'closed', mergedAt: at(3), updatedAt: at(3) })
    store.recordPollObservation({ subject: merged, observedAt: at(3) })
    expect(store.failWorkerTask({ taskId: task.id, workerId: 'reviewer', fence: task.state.fence, at: at(4), reason: 'GitHub request timed out.' })).toBe('Retrying')
    store.recordPollObservation({ subject: merged, observedAt: at(4) })
    expect(state(store, task.id)).toBe('Queued')
    const retry = store.claimNextAdversarialReviewTask('reviewer', at(4), 600000)!
    expect(retry.id).toBe(task.id)
    for (let second = 5; second < 7; second++) {
      const running = second === 5 ? retry : store.claimNextAdversarialReviewTask('reviewer', at(second), 600000)!
      store.failWorkerTask({ taskId: running.id, workerId: 'reviewer', fence: running.state.fence, at: at(second), reason: 'GitHub request timed out.' })
    }
    store.recordPollObservation({ subject: merged, observedAt: at(7) })
    expect(state(store, task.id)).toBe('Failed')
    expect(store.listIncidents()).toHaveLength(1)
    expect(store.retryRecoverableWorkerFailures(at(70))).toBe(1)
    store.recordPollObservation({ subject: merged, observedAt: at(71) })
    expect(store.claimNextAdversarialReviewTask('recovered', at(72), 600000)?.id).toBe(task.id)
  })

  it('preserves a claimed post-merge continuation after writes pause refunds its attempt', () => {
    const { store, task } = setup()
    const merged = pullRequestItem({ mergeState: 'clean', state: 'closed', mergedAt: at(3), updatedAt: at(3) })
    store.recordPollObservation({ subject: merged, observedAt: at(3) })
    store.setRepositoryWritesEnabled(merged.repository, false)
    expect(store.failWorkerTask({ taskId: task.id, workerId: 'reviewer', fence: task.state.fence, at: at(4), reason: 'Repository writes are paused.' })).toBe('Retrying')
    store.setRepositoryWritesEnabled(merged.repository, true)
    store.recordPollObservation({ subject: merged, observedAt: at(5) })
    expect(state(store, task.id)).toBe('Queued')
    expect(store.claimNextAdversarialReviewTask('recovered', at(6), 600000)?.id).toBe(task.id)
  })

  it('resolves a cancelled mutation Task Incident without clearing an open Review failure', () => {
    const { store, task } = setup()
    exhaust(store, task)
    store.recordPollObservation({ subject: pullRequestItem({ number: 26, mergeState: 'conflicting' }), observedAt: at(7) })
    const repair = store.claimNextConflictTask('repair', at(8), 600000)!
    expect(repair).not.toBeNull()
    expect(store.failTask({ taskId: repair.id, workerId: 'repair', fence: repair.state.fence, at: at(9), reason: 'Repository policy does not permit issue work.' })).toBe('Failed')
    expect(store.listIncidents()).toHaveLength(2)
    expect(store.cancelTask({ taskId: repair.id, at: at(10) })._tag).toBe('Cancelled')
    expect(store.listIncidents()).toEqual([expect.objectContaining({ scope: expect.objectContaining({ taskId: task.id }) })])
  })

  it('resolves only the explicitly cancelled Task Incident', () => {
    const { store, task } = setup()
    exhaust(store, task)
    store.recordIncident({ scope: { _tag: 'Repository', repository: 'harlan-zw/example' }, kind: 'runner_lost', severity: 'warning', operation: 'read_checks', message: 'Runner lost.', recovery: { _tag: 'ActionRequired' }, at: at(7) })
    expect(store.cancelTask({ taskId: task.id, at: at(8) })._tag).toBe('Cancelled')
    expect(state(store, task.id)).toBe('Superseded')
    expect(store.listIncidents()).toEqual([expect.objectContaining({ operation: 'read_checks' })])
    expect(store.cancelTask({ taskId: task.id, at: at(9) })._tag).toBe('AlreadyCancelled')
  })
})
