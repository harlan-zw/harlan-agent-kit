import type { AgentEvent } from './agent-provider.ts'
import type { DesktopReport } from './desktop-broker.ts'
import type { DesktopWorktree } from './desktop-worktree.ts'
import { parseRunnerJobs } from './runner-jobs.ts'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseDesktopReport(value: unknown): DesktopReport {
  if (!record(value) || !['memoryGiB', 'reservedGiB', 'agents', 'actions'].every(key => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
    || Number(value.memoryGiB) < 1 || Number(value.memoryGiB) > 256) {
    throw new Error('Desktop memory and activity must be whole numbers.')
  }
  const jobs = record(value.jobs) && value.jobs._tag === 'Available' && Array.isArray(value.jobs.jobs)
    ? parseRunnerJobs({ updatedAt: 0, runners: value.jobs.jobs.map(job => record(job) ? { activity: 'Running', name: job.runner, repository: job.repository, job } : job) }, 0)
    : { _tag: 'Unavailable' as const }
  return { memoryGiB: Number(value.memoryGiB), reservedGiB: Number(value.reservedGiB), agents: Number(value.agents), actions: Number(value.actions), jobs }
}

export function parseDesktopMemory(value: unknown): number {
  if (!record(value) || !Number.isSafeInteger(value.memoryGiB) || Number(value.memoryGiB) < 1 || Number(value.memoryGiB) > 256)
    throw new Error('Desktop memory must be between 1 and 256 GiB.')
  return Number(value.memoryGiB)
}

export function parseDesktopWorktree(value: unknown): DesktopWorktree {
  if (!record(value) || typeof value.head !== 'string' || !/^[a-f0-9]{40,64}$/.test(value.head)
    || typeof value.origin !== 'string' || !/^(?:https:\/\/github.com\/|git@github.com:)[\w.-]+\/[\w.-]+$/.test(value.origin)
    || typeof value.bundle !== 'string' || typeof value.patch !== 'string' || !Array.isArray(value.files)
    || value.files.length > 50_000 || value.bundle.length > 256 * 1024 ** 2 || value.patch.length > 64 * 1024 ** 2) {
    throw new Error('Desktop Worktree data is invalid.')
  }
  const files = value.files.map((file) => {
    if (!record(file) || typeof file.path !== 'string' || typeof file.data !== 'string' || file.data.length > 64 * 1024 ** 2 || !Number.isInteger(file.mode) || Number(file.mode) < 0 || Number(file.mode) > 0o777)
      throw new Error('Desktop file data is invalid.')
    return { path: file.path, data: file.data, mode: Number(file.mode) }
  })
  return { head: value.head, origin: value.origin, bundle: value.bundle, patch: value.patch, files }
}

/** The desktop forwards only provider messages and session identity across the boundary. */
export function parseDesktopEvents(value: unknown): AgentEvent[] {
  if (!Array.isArray(value) || value.length > 1000)
    throw new Error('Desktop events must be a bounded list.')
  return value.map((event): AgentEvent => {
    if (!record(event))
      throw new Error('Desktop event is invalid.')
    if (event._tag === 'SessionStarted' && typeof event.sessionId === 'string')
      return { _tag: 'SessionStarted', sessionId: event.sessionId }
    if (event._tag === 'Message' && typeof event.text === 'string')
      return { _tag: 'Message', text: event.text }
    if (event._tag === 'Failed' && typeof event.reason === 'string')
      return { _tag: 'Failed', reason: event.reason }
    if (event._tag === 'Progress' && typeof event.text === 'string' && Number.isFinite(event.percent) && Number(event.percent) >= 0 && Number(event.percent) <= 100)
      return { _tag: 'Progress', text: event.text, percent: Number(event.percent) }
    if (event._tag === 'CommandStarted' && typeof event.command === 'string')
      return { _tag: 'CommandStarted', command: event.command }
    if (event._tag === 'CommandCompleted' && typeof event.command === 'string' && typeof event.output === 'string' && (event.exitCode === null || Number.isSafeInteger(event.exitCode)))
      return { _tag: 'CommandCompleted', command: event.command, output: event.output, exitCode: event.exitCode === null ? null : Number(event.exitCode) }
    if (event._tag === 'Reasoning' && typeof event.text === 'string')
      return { _tag: 'Reasoning', text: event.text }
    if (event._tag === 'FileChanged' && Array.isArray(event.changes)) {
      const changes = event.changes.map((change): { path: string, kind: 'add' | 'delete' | 'update' } => {
        if (!record(change) || typeof change.path !== 'string' || (change.kind !== 'add' && change.kind !== 'delete' && change.kind !== 'update'))
          throw new Error('Desktop file event is invalid.')
        return { path: change.path, kind: change.kind }
      })
      return { _tag: 'FileChanged', changes }
    }
    if (event._tag === 'WebSearch' || event._tag === 'TurnCompleted')
      return { _tag: event._tag }
    if (event._tag === 'ContextBudgetExhausted' && Number.isFinite(event.cachedTokensRead) && Number(event.cachedTokensRead) >= 0)
      return { _tag: 'ContextBudgetExhausted', cachedTokensRead: Number(event.cachedTokensRead) }
    if (event._tag === 'Usage' && record(event.usage) && event.usage._tag === 'Available') {
      const usage = event.usage
      if (['input', 'cachedInput', 'cacheWrite', 'output', 'reasoning'].every(key => Number.isFinite(usage[key]) && Number(usage[key]) >= 0))
        return { _tag: 'Usage', usage: { _tag: 'Available', input: Number(usage.input), cachedInput: Number(usage.cachedInput), cacheWrite: Number(usage.cacheWrite), output: Number(usage.output), reasoning: Number(usage.reasoning) } }
    }
    throw new Error('Desktop event is unsupported.')
  })
}

/** Decode controller responses before consumers handle an empty Queue. */
export async function readDesktopResponse(response: Response): Promise<unknown> {
  const body = await response.text()
  return body === '' ? null : JSON.parse(body)
}
