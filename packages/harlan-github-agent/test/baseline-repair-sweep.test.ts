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

function setup(mutationsEnabled = true, advanceBase = true, actionRequired = true) {
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
  if (actionRequired)
    store.needsAttentionTask({ taskId: repair.id, workerId: 'baseline', fence: repair.state.fence, at: at(6), reason: 'The runner is unavailable.', evidence: 'Runner lost the job.' })
  if (advanceBase)
    store.recordObservation({ externalId: 'new-base', observedAt: at(7), source: 'poll', subject: pullRequestItem({ baseSha: 'new-base', mergeState: 'clean', updatedAt: at(7) }) })
  return { store, mapping, repair, review }
}

function sweep(fixture: ReturnType<typeof setup>, baseSha: string, baseChecks: GitHubChecksSnapshot, onRead: () => void = () => undefined) {
  return retireObsoleteBaselineRepairs({ store: fixture.store, repository: fixture.mapping, now: () => new Date(at(9)), github: {
    getDefaultBranchSnapshot: () => {
      onRead()
      return Promise.resolve(ok({ baseSha, baseChecks }))
    },
  } }, new AbortController().signal)
}

function completedRepair(published = false) {
  const fixture = setup(true, false, false)
  if (published) {
    expect(fixture.store.stagePublication({ taskId: fixture.repair.id, workerId: 'baseline', fence: fixture.repair.state.fence, at: at(6), publication: {
      _tag: 'OpenPullRequest',
      taskKind: 'baseline_repair',
      pullRequestNumber: 24,
      pullRequestTitle: 'fix: repair CI',
      pullRequestBody: 'Repair CI.',
      commitSha: 'repair-head',
      baseSha: 'old-base',
      baseRef: 'main',
      expectedHeadSha: 'old-base',
      headRef: 'fix/baseline-ci-old-base',
      artifactRef: 'artifact',
      patchDigest: 'digest',
      changedFiles: 1,
    } })._tag).toBe('Staged')
    const publication = fixture.store.claimNextPublication('publisher', at(6), 600_000)!
    expect(fixture.store.authorizePublication({ commandId: publication.id, workerId: 'publisher', fence: publication.fence, at: at(6) })).toBe(true)
    expect(fixture.store.completePublication({ commandId: publication.id, workerId: 'publisher', fence: publication.fence, at: at(6), pullRequestNumber: 26, evidence: 'Opened repair.' })).toBe(true)
  }
  else {
    expect(fixture.store.completeTask({ taskId: fixture.repair.id, workerId: 'baseline', fence: fixture.repair.state.fence, at: at(6), evidence: 'Existing repair pull request #26.' })).toBe(true)
  }
  fixture.store.recordObservation({ externalId: 'repair-pr', observedAt: at(7), source: 'poll', subject: pullRequestItem({ number: 26, headSha: 'repair-head', headRef: 'fix/baseline-ci-old-base', purpose: { _tag: 'BaselineRepair', baseShaPrefix: 'old-base' }, controllerOwned: true, mergeState: 'clean', baseSha: 'old-base' }) })
  return fixture
}

describe('obsolete Baseline repair attention', () => {
  it.each([false, true])('resumes a same-base waiting Review while its repair pull request stays open, published: %s', async (published) => {
    const fixture = completedRepair(published)
    expect(await sweep(fixture, 'old-base', { _tag: 'Available', checks: [check('success')] })).toEqual(ok(1))
    fixture.store.recordObservation({ externalId: 'original-repeat', observedAt: at(10), source: 'poll', subject: pullRequestItem({ baseSha: 'old-base', mergeState: 'clean' }) })
    const claims = [fixture.store.claimNextAdversarialReviewTask('reviewer', at(11), 600_000)?.id, fixture.store.claimNextAdversarialReviewTask('repair-reviewer', at(11), 600_000)?.id]
    expect(claims).toContain(fixture.review.id)
    expect(fixture.store.getDashboardSnapshot(at(10)).items.find(item => item.number === 26)?.state).toBe('open')
    if (published)
      expect(fixture.store.listOpenAgentPullRequests(fixture.mapping.github).map(pr => pr.pullRequestNumber)).toEqual([26])
  })

  it('keeps completed repair history when no current Review waits on it', async () => {
    const fixture = completedRepair()
    fixture.store.recordObservation({ externalId: 'new-head', observedAt: at(8), source: 'poll', subject: pullRequestItem({ baseSha: 'old-base', headSha: 'new-head', mergeState: 'clean' }) })
    expect(await sweep(fixture, 'old-base', { _tag: 'Available', checks: [check('success')] })).toEqual(ok(0))
    expect(fixture.store.getDashboardSnapshot(at(10)).tasks.find(task => task.id === fixture.repair.id)?.state._tag).toBe('Completed')
  })

  it.each(['writes', 'dismiss', 'cancel', 'policy'] as const)('preserves the %s fence during completed repair recovery', async (fence) => {
    const fixture = completedRepair()
    expect(await sweep(fixture, 'old-base', { _tag: 'Available', checks: [check('success')] }, () => {
      if (fence === 'writes')
        fixture.store.setRepositoryWritesEnabled(fixture.mapping.github, false)
      if (fence === 'dismiss')
        fixture.store.dismissItem({ repository: fixture.mapping.github, itemNumber: 24, at: at(8) })
      if (fence === 'cancel')
        fixture.store.cancelReviewForHead({ repository: fixture.mapping.github, pullRequestNumber: 24, headSha: fixture.review.pullRequest.headSha, requestId: 'cancel-completed-wait', requestedBy: 'harlan-zw', at: at(8) })
      if (fence === 'policy')
        fixture.store.syncRepositories([repositoryMapping({ maxOpenPullRequests: 5 })], at(8))
    })).toEqual(ok(fence === 'cancel' ? 1 : 0))
    const first = fixture.store.claimNextAdversarialReviewTask('reviewer', at(10), 600_000)
    const second = fixture.store.claimNextAdversarialReviewTask('repair-reviewer', at(10), 600_000)
    expect([first?.id, second?.id]).not.toContain(fixture.review.id)
  })

  it('preserves an operator cancellation recorded while Review waits', async () => {
    const fixture = setup(true, false)
    expect(fixture.store.cancelReviewForHead({ repository: fixture.mapping.github, pullRequestNumber: 24, headSha: fixture.review.pullRequest.headSha, requestId: 'operator-cancel', requestedBy: 'harlan-zw', at: at(8) })).toBe(true)
    expect(await sweep(fixture, 'old-base', { _tag: 'Available', checks: [check('success')] })).toEqual(ok(1))
    expect(fixture.store.claimNextAdversarialReviewTask('reviewer', at(10), 600_000)).toBe(null)
    expect(fixture.store.getDashboardSnapshot(at(10)).tasks.find(task => task.id === fixture.review.id)?.state._tag).toBe('Completed')
  })

  it('requires Approval before the resumed Review can start in manual mode', async () => {
    const fixture = setup(true, false)
    fixture.store.setSelectionMode('manual')
    expect(await sweep(fixture, 'old-base', { _tag: 'Available', checks: [check('success')] })).toEqual(ok(1))
    expect(fixture.store.claimNextAdversarialReviewTask('reviewer', at(10), 600_000)).toBe(null)
    expect(fixture.store.approvePullRequest({ repository: fixture.mapping.github, pullRequestNumber: 24, revisionId: fixture.review.revisionId, kind: 'review', at: at(11) })._tag).toBe('Approved')
    expect(fixture.store.claimNextAdversarialReviewTask('reviewer', at(12), 600_000)?.id).toBe(fixture.review.id)
  })

  it('resumes all current Reviews sharing the recovered base commit', async () => {
    const fixture = setup(true, false)
    fixture.store.recordObservation({ externalId: 'second-item', observedAt: at(7), source: 'poll', subject: pullRequestItem({ number: 25, baseSha: 'old-base', mergeState: 'clean' }) })
    const second = fixture.store.claimNextAdversarialReviewTask('second-reviewer', at(7), 600_000)!
    expect(fixture.store.queueBaselineRepairForReview({ taskId: second.id, workerId: 'second-reviewer', fence: second.state.fence, baseSha: 'old-base', at: at(7) })._tag).toBe('Existing')
    expect(fixture.store.completeReviewTask({ taskId: second.id, workerId: 'second-reviewer', fence: second.state.fence, at: at(8), evidence: 'Waiting for shared Baseline repair.', resolution: { _tag: 'WaitingForBaselineRepair', taskId: fixture.repair.id } })).toBe(true)
    expect(await sweep(fixture, 'old-base', { _tag: 'Available', checks: [check('success')] })).toEqual(ok(1))
    const resumed = [fixture.store.claimNextAdversarialReviewTask('reviewer', at(10), 600_000)!.id, fixture.store.claimNextAdversarialReviewTask('second-reviewer', at(10), 600_000)!.id]
    expect(resumed.sort()).toEqual([fixture.review.id, second.id].sort())
  })

  it('resumes a same-base Review when the running Baseline repair verifies recovery', () => {
    const fixture = setup(true, false, false)
    expect(fixture.store.supersedeTask({ taskId: fixture.repair.id, workerId: 'baseline', fence: fixture.repair.state.fence, at: at(9), reason: 'Default branch CI passed.' })).toBe(true)
    expect(fixture.store.claimNextAdversarialReviewTask('reviewer', at(10), 600_000)?.id).toBe(fixture.review.id)
  })

  it('preserves the Review cancellation after recovery and duplicate observations', async () => {
    const fixture = setup(true, false)
    expect(await sweep(fixture, 'old-base', { _tag: 'Available', checks: [check('success')] })).toEqual(ok(1))
    expect(fixture.store.cancelTask({ taskId: fixture.review.id, at: at(10) })._tag).toBe('Cancelled')
    fixture.store.recordObservation({ externalId: 'duplicate', observedAt: at(11), source: 'poll', subject: pullRequestItem({ baseSha: 'old-base', mergeState: 'clean' }) })
    expect(await sweep(fixture, 'old-base', { _tag: 'Available', checks: [check('success')] })).toEqual(ok(0))
    expect(fixture.store.claimNextAdversarialReviewTask('reviewer', at(12), 600_000)).toBe(null)
  })

  it('preserves a newer running Review after the head changes during the branch read', async () => {
    const fixture = setup(true, false)
    let newerId = ''
    expect(await sweep(fixture, 'old-base', { _tag: 'Available', checks: [check('success')] }, () => {
      fixture.store.recordObservation({ externalId: 'new-head', observedAt: at(8), source: 'poll', subject: pullRequestItem({ baseSha: 'old-base', headSha: 'new-head', mergeState: 'clean' }) })
      newerId = fixture.store.claimNextAdversarialReviewTask('new-reviewer', at(8), 600_000)!.id
    })).toEqual(ok(1))
    const tasks = fixture.store.getDashboardSnapshot(at(10)).tasks
    expect(tasks.find(task => task.id === newerId)?.state._tag).toBe('Running')
    expect(tasks.find(task => task.id === fixture.review.id)?.state._tag).toBe('Completed')
    expect(fixture.store.claimNextAdversarialReviewTask('reviewer', at(10), 600_000)).toBe(null)
  })

  it.each(['ActionRequired', 'Completed'] as const)('keeps a saved same-head verdict when %s Baseline repair recovers', async (state) => {
    const fixture = state === 'Completed' ? completedRepair() : setup(true, false)
    if (state === 'Completed')
      fixture.store.claimNextAdversarialReviewTask('repair-reviewer', at(8), 600_000)
    const passed = { _tag: 'Passed' as const, evidence: [{ label: 'verified', sha256: 'a'.repeat(64) }] }
    expect(fixture.store.recordReviewRun({ id: 'saved-review', repository: fixture.mapping.github, pullRequestNumber: 24, revisionId: fixture.review.revisionId, headSha: fixture.review.pullRequest.headSha, provider: 'codex', sessionId: 'saved-session', model: 'gpt-5.6-sol', agentVersion: '0.0.0', skillDigest: 'c'.repeat(64), startedAt: at(2), completedAt: at(7), gates: { merge: passed, review: passed, ci: passed }, confidence: 95, findings: [] })._tag).toBe('Inserted')
    expect(fixture.store.recordReviewPublication({ id: 'saved-publication', reviewRunId: 'saved-review', body: '### READY', at: at(8), result: { _tag: 'Published', githubCommentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' } })._tag).toBe('Inserted')
    expect(await sweep(fixture, 'old-base', { _tag: 'Available', checks: [check('success')] })).toEqual(ok(1))
    expect(fixture.store.claimNextAdversarialReviewTask('reviewer', at(10), 600_000)).toBe(null)
    expect(fixture.store.listReviewGateRefreshes().map(refresh => refresh.reviewRunId)).toEqual(['saved-review'])
    expect(fixture.store.getDashboardSnapshot(at(10)).queue.some(entry => entry.state._tag === 'Pending' && entry.state.reason === 'Waiting for Baseline repair.')).toBe(false)
  })

  it('resumes the dependent Review when the same base becomes green', async () => {
    const fixture = setup(true, false)
    expect(await sweep(fixture, 'old-base', { _tag: 'Available', checks: [check('success')] })).toEqual(ok(1))
    const resumed = fixture.store.claimNextAdversarialReviewTask('reviewer', at(10), 600_000)
    expect(resumed?.id).toBe(fixture.review.id)
    expect(resumed?.state.fence).toBe(fixture.review.state.fence + 1)
    expect(fixture.store.failWorkerTask({ taskId: resumed!.id, workerId: 'reviewer', fence: resumed!.state.fence, at: at(11), reason: 'GitHub timed out.' })).toBe('Retrying')
    const retry = fixture.store.claimNextAdversarialReviewTask('reviewer', at(12), 600_000)!
    expect(fixture.store.failWorkerTask({ taskId: retry.id, workerId: 'reviewer', fence: retry.state.fence, at: at(13), reason: 'GitHub timed out.' })).toBe('Retrying')
    expect(fixture.store.claimNextAdversarialReviewTask('reviewer', at(14), 600_000)?.id).toBe(fixture.review.id)
  })

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
    expect(fixture.store.listBaselineRepairRetirementCandidates(fixture.mapping.github)[0]?.taskId).toBe(fixture.repair.id)
    expect(fixture.store.claimNextAdversarialReviewTask('reviewer', at(10), 600_000)).toBe(null)
  })

  it('surfaces unreadable same-base checks and preserves attention', async () => {
    const fixture = setup()
    expect(await sweep(fixture, 'old-base', { _tag: 'Unavailable', reason: 'Checks access failed.' })).toEqual(err('Checks access failed.'))
    expect(fixture.store.listBaselineRepairRetirementCandidates(fixture.mapping.github)[0]?.taskId).toBe(fixture.repair.id)
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
    expect(fixture.store.listBaselineRepairRetirementCandidates(fixture.mapping.github)[0]?.taskId).toBe(fixture.repair.id)
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
      const candidate = fixture.store.listBaselineRepairRetirementCandidates(fixture.mapping.github)[0]!
      expect(fixture.store.retireBaselineRepairCandidate({ candidate, evidence: { _tag: 'BaseChanged', baseSha: 'new-base' }, at: at(8) })).toBe(true)
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
