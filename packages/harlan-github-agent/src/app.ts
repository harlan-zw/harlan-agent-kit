import type { AgentActivityLog } from './agent-activity.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { TerminalSessionInput } from './terminal-session.ts'
import type { DashboardSnapshot } from './types.ts'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, relative } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createError, createEventStream, H3 } from 'h3'

export interface AgentAppOptions {
  store: Pick<JournalStore, 'approveIssueWork' | 'approvePullRequest' | 'cancelTask' | 'getDashboardSnapshot' | 'listReviewRuns' | 'pauseAgents' | 'requestReviewRerun' | 'resumeAgents' | 'setRepositoryPaused'>
  allowedHost: string
  dashboardPassword: string
  dashboardRoot?: string
  now: () => Date
  eventIntervalMilliseconds?: number
  shutdownSignal?: AbortSignal
  activityLog?: Pick<AgentActivityLog, 'read'>
  ejectAgent?: (input: TerminalSessionInput) => Promise<Result<void, string>>
}

const securityHeaders = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
}

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
}

function defaultDashboardRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(moduleDirectory, '..', 'dashboard', '.output', 'public'),
    join(moduleDirectory, '..', '..', 'dashboard', '.output', 'public'),
    join(process.cwd(), 'packages', 'harlan-github-agent', 'dashboard', '.output', 'public'),
  ]
  return candidates.find(existsSync) ?? candidates[0]!
}

/**
 * The journal owns durable state and the activity log owns ephemeral state.
 * They only meet here, on the way out to the dashboard.
 */
function dashboardSnapshot(options: AgentAppOptions): DashboardSnapshot {
  const snapshot = options.store.getDashboardSnapshot(options.now().toISOString())
  const activityLog = options.activityLog
  if (activityLog === undefined)
    return snapshot
  return {
    ...snapshot,
    agents: snapshot.agents.map(agent => agent._tag === 'ActiveAgent'
      ? { ...agent, activity: activityLog.read(agent.id) }
      : agent),
  }
}

async function setRepositoryPaused(options: AgentAppOptions, event: { req: { json: () => Promise<unknown> } }, paused: boolean): Promise<{ github: string, paused: boolean }> {
  const body = await event.req.json().catch(() => {
    // Malformed JSON receives the same 400 response as an invalid repository.
    return undefined
  })
  const github = typeof body === 'object' && body !== null && 'repository' in body ? (body as { repository: unknown }).repository : undefined
  if (typeof github !== 'string' || !/^[^/]+\/[^/]+$/.test(github))
    throw createError({ status: 400, statusText: 'Bad Request', message: 'A valid repository is required.' })
  if (!options.store.setRepositoryPaused(github, paused))
    throw createError({ status: 404, statusText: 'Not Found', message: 'That repository is not mapped.' })
  return { github, paused }
}

function dashboardPath(root: string, requestPath: string): string {
  const candidate = join(root, requestPath)
  const pathFromRoot = relative(root, candidate)
  if (pathFromRoot.startsWith('..'))
    throw createError({ status: 404, statusText: 'Not Found' })
  return candidate
}

function staticAsset(root: string, requestPath: string): Promise<Response> {
  const path = dashboardPath(root, requestPath)
  return readFile(path)
    .then(body => new Response(body, {
      headers: { 'content-type': contentTypes[extname(path)] ?? 'application/octet-stream' },
    }))
    .catch(() => {
      throw createError({ status: 404, statusText: 'Not Found' })
    })
}

async function dashboardHtml(root: string, requestPath: string, nonce: string): Promise<Response> {
  const html = await readFile(dashboardPath(root, requestPath), 'utf8')
  return new Response(
    html.replaceAll('<script', `<script nonce="${nonce}"`).replaceAll('<style', `<style nonce="${nonce}"`),
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  )
}

function hasDashboardAccess(request: Request, password: string): boolean {
  const authorization = request.headers.get('authorization')
  if (authorization === null || !authorization.startsWith('Basic '))
    return false

  const supplied = Buffer.from(authorization.slice(6), 'base64').toString('utf8')
  const separator = supplied.indexOf(':')
  const username = separator === -1 ? '' : supplied.slice(0, separator)
  const suppliedPassword = separator === -1 ? '' : supplied.slice(separator + 1)
  const expectedBuffer = Buffer.from(password)
  const suppliedBuffer = Buffer.from(suppliedPassword)
  return username === 'agent'
    && expectedBuffer.length === suppliedBuffer.length
    && timingSafeEqual(expectedBuffer, suppliedBuffer)
}

function observableState(options: AgentAppOptions): string {
  const snapshot = options.store.getDashboardSnapshot(options.now().toISOString())
  return JSON.stringify({ ...snapshot, generatedAt: '' })
}

interface ApprovalRequest {
  repository: string
  pullRequestNumber: number
  revisionId: string
  kind: 'review'
}

interface IssueApprovalRequest {
  repository: string
  issueNumber: number
  revisionId: string
}

interface CancelTaskRequest {
  taskId: string
}

interface ReviewRerunRequest {
  repository: string
  pullRequestNumber: number
  revisionId: string
}

function cancelTaskRequest(value: unknown): CancelTaskRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  const taskId = (value as Record<string, unknown>).taskId
  return typeof taskId === 'string' && /^[a-f\d]{64}$/.test(taskId) ? { taskId } : undefined
}

function reviewRerunRequest(value: unknown): ReviewRerunRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  const body = value as Record<string, unknown>
  if (typeof body.repository !== 'string' || !/^[^/]+\/[^/]+$/.test(body.repository))
    return undefined
  if (!Number.isSafeInteger(body.pullRequestNumber) || (body.pullRequestNumber as number) < 1)
    return undefined
  if (typeof body.revisionId !== 'string' || !/^[a-f\d]{64}$/.test(body.revisionId))
    return undefined
  return body as unknown as ReviewRerunRequest
}

function approvalRequest(value: unknown): ApprovalRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  const body = value as Record<string, unknown>
  if (typeof body.repository !== 'string' || !/^[^/]+\/[^/]+$/.test(body.repository))
    return undefined
  if (!Number.isSafeInteger(body.pullRequestNumber) || (body.pullRequestNumber as number) < 1)
    return undefined
  if (typeof body.revisionId !== 'string' || !/^[a-f\d]{64}$/.test(body.revisionId))
    return undefined
  if (body.kind !== 'review')
    return undefined
  return body as unknown as ApprovalRequest
}

function issueApprovalRequest(value: unknown): IssueApprovalRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined
  const body = value as Record<string, unknown>
  if (typeof body.repository !== 'string' || !/^[^/]+\/[^/]+$/.test(body.repository))
    return undefined
  if (!Number.isSafeInteger(body.issueNumber) || (body.issueNumber as number) < 1)
    return undefined
  if (typeof body.revisionId !== 'string' || !/^[a-f\d]{64}$/.test(body.revisionId))
    return undefined
  return body as unknown as IssueApprovalRequest
}

function approvalRejectionMessage(reason: ReturnType<JournalStore['approvePullRequest']> & { _tag: 'Rejected' }): string {
  switch (reason.reason._tag) {
    case 'ItemNotFound': return 'The pull request is no longer open.'
    case 'RevisionMismatch': return 'The pull request changed. Refresh before approving it.'
    case 'ApprovalNotRequired': return 'This pull request does not require local approval.'
  }
}

export function createAgentApp(options: AgentAppOptions): H3 {
  const dashboardRoot = options.dashboardRoot ?? defaultDashboardRoot()
  const app = new H3({
    onRequest(event) {
      if (event.req.headers.get('host') !== options.allowedHost)
        throw createError({ status: 421, statusText: 'Misdirected Request', message: 'Host is not allowed.' })
      if (!hasDashboardAccess(event.req, options.dashboardPassword)) {
        throw createError({
          status: 401,
          statusText: 'Unauthorized',
          message: 'Dashboard credentials are required.',
          headers: { 'www-authenticate': 'Basic realm="harlan-github-agent", charset="UTF-8"' },
        })
      }
      if (event.req.method !== 'GET' && event.req.method !== 'HEAD' && event.req.headers.get('origin') !== `http://${options.allowedHost}`)
        throw createError({ status: 403, statusText: 'Forbidden', message: 'Request origin is not allowed.' })
      event.context.dashboardNonce = randomBytes(18).toString('base64')
    },
    onResponse(response, event) {
      Object.entries(securityHeaders).forEach(([name, value]) => response.headers.set(name, value))
      const nonce = String(event.context.dashboardNonce)
      response.headers.set('content-security-policy', `default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'`)
    },
  })

  app.get('/health', () => {
    const snapshot = options.store.getDashboardSnapshot(options.now().toISOString())
    return Response.json({
      status: snapshot.status,
      mutationsEnabled: snapshot.mutationsEnabled,
      repositories: snapshot.repositories.length,
      issues: snapshot.items.filter(item => item.kind === 'issue').length,
      pullRequests: snapshot.items.filter(item => item.kind === 'pull_request').length,
      tasks: snapshot.tasks.length,
    }, { status: snapshot.status === 'ready' ? 200 : 503 })
  })

  app.get('/api/state', () => dashboardSnapshot(options))

  app.post('/api/agents/pause', () => options.store.pauseAgents(options.now().toISOString()))

  app.post('/api/agents/resume', () => options.store.resumeAgents(options.now().toISOString()))

  app.post('/api/agents/eject', async (event) => {
    const body = cancelTaskRequest(await event.req.json().catch(() => {
      // Request validation below reports malformed JSON as a bad request.
      return undefined
    }))
    if (body === undefined)
      throw createError({ status: 400, statusText: 'Bad Request', message: 'A valid task ID is required.' })
    if (options.ejectAgent === undefined)
      throw createError({ status: 501, statusText: 'Not Implemented', message: 'Interactive session launch is unavailable.' })
    const agent = dashboardSnapshot(options).agents.find(candidate => candidate._tag === 'ActiveAgent' && candidate.id === body.taskId)
    if (agent?._tag !== 'ActiveAgent')
      throw createError({ status: 404, statusText: 'Not Found', message: 'The running agent was not found.' })
    if (agent.session._tag !== 'Connected')
      throw createError({ status: 409, statusText: 'Conflict', message: 'The agent session is still starting.' })
    const cancelled = options.store.cancelTask({ taskId: body.taskId, at: options.now().toISOString() })
    if (cancelled._tag === 'Rejected')
      throw createError({ status: 409, statusText: 'Conflict', message: 'The agent already finished. Refresh before ejecting.' })
    const launched = await options.ejectAgent({
      taskId: body.taskId,
      sessionId: agent.session.id,
      provider: agent.provider,
      repository: agent.repository,
      itemNumber: agent.itemNumber,
    })
    if (launched._tag === 'Err')
      throw createError({ status: 500, statusText: 'Internal Server Error', message: launched.error })
    return { _tag: 'Ejected' }
  })

  app.post('/api/repositories/pause', event => setRepositoryPaused(options, event, true))

  app.post('/api/repositories/resume', event => setRepositoryPaused(options, event, false))

  app.get('/api/reviews', (event) => {
    const query = new URL(event.req.url).searchParams
    const repository = query.get('repository')
    const pullRequestNumber = Number(query.get('pull_request'))
    if (repository === null || !/^[^/]+\/[^/]+$/.test(repository) || !Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1)
      throw createError({ status: 400, statusText: 'Bad Request', message: 'Valid repository and pull_request query values are required.' })
    return { runs: options.store.listReviewRuns(repository, pullRequestNumber) }
  })

  app.post('/api/approvals', async (event) => {
    const body = approvalRequest(await event.req.json().catch(() => {
      // Approval validation below reports malformed JSON as a bad request.
      return undefined
    }))
    if (body === undefined)
      throw createError({ status: 400, statusText: 'Bad Request', message: 'A valid pull request Approval is required.' })
    const result = options.store.approvePullRequest({ ...body, at: options.now().toISOString() })
    if (result._tag === 'Rejected')
      throw createError({ status: 409, statusText: 'Conflict', message: approvalRejectionMessage(result) })
    return result
  })

  app.post('/api/issues/approve', async (event) => {
    const body = issueApprovalRequest(await event.req.json().catch(() => {
      // Approval validation below reports malformed JSON as a bad request.
      return undefined
    }))
    if (body === undefined)
      throw createError({ status: 400, statusText: 'Bad Request', message: 'A valid issue Approval is required.' })
    const result = options.store.approveIssueWork({ ...body, at: options.now().toISOString() })
    if (result._tag !== 'Rejected')
      return result
    switch (result.reason._tag) {
      case 'ItemNotFound': throw createError({ status: 404, statusText: 'Not Found', message: 'The issue is no longer open.' })
      case 'RevisionMismatch': throw createError({ status: 409, statusText: 'Conflict', message: 'The issue changed. Refresh before approving it.' })
      case 'ApprovalNotRequired': throw createError({ status: 409, statusText: 'Conflict', message: 'This issue does not require local approval.' })
      case 'TriageRequired': throw createError({ status: 409, statusText: 'Conflict', message: 'Issue triage must finish before approval.' })
      case 'NotAuthorized': throw createError({ status: 409, statusText: 'Conflict', message: 'Repository policy does not permit issue work.' })
    }
  })

  app.post('/api/tasks/cancel', async (event) => {
    const body = cancelTaskRequest(await event.req.json().catch(() => {
      // Cancellation validation below reports malformed JSON as a bad request.
      return undefined
    }))
    if (body === undefined)
      throw createError({ status: 400, statusText: 'Bad Request', message: 'A valid task ID is required.' })
    const result = options.store.cancelTask({ ...body, at: options.now().toISOString() })
    if (result._tag !== 'Rejected')
      return result
    if (result.reason._tag === 'TaskNotFound')
      throw createError({ status: 404, statusText: 'Not Found', message: 'The task was not found.' })
    throw createError({ status: 409, statusText: 'Conflict', message: 'The task already finished.' })
  })

  app.post('/api/reviews/rerun', async (event) => {
    const body = reviewRerunRequest(await event.req.json().catch(() => {
      // Rerun validation below reports malformed JSON as a bad request.
      return undefined
    }))
    if (body === undefined)
      throw createError({ status: 400, statusText: 'Bad Request', message: 'A valid pull request and head commit are required.' })
    const result = options.store.requestReviewRerun({
      ...body,
      requestId: `dashboard:${randomUUID()}`,
      source: 'dashboard',
      requestedBy: 'dashboard',
      at: options.now().toISOString(),
    })
    if (result._tag !== 'Rejected')
      return result
    if (result.reason._tag === 'ItemNotFound')
      throw createError({ status: 404, statusText: 'Not Found', message: 'The pull request is no longer open.' })
    if (result.reason._tag === 'RevisionMismatch')
      throw createError({ status: 409, statusText: 'Conflict', message: 'The pull request head commit changed. Refresh before rerunning.' })
    throw createError({ status: 409, statusText: 'Conflict', message: 'The pull request is not ready for review.' })
  })

  app.get('/api/events', (event) => {
    const stream = createEventStream(event)
    let previous = observableState(options)
    void stream.pushComment('connected')
    const interval = setInterval(() => {
      const next = observableState(options)
      if (next === previous)
        return
      previous = next
      const snapshot = dashboardSnapshot(options)
      void stream.push({ event: 'state', data: JSON.stringify(snapshot) }).catch(() => {
        // The browser closed this live update connection.
        clearInterval(interval)
      })
    }, options.eventIntervalMilliseconds ?? 2_000)
    interval.unref()
    const stop = (): void => {
      clearInterval(interval)
      options.shutdownSignal?.removeEventListener('abort', stop)
    }
    if (options.shutdownSignal?.aborted)
      void stream.close()
    else
      options.shutdownSignal?.addEventListener('abort', stop, { once: true })
    stream.onClosed(stop)
    return stream
  })

  app.get('/favicon.ico', () => new Response(null, { status: 204 }))
  app.get('/_payload.json', () => staticAsset(dashboardRoot, '_payload.json'))
  app.get('/flow/_payload.json', () => staticAsset(dashboardRoot, 'flow/_payload.json'))
  app.get('/_nuxt/**', event => staticAsset(dashboardRoot, new URL(event.req.url).pathname.slice(1)))
  app.get('/_fonts/**', event => staticAsset(dashboardRoot, new URL(event.req.url).pathname.slice(1)))
  app.get('/', event => dashboardHtml(dashboardRoot, 'index.html', String(event.context.dashboardNonce)))
  app.get('/flow', event => dashboardHtml(dashboardRoot, 'flow/index.html', String(event.context.dashboardNonce)))

  return app
}
