import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const directories: string[] = []
const reason = 'Could not publish the prepared commit: refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission'
const at = (seconds: number) => new Date(Date.parse('2026-09-07T00:00:00.000Z') + seconds * 1000).toISOString()

afterEach(() => {
  directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
})

function failedForkPublication(failure = reason) {
  const directory = mkdtempSync(join(tmpdir(), 'fork-publication-recovery-'))
  directories.push(directory)
  const path = join(directory, 'state.sqlite')
  const store = openJournalStore(path)
  const subject = pullRequestItem({ author: 'contributor', headRepository: 'contributor/example' })
  store.syncRepositories([repositoryMapping()], at(0))
  const observed = store.recordObservation({ externalId: 'fork', observedAt: at(1), source: 'poll', subject })
  if (observed._tag !== 'Inserted')
    throw new Error('Expected a pull request.')
  store.approvePullRequest({ repository: subject.repository, pullRequestNumber: subject.number, revisionId: observed.revisionId, kind: 'review', at: at(2) })
  store.recordObservation({ externalId: 'approved-fork', observedAt: at(3), source: 'poll', subject })
  const task = store.claimNextConflictTask('agent', at(4), 60_000)
  if (task === null)
    throw new Error('Expected conflict resolution.')
  const staged = store.stagePublication({
    taskId: task.id,
    workerId: 'agent',
    fence: task.state.fence,
    at: at(5),
    publication: {
      _tag: 'UpdatePullRequest',
      taskKind: 'resolve_conflict',
      pullRequestNumber: subject.number,
      expectedHeadSha: subject.headSha,
      headRef: subject.headRef,
      baseSha: subject.baseSha,
      baseRef: 'main',
      commitSha: 'prepared-merge',
      artifactRef: 'refs/harlan-github-agent/publications/saved-merge',
      patchDigest: 'saved-patch',
      changedFiles: 2,
    },
  })
  if (staged._tag !== 'Staged')
    throw new Error('Expected a saved merge.')
  for (let i = 0; i < 3; i++) {
    const command = store.claimNextPublication('publisher', at(6 + i), 60_000)
    if (command === null)
      throw new Error('Expected a publication retry.')
    store.failPublication({ commandId: command.id, workerId: command.workerId, fence: command.fence, at: at(6 + i), reason: failure })
  }
  return { path, store, subject, task, staged }
}

function rewind(path: string) {
  const database = new DatabaseSync(path)
  database.exec('PRAGMA user_version = 65')
  database.close()
}

describe('fork workflow publication recovery', () => {
  it('retries the saved merge once without another Agent turn', () => {
    const { path, store, staged } = failedForkPublication()
    store.close()
    rewind(path)
    const recovered = openJournalStore(path)
    expect(recovered.claimNextConflictTask('agent', at(10), 60_000)).toBeNull()
    const command = recovered.claimNextPublication('publisher', at(10), 60_000)
    expect(command).toMatchObject({ id: staged.commandId, commitSha: 'prepared-merge', artifactRef: 'refs/harlan-github-agent/publications/saved-merge' })
    if (command === null)
      throw new Error('Expected the saved merge.')
    expect(recovered.authorizePublication({ commandId: command.id, workerId: command.workerId, fence: command.fence, at: at(11) })).toBe(true)
    recovered.completePublication({ commandId: command.id, workerId: command.workerId, fence: command.fence, at: at(11), evidence: 'Published prepared-merge.' })
    expect(recovered.listIncidents()).toEqual([])
    recovered.close()
    const restarted = openJournalStore(path)
    expect(restarted.claimNextPublication('publisher', at(12), 60_000)).toBeNull()
    restarted.close()
  })

  it.each(['changed head', 'dismissed', 'different failure', 'later failure'] as const)('leaves a %s untouched', (scenario) => {
    const { path, store, subject } = failedForkPublication(scenario === 'different failure' ? 'Branch protection rejected this push.' : reason)
    if (scenario === 'changed head')
      store.recordObservation({ externalId: 'new-head', observedAt: at(9), source: 'poll', subject: { ...subject, headSha: 'contributor-push' } })
    if (scenario === 'dismissed')
      store.dismissItem({ repository: subject.repository, itemNumber: subject.number, at: at(9) })
    store.close()
    rewind(path)
    if (scenario === 'later failure') {
      const database = new DatabaseSync(path)
      database.prepare('UPDATE tasks SET reason = ? WHERE kind = ?').run('A later repair requires a human decision.', 'resolve_conflict')
      database.close()
    }
    const recovered = openJournalStore(path)
    expect(recovered.claimNextPublication('publisher', at(10), 60_000)).toBeNull()
    recovered.close()
  })

  it('does not renew the retry budget on another restart', () => {
    const { path, store } = failedForkPublication()
    store.close()
    rewind(path)
    const recovered = openJournalStore(path)
    for (let i = 0; i < 3; i++) {
      const command = recovered.claimNextPublication('publisher', at(10 + i), 60_000)
      if (command === null)
        throw new Error('Expected the bounded publication retry.')
      recovered.failPublication({ commandId: command.id, workerId: command.workerId, fence: command.fence, at: at(10 + i), reason })
    }
    recovered.close()
    const restarted = openJournalStore(path)
    expect(restarted.claimNextPublication('publisher', at(15), 60_000)).toBeNull()
    expect(restarted.claimNextConflictTask('agent', at(15), 60_000)).toBeNull()
    restarted.close()
  })

  it('requires exact Approval when it claims a saved fork merge', () => {
    const { path, store } = failedForkPublication()
    store.close()
    rewind(path)
    const recovered = openJournalStore(path)
    recovered.close()
    // Represents authority revoked after migration, before the publisher runs.
    const database = new DatabaseSync(path)
    database.exec('DELETE FROM pull_request_approvals')
    database.close()
    const restarted = openJournalStore(path)
    expect(restarted.claimNextPublication('publisher', at(15), 60_000)).toBeNull()
    restarted.close()
  })

  it('carries Approval only to the conflict merge the controller published', () => {
    const { path, store, subject } = failedForkPublication()
    store.close()
    rewind(path)
    const recovered = openJournalStore(path)
    const command = recovered.claimNextPublication('publisher', at(10), 60_000)
    if (command === null)
      throw new Error('Expected the saved merge.')
    recovered.completePublication({ commandId: command.id, workerId: command.workerId, fence: command.fence, at: at(11), evidence: 'Published prepared-merge.' })
    recovered.recordObservation({ externalId: 'published-head', observedAt: at(12), source: 'poll', subject: { ...subject, headSha: command.commitSha, mergeState: 'clean' } })
    const approval = () => {
      const item = recovered.getDashboardSnapshot(at(13)).items.find(item => item.repository === subject.repository && item.number === subject.number)
      return item?.kind === 'pull_request' ? item.approval : undefined
    }
    expect(approval()).toMatchObject({ _tag: 'ReviewApproved' })
    recovered.recordObservation({ externalId: 'unapproved-head', observedAt: at(14), source: 'poll', subject: { ...subject, headSha: 'unrelated-push', mergeState: 'clean' } })
    expect(approval()).toMatchObject({ _tag: 'ReviewRequired' })
    recovered.close()
  })
})
