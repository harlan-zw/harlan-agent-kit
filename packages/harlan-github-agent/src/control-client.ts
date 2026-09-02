import type { Result } from './result.ts'
import type { CancelTaskResult } from './store.ts'
import type {
  AgentActivityItem,
  DashboardSnapshot,
  DashboardTask,
  Incident,
  RestartRequest,
  StoredAgentControl,
  WorkflowEvent,
  WorkflowEventStream,
} from './types.ts'
import { Buffer } from 'node:buffer'
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

export type ControlApiError
  = | { _tag: 'NetworkFailure', message: string }
    | { _tag: 'HttpFailure', status: number, message: string }
    | { _tag: 'InvalidResponse', message: string }

export type ControlClientError
  = | ControlApiError
    | { _tag: 'TaskNotFound', taskId: string }

export interface ControlClientOptions {
  baseUrl: string
  authentication: { _tag: 'Basic', password: string }
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

export interface WorkflowEventQuery {
  stream?: WorkflowEventStream
  limit?: number
}

type TaskCancellation = Extract<CancelTaskResult, { _tag: 'Cancelled' | 'AlreadyCancelled' }>
type Parsed<Value> = Result<Value, string>
type ResponseParser<Value> = (value: unknown) => Parsed<Value>

export interface ControlClient {
  health: () => Promise<Result<ControlHealth, ControlApiError>>
  state: () => Promise<Result<DashboardSnapshot, ControlApiError>>
  status: () => Promise<Result<ControlStatus, ControlApiError>>
  tasks: () => Promise<Result<DashboardTask[], ControlApiError>>
  incidents: () => Promise<Result<Incident[], ControlApiError>>
  activity: (taskId: string) => Promise<Result<AgentActivityItem[], ControlClientError>>
  workflowEvents: (query?: WorkflowEventQuery) => Promise<Result<WorkflowEvent[], ControlApiError>>
  pause: () => Promise<Result<StoredAgentControl, ControlApiError>>
  resume: () => Promise<Result<StoredAgentControl, ControlApiError>>
  restart: () => Promise<Result<RestartRequest, ControlApiError>>
  update: () => Promise<Result<RestartRequest, ControlApiError>>
  cancelTask: (taskId: string) => Promise<Result<TaskCancellation, ControlApiError>>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function parseHealth(value: unknown): Parsed<ControlHealth> {
  const input = record(value)
  if (input === undefined
    || (input.status !== 'starting' && input.status !== 'ready' && input.status !== 'degraded')
    || typeof input.mutationsEnabled !== 'boolean'
    || !integer(input.repositories)
    || !integer(input.issues)
    || !integer(input.pullRequests)
    || !integer(input.tasks)) {
    return err('The service returned invalid health data.')
  }
  return ok(input as unknown as ControlHealth)
}

function parseState(value: unknown): Parsed<DashboardSnapshot> {
  const input = record(value)
  if (input === undefined
    || typeof input.generatedAt !== 'string'
    || (input.status !== 'starting' && input.status !== 'ready' && input.status !== 'degraded')
    || typeof input.mutationsEnabled !== 'boolean'
    || !Array.isArray(input.agents)
    || !Array.isArray(input.incidents)
    || !Array.isArray(input.repositories)
    || !Array.isArray(input.tasks)) {
    return err('The service returned invalid state data.')
  }
  return ok(input as unknown as DashboardSnapshot)
}

function parseAgentControl(value: unknown): Parsed<StoredAgentControl> {
  const input = record(value)
  if (input?._tag === 'Running')
    return ok({ _tag: 'Running' })
  if (input?._tag === 'Paused' && typeof input.pausedAt === 'string')
    return ok({ _tag: 'Paused', pausedAt: input.pausedAt })
  return err('The service returned invalid Agent control data.')
}

function parseRestartRequest(value: unknown): Parsed<RestartRequest> {
  const input = record(value)
  const operation = record(input?.operation)
  const validOperation = operation?._tag === 'Restart'
    || (operation?._tag === 'Update' && typeof operation.targetCommit === 'string')
  if (input === undefined
    || !['Requested', 'Restarting', 'Completed', 'ActionRequired'].includes(String(input._tag))
    || typeof input.id !== 'string'
    || (input.source !== 'dashboard' && input.source !== 'tray' && input.source !== 'helper')
    || !validOperation
    || typeof input.requestedAt !== 'string') {
    return err('The service returned an invalid Restart request.')
  }
  return ok(input as unknown as RestartRequest)
}

function parseCancellation(value: unknown): Parsed<TaskCancellation> {
  const input = record(value)
  if (input?._tag === 'Cancelled' || input?._tag === 'AlreadyCancelled')
    return ok({ _tag: input._tag })
  return err('The service returned an invalid Task cancellation.')
}

function parseWorkflowEvents(value: unknown): Parsed<WorkflowEvent[]> {
  const input = record(value)
  return Array.isArray(input?.events)
    ? ok(input.events as WorkflowEvent[])
    : err('The service returned invalid workflow events.')
}

function errorMessage(value: unknown, fallback: string): string {
  const input = record(value)
  if (typeof input?.message === 'string' && input.message.length > 0)
    return input.message
  if (typeof input?.statusMessage === 'string' && input.statusMessage.length > 0)
    return input.statusMessage
  return fallback
}

function caughtMessage(value: unknown): string {
  return value instanceof Error && value.message.length > 0
    ? value.message
    : 'The service could not be reached.'
}

function parseBaseUrl(value: string): Result<URL, ControlClientConfigurationError> {
  if (!URL.canParse(value))
    return err({ _tag: 'InvalidBaseUrl', message: 'Enter a valid service URL.' })
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return err({ _tag: 'InvalidBaseUrl', message: 'The service URL must use HTTP or HTTPS.' })
  if (url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0)
    return err({ _tag: 'InvalidBaseUrl', message: 'The service URL must not contain credentials, a query, or a fragment.' })
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
  return ok(url)
}

export function createControlClient(options: ControlClientOptions): Result<ControlClient, ControlClientConfigurationError> {
  const parsedBaseUrl = parseBaseUrl(options.baseUrl)
  if (parsedBaseUrl._tag === 'Err')
    return parsedBaseUrl
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
    const response = await options.fetch(new URL(input.path, baseUrl), {
      method: input.method,
      headers,
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    }).then(value => ok(value), reason => err({ _tag: 'NetworkFailure' as const, message: caughtMessage(reason) }))
    if (response._tag === 'Err')
      return response

    const body = await response.value.json()
      .then(value => ok(value), () => err({ _tag: 'InvalidResponse' as const, message: 'The service returned invalid JSON.' }))
    if (body._tag === 'Err')
      return body
    const accepted = input.acceptedStatuses ?? [200]
    if (!accepted.includes(response.value.status)) {
      return err({
        _tag: 'HttpFailure',
        status: response.value.status,
        message: errorMessage(body.value, `The service returned HTTP ${response.value.status}.`),
      })
    }
    const parsed = input.parse(body.value)
    return parsed._tag === 'Ok'
      ? parsed
      : err({ _tag: 'InvalidResponse', message: parsed.error })
  }

  const health = () => request({ method: 'GET', path: 'health', parse: parseHealth, acceptedStatuses: [200, 503] })
  const state = () => request({ method: 'GET', path: 'api/state', parse: parseState })

  return ok({
    health,
    state,
    async status() {
      const healthResult = await health()
      if (healthResult._tag === 'Err')
        return healthResult
      const stateResult = await state()
      return stateResult._tag === 'Err'
        ? stateResult
        : ok({ health: healthResult.value, state: stateResult.value })
    },
    async tasks() {
      const result = await state()
      return result._tag === 'Err' ? result : ok(result.value.tasks)
    },
    async incidents() {
      const result = await state()
      return result._tag === 'Err' ? result : ok(result.value.incidents)
    },
    async activity(taskId) {
      const result = await state()
      if (result._tag === 'Err')
        return result
      const agent = result.value.agents.find(candidate => candidate._tag === 'ActiveAgent' && candidate.id === taskId)
      return agent?._tag === 'ActiveAgent'
        ? ok(agent.activity)
        : err({ _tag: 'TaskNotFound', taskId })
    },
    workflowEvents(query = {}) {
      const search = new URLSearchParams()
      if (query.stream !== undefined)
        search.set('stream', query.stream)
      if (query.limit !== undefined)
        search.set('limit', String(query.limit))
      const suffix = search.size === 0 ? '' : `?${search.toString()}`
      return request({ method: 'GET', path: `api/workflow-events${suffix}`, parse: parseWorkflowEvents })
    },
    pause: () => request({ method: 'POST', path: 'api/agents/pause', parse: parseAgentControl }),
    resume: () => request({ method: 'POST', path: 'api/agents/resume', parse: parseAgentControl }),
    restart: () => request({ method: 'POST', path: 'api/service/restart', body: { source: 'helper' }, parse: parseRestartRequest, acceptedStatuses: [202] }),
    update: () => request({ method: 'POST', path: 'api/service/update', body: { source: 'helper' }, parse: parseRestartRequest, acceptedStatuses: [202] }),
    cancelTask: taskId => request({ method: 'POST', path: 'api/tasks/cancel', body: { taskId }, parse: parseCancellation }),
  })
}
