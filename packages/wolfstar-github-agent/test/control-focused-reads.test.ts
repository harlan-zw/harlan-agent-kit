import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { createAgentActivityLog } from '../src/agent-activity.ts'
import { createAgentApp, createControlClient, openJournalStore } from '../src/index.ts'
import { issueItem, pullRequestItem, repositoryMapping } from './fixtures.ts'

const origin = 'https://agent.example.test'
const password = 'test-password-with-at-least-32-bytes'
const at = '2026-10-13T00:00:00.000Z'
const headers = {
  host: 'agent.example.test',
  authorization: `Basic ${Buffer.from(`agent:${password}`).toString('base64')}`,
}

function fixture() {
  const store = openJournalStore(':memory:', true)
  store.syncRepositories([repositoryMapping()], at)
  store.setRepositoryWritesEnabled('wolfstar-project/example', true)
  store.recordPollObservation({ observedAt: at, subject: pullRequestItem() })
  const task = store.claimNextConflictTask('test-agent', at, 60_000)!
  const activityLog = createAgentActivityLog()
  const getDashboardSnapshot = vi.fn(() => {
    throw new Error('Focused reads must not build the Dashboard.')
  })
  const app = createAgentApp({
    allowedOrigin: origin,
    dashboardPassword: password,
    now: () => new Date(at),
    store: { ...store, getDashboardSnapshot },
    activityLog,
  })
  const requests: string[] = []
  const created = createControlClient({
    baseUrl: origin,
    authentication: { _tag: 'Basic', password },
    fetch: async (input, init) => {
      const requestHeaders = new Headers(init?.headers)
      requestHeaders.set('host', 'agent.example.test')
      requests.push(String(input))
      return app.fetch(new Request(input, { ...init, headers: requestHeaders }))
    },
  })
  if (created._tag === 'Err') throw new Error(created.error.message)
  return { store, task, activityLog, app, requests, client: created.value }
}

describe('focused Control reads', () => {
  it('reads only one Task activity and keeps dashboard authentication', async () => {
    const { store, task, activityLog, app, requests, client } = fixture()
    const activity = { _tag: 'Reasoning' as const, at, text: 'Reading the changed function.' }
    activityLog.record(task.id, activity)
    activityLog.record('another-task', { ...activity, text: 'Other Task activity.' })
    try {
      expect(await client.activity(task.id)).toEqual({ _tag: 'Ok', value: [activity] })
      expect(requests).toEqual([`${origin}/api/tasks/activity?task=${task.id}`])
      expect(
        (await app.request(`${origin}/api/tasks/activity?task=${task.id}`, { headers: { host: 'agent.example.test' } }))
          .status,
      ).toBe(401)
    } finally {
      store.close()
    }
  })

  it('explains Completed activity even after it leaves the Dashboard history', async () => {
    const { store, task, client } = fixture()
    store.completeTask({ taskId: task.id, workerId: 'test-agent', fence: task.state.fence, at, evidence: 'Finished.' })
    store.recordPollObservation({ observedAt: at, subject: pullRequestItem({ state: 'closed', mergedAt: at }) })
    for (let number = 100; number < 205; number++)
      store.recordPollObservation({ observedAt: '2026-10-13T00:01:00.000Z', subject: pullRequestItem({ number }) })
    try {
      expect(store.getDashboardSnapshot(at).tasks.some((candidate) => candidate.id === task.id)).toBe(false)
      expect(await client.activity(task.id)).toMatchObject({
        _tag: 'Err',
        error: {
          _tag: 'TaskActivityUnavailable',
          taskId: task.id,
          state: 'Completed',
          message: expect.stringContaining('Completed'),
        },
      })
      expect(await client.activity('missing-task')).toMatchObject({
        _tag: 'Err',
        error: { _tag: 'TaskNotFound', taskId: 'missing-task' },
      })
    } finally {
      store.close()
    }
  })

  it('lists Tasks and Incidents without building the Dashboard', async () => {
    const { store, task, client, requests } = fixture()
    try {
      expect(await client.tasks()).toMatchObject({
        _tag: 'Ok',
        value: { tasks: [expect.objectContaining({ id: task.id })], completionTasks: [] },
      })
      expect(await client.incidents()).toEqual({ _tag: 'Ok', value: [] })
      expect(requests).toEqual([`${origin}/api/tasks`, `${origin}/api/incidents`])
    } finally {
      store.close()
    }
  })

  it('reads a Review Task from the worker Task store', async () => {
    const { store, client, activityLog } = fixture()
    store.recordPollObservation({ observedAt: at, subject: pullRequestItem({ number: 25, mergeState: 'clean' }) })
    const task = store.claimNextAdversarialReviewTask('reviewer', at, 60_000)!
    const activity = { _tag: 'Reasoning' as const, at, text: 'Reviewing the diff.' }
    activityLog.record(task.id, activity)
    try {
      expect(await client.activity(task.id)).toEqual({ _tag: 'Ok', value: [activity] })
      store.completeWorkerTask({
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at,
        evidence: 'review-result',
      })
      expect(await client.activity(task.id)).toMatchObject({
        _tag: 'Err',
        error: { _tag: 'TaskActivityUnavailable', state: 'Completed' },
      })
    } finally {
      store.close()
    }
  })

  it('serves a tracked diff beyond the Dashboard Item limit', async () => {
    const { store } = fixture()
    for (let number = 100; number < 205; number++)
      store.recordPollObservation({ observedAt: '2026-10-13T00:01:00.000Z', subject: issueItem({ number }) })
    const pull = pullRequestItem()
    const result = { _tag: 'Err' as const, error: 'Changed' as const }
    const list = vi.fn(async () => result)
    const app = createAgentApp({
      allowedOrigin: origin,
      dashboardPassword: password,
      now: () => new Date(at),
      store,
      pullRequestDiff: { list, file: async () => result },
    })
    try {
      const response = await app.request(
        `${origin}/api/items/pull-request-diff?repository=${pull.repository}&number=${pull.number}&base=${pull.baseSha}&head=${pull.headSha}`,
        { headers },
      )
      expect(await response.json()).toEqual(result)
      expect(list).toHaveBeenCalledWith(
        { repository: pull.repository, number: pull.number, base: pull.baseSha, head: pull.headSha },
        expect.any(AbortSignal),
      )
    } finally {
      store.close()
    }
  })
})
