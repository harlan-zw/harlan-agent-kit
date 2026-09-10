import type { PreparedPublication } from '../src/types.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { MAXIMUM_RECOVERY_ATTEMPTS } from '../src/failure.ts'
import { openJournalStore } from '../src/store.ts'
import { issueItem, repositoryMapping } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
const directories: string[] = []
afterEach(() => {
  stores.splice(0).forEach(store => store.close())
  directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
})
const at = (second: number) => new Date(Date.parse('2026-09-08T01:00:00Z') + second * 1000).toISOString()

function readyIssues(numbers = [12], path = ':memory:') {
  const store = openJournalStore(path)
  stores.push(store)
  store.syncRepositories([repositoryMapping()], at(0))
  const issues = numbers.map(number => issueItem({ number, author: 'harlan-zw' }))
  for (const issue of issues) {
    store.recordObservation({ externalId: `issue-${issue.number}`, observedAt: at(1), source: 'poll', subject: issue })
    const triage = store.claimNextIssueTriageTask('triage', at(2), 600_000)!
    store.completeWorkerTask({ taskId: triage.id, workerId: 'triage', fence: triage.state.fence, at: at(3 + numbers.indexOf(issue.number)), evidence: JSON.stringify({ _tag: 'READY_TO_IMPLEMENT' }) })
  }
  return { store, issues }
}

function databasePath() {
  const directory = mkdtempSync(join(tmpdir(), 'issue-handoffs-'))
  directories.push(directory)
  return join(directory, 'state.sqlite')
}

function reopen(store: ReturnType<typeof openJournalStore>, path: string) {
  stores.splice(stores.indexOf(store), 1)
  store.close()
  const reopened = openJournalStore(path)
  stores.push(reopened)
  return reopened
}

function publish(store: ReturnType<typeof openJournalStore>, second = 5, combinedIssueNumbers: number[] = []) {
  const task = store.claimNextIssueWorkTask('implementer', at(second), 600_000)!
  const publication: PreparedPublication & { combinedIssueNumbers: number[] } = {
    _tag: 'OpenPullRequest',
    taskKind: 'issue_work',
    issueNumber: task.issueNumber,
    pullRequestTitle: 'fix: repair the issue',
    pullRequestBody: `Closes #${task.issueNumber}.\n${combinedIssueNumbers.map(n => `Closes #${n}.`).join('\n')}`,
    diagram: null,
    commitSha: `commit-${second}`,
    baseSha: `base-${second}`,
    baseRef: 'main',
    expectedHeadSha: `base-${second}`,
    headRef: `fix/issue-${task.issueNumber}`,
    artifactRef: `refs/artifact-${second}`,
    patchDigest: `patch-${second}`,
    changedFiles: 1,
    combinedIssueNumbers,
  }
  expect(store.stagePublication({ taskId: task.id, workerId: 'implementer', fence: task.state.fence, at: at(second + 1), publication })._tag).toBe('Staged')
  const command = store.claimNextPublication('publisher', at(second + 2), 600_000)!
  return { task, command }
}

describe('issue work handoffs', () => {
  it('retries the same approved issue after the base changes before publication', () => {
    const { store, issues: [issue] } = readyIssues()
    const { task, command } = publish(store)
    store.supersedePublication({ commandId: command.id, workerId: 'publisher', fence: command.fence, at: at(8), reason: 'The base branch changed before publication.' })

    store.recordObservation({ externalId: 'issue-12', observedAt: at(9), source: 'poll', subject: issue! })

    expect(store.claimNextIssueWorkTask('retry', at(10), 600_000)).toMatchObject({ id: task.id, state: { _tag: 'Running' } })
    expect(store.getDashboardSnapshot(at(10)).queue[0]?.state).toEqual({ _tag: 'Active', work: 'issue_work' })
  })

  it('bounds repeated base changes and reports the actual stop reason', () => {
    const { store, issues: [issue] } = readyIssues()
    for (let round = 0; round <= MAXIMUM_RECOVERY_ATTEMPTS; round++) {
      const second = 5 + round * 10
      const { command } = publish(store, second)
      store.supersedePublication({ commandId: command.id, workerId: 'publisher', fence: command.fence, at: at(second + 3), reason: 'The base branch changed before publication.' })
      store.recordObservation({ externalId: 'issue-12', observedAt: at(second + 4), source: 'poll', subject: issue! })
    }

    expect(store.claimNextIssueWorkTask('retry', at(100), 600_000)).toBeNull()
    expect(store.getDashboardSnapshot(at(100)).queue[0]?.state).toMatchObject({ _tag: 'ActionRequired', reason: expect.stringContaining('base branch') })
  })

  it('keeps a dashboard cancellation terminal and does not ask for approval', () => {
    const { store, issues: [issue] } = readyIssues()
    const task = store.getDashboardSnapshot(at(4)).tasks.find(t => t.kind === 'issue_work')!
    store.cancelTask({ taskId: task.id, at: at(5) })
    store.recordObservation({ externalId: 'issue-12', observedAt: at(6), source: 'poll', subject: issue! })

    expect(store.claimNextIssueWorkTask('retry', at(7), 600_000)).toBeNull()
    expect(store.getDashboardSnapshot(at(7)).queue[0]?.state).toEqual({ _tag: 'Pending', reason: 'Cancelled from the dashboard.' })
  })

  it('shows the confirmed pull request instead of waiting for GitHub', () => {
    const { store } = readyIssues()
    const { command } = publish(store)
    const evidence = 'Opened pull request #24: https://github.com/harlan-zw/example/pull/24.'
    store.completePublication({ commandId: command.id, workerId: 'publisher', fence: command.fence, at: at(8), evidence, pullRequestNumber: 24 })

    expect(store.getDashboardSnapshot(at(9)).queue[0]?.state).toEqual({ _tag: 'Pending', reason: evidence })
  })

  it('holds related issues until the pull request is confirmed', () => {
    const { store } = readyIssues([12, 13])
    const { command } = publish(store, 5, [13])

    expect(store.claimNextIssueWorkTask('other', at(8), 600_000)).toBeNull()
    expect(store.getDashboardSnapshot(at(8)).queue.find(entry => entry.number === 13)?.state)
      .toEqual({ _tag: 'Pending', reason: 'Waiting for the combined pull request for issue #12 to publish.' })
    const evidence = 'Opened pull request #24: https://github.com/harlan-zw/example/pull/24.'
    store.completePublication({ commandId: command.id, workerId: 'publisher', fence: command.fence, at: at(9), evidence, pullRequestNumber: 24 })
    expect(store.getDashboardSnapshot(at(10)).tasks.filter(t => t.kind === 'issue_work').map(t => t.state))
      .toEqual([{ _tag: 'Completed', evidence }, { _tag: 'Completed', evidence }])
  })

  it('retains the combined publication across a restart and prevents a second Batch claiming it', () => {
    const path = databasePath()
    const { store } = readyIssues([12, 13, 14], path)
    publish(store, 5, [13, 14])
    const restarted = reopen(store, path)

    expect(restarted.planBatches(at(8))).toEqual([])
    expect(restarted.claimNextIssueWorkTask('other', at(8), 600_000)).toBeNull()
    const command = restarted.claimNextPublication('new-publisher', at(700), 600_000)!
    restarted.completePublication({ commandId: command.id, workerId: 'new-publisher', fence: command.fence, at: at(701), evidence: 'Opened pull request #24.', pullRequestNumber: 24 })
    expect(restarted.getDashboardSnapshot(at(702)).tasks.filter(t => t.kind === 'issue_work').map(t => t.state))
      .toEqual(Array.from({ length: 3 }, () => ({ _tag: 'Completed', evidence: 'Opened pull request #24.' })))
  })

  it('revokes an unpublished change when a combined issue is cancelled', () => {
    const { store } = readyIssues([12, 13])
    const { command } = publish(store, 5, [13])
    const companion = store.getDashboardSnapshot(at(8)).tasks.find(t => t.kind === 'issue_work' && t.issueNumber === 13)!
    store.cancelTask({ taskId: companion.id, at: at(8) })

    expect(store.authorizePublication({ commandId: command.id, workerId: 'publisher', fence: command.fence, at: at(9) })).toBe(false)
    expect(store.claimNextPublication('retry', at(700), 600_000)).toBeNull()
    expect(store.getDashboardSnapshot(at(701)).tasks.find(t => t.id === companion.id)?.state)
      .toEqual({ _tag: 'Superseded', reason: 'Cancelled from the dashboard.' })
  })

  it('recovers a legacy Batch companion that was completed before publication', () => {
    const path = databasePath()
    const { store, issues } = readyIssues([12, 13], path)
    const [planned] = store.planBatches(at(4))
    const batch = store.claimNextBatch('batch', at(5), 600_000)!
    const units = store.recordBatchPlan({ batchId: planned!.batchId, workerId: 'batch', fence: batch.state.fence, at: at(6), units: [{ issueNumbers: [12, 13], dependsOn: null, rationale: 'One repair.' }] })
    if (units._tag === 'Err')
      throw new Error(units.error)
    const primary = store.claimBatchUnitTask({ unitId: units.value[0]!.id, workerId: 'batch', now: at(7), leaseMilliseconds: 600_000 })!
    store.stagePublication({ taskId: primary.id, workerId: 'batch', fence: primary.state.fence, at: at(8), publication: {
      _tag: 'OpenPullRequest',
      taskKind: 'issue_work',
      issueNumber: 12,
      pullRequestTitle: 'fix: both issues',
      pullRequestBody: 'Closes #12.\nCloses #13.',
      diagram: null,
      commitSha: 'repair',
      baseSha: 'old-base',
      baseRef: 'main',
      expectedHeadSha: 'old-base',
      headRef: 'fix/issue-12',
      artifactRef: 'refs/repair',
      patchDigest: 'patch',
      changedFiles: 1,
    } })
    const command = store.claimNextPublication('publisher', at(9), 600_000)!
    store.supersedePublication({ commandId: command.id, workerId: 'publisher', fence: command.fence, at: at(10), reason: 'The base branch changed before publication.' })
    store.completeBatch({ batchId: batch.id, workerId: 'batch', fence: batch.state.fence, at: at(11) })
    stores.splice(stores.indexOf(store), 1)
    store.close()
    // Reconstruct the old on-disk state as the migration's input.
    const legacy = new DatabaseSync(path)
    legacy.exec('UPDATE tasks SET state_tag = \'Completed\', evidence = \'Closed by the pull request for issue #12 in the same Batch.\' WHERE kind = \'issue_work\' AND state_tag = \'Queued\'; DROP TABLE combined_issue_publications; PRAGMA user_version = 66;')
    legacy.close()

    const migrated = openJournalStore(path)
    stores.push(migrated)
    for (const issue of issues)
      migrated.recordObservation({ externalId: `issue-${issue.number}`, observedAt: at(12), source: 'poll', subject: issue })
    expect(migrated.getDashboardSnapshot(at(13)).tasks.filter(t => t.kind === 'issue_work').map(t => t.state))
      .toEqual([{ _tag: 'Queued' }, { _tag: 'Queued' }])
    expect(migrated.claimNextIssueWorkTask('retry', at(14), 600_000)).not.toBeNull()
  })

  it('releases related issues when publication is refused', () => {
    const { store } = readyIssues([12, 13])
    const { command } = publish(store, 5, [13])
    store.supersedePublication({ commandId: command.id, workerId: 'publisher', fence: command.fence, at: at(8), reason: 'The base branch changed before publication.' })

    expect(store.claimNextIssueWorkTask('other', at(9), 600_000)?.issueNumber).toBe(13)
  })

  it('shows the next action for Ready to spec', () => {
    const store = openJournalStore(':memory:')
    stores.push(store)
    store.syncRepositories([repositoryMapping()], at(0))
    store.recordObservation({ externalId: 'spec', observedAt: at(1), source: 'poll', subject: issueItem({ author: 'harlan-zw' }) })
    const task = store.claimNextIssueTriageTask('triage', at(2), 600_000)!
    store.completeWorkerTask({ taskId: task.id, workerId: 'triage', fence: task.state.fence, at: at(3), evidence: JSON.stringify({ _tag: 'READY_TO_SPEC', nextAction: 'Decide the discovery spending limit.' }) })

    expect(store.claimNextIssueWorkTask('implementer', at(4), 600_000)).toBeNull()
    expect(store.getDashboardSnapshot(at(4)).queue[0]?.state).toEqual({ _tag: 'ActionRequired', reason: 'Ready to spec. Decide the discovery spending limit.' })
  })
})
