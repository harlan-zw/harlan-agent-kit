import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { reconcileRepository } from '../src/reconcile.ts'
import { ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { runCompletionTask } from '../src/take-ownership-completion.ts'
import { issueItem, pullRequestItem, repositoryMapping } from './fixtures.ts'

const at = (second: number) => new Date(Date.parse('2026-10-05T00:00:00Z') + second * 1000).toISOString()
const repository = repositoryMapping({ checkout: '/home/harlan/sites/example', takeOwnership: {
  _tag: 'Enabled',
  productionUrl: 'https://example.com',
  requiredWorkflows: ['deploy.yml'],
  smokePaths: ['/health'],
} })

function published(store: ReturnType<typeof openJournalStore>) {
  store.syncRepositories([repository], at(0))
  store.setRepositoryWritesEnabled(repository.github, true)
  store.recordPollObservation({ observedAt: at(1), subject: issueItem({ author: 'harlan-zw' }) })
  const triage = store.claimNextIssueTriageTask('triage', at(2), 600_000)!
  store.completeWorkerTask({ taskId: triage.id, workerId: 'triage', fence: triage.state.fence, at: at(3), evidence: JSON.stringify({ _tag: 'READY_TO_IMPLEMENT' }) })
  const task = store.claimNextIssueWorkTask('implementer', at(4), 600_000)!
  const staged = store.stagePublication({ taskId: task.id, workerId: 'implementer', fence: task.state.fence, at: at(5), publication: {
    _tag: 'OpenPullRequest',
    taskKind: 'issue_work',
    issueNumber: 12,
    pullRequestTitle: 'fix: repair the issue',
    pullRequestBody: 'Closes #12.',
    diagram: null,
    commitSha: 'h'.repeat(40),
    baseSha: 'b'.repeat(40),
    baseRef: 'main',
    expectedHeadSha: 'b'.repeat(40),
    headRef: 'fix/issue-12',
    artifactRef: 'refs/artifact',
    patchDigest: 'digest',
    changedFiles: 1,
  } })
  expect(staged._tag).toBe('Staged')
  const command = store.claimNextPublication('publisher', at(6), 600_000)!
  expect(store.completePublication({ commandId: command.id, workerId: 'publisher', fence: command.fence, at: at(7), evidence: 'Opened pull request #24.', pullRequestNumber: 24 })).toBe(true)
}

function merged(store: ReturnType<typeof openJournalStore>, number = 24) {
  const subject = pullRequestItem({ number, state: 'closed', mergedAt: at(8), updatedAt: at(8), headSha: 'h'.repeat(40), mergeCommitSha: 'm'.repeat(40) })
  const write = store.recordPollObservation({ observedAt: at(9), subject })
  if (write._tag !== 'Inserted' && write._tag !== 'Duplicate')
    throw new Error('The merge observation did not land.')
  return () => store.recordVerifiedPullRequestClosure({ repository: repository.github, pullRequestNumber: number, revisionId: write.revisionId, headSha: subject.headSha, baseSha: subject.baseSha, disposition: { _tag: 'Merged' }, at: at(10) })
}

it('queues only an exactly confirmed Service-created merge, once across restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'completion-'))
  const path = join(directory, 'state.sqlite')
  let store = openJournalStore(path)
  try {
    published(store)
    const confirm = merged(store)
    expect(store.queueCompletionTasks(repository, at(11))).toBe(0)
    expect(confirm()).toBe(true)
    merged(store, 25)()
    expect(store.queueCompletionTasks(repository, at(12))).toBe(1)
    store.close()
    store = openJournalStore(path)
    expect(store.queueCompletionTasks(repository, at(13))).toBe(0)
    expect(store.getDashboardSnapshot(at(13)).completionTasks).toMatchObject([
      { repository: repository.github, target: { pullRequestNumber: 24, mergeSha: 'm'.repeat(40) }, state: { _tag: 'Queued' } },
    ])
  }
  finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('fences old claims and respects repository pause and policy revocation', () => {
  const store = openJournalStore(':memory:')
  try {
    published(store)
    merged(store)()
    store.queueCompletionTasks(repository, at(11))
    store.setRepositoryPaused(repository.github, true)
    expect(store.claimCompletionTask(repository.github, 'first', at(12))).toBeNull()
    store.setRepositoryPaused(repository.github, false)
    const first = store.claimCompletionTask(repository.github, 'first', at(13))!
    expect(store.claimCompletionTask(repository.github, 'second', at(14))).toBeNull()
    const second = store.claimCompletionTask(repository.github, 'second', at(104))!
    expect(store.settleCompletionTask(first, { _tag: 'Pending', reason: 'pending' }, at(105))).toBe(false)
    store.setRepositoryWritesEnabled(repository.github, false)
    expect(store.settleCompletionTask(second, { _tag: 'Completed', evidence: { mergeSha: first.target.mergeSha, workflows: [], smoke: [] } }, at(106))).toBe(false)
  }
  finally { store.close() }
})

it('resumes Pending delivery, then stores workflow and smoke evidence', async () => {
  const store = openJournalStore(':memory:')
  let seconds = 11
  let delivered = false
  let smokeRequests = 0
  try {
    published(store)
    merged(store)()
    const options = { repository, store, workerId: 'completion', now: () => new Date(at(seconds)), source: {
      workflows: async () => ok(delivered
        ? [{ id: 1, path: '.github/workflows/deploy.yml', sha: 'm'.repeat(40), branch: 'main', event: 'push', status: 'completed', conclusion: 'success', url: 'https://github.com/run/1' }]
        : []),
      smoke: async () => {
        smokeRequests++
        return ok(200)
      },
    } }
    await runCompletionTask(options, new AbortController().signal)
    expect(store.listCompletionTasks()[0]).toMatchObject({ state: { _tag: 'Queued' } })
    seconds = 72
    delivered = true
    await runCompletionTask(options, new AbortController().signal)
    expect(store.listCompletionTasks()[0]).toMatchObject({ state: { _tag: 'Completed', evidence: { mergeSha: 'm'.repeat(40) } } })
    expect(smokeRequests).toBe(1)
    seconds = 140
    await runCompletionTask(options, new AbortController().signal)
    expect(smokeRequests).toBe(1)
  }
  finally { store.close() }
})

it('recovers a published pull request that merged before the first observation', async () => {
  const store = openJournalStore(':memory:')
  let reads = 0
  try {
    published(store)
    const github = {
      listOpenItems: async () => ok([]),
      getIssue: async () => ok(issueItem({ state: 'closed' })),
      getPullRequest: async () => {
        reads++
        return ok(pullRequestItem({ state: 'closed', mergedAt: at(8), updatedAt: at(8), mergeCommitSha: 'm'.repeat(40) }))
      },
    }
    expect((await reconcileRepository(repository, { github, store, now: () => new Date(at(11)) }))._tag).toBe('Ok')
    expect(store.queueCompletionTasks(repository, at(12))).toBe(1)
    await reconcileRepository(repository, { github, store, now: () => new Date(at(13)) })
    expect(reads).toBe(1)
  }
  finally { store.close() }
})

it('bounds Pending checks and retires a changed policy without repeating Completion', () => {
  const store = openJournalStore(':memory:')
  try {
    published(store)
    merged(store)()
    store.queueCompletionTasks(repository, at(11))
    const task = store.claimCompletionTask(repository.github, 'completion', at(86412))!
    expect(store.settleCompletionTask(task, { _tag: 'Pending', reason: 'No deploy run.' }, at(86413))).toBe(true)
    expect(store.listCompletionTasks()[0]?.state).toEqual({ _tag: 'ActionRequired', reason: 'Completion exceeded 24 hours. No deploy run.' })
    expect(store.claimCompletionTask(repository.github, 'completion', at(86500))).toBeNull()
  }
  finally { store.close() }
})

it('retires queued work when Take Ownership is disabled', () => {
  const store = openJournalStore(':memory:')
  try {
    published(store)
    merged(store)()
    store.queueCompletionTasks(repository, at(11))
    const disabled = { ...repository, takeOwnership: { _tag: 'Disabled' as const } }
    store.syncRepositories([disabled], at(12))
    expect(store.queueCompletionTasks(disabled, at(13))).toBe(0)
    expect(store.listCompletionTasks()[0]?.state).toEqual({ _tag: 'ActionRequired', reason: 'Take Ownership policy changed. Check delivery for this pull request.' })
    expect(store.claimCompletionTask(repository.github, 'completion', at(14))).toBeNull()
  }
  finally { store.close() }
})
