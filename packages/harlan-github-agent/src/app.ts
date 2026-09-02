import type { AgentActivityLog } from './agent-activity.ts'
import type { StatsRangeError } from './stats.ts'
import type { JournalStore } from './store.ts'
import type { DashboardSnapshot, WorkflowEventStream } from './types.ts'
import { Buffer } from 'node:buffer'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, relative } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createError, createEventStream, H3, setResponseStatus } from 'h3'
import { parseAgentFeedback } from './agent-feedback.ts'
import { parseAgentSelection } from './agent-profile.ts'
import { parseStatsRange } from './stats.ts'

export interface AgentAppOptions {
  store: Pick<JournalStore, 'approveIssueWork' | 'approvePullRequest' | 'cancelTask' | 'getDashboardSnapshot' | 'getStats' | 'listReviewRuns' | 'listWorkflowEvents' | 'pauseAgents' | 'recordAgentFeedback' | 'requestRestart' | 'requestReviewRerun' | 'resumeAgents' | 'selectAgent' | 'setRepositoryPaused' | 'setSelectionMode' | 'dismissItem' | 'restoreItem' | 'setRepositoryWritesEnabled'>
  settleTask?: (taskId: string) => Promise<boolean>
  ejectSettlementTimeoutMilliseconds?: number
  allowedOrigin: string
  dashboardPassword: string
  dashboardRoot?: string
  now: () => Date
  eventIntervalMilliseconds?: number
  shutdownSignal?: AbortSignal
  activityLog?: Pick<AgentActivityLog, 'read'>
}

/** Prerendered dashboard routes below `/`, each with its own payload. */
const DASHBOARD_PAGES = ['history', 'watching', 'flow', 'stats'] as const
const EJECT_SETTLEMENT_TIMEOUT_MILLISECONDS = 12_000

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
    routineRuns: snapshot.routineRuns.map(run => ({ ...run, activity: activityLog.read(run.id) })),
  }
}

function settleEjectedTask(options: AgentAppOptions, taskId: string): Promise<boolean> {
  const settleTask = options.settleTask
  if (settleTask === undefined)
    return Promise.resolve(false)
  const timeoutMilliseconds = options.ejectSettlementTimeoutMilliseconds ?? EJECT_SETTLEMENT_TIMEOUT_MILLISECONDS
  return new Promise((resolve) => {
    let answered = false
    const answer = (settled: boolean) => {
      if (answered)
        return
      answered = true
      clearTimeout(timeout)
      resolve(settled)
    }
    const timeout = setTimeout(answer, timeoutMilliseconds, false)
    timeout.unref()
    settleTask(taskId).then(answer, () => answer(false))
  })
}

async function setRepositoryWrites(options: AgentAppOptions, event: { req: { json: () => Promise<unknown> } }, writesEnabled: boolean): Promise<{ github: string, writesEnabled: boolean }> {
  const body = await event.req.json().catch(() => {
    // Malformed JSON receives the same 400 response as a missing repository.
    return undefined
  })
  const github = typeof body === 'object' && body !== null && 'repository' in body ? (body as { repository: unknown }).repository : undefined
  if (typeof github !== 'string' || !/^[^/]+\/[^/]+$/.test(github))
    throw createError({ status: 400, statusText: 'Bad Request', message: 'A valid repository is required.' })
  if (!options.store.setRepositoryWritesEnabled(github, writesEnabled))
    throw createError({ status: 404, statusText: 'Not Found', message: 'That repository is not mapped.' })
  return { github, writesEnabled }
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
  const snapshot = dashboardSnapshot(options)
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

type ParsedAgentSession
  = | { _tag: 'Codex', id: string, provider: 'codex' }
    | { _tag: 'Opencode', id: string, provider: 'opencode' }

function parseAgentSession(provider: 'codex' | 'opencode', id: string): ParsedAgentSession | undefined {
  if (provider === 'codex')
    return /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(id) ? { _tag: 'Codex', id, provider } : undefined
  return /^ses_[a-z\d]{8,}$/i.test(id) ? { _tag: 'Opencode', id, provider } : undefined
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

function statsRangeMessage(error: StatsRangeError): string {
  switch (error._tag) {
    case 'MissingFrom':
    case 'InvalidFrom': return 'Choose a valid start date.'
    case 'MissingTo':
    case 'InvalidTo': return 'Choose a valid end date.'
    case 'InvalidTimeZone': return 'Choose a supported time zone.'
    case 'EmptyRange': return 'The end date must follow the start date.'
  }
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

/**
 * A Dismissal names an Item, never a Task, so a new head commit cannot undo it.
 */
async function changeDismissal(options: AgentAppOptions, event: { req: Request }, action: 'dismiss' | 'restore') {
  const body = await event.req.json().catch(() => {
    // Validation below reports malformed JSON as a bad request.
    return undefined
  }) as { repository?: unknown, itemNumber?: unknown } | undefined
  if (typeof body?.repository !== 'string' || !/^[^/]+\/[^/]+$/.test(body.repository)
    || !Number.isSafeInteger(body.itemNumber) || (body.itemNumber as number) < 1) {
    throw createError({ status: 400, statusText: 'Bad Request', message: 'A valid repository and item number are required.' })
  }
  const input = { repository: body.repository, itemNumber: body.itemNumber as number, at: options.now().toISOString() }
  const result = action === 'dismiss' ? options.store.dismissItem(input) : options.store.restoreItem(input)
  if (result._tag === 'Rejected')
    throw createError({ status: 404, statusText: 'Not Found', message: 'The item is no longer tracked.' })
  return result
}

export function createAgentApp(options: AgentAppOptions): H3 {
  const dashboardRoot = options.dashboardRoot ?? defaultDashboardRoot()
  const allowedHost = new URL(options.allowedOrigin).host
  const app = new H3({
    onRequest(event) {
      if (event.req.headers.get('host') !== allowedHost)
        throw createError({ status: 421, statusText: 'Misdirected Request', message: 'Host is not allowed.' })
      if (!hasDashboardAccess(event.req, options.dashboardPassword)) {
        throw createError({
          status: 401,
          statusText: 'Unauthorized',
          message: 'Dashboard credentials are required.',
          headers: { 'www-authenticate': 'Basic realm="harlan-github-agent", charset="UTF-8"' },
        })
      }
      if (event.req.method !== 'GET' && event.req.method !== 'HEAD' && event.req.headers.get('origin') !== options.allowedOrigin)
        throw createError({ status: 403, statusText: 'Forbidden', message: 'Request origin is not allowed.' })
      event.context.dashboardNonce = randomBytes(18).toString('base64')
    },
    onResponse(response, event) {
      Object.entries(securityHeaders).forEach(([name, value]) => response.headers.set(name, value))
      const nonce = String(event.context.dashboardNonce)
      // GitHub avatars come from github.com and redirect to avatars.githubusercontent.com.
      response.headers.set('content-security-policy', `default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; img-src 'self' data: https://github.com https://avatars.githubusercontent.com; object-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'`)
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

  app.post('/api/service/restart', async (event) => {
    const body = await event.req.json().catch(() => {
      // Parsing below reports malformed JSON as a bad request.
      return undefined
    }) as { source?: unknown } | undefined
    if (body?.source !== 'dashboard' && body?.source !== 'tray' && body?.source !== 'helper')
      throw createError({ status: 400, statusText: 'Bad Request', message: 'Restart source must be dashboard, tray, or helper.' })
    const request = options.store.requestRestart({
      id: randomUUID(),
      source: body.source,
      operation: { _tag: 'Restart' },
      at: options.now().toISOString(),
    })
    setResponseStatus(event, 202)
    return request
  })

  app.post('/api/service/update', async (event) => {
    const body = await event.req.json().catch(() => {
      // Validation below reports malformed JSON as a bad request.
      return undefined
    }) as { source?: unknown } | undefined
    if (body?.source !== 'dashboard' && body?.source !== 'helper')
      throw createError({ status: 400, statusText: 'Bad Request', message: 'Update source must be dashboard or helper.' })
    const update = options.store.getDashboardSnapshot(options.now().toISOString()).serviceUpdate
    if (update._tag !== 'Available')
      throw createError({ status: 409, statusText: 'Conflict', message: 'No service update is available.' })
    const request = options.store.requestRestart({
      id: randomUUID(),
      source: body.source,
      operation: { _tag: 'Update', targetCommit: update.latestCommit },
      at: options.now().toISOString(),
    })
    setResponseStatus(event, 202)
    return request
  })

  app.post('/api/agents/selection-mode', async (event) => {
    const body = await event.req.json().catch(() => {
      // Validation below reports malformed JSON as a bad request.
      return undefined
    }) as { mode?: unknown } | undefined
    if (body?.mode !== 'auto' && body?.mode !== 'manual')
      throw createError({ status: 400, statusText: 'Bad Request', message: 'Selection mode must be auto or manual.' })
    return { selectionMode: options.store.setSelectionMode(body.mode) }
  })

  app.post('/api/agents/select', async (event) => {
    const selection = parseAgentSelection(await event.req.json().catch(() => {
      // Selection parsing below reports malformed JSON as a bad request.
      return undefined
    }))
    if (selection._tag === 'Err')
      throw createError({ status: 400, statusText: 'Bad Request', message: selection.error })
    return options.store.selectAgent(selection.value, options.now().toISOString())
  })

  app.post('/api/agents/eject', async (event) => {
    const body = cancelTaskRequest(await event.req.json().catch(() => {
      // Request validation below reports malformed JSON as a bad request.
      return undefined
    }))
    if (body === undefined)
      throw createError({ status: 400, statusText: 'Bad Request', message: 'A valid task ID is required.' })
    const agent = dashboardSnapshot(options).agents.find(candidate => candidate._tag === 'ActiveAgent' && candidate.id === body.taskId)
    if (agent?._tag !== 'ActiveAgent')
      throw createError({ status: 404, statusText: 'Not Found', message: 'The running agent was not found.' })
    if (agent.session._tag !== 'Connected')
      throw createError({ status: 409, statusText: 'Conflict', message: 'The agent session is still starting.' })
    const session = parseAgentSession(agent.provider, agent.session.id)
    if (session === undefined)
      throw createError({ status: 409, statusText: 'Conflict', message: 'The saved agent session is invalid.' })
    if (options.settleTask === undefined)
      throw createError({ status: 503, statusText: 'Service Unavailable', message: 'The agent session cannot be transferred safely.' })
    const cancelled = options.store.cancelTask({ taskId: body.taskId, at: options.now().toISOString() })
    if (cancelled._tag === 'Rejected')
      throw createError({ status: 409, statusText: 'Conflict', message: 'The agent already finished. Refresh before ejecting.' })
    const settled = await settleEjectedTask(options, body.taskId)
    if (!settled) {
      throw createError({
        status: 503,
        statusText: 'Service Unavailable',
        message: 'The agent stop could not be confirmed.',
        data: {
          _tag: 'EjectDelayed',
          provider: session.provider,
          sessionId: session.id,
          nextAction: 'Stop Harlan GitHub Agent. Then resume this saved session.',
        },
      })
    }
    return {
      _tag: 'Ejected',
      provider: session.provider,
      sessionId: session.id,
      repository: agent.repository,
      itemNumber: agent.itemNumber,
    }
  })

  app.post('/api/repositories/writes/enable', event => setRepositoryWrites(options, event, true))
  app.post('/api/repositories/writes/disable', event => setRepositoryWrites(options, event, false))
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

  app.post('/api/reviews/feedback', async (event) => {
    const input = parseAgentFeedback(await event.req.json().catch(() => {
      // Parsing below reports malformed JSON as a bad request.
      return undefined
    }))
    if (input._tag === 'Err')
      throw createError({ status: 400, statusText: 'Bad Request', message: input.error })
    const result = options.store.recordAgentFeedback({ ...input.value, at: options.now().toISOString() })
    if (result._tag === 'Rejected')
      throw createError({ status: 404, statusText: 'Not Found', message: 'The review was not found.' })
    return result
  })

  app.get('/api/stats', (event) => {
    const query = new URL(event.req.url).searchParams
    const range = parseStatsRange({
      from: query.get('from') ?? undefined,
      to: query.get('to') ?? undefined,
      timeZone: query.get('time_zone') ?? undefined,
    })
    if (range._tag === 'Err')
      throw createError({ status: 400, statusText: 'Bad Request', message: statsRangeMessage(range.error) })
    return options.store.getStats(range.value, options.now().toISOString())
  })

  app.get('/api/workflow-events', (event) => {
    const query = new URL(event.req.url).searchParams
    const stream = query.get('stream')
    const allowed = new Set([
      'task',
      'worker_task',
      'publication',
      'review_run',
      'review_gate',
      'review_resolution',
      'review_status',
      'issue_triage_status',
      'routine_run',
      'candidate_issue',
      'routine_report',
      'provider_circuit',
    ])
    if (stream !== null && !allowed.has(stream))
      throw createError({ status: 400, statusText: 'Bad Request', message: 'Select a valid workflow event stream.' })
    const rawLimit = query.get('limit')
    const limit = rawLimit === null ? 200 : Number(rawLimit)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
      throw createError({ status: 400, statusText: 'Bad Request', message: 'Set limit from 1 to 1000.' })
    return {
      events: options.store.listWorkflowEvents({
        ...(stream === null ? {} : { stream: stream as WorkflowEventStream }),
        limit,
      }),
    }
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

  app.post('/api/items/dismiss', event => changeDismissal(options, event, 'dismiss'))

  app.post('/api/items/restore', event => changeDismissal(options, event, 'restore'))

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
  app.get('/_nuxt/**', event => staticAsset(dashboardRoot, new URL(event.req.url).pathname.slice(1)))
  app.get('/_fonts/**', event => staticAsset(dashboardRoot, new URL(event.req.url).pathname.slice(1)))
  app.get('/_nuxt-skew-sw.js', () => staticAsset(dashboardRoot, '_nuxt-skew-sw.js'))
  app.get('/', event => dashboardHtml(dashboardRoot, 'index.html', String(event.context.dashboardNonce)))
  DASHBOARD_PAGES.forEach((page) => {
    app.get(`/${page}`, event => dashboardHtml(dashboardRoot, `${page}/index.html`, String(event.context.dashboardNonce)))
    app.get(`/${page}/_payload.json`, () => staticAsset(dashboardRoot, `${page}/_payload.json`))
  })

  return app
}
