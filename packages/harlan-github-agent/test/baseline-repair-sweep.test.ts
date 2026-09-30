import type { GitHubCheck, GitHubChecksSnapshot } from '../src/github-agent-source.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { retireObsoleteBaselineRepairs } from '../src/baseline-repair-sweep.ts'
import { err, ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
afterEach(() => stores.splice(0).forEach(store => store.close()))
const at = (second: number) => new Date(Date.parse('2026-09-30T06:00:00Z') + second * 1000).toISOString()
const check = (conclusion: string | null, status = 'completed'): GitHubCheck => ({ id: 1, name: 'test', conclusion, status, failure: { _tag: 'NotAsked' }, source: { _tag: 'CheckRun', appId: 15368 } })

function setup(mutationsEnabled = true) {
  const store = openJournalStore(':memory:', mutationsEnabled)
  stores.push(store)
  const mapping = repositoryMapping()
  store.syncRepositories([mapping], at(0))
  store.setRepositoryWritesEnabled(mapping.github, true)
  store.recordObservation({ externalId: 'old-base', observedAt: at(1), source: 'poll', subject: pullRequestItem({ baseSha: 'old-base', mergeState: 'clean' }) })
  const review = store.claimNextAdversarialReviewTask('reviewer', at(2), 600_000)!
  const queued = store.queueBaselineRepairForReview({ taskId: review.id, workerId: 'reviewer', fence: review.state.fence, baseSha: 'old-base', at: at(3) })
  if (queued._tag !== 'Queued')
    throw new Error('Expected Baseline repair.')
  const repair = store.claimNextBaselineRepairTask('baseline', at(4), 600_000)!
  store.completeReviewTask({ taskId: review.id, workerId: 'reviewer', fence: review.state.fence, at: at(5), evidence: 'Waiting for Baseline repair.', resolution: { _tag: 'WaitingForBaselineRepair', taskId: repair.id } })
  store.needsAttentionTask({ taskId: repair.id, workerId: 'baseline', fence: repair.state.fence, at: at(6), reason: 'The runner is unavailable.', evidence: 'Runner lost the job.' })
  store.recordObservation({ externalId: 'new-base', observedAt: at(7), source: 'poll', subject: pullRequestItem({ baseSha: 'new-base', mergeState: 'clean', updatedAt: at(7) }) })
  return { store, mapping, repair }
}

function sweep(fixture: ReturnType<typeof setup>, baseSha: string, baseChecks: GitHubChecksSnapshot, onRead: () => void = () => undefined) {
  return retireObsoleteBaselineRepairs({ store: fixture.store, repository: fixture.mapping, now: () => new Date(at(9)), github: {
    getDefaultBranchSnapshot: () => {
      onRead()
      return Promise.resolve(ok({ baseSha, baseChecks }))
    },
  } }, new AbortController().signal)
}

describe('obsolete Baseline repair attention', () => {
  it('retires attention for a live default branch that moved and releases Review', async () => {
    const fixture = setup()
    expect(fixture.store.claimNextAdversarialReviewTask('reviewer', at(8), 600_000)).toBe(null)
    expect(await sweep(fixture, 'new-base', { _tag: 'Available', checks: [check('failure')] })).toEqual(ok(1))
    expect(fixture.store.claimNextAdversarialReviewTask('reviewer', at(10), 600_000)?.pullRequest.baseSha).toBe('new-base')
    expect(fixture.store.claimNextBaselineRepairTask('baseline', at(11), 600_000)).toBe(null)
  })

  it.each(['success', 'skipped', 'neutral'])('retires same-base attention after verified %s CI', async (conclusion) => {
    const fixture = setup()
    expect(await sweep(fixture, 'old-base', { _tag: 'Available', checks: [check(conclusion)] })).toEqual(ok(1))
  })
  it.each([
    { _tag: 'Available' as const, checks: [check('failure')] },
    { _tag: 'Available' as const, checks: [check(null, 'in_progress')] },
    { _tag: 'Available' as const, checks: [] },
    { _tag: 'Available' as const, checks: [{ ...check('success'), failure: { _tag: 'RunnerLost' as const, incompleteSteps: 2 } }] },
  ])('preserves same-base operator attention while CI is unresolved: %j', async (checks) => {
    const fixture = setup()
    expect(await sweep(fixture, 'old-base', checks)).toEqual(ok(0))
    expect(fixture.store.listActionRequiredBaselineRepairs(fixture.mapping.github)[0]?.taskId).toBe(fixture.repair.id)
    expect(fixture.store.claimNextAdversarialReviewTask('reviewer', at(10), 600_000)).toBe(null)
  })

  it('surfaces unreadable same-base checks and preserves attention', async () => {
    const fixture = setup()
    expect(await sweep(fixture, 'old-base', { _tag: 'Unavailable', reason: 'Checks access failed.' })).toEqual(err('Checks access failed.'))
    expect(fixture.store.listActionRequiredBaselineRepairs(fixture.mapping.github)[0]?.taskId).toBe(fixture.repair.id)
  })

  it('retires a proven obsolete base even when its successor checks cannot be read', async () => {
    const fixture = setup()
    expect(await sweep(fixture, 'new-base', { _tag: 'Unavailable', reason: 'Checks access failed.' })).toEqual(ok(1))
  })

  it('surfaces an unreadable default branch without retiring attention', async () => {
    const fixture = setup()
    expect(await retireObsoleteBaselineRepairs({ store: fixture.store, repository: fixture.mapping, now: () => new Date(at(9)), github: {
      getDefaultBranchSnapshot: () => Promise.resolve(err('Branch access failed.')),
    } }, new AbortController().signal)).toEqual(err('Branch access failed.'))
    expect(fixture.store.listActionRequiredBaselineRepairs(fixture.mapping.github)[0]?.taskId).toBe(fixture.repair.id)
  })

  it.each(['writes', 'policy', 'cancel', 'dismiss', 'pause'] as const)('retains the %s fence when it changes during the branch read', async (fence) => {
    const fixture = setup()
    expect(await sweep(fixture, 'new-base', { _tag: 'Available', checks: [check('success')] }, () => {
      if (fence === 'writes')
        fixture.store.setRepositoryWritesEnabled(fixture.mapping.github, false)
      if (fence === 'policy')
        fixture.store.syncRepositories([repositoryMapping({ maxOpenPullRequests: 5 })], at(8))
      if (fence === 'cancel')
        fixture.store.cancelTask({ taskId: fixture.repair.id, at: at(8) })
      if (fence === 'dismiss')
        fixture.store.dismissItem({ repository: fixture.mapping.github, itemNumber: 24, at: at(8) })
      if (fence === 'pause')
        fixture.store.setRepositoryPaused(fixture.mapping.github, true)
    })).toEqual(ok(0))
  })

  it('does no retirement or branch read when mutations are disabled', async () => {
    const fixture = setup(false)
    let reads = 0
    expect(await sweep(fixture, 'new-base', { _tag: 'Available', checks: [check('success')] }, () => {
      reads += 1
    })).toEqual(ok(0))
    expect(reads).toBe(0)
  })

  it('refuses a stale mapping for a renamed default branch', async () => {
    const fixture = setup()
    fixture.store.syncRepositories([repositoryMapping({ defaultBranch: 'trunk' })], at(8))
    expect(await sweep(fixture, 'new-base', { _tag: 'Available', checks: [check('success')] })).toEqual(err('Repository policy changed before Baseline repair refresh.'))
  })

  it.each(['Queued', 'Running', 'Publishing', 'ActionRequired'] as const)('preserves newer %s work created during an earlier branch read', async (state) => {
    const fixture = setup()
    let newFence = 0
    expect(await sweep(fixture, 'new-base', { _tag: 'Available', checks: [check('success')] }, () => {
      const candidate = fixture.store.listActionRequiredBaselineRepairs(fixture.mapping.github)[0]!
      expect(fixture.store.retireActionRequiredBaselineRepair({ candidate, evidence: { _tag: 'BaseChanged', baseSha: 'new-base' }, at: at(8) })).toBe(true)
      fixture.store.recordObservation({ externalId: 'replacement', observedAt: at(8), source: 'poll', subject: pullRequestItem({ number: 25, baseSha: 'old-base', mergeState: 'clean' }) })
      fixture.store.claimNextAdversarialReviewTask('new-base-review', at(8), 600_000)
      const review = fixture.store.claimNextAdversarialReviewTask('replacement-review', at(8), 600_000)!
      expect(fixture.store.queueBaselineRepairForReview({ taskId: review.id, workerId: 'replacement-review', fence: review.state.fence, baseSha: 'old-base', at: at(8) })._tag).toBe('Queued')
      if (state === 'Queued')
        return
      const repair = fixture.store.claimNextBaselineRepairTask('replacement-baseline', at(8), 600_000)!
      newFence = repair.state.fence
      if (state === 'ActionRequired')
        expect(fixture.store.needsAttentionTask({ taskId: repair.id, workerId: 'replacement-baseline', fence: newFence, at: at(8), reason: 'New operator attention.', evidence: 'A newer decision.' })).toBe(true)
      if (state === 'Publishing') {
        expect(fixture.store.stagePublication({ taskId: repair.id, workerId: 'replacement-baseline', fence: newFence, at: at(8), publication: {
          _tag: 'OpenPullRequest',
          taskKind: 'baseline_repair',
          pullRequestNumber: 24,
          pullRequestTitle: 'fix: repair CI',
          pullRequestBody: 'Repairs CI.',
          commitSha: 'repair-commit',
          baseSha: 'old-base',
          baseRef: 'main',
          expectedHeadSha: 'old-base',
          headRef: 'fix/baseline-ci-old-base',
          artifactRef: 'artifact',
          patchDigest: 'digest',
          changedFiles: 1,
        } })._tag).toBe('Staged')
      }
    })).toEqual(ok(0))
    expect(fixture.store.getDashboardSnapshot(at(10)).tasks.find(task => task.id === fixture.repair.id)?.state._tag).toBe(state)
    if (state === 'Running')
      expect(fixture.store.heartbeatTask({ taskId: fixture.repair.id, workerId: 'replacement-baseline', fence: newFence, at: at(10), leaseMilliseconds: 600_000 })).toBe(true)
  })
})
