import type { JournalStore } from '../src/store.ts'
import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it } from 'vitest'
import { parseTimelineHistory } from '../dashboard/app/utils/timeline.ts'
import { createAgentApp, openJournalStore } from '../src/index.ts'
import { routineResult, timelineOutcome } from '../src/timeline.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const origin = 'https://agent.example.test'
const password = 'test-password-with-at-least-32-bytes'
const headers = { host: 'agent.example.test', authorization: `Basic ${Buffer.from(`agent:${password}`).toString('base64')}` }
const minute = 60_000

const stores: JournalStore[] = []
afterEach(() => stores.splice(0).forEach(store => store.close()))

function createStore(at: string): JournalStore {
  const store = openJournalStore(':memory:', true)
  stores.push(store)
  store.syncRepositories([repositoryMapping()], at)
  store.setRepositoryWritesEnabled('harlan-zw/example', true)
  return store
}

function timelineApp(store: JournalStore, now: string) {
  return createAgentApp({ allowedOrigin: origin, dashboardPassword: password, now: () => new Date(now), store })
}

async function readTimeline(store: JournalStore, now: string, query = '') {
  const response = await timelineApp(store, now).request(`${origin}/api/timeline${query}`, { headers })
  expect(response.status).toBe(200)
  const history = parseTimelineHistory(await response.json())
  if (history === undefined)
    throw new Error('Expected the Timeline API to answer in the TimelineHistory shape.')
  return history
}

describe('the Timeline API window', () => {
  it('answers the last seven days and the next two by default, with no delivery records yet', async () => {
    const now = '2026-10-13T12:34:56.000Z'
    const history = await readTimeline(createStore(now), now)

    expect(history.generatedAt).toBe(now)
    // An empty series reads as no records, never as a quiet week.
    expect(history.deliveries).toEqual({ start: '2026-10-06T12:00:00.000Z', bucketSeconds: 60, counts: [] })
    expect(history.itemEvents).toEqual([])
    expect(history.pauses).toEqual([])
  })

  it('refuses a window longer than 30 days, a reversed window, and a time that is not ISO 8601', async () => {
    const now = '2026-10-13T12:00:00.000Z'
    const app = timelineApp(createStore(now), now)

    for (const query of ['?from=2026-09-01T00:00:00.000Z&to=2026-10-13T00:00:00.000Z', '?from=2026-10-13T00:00:00.000Z&to=2026-10-12T00:00:00.000Z', '?from=yesterday']) {
      const response = await app.request(`${origin}/api/timeline${query}`, { headers })
      expect(response.status).toBe(400)
    }
  })

  it('answers a window of exactly 30 days', async () => {
    const now = '2026-10-13T12:00:00.000Z'
    const history = await readTimeline(createStore(now), now, '?from=2026-09-13T12:00:00.000Z&to=2026-10-13T12:00:00.000Z')

    expect(history.deliveries.start).toBe('2026-09-13T12:00:00.000Z')
  })

  it('keeps dashboard authentication', async () => {
    const now = '2026-10-13T12:00:00.000Z'
    const response = await timelineApp(createStore(now), now).request(`${origin}/api/timeline`, { headers: { host: 'agent.example.test' } })

    expect(response.status).toBe(401)
  })
})

describe('tasks on the Timeline', () => {
  it('draws a finished Task from its last claim to its end, with the item it worked on', async () => {
    const store = createStore('2026-10-13T00:00:00.000Z')
    store.recordPollObservation({ observedAt: '2026-10-13T00:00:00.000Z', subject: pullRequestItem() })
    const task = store.claimNextConflictTask('agent-1', '2026-10-13T01:00:00.000Z', 60 * minute)
    if (task === null)
      throw new Error('Expected a conflict Task.')
    store.completeTask({ taskId: task.id, workerId: 'agent-1', fence: task.state.fence, at: '2026-10-13T01:20:00.000Z', evidence: 'Resolved.' })

    const history = await readTimeline(store, '2026-10-13T12:00:00.000Z')

    expect(history.tasks).toEqual([{
      id: task.id,
      repository: 'harlan-zw/example',
      number: 24,
      kind: 'pull_request',
      title: 'Fix the broken thing',
      work: 'conflict_resolution',
      startedAt: '2026-10-13T01:00:00.000Z',
      endedAt: '2026-10-13T01:20:00.000Z',
      outcome: 'Completed',
    }])
  })

  it('draws one Review per Review Task, capped with its gate outcome', async () => {
    const store = createStore('2026-10-13T00:00:00.000Z')
    const pullRequest = pullRequestItem({ number: 31, mergeState: 'clean', title: 'feat: add the Timeline API' })
    store.recordPollObservation({ observedAt: '2026-10-13T00:00:00.000Z', subject: pullRequest })
    const review = store.claimNextAdversarialReviewTask('reviewer-1', '2026-10-13T02:00:00.000Z', 60 * minute)
    if (review === null)
      throw new Error('Expected a Review Task.')
    store.recordReviewRun({
      id: 'timeline-review-run',
      repository: review.repository,
      pullRequestNumber: review.pullRequestNumber,
      revisionId: review.revisionId,
      headSha: review.pullRequest.headSha,
      provider: 'codex',
      sessionId: 'timeline-review-session',
      model: 'gpt-5.6',
      agentVersion: '1.2.3',
      skillDigest: 'f'.repeat(64),
      startedAt: '2026-10-13T02:00:00.000Z',
      completedAt: '2026-10-13T02:06:00.000Z',
      gates: {
        merge: { _tag: 'Passed', evidence: [] },
        review: { _tag: 'Passed', evidence: [] },
        ci: { _tag: 'Passed', evidence: [] },
      },
      confidence: 95,
      findings: [],
    })
    store.completeWorkerTask({ taskId: review.id, workerId: review.state.workerId, fence: review.state.fence, at: '2026-10-13T02:06:02.000Z', evidence: 'timeline-review-run' })

    const history = await readTimeline(store, '2026-10-13T12:00:00.000Z')

    expect(history.tasks).toEqual([expect.objectContaining({
      id: review.id,
      number: 31,
      title: 'feat: add the Timeline API',
      work: 'adversarial_review',
      startedAt: '2026-10-13T02:00:00.000Z',
      endedAt: '2026-10-13T02:06:02.000Z',
      outcome: 'READY',
    })])
  })

  it('leaves out a Task that ended before the window', async () => {
    const store = createStore('2026-10-01T00:00:00.000Z')
    store.recordPollObservation({ observedAt: '2026-10-01T00:00:00.000Z', subject: pullRequestItem() })
    const task = store.claimNextConflictTask('agent-1', '2026-10-01T01:00:00.000Z', 60 * minute)
    if (task === null)
      throw new Error('Expected a conflict Task.')
    store.completeTask({ taskId: task.id, workerId: 'agent-1', fence: task.state.fence, at: '2026-10-01T01:20:00.000Z', evidence: 'Resolved.' })

    const history = await readTimeline(store, '2026-10-13T12:00:00.000Z')

    expect(history.tasks).toEqual([])
  })
})

describe('routines on the Timeline', () => {
  it('shows finished runs in the window and the next instants of each enabled Routine', async () => {
    const store = createStore('2026-10-10T00:00:00.000Z')
    store.syncRoutines({ repository: 'harlan-zw/example', specSha: 'a', at: '2026-10-10T00:00:00.000Z', entries: [
      { name: 'daily-checkin', crons: ['0 7 * * *'], timeZone: 'UTC', mode: 'report', enabled: true },
      { name: 'ci-review', crons: ['0 8 * * *'], timeZone: 'UTC', mode: 'report', enabled: false },
    ] })
    store.openRoutineRun({ routineId: 'harlan-zw/example:daily-checkin', scheduledFor: '2026-10-12T07:00:00.000Z', specSha: 'a', at: '2026-10-12T07:00:00.000Z' })
    const run = store.claimNextRoutineRun('worker-1', '2026-10-12T07:00:05.000Z', 60 * minute)
    if (run === null)
      throw new Error('Expected a Routine run.')
    store.completeRoutineRun({ taskId: run.id, workerId: 'worker-1', fence: run.state.fence, at: '2026-10-12T07:09:00.000Z', evidence: 'daily-checkin on harlan-zw/example | 0 found | 0 new' })
    store.skipRoutineRun({ routineId: 'harlan-zw/example:daily-checkin', scheduledFor: '2026-10-11T07:00:00.000Z', specSha: 'a', reason: 'This run was due more than 6 hours ago, so it was skipped.', at: '2026-10-11T20:00:00.000Z' })

    const history = await readTimeline(store, '2026-10-13T12:00:00.000Z')

    expect(history.routineRuns).toEqual([
      { routineId: 'harlan-zw/example:daily-checkin', repository: 'harlan-zw/example', name: 'daily-checkin', scheduledFor: '2026-10-11T07:00:00.000Z', endedAt: null, result: 'Skipped' },
      { routineId: 'harlan-zw/example:daily-checkin', repository: 'harlan-zw/example', name: 'daily-checkin', scheduledFor: '2026-10-12T07:00:00.000Z', endedAt: '2026-10-12T07:09:00.000Z', result: 'Clear' },
    ])
    expect(history.upcoming).toEqual([
      { routineId: 'harlan-zw/example:daily-checkin', repository: 'harlan-zw/example', name: 'daily-checkin', at: '2026-10-14T07:00:00.000Z' },
      { routineId: 'harlan-zw/example:daily-checkin', repository: 'harlan-zw/example', name: 'daily-checkin', at: '2026-10-15T07:00:00.000Z' },
    ])
  })
})

describe('the cap a finished run shows', () => {
  it('reads a Routine run the way the Routines page labels it', () => {
    const completed = { end: 'Completed' as const, evidence: 'daily-checkin | 0 found', proposedCandidates: 0 }
    expect(routineResult({ ...completed, verdict: { severity: 'GREEN', coverage: 'complete' } })).toBe('Clear')
    expect(routineResult({ ...completed, verdict: null })).toBe('Clear')
    expect(routineResult({ ...completed, verdict: { severity: 'AMBER', coverage: 'incomplete' } })).toBe('Blocked')
    expect(routineResult({ ...completed, verdict: { severity: 'RED', coverage: 'complete' } })).toBe('Action required')
    expect(routineResult({ ...completed, verdict: null, proposedCandidates: 2 })).toBe('Action required')
    expect(routineResult({ ...completed, evidence: 'unchanged since run 2026-10-12', verdict: null })).toBe('Unchanged')
    expect(routineResult({ end: 'Failed', evidence: null, verdict: null, proposedCandidates: 0 })).toBe('Blocked')
    expect(routineResult({ end: 'Superseded', evidence: null, verdict: null, proposedCandidates: 0 })).toBe('Skipped')
  })

  it('never shows replaced work as a failure, and names an Issue triage that asked for information', () => {
    expect(timelineOutcome({ end: 'Superseded', review: null, triageRoute: null })).toBe('Superseded')
    expect(timelineOutcome({ end: 'ActionRequired', review: null, triageRoute: null })).toBe('Action required')
    expect(timelineOutcome({ end: 'Completed', review: 'Blocked', triageRoute: null })).toBe('BLOCKED')
    expect(timelineOutcome({ end: 'Completed', review: null, triageRoute: 'NEEDS_INFO' })).toBe('Needs info')
    expect(timelineOutcome({ end: 'Completed', review: null, triageRoute: 'AGENT_TRIAGE' })).toBe('Completed')
  })
})
