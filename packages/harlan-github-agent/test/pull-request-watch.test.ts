import { execFile } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { H3 } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentApp, createControlClient, createReconcileHint, createWebhookApp, openJournalStore, pullRequestWatchFinished, reconcileRepository, startAgentServer } from '../src/index.ts'
import { ok } from '../src/result.ts'
import { issueItem, pullRequestItem, repositoryMapping } from './fixtures.ts'

const target = { repository: 'harlan-zw/example', number: 24 }
const open = { _tag: 'Open' as const, pullRequest: pullRequestItem({ mergeState: 'clean' }), tasks: [] }
const merged = { _tag: 'Merged' as const, pullRequest: pullRequestItem({ state: 'closed', mergedAt: '2026-10-05T00:00:00.000Z' }), tasks: [] }
afterEach(() => vi.useRealTimers())

function streamClient(states: unknown[]) {
  const client = createControlClient({ baseUrl: 'https://agent.example.test', authentication: { _tag: 'Basic', password: 'secret' }, fetch: async () => new Response(states.map(state => `event: pull-request\ndata: ${JSON.stringify(state)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }) })
  if (client._tag === 'Err')
    throw new Error(client.error.message)
  return client.value
}

describe('pull request watch', () => {
  it('streams a merge to the caller without polling another endpoint', async () => {
    const requests: Request[] = []
    let cancelled = false
    const bytes = new TextEncoder().encode(`: connected\r\n\r\nevent: pull-request\r\ndata: ${JSON.stringify(open)}\r\n\r\nevent: pull-request\r\ndata: ${JSON.stringify(merged)}\r\n\r\n`)
    const client = createControlClient({ baseUrl: 'https://agent.example.test', authentication: { _tag: 'Basic', password: 'secret' }, fetch: async (input, init) => {
      requests.push(new Request(input, init))
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        // Arbitrary chunk boundaries include a split CRLF and split JSON.
        for (let offset = 0; offset < bytes.length; offset += 7)
          controller.enqueue(bytes.slice(offset, offset + 7))
      }, cancel() { cancelled = true } }), { headers: { 'content-type': 'text/event-stream' } })
    } })
    if (client._tag === 'Err')
      throw new Error(client.error.message)
    const updates: string[] = []
    expect(await client.value.watchPullRequest(target, { onUpdate: state => updates.push(state._tag) })).toEqual({ _tag: 'Ok', value: merged })
    expect(updates).toEqual(['Open', 'Merged'])
    expect(requests.map(request => request.url)).toEqual(['https://agent.example.test/api/items/pull-request-events?repository=harlan-zw%2Fexample&number=24'])
    expect(cancelled).toBe(true)
  })

  it('requires an exact closure read before returning a stored merge', () => {
    const store = openJournalStore(':memory:')
    try {
      const repository = repositoryMapping()
      store.syncRepositories([repository], '2026-10-05T00:00:00.000Z')
      const subject = merged.pullRequest
      const recorded = store.recordPollObservation({ observedAt: '2026-10-05T00:00:00.000Z', subject })
      if (recorded._tag !== 'Inserted')
        throw new Error('The first observation must be recorded.')
      expect(store.getPullRequestWatchState(target.repository, target.number)?._tag).toBe('PendingClosure')
      store.recordVerifiedPullRequestClosure({ repository: target.repository, pullRequestNumber: target.number, revisionId: recorded.revisionId, headSha: subject.headSha, baseSha: subject.baseSha, disposition: { _tag: 'Merged' }, at: '2026-10-05T00:00:00.000Z' })
      expect(store.getPullRequestWatchState(target.repository, target.number)).toMatchObject({ _tag: 'Merged', pullRequest: { number: 24, headSha: subject.headSha, mergedAt: subject.mergedAt } })
    }
    finally {
      store.close()
    }
  })

  it('returns a confirmed merge from the journal after reopening it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'pr-watch-'))
    const path = join(directory, 'state.sqlite')
    let store = openJournalStore(path)
    try {
      store.syncRepositories([repositoryMapping()], '2026-10-05T00:00:00.000Z')
      const recorded = store.recordPollObservation({ observedAt: '2026-10-05T00:00:00.000Z', subject: merged.pullRequest })
      if (recorded._tag !== 'Inserted')
        throw new Error('The first observation must be recorded.')
      store.recordVerifiedPullRequestClosure({ repository: target.repository, pullRequestNumber: target.number, revisionId: recorded.revisionId, headSha: merged.pullRequest.headSha, baseSha: merged.pullRequest.baseSha, disposition: { _tag: 'Merged' }, at: '2026-10-05T00:00:00.000Z' })
      store.close()
      store = openJournalStore(path)
      expect(store.getPullRequestWatchState(target.repository, target.number)).toMatchObject({ _tag: 'Merged', pullRequest: { headSha: 'abc123' } })
    }
    finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('returns action required for the current head and ignores an old head failure', () => {
    const store = openJournalStore(':memory:', true)
    try {
      store.syncRepositories([repositoryMapping()], '2026-10-05T00:00:00.000Z')
      store.setRepositoryWritesEnabled(target.repository, true)
      store.recordPollObservation({ observedAt: '2026-10-05T00:00:00.000Z', subject: pullRequestItem() })
      const task = store.claimNextConflictTask('worker', '2026-10-05T00:00:00.000Z', 60_000)!
      store.needsAttentionTask({ taskId: task.id, workerId: 'worker', fence: task.state.fence, at: '2026-10-05T00:00:01.000Z', reason: 'Resolve the conflicting API change.', evidence: 'Two incompatible signatures.' })
      expect(store.getPullRequestWatchState(target.repository, target.number)).toMatchObject({ _tag: 'ActionRequired', reason: 'Resolve the conflicting API change.' })
      store.recordPollObservation({ observedAt: '2026-10-05T00:01:00.000Z', subject: pullRequestItem({ headSha: 'newhead', updatedAt: '2026-10-05T00:01:00.000Z' }) })
      expect(store.getPullRequestWatchState(target.repository, target.number)).toMatchObject({ _tag: 'Open', pullRequest: { headSha: 'newhead' } })
    }
    finally {
      store.close()
    }
  })

  it('waits for published Review evidence and invalidates readiness when the target branch changes', () => {
    const store = openJournalStore(':memory:')
    try {
      store.syncRepositories([repositoryMapping()], '2026-10-05T00:00:00.000Z')
      const observed = store.recordPollObservation({ observedAt: '2026-10-05T00:00:00.000Z', subject: open.pullRequest })
      if (observed._tag !== 'Inserted')
        throw new Error('Expected an observed pull request.')
      const task = store.claimNextAdversarialReviewTask('reviewer', '2026-10-05T00:00:01.000Z', 60_000)!
      store.completeWorkerTask({ taskId: task.id, workerId: 'reviewer', fence: task.state.fence, at: '2026-10-05T00:00:02.000Z', evidence: 'Reviewed.' })
      const gates = { merge: { _tag: 'Passed' as const, evidence: [] }, review: { _tag: 'Passed' as const, evidence: [] }, ci: { _tag: 'Passed' as const, evidence: [] } }
      store.recordReviewRun({ id: 'ready-run', repository: target.repository, pullRequestNumber: 24, revisionId: observed.revisionId, headSha: 'abc123', provider: 'codex', sessionId: 'ready-session', model: 'gpt-5.6', agentVersion: '1.2.3', skillDigest: 'f'.repeat(64), startedAt: '2026-10-05T00:00:01.000Z', completedAt: '2026-10-05T00:00:02.000Z', gates, findings: [] })
      expect(store.getPullRequestWatchState(target.repository, target.number)?._tag).toBe('Open')
      const staged = store.stageReviewGateStatus({ reviewRunId: 'ready-run', repository: target.repository, pullRequestNumber: 24, revisionId: observed.revisionId, expectedHeadSha: 'abc123', gates, body: '### READY', desiredOutcome: 'READY', at: '2026-10-05T00:00:03.000Z' })
      if (staged._tag !== 'Staged')
        throw new Error('Expected a staged Review publication.')
      const command = store.claimReviewStatus(staged.commandId, 'publisher', '2026-10-05T00:00:04.000Z', 60_000)!
      store.completeReviewStatus({ commandId: command.id, workerId: 'publisher', fence: command.fence, at: '2026-10-05T00:00:05.000Z', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' })
      expect(store.getPullRequestWatchState(target.repository, target.number)?._tag).toBe('Ready')
      store.recordPollObservation({ observedAt: '2026-10-05T00:01:00.000Z', subject: { ...open.pullRequest, baseRef: 'release', baseSha: 'newbase', updatedAt: '2026-10-05T00:01:00.000Z' } })
      expect(store.getPullRequestWatchState(target.repository, target.number)?._tag).toBe('Open')
    }
    finally {
      store.close()
    }
  })

  it('finds a watched pull request beyond the dashboard item limit', () => {
    const store = openJournalStore(':memory:')
    try {
      store.syncRepositories([repositoryMapping()], '2026-10-05T00:00:00.000Z')
      store.recordPollObservation({ observedAt: '2026-10-05T00:00:00.000Z', subject: open.pullRequest })
      for (let number = 100; number < 201; number++)
        store.recordPollObservation({ observedAt: '2026-10-05T00:01:00.000Z', subject: issueItem({ number, author: 'harlan-zw' }) })
      expect(store.getDashboardSnapshot('2026-10-05T00:02:00.000Z').items.some(item => item.kind === 'pull_request' && item.number === 24)).toBe(false)
      expect(store.getPullRequestWatchState(target.repository, target.number)).toMatchObject({ _tag: 'Open', pullRequest: { number: 24 } })
    }
    finally {
      store.close()
    }
  })

  it.each(['attention', 'review', 'merged'] as const)('stops at a confirmed close without merge in %s mode', async (until) => {
    const closed = { _tag: 'Closed', pullRequest: { ...merged.pullRequest, mergedAt: null }, tasks: [] }
    expect(await streamClient([closed]).watchPullRequest(target, { until })).toEqual({ _tag: 'Ok', value: closed })
  })

  it('returns actionable work by default and can keep watching until merge', async () => {
    const attention = { ...open, _tag: 'ActionRequired', reason: 'Fix the failing check.' }
    expect(await streamClient([attention, merged]).watchPullRequest(target)).toEqual({ _tag: 'Ok', value: attention })
    expect(await streamClient([attention, merged]).watchPullRequest(target, { until: 'merged' })).toEqual({ _tag: 'Ok', value: merged })
    expect(await streamClient([{ ...open, _tag: 'Ready' }]).watchPullRequest(target, { until: 'review' })).toMatchObject({ _tag: 'Ok', value: { _tag: 'Ready' } })
    expect(pullRequestWatchFinished({ ...open, _tag: 'Ready' })).toBe(false)
  })

  it('rejects a stream for another pull request and inconsistent merge data', async () => {
    expect(await streamClient([{ ...merged, pullRequest: { ...merged.pullRequest, number: 25 } }]).watchPullRequest(target)).toMatchObject({ _tag: 'Err', error: { _tag: 'InvalidResponse' } })
    expect(await streamClient([{ ...open, _tag: 'Merged' }]).watchPullRequest(target)).toMatchObject({ _tag: 'Err', error: { _tag: 'InvalidResponse' } })
  })

  it('reports disconnects so the caller can resume the same stored pull request', async () => {
    expect(await streamClient([open]).watchPullRequest(target)).toMatchObject({ _tag: 'Err', error: { _tag: 'NetworkFailure' } })
  })

  it.each(['NotObserved', 'PendingClosure'] as const)('confirms %s once and requires dashboard authentication', async (_tag) => {
    const store = openJournalStore(':memory:')
    const shutdown = new AbortController()
    let observed = false
    let reads = 0
    const app = createAgentApp({ allowedOrigin: 'https://agent.example.test', dashboardPassword: 'secret', now: () => new Date(), store, shutdownSignal: shutdown.signal, pullRequestWatch: {
      state: () => observed ? merged : _tag === 'NotObserved' ? { _tag, ...target } : { ...merged, _tag },
      observe: async () => {
        reads++
        observed = true
        return ok(undefined)
      },
    } })
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      headers.set('host', 'agent.example.test')
      return app.fetch(new Request(input, { ...init, headers }))
    }
    try {
      const denied = await fetch('https://agent.example.test/api/items/pull-request-events?repository=harlan-zw%2Fexample&number=24')
      expect(denied.status).toBe(401)
      expect(reads).toBe(0)
      const client = createControlClient({ baseUrl: 'https://agent.example.test', authentication: { _tag: 'Basic', password: 'secret' }, fetch })
      if (client._tag === 'Err')
        throw new Error(client.error.message)
      expect(await client.value.watchPullRequest(target)).toMatchObject({ _tag: 'Ok', value: { _tag: 'Merged' } })
      expect(await client.value.watchPullRequest(target)).toMatchObject({ _tag: 'Ok', value: { _tag: 'Merged' } })
      expect(reads).toBe(1)
    }
    finally {
      shutdown.abort()
      store.close()
    }
  })

  it('wakes a waiting client from a signed merge webhook with one reconciliation', async () => {
    vi.useFakeTimers()
    const repository = repositoryMapping({ conflictResolution: false, pullRequestReview: false, issueWork: false })
    const store = openJournalStore(':memory:')
    store.syncRepositories([repository], '2026-10-05T00:00:00.000Z')
    store.recordPollObservation({ observedAt: '2026-10-05T00:00:00.000Z', subject: open.pullRequest })
    let githubReads = 0
    const hint = createReconcileHint({ delayMilliseconds: 1, onError: (error) => {
      throw error
    }, run: async () => {
      const result = await reconcileRepository(repository, { store, now: () => new Date('2026-10-05T00:01:00.000Z'), github: {
        listOpenItems: async () => {
          githubReads++
          return ok([])
        },
        getPullRequest: async () => {
          githubReads++
          return ok(merged.pullRequest)
        },
        getIssue: async () => { throw new Error('No issue should be read.') },
      } })
      if (result._tag === 'Err')
        throw new Error(result.error.message)
    } })
    const secret = 'a'.repeat(40)
    const webhook = createWebhookApp({ secret, allowedOwners: ['harlan-zw'], logger: { info() {} }, onHint: hint.hint })
    const shutdown = new AbortController()
    const app = createAgentApp({ allowedOrigin: 'https://agent.example.test', dashboardPassword: 'secret', now: () => new Date(), eventIntervalMilliseconds: 1, shutdownSignal: shutdown.signal, store, pullRequestWatch: { state: store.getPullRequestWatchState, observe: async () => {
      throw new Error('The stored pull request needs no bootstrap read.')
    } } })
    let connections = 0
    const client = createControlClient({ baseUrl: 'https://agent.example.test', authentication: { _tag: 'Basic', password: 'secret' }, fetch: async (input, init) => {
      connections++
      const headers = new Headers(init?.headers)
      headers.set('host', 'agent.example.test')
      return app.fetch(new Request(input, { ...init, headers }))
    } })
    if (client._tag === 'Err')
      throw new Error(client.error.message)
    const updates: string[] = []
    const watching = client.value.watchPullRequest(target, { onUpdate: state => updates.push(state._tag) })
    try {
      await vi.advanceTimersByTimeAsync(10)
      expect(updates).toEqual(['Open'])
      const body = JSON.stringify({ action: 'closed', repository: { full_name: target.repository }, pull_request: { merged: true } })
      const response = await webhook.fetch(new Request('http://127.0.0.1/webhook', { method: 'POST', body, headers: { 'x-github-event': 'pull_request', 'x-github-delivery': 'merge-delivery', 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } }))
      expect(response.status).toBe(204)
      await vi.advanceTimersByTimeAsync(10)
      expect(await watching).toMatchObject({ _tag: 'Ok', value: { _tag: 'Merged', pullRequest: { number: 24 } } })
      expect(updates).toEqual(['Open', 'Merged'])
      expect(connections).toBe(1)
      expect(githubReads).toBe(2)
      shutdown.abort()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(githubReads).toBe(2)
    }
    finally {
      shutdown.abort()
      await hint.stop()
      store.close()
    }
  })

  it('runs the real CLI against an authenticated HTTP stream', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'pr-watch-cli-'))
    const password = 'test-password-with-at-least-32-bytes'
    const passwordPath = join(directory, 'dashboard-password')
    writeFileSync(passwordPath, password, { mode: 0o600 })
    const store = openJournalStore(':memory:')
    store.syncRepositories([repositoryMapping()], '2026-10-05T00:00:00.000Z')
    const shutdown = new AbortController()
    let app: ReturnType<typeof createAgentApp> | undefined
    const gateway = new H3()
    gateway.get('/api/items/pull-request-events', (event) => {
      if (app === undefined)
        throw new Error('The test service is not ready.')
      return app.fetch(event.req)
    })
    const server = await startAgentServer({ app: gateway, hostname: '127.0.0.1', port: 0 })
    const url = server.url
    if (url === undefined)
      throw new Error('The test server has no URL.')
    app = createAgentApp({ allowedOrigin: url, dashboardPassword: password, now: () => new Date(), store, shutdownSignal: shutdown.signal, pullRequestWatch: { state: () => merged, observe: async () => ok(undefined) } })
    try {
      const result = await promisify(execFile)(process.execPath, ['--experimental-strip-types', join(import.meta.dirname, '..', 'src', 'cli.ts'), 'control', 'watch-pr', '--repository', target.repository, '--number', '24', '--url', url, '--password-file', passwordPath, '--timeout-seconds', '2'], { timeout: 15_000 })
      expect(JSON.parse(result.stdout)).toMatchObject({ _tag: 'Merged', pullRequest: { number: 24, headSha: 'abc123' } })
      expect(result.stderr).toContain('"status":"Merged"')
    }
    finally {
      shutdown.abort()
      await server.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
