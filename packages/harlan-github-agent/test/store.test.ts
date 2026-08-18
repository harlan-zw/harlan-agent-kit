import type { ReviewFixClaim, ReviewGates } from '../src/types.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { openJournalStore } from '../src/store.ts'
import { issueItem, pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []
const temporaryDirectories: string[] = []

afterEach(() => {
  stores.splice(0).forEach(store => store.close())
  temporaryDirectories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
})

function createStore() {
  const store = openJournalStore(':memory:')
  stores.push(store)
  return store
}

/** The repair Task one review claimed, or a readable failure. */
function claimedRepair(claim: ReviewFixClaim) {
  if (claim._tag !== 'Claimed')
    throw new Error(`Expected the repair Task, not ${claim._tag}.`)
  return claim.task
}

function passedReviewGates(): ReviewGates {
  return {
    head: { _tag: 'Passed', evidence: [{ label: 'head', sha256: 'a'.repeat(64) }] },
    merge: { _tag: 'Passed', evidence: [{ label: 'mergeability', sha256: 'b'.repeat(64) }] },
    metadata: { _tag: 'Passed', evidence: [] },
    review: { _tag: 'Passed', evidence: [{ label: 'review', sha256: 'c'.repeat(64) }] },
    verification: { _tag: 'Passed', evidence: [{ label: 'tests', sha256: 'd'.repeat(64) }] },
    ci: { _tag: 'Passed', evidence: [{ label: 'required-ci', sha256: 'e'.repeat(64) }] },
  }
}

describe('journal store', () => {
  it('persists Pause and reports when restart is safe', () => {
    const directory = mkdtempSync(join(tmpdir(), 'harlan-github-agent-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'journal.sqlite')
    const store = openJournalStore(path)

    expect(store.getAgentControl()).toEqual({ _tag: 'Running' })
    expect(store.pauseAgents('2026-08-13T01:00:00.000Z')).toEqual({
      _tag: 'Paused',
      pausedAt: '2026-08-13T01:00:00.000Z',
    })
    expect(store.getDashboardSnapshot('2026-08-13T01:00:01.000Z').agentControl).toEqual({
      _tag: 'Paused',
      pausedAt: '2026-08-13T01:00:00.000Z',
      safeToRestart: true,
    })
    store.close()

    const reopened = openJournalStore(path)
    stores.push(reopened)
    expect(reopened.getAgentControl()).toEqual({
      _tag: 'Paused',
      pausedAt: '2026-08-13T01:00:00.000Z',
    })
    expect(reopened.resumeAgents('2026-08-13T01:00:02.000Z')).toEqual({ _tag: 'Running' })
  })

  it('reports restart unsafe until active work and publication finish', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'pause-active-work',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })
    expect(store.claimNextConflictTask('worker-1', '2026-08-13T01:01:00.000Z', 10_000)).not.toBeNull()

    store.pauseAgents('2026-08-13T01:01:01.000Z')

    expect(store.getDashboardSnapshot('2026-08-13T01:01:02.000Z').agentControl).toEqual({
      _tag: 'Paused',
      pausedAt: '2026-08-13T01:01:01.000Z',
      safeToRestart: false,
    })
  })

  it('ignores unowned pending progress updates when deciding restart safety', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'pause-stale-status',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request.')
    const task = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T01:01:00.000Z', 1_000)
    if (task === null)
      throw new Error('Expected a review task.')
    store.stageReviewStatus({
      taskKind: 'adversarial_review',
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:01:00.500Z',
      revisionId: observed.revisionId,
      expectedHeadSha: task.pullRequest.headSha,
      phase: 'snapshot',
      body: '<!-- harlan-agent-kit:pr-triage -->\nReview started.',
    })
    store.recoverInterruptedAgentTasks('2026-08-13T01:01:02.000Z')
    store.pauseAgents('2026-08-13T01:01:03.000Z')

    expect(store.getDashboardSnapshot('2026-08-13T01:01:04.000Z').agentControl).toEqual({
      _tag: 'Paused',
      pausedAt: '2026-08-13T01:01:03.000Z',
      safeToRestart: true,
    })
  })

  it('deduplicates one immutable observation', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const input = {
      externalId: 'delivery-1',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll' as const,
      subject: issueItem(),
    }

    expect(store.recordObservation(input)._tag).toBe('Inserted')
    expect(store.recordObservation(input)._tag).toBe('Duplicate')
    expect(store.getDashboardSnapshot(input.observedAt).items).toHaveLength(1)
  })

  it('keeps the same issue Revision when its Approval label changes', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const first = store.recordObservation({
      externalId: 'issue-without-label',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: issueItem(),
    })
    const labelled = store.recordObservation({
      externalId: 'issue-with-label',
      observedAt: '2026-08-13T01:01:00.000Z',
      source: 'poll',
      subject: issueItem({ approvalLabels: ['review'] }),
    })

    if (first._tag !== 'Inserted')
      throw new Error('Expected the first issue Revision.')
    expect(labelled).toEqual({ _tag: 'Duplicate', revisionId: first.revisionId })
    expect(store.getDashboardSnapshot('2026-08-13T01:01:00.000Z').tasks).toEqual([
      expect.objectContaining({ kind: 'issue_triage', state: { _tag: 'Queued' } }),
    ])
  })

  it('rejects one observation identity with different content', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')

    store.recordObservation({
      externalId: 'delivery-1',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'webhook',
      subject: issueItem(),
    })
    const result = store.recordObservation({
      externalId: 'delivery-1',
      observedAt: '2026-08-13T01:01:00.000Z',
      source: 'webhook',
      subject: issueItem({ title: 'Different content' }),
    })

    expect(result._tag).toBe('Conflict')
  })

  it('queues conflict resolution for a writable pull request branch', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')

    store.recordObservation({
      externalId: 'poll-pr-24',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })

    expect(store.getDashboardSnapshot('2026-08-13T01:00:00.000Z').tasks).toEqual([
      expect.objectContaining({
        repository: 'harlan-zw/example',
        pullRequestNumber: 24,
        state: { _tag: 'Queued' },
      }),
    ])
  })

  it('requeues conflict resolution when GitHub reports conflicts again', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const conflicting = pullRequestItem({ mergeState: 'conflicting' })
    store.recordObservation({ externalId: 'conflicting-1', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject: conflicting })
    store.recordObservation({ externalId: 'clean', observedAt: '2026-08-13T01:01:00.000Z', source: 'poll', subject: pullRequestItem({ mergeState: 'clean' }) })
    store.recordObservation({ externalId: 'conflicting-1', observedAt: '2026-08-13T01:02:00.000Z', source: 'poll', subject: conflicting })

    expect(store.getDashboardSnapshot('2026-08-13T01:02:00.000Z').queue[0]?.state).toEqual({
      _tag: 'Queued',
      work: 'conflict_resolution',
    })
  })

  it('keeps a manually cancelled task cancelled across later polls', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const subject = pullRequestItem({ mergeState: 'conflicting' })
    store.recordObservation({ externalId: 'cancelled-conflict', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject })
    const task = store.claimNextConflictTask('worker-1', '2026-08-13T01:01:00.000Z', 10_000)
    if (task === null)
      throw new Error('Expected a running conflict task.')

    expect(store.cancelTask({ taskId: task.id, at: '2026-08-13T01:02:00.000Z' })).toEqual({ _tag: 'Cancelled' })
    expect(store.heartbeatTask({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:02:01.000Z',
      leaseMilliseconds: 10_000,
    })).toBe(false)

    store.recordObservation({ externalId: 'cancelled-conflict', observedAt: '2026-08-13T01:03:00.000Z', source: 'poll', subject })
    expect(store.claimNextConflictTask('worker-2', '2026-08-13T01:04:00.000Z', 10_000)).toBeNull()
    expect(store.getDashboardSnapshot('2026-08-13T01:04:00.000Z').tasks.find(candidate => candidate.id === task.id)?.state).toEqual({
      _tag: 'Superseded',
      reason: 'Cancelled from the dashboard.',
    })
  })

  it('cancels current work when its pull request closes', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const subject = pullRequestItem({ mergeState: 'conflicting' })
    store.recordObservation({ externalId: 'open-pull-request', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject })
    const task = store.claimNextConflictTask('worker-1', '2026-08-13T01:01:00.000Z', 10_000)
    if (task === null)
      throw new Error('Expected a running conflict task.')

    store.recordObservation({
      externalId: 'closed-pull-request',
      observedAt: '2026-08-13T01:02:00.000Z',
      source: 'poll',
      subject: { ...subject, state: 'closed', updatedAt: '2026-08-13T01:02:00.000Z' },
    })

    expect(store.getDashboardSnapshot('2026-08-13T01:02:00.000Z').tasks.find(candidate => candidate.id === task.id)?.state).toEqual({
      _tag: 'Superseded',
      reason: 'The pull request closed.',
    })
    expect(store.cancelTask({ taskId: task.id, at: '2026-08-13T01:03:00.000Z' })).toEqual({ _tag: 'AlreadyCancelled' })
  })

  it('cancels review work and its pending GitHub status update', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const subject = pullRequestItem({ mergeState: 'clean' })
    const observed = store.recordObservation({ externalId: 'cancelled-review', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request.')
    const task = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T01:01:00.000Z', 10_000)
    if (task === null)
      throw new Error('Expected a running review task.')
    const status = store.stageReviewStatus({
      taskKind: 'adversarial_review',
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:01:01.000Z',
      revisionId: observed.revisionId,
      expectedHeadSha: subject.headSha,
      phase: 'snapshot',
      body: '<!-- harlan-agent-kit:pr-triage -->\nReview started.',
    })
    if (status._tag === 'Rejected')
      throw new Error(status.reason)

    expect(store.cancelTask({ taskId: task.id, at: '2026-08-13T01:02:00.000Z' })).toEqual({ _tag: 'Cancelled' })
    expect(store.heartbeatWorkerTask({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:02:01.000Z',
      leaseMilliseconds: 10_000,
    })).toBe(false)
    expect(store.claimReviewStatus(status.commandId, 'publisher-1', '2026-08-13T01:02:01.000Z', 10_000)).toBeNull()
    store.recordObservation({ externalId: 'cancelled-review', observedAt: '2026-08-13T01:03:00.000Z', source: 'poll', subject })
    expect(store.claimNextAdversarialReviewTask('reviewer-2', '2026-08-13T01:04:00.000Z', 10_000)).toBeNull()
  })

  it.each([
    ['a transient failure', 'wt list returned an invalid worktree entry.', true],
    ['a permanent failure', 'The worker changed a file that was not conflicted: src/index.ts.', false],
  ])('requeues a failed conflict task on the next poll only after %s', (_name, reason, requeued) => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const subject = pullRequestItem()
    store.recordObservation({ externalId: 'conflict-recovery', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject })
    const task = store.claimNextConflictTask('worker-1', '2026-08-13T01:01:00.000Z', 10_000)
    if (task === null)
      throw new Error('Expected the conflict Task.')
    // Fail it until every attempt and every recovery is spent, so it is Failed
    // for good and only a poll can bring it back.
    const start = Date.parse('2026-08-13T01:02:00.000Z')
    const at = (step: number, offsetMs = 0): string => new Date(start + step * 3_600_000 + offsetMs).toISOString()
    let claimed: typeof task | null = task
    let step = 0
    while (claimed !== null && step < 90) {
      // Fail inside the lease, otherwise the claim simply expires and the
      // attempt is never counted.
      store.failTask({ taskId: claimed.id, workerId: claimed.state.workerId, fence: claimed.state.fence, at: at(step, 5_000), reason })
      step++
      claimed = store.claimNextConflictTask('worker-1', at(step), 10_000)
    }
    expect(claimed).toBeNull()

    store.recordObservation({ externalId: 'conflict-recovery', observedAt: '2026-08-14T00:00:00.000Z', source: 'poll', subject })

    expect(store.claimNextConflictTask('worker-1', '2026-08-14T00:01:00.000Z', 10_000) !== null).toBe(requeued)
  })

  it('cancels a conflict task before its commit is pushed', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({ externalId: 'cancelled-publication', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject: pullRequestItem() })
    const task = store.claimNextConflictTask('worker-1', '2026-08-13T01:01:00.000Z', 10_000)
    if (task === null)
      throw new Error('Expected a running conflict task.')
    expect(store.stagePublication({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:01:01.000Z',
      publication: {
        _tag: 'UpdatePullRequest',
        taskKind: 'resolve_conflict',
        pullRequestNumber: task.pullRequestNumber,
        commitSha: 'merge123',
        baseSha: task.pullRequest.baseSha,
        expectedHeadSha: task.pullRequest.headSha,
        headRef: task.pullRequest.headRef,
        artifactRef: 'refs/harlan-github-agent/publications/cancelled',
        patchDigest: 'patch',
        changedFiles: 1,
      },
    })._tag).toBe('Staged')

    expect(store.cancelTask({ taskId: task.id, at: '2026-08-13T01:02:00.000Z' })).toEqual({ _tag: 'Cancelled' })
    expect(store.claimNextPublication('publisher-1', '2026-08-13T01:02:01.000Z', 10_000)).toBeNull()
  })

  it('retries base movement without asking for attention', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const subject = pullRequestItem({ mergeState: 'conflicting' })
    store.recordObservation({ externalId: 'moving-base', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject })
    for (const attempt of [1, 2, 3]) {
      const task = store.claimNextConflictTask(`worker-${attempt}`, `2026-08-13T01:00:0${attempt}.000Z`, 10_000)
      if (task === null)
        throw new Error(`Expected conflict attempt ${attempt}.`)
      store.failTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at: `2026-08-13T01:00:0${attempt}.000Z`,
        reason: 'Fetched base branch no longer matches the claimed base commit SHA.',
      })
    }

    store.recordObservation({ externalId: 'moving-base', observedAt: '2026-08-13T01:01:00.000Z', source: 'poll', subject })
    expect(store.getDashboardSnapshot('2026-08-13T01:01:00.000Z').queue[0]?.state).toEqual({
      _tag: 'Queued',
      work: 'conflict_resolution',
    })
  })

  it('retries conflict verification after the patch buffer limit is repaired', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const subject = pullRequestItem({ mergeState: 'conflicting' })
    store.recordObservation({ externalId: 'large-conflict', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject })
    for (const attempt of [1, 2, 3]) {
      const task = store.claimNextConflictTask(`worker-${attempt}`, `2026-08-13T01:00:0${attempt}.000Z`, 10_000)
      if (task === null)
        throw new Error(`Expected conflict attempt ${attempt}.`)
      store.failTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at: `2026-08-13T01:00:0${attempt}.000Z`,
        reason: 'Could not read the conflict resolution patch: ',
      })
    }

    store.recordObservation({ externalId: 'large-conflict', observedAt: '2026-08-13T01:01:00.000Z', source: 'poll', subject })

    expect(store.getDashboardSnapshot('2026-08-13T01:01:00.000Z').queue[0]?.state).toEqual({
      _tag: 'Queued',
      work: 'conflict_resolution',
    })
  })

  it('retries an invalid agent review result without asking for attention', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const subject = pullRequestItem({ mergeState: 'clean' })
    store.recordObservation({ externalId: 'invalid-review', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject })
    for (const attempt of [1, 2, 3]) {
      const task = store.claimNextAdversarialReviewTask(`worker-${attempt}`, `2026-08-13T01:00:0${attempt}.000Z`, 10_000)
      if (task === null)
        throw new Error(`Expected review attempt ${attempt}.`)
      store.failWorkerTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at: `2026-08-13T01:00:0${attempt}.000Z`,
        reason: 'The agent returned an invalid adversarial review result.',
      })
    }

    store.recordObservation({ externalId: 'invalid-review', observedAt: '2026-08-13T01:01:00.000Z', source: 'poll', subject })
    expect(store.getDashboardSnapshot('2026-08-13T01:01:00.000Z').queue[0]?.state).toEqual({
      _tag: 'Queued',
      work: 'adversarial_review',
    })
  })

  it('surfaces a running conflict Worker as live agent activity', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'running-conflict',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })
    const task = store.claimNextConflictTask('worker-1', '2026-08-13T01:01:00.000Z', 600_000)
    if (task === null)
      throw new Error('Expected a conflict resolution Task.')
    store.saveWorkerSession('harlan-zw/example', 24, 'conflict_resolution', 'session-1', '2026-08-13T01:01:05.000Z')
    expect(store.updateAgentProgress({
      taskId: task.id,
      taskKind: task.kind,
      workerId: 'worker-1',
      fence: task.state.fence,
      progress: { percent: 70, label: 'Running tests and checks' },
      at: '2026-08-13T01:01:30.000Z',
    })).toBe(true)

    expect(store.getDashboardSnapshot('2026-08-13T01:02:00.000Z').agents).toEqual([
      expect.objectContaining({
        _tag: 'ActiveAgent',
        id: task.id,
        provider: 'codex',
        role: 'conflict_resolution',
        session: { _tag: 'Connected', id: 'session-1' },
        repository: 'harlan-zw/example',
        subjectKind: 'pull_request',
        itemNumber: 24,
        subjectUrl: 'https://github.com/harlan-zw/example/pull/24',
        progress: { percent: 70, label: 'Running tests and checks' },
        state: expect.objectContaining({ _tag: 'Working', workerId: 'worker-1' }),
      }),
    ])
  })

  it('keeps active agents in stable positions when progress changes', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'active-conflict',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })
    store.recordObservation({
      externalId: 'active-issue',
      observedAt: '2026-08-13T01:00:01.000Z',
      source: 'poll',
      subject: issueItem(),
    })
    const conflict = store.claimNextConflictTask('conflict-worker', '2026-08-13T01:01:00.000Z', 600_000)
    const issue = store.claimNextIssueTriageTask('issue-worker', '2026-08-13T01:02:00.000Z', 600_000)
    if (conflict === null || issue === null)
      throw new Error('Expected two active agents.')

    const before = store.getDashboardSnapshot('2026-08-13T01:02:01.000Z').agents.map(agent => agent.id)
    store.updateAgentProgress({
      taskId: conflict.id,
      taskKind: conflict.kind,
      workerId: 'conflict-worker',
      fence: conflict.state.fence,
      progress: { percent: 80, label: 'Fix verified' },
      at: '2026-08-13T01:03:00.000Z',
    })

    expect(store.getDashboardSnapshot('2026-08-13T01:03:01.000Z').agents.map(agent => agent.id)).toEqual(before)
  })

  it('does not report a heartbeat as agent progress', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'review-heartbeat',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    const task = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T01:01:00.000Z', 45 * 60_000)
    if (task === null)
      throw new Error('Expected a running review.')

    expect(store.heartbeatWorkerTask({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:02:00.000Z',
      leaseMilliseconds: 45 * 60_000,
    })).toBe(true)

    const active = store.getDashboardSnapshot('2026-08-13T01:02:00.000Z').agents.find(agent => agent._tag === 'ActiveAgent' && agent.id === task.id)
    expect(active?.updatedAt).toBe('2026-08-13T01:01:00.000Z')
  })

  it('orders active work, approvals, reviews, and issue triage in the Queue', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'issue',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: issueItem(),
    })
    store.recordObservation({
      externalId: 'review-ready',
      observedAt: '2026-08-13T01:01:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ number: 23, mergeState: 'clean' }),
    })
    store.recordObservation({
      externalId: 'approval',
      observedAt: '2026-08-13T01:02:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ number: 25, author: 'contributor', mergeState: 'clean' }),
    })
    store.recordObservation({
      externalId: 'active',
      observedAt: '2026-08-13T01:03:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ number: 26 }),
    })
    store.claimNextConflictTask('worker-1', '2026-08-13T01:04:00.000Z', 600_000)

    expect(store.getDashboardSnapshot('2026-08-13T01:05:00.000Z').queue.map(entry => ({
      number: entry.number,
      position: entry.position,
      state: entry.state,
    }))).toEqual([
      { number: 26, position: 1, state: expect.objectContaining({ _tag: 'Active' }) },
      { number: 25, position: 2, state: { _tag: 'AwaitingApproval', kind: 'review' } },
      { number: 23, position: 3, state: { _tag: 'Queued', work: 'adversarial_review' } },
      { number: 12, position: 4, state: { _tag: 'Queued', work: 'issue_triage' } },
    ])
  })

  it('queues outside contributor issue work after approval and keeps the same agent session', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'issue-triage',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: issueItem(),
    })

    const task = store.claimNextIssueTriageTask('issue-worker', '2026-08-13T01:01:00.000Z', 600_000)
    if (task === null)
      throw new Error('Expected an issue triage Task.')
    store.saveWorkerSession('harlan-zw/example', 12, 'issue_triage', 'issue-session', '2026-08-13T01:01:05.000Z')

    expect(store.getDashboardSnapshot('2026-08-13T01:02:00.000Z').agents).toEqual([
      expect.objectContaining({
        _tag: 'ActiveAgent',
        id: task.id,
        role: 'issue_triage',
        subjectKind: 'issue',
        itemNumber: 12,
        session: { _tag: 'Connected', id: 'issue-session' },
      }),
    ])
    expect(store.completeWorkerTask({
      taskId: task.id,
      workerId: 'issue-worker',
      fence: task.state.fence,
      at: '2026-08-13T01:02:00.000Z',
      evidence: JSON.stringify({ validity: 'valid' }),
    })).toBe(true)
    expect(store.isIssueWorkApprovalReady('harlan-zw/example', 12, task.revisionId)).toBe(true)
    expect(store.approveIssueWork({
      repository: 'harlan-zw/example',
      issueNumber: 12,
      revisionId: task.revisionId,
      at: '2026-08-13T01:02:01.000Z',
    })).toEqual({ _tag: 'Approved', taskId: expect.any(String) })
    expect(store.isIssueWorkApprovalReady('harlan-zw/example', 12, task.revisionId)).toBe(false)
    const work = store.claimNextIssueWorkTask('issue-worker', '2026-08-13T01:02:02.000Z', 600_000)
    expect(work).toEqual(expect.objectContaining({
      kind: 'issue_work',
      issueNumber: 12,
      revisionId: task.revisionId,
    }))
    expect(store.getWorkerSession('harlan-zw/example', 12, 'issue_triage')).toBe('issue-session')
    expect(store.getDashboardSnapshot('2026-08-13T01:02:03.000Z').agents).toEqual([
      expect.objectContaining({ role: 'issue_work', session: { _tag: 'Connected', id: 'issue-session' } }),
    ])
    if (work === null)
      throw new Error('Expected approved issue work.')
    expect(store.stagePublication({
      taskId: work.id,
      workerId: work.state.workerId,
      fence: work.state.fence,
      at: '2026-08-13T01:02:04.000Z',
      publication: {
        _tag: 'OpenPullRequest',
        taskKind: 'issue_work',
        issueNumber: 12,
        pullRequestTitle: 'Fix #12: Broken thing',
        pullRequestBody: 'Closes #12.',
        commitSha: 'issue-commit',
        baseSha: 'base-sha',
        expectedHeadSha: 'base-sha',
        headRef: 'fix/issue-12',
        artifactRef: 'refs/harlan-github-agent/publications/issue-work',
        patchDigest: 'issue-patch',
        changedFiles: 2,
      },
    })._tag).toBe('Staged')
    expect(store.claimNextPublication('publisher', '2026-08-13T01:02:05.000Z', 60_000)).toEqual(expect.objectContaining({
      _tag: 'OpenPullRequest',
      taskKind: 'issue_work',
      issueNumber: 12,
      pullRequestTitle: 'Fix #12: Broken thing',
    }))
  })

  it('stores one durable issue triage comment', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'issue-triage-comment',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: issueItem(),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new issue Revision.')
    const task = store.claimNextIssueTriageTask('issue-worker', '2026-08-13T01:01:00.000Z', 600_000)
    if (task === null)
      throw new Error('Expected an issue triage Task.')

    const staged = store.stageIssueTriageComment({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:02:00.000Z',
      revisionId: observed.revisionId,
      expectedUpdatedAt: task.issue.updatedAt,
      body: '<!-- harlan-agent-kit:issue-triage -->\nTriage result.',
    })
    expect(staged).toEqual({ _tag: 'Staged', commandId: expect.any(String) })
    if (staged._tag === 'Rejected')
      throw new Error(staged.reason)
    const command = store.claimIssueTriageComment(staged.commandId, 'comment-controller', '2026-08-13T01:02:01.000Z', 600_000)
    expect(command).toEqual(expect.objectContaining({
      repository: 'harlan-zw/example',
      issueNumber: 12,
      revisionId: observed.revisionId,
      expectedUpdatedAt: task.issue.updatedAt,
      commentId: null,
      body: '<!-- harlan-agent-kit:issue-triage -->\nTriage result.',
    }))
    if (command === null)
      throw new Error('Expected an issue triage comment command.')
    expect(store.completeIssueTriageComment({
      commandId: command.id,
      workerId: command.workerId,
      fence: command.fence,
      at: '2026-08-13T01:02:02.000Z',
      commentId: 42,
      url: 'https://github.com/harlan-zw/example/issues/12#issuecomment-42',
    })).toBe(true)
    expect(store.completeWorkerTask({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:02:03.000Z',
      evidence: JSON.stringify({ validity: 'valid' }),
    })).toBe(true)

    const changed = store.recordObservation({
      externalId: 'issue-triage-comment-rerun',
      observedAt: '2026-08-13T02:00:00.000Z',
      source: 'poll',
      subject: issueItem({ title: 'Changed issue', updatedAt: '2026-08-13T02:00:00.000Z' }),
    })
    if (changed._tag !== 'Inserted')
      throw new Error('Expected a changed issue Revision.')
    const rerun = store.claimNextIssueTriageTask('issue-worker', '2026-08-13T02:01:00.000Z', 600_000)
    if (rerun === null)
      throw new Error('Expected a rerun issue triage Task.')
    const restaged = store.stageIssueTriageComment({
      taskId: rerun.id,
      workerId: rerun.state.workerId,
      fence: rerun.state.fence,
      at: '2026-08-13T02:02:00.000Z',
      revisionId: changed.revisionId,
      expectedUpdatedAt: rerun.issue.updatedAt,
      body: '<!-- harlan-agent-kit:issue-triage -->\nUpdated triage result.',
    })
    if (restaged._tag === 'Rejected')
      throw new Error(restaged.reason)
    expect(store.claimIssueTriageComment(restaged.commandId, 'comment-controller', '2026-08-13T02:02:01.000Z', 600_000))
      .toEqual(expect.objectContaining({ commentId: 42 }))
  })

  it('queues trusted author issue work automatically after valid triage', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'trusted-issue',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: issueItem({ author: 'harlan-zw' }),
    })
    const triage = store.claimNextIssueTriageTask('issue-worker', '2026-08-13T01:01:00.000Z', 600_000)
    if (triage === null)
      throw new Error('Expected issue triage.')

    expect(store.completeWorkerTask({
      taskId: triage.id,
      workerId: 'issue-worker',
      fence: triage.state.fence,
      at: '2026-08-13T01:02:00.000Z',
      evidence: JSON.stringify({ validity: 'valid' }),
    })).toBe(true)

    expect(store.getDashboardSnapshot('2026-08-13T01:02:01.000Z').queue).toEqual([
      expect.objectContaining({
        number: 12,
        state: { _tag: 'Queued', work: 'issue_work' },
      }),
    ])
    expect(store.claimNextIssueWorkTask('issue-worker', '2026-08-13T01:02:02.000Z', 600_000)).toEqual(
      expect.objectContaining({ kind: 'issue_work', issueNumber: 12, revisionId: triage.revisionId }),
    )
    expect(store.approveIssueWork({
      repository: 'harlan-zw/example',
      issueNumber: 12,
      revisionId: triage.revisionId,
      at: '2026-08-13T01:02:03.000Z',
    })).toEqual({ _tag: 'Rejected', reason: { _tag: 'ApprovalNotRequired' } })
  })

  it('does not queue issue work when triage needs information', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'issue-needs-information',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: issueItem(),
    })
    const task = store.claimNextIssueTriageTask('issue-worker', '2026-08-13T01:01:00.000Z', 600_000)
    if (task === null)
      throw new Error('Expected issue triage.')

    store.completeWorkerTask({
      taskId: task.id,
      workerId: 'issue-worker',
      fence: task.state.fence,
      at: '2026-08-13T01:02:00.000Z',
      evidence: JSON.stringify({ validity: 'needs_information' }),
    })

    expect(store.approveIssueWork({
      repository: 'harlan-zw/example',
      issueNumber: 12,
      revisionId: task.revisionId,
      at: '2026-08-13T01:02:01.000Z',
    })).toEqual({ _tag: 'Rejected', reason: { _tag: 'TriageRequired' } })
    expect(store.claimNextIssueWorkTask('issue-worker', '2026-08-13T01:02:01.000Z', 600_000)).toBeNull()
  })

  it('requires attention when the pull request branch is outside authority', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')

    store.recordObservation({
      externalId: 'poll-pr-24',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ headRepository: 'contributor/example' }),
    })

    expect(store.getDashboardSnapshot('2026-08-13T01:00:00.000Z').tasks[0]?.state._tag).toBe('ActionRequired')
  })

  it('queues conflict resolution for an approved outside contributor fork', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'approved-fork-conflict',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ author: 'contributor', headRepository: 'contributor/example' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    expect(store.approvePullRequest({
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      kind: 'review',
      at: '2026-08-13T01:01:00.000Z',
    })).toEqual({ _tag: 'Approved', approval: { _tag: 'ReviewApproved', approvedAt: '2026-08-13T01:01:00.000Z' } })
    expect(store.recordObservation({
      externalId: 'approved-fork-conflict',
      observedAt: '2026-08-13T01:02:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ author: 'contributor', headRepository: 'contributor/example' }),
    })).toEqual(expect.objectContaining({ _tag: 'Duplicate' }))

    expect(store.getDashboardSnapshot('2026-08-13T01:02:00.000Z').queue[0]?.state).toEqual({
      _tag: 'Queued',
      work: 'conflict_resolution',
    })
    expect(store.claimNextConflictTask('worker-1', '2026-08-13T01:02:01.000Z', 10_000)).not.toBeNull()
  })

  it('requires Revision-bound Review and repair approval for an outside contributor', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'outside-pr',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ author: 'contributor', mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    expect(store.getDashboardSnapshot('2026-08-13T01:00:00.000Z').items[0]).toEqual(expect.objectContaining({
      approval: { _tag: 'ReviewRequired' },
    }))
    expect(store.recordReviewRun({
      id: 'unapproved-attempt',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      headSha: 'abc123',
      provider: 'codex',
      sessionId: 'unapproved-session',
      model: 'gpt-5.6',
      agentVersion: '1.2.3',
      skillDigest: 'f'.repeat(64),
      startedAt: '2026-08-13T01:00:10.000Z',
      completedAt: '2026-08-13T01:00:20.000Z',
      gates: passedReviewGates(),
      confidence: 95,
      findings: [],
    })).toEqual({ _tag: 'Rejected', reason: { _tag: 'ReviewApprovalRequired' } })
    expect(store.approvePullRequest({
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      kind: 'review',
      at: '2026-08-13T01:01:00.000Z',
    })).toEqual({
      _tag: 'Approved',
      approval: { _tag: 'ReviewApproved', approvedAt: '2026-08-13T01:01:00.000Z' },
    })
    expect(store.approvePullRequest({
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      kind: 'review',
      at: '2026-08-13T01:02:00.000Z',
    })._tag).toBe('Duplicate')
  })

  it('uses one outside contributor approval for review and repairs', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'outside-pr-findings',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ author: 'contributor', mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')

    store.approvePullRequest({
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      kind: 'review',
      at: '2026-08-13T01:02:00.000Z',
    })
    const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:02:01.000Z', 600_000)
    if (review === null)
      throw new Error('Expected the approved review Task.')
    const gates = passedReviewGates()
    gates.review = { _tag: 'Failed', reason: 'Unsafe input reached a command boundary.', evidence: [] }
    store.recordReviewRun({
      id: 'outside-attempt',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      headSha: 'abc123',
      provider: 'codex',
      sessionId: 'session-outside',
      model: 'gpt-5.6',
      agentVersion: '1.2.3',
      skillDigest: 'f'.repeat(64),
      startedAt: '2026-08-13T01:03:00.000Z',
      completedAt: '2026-08-13T01:04:00.000Z',
      gates,
      findings: [{ _tag: 'Open', summary: 'Unsafe command input.', nextAction: 'Apply the guarded fix.' }],
    })

    expect(store.getDashboardSnapshot('2026-08-13T01:05:00.000Z').items[0]).toEqual(expect.objectContaining({
      approval: { _tag: 'ReviewApproved', approvedAt: '2026-08-13T01:02:00.000Z' },
    }))
    const repair = claimedRepair(store.claimReviewFixTaskForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:06:00.000Z',
      leaseMilliseconds: 60_000,
    }))
    const repairCommit = 'd'.repeat(40)
    expect(store.stagePublication({
      taskId: repair.id,
      workerId: repair.state.workerId,
      fence: repair.state.fence,
      at: '2026-08-13T01:06:01.000Z',
      publication: {
        _tag: 'UpdatePullRequest',
        taskKind: 'review_fix',
        pullRequestNumber: repair.pullRequestNumber,
        commitSha: repairCommit,
        baseSha: 'base123',
        expectedHeadSha: 'abc123',
        headRef: 'fix/broken-thing',
        artifactRef: 'refs/harlan-github-agent/publications/outside-repair',
        patchDigest: 'repair-patch',
        changedFiles: 2,
      },
    })._tag).toBe('Staged')
    const publication = store.claimNextPublication('publisher', '2026-08-13T01:06:02.000Z', 60_000)
    if (publication === null)
      throw new Error('Expected the approved repair publication.')
    expect(store.completePublication({
      commandId: publication.id,
      workerId: publication.workerId,
      fence: publication.fence,
      at: '2026-08-13T01:06:03.000Z',
      evidence: 'Published repair commit.',
    })).toBe(true)

    const repaired = store.recordObservation({
      externalId: 'outside-pr-repaired',
      observedAt: '2026-08-13T01:07:00.000Z',
      source: 'poll',
      subject: pullRequestItem({
        author: 'contributor',
        headSha: repairCommit,
        mergeState: 'clean',
        updatedAt: '2026-08-13T01:07:00.000Z',
      }),
    })
    if (repaired._tag !== 'Inserted')
      throw new Error('Expected the published repair to create a new revision.')
    expect(store.getDashboardSnapshot('2026-08-13T01:07:00.000Z').items[0]).toEqual(expect.objectContaining({
      approval: { _tag: 'ReviewApproved', approvedAt: '2026-08-13T01:07:00.000Z' },
      revisionId: repaired.revisionId,
    }))
  })

  it('lists a review that stopped while its progress comment still claims it runs', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    store.recordObservation({
      externalId: 'stopped-review-pr',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequest,
    })
    const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:01:00.000Z', 600_000)
    if (review === null)
      throw new Error('Expected the review Task.')
    const staged = store.stageReviewStatus({
      taskKind: 'adversarial_review',
      phase: 'review',
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:02:00.000Z',
      revisionId: review.revisionId,
      expectedHeadSha: pullRequest.headSha,
      body: '### 🤖 REVIEWING · Git worktree ready',
    })
    if (staged._tag === 'Rejected')
      throw new Error(staged.reason)
    const command = store.claimReviewStatus(staged.commandId, 'status-worker', '2026-08-13T01:02:01.000Z', 60_000)
    if (command === null)
      throw new Error('Expected the review status command.')
    store.completeReviewStatus({
      commandId: command.id,
      workerId: command.workerId,
      fence: command.fence,
      at: '2026-08-13T01:02:02.000Z',
      commentId: 42,
      url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
    })

    expect(store.listStoppedReviews()).toEqual([])

    store.failWorkerTask({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:03:00.000Z',
      reason: 'The agent returned malformed adversarial review JSON.',
    })
    // A retry keeps the Task live, so the pull request waits for the retry instead.
    expect(store.listStoppedReviews()).toEqual([])

    const retry = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:04:00.000Z', 600_000)
    if (retry === null)
      throw new Error('Expected the retry.')
    store.failWorkerTask({ taskId: retry.id, workerId: retry.state.workerId, fence: retry.state.fence, at: '2026-08-13T01:05:00.000Z', reason: 'Malformed again.' })
    const last = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:06:00.000Z', 600_000)
    if (last === null)
      throw new Error('Expected the last attempt.')
    store.failWorkerTask({ taskId: last.id, workerId: last.state.workerId, fence: last.state.fence, at: '2026-08-13T01:07:00.000Z', reason: 'Malformed again.' })

    expect(store.listStoppedReviews()).toEqual([expect.objectContaining({
      taskId: review.id,
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      headSha: pullRequest.headSha,
      commentId: 42,
    })])

    expect(store.recordStoppedReviewStatus({
      taskId: review.id,
      revisionId: review.revisionId,
      expectedHeadSha: pullRequest.headSha,
      body: '### 🤖 STOPPED',
      at: '2026-08-13T01:08:00.000Z',
      commentId: 42,
      url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
    })).toBe(true)
    expect(store.listStoppedReviews()).toEqual([])
  })

  it('recognises the pull request the controller opened to repair the default branch', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'baseline-identity-pr',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:01:00.000Z', 600_000)
    if (review === null)
      throw new Error('Expected the review Task.')
    const queued = store.queueBaselineRepairForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      baseSha: review.pullRequest.baseSha,
      at: '2026-08-13T01:02:00.000Z',
    })
    if (queued._tag === 'Rejected' || queued._tag === 'NotAuthorized')
      throw new Error(queued.reason)
    const repair = store.claimNextBaselineRepairTask('baseline-agent', '2026-08-13T01:03:00.000Z', 600_000)
    if (repair === null)
      throw new Error('Expected the Baseline repair Task.')
    const staged = store.stagePublication({
      taskId: repair.id,
      workerId: repair.state.workerId,
      fence: repair.state.fence,
      at: '2026-08-13T01:04:00.000Z',
      publication: {
        _tag: 'OpenPullRequest',
        taskKind: 'baseline_repair',
        pullRequestNumber: repair.pullRequestNumber,
        pullRequestTitle: 'fix(ci): repair the default branch',
        pullRequestBody: 'Repairs default branch CI.',
        commitSha: 'baseline-commit',
        baseSha: repair.pullRequest.baseSha,
        expectedHeadSha: repair.pullRequest.baseSha,
        headRef: 'fix/baseline-ci-abcdef012345',
        artifactRef: 'refs/harlan-github-agent/publications/baseline',
        patchDigest: 'patch',
        changedFiles: 1,
      },
    })
    if (staged._tag !== 'Staged')
      throw new Error('Expected a staged publication.')

    expect(store.isBaselineRepairPullRequest('harlan-zw/example', 'fix/baseline-ci-abcdef012345')).toBe(false)

    const claimed = store.claimNextPublication('publisher', '2026-08-13T01:05:00.000Z', 60_000)
    if (claimed === null)
      throw new Error('Expected the publication command.')
    store.completePublication({
      commandId: claimed.id,
      workerId: claimed.workerId,
      fence: claimed.fence,
      at: '2026-08-13T01:05:30.000Z',
      evidence: 'Opened pull request #99.',
    })

    expect(store.isBaselineRepairPullRequest('harlan-zw/example', 'fix/baseline-ci-abcdef012345')).toBe(true)
    expect(store.isBaselineRepairPullRequest('harlan-zw/example', 'fix/other')).toBe(false)
  })

  it('queues Baseline repair for a repository Harlan maintains but does not own', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping({ ownership: 'maintained' })], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'baseline-maintained-pr',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:01:00.000Z', 600_000)
    if (review === null)
      throw new Error('Expected the review Task.')

    const queued = store.queueBaselineRepairForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      baseSha: review.pullRequest.baseSha,
      at: '2026-08-13T01:02:00.000Z',
    })

    expect(queued._tag).toBe('Queued')
  })

  it('reports an external repository as unauthorized rather than rejected', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping({ ownership: 'external' })], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'baseline-external-pr',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:01:00.000Z', 600_000)
    if (review === null)
      throw new Error('Expected the review Task.')

    const queued = store.queueBaselineRepairForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      baseSha: review.pullRequest.baseSha,
      at: '2026-08-13T01:02:00.000Z',
    })

    expect(queued._tag).toBe('NotAuthorized')
  })

  it('retires a failed Baseline repair once a review sees a healthy base', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'baseline-retire-pr',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    // The review lease must outlive the repair's whole failure run below.
    const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:01:00.000Z', 6_000_000)
    if (review === null)
      throw new Error('Expected the review Task.')
    const queued = store.queueBaselineRepairForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      baseSha: review.pullRequest.baseSha,
      at: '2026-08-13T01:02:00.000Z',
    })
    if (queued._tag === 'Rejected' || queued._tag === 'NotAuthorized')
      throw new Error(queued.reason)
    // Kill the repair for good.
    for (let attempt = 0; attempt < 3; attempt++) {
      const claimed = store.claimNextBaselineRepairTask('baseline-agent', `2026-08-13T01:1${attempt}:00.000Z`, 600_000)
      if (claimed === null)
        throw new Error('Expected the Baseline repair Task to retry.')
      store.failTask({ taskId: claimed.id, workerId: claimed.state.workerId, fence: claimed.state.fence, at: `2026-08-13T01:1${attempt}:30.000Z`, reason: 'The worker cannot build this commit.' })
    }

    const retired = store.retireBaselineRepairForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:20:00.000Z',
    })

    expect(retired).toBe(1)
    expect(store.getDashboardSnapshot('2026-08-13T01:21:00.000Z').tasks)
      .toContainEqual(expect.objectContaining({
        id: queued.taskId,
        state: { _tag: 'Superseded', reason: 'The default branch no longer fails at this base commit.' },
      }))
  })

  it('leaves a live Baseline repair alone when a review sees a healthy base', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'baseline-keep-pr',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:01:00.000Z', 600_000)
    if (review === null)
      throw new Error('Expected the review Task.')
    store.queueBaselineRepairForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      baseSha: review.pullRequest.baseSha,
      at: '2026-08-13T01:02:00.000Z',
    })

    expect(store.retireBaselineRepairForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:03:00.000Z',
    })).toBe(0)
    expect(store.claimNextBaselineRepairTask('baseline-agent', '2026-08-13T01:04:00.000Z', 600_000)).not.toBeNull()
  })

  it('stages and claims a Baseline repair publication for a repository Harlan maintains', () => {
    const store = createStore()
    const mapping = repositoryMapping({ ownership: 'maintained' })
    store.syncRepositories([mapping], '2026-08-13T00:00:00.000Z')
    const subject = pullRequestItem({ mergeState: 'clean' })
    store.recordObservation({ externalId: 'baseline-publish', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject })
    const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:01:00.000Z', 600_000)
    if (review === null)
      throw new Error('Expected the review Task.')
    const queued = store.queueBaselineRepairForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      baseSha: review.pullRequest.baseSha,
      at: '2026-08-13T01:02:00.000Z',
    })
    if (queued._tag === 'Rejected' || queued._tag === 'NotAuthorized')
      throw new Error(queued.reason)
    const repair = store.claimNextBaselineRepairTask('baseline-agent', '2026-08-13T01:03:00.000Z', 600_000)
    if (repair === null)
      throw new Error('Expected the Baseline repair Task.')

    const staged = store.stagePublication({
      taskId: repair.id,
      workerId: repair.state.workerId,
      fence: repair.state.fence,
      at: '2026-08-13T01:04:00.000Z',
      publication: {
        _tag: 'OpenPullRequest',
        taskKind: 'baseline_repair',
        pullRequestNumber: subject.number,
        pullRequestTitle: 'fix(ci): repair the default branch build',
        pullRequestBody: 'Repairs the default branch build.',
        commitSha: 'repair-commit',
        baseSha: subject.baseSha,
        expectedHeadSha: subject.baseSha,
        headRef: 'fix/baseline-ci-abcdef012345',
        artifactRef: 'artifact-ref',
        patchDigest: 'patch-digest',
        changedFiles: 2,
      },
    })

    expect(staged._tag).toBe('Staged')
    if (staged._tag !== 'Staged')
      throw new Error('Expected the publication to stage.')
    expect(store.claimNextPublication('publisher-1', '2026-08-13T01:05:00.000Z', 600_000))
      .toEqual(expect.objectContaining({ taskKind: 'baseline_repair' }))
  })

  it.each([
    ['stacked on another pull request', 'fix/parent-work', 'NotAuthorized'],
    ['based on the default branch', 'main', 'Queued'],
  ])('refuses Baseline repair for a pull request %s', (_name, baseRef, expected) => {
    const store = createStore()
    store.syncRepositories([repositoryMapping({ defaultBranch: 'main' })], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: `baseline-stack-${baseRef}`,
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean', baseRef }),
    })
    const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:01:00.000Z', 600_000)
    if (review === null)
      throw new Error('Expected the review Task.')

    expect(store.queueBaselineRepairForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      baseSha: review.pullRequest.baseSha,
      at: '2026-08-13T01:02:00.000Z',
    })._tag).toBe(expected)
  })

  it('queues a new Baseline repair after the previous one failed', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'baseline-retry-pr',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:01:00.000Z', 600_000)
    if (review === null)
      throw new Error('Expected the review Task.')
    const input = {
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      baseSha: review.pullRequest.baseSha,
      at: '2026-08-13T01:02:00.000Z',
    }
    const queued = store.queueBaselineRepairForReview(input)
    if (queued._tag === 'Rejected' || queued._tag === 'NotAuthorized')
      throw new Error(queued.reason)
    const repair = store.claimNextBaselineRepairTask('baseline-agent', '2026-08-13T01:03:00.000Z', 600_000)
    if (repair === null)
      throw new Error('Expected the Baseline repair Task.')
    for (const attempt of [1, 2, 3]) {
      const claimed = attempt === 1
        ? repair
        : store.claimNextBaselineRepairTask('baseline-agent', `2026-08-13T01:0${2 + attempt}:00.000Z`, 600_000)
      if (claimed === null)
        throw new Error('Expected the Baseline repair Task to retry.')
      store.failTask({
        taskId: claimed.id,
        workerId: claimed.state.workerId,
        fence: claimed.state.fence,
        at: `2026-08-13T01:0${2 + attempt}:30.000Z`,
        reason: 'The remote branch changed before publication.',
      })
    }
    expect(store.getDashboardSnapshot('2026-08-13T01:06:00.000Z').tasks)
      .toContainEqual(expect.objectContaining({ id: queued.taskId, state: { _tag: 'Failed', reason: 'The remote branch changed before publication.' } }))

    expect(store.queueBaselineRepairForReview({ ...input, at: '2026-08-13T01:07:00.000Z' }))
      .toEqual({ _tag: 'Queued', taskId: queued.taskId })
    expect(store.claimNextBaselineRepairTask('baseline-agent', '2026-08-13T01:08:00.000Z', 600_000))
      .toEqual(expect.objectContaining({ id: queued.taskId }))
  })

  it('queues one Baseline repair for one failing base commit', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'baseline-repair-pr',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:01:00.000Z', 600_000)
    if (review === null)
      throw new Error('Expected the review Task.')
    const input = {
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      baseSha: review.pullRequest.baseSha,
      at: '2026-08-13T01:02:00.000Z',
    }

    const queued = store.queueBaselineRepairForReview(input)
    expect(queued).toEqual({ _tag: 'Queued', taskId: expect.any(String) })
    if (queued._tag === 'Rejected' || queued._tag === 'NotAuthorized')
      throw new Error(queued.reason)
    expect(store.queueBaselineRepairForReview(input)).toEqual({ _tag: 'Existing', taskId: queued.taskId })

    const repair = store.claimNextBaselineRepairTask('baseline-agent', '2026-08-13T01:03:00.000Z', 600_000)
    expect(repair).toEqual(expect.objectContaining({
      id: queued.taskId,
      kind: 'baseline_repair',
      pullRequest: expect.objectContaining({ baseSha: review.pullRequest.baseSha }),
    }))
    if (repair === null)
      throw new Error('Expected the Baseline repair Task.')
    expect(store.stagePublication({
      taskId: repair.id,
      workerId: repair.state.workerId,
      fence: repair.state.fence,
      at: '2026-08-13T01:04:00.000Z',
      publication: {
        _tag: 'OpenPullRequest',
        taskKind: 'baseline_repair',
        pullRequestNumber: repair.pullRequestNumber,
        pullRequestTitle: 'fix: repair default branch CI',
        pullRequestBody: 'Repairs the failing default branch check.',
        commitSha: 'repair-commit',
        baseSha: repair.pullRequest.baseSha,
        expectedHeadSha: repair.pullRequest.baseSha,
        headRef: 'fix/baseline-ci',
        artifactRef: 'refs/harlan-github-agent/publications/baseline',
        patchDigest: 'patch-digest',
        changedFiles: 1,
      },
    })._tag).toBe('Staged')
    expect(store.claimNextPublication('publisher', '2026-08-13T01:05:00.000Z', 60_000)).toEqual(expect.objectContaining({
      _tag: 'OpenPullRequest',
      taskKind: 'baseline_repair',
      pullRequestNumber: repair.pullRequestNumber,
    }))
  })

  it('claims an owned repair inside its active review', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'owned-pr-findings',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:00:30.000Z', 600_000)
    if (review === null)
      throw new Error('Expected the review Task.')
    const gates = passedReviewGates()
    gates.review = { _tag: 'Failed', reason: 'The boundary accepts invalid input.', evidence: [] }
    store.recordReviewRun({
      id: 'owned-attempt',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      headSha: 'abc123',
      provider: 'codex',
      sessionId: 'owned-session',
      model: 'gpt-5.6',
      agentVersion: '1.2.3',
      skillDigest: 'f'.repeat(64),
      startedAt: '2026-08-13T01:01:00.000Z',
      completedAt: '2026-08-13T01:02:00.000Z',
      gates,
      findings: [{ _tag: 'Open', summary: 'Invalid input crosses the boundary.', nextAction: 'Parse the input before use.' }],
    })

    expect(store.getDashboardSnapshot('2026-08-13T01:03:00.000Z').items[0]).toEqual(expect.objectContaining({
      approval: { _tag: 'NotRequired' },
    }))
    const repair = claimedRepair(store.claimReviewFixTaskForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:05:00.000Z',
      leaseMilliseconds: 60_000,
    }))
    expect(repair).toEqual(expect.objectContaining({ kind: 'review_fix' }))
    const dashboard = store.getDashboardSnapshot('2026-08-13T01:05:00.050Z')
    expect(dashboard.agents.filter(agent => agent._tag === 'ActiveAgent')).toEqual([
      expect.objectContaining({ role: 'adversarial_review', itemNumber: 24 }),
    ])
    expect(dashboard.queue).toContainEqual(expect.objectContaining({
      number: 24,
      state: { _tag: 'Active', work: 'adversarial_review' },
    }))
    const stagedStatus = store.stageReviewStatus({
      taskKind: 'review_fix',
      taskId: repair.id,
      workerId: repair.state.workerId,
      fence: repair.state.fence,
      at: '2026-08-13T01:05:00.100Z',
      revisionId: repair.revisionId,
      expectedHeadSha: repair.pullRequest.headSha,
      phase: 'repair',
      body: '<!-- harlan-agent-kit:pr-triage -->\nRepair in progress.',
    })
    if (stagedStatus._tag === 'Rejected')
      throw new Error(stagedStatus.reason)
    const status = store.claimReviewStatus(stagedStatus.commandId, 'status-publisher', '2026-08-13T01:05:00.200Z', 60_000)
    expect(status).toEqual(expect.objectContaining({
      taskKind: 'review_fix',
      taskId: repair.id,
      phase: 'repair',
      expectedHeadSha: repair.pullRequest.headSha,
    }))
    if (status === null)
      throw new Error('Expected a repair status command.')
    expect(store.completeReviewStatus({
      commandId: status.id,
      workerId: status.workerId,
      fence: status.fence,
      at: '2026-08-13T01:05:00.300Z',
      commentId: 42,
      url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
    })).toBe(true)
    expect(store.stagePublication({
      taskId: repair.id,
      workerId: repair.state.workerId,
      fence: repair.state.fence,
      at: '2026-08-13T01:05:01.000Z',
      publication: {
        _tag: 'UpdatePullRequest',
        taskKind: 'review_fix',
        pullRequestNumber: repair.pullRequestNumber,
        commitSha: 'repair-commit',
        baseSha: 'base123',
        expectedHeadSha: 'abc123',
        headRef: 'fix/broken-thing',
        artifactRef: 'refs/harlan-github-agent/publications/repair-task',
        patchDigest: 'repair-patch',
        changedFiles: 2,
      },
    })._tag).toBe('Staged')
    expect(store.claimNextPublication('publisher', '2026-08-13T01:05:02.000Z', 60_000)).toEqual(expect.objectContaining({
      taskKind: 'review_fix',
    }))
  })

  it('reclaims a superseded repair after policy returns for its exact head commit', () => {
    const store = createStore()
    const mapping = repositoryMapping()
    store.syncRepositories([mapping], '2026-08-13T00:00:00.000Z')
    const first = store.recordObservation({
      externalId: 'repair-head-a',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (first._tag !== 'Inserted')
      throw new Error('Expected the first pull request head.')
    const firstReview = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:00:01.000Z', 600_000)
    if (firstReview === null)
      throw new Error('Expected the first review Task.')
    const gates = passedReviewGates()
    gates.review = { _tag: 'Failed', reason: 'The boundary accepts invalid input.', evidence: [] }
    store.recordReviewRun({
      id: 'repair-head-a-attempt',
      repository: mapping.github,
      pullRequestNumber: firstReview.pullRequestNumber,
      revisionId: first.revisionId,
      headSha: firstReview.pullRequest.headSha,
      provider: 'codex',
      sessionId: 'repair-head-a-session',
      model: 'gpt-5.6',
      agentVersion: '1.2.3',
      skillDigest: 'f'.repeat(64),
      startedAt: '2026-08-13T01:00:02.000Z',
      completedAt: '2026-08-13T01:00:03.000Z',
      gates,
      findings: [{ _tag: 'Open', summary: 'Invalid input crosses the boundary.', nextAction: 'Parse the input before use.' }],
    })
    expect(store.claimReviewFixTaskForReview({
      taskId: firstReview.id,
      workerId: firstReview.state.workerId,
      fence: firstReview.state.fence,
      at: '2026-08-13T01:00:04.000Z',
      leaseMilliseconds: 60_000,
    })._tag).toBe('Claimed')

    store.syncRepositories([{ ...mapping, pullRequestReview: false }], '2026-08-13T01:01:00.000Z')
    store.syncRepositories([mapping], '2026-08-13T01:02:00.000Z')
    expect(store.requestReviewRerun({
      repository: mapping.github,
      pullRequestNumber: firstReview.pullRequestNumber,
      revisionId: first.revisionId,
      requestId: 'repair-head-a-rerun',
      source: 'dashboard',
      requestedBy: 'harlan-zw',
      at: '2026-08-13T01:02:01.000Z',
    })._tag).toBe('Queued')
    const rerun = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:02:02.000Z', 600_000)
    if (rerun === null)
      throw new Error('Expected the returned head review Task.')
    expect(store.getDashboardSnapshot('2026-08-13T01:02:02.000Z').tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'review_fix', revisionId: first.revisionId, state: { _tag: 'Superseded', reason: 'Repository policy no longer permits this change.' } }),
    ]))

    expect(store.claimReviewFixTaskForReview({
      taskId: rerun.id,
      workerId: rerun.state.workerId,
      fence: rerun.state.fence,
      at: '2026-08-13T01:02:03.000Z',
      leaseMilliseconds: 60_000,
    })).toEqual({ _tag: 'Claimed', task: expect.objectContaining({ kind: 'review_fix', revisionId: first.revisionId }) })
  })

  it('does not carry Approval to a new Revision', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'outside-pr-old',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ author: 'contributor', mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    store.approvePullRequest({
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      kind: 'review',
      at: '2026-08-13T01:01:00.000Z',
    })
    store.recordObservation({
      externalId: 'outside-pr-new',
      observedAt: '2026-08-13T02:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ author: 'contributor', mergeState: 'clean', headSha: 'new-head', updatedAt: '2026-08-13T02:00:00.000Z' }),
    })

    expect(store.getDashboardSnapshot('2026-08-13T02:00:00.000Z').items[0]).toEqual(expect.objectContaining({
      approval: { _tag: 'ReviewRequired' },
    }))
  })

  it('keeps Approval when only GitHub activity time changes', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'outside-pr-before-agent-comment',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ author: 'contributor', mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    store.approvePullRequest({
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      kind: 'review',
      at: '2026-08-13T01:01:00.000Z',
    })

    const afterComment = store.recordObservation({
      externalId: 'outside-pr-after-agent-comment',
      observedAt: '2026-08-13T01:02:00.000Z',
      source: 'poll',
      subject: pullRequestItem({
        author: 'contributor',
        mergeState: 'clean',
        updatedAt: '2026-08-13T01:02:00.000Z',
      }),
    })

    expect(afterComment).toEqual({ _tag: 'Duplicate', revisionId: observed.revisionId })
    expect(store.getDashboardSnapshot('2026-08-13T01:02:00.000Z').items[0]).toEqual(expect.objectContaining({
      updatedAt: '2026-08-13T01:02:00.000Z',
      approval: { _tag: 'ReviewApproved', approvedAt: '2026-08-13T01:01:00.000Z' },
    }))
  })

  it('keeps a newer revision current when an older observation arrives', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'newer',
      observedAt: '2026-08-13T02:00:00.000Z',
      source: 'poll',
      subject: issueItem({ title: 'New title', updatedAt: '2026-08-13T02:00:00.000Z' }),
    })

    const result = store.recordObservation({
      externalId: 'older',
      observedAt: '2026-08-13T03:00:00.000Z',
      source: 'webhook',
      subject: issueItem({ title: 'Old title', updatedAt: '2026-08-13T01:00:00.000Z' }),
    })

    expect(result._tag).toBe('Stale')
    expect(store.getDashboardSnapshot('2026-08-13T03:00:00.000Z').items[0]?.title).toBe('New title')
  })

  it('supersedes conflict work when the pull request becomes clean', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'conflicting',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })
    store.recordObservation({
      externalId: 'clean',
      observedAt: '2026-08-13T02:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean', updatedAt: '2026-08-13T02:00:00.000Z' }),
    })

    expect(store.getDashboardSnapshot('2026-08-13T02:00:00.000Z').tasks[0]?.state._tag).toBe('Superseded')
  })

  it('rejects completion from an expired worker fence', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'conflicting',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })
    const first = store.claimNextConflictTask('worker-1', '2026-08-13T01:00:00.000Z', 1_000)
    const second = store.claimNextConflictTask('worker-2', '2026-08-13T01:00:02.000Z', 2_000)

    expect(first?.state.fence).toBe(1)
    expect(second?.state.fence).toBe(2)
    expect(store.completeTask({
      taskId: first?.id ?? '',
      workerId: 'worker-1',
      fence: first?.state.fence ?? 0,
      at: '2026-08-13T01:00:03.000Z',
      evidence: 'stale',
    })).toBe(false)
    expect(store.completeTask({
      taskId: second?.id ?? '',
      workerId: 'worker-2',
      fence: second?.state.fence ?? 0,
      at: '2026-08-13T01:00:03.000Z',
      evidence: 'verified',
    })).toBe(true)
  })

  it('rejects publication staging after the task lease expires', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'conflicting-expired',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })
    const task = store.claimNextConflictTask('worker-1', '2026-08-13T01:00:00.000Z', 1_000)
    if (task === null)
      throw new Error('Expected a conflict task.')

    expect(store.stagePublication({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:00:02.000Z',
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
    })._tag).toBe('Rejected')
  })

  it('stages a content-equivalent merge commit', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'content-equivalent-conflict',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })
    const task = store.claimNextConflictTask('worker-1', '2026-08-13T01:00:00.000Z', 10_000)
    if (task === null)
      throw new Error('Expected a conflict task.')

    expect(store.stagePublication({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:00:01.000Z',
      publication: {
        _tag: 'UpdatePullRequest',
        taskKind: 'resolve_conflict',
        pullRequestNumber: task.pullRequestNumber,
        commitSha: 'merge123',
        baseSha: 'base123',
        expectedHeadSha: 'abc123',
        headRef: 'fix/broken-thing',
        artifactRef: 'refs/harlan-github-agent/publications/task-1',
        patchDigest: 'empty-patch',
        changedFiles: 0,
      },
    })._tag).toBe('Staged')
  })

  it('closes subjects missing from a complete repository snapshot', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'issue-open',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: issueItem(),
    })

    expect(store.closeMissingItems('harlan-zw/example', [], '2026-08-13T02:00:00.000Z')).toBe(1)
    expect(store.getDashboardSnapshot('2026-08-13T02:00:00.000Z').items).toHaveLength(0)
  })

  it('disables removed repository mappings and supersedes their tasks', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'conflicting',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })

    store.syncRepositories([], '2026-08-13T02:00:00.000Z')

    const snapshot = store.getDashboardSnapshot('2026-08-13T02:00:00.000Z')
    expect(snapshot.repositories).toHaveLength(0)
    expect(snapshot.tasks[0]?.state._tag).toBe('Superseded')
  })

  it('supersedes review work when its repository topic policy is removed', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'clean-review',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })

    store.syncRepositories([repositoryMapping({ pullRequestReview: false })], '2026-08-13T01:01:00.000Z')

    expect(store.claimNextAdversarialReviewTask('worker-1', '2026-08-13T01:02:00.000Z', 10_000)).toBeNull()
    expect(store.getDashboardSnapshot('2026-08-13T01:02:00.000Z').queue).toEqual([])
  })

  it('revokes a running review when a trusted review covers the current head commit', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    store.recordObservation({
      externalId: 'review-unclaimed',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequest,
    })
    const task = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T01:01:00.000Z', 45 * 60_000)
    if (task === null)
      throw new Error('Expected a running review.')

    store.recordObservation({
      externalId: 'review-claimed-elsewhere',
      observedAt: '2026-08-13T01:02:00.000Z',
      source: 'poll',
      subject: {
        ...pullRequest,
        priorAutomatedReview: {
          _tag: 'Found',
          authorLogin: 'harlan-zw',
          state: 'complete',
          url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
        },
      },
    })

    expect(store.heartbeatWorkerTask({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:02:01.000Z',
      leaseMilliseconds: 45 * 60_000,
    })).toBe(false)
    expect(store.getDashboardSnapshot('2026-08-13T01:02:01.000Z').tasks.find(item => item.id === task.id)?.state).toEqual({
      _tag: 'Superseded',
      reason: 'The current head commit already has an automated review.',
    })
  })

  it('reruns a completed review for the exact current head commit', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'review-rerun',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request.')
    const first = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T01:01:00.000Z', 10_000)
    if (first === null)
      throw new Error('Expected the first review.')
    expect(store.completeWorkerTask({
      taskId: first.id,
      workerId: first.state.workerId,
      fence: first.state.fence,
      at: '2026-08-13T01:01:01.000Z',
      evidence: 'Waiting for CI.',
    })).toBe(true)

    expect(store.requestReviewRerun({
      repository: first.repository,
      pullRequestNumber: first.pullRequestNumber,
      revisionId: first.revisionId,
      requestId: 'dashboard:request-1',
      source: 'dashboard',
      requestedBy: 'harlan-zw',
      at: '2026-08-13T01:02:00.000Z',
    })).toEqual({ _tag: 'Queued', taskId: first.id })

    const rerun = store.claimNextAdversarialReviewTask('reviewer-2', '2026-08-13T01:02:01.000Z', 10_000)
    expect(rerun).toEqual(expect.objectContaining({ id: first.id, revisionId: observed.revisionId }))
    expect(rerun?.state.fence).toBe(2)
  })

  it('reviews the same head again after its base commit changes', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const firstObservation = store.recordObservation({
      externalId: 'review-old-base',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean', baseSha: 'old-base' }),
    })
    if (firstObservation._tag !== 'Inserted')
      throw new Error('Expected the first pull request revision.')
    const first = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T01:01:00.000Z', 10_000)
    if (first === null)
      throw new Error('Expected the first review.')
    store.recordReviewRun({
      id: 'old-base-attempt',
      repository: first.repository,
      pullRequestNumber: first.pullRequestNumber,
      revisionId: first.revisionId,
      headSha: first.pullRequest.headSha,
      provider: 'codex',
      sessionId: 'old-base-session',
      model: 'gpt-5.6',
      agentVersion: '1.2.3',
      skillDigest: 'f'.repeat(64),
      startedAt: '2026-08-13T01:01:00.000Z',
      completedAt: '2026-08-13T01:02:00.000Z',
      gates: passedReviewGates(),
      confidence: 95,
      findings: [],
    })
    store.completeWorkerTask({
      taskId: first.id,
      workerId: first.state.workerId,
      fence: first.state.fence,
      at: '2026-08-13T01:02:00.000Z',
      evidence: 'Reviewed old base.',
    })
    const secondObservation = store.recordObservation({
      externalId: 'review-new-base',
      observedAt: '2026-08-13T02:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({
        mergeState: 'clean',
        baseSha: 'new-base',
        priorAutomatedReview: {
          _tag: 'Found',
          authorLogin: 'harlan-github-agent[bot]',
          state: 'complete',
          url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
        },
      }),
    })
    if (secondObservation._tag !== 'Inserted')
      throw new Error('Expected the new base revision.')

    expect(store.claimNextAdversarialReviewTask('reviewer-2', '2026-08-13T02:01:00.000Z', 10_000)).toEqual(expect.objectContaining({
      revisionId: secondObservation.revisionId,
      pullRequest: expect.objectContaining({ baseSha: 'new-base' }),
    }))
  })

  it('deduplicates one GitHub review rerun command', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'review-command',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request.')
    const input = {
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      requestId: 'github-comment:42:2026-08-13T01:01:00.000Z',
      source: 'github_comment' as const,
      requestedBy: 'harlan-zw',
      at: '2026-08-13T01:01:00.000Z',
    }

    expect(store.requestReviewRerun(input)._tag).toBe('AlreadyQueued')
    expect(store.requestReviewRerun(input)._tag).toBe('Duplicate')
  })

  it('rejects a GitHub review rerun command from an untrusted author', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'untrusted-review-command',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request.')

    expect(store.requestReviewRerun({
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      requestId: 'github-comment:43:2026-08-13T01:01:00.000Z',
      source: 'github_comment',
      requestedBy: 'outside-contributor',
      at: '2026-08-13T01:01:00.000Z',
    })).toEqual({ _tag: 'Rejected', reason: { _tag: 'AuthorNotAllowed' } })
  })

  it('rejects a review status after its review task fence changes', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'status-fence',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    const first = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T01:00:00.000Z', 1_000)
    if (first === null)
      throw new Error('Expected a review Task.')
    const staged = store.stageReviewStatus({
      taskKind: 'adversarial_review',
      taskId: first.id,
      workerId: first.state.workerId,
      fence: first.state.fence,
      at: '2026-08-13T01:00:00.500Z',
      revisionId: observed.revisionId,
      expectedHeadSha: first.pullRequest.headSha,
      phase: 'snapshot',
      body: '<!-- harlan-agent-kit:pr-triage -->\nReview started.',
    })
    if (staged._tag === 'Rejected')
      throw new Error(staged.reason)
    const status = store.claimReviewStatus(staged.commandId, 'publisher-1', '2026-08-13T01:00:00.600Z', 10_000)
    if (status === null)
      throw new Error('Expected a review status Publication command.')

    const second = store.claimNextAdversarialReviewTask('reviewer-2', '2026-08-13T01:00:02.000Z', 10_000)
    expect(second?.state.fence).toBe(2)
    if (second === null)
      throw new Error('Expected the review task retry.')
    const restaged = store.stageReviewStatus({
      taskKind: 'adversarial_review',
      taskId: second.id,
      workerId: second.state.workerId,
      fence: second.state.fence,
      at: '2026-08-13T01:00:02.100Z',
      revisionId: observed.revisionId,
      expectedHeadSha: second.pullRequest.headSha,
      phase: 'snapshot',
      body: '<!-- harlan-agent-kit:pr-triage -->\nReview started.',
    })
    if (restaged._tag === 'Rejected')
      throw new Error(restaged.reason)
    expect(restaged.commandId).not.toBe(staged.commandId)
    expect(store.claimReviewStatus(restaged.commandId, 'publisher-2', '2026-08-13T01:00:02.200Z', 10_000)).not.toBeNull()
    expect(store.completeReviewStatus({
      commandId: status.id,
      workerId: status.workerId,
      fence: status.fence,
      at: '2026-08-13T01:00:02.300Z',
      commentId: 42,
      url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
    })).toBe(false)
  })

  it('retries a failed review after GitHub App permissions change', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'permission-retry',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    const permissionError = 'The level of access for permissions requested are not granted to this installation.'
    let revisionId = ''
    for (const attempt of [1, 2, 3]) {
      const at = `2026-08-13T01:00:0${attempt}.000Z`
      const task = store.claimNextAdversarialReviewTask(`worker-${attempt}`, at, 10_000)
      if (task === null)
        throw new Error(`Expected review attempt ${attempt}.`)
      revisionId = task.revisionId
      expect(store.failWorkerTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        reason: permissionError,
      })).toBe(attempt < 3 ? 'Retrying' : 'Failed')
    }
    const gates = passedReviewGates()
    gates.review = { _tag: 'Failed', reason: 'The previous review failed.', evidence: [] }
    store.recordReviewRun({
      id: 'permission-retry-attempt',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId,
      headSha: 'abc123',
      provider: 'codex',
      sessionId: 'permission-retry-session',
      model: 'gpt-5.6',
      agentVersion: '1.2.3',
      skillDigest: 'f'.repeat(64),
      startedAt: '2026-08-13T01:00:01.000Z',
      completedAt: '2026-08-13T01:00:03.000Z',
      gates,
      findings: [{ _tag: 'Open', summary: 'Old finding.', nextAction: 'Run the review again.' }],
    })

    expect(store.retryRecoverableWorkerFailures('2026-08-13T01:00:04.000Z')).toBe(1)
    expect(store.claimNextAdversarialReviewTask('worker-4', '2026-08-13T01:00:05.000Z', 10_000)?.state.fence).toBe(4)
    expect(store.getDashboardSnapshot('2026-08-13T01:00:06.000Z').queue).toContainEqual(expect.objectContaining({
      number: 24,
      state: { _tag: 'Active', work: 'adversarial_review' },
    }))
  })

  it.each([
    ['a repair claim race passes', 'The repair Task changed before the review claimed it.'],
    ['stale duplicate CI is classified correctly', 'Repository policy does not authorize Baseline repair for this base commit.'],
  ])('retries a review after %s', (_scenario, reason) => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'inline-repair-claim-retry',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    for (const attempt of [1, 2, 3]) {
      const at = `2026-08-13T01:00:0${attempt}.000Z`
      const task = store.claimNextAdversarialReviewTask(`worker-${attempt}`, at, 10_000)
      if (task === null)
        throw new Error(`Expected review attempt ${attempt}.`)
      store.failWorkerTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        reason,
      })
    }

    expect(store.retryRecoverableWorkerFailures('2026-08-13T01:00:04.000Z')).toBe(1)
    expect(store.claimNextAdversarialReviewTask('worker-4', '2026-08-13T01:00:05.000Z', 10_000)?.state.fence).toBe(4)
  })

  it('retries a review after corrected publication staging becomes available', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'review-publication-staging-retry',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    const reason = 'The task already has a different publication command.'
    for (const attempt of [1, 2, 3]) {
      const at = `2026-08-13T01:00:0${attempt}.000Z`
      const task = store.claimNextAdversarialReviewTask(`worker-${attempt}`, at, 10_000)
      if (task === null)
        throw new Error(`Expected review attempt ${attempt}.`)
      store.failWorkerTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        reason,
      })
    }

    expect(store.retryRecoverableWorkerFailures('2026-08-13T01:00:04.000Z')).toBe(1)
    expect(store.claimNextAdversarialReviewTask('worker-4', '2026-08-13T01:00:05.000Z', 10_000)?.state.fence).toBe(4)
  })

  it.each([
    ['corrected publication staging becomes available', 'The task already has a different publication command.'],
    ['GitHub App permissions are granted', 'The permissions requested are not granted to this installation.'],
  ])('retries mutation work after %s', (_scenario, reason) => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'mutation-publication-staging-retry',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })
    for (const attempt of [1, 2, 3]) {
      const at = `2026-08-13T01:00:0${attempt}.000Z`
      const task = store.claimNextConflictTask(`worker-${attempt}`, at, 10_000)
      if (task === null)
        throw new Error(`Expected conflict attempt ${attempt}.`)
      store.failTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        reason,
      })
    }

    expect(store.retryRecoverableWorkerFailures('2026-08-13T01:00:04.000Z')).toBe(1)
    expect(store.claimNextConflictTask('worker-4', '2026-08-13T01:00:05.000Z', 10_000)?.state.fence).toBe(4)
  })

  it('requeues the combined reviewer when its repair recovers', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'combined-review-recovery',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a pull request revision.')
    const review = store.claimNextAdversarialReviewTask('review-worker', '2026-08-13T01:00:01.000Z', 60_000)
    if (review === null)
      throw new Error('Expected review work.')
    const gates = passedReviewGates()
    gates.review = { _tag: 'Failed', reason: 'The workflow needs repair.', evidence: [] }
    store.recordReviewRun({
      id: 'combined-review-recovery-attempt',
      repository: review.repository,
      pullRequestNumber: review.pullRequestNumber,
      revisionId: review.revisionId,
      headSha: review.pullRequest.headSha,
      provider: 'codex',
      sessionId: 'combined-review-recovery-session',
      model: 'gpt-5.6',
      agentVersion: '1.2.3',
      skillDigest: 'f'.repeat(64),
      startedAt: '2026-08-13T01:00:01.000Z',
      completedAt: '2026-08-13T01:00:02.000Z',
      gates,
      findings: [{ _tag: 'Open', summary: 'Workflow defect.', nextAction: 'Repair the workflow.' }],
    })
    const firstRepair = claimedRepair(store.claimReviewFixTaskForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:00:03.000Z',
      leaseMilliseconds: 10_000,
    }))
    const reason = 'The permissions requested are not granted to this installation.'
    store.failTask({
      taskId: firstRepair.id,
      workerId: firstRepair.state.workerId,
      fence: firstRepair.state.fence,
      at: '2026-08-13T01:00:04.000Z',
      reason,
    })
    for (const attempt of [2, 3]) {
      const at = `2026-08-13T01:00:0${attempt + 3}.000Z`
      const repair = store.claimNextReviewFixTask(`repair-worker-${attempt}`, at, 10_000)
      if (repair === null)
        throw new Error(`Expected repair attempt ${attempt}.`)
      store.failTask({
        taskId: repair.id,
        workerId: repair.state.workerId,
        fence: repair.state.fence,
        at,
        reason,
      })
    }
    store.completeWorkerTask({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:00:07.000Z',
      evidence: 'Repair publication failed.',
    })

    expect(store.retryRecoverableWorkerFailures('2026-08-13T01:00:08.000Z')).toBe(1)
    expect(store.claimNextAdversarialReviewTask('review-worker-2', '2026-08-13T01:00:09.000Z', 10_000)).toEqual(expect.objectContaining({
      id: review.id,
      state: expect.objectContaining({ fence: 2 }),
    }))
  })

  it('requeues a completed reviewer with orphaned queued repair work', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'orphaned-review-repair',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a pull request revision.')
    const review = store.claimNextAdversarialReviewTask('review-worker', '2026-08-13T01:00:01.000Z', 60_000)
    if (review === null)
      throw new Error('Expected review work.')
    const gates = passedReviewGates()
    gates.review = { _tag: 'Failed', reason: 'Repair required.', evidence: [] }
    store.recordReviewRun({
      id: 'orphaned-review-repair-attempt',
      repository: review.repository,
      pullRequestNumber: review.pullRequestNumber,
      revisionId: review.revisionId,
      headSha: review.pullRequest.headSha,
      provider: 'codex',
      sessionId: 'orphaned-review-repair-session',
      model: 'gpt-5.6',
      agentVersion: '1.2.3',
      skillDigest: 'f'.repeat(64),
      startedAt: '2026-08-13T01:00:01.000Z',
      completedAt: '2026-08-13T01:00:02.000Z',
      gates,
      findings: [{ _tag: 'Open', summary: 'Repair required.', nextAction: 'Apply the repair.' }],
    })
    const repair = claimedRepair(store.claimReviewFixTaskForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:00:02.500Z',
      leaseMilliseconds: 10_000,
    }))
    store.failTask({
      taskId: repair.id,
      workerId: repair.state.workerId,
      fence: repair.state.fence,
      at: '2026-08-13T01:00:02.750Z',
      reason: 'Transient repair failure.',
    })
    store.completeWorkerTask({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:00:03.000Z',
      evidence: 'Repair remains queued.',
    })
    expect(store.getDashboardSnapshot('2026-08-13T01:00:03.500Z').tasks.find(task => task.kind === 'review_fix')?.state).toEqual({ _tag: 'Queued' })

    expect(store.retryRecoverableWorkerFailures('2026-08-13T01:00:04.000Z')).toBe(1)
    expect(store.claimNextAdversarialReviewTask('review-worker-2', '2026-08-13T01:00:05.000Z', 10_000)).toEqual(expect.objectContaining({
      id: review.id,
      state: expect.objectContaining({ fence: 2 }),
    }))
  })

  it('retries a Baseline repair after its pull request token gains ref access', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'baseline-ref-access-retry',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:00:01.000Z', 600_000)
    if (review === null)
      throw new Error('Expected a review Task.')
    const queued = store.queueBaselineRepairForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      baseSha: review.pullRequest.baseSha,
      at: '2026-08-13T01:00:02.000Z',
    })
    if (queued._tag === 'Rejected' || queued._tag === 'NotAuthorized')
      throw new Error(queued.reason)
    const reason = 'Validation Failed: not all refs are readable'
    for (const attempt of [1, 2, 3]) {
      const at = `2026-08-13T01:00:0${attempt + 2}.000Z`
      const task = store.claimNextBaselineRepairTask(`baseline-worker-${attempt}`, at, 10_000)
      if (task === null)
        throw new Error(`Expected Baseline repair attempt ${attempt}.`)
      store.failTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        reason,
      })
    }

    expect(store.retryRecoverableWorkerFailures('2026-08-13T01:00:06.000Z')).toBe(1)
    expect(store.claimNextBaselineRepairTask('baseline-worker-4', '2026-08-13T01:00:07.000Z', 10_000)?.state.fence).toBe(4)
  })

  it('stages a corrected publication after an earlier command failed', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'corrected-publication',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })
    const firstTask = store.claimNextConflictTask('worker-1', '2026-08-13T01:00:01.000Z', 60_000)
    if (firstTask === null)
      throw new Error('Expected conflict work.')
    const first = store.stagePublication({
      taskId: firstTask.id,
      workerId: firstTask.state.workerId,
      fence: firstTask.state.fence,
      at: '2026-08-13T01:00:02.000Z',
      publication: {
        _tag: 'UpdatePullRequest',
        taskKind: 'resolve_conflict',
        pullRequestNumber: firstTask.pullRequestNumber,
        commitSha: 'first-commit',
        baseSha: 'base-sha',
        expectedHeadSha: firstTask.pullRequest.headSha,
        headRef: firstTask.pullRequest.headRef,
        artifactRef: 'first-artifact',
        patchDigest: 'first-patch',
        changedFiles: 1,
      },
    })
    if (first._tag === 'Rejected')
      throw new Error(first.reason)
    const reason = 'Could not list wt worktrees: spawn wt ENOENT'
    for (const attempt of [1, 2, 3]) {
      const at = `2026-08-13T01:00:0${attempt + 2}.000Z`
      const command = store.claimNextPublication(`publisher-${attempt}`, at, 10_000)
      if (command === null)
        throw new Error(`Expected publication attempt ${attempt}.`)
      store.failPublication({
        commandId: command.id,
        workerId: command.workerId,
        fence: command.fence,
        at,
        reason,
      })
    }
    expect(store.retryRecoverableWorkerFailures('2026-08-13T01:00:06.000Z')).toBe(1)
    const secondTask = store.claimNextConflictTask('worker-2', '2026-08-13T01:00:07.000Z', 60_000)
    if (secondTask === null)
      throw new Error('Expected retried conflict work.')
    const second = store.stagePublication({
      taskId: secondTask.id,
      workerId: secondTask.state.workerId,
      fence: secondTask.state.fence,
      at: '2026-08-13T01:00:08.000Z',
      publication: {
        _tag: 'UpdatePullRequest',
        taskKind: 'resolve_conflict',
        pullRequestNumber: secondTask.pullRequestNumber,
        commitSha: 'corrected-commit',
        baseSha: 'base-sha',
        expectedHeadSha: secondTask.pullRequest.headSha,
        headRef: secondTask.pullRequest.headRef,
        artifactRef: 'corrected-artifact',
        patchDigest: 'corrected-patch',
        changedFiles: 1,
      },
    })
    expect(second).toEqual({ _tag: 'Staged', commandId: expect.not.stringMatching(first.commandId) })
    expect(store.claimNextPublication('publisher-4', '2026-08-13T01:00:09.000Z', 10_000)).toEqual(expect.objectContaining({
      commitSha: 'corrected-commit',
    }))
  })

  it('requires fresh triage before retrying approved issue work against a changed scope', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'issue-scope-retry',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: issueItem(),
    })
    const triage = store.claimNextIssueTriageTask('triage-worker', '2026-08-13T01:00:01.000Z', 10_000)
    if (triage === null)
      throw new Error('Expected issue triage.')
    store.completeWorkerTask({
      taskId: triage.id,
      workerId: triage.state.workerId,
      fence: triage.state.fence,
      at: '2026-08-13T01:00:02.000Z',
      evidence: JSON.stringify({ validity: 'valid' }),
    })
    store.approveIssueWork({
      repository: 'harlan-zw/example',
      issueNumber: 12,
      revisionId: triage.revisionId,
      at: '2026-08-13T01:00:03.000Z',
    })
    const reason = 'The issue changed before work started.'
    for (const attempt of [1, 2, 3]) {
      const at = `2026-08-13T01:00:0${attempt + 3}.000Z`
      const task = store.claimNextIssueWorkTask(`issue-worker-${attempt}`, at, 10_000)
      if (task === null)
        throw new Error(`Expected issue work attempt ${attempt}.`)
      store.failTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        reason,
      })
    }

    expect(store.retryRecoverableWorkerFailures('2026-08-13T01:00:07.000Z')).toBe(1)
    expect(store.claimNextIssueWorkTask('issue-worker-4', '2026-08-13T01:00:08.000Z', 10_000)).toBeNull()
    const retriage = store.claimNextIssueTriageTask('triage-worker-2', '2026-08-13T01:00:08.000Z', 10_000)
    if (retriage === null)
      throw new Error('Expected fresh issue triage.')
    expect(retriage.state.fence).toBe(2)
    store.completeWorkerTask({
      taskId: retriage.id,
      workerId: retriage.state.workerId,
      fence: retriage.state.fence,
      at: '2026-08-13T01:00:09.000Z',
      evidence: JSON.stringify({ validity: 'valid' }),
    })
    expect(store.getDashboardSnapshot('2026-08-13T01:00:10.000Z').queue).toContainEqual(expect.objectContaining({
      number: 12,
      state: { _tag: 'AwaitingApproval', kind: 'issue_work' },
    }))
    expect(store.approveIssueWork({
      repository: 'harlan-zw/example',
      issueNumber: 12,
      revisionId: retriage.revisionId,
      at: '2026-08-13T01:00:11.000Z',
    })).toEqual({ _tag: 'Approved', taskId: expect.any(String) })
    expect(store.claimNextIssueWorkTask('issue-worker-4', '2026-08-13T01:00:12.000Z', 10_000)).toEqual(expect.objectContaining({
      kind: 'issue_work',
      issueNumber: 12,
    }))
  })

  it('retries a failed review repair after Worktrunk becomes available', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'worktrunk-retry',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:00:00.500Z', 600_000)
    if (review === null)
      throw new Error('Expected the review Task.')
    const gates = passedReviewGates()
    gates.review = { _tag: 'Failed', reason: 'The boundary is unsafe.', evidence: [] }
    store.recordReviewRun({
      id: 'worktrunk-retry-attempt',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      headSha: 'abc123',
      provider: 'codex',
      sessionId: 'worktrunk-retry-session',
      model: 'gpt-5.6',
      agentVersion: '1.2.3',
      skillDigest: 'f'.repeat(64),
      startedAt: '2026-08-13T01:00:01.000Z',
      completedAt: '2026-08-13T01:00:02.000Z',
      gates,
      findings: [{ _tag: 'Open', summary: 'Unsafe boundary.', nextAction: 'Repair the boundary.' }],
    })
    const firstRepair = claimedRepair(store.claimReviewFixTaskForReview({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:00:03.000Z',
      leaseMilliseconds: 10_000,
    }))
    const reason = 'Could not list wt worktrees: spawn wt ENOENT'
    expect(store.failTask({
      taskId: firstRepair.id,
      workerId: firstRepair.state.workerId,
      fence: firstRepair.state.fence,
      at: '2026-08-13T01:00:03.000Z',
      reason,
    })).toBe('Retrying')
    for (const attempt of [2, 3]) {
      const at = `2026-08-13T01:00:0${attempt + 2}.000Z`
      const task = store.claimNextReviewFixTask(`repair-${attempt}`, at, 10_000)
      if (task === null)
        throw new Error(`Expected repair attempt ${attempt}.`)
      expect(store.failTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        reason,
      })).toBe(attempt < 3 ? 'Retrying' : 'Failed')
    }

    expect(store.retryRecoverableWorkerFailures('2026-08-13T01:00:06.000Z')).toBe(1)
    expect(store.claimNextReviewFixTask('repair-4', '2026-08-13T01:00:07.000Z', 10_000)?.state.fence).toBe(4)
  })

  it('requeues an agent task interrupted by a service restart', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'restart-recovery',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    expect(store.claimNextAdversarialReviewTask('worker-1', '2026-08-13T01:01:00.000Z', 10_000)).not.toBeNull()

    expect(store.recoverInterruptedAgentTasks('2026-08-13T01:02:00.000Z')).toBe(1)
    expect(store.claimNextAdversarialReviewTask('worker-2', '2026-08-13T01:03:00.000Z', 10_000)?.state.fence).toBe(2)
  })

  it('requeues a task that an earlier shutdown recorded as aborted', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'aborted-restart-recovery',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })
    for (const attempt of [1, 2, 3]) {
      const task = store.claimNextConflictTask(`worker-${attempt}`, `2026-08-13T01:01:0${attempt}.000Z`, 10_000)
      if (task === null)
        throw new Error(`Expected conflict attempt ${attempt}.`)
      store.failTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at: `2026-08-13T01:01:0${attempt}.000Z`,
        reason: 'The operation was aborted',
      })
    }

    expect(store.recoverInterruptedAgentTasks('2026-08-13T01:02:00.000Z')).toBe(1)
    expect(store.claimNextConflictTask('worker-4', '2026-08-13T01:03:00.000Z', 10_000)?.state.fence).toBe(4)
  })

  it('records one immutable review attempt and its exact published comment', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'clean-pr',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')

    expect(store.recordReviewRun({
      id: 'attempt-1',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      headSha: 'abc123',
      provider: 'codex',
      sessionId: 'session-1',
      model: 'gpt-5.6',
      agentVersion: '1.2.3',
      skillDigest: 'f'.repeat(64),
      startedAt: '2026-08-13T01:01:00.000Z',
      completedAt: '2026-08-13T01:02:00.000Z',
      gates: passedReviewGates(),
      confidence: 96,
      findings: [{ _tag: 'Fixed', summary: 'Rejected an unsafe path.' }],
    })).toEqual({ _tag: 'Inserted', reviewRunId: 'attempt-1' })

    const body = '### 🤖 READY · 96/100\n\n- **Fixed:** Rejected an unsafe path.'
    expect(store.recordReviewPublication({
      id: 'publication-1',
      reviewRunId: 'attempt-1',
      body,
      at: '2026-08-13T01:03:00.000Z',
      result: {
        _tag: 'Published',
        githubCommentId: 42,
        url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
      },
    })).toEqual({ _tag: 'Inserted', publicationId: 'publication-1' })

    expect(store.listReviewRuns('harlan-zw/example', 24)).toEqual([
      expect.objectContaining({
        id: 'attempt-1',
        outcome: { _tag: 'Ready', confidence: 96 },
        findings: [{ _tag: 'Fixed', summary: 'Rejected an unsafe path.' }],
        publications: [expect.objectContaining({
          id: 'publication-1',
          body,
          result: {
            _tag: 'Published',
            githubCommentId: 42,
            url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
          },
        })],
      }),
    ])
    const dashboard = store.getDashboardSnapshot('2026-08-13T01:04:00.000Z')
    expect(dashboard.agents).toEqual([
      expect.objectContaining({
        _tag: 'ReviewAgent',
        id: 'attempt-1',
        provider: 'codex',
        model: 'gpt-5.6',
        subjectUrl: 'https://github.com/harlan-zw/example/pull/24',
        commitUrl: 'https://github.com/harlan-zw/example/commit/abc123',
        outcome: { _tag: 'Ready', confidence: 96 },
        findings: [{ _tag: 'Fixed', summary: 'Rejected an unsafe path.' }],
        publications: [expect.objectContaining({
          result: {
            _tag: 'Published',
            githubCommentId: 42,
            url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
          },
        })],
      }),
    ])
    expect(dashboard.queue).toEqual([])
  })

  it('keeps a passing review that named no confidence', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'ready-without-confidence',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')

    expect(store.recordReviewRun({
      id: 'attempt-ready-without-confidence',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      headSha: 'abc123',
      provider: 'codex',
      sessionId: 'session-1',
      model: 'gpt-5.6',
      agentVersion: '1.2.3',
      skillDigest: 'f'.repeat(64),
      startedAt: '2026-08-13T01:01:00.000Z',
      completedAt: '2026-08-13T01:02:00.000Z',
      gates: passedReviewGates(),
      findings: [],
    })).toEqual({ _tag: 'Inserted', reviewRunId: 'attempt-ready-without-confidence' })
    expect(store.listReviewRuns('harlan-zw/example', 24)[0]?.outcome).toEqual({ _tag: 'Ready' })
  })

  it('rejects confidence unless every review gate passed', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'waiting-pr',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'unknown' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')

    const gates = passedReviewGates()
    gates.merge = { _tag: 'Pending', reason: 'GitHub has not computed mergeability.', evidence: [] }
    expect(store.recordReviewRun({
      id: 'attempt-waiting',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      headSha: 'abc123',
      provider: 'codex',
      sessionId: 'session-1',
      model: 'gpt-5.6',
      agentVersion: '1.2.3',
      skillDigest: 'f'.repeat(64),
      startedAt: '2026-08-13T01:01:00.000Z',
      completedAt: '2026-08-13T01:02:00.000Z',
      gates,
      confidence: 79,
      findings: [],
    })).toEqual({
      _tag: 'Rejected',
      reason: { _tag: 'ConfidenceRequiresReady' },
    })
  })

  it('never overwrites an immutable review attempt', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'immutable-pr',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    const input = {
      id: 'attempt-immutable',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      headSha: 'abc123',
      provider: 'codex' as const,
      sessionId: 'session-1',
      model: 'gpt-5.6',
      agentVersion: '1.2.3',
      skillDigest: 'f'.repeat(64),
      startedAt: '2026-08-13T01:01:00.000Z',
      completedAt: '2026-08-13T01:02:00.000Z',
      gates: passedReviewGates(),
      confidence: 96,
      findings: [],
    }

    expect(store.recordReviewRun(input)).toEqual({ _tag: 'Inserted', reviewRunId: input.id })
    expect(store.recordReviewRun(input)).toEqual({ _tag: 'Duplicate', reviewRunId: input.id })
    expect(store.recordReviewRun({ ...input, model: 'different-model' })).toEqual({
      _tag: 'Conflict',
      reviewRunId: input.id,
    })
    expect(store.listReviewRuns(input.repository, input.pullRequestNumber)[0]?.model).toBe('gpt-5.6')
  })

  it('records comment publication failures for later analysis', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'blocked-pr',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'conflicting' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')

    const gates = passedReviewGates()
    gates.merge = { _tag: 'Failed', reason: 'Merge conflicts present.', evidence: [] }
    store.recordReviewRun({
      id: 'attempt-blocked',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      headSha: 'abc123',
      provider: 'claude',
      sessionId: 'session-2',
      model: 'claude-opus',
      agentVersion: '1.2.3',
      skillDigest: 'f'.repeat(64),
      startedAt: '2026-08-13T01:01:00.000Z',
      completedAt: '2026-08-13T01:02:00.000Z',
      gates,
      findings: [{ _tag: 'Open', summary: 'Merge conflicts prevent review.', nextAction: 'Resolve conflicts.' }],
    })

    expect(store.recordReviewPublication({
      id: 'publication-failed',
      reviewRunId: 'attempt-blocked',
      body: '### 🤖 BLOCKED',
      at: '2026-08-13T01:03:00.000Z',
      result: { _tag: 'Failed', reason: 'GitHub returned 502.' },
    })).toEqual({ _tag: 'Inserted', publicationId: 'publication-failed' })
    expect(store.listReviewRuns('harlan-zw/example', 24)[0]?.publications[0]?.result).toEqual({
      _tag: 'Failed',
      reason: 'GitHub returned 502.',
    })
  })

  it('reopens the journal without losing review attempts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'harlan-github-agent-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'journal.sqlite')
    const store = openJournalStore(path)
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    const observed = store.recordObservation({
      externalId: 'persisted-pr',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: 'clean' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')

    expect(store.recordReviewRun({
      id: 'attempt-persisted',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId: observed.revisionId,
      headSha: 'abc123',
      provider: 'codex',
      sessionId: 'session-1',
      model: 'gpt-5.6',
      agentVersion: '1.2.3',
      skillDigest: 'f'.repeat(64),
      startedAt: '2026-08-13T01:01:00.000Z',
      completedAt: '2026-08-13T01:02:00.000Z',
      gates: passedReviewGates(),
      confidence: 96,
      findings: [],
    })).toEqual({ _tag: 'Inserted', reviewRunId: 'attempt-persisted' })
    store.close()

    const reopened = openJournalStore(path)
    stores.push(reopened)
    expect(reopened.listReviewRuns('harlan-zw/example', 24)[0]?.id).toBe('attempt-persisted')
  })

  it('reopens a staged Publication command', () => {
    const directory = mkdtempSync(join(tmpdir(), 'harlan-github-agent-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'journal.sqlite')
    const store = openJournalStore(path)
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'persisted-publication',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })
    const task = store.claimNextConflictTask('worker-1', '2026-08-13T01:01:00.000Z', 10 * 60_000)
    if (task === null)
      throw new Error('Expected a conflict task.')
    expect(store.stagePublication({
      taskId: task.id,
      workerId: task.state.workerId,
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
    })._tag).toBe('Staged')
    store.close()

    const reopened = openJournalStore(path)
    stores.push(reopened)
    expect(reopened.claimNextPublication('publisher-1', '2026-08-13T01:03:00.000Z', 10_000)).toEqual(expect.objectContaining({
      commitSha: 'commit123',
      expectedHeadSha: 'abc123',
      artifactRef: 'refs/harlan-github-agent/publications/task-1',
    }))
  })
})

describe('agent selection', () => {
  it('follows the configured Agent provider while nothing is stored', () => {
    const store = createStore()

    expect(store.getAgentSelection()).toEqual({ provider: 'codex', model: null, reasoningEffort: null })
    expect(store.getDashboardSnapshot('2026-08-18T01:00:00.000Z').agentProfile.roles.issue_work.model).toBe('gpt-5.6-terra')
  })

  it('applies a switch to the dashboard profile and keeps agent capacity', () => {
    const store = createStore()

    store.selectAgent({ provider: 'opencode', model: 'opencode-go/deepseek-v4-pro', reasoningEffort: 'low' }, '2026-08-18T01:00:00.000Z')
    const profile = store.getDashboardSnapshot('2026-08-18T01:00:01.000Z').agentProfile

    expect(profile.provider).toBe('opencode')
    expect(profile.roles.adversarial_review).toEqual({ model: 'opencode-go/deepseek-v4-pro', reasoningEffort: 'low' })
    expect(profile.maximumActiveAgents).toBe(CODEX_AGENT_PROFILE.maximumActiveAgents)
  })

  it('keeps a switch across a restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'harlan-agent-selection-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'state.sqlite')
    const store = openJournalStore(path)

    store.selectAgent({ provider: 'opencode', model: null, reasoningEffort: 'max' }, '2026-08-18T01:00:00.000Z')
    store.close()

    const reopened = openJournalStore(path)
    stores.push(reopened)
    expect(reopened.getAgentSelection()).toEqual({ provider: 'opencode', model: null, reasoningEffort: 'max' })
  })

  it('reads a saved session for the selected Agent provider only', () => {
    const store = createStore()
    store.syncRepositories([repositoryMapping()], '2026-08-18T01:00:00.000Z')
    store.recordObservation({
      externalId: 'pr-1',
      observedAt: '2026-08-18T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })

    store.saveWorkerSession('harlan-zw/example', 24, 'conflict_resolution', 'session-codex', '2026-08-18T01:00:00.000Z')
    const beforeSwitch = store.getWorkerSession('harlan-zw/example', 24, 'conflict_resolution')
    store.selectAgent({ provider: 'opencode', model: null, reasoningEffort: null }, '2026-08-18T01:01:00.000Z')
    const afterSwitch = store.getWorkerSession('harlan-zw/example', 24, 'conflict_resolution')

    expect(beforeSwitch).toBe('session-codex')
    expect(afterSwitch).toBeNull()
  })
})
