import { afterEach, describe, expect, it } from 'vitest'
import { openJournalStore } from '../src/store.ts'
import { issueItem, pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []

afterEach(() => stores.splice(0).forEach(store => store.close()))

function createStore() {
  const store = openJournalStore(':memory:')
  stores.push(store)
  store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
  return store
}

describe('workflow telemetry', () => {
  it('keeps every Issue triage status transition with retry telemetry', () => {
    const store = createStore()
    const issue = issueItem()
    const observed = store.recordObservation({
      externalId: 'telemetry-issue-status',
      observedAt: '2026-08-13T00:00:00.000Z',
      source: 'poll',
      subject: issue,
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected an Issue.')
    const task = store.claimNextIssueTriageTask('triage-1', '2026-08-13T00:00:10.000Z', 120_000)
    if (task === null)
      throw new Error('Expected an Issue triage Task.')
    const staged = store.stageIssueTriageComment({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T00:00:20.000Z',
      revisionId: observed.revisionId,
      body: 'READY_TO_IMPLEMENT',
    })
    if (staged._tag === 'Rejected')
      throw new Error(staged.reason)
    const first = store.claimIssueTriageComment(staged.commandId, 'publisher-1', '2026-08-13T00:00:30.000Z', 60_000)
    if (first === null)
      throw new Error('Expected the first status claim.')
    store.deferIssueTriageComment({
      commandId: first.id,
      workerId: first.workerId,
      fence: first.fence,
      at: '2026-08-13T00:00:40.000Z',
      reason: 'GitHub timed out with token ghp_1234567890123456.',
    })
    const second = store.claimIssueTriageComment(staged.commandId, 'publisher-2', '2026-08-13T00:00:50.000Z', 60_000)
    if (second === null)
      throw new Error('Expected the retry status claim.')
    store.completeIssueTriageComment({
      commandId: second.id,
      workerId: second.workerId,
      fence: second.fence,
      at: '2026-08-13T00:01:00.000Z',
      commentId: 41,
      url: `${issue.url}#issuecomment-41`,
    })

    expect(store.listWorkflowEvents({ stream: 'issue_triage_status', limit: 10 })).toMatchObject([
      { event: 'Published', from: 'Running', to: 'Published', attempt: 2, durationMilliseconds: 10_000 },
      { event: 'Claimed', from: 'Pending', to: 'Running', attempt: 2, durationMilliseconds: 10_000 },
      {
        event: 'Deferred',
        from: 'Running',
        to: 'Pending',
        attempt: 1,
        durationMilliseconds: 10_000,
        reason: 'GitHub timed out with token ghp_***.',
      },
      { event: 'Claimed', from: 'Pending', to: 'Running', attempt: 1, durationMilliseconds: 10_000 },
      {
        event: 'Staged',
        entityId: staged.commandId,
        repository: issue.repository,
        itemNumber: issue.number,
        revisionId: observed.revisionId,
        taskId: task.id,
        from: null,
        to: 'Pending',
        attempt: 0,
        durationMilliseconds: null,
      },
    ])
  })

  it('records status recovery when the service restarts', () => {
    const store = createStore()
    const issue = issueItem()
    const observedIssue = store.recordObservation({
      externalId: 'telemetry-restart-issue',
      observedAt: '2026-08-13T00:00:00.000Z',
      source: 'poll',
      subject: issue,
    })
    if (observedIssue._tag !== 'Inserted')
      throw new Error('Expected an Issue.')
    const triage = store.claimNextIssueTriageTask('triage-1', '2026-08-13T00:00:10.000Z', 60_000)
    if (triage === null)
      throw new Error('Expected an Issue triage Task.')
    const stagedIssue = store.stageIssueTriageComment({
      taskId: triage.id,
      workerId: triage.state.workerId,
      fence: triage.state.fence,
      at: '2026-08-13T00:00:20.000Z',
      revisionId: observedIssue.revisionId,
      body: 'READY_TO_IMPLEMENT',
    })
    if (stagedIssue._tag === 'Rejected')
      throw new Error(stagedIssue.reason)
    if (store.claimIssueTriageComment(stagedIssue.commandId, 'publisher-1', '2026-08-13T00:00:30.000Z', 60_000) === null)
      throw new Error('Expected an Issue status claim.')
    store.recoverInterruptedAgentTasks('2026-08-13T00:00:40.000Z')

    expect(store.listWorkflowEvents({ stream: 'issue_triage_status', limit: 1 })[0]).toMatchObject({
      event: 'RestartSuperseded',
      from: 'Running',
      to: 'Superseded',
      reason: 'The service restarted.',
    })

    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const observedPullRequest = store.recordObservation({
      externalId: 'telemetry-restart-review',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequest,
    })
    if (observedPullRequest._tag !== 'Inserted')
      throw new Error('Expected a pull request.')
    const review = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T01:00:10.000Z', 60_000)
    if (review === null)
      throw new Error('Expected a Review Task.')
    const stagedReview = store.stageReviewStatus({
      taskKind: 'adversarial_review',
      phase: 'terminal',
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:00:20.000Z',
      revisionId: observedPullRequest.revisionId,
      expectedHeadSha: pullRequest.headSha,
      body: '<!-- harlan-agent-kit:pr-triage -->\n### 🤖 READY',
    })
    if (stagedReview._tag === 'Rejected')
      throw new Error(stagedReview.reason)
    store.completeWorkerTask({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:00:21.000Z',
      evidence: 'review-1',
    })
    if (store.claimNextTerminalReviewStatus('publisher-2', '2026-08-13T01:00:30.000Z', 60_000) === null)
      throw new Error('Expected a terminal Review status claim.')
    store.recoverInterruptedAgentTasks('2026-08-13T01:00:40.000Z')

    expect(store.listWorkflowEvents({ stream: 'review_status', limit: 1 })[0]).toMatchObject({
      event: 'RestartRecovered',
      from: 'Running',
      to: 'Pending',
      reason: 'The service restarted during terminal Publication.',
    })
  })

  it('keeps Issue triage Agent usage on its terminal transition', () => {
    const store = createStore()
    store.recordObservation({
      externalId: 'telemetry-issue-triage',
      observedAt: '2026-08-13T00:01:00.000Z',
      source: 'poll',
      subject: issueItem(),
    })
    const task = store.claimNextIssueTriageTask('triage-1', '2026-08-13T00:01:10.000Z', 60_000)
    if (task === null)
      throw new Error('Expected an Issue triage Task.')
    store.completeWorkerTask({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T00:01:20.000Z',
      evidence: JSON.stringify({ _tag: 'READY_TO_IMPLEMENT' }),
      usage: { _tag: 'Available', input: 80, cachedInput: 40, cacheWrite: 0, output: 12, reasoning: 4 },
    })

    expect(store.listWorkflowEvents({ stream: 'worker_task', limit: 1 })[0]).toMatchObject({
      event: 'Completed',
      entityId: task.id,
      usage: { _tag: 'Available', input: 80, cachedInput: 40, cacheWrite: 0, output: 12, reasoning: 4 },
    })
  })

  it('keeps every Review status transition with its scope, retry, and duration', () => {
    const store = createStore()
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    const observed = store.recordObservation({
      externalId: 'telemetry-review-status',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequest,
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a pull request.')
    const task = store.claimNextAdversarialReviewTask('reviewer-1', '2026-08-13T01:00:10.000Z', 60_000)
    if (task === null)
      throw new Error('Expected a Review Task.')
    const staged = store.stageReviewStatus({
      taskKind: 'adversarial_review',
      phase: 'terminal',
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: '2026-08-13T01:00:20.000Z',
      revisionId: observed.revisionId,
      expectedHeadSha: pullRequest.headSha,
      body: '<!-- harlan-agent-kit:pr-triage -->\n### 🤖 READY',
    })
    if (staged._tag === 'Rejected')
      throw new Error(staged.reason)
    const first = store.claimReviewStatus(staged.commandId, 'publisher-1', '2026-08-13T01:00:30.000Z', 60_000)
    if (first === null)
      throw new Error('Expected the first Publication claim.')
    store.deferReviewStatus({
      commandId: first.id,
      workerId: first.workerId,
      fence: first.fence,
      at: '2026-08-13T01:00:40.000Z',
      reason: 'GitHub timed out with token ghp_1234567890123456.',
    })
    const second = store.claimReviewStatus(staged.commandId, 'publisher-2', '2026-08-13T01:00:50.000Z', 60_000)
    if (second === null)
      throw new Error('Expected the retry Publication claim.')
    store.completeReviewStatus({
      commandId: second.id,
      workerId: second.workerId,
      fence: second.fence,
      at: '2026-08-13T01:01:00.000Z',
      commentId: 42,
      url: `${pullRequest.url}#issuecomment-42`,
    })

    expect(store.listWorkflowEvents({ stream: 'review_status', limit: 10 })).toMatchObject([
      { event: 'Published', from: 'Running', to: 'Published', attempt: 2, durationMilliseconds: 10_000 },
      { event: 'Claimed', from: 'Pending', to: 'Running', attempt: 2, durationMilliseconds: 10_000 },
      {
        event: 'Deferred',
        from: 'Running',
        to: 'Pending',
        attempt: 1,
        durationMilliseconds: 10_000,
        reason: 'GitHub timed out with token ghp_***.',
      },
      { event: 'Claimed', from: 'Pending', to: 'Running', attempt: 1, durationMilliseconds: 10_000 },
      {
        event: 'Staged',
        entityId: staged.commandId,
        repository: pullRequest.repository,
        itemNumber: pullRequest.number,
        revisionId: observed.revisionId,
        taskId: task.id,
        from: null,
        to: 'Pending',
        attempt: 0,
        durationMilliseconds: null,
      },
    ])
  })

  it('stores Routine Agent usage and every retry transition', () => {
    const store = createStore()
    const [routine] = store.syncRoutines({
      repository: 'harlan-zw/example',
      specSha: 'spec-1',
      entries: [{ name: 'pr-triage', crons: ['0 7 * * *'], timeZone: 'UTC', mode: 'report', enabled: true }],
      at: '2026-08-13T01:00:00.000Z',
    })
    if (routine === undefined)
      throw new Error('Expected a Routine.')
    const run = store.openRoutineRun({
      routineId: routine.id,
      scheduledFor: '2026-08-13T07:00:00.000Z',
      specSha: routine.specSha,
      at: '2026-08-13T07:00:00.000Z',
    })
    if (run === null)
      throw new Error('Expected a Routine run.')
    const first = store.claimNextRoutineRun('routine-1', '2026-08-13T07:00:10.000Z', 60_000)
    if (first === null)
      throw new Error('Expected a Routine claim.')
    store.failRoutineRun({
      taskId: first.id,
      workerId: first.state.workerId,
      fence: first.state.fence,
      at: '2026-08-13T07:00:20.000Z',
      reason: 'The Agent provider timed out.',
    })
    const second = store.claimNextRoutineRun('routine-2', '2026-08-13T07:00:30.000Z', 60_000)
    if (second === null)
      throw new Error('Expected a Routine retry.')
    store.completeRoutineRun({
      taskId: second.id,
      workerId: second.state.workerId,
      fence: second.state.fence,
      at: '2026-08-13T07:00:50.000Z',
      evidence: '0 Candidates',
      usage: { _tag: 'Available', input: 100, cachedInput: 50, cacheWrite: 0, output: 20, reasoning: 10 },
    })

    expect(store.getRoutineRun(run.id)).toMatchObject({
      usage: { _tag: 'Available', input: 100, cachedInput: 50, cacheWrite: 0, output: 20, reasoning: 10 },
    })
    expect(store.listWorkflowEvents({ stream: 'routine_run', limit: 10 })).toMatchObject([
      { event: 'Completed', from: 'Running', to: 'Completed', attempt: 2, durationMilliseconds: 20_000 },
      { event: 'Claimed', from: 'Queued', to: 'Running', attempt: 2, durationMilliseconds: 10_000 },
      { event: 'Retrying', from: 'Running', to: 'Queued', attempt: 1, durationMilliseconds: 10_000 },
      { event: 'Claimed', from: 'Queued', to: 'Running', attempt: 1, durationMilliseconds: 10_000 },
      { event: 'Opened', from: null, to: 'Queued', attempt: 0, durationMilliseconds: null },
    ])
    expect(store.listWorkflowEvents({ stream: 'routine_run', limit: 1 })[0]?.usage).toEqual({
      _tag: 'Available',
      input: 100,
      cachedInput: 50,
      cacheWrite: 0,
      output: 20,
      reasoning: 10,
    })
  })
})
