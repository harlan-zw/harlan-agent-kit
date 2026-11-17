import type { GitHubPullRequestItem, RepositoryMapping } from '../src/types.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { MAXIMUM_RECOVERY_ATTEMPTS } from '../src/failure.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
const directories: string[] = []
const at = (seconds: number) => new Date(Date.parse('2026-11-18T00:00:00.000Z') + seconds * 1000).toISOString()

afterEach(() => {
  stores.splice(0).forEach(store => store.close())
  directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
})

function setup(path = ':memory:', mutationsEnabled = true) {
  const store = openJournalStore(path, mutationsEnabled)
  stores.push(store)
  const mapping = repositoryMapping()
  store.syncRepositories([mapping], at(0))
  store.setRepositoryWritesEnabled(mapping.github, true)
  const subject = pullRequestItem()
  const observed = store.recordObservation({ externalId: 'initial', observedAt: at(0), source: 'poll', subject })
  if (observed._tag !== 'Inserted')
    throw new Error('Expected a new pull request.')
  const task = store.claimNextConflictTask('first-agent', at(1), 60_000)
  if (task === null)
    throw new Error('Expected the first conflict Task.')
  store.needsAttentionTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: at(2), reason: 'Cargo is unavailable.', evidence: 'Unverified local merge.' })
  const request = (requestId: string, seconds = 3) => ({
    repository: mapping.github,
    pullRequestNumber: subject.number,
    revisionId: observed.revisionId,
    requestId,
    source: 'dashboard' as const,
    requestedBy: 'dashboard',
    at: at(seconds),
  })
  return { store, mapping, subject, task, request }
}

describe('explicit conflict verification retry', () => {
  it('requeues the exact blocked Task with a new fence and no Review Task', () => {
    const { store, task, request } = setup()

    expect(store.requestReviewRerun(request('cargo-fixed'))).toEqual({ _tag: 'Queued', taskId: task.id })
    expect(store.requestReviewRerun(request('cargo-fixed'))).toEqual({ _tag: 'Duplicate', taskId: task.id })
    expect(store.requestReviewRerun(request('second-click'))).toEqual({ _tag: 'AlreadyQueued', taskId: task.id })
    const retried = store.claimNextConflictTask('fresh-agent', at(4), 60_000)!
    expect(retried.id).toBe(task.id)
    expect(retried.state.fence).toBeGreaterThan(task.state.fence)
    expect(store.claimNextAdversarialReviewTask('reviewer', at(4), 60_000)).toBeNull()
    expect(store.needsAttentionTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: at(5), reason: 'Old result', evidence: 'Stale worktree' })).toBe(false)
    expect(store.stagePublication({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: at(5), publication: {
      _tag: 'UpdatePullRequest',
      taskKind: 'resolve_conflict',
      pullRequestNumber: task.pullRequestNumber,
      expectedHeadSha: task.pullRequest.headSha,
      headRef: task.pullRequest.headRef,
      baseRef: task.pullRequest.baseRef!,
      baseSha: task.pullRequest.baseSha,
      commitSha: 'unverified-old-commit',
      artifactRef: 'old-worktree',
      patchDigest: 'old-digest',
      changedFiles: 1,
    } })._tag).toBe('Rejected')
  })

  it('retains request idempotency after the journal reopens', () => {
    const directory = mkdtempSync(join(tmpdir(), 'conflict-retry-'))
    directories.push(directory)
    const path = join(directory, 'journal.sqlite')
    const { store, task, request } = setup(path)
    expect(store.requestReviewRerun(request('durable-retry'))._tag).toBe('Queued')
    stores.splice(stores.indexOf(store), 1)
    store.close()

    const resumed = openJournalStore(path, true)
    stores.push(resumed)
    expect(resumed.requestReviewRerun(request('durable-retry'))).toEqual({ _tag: 'Duplicate', taskId: task.id })
    expect(resumed.claimNextConflictTask('new-process', at(4), 60_000)?.state.fence).toBeGreaterThan(task.state.fence)
  })

  it('retries a blocked Task after upgrading a version 98 journal', () => {
    const directory = mkdtempSync(join(tmpdir(), 'conflict-retry-upgrade-'))
    directories.push(directory)
    const path = join(directory, 'journal.sqlite')
    const { store, task, request } = setup(path)
    stores.splice(stores.indexOf(store), 1)
    store.close()
    const legacy = new DatabaseSync(path)
    legacy.exec('DROP TABLE conflict_retry_requests; PRAGMA user_version = 98;')
    legacy.close()
    const migrated = openJournalStore(path, true)
    stores.push(migrated)

    expect(migrated.requestReviewRerun(request('after-upgrade'))).toEqual({ _tag: 'Queued', taskId: task.id })
    expect(migrated.requestReviewRerun(request('after-upgrade'))).toEqual({ _tag: 'Duplicate', taskId: task.id })
  })

  it('spends the existing retry budget without resetting it', () => {
    const { store, task, request } = setup()
    for (let attempt = 0; attempt < MAXIMUM_RECOVERY_ATTEMPTS; attempt += 1) {
      const seconds = 3 + attempt * 3
      expect(store.requestReviewRerun(request(`retry-${attempt}`, seconds))).toEqual({ _tag: 'Queued', taskId: task.id })
      const claimed = store.claimNextConflictTask('retry-agent', at(seconds + 1), 60_000)!
      expect(store.needsAttentionTask({ taskId: claimed.id, workerId: claimed.state.workerId, fence: claimed.state.fence, at: at(seconds + 2), reason: 'Verification still fails.', evidence: 'Focused check failed.' })).toBe(true)
    }
    expect(store.requestReviewRerun(request('over-budget', 100))).toEqual({ _tag: 'Rejected', reason: { _tag: 'ReviewNotReady' } })
    expect(store.claimNextConflictTask('another-agent', at(101), 60_000)).toBeNull()
  })

  it.each([
    { name: 'disabled conflicts', change: { conflictResolution: false } },
    { name: 'external repository', change: { ownership: 'external' } },
    { name: 'disallowed branch', change: { writablePullRequestHeadPrefixes: ['docs/'] } },
    { name: 'disallowed author', change: { writablePullRequestAuthors: ['another-owner'] } },
  ] satisfies Array<{ name: string, change: Partial<RepositoryMapping> }>)('rejects $name', ({ change }) => {
    const { store, mapping, request } = setup()
    store.syncRepositories([{ ...mapping, ...change }], at(3))
    expect(store.requestReviewRerun(request('authority-revoked', 4))).toEqual({ _tag: 'Rejected', reason: { _tag: 'ReviewNotReady' } })
    expect(store.claimNextConflictTask('new-agent', at(5), 60_000)).toBeNull()
  })

  it.each(['writes', 'pause', 'dismiss', 'cancel', 'review cancellation', 'stop', 'approval'] as const)('keeps %s authority in force', (control) => {
    const { store, mapping, subject, task, request } = setup()
    if (control === 'writes')
      store.setRepositoryWritesEnabled(mapping.github, false)
    if (control === 'pause')
      store.setRepositoryPaused(mapping.github, true)
    if (control === 'dismiss')
      store.dismissItem({ repository: mapping.github, itemNumber: subject.number, at: at(3) })
    if (control === 'cancel')
      store.cancelTask({ taskId: task.id, at: at(3) })
    if (control === 'review cancellation')
      store.cancelReviewForHead({ repository: mapping.github, pullRequestNumber: subject.number, headSha: subject.headSha, requestId: 'cancel-review', requestedBy: 'harlan-zw', at: at(3) })
    if (control === 'stop')
      store.stopReviewForHead({ repository: mapping.github, pullRequestNumber: subject.number, headSha: subject.headSha, at: at(3) })
    if (control === 'approval')
      store.setSelectionMode('manual')
    expect(store.requestReviewRerun(request('must-stay-blocked', 4))).toEqual({ _tag: 'Rejected', reason: { _tag: control === 'stop' ? 'ReviewStopped' : 'ReviewNotReady' } })
  })

  it('requires the global mutation switch', () => {
    const { store, request } = setup(':memory:', false)
    expect(store.requestReviewRerun(request('disabled-service'))).toEqual({ _tag: 'Rejected', reason: { _tag: 'ReviewNotReady' } })
  })

  it.each(['github_comment', 'repair_dispute'] as const)('does not let %s retry conflict work', (source) => {
    const { store, request } = setup()
    expect(store.requestReviewRerun({ ...request('wrong-source'), source, requestedBy: 'harlan-zw' })).toEqual({ _tag: 'Rejected', reason: { _tag: 'ReviewNotReady' } })
  })

  it.each([
    { state: 'closed' },
    { draft: true },
    { headSha: 'replacement-head' },
    { baseRef: 'fix/another-target' },
    { baseSha: 'advanced-base' },
  ] satisfies Array<Partial<GitHubPullRequestItem>>)('rejects a stale exact Revision after %j', (change) => {
    const { store, subject, request } = setup()
    store.recordObservation({ externalId: 'changed', observedAt: at(3), source: 'poll', subject: { ...subject, ...change } })
    expect(store.requestReviewRerun(request('stale-selection', 4))._tag).toBe('Rejected')
  })

  it('keeps current-base work blocked until Control selects its exact Revision', () => {
    const { store, subject, task, request } = setup()
    const observed = store.recordObservation({ externalId: 'base-moved', observedAt: at(3), source: 'poll', subject: { ...subject, baseSha: 'advanced-base' } })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected the advanced base Revision.')

    expect(store.requestReviewRerun({ ...request('fresh-selection', 4), revisionId: observed.revisionId })).toEqual({ _tag: 'Queued', taskId: task.id })
    expect(store.claimNextConflictTask('fresh-agent', at(124), 60_000)?.pullRequest.baseSha).toBe('advanced-base')
  })

  it('requires Approval and maintainer access before retrying a fork', () => {
    const { store, mapping, subject, task, request } = setup()
    const fork = { ...subject, author: 'contributor', headRepository: 'contributor/example' }
    const observed = store.recordObservation({ externalId: 'fork', observedAt: at(3), source: 'poll', subject: fork })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected the fork Revision.')
    const input = { ...request('fork-retry', 4), revisionId: observed.revisionId }
    expect(store.requestReviewRerun(input)).toEqual({ _tag: 'Rejected', reason: { _tag: 'ReviewNotReady' } })
    expect(store.approvePullRequest({ repository: mapping.github, pullRequestNumber: subject.number, revisionId: observed.revisionId, kind: 'review', at: at(5) })._tag).toBe('Approved')
    expect(store.requestReviewRerun({ ...input, at: at(6) })).toEqual({ _tag: 'Queued', taskId: task.id })
    const denied = store.recordObservation({ externalId: 'fork-access-revoked', observedAt: at(7), source: 'poll', subject: { ...fork, maintainerCanModify: false } })
    if (denied._tag !== 'Inserted' && denied._tag !== 'Duplicate')
      throw new Error('Expected the revoked maintainer access Revision.')
    expect(store.requestReviewRerun({ ...input, requestId: 'revoked-fork', revisionId: denied.revisionId, at: at(8) })).toEqual({ _tag: 'Rejected', reason: { _tag: 'ReviewNotReady' } })
  })

  it('leaves an active conflict Agent on its existing lease', () => {
    const { store, task, request } = setup()
    store.requestReviewRerun(request('first-retry'))
    const running = store.claimNextConflictTask('active-agent', at(4), 60_000)!

    expect(store.requestReviewRerun(request('while-running', 5))).toEqual({ _tag: 'AlreadyQueued', taskId: task.id })
    expect(store.claimNextConflictTask('competing-agent', at(6), 60_000)).toBeNull()
    expect(store.heartbeatTask({ taskId: running.id, workerId: running.state.workerId, fence: running.state.fence, at: at(6), leaseMilliseconds: 60_000 })).toBe(true)
  })

  it('does not take an Item from an active owner-requested Repair', () => {
    const { store, subject, request } = setup()
    const clean = store.recordObservation({ externalId: 'clean', observedAt: at(3), source: 'poll', subject: { ...subject, mergeState: 'clean' } })
    if (clean._tag !== 'Inserted')
      throw new Error('Expected the clean Revision.')
    const review = store.claimNextAdversarialReviewTask('reviewer', at(4), 60_000)!
    store.completeWorkerTask({ taskId: review.id, workerId: review.state.workerId, fence: review.state.fence, at: at(5), evidence: 'Review completed.' })
    const change = store.requestPullRequestChange({ ...request('owner-change', 6), revisionId: clean.revisionId, requestedBy: 'harlan-zw', instruction: 'Preserve the new parser ordering.' })
    expect(change._tag).toBe('Queued')
    const repair = store.claimNextReviewFixTask('repair-agent', at(7), 60_000)!
    const conflicting = store.recordObservation({ externalId: 'conflicting-again', observedAt: at(8), source: 'poll', subject })
    if (conflicting._tag !== 'Inserted' && conflicting._tag !== 'Duplicate')
      throw new Error('Expected the conflicting Revision.')

    expect(store.requestReviewRerun({ ...request('competing-retry', 9), revisionId: conflicting.revisionId })).toEqual({ _tag: 'Rejected', reason: { _tag: 'ReviewNotReady' } })
    expect(store.heartbeatTask({ taskId: repair.id, workerId: repair.state.workerId, fence: repair.state.fence, at: at(10), leaseMilliseconds: 60_000 })).toBe(true)
  })
})
