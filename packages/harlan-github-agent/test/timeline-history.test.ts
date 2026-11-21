import type { JournalStore } from '../src/store.ts'
import { Buffer } from 'node:buffer'
import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { parseTimelineHistory } from '../dashboard/app/utils/timeline.ts'
import { createAgentApp, createWebhookApp, openJournalStore } from '../src/index.ts'
import { REVIEW_CANCEL_CONTROL } from '../src/review-cancel.ts'
import { routineResult, timelineOutcome } from '../src/timeline.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const origin = 'https://agent.example.test'
const password = 'test-password-with-at-least-32-bytes'
const headers = { host: 'agent.example.test', authorization: `Basic ${Buffer.from(`agent:${password}`).toString('base64')}` }
const secret = 'a'.repeat(40)
const minute = 60_000
const day = 24 * 60 * minute

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

function webhookApp(store: JournalStore, now: () => number) {
  return createWebhookApp({
    allowedOwners: ['harlan-zw'],
    logger: { info: () => {} },
    onHint: () => {},
    secret,
    appId: 77,
    now,
    recordDelivery: delivery => store.recordDelivery(delivery),
    reviewCancellation: { actorLogin: () => 'harlan-github-agent[bot]', apply: () => {} },
  })
}

async function deliver(app: ReturnType<typeof createWebhookApp>, event: string, payload: object, delivery: string): Promise<number> {
  const body = JSON.stringify(payload)
  const response = await app.fetch(new Request('http://127.0.0.1/webhook', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': delivery,
      'x-github-event': event,
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
    },
  }))
  return response.status
}

describe('the Timeline API window', () => {
  it('answers the last seven days and the next two by default', async () => {
    const now = '2026-10-13T12:34:56.000Z'
    const history = await readTimeline(createStore(now), now)

    expect(history.generatedAt).toBe(now)
    // The series starts on the hour and ends at now, so its tail is the last hour.
    expect(history.deliveries).toMatchObject({ start: '2026-10-06T12:00:00.000Z', bucketSeconds: 60 })
    expect(history.deliveries.counts).toHaveLength(7 * 24 * 60 + 35)
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

  it('counts in one minute buckets for any window, so adjacent windows join', async () => {
    const now = '2026-10-13T12:00:00.000Z'
    const store = createStore(now)
    await deliver(webhookApp(store, () => Date.parse('2026-10-01T08:30:20.000Z')), 'push', { ref: 'refs/heads/main', repository: { full_name: 'harlan-zw/example' } }, 'push-1')
    const month = await readTimeline(store, now, '?from=2026-09-13T12:00:00.000Z&to=2026-10-13T12:00:00.000Z')
    const day = await readTimeline(store, now, '?from=2026-10-01T00:00:00.000Z&to=2026-10-02T00:00:00.000Z')

    const minuteOf = (series: typeof month.deliveries) => Date.parse(series.start) + series.counts.findIndex(count => count > 0) * series.bucketSeconds * 1000
    expect([month.deliveries.bucketSeconds, day.deliveries.bucketSeconds]).toEqual([60, 60])
    expect(month.deliveries.counts).toHaveLength(30 * 24 * 60)
    expect([minuteOf(month.deliveries), minuteOf(day.deliveries)]).toEqual([Date.parse('2026-10-01T08:30:00.000Z'), Date.parse('2026-10-01T08:30:00.000Z')])
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

describe('deliveries on the Timeline', () => {
  it('counts each accepted delivery once in its minute, and keeps the ones that move an item', async () => {
    const now = '2026-10-13T12:00:30.000Z'
    const store = createStore(now)
    const app = webhookApp(store, () => Date.parse(now) - 2 * minute)
    const repository = { full_name: 'Harlan-ZW/Example' }

    expect(await deliver(app, 'pull_request', { action: 'synchronize', number: 24, pull_request: { number: 24 }, repository }, 'delivery-1')).toBe(204)
    expect(await deliver(app, 'pull_request', { action: 'synchronize', number: 24, pull_request: { number: 24 }, repository }, 'delivery-1')).toBe(204)
    expect(await deliver(app, 'check_run', { action: 'completed', check_run: { app: { id: 77 } }, repository }, 'delivery-2')).toBe(204)
    expect(await deliver(app, 'push', { ref: 'refs/heads/main', repository }, 'delivery-3')).toBe(204)
    expect(await deliver(app, 'issue_comment', { action: 'created', issue: { number: 5 }, comment: { body: 'Looks good.' }, repository }, 'delivery-4')).toBe(204)

    const history = await readTimeline(store, now)

    expect(history.deliveries.counts.at(-3)).toBe(4)
    expect(history.deliveries.counts.reduce((total, count) => total + count, 0)).toBe(4)
    // The item takes the repository as the Service maps it, so it joins its Task row.
    expect(history.itemEvents).toEqual([{ repository: 'harlan-zw/example', number: 24, at: '2026-10-13T11:58:30.000Z', event: 'pull_request · synchronize' }])
  })

  it('keeps a comment command on its item only when the Service ran it', async () => {
    const now = '2026-10-13T12:00:30.000Z'
    const store = createStore(now)
    const app = webhookApp(store, () => Date.parse(now) - minute)
    const before = `<!-- harlan-agent-kit:pr-triage -->\n<!-- reviewed-sha: ${'a'.repeat(40)} -->\n${REVIEW_CANCEL_CONTROL}`
    const click = (sender: string) => ({ action: 'edited', repository: { full_name: 'harlan-zw/example' }, issue: { number: 24, pull_request: {} }, sender: { login: sender }, comment: { id: 42, user: { login: 'harlan-github-agent[bot]' }, body: before.replace('[ ]', '[x]') }, changes: { body: { from: before } } })

    expect(await deliver(app, 'issue_comment', click('contributor'), 'click-by-contributor')).toBe(204)
    expect(await deliver(app, 'issue_comment', click('harlan-zw'), 'click-by-owner')).toBe(204)

    const history = await readTimeline(store, now)

    expect(history.deliveries.counts.at(-2)).toBe(2)
    expect(history.itemEvents).toEqual([{ repository: 'harlan-zw/example', number: 24, at: '2026-10-13T11:59:30.000Z', event: 'issue_comment · edited' }])
  })

  it('keeps delivery counts for 90 days and item deliveries for 30', async () => {
    const start = Date.parse('2026-07-01T00:00:00.000Z')
    const store = createStore(new Date(start).toISOString())
    let at = start
    const app = webhookApp(store, () => at)
    const repository = { full_name: 'harlan-zw/example' }
    const opened = (delivery: string) => deliver(app, 'issues', { action: 'opened', issue: { number: 9 }, repository }, delivery)

    await opened('day-0')
    at = start + 31 * day
    await opened('day-31')
    const day31 = new Date(at).toISOString()
    let history = await readTimeline(store, day31, `?from=${new Date(start - minute).toISOString()}&to=${new Date(start + day).toISOString()}`)
    expect(history.deliveries.counts.reduce((total, count) => total + count, 0)).toBe(1)
    expect(history.itemEvents).toEqual([])

    at = start + 91 * day
    await opened('day-91')
    history = await readTimeline(store, new Date(at).toISOString(), `?from=${new Date(start - minute).toISOString()}&to=${new Date(start + day).toISOString()}`)
    expect(history.deliveries.counts.reduce((total, count) => total + count, 0)).toBe(0)
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
