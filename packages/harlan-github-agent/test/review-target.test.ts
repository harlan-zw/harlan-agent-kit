import type { ReviewGates } from '../src/types.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    restarted.recordReviewPublication({
      id: 'main-publication',
      reviewRunId: 'main-review',
      body: '### READY',
      at: '2026-08-13T02:03:00.000Z',
      result: { _tag: 'Published', githubCommentId: 43, url: `${child.url}#issuecomment-43` },
    })
    await controller.reconcile(repository, retargeted, new AbortController().signal)
    expect(merges).toEqual([child.headSha])
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
