import type { AgentSelection } from '../src/agent-profile.ts'
import { Buffer } from 'node:buffer'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentApp } from '../src/app.ts'
import { ok } from '../src/result.ts'
import { dashboardSnapshot } from './fixtures.ts'

const allowedHost = 'harlan-github-agent.local'
const dashboardPassword = 'test-password-with-at-least-32-bytes'
const authorization = `Basic ${Buffer.from(`agent:${dashboardPassword}`).toString('base64')}`
const now = () => new Date('2026-08-13T01:00:00.000Z')
const dashboardRoot = join(import.meta.dirname, 'fixtures', 'dashboard')
const agentControls = {
  pauseAgents: (at: string) => ({ _tag: 'Paused' as const, pausedAt: at }),
  resumeAgents: (_at: string) => ({ _tag: 'Running' as const }),
  selectAgent: (selection: AgentSelection, _at: string) => selection,
  setRepositoryPaused: (_github: string, _paused: boolean) => true,
}

afterEach(() => vi.useRealTimers())

function createApp(snapshot = dashboardSnapshot()) {
  return createAgentApp({
    allowedHost,
    dashboardPassword,
    dashboardRoot,
    now,
    store: { ...agentControls, approveIssueWork: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }), approvePullRequest: () => ({ _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }), cancelTask: () => ({ _tag: 'Rejected', reason: { _tag: 'TaskNotFound' } }), getDashboardSnapshot: () => snapshot, listReviewRuns: () => [], requestReviewRerun: () => ({ _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }) },
  })
}

describe('dashboard HTTP app', () => {
  it('switches the Agent provider, model, and reasoning effort', async () => {
    const switches: unknown[] = []
    const app = createAgentApp({
      allowedHost,
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
    const headers = { authorization, host: allowedHost, origin: `http://${allowedHost}` }

    const switched = await app.request(`http://${allowedHost}/api/agents/select`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ provider: 'opencode', model: 'opencode-go/deepseek-v4-pro', reasoningEffort: 'medium' }),
    })
    const rejected = await app.request(`http://${allowedHost}/api/agents/select`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ provider: 'opencode', model: 'gpt-5.6-sol' }),
    })

    expect(switched.status).toBe(200)
    await expect(switched.json()).resolves.toEqual({ provider: 'opencode', model: 'opencode-go/deepseek-v4-pro', reasoningEffort: 'medium' })
    expect(switches).toEqual([{
      selection: { provider: 'opencode', model: 'opencode-go/deepseek-v4-pro', reasoningEffort: 'medium' },
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
      body: JSON.stringify({ provider: 'codex' }),
    })

    expect(response.status).toBe(403)
  })

  it('pauses and resumes new agent work', async () => {
    const controls: unknown[] = []
    const app = createAgentApp({
      allowedHost,
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
    const headers = { authorization, host: allowedHost, origin: `http://${allowedHost}` }

    const paused = await app.request(`http://${allowedHost}/api/agents/pause`, { method: 'POST', headers })
    const resumed = await app.request(`http://${allowedHost}/api/agents/resume`, { method: 'POST', headers })

    expect(await paused.json()).toEqual({ _tag: 'Paused', pausedAt: now().toISOString() })
    expect(await resumed.json()).toEqual({ _tag: 'Running' })
    expect(controls).toEqual([{ _tag: 'Pause', at: now().toISOString() }, { _tag: 'Resume', at: now().toISOString() }])
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

  it('returns local review history for one pull request', async () => {
    const requests: Array<{ repository: string, pullRequestNumber: number }> = []
    const app = createAgentApp({
      allowedHost,
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

  it('records a local Review and repair approval for the exact Revision', async () => {
    const approvals: unknown[] = []
    const revisionId = 'a'.repeat(64)
    const app = createAgentApp({
      allowedHost,
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
      headers: { 'authorization': authorization, 'content-type': 'application/json', 'host': allowedHost, 'origin': `http://${allowedHost}` },
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
      allowedHost,
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
      headers: { 'authorization': authorization, 'content-type': 'application/json', 'host': allowedHost, 'origin': `http://${allowedHost}` },
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
      allowedHost,
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
      headers: { 'authorization': authorization, 'content-type': 'application/json', 'host': allowedHost, 'origin': `http://${allowedHost}` },
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
    const launches: unknown[] = []
    const snapshot = dashboardSnapshot({
      agents: [{
        _tag: 'ActiveAgent',
        id: taskId,
        provider: 'codex',
        role: 'adversarial_review',
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
      allowedHost,
      dashboardPassword,
      dashboardRoot,
      now,
      ejectAgent: (input) => {
        launches.push(input)
        return Promise.resolve(ok(undefined))
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

    const response = await app.request(`http://${allowedHost}/api/agents/eject`, {
      method: 'POST',
      headers: { 'authorization': authorization, 'content-type': 'application/json', 'host': allowedHost, 'origin': `http://${allowedHost}` },
      body: JSON.stringify({ taskId }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ _tag: 'Ejected' })
    expect(cancellations).toEqual([{ taskId, at: now().toISOString() }])
    expect(launches).toEqual([{ taskId, sessionId, provider: 'codex', repository: 'harlan-zw/example', itemNumber: 24 }])
  })

  it('queues one review rerun from the dashboard', async () => {
    const requests: unknown[] = []
    const revisionId = 'a'.repeat(64)
    const app = createAgentApp({
      allowedHost,
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
      headers: { 'authorization': authorization, 'content-type': 'application/json', 'host': allowedHost, 'origin': `http://${allowedHost}` },
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
      allowedHost,
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
