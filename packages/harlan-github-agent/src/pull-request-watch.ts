import type { ControlApiError } from './control-client.ts'
import type { Result } from './result.ts'
import type { AgentStartState, AgentTask, GitHubPullRequestItem } from './types.ts'
import { err, ok } from './result.ts'

export interface PullRequestWatchTarget {
  repository: string
  number: number
}

interface ObservedPullRequest {
  pullRequest: GitHubPullRequestItem
  tasks: AgentTask[]
  /** Present while this pull request has a queued Task. It does not change watch completion. */
  agentStart?: AgentStartState
}

/** A closure is terminal only after an exact GitHub read confirms it. */
export type PullRequestWatchState
  = | { _tag: 'NotObserved', repository: string, number: number }
    | ObservedPullRequest & { _tag: 'Open' | 'Ready' | 'PendingClosure' | 'Merged' | 'Closed' | 'Dismissed' }
    | ObservedPullRequest & { _tag: 'ActionRequired', reason: string }

export interface PullRequestWatchOptions {
  signal?: AbortSignal
  /** `merged` keeps waiting through actionable findings. Closure and Dismissal always finish. */
  until?: 'attention' | 'merged' | 'review'
  onUpdate?: (state: PullRequestWatchState) => void
  /** Runs before each wait to reconnect after a dropped stream or a gateway error. */
  onReconnect?: (reconnect: PullRequestWatchReconnect) => void
}

export interface PullRequestWatchReconnect {
  attempt: number
  delayMilliseconds: number
  error: ControlApiError
}

/** One outage may last this long. A Service Restart or Update takes under a minute. */
const reconnectWindowMilliseconds = 180_000
/** A stream that stays connected this long ends the outage. Keepalives arrive every 15 seconds. */
const stableConnectionMilliseconds = 30_000
const reconnectDelaysMilliseconds = [1_000, 2_000, 4_000, 8_000, 15_000]
/** Caddy returns these while the Service is down. The route's own 503 means watching is not configured. */
const gatewayStatuses = new Set([502, 504])

type WatchAttempt
  = | { _tag: 'Finished', state: PullRequestWatchState }
    | { _tag: 'Cancelled' }
    | { _tag: 'Failed', error: ControlApiError }
    | { _tag: 'Dropped', error: ControlApiError, connectedMilliseconds: number }

const cancelled: ControlApiError = { _tag: 'NetworkFailure', message: 'The pull request watch was cancelled.' }

function validTask(value: unknown, repository: string, number: number): boolean {
  if (typeof value !== 'object' || value === null)
    return false
  const task = value as Record<string, unknown>
  if (typeof task.id !== 'string' || typeof task.revisionId !== 'string' || typeof task.updatedAt !== 'string'
    || task.repository !== repository || task.pullRequestNumber !== number
    || !['resolve_conflict', 'review_fix', 'baseline_repair', 'adversarial_review'].includes(String(task.kind))
    || typeof task.state !== 'object' || task.state === null) {
    return false
  }
  const state = task.state as Record<string, unknown>
  if (state._tag === 'Queued')
    return true
  if (state._tag === 'Running')
    return typeof state.workerId === 'string' && Number.isSafeInteger(state.fence) && Number(state.fence) > 0 && typeof state.leaseExpiresAt === 'string'
  if (state._tag === 'Publishing')
    return typeof state.commandId === 'string'
  if (state._tag === 'Completed')
    return typeof state.evidence === 'string'
  return ['ActionRequired', 'Failed', 'Superseded'].includes(String(state._tag)) && typeof state.reason === 'string'
}

export function parsePullRequestWatchTarget(value: unknown): Result<PullRequestWatchTarget, string> {
  if (typeof value !== 'object' || value === null)
    return err('Provide a repository and pull request number.')
  const input = value as Record<string, unknown>
  if (typeof input.repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(input.repository)
    || !Number.isSafeInteger(input.number) || Number(input.number) < 1) {
    return err('Provide a repository and positive pull request number.')
  }
  return ok({ repository: input.repository, number: Number(input.number) })
}

export function parsePullRequestWatchState(value: unknown): Result<PullRequestWatchState, string> {
  if (typeof value !== 'object' || value === null)
    return err('The service returned an invalid pull request state.')
  const input = value as Record<string, unknown>
  if (input._tag === 'NotObserved') {
    return parsePullRequestWatchTarget(input)._tag === 'Ok'
      ? ok(input as unknown as PullRequestWatchState)
      : err('The service returned an invalid pull request target.')
  }
  const pull = input.pullRequest as Partial<GitHubPullRequestItem> | undefined
  if (pull === undefined || pull === null || pull.kind !== 'pull_request'
    || parsePullRequestWatchTarget({ repository: pull.repository, number: pull.number })._tag !== 'Ok'
    || typeof pull.headSha !== 'string' || typeof pull.url !== 'string'
    || typeof pull.baseSha !== 'string' || typeof pull.headRef !== 'string' || typeof pull.headRepository !== 'string'
    || (pull.baseRef !== undefined && typeof pull.baseRef !== 'string')
    || (pull.mergeCommitSha !== undefined && pull.mergeCommitSha !== null && typeof pull.mergeCommitSha !== 'string')
    || (pull.state !== 'open' && pull.state !== 'closed')
    || (pull.mergedAt !== null && typeof pull.mergedAt !== 'string')
    || !Array.isArray(input.tasks) || !input.tasks.every(task => validTask(task, pull.repository!, pull.number!))
    || (input.agentStart !== undefined && (typeof input.agentStart !== 'object' || input.agentStart === null
      || typeof (input.agentStart as Record<string, unknown>)._tag !== 'string'
      || !['Available', 'Paused', 'RestartRequested', 'WritesDisabled', 'ReserveReached', 'CapacityUnavailable'].includes(String((input.agentStart as Record<string, unknown>)._tag))))
    || !['Open', 'Ready', 'PendingClosure', 'Merged', 'Closed', 'Dismissed', 'ActionRequired'].includes(String(input._tag))
    || (input._tag === 'ActionRequired' && typeof input.reason !== 'string')
    || ((input._tag === 'Open' || input._tag === 'Ready') && pull.state !== 'open')
    || ((input._tag === 'Dismissed' || input._tag === 'ActionRequired') && pull.state !== 'open')
    || (input._tag === 'PendingClosure' && pull.state !== 'closed')
    || (input._tag === 'Merged' && (pull.state !== 'closed' || pull.mergedAt === null))
    || (input._tag === 'Closed' && (pull.state !== 'closed' || pull.mergedAt !== null))) {
    return err('The service returned an invalid pull request state.')
  }
  return ok(input as unknown as PullRequestWatchState)
}

export function pullRequestWatchFinished(state: PullRequestWatchState, until: 'attention' | 'merged' | 'review' = 'attention'): boolean {
  return ['Merged', 'Closed', 'Dismissed'].includes(state._tag)
    || (until !== 'merged' && state._tag === 'ActionRequired')
    || (until === 'review' && state._tag === 'Ready')
}

interface WatchInput {
  url: URL
  target: PullRequestWatchTarget
  authorization: string
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  options: PullRequestWatchOptions
}

/**
 * Reads service events only. This function never contacts GitHub.
 * A dropped stream or a gateway error reconnects with backoff. Each reconnect resumes from stored state.
 */
export async function watchPullRequestStream(input: WatchInput): Promise<Result<PullRequestWatchState, ControlApiError>> {
  const seen = { previous: '' }
  let outageStartedAt: number | undefined
  let attempt = 0
  while (true) {
    const result = await watchPullRequestOnce(input, seen)
    if (result._tag === 'Finished')
      return ok(result.state)
    if (result._tag === 'Cancelled')
      return err(cancelled)
    if (result._tag === 'Failed')
      return err(result.error)
    const now = Date.now()
    if (outageStartedAt === undefined || result.connectedMilliseconds >= stableConnectionMilliseconds) {
      outageStartedAt = now
      attempt = 0
    }
    attempt++
    const delayMilliseconds = reconnectDelaysMilliseconds[Math.min(attempt, reconnectDelaysMilliseconds.length) - 1]!
    if (now + delayMilliseconds - outageStartedAt > reconnectWindowMilliseconds)
      return err({ ...result.error, message: `${result.error.message} The watch stopped reconnecting after ${reconnectWindowMilliseconds / 60_000} minutes. Run watch-pr again to resume from stored state.` })
    input.options.onReconnect?.({ attempt, delayMilliseconds, error: result.error })
    if (!await wait(delayMilliseconds, input.options.signal))
      return err(cancelled)
  }
}

function wait(milliseconds: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const abort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    if (signal?.aborted) {
      resolve(false)
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve(true)
    }, milliseconds)
  })
}

/** Reads one connection. `seen` spans reconnects, so a replayed stored state is not reported twice. */
async function watchPullRequestOnce(input: WatchInput, seen: { previous: string }): Promise<WatchAttempt> {
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let connectedAt: number | undefined
  const dropped = (message: string): WatchAttempt => ({ _tag: 'Dropped', error: { _tag: 'NetworkFailure', message }, connectedMilliseconds: connectedAt === undefined ? 0 : Date.now() - connectedAt })
  const invalid = (message: string): WatchAttempt => ({ _tag: 'Failed', error: { _tag: 'InvalidResponse', message } })
  const abort = () => {
    controller.abort()
    void reader?.cancel().catch(() => {
      // A cancelled request may already have closed its stream.
    })
  }
  input.options.signal?.addEventListener('abort', abort, { once: true })
  if (input.options.signal?.aborted)
    controller.abort()
  try {
    if (controller.signal.aborted)
      return { _tag: 'Cancelled' }
    const response = await input.fetch(input.url, {
      headers: { authorization: input.authorization, accept: 'text/event-stream' },
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = await response.json().catch(() => {
        // Non-JSON proxy errors retain their HTTP status below.
        return undefined
      }) as { message?: unknown } | undefined
      const error: ControlApiError = { _tag: 'HttpFailure', status: response.status, message: typeof body?.message === 'string' ? body.message : `The service returned HTTP ${response.status}.` }
      return gatewayStatuses.has(response.status) ? { _tag: 'Dropped', error, connectedMilliseconds: 0 } : { _tag: 'Failed', error }
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream') || response.body === null)
      return invalid('The service did not return a pull request event stream.')
    reader = response.body.getReader()
    connectedAt = Date.now()
    const decoder = new TextDecoder()
    let buffer = ''
    let event = ''
    let data: string[] = []
    while (!controller.signal.aborted) {
      const chunk = await reader.read()
      if (controller.signal.aborted)
        return { _tag: 'Cancelled' }
      if (chunk.done)
        return dropped('The watch disconnected.')
      buffer += decoder.decode(chunk.value, { stream: true })
      if (buffer.length + data.join('\n').length > 1_000_000)
        return invalid('The pull request event exceeded one megabyte.')
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line === '') {
          if (event === 'pull-request' && data.length > 0) {
            const json = data.join('\n')
            const value = await Promise.resolve().then(() => JSON.parse(json) as unknown).then(value => ok(value), () => err('The service returned invalid event JSON.'))
            if (value._tag === 'Err')
              return invalid(value.error)
            const state = parsePullRequestWatchState(value.value)
            if (state._tag === 'Err')
              return invalid(state.error)
            const target = state.value._tag === 'NotObserved' ? state.value : state.value.pullRequest
            if (target.repository.toLowerCase() !== input.target.repository.toLowerCase() || target.number !== input.target.number)
              return invalid('The service returned another pull request.')
            if (json !== seen.previous) {
              input.options.onUpdate?.(state.value)
              seen.previous = json
            }
            if (pullRequestWatchFinished(state.value, input.options.until))
              return { _tag: 'Finished', state: state.value }
          }
          event = ''
          data = []
        }
        else if (line.startsWith('event:')) {
          event = line.slice(6).trimStart()
        }
        else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''))
        }
        newline = buffer.indexOf('\n')
      }
    }
    return { _tag: 'Cancelled' }
  }
  catch (error) {
    if (controller.signal.aborted)
      return { _tag: 'Cancelled' }
    return dropped(error instanceof Error ? error.message : 'The pull request event stream failed.')
  }
  finally {
    controller.abort()
    input.options.signal?.removeEventListener('abort', abort)
    await reader?.cancel().catch(() => {
      // The request is already aborted. A closed stream needs no further cleanup.
    })
  }
}
