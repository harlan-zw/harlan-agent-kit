import { afterEach, describe, expect, it } from 'vitest'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []

afterEach(() => {
  stores.splice(0).forEach(store => store.close())
})

function runningConflict() {
  const store = openJournalStore(':memory:', true)
  stores.push(store)
  const repository = repositoryMapping()
  store.syncRepositories([repository], '2026-09-02T00:00:00.000Z')
  store.setRepositoryWritesEnabled(repository.github, true)
  const pullRequest = pullRequestItem()
  store.recordObservation({ externalId: 'conflicting', observedAt: '2026-09-02T00:01:00.000Z', source: 'poll', subject: pullRequest })
  const task = store.claimNextConflictTask('conflict-worker', '2026-09-02T00:02:00.000Z', 60_000)
  if (task === null || task.pullRequest.baseRef === undefined)
    throw new Error('Expected a conflict resolution Task with a base branch.')
  const stage = () => store.stagePublication({
    taskId: task.id,
    workerId: task.state.workerId,
    fence: task.state.fence,
    at: '2026-09-02T00:02:30.000Z',
    publication: {
      _tag: 'UpdatePullRequest',
      taskKind: 'resolve_conflict',
      pullRequestNumber: task.pullRequestNumber,
      commitSha: 'resolved-commit',
      baseSha: task.pullRequest.baseSha,
      baseRef: task.pullRequest.baseRef!,
      expectedHeadSha: task.pullRequest.headSha,
      headRef: task.pullRequest.headRef,
      artifactRef: 'resolved-artifact',
      patchDigest: 'resolved-patch',
      changedFiles: 1,
    },
  })
  return { store, pullRequest, stage }
}

describe('conflict resolution under unresolved mergeability', () => {
  it('keeps a running resolution when GitHub reads unknown on the same head and base', () => {
    const { store, pullRequest, stage } = runningConflict()

    store.recordObservation({ externalId: 'unknown', observedAt: '2026-09-02T00:02:10.000Z', source: 'poll', subject: { ...pullRequest, mergeState: 'unknown' } })

    expect(stage()._tag).toBe('Staged')
  })

  it('still retires a running resolution when the base branch moves', () => {
    const { store, pullRequest, stage } = runningConflict()

    store.recordObservation({ externalId: 'base-moved', observedAt: '2026-09-02T00:02:10.000Z', source: 'poll', subject: { ...pullRequest, baseSha: 'base456', mergeState: 'unknown' } })

    expect(stage()._tag).not.toBe('Staged')
  })
})
