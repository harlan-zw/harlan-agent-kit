import type { ReviewGates } from '../src/types.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createAutoMergeController, openJournalStore } from '../src/index.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()))

const gates: ReviewGates = {
  merge: { _tag: 'Passed', evidence: [{ label: 'merge', sha256: 'a'.repeat(64) }] },
  review: { _tag: 'Passed', evidence: [{ label: 'review', sha256: 'b'.repeat(64) }] },
  ci: { _tag: 'Passed', evidence: [{ label: 'ci', sha256: 'c'.repeat(64) }] },
}
const ready = {
  repository: 'harlan-zw/example',
  pullRequestNumber: 24,
  headSha: 'abc123',
  provider: 'codex' as const,
  sessionId: 'session',
  model: 'gpt-5.6',
  agentVersion: '1.2.3',
  skillDigest: 'd'.repeat(64),
  startedAt: '2026-08-13T01:01:00.000Z',
  completedAt: '2026-08-13T01:02:00.000Z',
  gates,
  confidence: 100,
  findings: [],
}

describe('review target branch authority', () => {
  it('requires a new Review after retargeting, including after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'harlan-review-target-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const path = join(directory, 'journal.sqlite')
    const repository = repositoryMapping()
    const child = pullRequestItem({ mergeState: 'clean', autoMerge: true, baseRef: 'fix/parent', baseSha: 'parent-v1' })
    const before = openJournalStore(path, true)
    before.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    before.setRepositoryWritesEnabled(repository.github, true)
    before.recordObservation({ externalId: 'before', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject: child })
    const task = before.claimNextAdversarialReviewTask('reviewer', '2026-08-13T01:00:30.000Z', 60 * 60_000)
    if (task === null)
      throw new Error('Expected the first Review.')
    before.recordReviewRun({ ...ready, id: 'parent-review', revisionId: task.revisionId })
    before.completeReviewTask({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:02:30.000Z',
      evidence: 'parent-review',
      resolution: { _tag: 'Reviewed', reviewRunId: 'parent-review' },
    })
    before.recordReviewPublication({
      id: 'parent-publication',
      reviewRunId: 'parent-review',
      body: '### READY',
      at: '2026-08-13T01:03:00.000Z',
      result: { _tag: 'Published', githubCommentId: 42, url: `${child.url}#issuecomment-42` },
    })
    before.close()

    // Parent v2 removed a file after the child forked. The same child head now
    // restores that file in its diff against main. Its old Review cannot cover it.
    const retargeted = { ...child, baseRef: 'main', baseSha: 'squashed-parent-v2' }
    const observed = openJournalStore(path, true)
    observed.recordObservation({ externalId: 'retargeted', observedAt: '2026-08-13T02:00:00.000Z', source: 'poll', subject: retargeted })
    observed.close()
    const restarted = openJournalStore(path, true)
    cleanups.push(() => restarted.close())
    const merges: string[] = []
    const controller = createAutoMergeController({
      policy: { _tag: 'Enabled', minimumConfidence: 100, method: 'squash' },
      store: restarted,
      report: () => {},
      merger: {
        retargetMergedParent: async () => ({ _tag: 'Ok', value: false }),
        merge: async (input) => {
          merges.push(input.expectedHeadSha)
          return { _tag: 'Ok', value: { _tag: 'Merged', sha: 'merged-child' } }
        },
      },
    })
    await controller.reconcile(repository, retargeted, new AbortController().signal)
    expect(merges).toEqual([])
    expect(restarted.storedReviewForHead(repository.github, child.number, child.headSha)).toEqual({ _tag: 'Stale' })
    expect(restarted.listReviewGateRefreshes()).toEqual([])
    const fresh = restarted.claimNextAdversarialReviewTask('reviewer-2', '2026-08-13T02:00:30.000Z', 60 * 60_000)
    expect(fresh?.pullRequest.baseRef).toBe('main')
    if (fresh === null)
      throw new Error('Expected a new Review of the target branch.')
    expect(restarted.recordReviewRun({ ...ready, id: 'main-review', revisionId: fresh.revisionId, completedAt: '2026-08-13T02:02:00.000Z' })._tag).toBe('Inserted')
    const staged = restarted.stageReviewStatus({
      taskKind: 'adversarial_review',
      phase: 'terminal',
      taskId: fresh.id,
      workerId: fresh.state.workerId,
      fence: fresh.state.fence,
      revisionId: fresh.revisionId,
      expectedHeadSha: child.headSha,
      reviewRunId: 'main-review',
      gates,
      body: '### READY',
      desiredOutcome: 'READY',
      at: '2026-08-13T02:03:00.000Z',
    })
    if (staged._tag === 'Rejected')
      throw new Error(staged.reason)
    const publication = restarted.claimReviewStatus(staged.commandId, 'publisher', '2026-08-13T02:03:00.000Z', 60_000)!
    expect(restarted.completeReviewStatus({ commandId: publication.id, workerId: publication.workerId, fence: publication.fence, at: '2026-08-13T02:03:01.000Z', commentId: 43, url: `${child.url}#issuecomment-43` })).toBe(true)
    await controller.reconcile(repository, retargeted, new AbortController().signal)
    expect(merges).toEqual([child.headSha])
  })

  it('requires fresh Review when an upgraded journal already moved legacy evidence to the new target', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'harlan-review-upgrade-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const path = join(directory, 'journal.sqlite')
    const repository = repositoryMapping()
    const child = pullRequestItem({ mergeState: 'clean', autoMerge: true, baseRef: 'fix/parent' })
    const before = openJournalStore(path)
    before.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    before.recordObservation({ externalId: 'legacy-parent', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject: child })
    const task = before.claimNextAdversarialReviewTask('reviewer', '2026-08-13T01:00:30.000Z', 60 * 60_000)
    if (task === null)
      throw new Error('Expected the parent Review.')
    before.recordReviewRun({ ...ready, id: 'legacy-review', revisionId: task.revisionId })
    before.completeReviewTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: ready.completedAt, evidence: 'legacy-review', resolution: { _tag: 'Reviewed', reviewRunId: 'legacy-review' } })
    before.recordReviewPublication({ id: 'legacy-publication', reviewRunId: 'legacy-review', body: '### READY', at: ready.completedAt, result: { _tag: 'Published', githubCommentId: 42, url: `${child.url}#issuecomment-42` } })
    const main = { ...child, baseRef: 'main' }
    const retargeted = before.recordObservation({ externalId: 'legacy-main', observedAt: '2026-08-13T02:00:00.000Z', source: 'poll', subject: main })
    if (retargeted._tag !== 'Inserted')
      throw new Error('Expected the new target Revision.')
    before.close()

    // Version 68 followed the head across target changes and overwrote provenance.
    const legacy = new DatabaseSync(path)
    legacy.prepare('DELETE FROM worker_task_transitions WHERE task_id != ?').run(task.id)
    legacy.prepare('DELETE FROM worker_tasks WHERE id != ?').run(task.id)
    legacy.prepare('UPDATE worker_tasks SET revision_id = ?').run(retargeted.revisionId)
    legacy.prepare('UPDATE review_runs SET revision_id = ?').run(retargeted.revisionId)
    legacy.prepare('UPDATE review_resolutions SET revision_id = ?').run(retargeted.revisionId)
    if ((legacy.prepare('PRAGMA table_info(review_runs)').all() as Array<{ name: string }>).some(column => column.name === 'base_ref'))
      legacy.exec('ALTER TABLE review_runs DROP COLUMN base_ref')
    legacy.exec('PRAGMA user_version = 68')
    legacy.close()

    const upgraded = openJournalStore(path)
    cleanups.push(() => upgraded.close())
    const merges: string[] = []
    const controller = createAutoMergeController({
      policy: { _tag: 'Enabled', minimumConfidence: 100, method: 'squash' },
      store: upgraded,
      report: () => {},
      merger: {
        retargetMergedParent: async () => ({ _tag: 'Ok', value: false }),
        merge: async (input) => {
          merges.push(input.expectedHeadSha)
          return { _tag: 'Ok', value: { _tag: 'Merged', sha: 'merged-child' } }
        },
      },
    })
    expect(upgraded.listReviewRuns(repository.github, child.number)[0]?.baseRef).toBeNull()
    expect(upgraded.storedReviewForHead(repository.github, child.number, child.headSha)).toEqual({ _tag: 'Stale' })
    expect(upgraded.listReviewGateRefreshes()).toEqual([])
    await controller.reconcile(repository, main, new AbortController().signal)
    expect(merges).toEqual([])
    upgraded.recordObservation({ externalId: 'upgraded-main', observedAt: '2026-08-13T03:00:00.000Z', source: 'poll', subject: main })
    expect(upgraded.claimNextAdversarialReviewTask('fresh-reviewer', '2026-08-13T03:00:30.000Z', 60_000)?.pullRequest.baseRef).toBe('main')
  })

  it.each([false, true])('dispatches fresh Review after a trusted comment without journal evidence, legacy completion: %s', (legacyCompletion) => {
    const directory = mkdtempSync(join(tmpdir(), 'harlan-review-comment-'))
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
    const path = join(directory, 'journal.sqlite')
    const repository = repositoryMapping()
    const child = pullRequestItem({
      mergeState: 'clean',
      baseRef: 'fix/parent',
      priorAutomatedReview: { _tag: 'Found', authorLogin: 'harlan-zw', state: 'complete', url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' },
    })
    const before = openJournalStore(path)
    before.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
    before.recordObservation({ externalId: 'comment-parent', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject: child })
    before.recordObservation({ externalId: 'comment-main', observedAt: '2026-08-13T02:00:00.000Z', source: 'poll', subject: { ...child, baseRef: 'main' } })
    if (legacyCompletion) {
      const task = before.claimNextAdversarialReviewTask('legacy-reviewer', '2026-08-13T02:00:01.000Z', 60_000)
      if (task === null)
        throw new Error('Expected the Review Task.')
      before.completeReviewTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: '2026-08-13T02:00:02.000Z', evidence: 'Trusted comment', resolution: { _tag: 'ExistingReview', url: child.url } })
    }
    before.close()
    const restarted = openJournalStore(path)
    cleanups.push(() => restarted.close())
    restarted.recordObservation({ externalId: 'comment-restart', observedAt: '2026-08-13T02:00:03.000Z', source: 'poll', subject: { ...child, baseRef: 'main' } })
    expect(restarted.claimNextAdversarialReviewTask('fresh-reviewer', '2026-08-13T02:00:30.000Z', 60_000)?.pullRequest.baseRef).toBe('main')
  })

  it('rejects a running Review result when its target branch changed', () => {
    const store = openJournalStore(':memory:')
    cleanups.push(() => store.close())
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const child = pullRequestItem({ mergeState: 'clean', baseRef: 'fix/parent' })
    store.recordObservation({ externalId: 'running', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject: child })
    const task = store.claimNextAdversarialReviewTask('reviewer', '2026-08-13T01:00:30.000Z', 60 * 60_000)
    if (task === null)
      throw new Error('Expected the running Review.')
    store.recordObservation({ externalId: 'changed', observedAt: '2026-08-13T01:01:00.000Z', source: 'poll', subject: { ...child, baseRef: 'main' } })
    expect(store.recordReviewRun({ ...ready, id: 'late-review', revisionId: task.revisionId })).toEqual({
      _tag: 'Rejected',
      reason: { _tag: 'RevisionMismatch' },
    })
  })
})
