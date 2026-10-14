import type { IncidentResolutionReceipt, IncidentResolutionRequest } from './incident-resolution.ts'
import type { PullRequestWatchOptions, PullRequestWatchState, PullRequestWatchTarget } from './pull-request-watch.ts'
import type { RepairRecoveryRequest, RepairRecoveryResponse } from './repair-recovery.ts'
import type { Result } from './result.ts'
import type { CancelTaskResult } from './store.ts'
import type {
  AgentActivityItem,
  DashboardSnapshot,
  DashboardTask,
  Incident,
  IssueTriageRerunResult,
  RestartRequest,
  ReviewRun,
  RoutineRun,
  StoredAgentControl,
  WorkflowEvent,
  WorkflowEventStream,
} from './types.ts'
import { Buffer } from 'node:buffer'
import { parseIncidentResolutionReceipt, parseIncidentResolutionRequest } from './incident-resolution.ts'
import { parsePullRequestWatchTarget, watchPullRequestStream } from './pull-request-watch.ts'
import { parseRepairRecoveryCandidate, parseRepairRecoveryResponse } from './repair-recovery.ts'
import { err, ok } from './result.ts'

export interface ControlHealth {
  status: 'starting' | 'ready' | 'degraded'
  mutationsEnabled: boolean
  repositories: number
  issues: number
  pullRequests: number
  tasks: number
}

export interface ControlStatus {
  health: ControlHealth
  state: DashboardSnapshot
}

export interface ControlClientConfigurationError {
  _tag: 'InvalidBaseUrl'
  message: string
}

export type ControlApiError =
  | { _tag: 'NetworkFailure'; message: string }
  | { _tag: 'HttpFailure'; status: number; message: string }
  | { _tag: 'InvalidResponse'; message: string }

export type ControlClientError =
  | ControlApiError
  | { _tag: 'TaskNotFound'; taskId: string; message: string }
  | { _tag: 'TaskActivityUnavailable'; taskId: string; state: DashboardTask['state']['_tag']; message: string }

export interface ControlTaskList {
  tasks: DashboardTask[]
  completionTasks: NonNullable<DashboardSnapshot['completionTasks']>
}

export interface ControlClientOptions {
  baseUrl: string
  authentication: { _tag: 'Basic'; password: string }
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

export interface WorkflowEventQuery {
  stream?: WorkflowEventStream
  limit?: number
}

export type ControlReviewRun = Pick<
  ReviewRun,
  'id' | 'repository' | 'pullRequestNumber' | 'headSha' | 'startedAt' | 'completedAt' | 'outcome' | 'gates' | 'findings'
>

export interface ReviewQuery {
  repository: string
  number: number
  head?: string
}

type TaskCancellation = Extract<CancelTaskResult, { _tag: 'Cancelled' | 'AlreadyCancelled' }>
type Parsed<Value> = Result<Value, string>
type ResponseParser<Value> = (value: unknown) => Parsed<Value>

export interface ControlClient {
  reviews: (query: ReviewQuery) => Promise<Result<{ runs: ControlReviewRun[] }, ControlApiError>>
  recoverRepair: (request: RepairRecoveryRequest) => Promise<Result<RepairRecoveryResponse, ControlApiError>>
  watchPullRequest: (
    target: PullRequestWatchTarget,
    options?: PullRequestWatchOptions,
  ) => Promise<Result<PullRequestWatchState, ControlApiError>>
  health: () => Promise<Result<ControlHealth, ControlApiError>>
  state: () => Promise<Result<DashboardSnapshot, ControlApiError>>
  status: () => Promise<Result<ControlStatus, ControlApiError>>
  tasks: () => Promise<Result<ControlTaskList, ControlApiError>>
  resolveIncident: (request: IncidentResolutionRequest) => Promise<Result<IncidentResolutionReceipt, ControlApiError>>
  incidents: () => Promise<Result<Incident[], ControlApiError>>
  activity: (taskId: string) => Promise<Result<AgentActivityItem[], ControlClientError>>
  workflowEvents: (query?: WorkflowEventQuery) => Promise<Result<WorkflowEvent[], ControlApiError>>
  pause: () => Promise<Result<StoredAgentControl, ControlApiError>>
  resume: () => Promise<Result<StoredAgentControl, ControlApiError>>
  restart: () => Promise<Result<RestartRequest, ControlApiError>>
  reloadExternalWatches: () => Promise<Result<{ repositories: number; issues: number }, ControlApiError>>
  update: (targetCommit?: string) => Promise<Result<RestartRequest, ControlApiError>>
  cancelTask: (taskId: string) => Promise<Result<TaskCancellation, ControlApiError>>
  stopReview: (
    repository: string,
    pullRequestNumber: number,
    headSha: string,
  ) => Promise<Result<{ _tag: 'Stopped' | 'AlreadyStopped' }, ControlApiError>>
  rerunIssueTriage: (
    repository: string,
    issueNumber: number,
    revisionId: string,
  ) => Promise<Result<Exclude<IssueTriageRerunResult, { _tag: 'Rejected' }>, ControlApiError>>
  issueStatus: (
    repository: string,
    issueNumber: number,
  ) => Promise<Result<{ revisionId: string; dismissed: boolean }, ControlApiError>>
  /** Opens one run of a Routine for the current minute, ahead of its schedule. */
  runRoutine: (routineId: string) => Promise<Result<RoutineRun, ControlApiError>>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function validActivityItem(value: unknown): value is AgentActivityItem {
  const item = record(value)
  if (item === undefined || typeof item.at !== 'string') return false
  switch (item._tag) {
    case 'Command':
      return (
        typeof item.command === 'string' &&
        typeof item.output === 'string' &&
        (item.exitCode === null || Number.isInteger(item.exitCode))
      )
    case 'Reasoning':
      return typeof item.text === 'string'
    case 'Progress':
      return (
        typeof item.text === 'string' &&
        typeof item.percent === 'number' &&
        Number.isFinite(item.percent) &&
        item.percent >= 0 &&
        item.percent <= 100
      )
    case 'FileChange':
      return (
        Array.isArray(item.changes) &&
        item.changes.every((value) => {
          const change = record(value)
          return (
            change !== undefined &&
            typeof change.path === 'string' &&
            typeof change.kind === 'string' &&
            ['add', 'delete', 'update'].includes(change.kind)
          )
        })
      )
    default:
      return false
  }
}

function parseActivity(value: unknown, taskId: string): Parsed<Result<AgentActivityItem[], ControlClientError>> {
  const input = record(value)
  const success = record(input?.value)
  if (
    input?._tag === 'Ok' &&
    success?.taskId === taskId &&
    Array.isArray(success.activity) &&
    success.activity.every(validActivityItem)
  )
    return ok(ok(success.activity))
  const failure = record(input?.error)
  if (input?._tag === 'Err' && failure?.taskId === taskId && typeof failure.message === 'string') {
    if (failure._tag === 'TaskNotFound') return ok(err({ _tag: 'TaskNotFound', taskId, message: failure.message }))
    if (
      failure._tag === 'TaskActivityUnavailable' &&
      typeof failure.state === 'string' &&
      ['Queued', 'Running', 'Publishing', 'Completed', 'Failed', 'ActionRequired', 'Superseded'].includes(failure.state)
    ) {
      return ok(
        err({
          _tag: 'TaskActivityUnavailable',
          taskId,
          state: failure.state as DashboardTask['state']['_tag'],
          message: failure.message,
        }),
      )
    }
  }
  return err('The Service returned invalid Task activity.')
}

function parseTasks(value: unknown): Parsed<ControlTaskList> {
  const input = record(value)
  return input !== undefined && Array.isArray(input.tasks) && Array.isArray(input.completionTasks)
    ? ok({
        tasks: input.tasks as DashboardTask[],
        completionTasks: input.completionTasks as ControlTaskList['completionTasks'],
      })
    : err('The Service returned invalid Tasks.')
}

function parseIncidents(value: unknown): Parsed<Incident[]> {
  const input = record(value)
  return Array.isArray(input?.incidents)
    ? ok(input.incidents as Incident[])
    : err('The Service returned invalid Incidents.')
}

function parseReviews(value: unknown): Parsed<{ runs: ControlReviewRun[] }> {
  const input = record(value)
  if (!Array.isArray(input?.runs)) return err('The service returned invalid Review runs.')
  for (const value of input.runs) {
    const run = record(value)
    const gates = record(run?.gates)
    const outcome = record(run?.outcome)
    if (
      run === undefined ||
      typeof run.id !== 'string' ||
      typeof run.repository !== 'string' ||
      !integer(run.pullRequestNumber) ||
      run.pullRequestNumber < 1 ||
      typeof run.headSha !== 'string' ||
      !/^[a-f\d]{40}$/.test(run.headSha) ||
      typeof run.startedAt !== 'string' ||
      typeof run.completedAt !== 'string' ||
      !['Ready', 'Pending', 'Blocked'].includes(String(outcome?._tag)) ||
      !Array.isArray(run.findings) ||
      gates === undefined
    ) {
      return err('The service returned an invalid Review run.')
    }
    for (const name of ['merge', 'review', 'ci']) {
      const gate = record(gates[name])
      if (
        !['Passed', 'Pending', 'Failed'].includes(String(gate?._tag)) ||
        !Array.isArray(gate?.evidence) ||
        (gate._tag !== 'Passed' && typeof gate.reason !== 'string')
      ) {
        return err('The service returned invalid Review gates.')
      }
    }
    for (const value of run.findings) {
      const finding = record(value)
      if (
        !['Fixed', 'Logged', 'Open'].includes(String(finding?._tag)) ||
        typeof finding?.summary !== 'string' ||
        (finding._tag === 'Open' && typeof finding.nextAction !== 'string') ||
        (finding._tag === 'Logged' && typeof finding.impact !== 'number')
      ) {
        return err('The service returned invalid Review findings.')
      }
    }
  }
  return ok({ runs: input.runs as ControlReviewRun[] })
}

function parseHealth(value: unknown): Parsed<ControlHealth> {
  const input = record(value)
  if (
    input === undefined ||
    (input.status !== 'starting' && input.status !== 'ready' && input.status !== 'degraded') ||
    typeof input.mutationsEnabled !== 'boolean' ||
    !integer(input.repositories) ||
    !integer(input.issues) ||
    !integer(input.pullRequests) ||
    !integer(input.tasks)
  ) {
    return err('The service returned invalid health data.')
  }
  return ok(input as unknown as ControlHealth)
}

function parseExternalWatchReload(value: unknown): Parsed<{ repositories: number; issues: number }> {
  const input = record(value)
  return input !== undefined && integer(input.repositories) && integer(input.issues)
    ? ok({ repositories: input.repositories, issues: input.issues })
    : err('The service returned invalid external watch counts.')
}

function parseState(value: unknown): Parsed<DashboardSnapshot> {
  const input = record(value)
  if (
    input === undefined ||
    typeof input.generatedAt !== 'string' ||
    (input.status !== 'starting' && input.status !== 'ready' && input.status !== 'degraded') ||
    typeof input.mutationsEnabled !== 'boolean' ||
    !Array.isArray(input.agents) ||
    !Array.isArray(input.incidents) ||
    !Array.isArray(input.repairRecoveryCandidates) ||
    !Array.isArray(input.repositories) ||
    !Array.isArray(input.tasks)
  ) {
    return err('The service returned invalid state data.')
  }
  const candidates: DashboardSnapshot['repairRecoveryCandidates'] = []
  for (const candidate of input.repairRecoveryCandidates) {
    const parsed = parseRepairRecoveryCandidate(candidate)
    if (parsed._tag === 'Err') return err(parsed.error)
    candidates.push(parsed.value)
  }
  return ok({ ...input, repairRecoveryCandidates: candidates } as unknown as DashboardSnapshot)
}

function parseAgentControl(value: unknown): Parsed<StoredAgentControl> {
  const input = record(value)
  if (input?._tag === 'Running') return ok({ _tag: 'Running' })
  if (input?._tag === 'Paused' && typeof input.pausedAt === 'string')
    return ok({ _tag: 'Paused', pausedAt: input.pausedAt })
  return err('The service returned invalid Agent control data.')
}

function parseRestartRequest(value: unknown): Parsed<RestartRequest> {
  const input = record(value)
  const operation = record(input?.operation)
  const validOperation =
    operation?._tag === 'Restart' ||
    (operation?._tag === 'Update' &&
      typeof operation.targetCommit === 'string' &&
      (operation.preparation === 'Pending' || operation.preparation === 'Ready'))
  if (
    input === undefined ||
    !['Requested', 'Restarting', 'Completed', 'ActionRequired'].includes(String(input._tag)) ||
    typeof input.id !== 'string' ||
    (input.source !== 'dashboard' && input.source !== 'tray' && input.source !== 'helper') ||
    !validOperation ||
    typeof input.requestedAt !== 'string'
  ) {
    return err('The service returned an invalid Restart request.')
  }
  return ok(input as unknown as RestartRequest)
}

function parseRoutineRun(value: unknown): Parsed<RoutineRun> {
  const input = record(value)
  if (
    input === undefined ||
    typeof input.id !== 'string' ||
    typeof input.routineId !== 'string' ||
    typeof input.scheduledFor !== 'string' ||
    record(input.state) === undefined
  ) {
    return err('The service returned an invalid Routine run.')
  }
  return ok(input as unknown as RoutineRun)
}

function parseCancellation(value: unknown): Parsed<TaskCancellation> {
  const input = record(value)
  if (input?._tag === 'Cancelled' || input?._tag === 'AlreadyCancelled') return ok({ _tag: input._tag })
  return err('The service returned an invalid Task cancellation.')
}

function parseIssueStatus(value: unknown): Parsed<{ revisionId: string; dismissed: boolean }> {
  const input = record(value)
  if (
    typeof input?.revisionId === 'string' &&
    /^[a-f\d]{64}$/.test(input.revisionId) &&
    typeof input.dismissed === 'boolean'
  )
    return ok({ revisionId: input.revisionId, dismissed: input.dismissed })
  return err('The service returned invalid Issue status.')
}

function parseIssueTriageRerun(value: unknown): Parsed<Exclude<IssueTriageRerunResult, { _tag: 'Rejected' }>> {
  const input = record(value)
  if (
    (input?._tag === 'Queued' || input?._tag === 'AlreadyQueued') &&
    typeof input.taskId === 'string' &&
    /^[a-f\d]{64}$/.test(input.taskId)
  )
    return ok({ _tag: input._tag, taskId: input.taskId })
  return err('The service returned an invalid Issue triage rerun result.')
}

function parseStoppedReview(value: unknown): Parsed<{ _tag: 'Stopped' | 'AlreadyStopped' }> {
  const input = record(value)
  if (input?._tag === 'Stopped' || input?._tag === 'AlreadyStopped') return ok({ _tag: input._tag })
  return err('The service returned an invalid stopped Review result.')
}

function parseWorkflowEvents(value: unknown): Parsed<WorkflowEvent[]> {
  const input = record(value)
  return Array.isArray(input?.events)
    ? ok(input.events as WorkflowEvent[])
    : err('The service returned invalid workflow events.')
}

function errorMessage(value: unknown, fallback: string): string {
  const input = record(value)
  if (typeof input?.message === 'string' && input.message.length > 0) return input.message
  if (typeof input?.statusMessage === 'string' && input.statusMessage.length > 0) return input.statusMessage
  return fallback
}

function caughtMessage(value: unknown): string {
  return value instanceof Error && value.message.length > 0 ? value.message : 'The service could not be reached.'
}

function parseBaseUrl(value: string): Result<URL, ControlClientConfigurationError> {
  if (!URL.canParse(value)) return err({ _tag: 'InvalidBaseUrl', message: 'Enter a valid service URL.' })
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return err({ _tag: 'InvalidBaseUrl', message: 'The service URL must use HTTP or HTTPS.' })
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0)
    return err({
      _tag: 'InvalidBaseUrl',
      message: 'The service URL must not contain credentials, a query, or a fragment.',
    })
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
  return ok(url)
}

export function createControlClient(
  options: ControlClientOptions,
): Result<ControlClient, ControlClientConfigurationError> {
  const parsedBaseUrl = parseBaseUrl(options.baseUrl)
  if (parsedBaseUrl._tag === 'Err') return parsedBaseUrl
  const baseUrl = parsedBaseUrl.value
  const authorization = `Basic ${Buffer.from(`agent:${options.authentication.password}`).toString('base64')}`

  async function request<Value>(input: {
    method: 'GET' | 'POST'
    path: string
    parse: ResponseParser<Value>
    body?: unknown
    acceptedStatuses?: readonly number[]
  }): Promise<Result<Value, ControlApiError>> {
    const headers = new Headers({ authorization, accept: 'application/json' })
    if (input.method === 'POST') {
      headers.set('content-type', 'application/json')
      headers.set('origin', baseUrl.origin)
    }
    const response = await options
      .fetch(new URL(input.path, baseUrl), {
        method: input.method,
        headers,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      })
      .then(
        (value) => ok(value),
        (reason) => err({ _tag: 'NetworkFailure' as const, message: caughtMessage(reason) }),
      )
    if (response._tag === 'Err') return response

    const accepted = input.acceptedStatuses ?? [200]
    if (!accepted.includes(response.value.status)) {
      // The body is best effort: a non-JSON error body only loses the extracted message, the status is kept.
      const body = await response.value.json().catch(() => {
        // Ignorable: the fallback message below already carries the HTTP status.
        return undefined
      })
      return err({
        _tag: 'HttpFailure',
        status: response.value.status,
        message:
          body === undefined
            ? `The service returned HTTP ${response.value.status}.`
            : errorMessage(body, `The service returned HTTP ${response.value.status}.`),
      })
    }
    const body = await response.value.json().then(
      (value) => ok(value),
      () => err({ _tag: 'InvalidResponse' as const, message: 'The service returned invalid JSON.' }),
    )
    if (body._tag === 'Err') return body
    const parsed = input.parse(body.value)
    return parsed._tag === 'Ok' ? parsed : err({ _tag: 'InvalidResponse', message: parsed.error })
  }

  const health = () => request({ method: 'GET', path: 'health', parse: parseHealth, acceptedStatuses: [200, 503] })
  const state = () => request({ method: 'GET', path: 'api/state', parse: parseState })

  return ok({
    async reviews(query) {
      const target = parsePullRequestWatchTarget(query)
      if (target._tag === 'Err' || (query.head !== undefined && !/^[a-f\d]{40}$/.test(query.head)))
        return err({
          _tag: 'InvalidResponse',
          message: target._tag === 'Err' ? target.error : 'Set head to one full head SHA.',
        })
      const search = new URLSearchParams({ repository: query.repository, pull_request: String(query.number) })
      const result = await request({ method: 'GET', path: `api/reviews?${search}`, parse: parseReviews })
      return result._tag === 'Err'
        ? result
        : ok({ runs: result.value.runs.filter((run) => query.head === undefined || run.headSha === query.head) })
    },
    recoverRepair: (body) =>
      request({
        method: 'POST',
        path: 'api/tasks/recover-repair',
        body,
        acceptedStatuses: [200, 202],
        parse: parseRepairRecoveryResponse,
      }),
    watchPullRequest(target, watchOptions = {}) {
      const parsed = parsePullRequestWatchTarget(target)
      if (parsed._tag === 'Err') return Promise.resolve(err({ _tag: 'InvalidResponse', message: parsed.error }))
      const url = new URL('api/items/pull-request-events', baseUrl)
      url.search = new URLSearchParams({ repository: target.repository, number: String(target.number) }).toString()
      return watchPullRequestStream({ url, target, authorization, fetch: options.fetch, options: watchOptions })
    },
    health,
    state,
    async status() {
      const healthResult = await health()
      if (healthResult._tag === 'Err') return healthResult
      const stateResult = await state()
      return stateResult._tag === 'Err' ? stateResult : ok({ health: healthResult.value, state: stateResult.value })
    },
    tasks: () => request({ method: 'GET', path: 'api/tasks', parse: parseTasks }),
    async resolveIncident(input) {
      const parsed = parseIncidentResolutionRequest(input)
      if (parsed._tag === 'Err') return err({ _tag: 'InvalidResponse', message: parsed.error })
      return request({
        method: 'POST',
        path: 'api/incidents/resolve',
        body: parsed.value,
        parse: parseIncidentResolutionReceipt,
      })
    },
    incidents: () => request({ method: 'GET', path: 'api/incidents', parse: parseIncidents }),
    async activity(taskId) {
      const result = await request({
        method: 'GET',
        path: `api/tasks/activity?${new URLSearchParams({ task: taskId })}`,
        parse: (value) => parseActivity(value, taskId),
      })
      return result._tag === 'Err' ? result : result.value
    },
    workflowEvents(query = {}) {
      const search = new URLSearchParams()
      if (query.stream !== undefined) search.set('stream', query.stream)
      if (query.limit !== undefined) search.set('limit', String(query.limit))
      const suffix = search.size === 0 ? '' : `?${search.toString()}`
      return request({ method: 'GET', path: `api/workflow-events${suffix}`, parse: parseWorkflowEvents })
    },
    pause: () => request({ method: 'POST', path: 'api/agents/pause', parse: parseAgentControl }),
    resume: () => request({ method: 'POST', path: 'api/agents/resume', parse: parseAgentControl }),
    restart: () =>
      request({
        method: 'POST',
        path: 'api/service/restart',
        body: { source: 'helper' },
        parse: parseRestartRequest,
        acceptedStatuses: [202],
      }),
    reloadExternalWatches: () =>
      request({ method: 'POST', path: 'api/external-watches/reload', parse: parseExternalWatchReload }),
    update: (targetCommit) =>
      request({
        method: 'POST',
        path: 'api/service/update',
        body: { source: 'helper', ...(targetCommit === undefined ? {} : { targetCommit }) },
        parse: parseRestartRequest,
        acceptedStatuses: [202],
      }),
    cancelTask: (taskId) =>
      request({ method: 'POST', path: 'api/tasks/cancel', body: { taskId }, parse: parseCancellation }),
    stopReview: (repository, pullRequestNumber, headSha) =>
      request({
        method: 'POST',
        path: 'api/reviews/stop',
        body: { repository, pullRequestNumber, headSha },
        parse: parseStoppedReview,
      }),
    rerunIssueTriage: (repository, issueNumber, revisionId) =>
      request({
        method: 'POST',
        path: 'api/issues/rerun-triage',
        body: { repository, issueNumber, revisionId },
        parse: parseIssueTriageRerun,
        acceptedStatuses: [202],
      }),
    issueStatus: (repository, issueNumber) =>
      request({
        method: 'GET',
        path: `api/items/issue-status?${new URLSearchParams({ repository, number: String(issueNumber) })}`,
        parse: parseIssueStatus,
      }),
    runRoutine: (routineId) =>
      request({
        method: 'POST',
        path: 'api/routines/run',
        body: { routineId },
        parse: parseRoutineRun,
        acceptedStatuses: [202],
      }),
  })
}
