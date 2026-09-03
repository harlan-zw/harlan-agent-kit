import type { AgentSelection } from '../src/agent-profile.ts'
import type { StatsRange, StatsSnapshot } from '../src/stats.ts'
import type { RestartOperation, SelectionMode } from '../src/types.ts'
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentApp } from '../src/app.ts'
import { dashboardSnapshot } from './fixtures.ts'

const allowedOrigin = 'https://harlan-github-agent.localhost'
const allowedHost = new URL(allowedOrigin).host
const dashboardPassword = 'test-password-with-at-least-32-bytes'
const authorization = `Basic ${Buffer.from(`agent:${dashboardPassword}`).toString('base64')}`
function now() {
  return new Date('2026-08-13T01:00:00.000Z')
}
const dashboardRoot = join(import.meta.dirname, 'fixtures', 'dashboard')
function statsSnapshot(range: StatsRange, generatedAt: string): StatsSnapshot {
  return {
    generatedAt,
    range,
    previousRange: { from: '2026-06-14T00:00:00.000Z', to: range.from },
    coverage: { pullRequestTriage: { _tag: 'Complete' } },
    summary: {
      changedPullRequests: { value: 0, previous: 0 },
      conflictResolutions: { value: 0, previous: 0 },
      fixCommits: { value: 0, previous: 0 },
      openedPullRequests: { value: 0, previous: 0 },
      reviewFindings: { value: 0, previous: 0 },
    },
    days: [],
    work: [],
  }
}
const agentControls = {
  getStats: (range: StatsRange, generatedAt: string) => statsSnapshot(range, generatedAt),
  pauseAgents: (at: string) => ({ _tag: 'Paused' as const, pausedAt: at }),
  requestRestart: (input: { id: string, source: 'dashboard' | 'tray' | 'helper', operation: RestartOperation, at: string }) => ({
    _tag: 'Requested' as const,
    id: input.id,
    source: input.source,
    operation: input.operation,
    requestedAt: input.at,
  }),
  resumeAgents: (_at: string) => ({ _tag: 'Running' as const }),
  selectAgent: (selection: AgentSelection, _at: string) => selection,
  setRepositoryPaused: (_github: string, _paused: boolean) => true,
  setRepositoryWritesEnabled: (_github: string, _writesEnabled: boolean) => true,
  setSelectionMode: (mode: SelectionMode) => mode,
  dismissItem: () => ({ _tag: 'Dismissed' as const }),
  restoreItem: () => ({ _tag: 'Restored' as const }),
  recordAgentFeedback: () => ({ _tag: 'Rejected' as const, reason: { _tag: 'ReviewRunNotFound' as const } }),
  listWorkflowEvents: () => [],
}

afterEach(() => vi.useRealTimers())

function createApp(snapshot = dashboardSnapshot()) {
  return createAgentApp({
    allowedOrigin,
    dashboardPassword,
    dashboardRoot,
    now,
    store: { ...agentControls, approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }), approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }), cancelTask: () => ({ _tag: 'Rejected', reason: { _tag: 'TaskNotFound' } }), getDashboardSnapshot: () => snapshot, listReviewRuns: () => [], requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }) },
  })
}

describe('dashboard HTTP app', () => {
  it('records parsed Agent feedback', async () => {
    const recorded: unknown[] = []
    const app = createAgentApp({
      allowedOrigin,
      dashboardPassword,
      dashboardRoot,
      now,
      store: {
        ...agentControls,
        approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        cancelTask: () => ({ _tag: 'Rejected', reason: { _tag: 'TaskNotFound' } }),
        getDashboardSnapshot: () => dashboardSnapshot(),
        listReviewRuns: () => [],
        requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }),
        recordAgentFeedback(input) {
          recorded.push(input)
          return { _tag: 'Recorded', feedback: { ...input.feedback, updatedAt: input.at } }
        },
      },
    })

    const response = await app.request(`http://${allowedHost}/api/reviews/feedback`, {
      method: 'POST',
      headers: { 'authorization': authorization, 'content-type': 'application/json', 'host': allowedHost, 'origin': allowedOrigin },
      body: JSON.stringify({ reviewRunId: 'review-1', feedback: { _tag: 'Wrong', reason: 'It did not reproduce.' } }),
    })

    expect(response.status).toBe(200)
    expect(recorded).toEqual([{
      reviewRunId: 'review-1',
      feedback: { _tag: 'Wrong', reason: 'It did not reproduce.' },
      at: now().toISOString(),
    }])
  })

  it('attaches live activity to a running Routine', async () => {
    const runId = 'routine-run-1'
    const snapshot = dashboardSnapshot({
      routineRuns: [{
        id: runId,
        routineId: 'harlan-zw/example:sentry-checkin',
        repository: 'harlan-zw/example',
        name: 'sentry-checkin',
        scheduledFor: '2026-08-13T00:00:00.000Z',
        specSha: 'abc123',
        mode: 'report',
        state: { _tag: 'Running', workerId: 'worker-1', leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
        fence: 1,
        attempts: 1,
        progress: { percent: 55, label: 'Checking the repository' },
        usage: { _tag: 'Unavailable' },
        candidates: [],
        activity: [],
        reportState: null,
        createdAt: '2026-08-13T00:00:00.000Z',
        updatedAt: now().toISOString(),
      }],
    })
    const app = createAgentApp({
      allowedOrigin,
      dashboardPassword,
      dashboardRoot,
      now,
      activityLog: { read: id => id === runId ? [{ _tag: 'Reasoning', at: now().toISOString(), text: 'Reading Sentry issues.' }] : [] },
      store: { ...agentControls, approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }), approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }), cancelTask: () => ({ _tag: 'Rejected', reason: { _tag: 'TaskNotFound' } }), getDashboardSnapshot: () => snapshot, listReviewRuns: () => [], requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }) },
    })

    const response = await app.request(`http://${allowedHost}/api/state`, { headers: { authorization, host: allowedHost } })
    const body = await response.json() as { routineRuns: Array<{ activity: unknown[] }> }

    expect(body.routineRuns[0]?.activity).toEqual([
      { _tag: 'Reasoning', at: now().toISOString(), text: 'Reading Sentry issues.' },
    ])
  })

  it('streams live Agent activity when durable state does not change', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const shutdown = new AbortController()
    const taskId = 'a'.repeat(64)
    const activity: Array<{ _tag: 'Reasoning', at: string, text: string }> = []
    const snapshot = dashboardSnapshot({
      agents: [{
        _tag: 'ActiveAgent',
        id: taskId,
        provider: 'codex',
        role: 'adversarial_review',
        author: 'harlan-zw',
        session: { _tag: 'Starting' },
        repository: 'harlan-zw/example',
        repositoryUrl: 'https://github.com/harlan-zw/example',
        subjectKind: 'pull_request',
        itemNumber: 24,
        title: 'Fix parser',
        subjectUrl: 'https://github.com/harlan-zw/example/pull/24',
        startedAt: now().toISOString(),
        updatedAt: now().toISOString(),
        progress: { percent: 40, label: 'Reviewing' },
        activity: [],
        state: { _tag: 'Working', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      }],
    })
    const app = createAgentApp({
      allowedOrigin,
      dashboardPassword,
      dashboardRoot,
      eventIntervalMilliseconds: 1_000,
      now,
      shutdownSignal: shutdown.signal,
      activityLog: { read: id => id === taskId ? activity : [] },
      store: { ...agentControls, approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }), approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }), cancelTask: () => ({ _tag: 'Rejected', reason: { _tag: 'TaskNotFound' } }), getDashboardSnapshot: () => snapshot, listReviewRuns: () => [], requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }) },
    })

    const response = await app.request(`http://${allowedHost}/api/events`, { headers: { authorization, host: allowedHost } })
    const reader = response.body!.getReader()
    await reader.read()
    activity.push({ _tag: 'Reasoning', at: now().toISOString(), text: 'Reading the changed files.' })
    await vi.advanceTimersByTimeAsync(1_000)

    const update = await Promise.race([
      reader.read(),
      new Promise<undefined>(resolve => setTimeout(resolve, 50, undefined)),
    ])
    shutdown.abort()
    await reader.cancel()
    expect(new TextDecoder().decode(update?.value)).toContain('Reading the changed files.')
  })

  it('switches the Agent provider, model, and reasoning effort', async () => {
    const switches: unknown[] = []
    const app = createAgentApp({
      allowedOrigin,
      dashboardPassword,
      dashboardRoot,
      now,
      store: {
        ...agentControls,
        approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        cancelTask: () => ({ _tag: 'Rejected', reason: { _tag: 'TaskNotFound' } }),
        getDashboardSnapshot: () => dashboardSnapshot(),
        listReviewRuns: () => [],
        requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }),
        selectAgent(selection, at) {
          switches.push({ selection, at })
          return selection
        },
      },
    })
    const headers = { authorization, host: allowedHost, origin: allowedOrigin }

    const switched = await app.request(`http://${allowedHost}/api/agents/select`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ _tag: 'Pinned', provider: 'opencode', model: 'opencode-go/deepseek-v4-pro', reasoningEffort: 'medium' }),
    })
    const rejected = await app.request(`http://${allowedHost}/api/agents/select`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ _tag: 'Pinned', provider: 'opencode', model: 'gpt-5.6-sol' }),
    })

    expect(switched.status).toBe(200)
    await expect(switched.json()).resolves.toEqual({ _tag: 'Pinned', provider: 'opencode', model: 'opencode-go/deepseek-v4-pro', reasoningEffort: 'medium' })
    expect(switches).toEqual([{
      selection: { _tag: 'Pinned', provider: 'opencode', model: 'opencode-go/deepseek-v4-pro', reasoningEffort: 'medium' },
      at: now().toISOString(),
    }])
    expect(rejected.status).toBe(400)
    expect(switches).toHaveLength(1)
  })

  it('refuses an Agent switch from another origin', async () => {
    const app = createApp()

    const response = await app.request(`http://${allowedHost}/api/agents/select`, {
      method: 'POST',
      headers: { authorization, host: allowedHost, origin: 'http://evil.local' },
      body: JSON.stringify({ _tag: 'Pinned', provider: 'codex' }),
    })

    expect(response.status).toBe(403)
  })

  it('pauses and resumes new agent work', async () => {
    const controls: unknown[] = []
    const app = createAgentApp({
      allowedOrigin,
      dashboardPassword,
      dashboardRoot,
      now,
      store: {
        ...agentControls,
        approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        cancelTask: () => ({ _tag: 'Rejected', reason: { _tag: 'TaskNotFound' } }),
        getDashboardSnapshot: () => dashboardSnapshot(),
        listReviewRuns: () => [],
        pauseAgents(at) {
          controls.push({ _tag: 'Pause', at })
          return { _tag: 'Paused', pausedAt: at }
        },
        requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }),
        resumeAgents(at) {
          controls.push({ _tag: 'Resume', at })
          return { _tag: 'Running' }
        },
      },
    })
    const headers = { authorization, host: allowedHost, origin: allowedOrigin }

    const paused = await app.request(`http://${allowedHost}/api/agents/pause`, { method: 'POST', headers })
    const resumed = await app.request(`http://${allowedHost}/api/agents/resume`, { method: 'POST', headers })

    expect(await paused.json()).toEqual({ _tag: 'Paused', pausedAt: now().toISOString() })
    expect(await resumed.json()).toEqual({ _tag: 'Running' })
    expect(controls).toEqual([{ _tag: 'Pause', at: now().toISOString() }, { _tag: 'Resume', at: now().toISOString() }])
  })

  it('stores a dashboard Restart request', async () => {
    const requests: unknown[] = []
    const app = createAgentApp({
      allowedOrigin,
      dashboardPassword,
      dashboardRoot,
      now,
      store: {
        ...agentControls,
        approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        cancelTask: () => ({ _tag: 'Rejected', reason: { _tag: 'TaskNotFound' } }),
        getDashboardSnapshot: () => dashboardSnapshot(),
        listReviewRuns: () => [],
        requestRestart(input) {
          requests.push(input)
          return { _tag: 'Requested', id: input.id, source: input.source, operation: input.operation, requestedAt: input.at }
        },
        requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }),
      },
    })

    const response = await app.request(`http://${allowedHost}/api/service/restart`, {
      method: 'POST',
      headers: { 'authorization': authorization, 'host': allowedHost, 'origin': allowedOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'dashboard' }),
    })

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual(expect.objectContaining({ _tag: 'Requested', source: 'dashboard' }))
    expect(requests).toEqual([expect.objectContaining({ source: 'dashboard', at: now().toISOString() })])
  })

  it('pins the available commit in a dashboard Update request', async () => {
    const latestCommit = 'b'.repeat(40)
    const requests: unknown[] = []
    const app = createAgentApp({
      allowedOrigin,
      dashboardPassword,
      dashboardRoot,
      now,
      store: {
        ...agentControls,
        approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        cancelTask: () => ({ _tag: 'Rejected', reason: { _tag: 'TaskNotFound' } }),
        getDashboardSnapshot: () => dashboardSnapshot({
          serviceUpdate: {
            _tag: 'Available',
            deployedCommit: 'a'.repeat(40),
            latestCommit,
            checkedAt: now().toISOString(),
          },
        }),
        listReviewRuns: () => [],
        requestRestart(input) {
          requests.push(input)
          return { _tag: 'Requested', id: input.id, source: input.source, operation: input.operation, requestedAt: input.at }
        },
        requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }),
      },
    })

    const response = await app.request(`http://${allowedHost}/api/service/update`, {
      method: 'POST',
      headers: { 'authorization': authorization, 'host': allowedHost, 'origin': allowedOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'dashboard' }),
    })

    expect(response.status).toBe(202)
    expect(requests).toEqual([expect.objectContaining({
      source: 'dashboard',
      operation: { _tag: 'Update', targetCommit: latestCommit },
    })])
  })

  it('pins the available commit in a CLI Update request', async () => {
    const latestCommit = 'b'.repeat(40)
    const requests: unknown[] = []
    const app = createAgentApp({
      allowedOrigin,
      dashboardPassword,
      dashboardRoot,
      now,
      store: {
        ...agentControls,
        approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        cancelTask: () => ({ _tag: 'Rejected', reason: { _tag: 'TaskNotFound' } }),
        getDashboardSnapshot: () => dashboardSnapshot({
          serviceUpdate: {
            _tag: 'Available',
            deployedCommit: 'a'.repeat(40),
            latestCommit,
            checkedAt: now().toISOString(),
          },
        }),
        listReviewRuns: () => [],
        requestRestart(input) {
          requests.push(input)
          return { _tag: 'Requested', id: input.id, source: input.source, operation: input.operation, requestedAt: input.at }
        },
        requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }),
      },
    })

    const response = await app.request(`http://${allowedHost}/api/service/update`, {
      method: 'POST',
      headers: { 'authorization': authorization, 'host': allowedHost, 'origin': allowedOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'helper' }),
    })

    expect(response.status).toBe(202)
    expect(requests).toEqual([expect.objectContaining({
      source: 'helper',
      operation: { _tag: 'Update', targetCommit: latestCommit },
    })])
  })

  it('reports read-only health', async () => {
    const response = await createApp().request(`http://${allowedHost}/health`, { headers: { authorization, host: allowedHost } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ready',
      mutationsEnabled: false,
      repositories: 0,
      issues: 0,
      pullRequests: 0,
      tasks: 0,
    })
  })

  it('rejects an unexpected host', async () => {
    const response = await createApp().request('http://attacker.invalid/health')

    expect(response.status).toBe(421)
  })

  it('requires dashboard credentials', async () => {
    const response = await createApp().request(`http://${allowedHost}/health`, { headers: { host: allowedHost } })

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('Basic')
  })

  it('renders the nonced Nuxt shell without embedding subject content', async () => {
    const snapshot = dashboardSnapshot({
      items: [{
        kind: 'issue',
        approvalLabels: [],
        contentDigest: '0'.repeat(64),
        routineFiled: false,
        routineTracking: false,
        dismissed: false,
        repository: 'harlan-zw/example',
        number: 12,
        state: 'open',
        title: '<script>alert(1)</script>',
        author: 'contributor',
        url: 'https://github.com/harlan-zw/example/issues/12',
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
        revisionId: 'revision',
        observedAt: now().toISOString(),
      }],
    })
    const response = await createApp(snapshot).request(`http://${allowedHost}/`, { headers: { authorization, host: allowedHost } })
    const body = await response.text()

    expect(body).toContain('Agent activity')
    expect(body).not.toContain('<script>alert(1)</script>')
    const nonce = /<script nonce="([^"]+)"/.exec(body)?.[1]
    expect(nonce).toBeTruthy()
    expect(response.headers.get('content-security-policy')).toContain(`script-src 'self' 'nonce-${nonce}'`)
  })

  it('serves the workflow map directly', async () => {
    const response = await createApp().request(`http://${allowedHost}/flow`, { headers: { authorization, host: allowedHost } })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('How GitHub work moves through the agent')
  })

  it('serves the skew protection service worker', async () => {
    const response = await createApp().request(`http://${allowedHost}/_nuxt-skew-sw.js`, { headers: { authorization, host: allowedHost } })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.text()).toContain('loadedModules')
  })

  it('returns local review history for one pull request', async () => {
    const requests: Array<{ repository: string, pullRequestNumber: number }> = []
    const app = createAgentApp({
      allowedOrigin,
      dashboardPassword,
      dashboardRoot,
      now,
      store: {
        ...agentControls,
        approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        cancelTask: () => ({ _tag: 'Rejected', reason: { _tag: 'TaskNotFound' } }),
        getDashboardSnapshot: () => dashboardSnapshot(),
        listReviewRuns(repository, pullRequestNumber) {
          requests.push({ repository, pullRequestNumber })
          return []
        },
        requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }),
      },
    })

    const response = await app.request(
      `http://${allowedHost}/api/reviews?repository=harlan-zw%2Fexample&pull_request=24`,
      { headers: { authorization, host: allowedHost } },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ runs: [] })
    expect(requests).toEqual([{ repository: 'harlan-zw/example', pullRequestNumber: 24 }])
  })

  it('rejects an invalid review history query', async () => {
    const response = await createApp().request(
      `http://${allowedHost}/api/reviews?repository=harlan-zw%2Fexample&pull_request=zero`,
      { headers: { authorization, host: allowedHost } },
    )

    expect(response.status).toBe(400)
  })

  it('returns Stats for one date range', async () => {
    const requests: Array<{ range: StatsRange, generatedAt: string }> = []
    const app = createAgentApp({
      allowedOrigin,
      dashboardPassword,
      dashboardRoot,
      now,
      store: {
        ...agentControls,
        approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        cancelTask: () => ({ _tag: 'Rejected', reason: { _tag: 'TaskNotFound' } }),
        getDashboardSnapshot: () => dashboardSnapshot(),
        getStats(range, generatedAt) {
          requests.push({ range, generatedAt })
          return statsSnapshot(range, generatedAt)
        },
        listReviewRuns: () => [],
        requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }),
      },
    })

    const response = await app.request(
      `http://${allowedHost}/api/stats?from=2026-07-14T00%3A00%3A00.000Z&to=2026-08-13T00%3A00%3A00.000Z&time_zone=Australia%2FMelbourne`,
      { headers: { authorization, host: allowedHost } },
    )

    expect(response.status).toBe(200)
    expect(requests).toEqual([{
      generatedAt: now().toISOString(),
      range: {
        from: '2026-07-14T00:00:00.000Z',
        to: '2026-08-13T00:00:00.000Z',
        timeZone: 'Australia/Melbourne',
      },
    }])
  })

  it('rejects an invalid Stats date range', async () => {
    const response = await createApp().request(
      `http://${allowedHost}/api/stats?from=2026-08-13T00%3A00%3A00.000Z&to=2026-07-14T00%3A00%3A00.000Z&time_zone=UTC`,
      { headers: { authorization, host: allowedHost } },
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual(expect.objectContaining({ message: 'The end date must follow the start date.' }))
  })

  it('returns filtered workflow events for reliability analysis', async () => {
    const requests: unknown[] = []
    const app = createAgentApp({
      allowedOrigin,
      dashboardPassword,
      dashboardRoot,
      now,
      store: {
        ...agentControls,
        approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        cancelTask: () => ({ _tag: 'Rejected', reason: { _tag: 'TaskNotFound' } }),
        getDashboardSnapshot: () => dashboardSnapshot(),
        getStats: (range, generatedAt) => statsSnapshot(range, generatedAt),
        listReviewRuns: () => [],
        requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }),
        listWorkflowEvents(input) {
          requests.push(input)
          return []
        },
      },
    })

    const response = await app.request(
      `http://${allowedHost}/api/workflow-events?stream=review_status&limit=25`,
      { headers: { authorization, host: allowedHost } },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ events: [] })
    expect(requests).toEqual([{ stream: 'review_status', limit: 25 }])
  })

  it('records a local Review and repair approval for the exact Revision', async () => {
    const approvals: unknown[] = []
    const revisionId = 'a'.repeat(64)
    const app = createAgentApp({
      allowedOrigin,
      dashboardPassword,
      dashboardRoot,
      now,
      store: {
        ...agentControls,
        approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        approvePullRequest(input) {
          approvals.push(input)
          return { _tag: 'Approved', approval: { _tag: 'ReviewApproved', approvedAt: input.at } }
        },
        cancelTask: () => ({ _tag: 'Rejected', reason: { _tag: 'TaskNotFound' } }),
        getDashboardSnapshot: () => dashboardSnapshot(),
        listReviewRuns: () => [],
        requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }),
      },
    })
    const response = await app.request(`http://${allowedHost}/api/approvals`, {
      method: 'POST',
      headers: { 'authorization': authorization, 'content-type': 'application/json', 'host': allowedHost, 'origin': allowedOrigin },
      body: JSON.stringify({ repository: 'harlan-zw/example', pullRequestNumber: 24, revisionId, kind: 'review' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ _tag: 'Approved', approval: { _tag: 'ReviewApproved', approvedAt: now().toISOString() } })
    expect(approvals).toEqual([{
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId,
      kind: 'review',
      at: now().toISOString(),
    }])
  })

  it('approves issue work for the exact issue state', async () => {
    const approvals: unknown[] = []
    const revisionId = 'a'.repeat(64)
    const app = createAgentApp({
      allowedOrigin,
      dashboardPassword,
      dashboardRoot,
      now,
      store: {
        ...agentControls,
        approveIssueWork(input) {
          approvals.push(input)
          return { _tag: 'Approved', taskId: 'b'.repeat(64) }
        },
        approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        cancelTask: () => ({ _tag: 'Rejected', reason: { _tag: 'TaskNotFound' } }),
        getDashboardSnapshot: () => dashboardSnapshot(),
        listReviewRuns: () => [],
        requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }),
      },
    })
    const response = await app.request(`http://${allowedHost}/api/issues/approve`, {
      method: 'POST',
      headers: { 'authorization': authorization, 'content-type': 'application/json', 'host': allowedHost, 'origin': allowedOrigin },
      body: JSON.stringify({ repository: 'harlan-zw/example', issueNumber: 12, revisionId }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ _tag: 'Approved', taskId: 'b'.repeat(64) })
    expect(approvals).toEqual([{ repository: 'harlan-zw/example', issueNumber: 12, revisionId, at: now().toISOString() }])
  })

  it('rejects Approval requests from another origin', async () => {
    const response = await createApp().request(`http://${allowedHost}/api/approvals`, {
      method: 'POST',
      headers: { 'authorization': authorization, 'content-type': 'application/json', 'host': allowedHost, 'origin': 'https://attacker.invalid' },
      body: JSON.stringify({ repository: 'harlan-zw/example', pullRequestNumber: 24, revisionId: 'a'.repeat(64), kind: 'review' }),
    })

    expect(response.status).toBe(403)
  })

  it('cancels one task from the dashboard', async () => {
    const cancellations: unknown[] = []
    const taskId = 'a'.repeat(64)
    const app = createAgentApp({
      allowedOrigin,
      dashboardPassword,
      dashboardRoot,
      now,
      store: {
        ...agentControls,
        approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        cancelTask(input) {
          cancellations.push(input)
          return { _tag: 'Cancelled' }
        },
        getDashboardSnapshot: () => dashboardSnapshot(),
        listReviewRuns: () => [],
        requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }),
      },
    })

    const response = await app.request(`http://${allowedHost}/api/tasks/cancel`, {
      method: 'POST',
      headers: { 'authorization': authorization, 'content-type': 'application/json', 'host': allowedHost, 'origin': allowedOrigin },
      body: JSON.stringify({ taskId }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ _tag: 'Cancelled' })
    expect(cancellations).toEqual([{ taskId, at: now().toISOString() }])
  })

  it('ejects a running agent into its interactive Codex session', async () => {
    const taskId = 'a'.repeat(64)
    const sessionId = '018f3c70-7b79-7be9-9c26-1c94e3a33430'
    const cancellations: unknown[] = []
    const snapshot = dashboardSnapshot({
      agents: [{
        _tag: 'ActiveAgent',
        id: taskId,
        provider: 'codex',
        role: 'adversarial_review',
        author: 'harlan-zw',
        session: { _tag: 'Connected', id: sessionId },
        repository: 'harlan-zw/example',
        repositoryUrl: 'https://github.com/harlan-zw/example',
        subjectKind: 'pull_request',
        itemNumber: 24,
        title: 'Fix parser',
        subjectUrl: 'https://github.com/harlan-zw/example/pull/24',
        headSha: 'abc123',
        commitUrl: 'https://github.com/harlan-zw/example/commit/abc123',
        startedAt: now().toISOString(),
        updatedAt: now().toISOString(),
        progress: { percent: 40, label: 'Reviewing' },
        activity: [],
        state: { _tag: 'Working', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      }],
    })
    const app = createAgentApp({
      allowedOrigin,
      dashboardPassword,
      dashboardRoot,
      now,
      settleTask: async () => true,
      store: {
        ...agentControls,
        approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        cancelTask(input) {
          cancellations.push(input)
          return { _tag: 'Cancelled' }
        },
        getDashboardSnapshot: () => snapshot,
        listReviewRuns: () => [],
        requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }),
      },
    })

    const response = await app.request(`http://${allowedHost}/api/agents/eject`, {
      method: 'POST',
      headers: { 'authorization': authorization, 'content-type': 'application/json', 'host': allowedHost, 'origin': allowedOrigin },
      body: JSON.stringify({ taskId }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      _tag: 'Ejected',
      provider: 'codex',
      sessionId,
      repository: 'harlan-zw/example',
      itemNumber: 24,
    })
    expect(cancellations).toEqual([{ taskId, at: now().toISOString() }])
  })

  it('waits for the running Agent to settle before transferring its session', async () => {
    const taskId = 'a'.repeat(64)
    let finishSettlement!: () => void
    const settlement = new Promise<void>((resolve) => {
      finishSettlement = resolve
    })
    const cancellations: unknown[] = []
    const snapshot = dashboardSnapshot({
      agents: [{
        _tag: 'ActiveAgent',
        id: taskId,
        provider: 'opencode',
        role: 'adversarial_review',
        author: 'harlan-zw',
        session: { _tag: 'Connected', id: 'ses_abc12345' },
        repository: 'harlan-zw/example',
        repositoryUrl: 'https://github.com/harlan-zw/example',
        subjectKind: 'pull_request',
        itemNumber: 24,
        title: 'Fix parser',
        subjectUrl: 'https://github.com/harlan-zw/example/pull/24',
        headSha: 'abc123',
        commitUrl: 'https://github.com/harlan-zw/example/commit/abc123',
        startedAt: now().toISOString(),
        updatedAt: now().toISOString(),
        progress: { percent: 40, label: 'Reviewing' },
        activity: [],
        state: { _tag: 'Working', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      }],
    })
    const app = createAgentApp({
      allowedOrigin,
      dashboardPassword,
      dashboardRoot,
      now,
      settleTask: async () => {
        await settlement
        return true
      },
      store: {
        ...agentControls,
        approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        cancelTask(input) {
          cancellations.push(input)
          return { _tag: 'Cancelled' }
        },
        getDashboardSnapshot: () => snapshot,
        listReviewRuns: () => [],
        requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }),
      },
    })
    let response: Response | undefined

    const request = Promise.resolve(app.request(`http://${allowedHost}/api/agents/eject`, {
      method: 'POST',
      headers: { 'authorization': authorization, 'content-type': 'application/json', 'host': allowedHost, 'origin': allowedOrigin },
      body: JSON.stringify({ taskId }),
    })).then((value) => {
      response = value
      return value
    })
    await vi.waitFor(() => expect(cancellations).toHaveLength(1))

    expect(response).toBeUndefined()
    finishSettlement()
    expect((await request).status).toBe(200)
  })

  it('keeps the Eject request open when settlement takes more than ten seconds', async () => {
    vi.useFakeTimers()
    try {
      const taskId = 'a'.repeat(64)
      const snapshot = dashboardSnapshot({
        agents: [{
          _tag: 'ActiveAgent',
          id: taskId,
          provider: 'opencode',
          role: 'adversarial_review',
          author: 'harlan-zw',
          session: { _tag: 'Connected', id: 'ses_abc12345' },
          repository: 'harlan-zw/example',
          repositoryUrl: 'https://github.com/harlan-zw/example',
          subjectKind: 'pull_request',
          itemNumber: 24,
          title: 'Fix parser',
          subjectUrl: 'https://github.com/harlan-zw/example/pull/24',
          headSha: 'abc123',
          commitUrl: 'https://github.com/harlan-zw/example/commit/abc123',
          startedAt: now().toISOString(),
          updatedAt: now().toISOString(),
          progress: { percent: 40, label: 'Reviewing' },
          activity: [],
          state: { _tag: 'Working', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
        }],
      })
      const app = createAgentApp({
        allowedOrigin,
        dashboardPassword,
        dashboardRoot,
        now,
        settleTask: () => new Promise(resolve => setTimeout(resolve, 11_000, true)),
        store: {
          ...agentControls,
          approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
          approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
          cancelTask: () => ({ _tag: 'Cancelled' }),
          getDashboardSnapshot: () => snapshot,
          listReviewRuns: () => [],
          requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }),
        },
      })
      let response: Response | undefined

      const request = Promise.resolve(app.request(`http://${allowedHost}/api/agents/eject`, {
        method: 'POST',
        headers: { 'authorization': authorization, 'content-type': 'application/json', 'host': allowedHost, 'origin': allowedOrigin },
        body: JSON.stringify({ taskId }),
      })).then((value) => {
        response = value
        return value
      })
      await vi.advanceTimersByTimeAsync(10_001)

      expect(response).toBeUndefined()
      await vi.advanceTimersByTimeAsync(999)
      expect((await request).status).toBe(200)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('returns a safe recovery path when the running Agent does not settle', async () => {
    vi.useFakeTimers()
    try {
      const taskId = 'a'.repeat(64)
      const sessionId = 'ses_abc12345'
      const snapshot = dashboardSnapshot({
        agents: [{
          _tag: 'ActiveAgent',
          id: taskId,
          provider: 'opencode',
          role: 'adversarial_review',
          author: 'harlan-zw',
          session: { _tag: 'Connected', id: sessionId },
          repository: 'harlan-zw/example',
          repositoryUrl: 'https://github.com/harlan-zw/example',
          subjectKind: 'pull_request',
          itemNumber: 24,
          title: 'Fix parser',
          subjectUrl: 'https://github.com/harlan-zw/example/pull/24',
          headSha: 'abc123',
          commitUrl: 'https://github.com/harlan-zw/example/commit/abc123',
          startedAt: now().toISOString(),
          updatedAt: now().toISOString(),
          progress: { percent: 40, label: 'Reviewing' },
          activity: [],
          state: { _tag: 'Working', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
        }],
      })
      const app = createAgentApp({
        allowedOrigin,
        dashboardPassword,
        dashboardRoot,
        now,
        settleTask: () => new Promise(() => {}),
        store: {
          ...agentControls,
          approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
          approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
          cancelTask: () => ({ _tag: 'Cancelled' }),
          getDashboardSnapshot: () => snapshot,
          listReviewRuns: () => [],
          requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }),
        },
      })

      const request = Promise.resolve(app.request(`http://${allowedHost}/api/agents/eject`, {
        method: 'POST',
        headers: { 'authorization': authorization, 'content-type': 'application/json', 'host': allowedHost, 'origin': allowedOrigin },
        body: JSON.stringify({ taskId }),
      }))
      await vi.advanceTimersByTimeAsync(12_000)
      const response = await request

      expect(response.status).toBe(503)
      expect(await response.json()).toEqual(expect.objectContaining({
        data: {
          _tag: 'EjectDelayed',
          provider: 'opencode',
          sessionId,
          nextAction: 'Stop Harlan GitHub Agent. Then resume this saved session.',
        },
      }))
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('rejects an invalid provider session before cancelling its Task', async () => {
    const taskId = 'a'.repeat(64)
    const cancellations: unknown[] = []
    const snapshot = dashboardSnapshot({
      agents: [{
        _tag: 'ActiveAgent',
        id: taskId,
        provider: 'opencode',
        role: 'adversarial_review',
        author: 'harlan-zw',
        session: { _tag: 'Connected', id: 'ses_abc12345;touch_/tmp/pwned' },
        repository: 'harlan-zw/example',
        repositoryUrl: 'https://github.com/harlan-zw/example',
        subjectKind: 'pull_request',
        itemNumber: 24,
        title: 'Fix parser',
        subjectUrl: 'https://github.com/harlan-zw/example/pull/24',
        headSha: 'abc123',
        commitUrl: 'https://github.com/harlan-zw/example/commit/abc123',
        startedAt: now().toISOString(),
        updatedAt: now().toISOString(),
        progress: { percent: 40, label: 'Reviewing' },
        activity: [],
        state: { _tag: 'Working', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-13T02:00:00.000Z' },
      }],
    })
    const app = createAgentApp({
      allowedOrigin,
      dashboardPassword,
      dashboardRoot,
      now,
      settleTask: async () => true,
      store: {
        ...agentControls,
        approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        cancelTask(input) {
          cancellations.push(input)
          return { _tag: 'Cancelled' }
        },
        getDashboardSnapshot: () => snapshot,
        listReviewRuns: () => [],
        requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }),
      },
    })

    const response = await app.request(`http://${allowedHost}/api/agents/eject`, {
      method: 'POST',
      headers: { 'authorization': authorization, 'content-type': 'application/json', 'host': allowedHost, 'origin': allowedOrigin },
      body: JSON.stringify({ taskId }),
    })

    expect(response.status).toBe(409)
    expect(cancellations).toEqual([])
  })

  it('queues one review rerun from the dashboard', async () => {
    const requests: unknown[] = []
    const revisionId = 'a'.repeat(64)
    const app = createAgentApp({
      allowedOrigin,
      dashboardPassword,
      dashboardRoot,
      now,
      store: {
        ...agentControls,
        approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        cancelTask: () => ({ _tag: 'Rejected', reason: { _tag: 'TaskNotFound' } }),
        getDashboardSnapshot: () => dashboardSnapshot(),
        listReviewRuns: () => [],
        requestReviewRerun(input) {
          requests.push(input)
          return { _tag: 'Queued', taskId: 'b'.repeat(64) }
        },
      },
    })

    const response = await app.request(`http://${allowedHost}/api/reviews/rerun`, {
      method: 'POST',
      headers: { 'authorization': authorization, 'content-type': 'application/json', 'host': allowedHost, 'origin': allowedOrigin },
      body: JSON.stringify({ repository: 'harlan-zw/example', pullRequestNumber: 24, revisionId }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ _tag: 'Queued', taskId: 'b'.repeat(64) })
    expect(requests).toEqual([expect.objectContaining({
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      revisionId,
      source: 'dashboard',
      requestedBy: 'dashboard',
    })])
  })

  it('stops live updates before the store closes', async () => {
    vi.useFakeTimers()
    const shutdown = new AbortController()
    let reads = 0
    const app = createAgentApp({
      allowedOrigin,
      dashboardPassword,
      dashboardRoot,
      eventIntervalMilliseconds: 1_000,
      now,
      shutdownSignal: shutdown.signal,
      store: {
        ...agentControls,
        approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }),
        cancelTask: () => ({ _tag: 'Rejected', reason: { _tag: 'TaskNotFound' } }),
        getDashboardSnapshot() {
          reads += 1
          return dashboardSnapshot()
        },
        listReviewRuns: () => [],
        requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }),
      },
    })
    const response = await app.request(`http://${allowedHost}/api/events`, { headers: { authorization, host: allowedHost } })
    const readsBeforeShutdown = reads

    shutdown.abort()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(reads).toBe(readsBeforeShutdown)
    await response.body?.cancel()
  })
})
