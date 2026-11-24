import type { ReviewGates } from '../src/types.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []
const directories: string[] = []

afterEach(() => {
  stores.splice(0).forEach(store => store.close())
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
})

function openStore(path: string) {
  const store = openJournalStore(path, true)
  stores.push(store)
  return store
}

/** The next process opens the same journal. */
function replaceProcess(store: ReturnType<typeof openJournalStore>, path: string) {
  stores.splice(stores.indexOf(store), 1)
  store.close()
  return openStore(path)
}

function storePath() {
  const directory = mkdtempSync(join(tmpdir(), 'harlan-restart-drain-'))
  directories.push(directory)
  return join(directory, 'state.sqlite')
}

function gates(ci: 'Passed' | 'Pending'): ReviewGates {
  return {
    merge: { _tag: 'Passed', evidence: [] },
    review: { _tag: 'Passed', evidence: [] },
    ci: ci === 'Passed'
      ? { _tag: 'Passed', evidence: [] }
      : { _tag: 'Pending', reason: 'Required checks are running.', evidence: [] },
  }
}

/** A Review whose terminal comment is on GitHub, so CI results refresh its gates. */
function publishedReview(store: ReturnType<typeof openJournalStore>) {
  const repository = repositoryMapping()
  const pullRequest = pullRequestItem({ mergeState: 'clean' })
  store.syncRepositories([repository], '2026-11-24T01:00:00.000Z')
  store.setRepositoryWritesEnabled(repository.github, true)
  store.recordObservation({ externalId: 'initial', observedAt: '2026-11-24T01:00:00.000Z', source: 'poll', subject: pullRequest })
  const task = store.claimNextAdversarialReviewTask('reviewer', '2026-11-24T01:01:00.000Z', 60_000)!
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
    startedAt: '2026-11-24T01:01:00.000Z',
    completedAt: '2026-11-24T01:01:05.000Z',
    gates: gates('Pending'),
    confidence: 96,
    findings: [],
  }
  expect(store.recordReviewRun(run)._tag).toBe('Inserted')
  const staged = store.stageReviewStatus({
    taskKind: 'adversarial_review',
    phase: 'terminal',
    taskId: task.id,
    workerId: task.state.workerId,
    fence: task.state.fence,
    at: '2026-11-24T01:01:10.000Z',
    revisionId: task.revisionId,
    expectedHeadSha: pullRequest.headSha,
    body: '### PENDING\nRequired checks are running.',
    reviewRunId: run.id,
    gates: run.gates,
    desiredOutcome: 'PENDING',
  })
  if (staged._tag === 'Rejected')
    throw new Error(staged.reason)
  expect(store.completeWorkerTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: '2026-11-24T01:01:20.000Z', evidence: run.id })).toBe(true)
  publishNext(store, '2026-11-24T01:01:30.000Z')
  const refresh = store.listReviewGateRefreshes().find(candidate => candidate.reviewRunId === run.id)
  if (refresh === undefined)
    throw new Error('Expected the published Review to take gate refreshes.')

  /** One gate refresh pass, as the sweep stages it after a CI result. */
  const refreshGates = ({ ci, body, at, ...reconciliation }: { ci: 'Passed' | 'Pending', body: string, at: string, reconciliationId?: string }) => {
    const refreshed = store.stageReviewGateStatus({
      reviewRunId: run.id,
      repository: repository.github,
      pullRequestNumber: pullRequest.number,
      revisionId: refresh.revisionId,
      expectedHeadSha: pullRequest.headSha,
      gates: gates(ci),
      body,
      desiredOutcome: ci === 'Passed' ? 'READY' : 'PENDING',
      ...reconciliation,
      at,
    })
    if (refreshed._tag === 'Rejected')
      throw new Error(refreshed.reason)
    return refreshed.commandId
  }
  return { refreshGates }
}

function publishNext(store: ReturnType<typeof openJournalStore>, at: string) {
  const command = store.claimNextTerminalReviewStatus('publisher', at, 60_000)
  if (command === null)
    throw new Error('Expected a terminal comment to publish.')
  expect(store.completeReviewStatus({
    commandId: command.id,
    workerId: command.workerId,
    fence: command.fence,
    at,
    commentId: 42,
    url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
  })).toBe(true)
  return command.id
}

function requestRestart(store: ReturnType<typeof openJournalStore>, at: string) {
  store.requestRestart({ id: 'restart', source: 'helper', operation: { _tag: 'Restart' }, at })
}

describe('restart drain', () => {
  it('restarts while gate refreshes keep queueing terminal comments', () => {
    const path = storePath()
    const store = openStore(path)
    const { refreshGates } = publishedReview(store)
    requestRestart(store, '2026-11-24T01:41:15.000Z')

    const queued = refreshGates({ ci: 'Pending', body: '### PENDING\nOne check is running.', at: '2026-11-24T01:58:00.000Z' })
    expect(store.prepareForRestart('2026-11-24T01:58:01.000Z')).toBe(true)

    expect(store.beginRestart({ id: 'restart', processId: 'old', at: '2026-11-24T01:58:02.000Z' })?._tag).toBe('Restarting')
    const next = replaceProcess(store, path)
    next.completeRestart('2026-11-24T01:58:10.000Z')
    next.recoverInterruptedAgentTasks('2026-11-24T01:58:10.000Z')
    expect(publishNext(next, '2026-11-24T01:58:11.000Z')).toBe(queued)
  })

  it('waits for a terminal comment queued before the Restart request', () => {
    const store = openStore(':memory:')
    const { refreshGates } = publishedReview(store)
    const queued = refreshGates({ ci: 'Passed', body: '### READY', at: '2026-11-24T01:41:00.000Z' })
    requestRestart(store, '2026-11-24T01:41:15.000Z')

    expect(store.prepareForRestart('2026-11-24T01:41:16.000Z')).toBe(false)
    expect(publishNext(store, '2026-11-24T01:41:17.000Z')).toBe(queued)
    expect(store.prepareForRestart('2026-11-24T01:41:18.000Z')).toBe(true)
  })

  it('restarts while a published gate comment is requeued after the Restart request', () => {
    const store = openStore(':memory:')
    const { refreshGates } = publishedReview(store)
    const published = refreshGates({ ci: 'Passed', body: '### READY', at: '2026-11-24T01:40:00.000Z' })
    expect(publishNext(store, '2026-11-24T01:40:01.000Z')).toBe(published)
    requestRestart(store, '2026-11-24T01:41:15.000Z')

    expect(refreshGates({ ci: 'Passed', body: '### READY', reconciliationId: 'Missing:42', at: '2026-11-24T01:58:00.000Z' })).toBe(published)
    expect(store.prepareForRestart('2026-11-24T01:58:01.000Z')).toBe(true)
  })
})
