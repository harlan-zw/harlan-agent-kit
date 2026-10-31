import type { ReviewGates } from '../src/types.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createReviewWorker } from '../src/item-agent.ts'
import { err, ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).reverse().forEach(dispose => dispose()))

function savedReview(state: 'Queued' | 'Failed' | 'Superseded') {
  const directory = mkdtempSync(join(tmpdir(), 'review-publication-retry-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'journal.sqlite')
  const store = openJournalStore(path)
  cleanup.push(() => store.close())
  const pullRequest = pullRequestItem({ mergeState: 'clean' })
  store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
  store.recordObservation({ externalId: 'initial', observedAt: '2026-08-13T01:00:00.000Z', source: 'poll', subject: pullRequest })
  const task = store.claimNextAdversarialReviewTask('reviewer', '2026-08-13T01:01:00.000Z', 600_000)
  if (task === null)
    throw new Error('Expected the Review Task.')
  const progress = store.stageReviewStatus({
    taskKind: 'adversarial_review',
    phase: 'review',
    taskId: task.id,
    workerId: task.state.workerId,
    fence: task.state.fence,
    at: '2026-08-13T01:01:01.000Z',
    revisionId: task.revisionId,
    expectedHeadSha: pullRequest.headSha,
    body: '### 🤖 REVIEWING',
  })
  if (progress._tag === 'Rejected')
    throw new Error(progress.reason)
  const command = store.claimReviewStatus(progress.commandId, 'publisher', '2026-08-13T01:01:02.000Z', 60_000)
  if (command === null)
    throw new Error('Expected the progress command.')
  store.completeReviewStatus({ commandId: command.id, workerId: command.workerId, fence: command.fence, at: '2026-08-13T01:01:03.000Z', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' })
  const gates: ReviewGates = {
    merge: { _tag: 'Passed', evidence: [] },
    review: { _tag: 'Passed', evidence: [] },
    ci: { _tag: 'Pending', reason: 'Typecheck is still running.', evidence: [] },
  }
  store.recordReviewRun({
    id: 'saved-run',
    repository: task.repository,
    pullRequestNumber: task.pullRequestNumber,
    revisionId: task.revisionId,
    headSha: task.pullRequest.headSha,
    provider: 'codex',
    sessionId: 'saved-session',
    model: 'gpt-6.1-sol',
    agentVersion: '1.0.0',
    skillDigest: 'f'.repeat(64),
    startedAt: '2026-08-13T01:01:00.000Z',
    completedAt: '2026-08-13T01:02:00.000Z',
    gates,
    confidence: 90,
    findings: [],
  })
  const reason = 'The App installation on harlan-zw hit the primary GitHub rate limit. Requests pause until 2026-08-13T01:05:00.000Z.'
  store.failWorkerTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: '2026-08-13T01:02:01.000Z', reason })
  if (state !== 'Queued') {
    for (const second of ['02', '04']) {
      const retry = store.claimNextAdversarialReviewTask('reviewer', `2026-08-13T01:02:${second}.000Z`, 600_000)
      if (retry === null)
        throw new Error('Expected a publication retry.')
      store.failWorkerTask({ taskId: retry.id, workerId: retry.state.workerId, fence: retry.state.fence, at: `2026-08-13T01:02:${String(Number(second) + 1).padStart(2, '0')}.000Z`, reason })
    }
  }
  if (state === 'Superseded') {
    // The previous deployment persisted this automatic deduplication decision.
    const fixture = new DatabaseSync(path)
    fixture.prepare('UPDATE worker_tasks SET state_tag = \'Superseded\', reason = ? WHERE id = ?')
      .run('The current head commit already has an automated review.', task.id)
    fixture.close()
  }
  return { store, task, pullRequest, path }
}

describe('stored Review publication recovery', () => {
  it.each(['Queued', 'Failed', 'Superseded'] as const)('resumes the saved run after a %s publication retry', async (state) => {
    const { store, task, pullRequest } = savedReview(state)
    store.recordObservation({ externalId: 'quota-reset', observedAt: '2026-08-13T01:10:00.000Z', source: 'poll', subject: pullRequest })
    const retry = store.claimNextAdversarialReviewTask('publisher-retry', '2026-08-13T01:10:01.000Z', 600_000)
    expect(retry).toMatchObject({ id: task.id, revisionId: task.revisionId })
    expect(store.storedReviewForHead(task.repository, task.pullRequestNumber, pullRequest.headSha))
      .toMatchObject({ _tag: 'Current', run: { id: 'saved-run' } })
    expect(store.listStoppedReviews()).toEqual([])
    if (retry === null)
      throw new Error('Expected the retained Review retry.')
    const unexpected = () => {
      throw new Error('Publication recovery must not start an Agent or unrelated operation.')
    }
    let terminalId: string | undefined
    const worker = createReviewWorker({
      runtime: unexpected,
      github: {
        consumeApprovalLabel: unexpected,
        editReviewStatus: unexpected,
        upsertReviewCheckRun: unexpected,
        ensureApprovalLabel: unexpected,
        clearAgentLabels: unexpected,
        clearRunningLabel: unexpected,
        listRunningLabelledItems: unexpected,
        stampAgentLabel: async () => ok(undefined),
        findOpenPullRequestForBranch: unexpected,
        getFailedJobContext: unexpected,
        getIssueTriageSnapshot: unexpected,
        getPullRequestTemplate: unexpected,
        listPullRequestFiles: unexpected,
        upsertIssueTriageComment: unexpected,
        upsertReviewStatus: unexpected,
        getPullRequestReviewSnapshot: async () => ok({
          pullRequest,
          body: 'Fix the bug.',
          comments: [],
          reviews: [],
          findingDiscussions: [],
          priorAutomatedReview: { _tag: 'None' },
          requiredChecks: { _tag: 'None' },
          checks: { _tag: 'Available', checks: [] },
          baseChecks: { _tag: 'Available', checks: [] },
        }),
      },
      now: () => new Date('2026-08-13T01:10:02.000Z'),
      preflightRepair: async () => ok(undefined),
      store,
      status: {
        publish: unexpected,
        stageTerminal: (current, body, desiredOutcome, reviewRunId, gates) => {
          if (reviewRunId === undefined || gates === undefined)
            throw new Error('Stored Review projection must carry its run and gates.')
          const terminal = store.stageReviewStatus({
            taskKind: 'adversarial_review',
            phase: 'terminal',
            taskId: current.id,
            workerId: current.state.workerId,
            fence: current.state.fence,
            at: '2026-08-13T01:10:02.000Z',
            revisionId: current.revisionId,
            expectedHeadSha: current.pullRequest.headSha,
            reviewRunId,
            desiredOutcome,
            gates,
            body,
          })
          if (terminal._tag === 'Rejected')
            return err(terminal.reason)
          terminalId = terminal.commandId
          return ok({ commandId: terminal.commandId })
        },
      },
      triageStatus: { publish: unexpected },
      workspaces: { prepareIssue: unexpected, prepareReview: unexpected, verifyReview: unexpected },
    })
    const result = await worker.run(retry, new AbortController().signal)
    expect(result).toMatchObject({ _tag: 'Ok', value: { evidence: 'saved-run', resolution: { _tag: 'Reviewed', reviewRunId: 'saved-run' } } })
    if (result._tag === 'Err' || terminalId === undefined)
      throw new Error('Expected stored Review projection.')
    expect(store.completeReviewTask({ taskId: retry.id, workerId: retry.state.workerId, fence: retry.state.fence, at: '2026-08-13T01:10:03.000Z', ...result.value })).toBe(true)
    const command = store.claimReviewStatus(terminalId, 'publisher', '2026-08-13T01:10:04.000Z', 60_000)
    expect(command).toMatchObject({ expectedHeadSha: pullRequest.headSha, desiredOutcome: 'READY' })
    if (command === null)
      throw new Error('Expected terminal publication authority.')
    expect(store.completeReviewStatus({ commandId: command.id, workerId: command.workerId, fence: command.fence, at: '2026-08-13T01:10:05.000Z', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' })).toBe(true)
    expect(store.listReviewRuns(task.repository, task.pullRequestNumber).map(run => run.id)).toEqual(['saved-run'])
    expect(store.listStoppedReviews()).toEqual([])
  })

  it.each(['stop', 'Dismissal', 'cancellation'] as const)('honors an explicit %s before publication recovery', (authority) => {
    const { store, task, pullRequest, path } = savedReview(authority === 'cancellation' ? 'Failed' : 'Superseded')
    if (authority === 'stop') {
      const fixture = new DatabaseSync(path)
      fixture.prepare('INSERT INTO review_stops SELECT subject_id, ?, ? FROM worker_tasks WHERE id = ?')
        .run(pullRequest.headSha, '2026-08-13T01:09:00.000Z', task.id)
      fixture.close()
    }
    else if (authority === 'Dismissal') {
      store.dismissItem({ repository: task.repository, itemNumber: task.pullRequestNumber, at: '2026-08-13T01:09:00.000Z' })
    }
    else {
      store.cancelTask({ taskId: task.id, at: '2026-08-13T01:09:00.000Z' })
    }
    store.recordObservation({ externalId: 'explicit-stop', observedAt: '2026-08-13T01:10:00.000Z', source: 'poll', subject: pullRequest })
    expect(store.claimNextAdversarialReviewTask('publisher-retry', '2026-08-13T01:10:01.000Z', 600_000)).toBeNull()
  })
})
