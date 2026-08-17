import { describe, expect, it } from 'vitest'
import { createPublicationScheduler } from '../src/publication-scheduler.ts'
import { err, ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { issueItem, pullRequestItem, repositoryMapping } from './fixtures.ts'

function stagedStore() {
  const store = openJournalStore(':memory:')
  store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
  store.recordObservation({
    externalId: 'conflicting',
    observedAt: '2026-08-13T01:00:00.000Z',
    source: 'poll',
    subject: pullRequestItem(),
  })
  const task = store.claimNextConflictTask('worker-1', '2026-08-13T01:01:00.000Z', 10 * 60_000)
  if (task === null)
    throw new Error('Expected a conflict task.')
  const staged = store.stagePublication({
    taskId: task.id,
    workerId: 'worker-1',
    fence: task.state.fence,
    at: '2026-08-13T01:02:00.000Z',
    publication: {
      _tag: 'UpdatePullRequest',
      taskKind: 'resolve_conflict',
      pullRequestNumber: task.pullRequestNumber,
      commitSha: 'commit123',
      baseSha: 'base123',
      expectedHeadSha: 'abc123',
      headRef: 'fix/broken-thing',
      artifactRef: 'refs/harlan-github-agent/publications/task-1',
      patchDigest: 'patch123',
      changedFiles: 1,
    },
  })
  if (staged._tag !== 'Staged')
    throw new Error('Expected a staged publication.')
  return store
}

function stagedIssueStore() {
  const store = openJournalStore(':memory:')
  store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
  const observed = store.recordObservation({
    externalId: 'issue',
    observedAt: '2026-08-13T01:00:00.000Z',
    source: 'poll',
    subject: issueItem(),
  })
  const triage = store.claimNextIssueTriageTask('triage', '2026-08-13T01:01:00.000Z', 60_000)
  if (triage === null || observed._tag !== 'Inserted')
    throw new Error('Expected issue triage.')
  store.completeWorkerTask({ taskId: triage.id, workerId: 'triage', fence: triage.state.fence, at: '2026-08-13T01:01:01.000Z', evidence: JSON.stringify({ validity: 'valid' }) })
  store.approveIssueWork({ repository: 'harlan-zw/example', issueNumber: 12, revisionId: observed.revisionId, at: '2026-08-13T01:01:02.000Z' })
  const task = store.claimNextIssueWorkTask('worker', '2026-08-13T01:01:03.000Z', 60_000)
  if (task === null)
    throw new Error('Expected issue work.')
  store.stagePublication({
    taskId: task.id,
    workerId: 'worker',
    fence: task.state.fence,
    at: '2026-08-13T01:01:04.000Z',
    publication: {
      _tag: 'OpenPullRequest',
      taskKind: 'issue_work',
      issueNumber: 12,
      pullRequestTitle: 'Fix #12',
      pullRequestBody: 'Closes #12.',
      commitSha: 'issue-commit',
      baseSha: 'base-sha',
      expectedHeadSha: 'base-sha',
      headRef: 'fix/issue-12',
      artifactRef: 'refs/harlan-github-agent/publications/issue',
      patchDigest: 'patch',
      changedFiles: 1,
    },
  })
  return store
}

describe('publication scheduler', () => {
  it('pushes a new branch before creating one pull request', async () => {
    const store = stagedIssueStore()
    let head: string | null = null
    const calls: string[] = []
    const scheduler = createPublicationScheduler({
      intervalMilliseconds: 60_000,
      leaseMilliseconds: 10_000,
      now: () => new Date('2026-08-13T02:00:00.000Z'),
      onError: (error) => { throw error },
      store,
      publisher: {
        finalize: () => {
          calls.push('pull request')
          return Promise.resolve(ok('Opened pull request #42.'))
        },
        getHeadSha: () => Promise.resolve(ok(head)),
        push: (command) => {
          calls.push('push')
          head = command.commitSha
          return Promise.resolve(ok(undefined))
        },
        validateAuthority: () => Promise.resolve(ok(undefined)),
      },
      workerId: 'publisher',
    })

    await scheduler.runNow()

    expect(calls).toEqual(['push', 'pull request'])
    expect(store.getDashboardSnapshot('2026-08-13T02:00:00.000Z').tasks.find(task => task.kind === 'issue_work')?.state).toEqual({
      _tag: 'Completed',
      evidence: 'Opened pull request #42.',
    })
    await scheduler.stop()
    store.close()
  })

  it('recovers a push completed before its acknowledgement', async () => {
    const store = stagedStore()
    let pushes = 0
    const scheduler = createPublicationScheduler({
      intervalMilliseconds: 60_000,
      leaseMilliseconds: 10_000,
      now: () => new Date('2026-08-13T02:00:00.000Z'),
      onError: (error) => { throw error },
      store,
      publisher: {
        finalize: () => Promise.resolve(ok('Published commit123.')),
        getHeadSha: () => Promise.resolve(ok('commit123')),
        push: () => {
          pushes += 1
          return Promise.resolve(ok(undefined))
        },
        validateAuthority: () => Promise.resolve(ok(undefined)),
      },
      workerId: 'publisher-1',
    })

    await scheduler.runNow()

    expect(pushes).toBe(0)
    expect(store.getDashboardSnapshot('2026-08-13T02:00:00.000Z').tasks[0]?.state).toEqual({
      _tag: 'Completed',
      evidence: 'Published commit123.',
    })
    await scheduler.stop()
    store.close()
  })

  it('publishes only while the remote head matches its expected SHA', async () => {
    const store = stagedStore()
    const calls: string[] = []
    const scheduler = createPublicationScheduler({
      intervalMilliseconds: 60_000,
      leaseMilliseconds: 10_000,
      now: () => new Date('2026-08-13T02:00:00.000Z'),
      onError: (error) => { throw error },
      store,
      publisher: {
        finalize: () => Promise.resolve(ok('Published commit123.')),
        getHeadSha: () => Promise.resolve(ok('different123')),
        push: () => {
          calls.push('push')
          return Promise.resolve(ok(undefined))
        },
        validateAuthority: () => Promise.resolve(ok(undefined)),
      },
      workerId: 'publisher-1',
    })

    await scheduler.runNow()

    expect(calls).toEqual([])
    expect(store.getDashboardSnapshot('2026-08-13T02:00:00.000Z').tasks[0]?.state._tag).toBe('Superseded')
    await scheduler.stop()
    store.close()
  })

  it('replaces a leftover branch from an earlier attempt when it opens a pull request', async () => {
    const store = stagedIssueStore()
    const calls: string[] = []
    const scheduler = createPublicationScheduler({
      intervalMilliseconds: 60_000,
      leaseMilliseconds: 10_000,
      now: () => new Date('2026-08-13T02:00:00.000Z'),
      onError: (error) => { throw error },
      store,
      publisher: {
        finalize: () => Promise.resolve(ok('Opened pull request #7.')),
        // The branch survives from an attempt that never opened a pull request.
        getHeadSha: () => Promise.resolve(ok(calls.includes('push') ? 'issue-commit' : 'orphan-commit')),
        push: () => {
          calls.push('push')
          return Promise.resolve(ok(undefined))
        },
        validateAuthority: () => {
          calls.push('validate')
          return Promise.resolve(ok(undefined))
        },
      },
      workerId: 'publisher-1',
    })

    await scheduler.runNow()

    expect(calls).toEqual(['validate', 'push'])
    expect(store.getDashboardSnapshot('2026-08-13T02:00:00.000Z').tasks[0]?.state).toEqual({ _tag: 'Completed', evidence: 'Opened pull request #7.' })
    await scheduler.stop()
    store.close()
  })

  it('keeps an unknown push outcome pending until remote reconciliation succeeds', async () => {
    const store = stagedStore()
    let reads = 0
    let pushes = 0
    const scheduler = createPublicationScheduler({
      intervalMilliseconds: 60_000,
      leaseMilliseconds: 10_000,
      now: () => new Date('2026-08-13T02:00:00.000Z'),
      onError: (error) => { throw error },
      store,
      publisher: {
        finalize: () => Promise.resolve(ok('Published commit123.')),
        getHeadSha: () => {
          reads += 1
          return Promise.resolve(reads === 1 ? ok('abc123') : err('network unavailable'))
        },
        push: () => {
          pushes += 1
          return Promise.resolve(err('connection closed'))
        },
        validateAuthority: () => Promise.resolve(ok(undefined)),
      },
      workerId: 'publisher-1',
    })

    await scheduler.runNow()
    await scheduler.runNow()

    expect(pushes).toBe(1)
    expect(store.getDashboardSnapshot('2026-08-13T02:00:00.000Z').tasks[0]?.state._tag).toBe('Publishing')
    await scheduler.stop()
    store.close()
  })
})
