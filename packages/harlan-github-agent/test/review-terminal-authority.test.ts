import type { ReviewGates } from '../src/types.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ok } from '../src/result.ts'
import { publishClaimedReviewStatus } from '../src/review-status-controller.ts'
import { createReviewStatusScheduler } from '../src/review-status-scheduler.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []
const directories: string[] = []
afterEach(() => {
  stores.splice(0).forEach(store => store.close())
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
})

function terminalStatus(lineage: 'current' | 'retained', outcome: 'READY' | 'PENDING' | 'BLOCKED' = 'READY', path = ':memory:') {
  const store = openJournalStore(path, true)
  stores.push(store)
  const repository = repositoryMapping()
  let pullRequest = pullRequestItem({ mergeState: 'clean' })
  store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
  store.setRepositoryWritesEnabled(repository.github, true)
  store.recordObservation({ externalId: 'initial', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject: pullRequest })
  const task = store.claimNextAdversarialReviewTask('reviewer', '2026-08-13T01:01:00.000Z', 60_000)!
  const gates: ReviewGates = {
    merge: { _tag: 'Passed', evidence: [] },
    review: outcome === 'BLOCKED'
      ? { _tag: 'Failed', reason: 'Invalid input crosses the boundary.', evidence: [] }
      : { _tag: 'Passed', evidence: [] },
    ci: outcome === 'PENDING'
      ? { _tag: 'Pending', reason: 'Required checks are running.', evidence: [] }
      : { _tag: 'Passed', evidence: [] },
  }
  const run = {
    id: 'review-1',
    repository: repository.github,
    pullRequestNumber: pullRequest.number,
    revisionId: task.revisionId,
    headSha: pullRequest.headSha,
    provider: 'codex' as const,
    sessionId: 'session',
    model: 'gpt-5.6',
    agentVersion: '1.2.3',
    skillDigest: 'a'.repeat(64),
    startedAt: '2026-08-13T01:01:00.000Z',
    completedAt: '2026-08-13T01:01:05.000Z',
    gates,
    confidence: 96,
    findings: outcome === 'BLOCKED'
      ? [{ _tag: 'Open' as const, summary: 'Invalid input crosses the boundary.', nextAction: 'Parse input before use.' }]
      : [],
  }
  expect(store.recordReviewRun(run)._tag).toBe('Inserted')
  const body = `### ${outcome}`
  let staged
  if (lineage === 'current') {
    staged = store.stageReviewStatus({
      taskKind: 'adversarial_review',
      phase: 'terminal',
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:01:10.000Z',
      revisionId: task.revisionId,
      expectedHeadSha: pullRequest.headSha,
      body,
      reviewRunId: run.id,
      gates,
      desiredOutcome: outcome,
    })
    if (outcome === 'BLOCKED') {
      expect(store.queueReviewFixTaskForReview({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at: '2026-08-13T01:01:15.000Z',
      })._tag).toBe('Queued')
    }
    expect(store.completeWorkerTask({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:01:20.000Z',
      evidence: run.id,
    })).toBe(true)
  }
  else {
    store.recordReviewPublication({
      id: 'prior-publication',
      reviewRunId: run.id,
      body,
      at: '2026-08-13T01:01:15.000Z',
      result: { _tag: 'Published', githubCommentId: 41, url: `${pullRequest.url}#issuecomment-41` },
    })
    expect(store.failWorkerTask({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:01:20.000Z',
      reason: 'GitHub request timed out.',
    })).toBe('Retrying')
    for (const [index, mergeState] of ['conflicting', 'clean'].entries()) {
      pullRequest = pullRequestItem({ baseSha: `base-${index}`, mergeState: mergeState as 'conflicting' | 'clean' })
      store.recordObservation({ externalId: `base-${index}`, observedAt: `2026-08-13T01:02:0${index}.000Z`, source: 'poll', subject: pullRequest })
    }
    const refresh = store.listReviewGateRefreshes().find(candidate => candidate.reviewRunId === run.id)!
    expect(refresh).toBeDefined()
    staged = store.stageReviewGateStatus({
      reviewRunId: run.id,
      repository: repository.github,
      pullRequestNumber: pullRequest.number,
      revisionId: refresh.revisionId,
      expectedHeadSha: pullRequest.headSha,
      gates,
      body,
      desiredOutcome: outcome,
      at: '2026-08-13T01:02:10.000Z',
    })
  }
  if (staged._tag === 'Rejected')
    throw new Error(staged.reason)
  return { store, repository, pullRequest, run, task, commandId: staged.commandId, gates }
}

type TerminalStatus = ReturnType<typeof terminalStatus>

function publicationHarness(test: Pick<TerminalStatus, 'store' | 'pullRequest' | 'commandId'>, boundary: 'snapshot' | 'label' | 'none', change = () => {}) {
  let clock = new Date('2026-08-13T01:03:00.000Z')
  const writes: string[] = []
  const commentIds: Array<number | null> = []
  const failures: string[] = []
  const published: number[] = []
  let reads = 0
  const options = {
    store: test.store,
    now: () => clock,
    github: {
      readExistingReviewLabel: () => { throw new Error('Unexpected existing Review.') },
      getPullRequestReviewSnapshot: () => {
        reads += 1
        if (boundary === 'snapshot')
          change()
        return Promise.resolve(ok({
          baseChecks: { _tag: 'Available' as const, checks: [] },
          body: '',
          checks: { _tag: 'Available' as const, checks: [] },
          comments: [],
          priorAutomatedReview: { _tag: 'None' as const },
          pullRequest: { ...test.pullRequest, baseSha: 'ordinary-base-movement' },
          requiredChecks: { _tag: 'None' as const },
          reviews: [],
        }))
      },
      upsertReviewStatus: (_repository: unknown, _number: number, commentId: number | null) => {
        writes.push('comment')
        commentIds.push(commentId)
        if (boundary === 'label')
          change()
        return Promise.resolve(ok({ commentId: 42, url: `${test.pullRequest.url}#issuecomment-42` }))
      },
      stampAgentLabel: (_repository: unknown, _number: number, label: string) => {
        writes.push(label)
        return Promise.resolve(ok(undefined))
      },
    },
  }
  const scheduler = createReviewStatusScheduler({
    ...options,
    intervalMilliseconds: 5_000,
    leaseMilliseconds: 1_000,
    onError: (error: unknown) => { throw error },
    onFailure: (_repository: string, _number: number, reason: string) => failures.push(reason),
    onPublished: (_repository: string, number: number) => published.push(number),
    workerId: 'scheduler',
  })
  return {
    options,
    scheduler,
    writes,
    commentIds,
    failures,
    published,
    reads: () => reads,
    advance: () => { clock = new Date(clock.getTime() + 2_000) },
    claim: () => test.store.claimReviewStatus(test.commandId, 'publisher', clock.toISOString(), 1_000),
    events: () => test.store.listWorkflowEvents({ stream: 'review_status', limit: 100 }).filter(event => event.entityId === test.commandId),
  }
}

function replaceProjection(test: TerminalStatus) {
  const staged = test.store.stageReviewGateStatus({
    reviewRunId: test.run.id,
    repository: test.repository.github,
    pullRequestNumber: test.pullRequest.number,
    revisionId: test.store.listReviewRuns(test.repository.github, test.pullRequest.number)[0]!.revisionId,
    expectedHeadSha: test.pullRequest.headSha,
    gates: { ...test.gates, ci: { _tag: 'Pending', reason: 'Required checks restarted.', evidence: [] } },
    body: '### PENDING',
    desiredOutcome: 'PENDING',
    at: '2026-08-13T01:03:00.000Z',
  })
  expect(staged._tag).toBe('Staged')
}

describe.each(['current', 'retained'] as const)('%s terminal Review authority', (lineage) => {
  it.each(['READY', 'PENDING', 'BLOCKED'] as const)('publishes %s once after the Agent finishes', async (outcome) => {
    const test = terminalStatus(lineage, outcome)
    const harness = publicationHarness(test, 'none')
    await harness.scheduler.runNow()
    harness.advance()
    await harness.scheduler.runNow()
    expect(harness.writes).toEqual(['comment', outcome])
    expect(harness.published).toEqual([test.pullRequest.number])
    expect(harness.failures).toEqual([])
  })

  it.each(['snapshot', 'label'] as const)('stops a superseded projection at the %s boundary', async (boundary) => {
    const test = terminalStatus(lineage)
    const harness = publicationHarness(test, boundary, () => replaceProjection(test))
    const command = harness.claim()!
    expect(command).not.toBeNull()
    const result = await publishClaimedReviewStatus(harness.options, command, true, new AbortController().signal)
    expect(result._tag).toBe('Err')
    expect(harness.writes).toEqual(boundary === 'label' ? ['comment'] : [])
    expect(harness.events()).toContainEqual(expect.objectContaining({ event: 'Superseded' }))
    if (boundary === 'label')
      expect(harness.events()).toContainEqual(expect.objectContaining({ event: 'CommentConfirmed' }))
    for (let index = 0; index < 3; index += 1) {
      harness.advance()
      expect(harness.claim()).toBeNull()
    }
  })

  describe.each(['head', 'target', 'closed', 'writes', 'review disabled', 'newer Review', 'task fence', 'Cancel'] as const)('%s authority', (loss) => {
    it.each(['before claim', 'snapshot', 'label'] as const)('prevents further writes after loss at %s', async (boundary) => {
      const directory = mkdtempSync(join(tmpdir(), 'terminal-authority-'))
      directories.push(directory)
      const path = join(directory, 'journal.sqlite')
      const test = terminalStatus(lineage, 'READY', path)
      const revoke = () => {
        const at = '2026-08-13T01:03:00.000Z'
        switch (loss) {
          case 'head':
          case 'target':
          case 'closed':
            test.store.recordObservation({
              externalId: loss,
              observedAt: at,
              source: 'poll',
              subject: { ...test.pullRequest, ...(loss === 'head' ? { headSha: 'new-head' } : loss === 'target' ? { baseRef: 'another-base' } : { state: 'closed' as const }) },
            })
            break
          case 'writes':
            test.store.setRepositoryWritesEnabled(test.repository.github, false)
            break
          case 'review disabled':
            test.store.syncRepositories([repositoryMapping({ pullRequestReview: false })], at)
            break
          case 'newer Review':
            expect(test.store.recordReviewRun({ ...test.run, id: 'review-2', completedAt: at })._tag).toBe('Inserted')
            break
          case 'task fence': {
            // Simulate a newer originating Task claim in the persisted Journal.
            const database = new DatabaseSync(path)
            database.prepare('UPDATE worker_tasks SET fence = fence + 1 WHERE id = ?').run(test.task.id)
            database.close()
            break
          }
          case 'Cancel': {
            // Completed Tasks reject Cancel. A persisted cancellation still revokes their evidence.
            const database = new DatabaseSync(path)
            database.prepare('INSERT INTO task_cancellations (task_id, cancelled_at, reason) VALUES (?, ?, ?)').run(test.task.id, at, 'Cancelled by Harlan.')
            database.close()
            break
          }
        }
      }
      const harness = publicationHarness(test, boundary === 'before claim' ? 'none' : boundary, revoke)
      if (boundary === 'before claim')
        revoke()
      await harness.scheduler.runNow()
      for (let index = 0; index < 3; index += 1) {
        harness.advance()
        await harness.scheduler.runNow()
        expect(harness.claim()).toBeNull()
      }
      expect(harness.writes).toEqual(boundary === 'label' ? ['comment'] : [])
      expect(harness.reads()).toBe(boundary === 'before claim' ? 0 : 1)
      expect(harness.published).toEqual([])
      expect(harness.events()).toContainEqual(expect.objectContaining({ to: 'Superseded' }))
      if (boundary === 'label')
        expect(harness.events()).toContainEqual(expect.objectContaining({ event: 'CommentConfirmed' }))
    })
  })

  it('leaves a newer Publication claim intact when an older publisher loses authority', async () => {
    const test = terminalStatus(lineage)
    const harness = publicationHarness(test, 'none')
    const old = harness.claim()!
    harness.advance()
    const current = harness.claim()!
    expect(current.fence).toBe(old.fence + 1)
    expect((await publishClaimedReviewStatus(harness.options, old, true, new AbortController().signal))._tag).toBe('Err')
    expect(harness.writes).toEqual([])
    expect((await publishClaimedReviewStatus(harness.options, current, true, new AbortController().signal))._tag).toBe('Ok')
    expect(harness.writes).toEqual(['comment', 'READY'])
  })

  describe.each(['Dismissal', 'policy'] as const)('%s', (loss) => {
    it.each(['before claim', 'expired lease', 'snapshot', 'label'] as const)('retires permanent loss at %s across expired leases', async (boundary) => {
      const test = terminalStatus(lineage)
      const revoke = () => {
        if (loss === 'Dismissal')
          test.store.dismissItem({ repository: test.repository.github, itemNumber: test.pullRequest.number, at: '2026-08-13T01:03:00.000Z' })
        else
          test.store.syncRepositories([repositoryMapping({ writablePullRequestHeadPrefixes: ['different/'] })], '2026-08-13T01:03:00.000Z')
      }
      const duringWrite = boundary === 'snapshot' || boundary === 'label'
      const harness = publicationHarness(test, duringWrite ? boundary : 'none', revoke)
      if (boundary === 'expired lease') {
        expect(harness.claim()).not.toBeNull()
        harness.advance()
      }
      if (!duringWrite)
        revoke()
      await harness.scheduler.runNow()
      expect(harness.events()).toContainEqual(expect.objectContaining({ to: 'Superseded' }))
      for (let index = 0; index < 3; index += 1) {
        harness.advance()
        await harness.scheduler.runNow()
        expect(harness.claim()).toBeNull()
      }
      expect(harness.writes).toEqual(boundary === 'label' ? ['comment'] : [])
      expect(harness.reads()).toBe(duringWrite ? 1 : 0)
      expect(harness.failures).toHaveLength(duringWrite ? 1 : 0)
      expect(harness.published).toEqual([])
      if (boundary === 'label')
        expect(harness.events()).toContainEqual(expect.objectContaining({ event: 'CommentConfirmed' }))
    })
  })

  it.each(['before claim', 'expired lease', 'snapshot', 'label'] as const)('keeps Pause pending at %s and publishes once after Resume', async (boundary) => {
    const test = terminalStatus(lineage)
    let paused = false
    const pause = () => {
      if (!paused) {
        test.store.setRepositoryPaused(test.repository.github, true)
        paused = true
      }
    }
    const duringWrite = boundary === 'snapshot' || boundary === 'label'
    const harness = publicationHarness(test, duringWrite ? boundary : 'none', pause)
    if (boundary === 'expired lease') {
      expect(harness.claim()).not.toBeNull()
      harness.advance()
    }
    if (!duringWrite)
      pause()
    await harness.scheduler.runNow()
    for (let index = 0; index < 3; index += 1) {
      harness.advance()
      await harness.scheduler.runNow()
      expect(harness.claim()).toBeNull()
    }
    expect(harness.events().filter(event => event.event === 'Claimed')).toHaveLength(boundary === 'before claim' ? 0 : 1)
    expect(harness.events().some(event => event.to === 'Superseded')).toBe(false)
    expect(harness.writes).toEqual(boundary === 'label' ? ['comment'] : [])
    test.store.setRepositoryPaused(test.repository.github, false)
    await harness.scheduler.runNow()
    harness.advance()
    await harness.scheduler.runNow()
    expect(harness.published).toEqual([test.pullRequest.number])
    expect(harness.writes).toEqual(boundary === 'label' ? ['comment', 'comment', 'READY'] : ['comment', 'READY'])
    expect(harness.commentIds).toEqual(boundary === 'label' ? [null, 42] : [null])
    expect(harness.failures).toHaveLength(duringWrite ? 1 : 0)
  })
})

it.each(['WAITING', 'SKIPPED', 'snapshot', 'review'] as const)('publishes %s without a Review run identifier', async (status) => {
  const store = openJournalStore(':memory:', true)
  stores.push(store)
  const repository = repositoryMapping()
  const pullRequest = pullRequestItem({ mergeState: 'clean' })
  store.syncRepositories([repository], '2026-08-13T00:00:00.000Z')
  store.setRepositoryWritesEnabled(repository.github, true)
  store.recordObservation({ externalId: 'initial', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject: pullRequest })
  const task = store.claimNextAdversarialReviewTask('reviewer', '2026-08-13T01:01:00.000Z', 60 * 60_000)!
  const terminal = status === 'WAITING' || status === 'SKIPPED'
  const staged = store.stageReviewStatus({
    taskKind: 'adversarial_review',
    phase: terminal ? 'terminal' : status,
    taskId: task.id,
    workerId: task.state.workerId,
    fence: task.state.fence,
    revisionId: task.revisionId,
    expectedHeadSha: pullRequest.headSha,
    body: `### ${status}`,
    at: '2026-08-13T01:01:10.000Z',
    ...(terminal ? { desiredOutcome: status } : {}),
  })
  if (staged._tag === 'Rejected')
    throw new Error(staged.reason)
  if (terminal) {
    expect(store.completeWorkerTask({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:01:20.000Z',
      evidence: status,
    })).toBe(true)
  }
  const harness = publicationHarness({ store, pullRequest, commandId: staged.commandId }, 'none')
  if (terminal) {
    await harness.scheduler.runNow()
  }
  else {
    const command = harness.claim()!
    expect((await publishClaimedReviewStatus(harness.options, command, true, new AbortController().signal))._tag).toBe('Ok')
  }
  expect(harness.writes).toEqual(status === 'WAITING' ? ['comment', 'PENDING'] : ['comment'])
  expect(harness.claim()).toBeNull()
})
