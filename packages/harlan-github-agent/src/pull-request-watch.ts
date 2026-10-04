import type { ControlApiError } from './control-client.ts'
import type { Result } from './result.ts'
import type { AgentTask, GitHubPullRequestItem } from './types.ts'
import { err, ok } from './result.ts'

export interface PullRequestWatchTarget {
  repository: string
  number: number
}

interface ObservedPullRequest {
  pullRequest: GitHubPullRequestItem
  tasks: AgentTask[]
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
}

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

/** Reads service events only. This function never contacts GitHub. */
export async function watchPullRequestStream(input: {
  url: URL
  target: PullRequestWatchTarget
  authorization: string
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
  options: PullRequestWatchOptions
}): Promise<Result<PullRequestWatchState, ControlApiError>> {
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
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
      return err({ _tag: 'NetworkFailure', message: 'The pull request watch was cancelled.' })
    const response = await input.fetch(input.url, {
      headers: { authorization: input.authorization, accept: 'text/event-stream' },
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = await response.json().catch(() => {
        // Non-JSON proxy errors retain their HTTP status below.
        return undefined
      }) as { message?: unknown } | undefined
      return err({ _tag: 'HttpFailure', status: response.status, message: typeof body?.message === 'string' ? body.message : `The service returned HTTP ${response.status}.` })
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream') || response.body === null)
      return err({ _tag: 'InvalidResponse', message: 'The service did not return a pull request event stream.' })
    reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let event = ''
    let data: string[] = []
    let previous = ''
    while (!controller.signal.aborted) {
      const chunk = await reader.read()
      if (controller.signal.aborted)
        return err({ _tag: 'NetworkFailure', message: 'The pull request watch was cancelled.' })
      if (chunk.done)
        return err({ _tag: 'NetworkFailure', message: 'The watch disconnected. Run watch-pr again to resume from stored state.' })
      buffer += decoder.decode(chunk.value, { stream: true })
      if (buffer.length + data.join('\n').length > 1_000_000)
        return err({ _tag: 'InvalidResponse', message: 'The pull request event exceeded one megabyte.' })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line === '') {
          if (event === 'pull-request' && data.length > 0) {
            const json = data.join('\n')
            const value = await Promise.resolve().then(() => JSON.parse(json) as unknown).then(value => ok(value), () => err('The service returned invalid event JSON.'))
            if (value._tag === 'Err')
              return err({ _tag: 'InvalidResponse', message: value.error })
            const state = parsePullRequestWatchState(value.value)
            if (state._tag === 'Err')
              return err({ _tag: 'InvalidResponse', message: state.error })
            const target = state.value._tag === 'NotObserved' ? state.value : state.value.pullRequest
            if (target.repository.toLowerCase() !== input.target.repository.toLowerCase() || target.number !== input.target.number)
              return err({ _tag: 'InvalidResponse', message: 'The service returned another pull request.' })
            if (json !== previous) {
              input.options.onUpdate?.(state.value)
              previous = json
            }
            if (pullRequestWatchFinished(state.value, input.options.until))
              return state
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
    return err({ _tag: 'NetworkFailure', message: 'The pull request watch was cancelled.' })
  }
  catch (error) {
    return err({ _tag: 'NetworkFailure', message: controller.signal.aborted
      ? 'The pull request watch was cancelled.'
      : error instanceof Error ? error.message : 'The pull request event stream failed.' })
  }
  finally {
    controller.abort()
    input.options.signal?.removeEventListener('abort', abort)
    await reader?.cancel().catch(() => {
      // The request is already aborted. A closed stream needs no further cleanup.
    })
  }
}
