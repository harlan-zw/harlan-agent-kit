import type { AgentEvent } from './agent-provider.ts'
import type { DesktopReport } from './desktop-broker.ts'
import type { DesktopHistory, DesktopWorktree } from './desktop-worktree.ts'
import { DESKTOP_WORKTREE_LIMITS, desktopWorktreeRefusal } from './desktop-worktree.ts'
import { parseRunnerJobs } from './runner-jobs.ts'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The shape of one desktop turn, as both hosts must agree on it.
 *
 * Hogwild and the desktop deploy from their own checkouts, so one can move
 * without the other. Raise this whenever the turn or report shape changes, and
 * a desktop on the older revision is stood down instead of being sent a turn it
 * cannot read.
 *
 * 1: the original whole-history payload.
 * 2: tagged `DesktopHistory`, which carries only what the receiver lacks.
 */
export const DESKTOP_PROTOCOL = 2

/**
 * Memory one desktop Agent reserves through `harlan-desktop-capacity`.
 *
 * The controller and the desktop client both count in this unit, so a turn the
 * controller sends always has memory waiting for it.
 */
export const DESKTOP_MEMORY_PER_AGENT_GIB = 8

/**
 * The most Agent slots the desktop may be set to.
 *
 * The desktop shares its memory with GitHub Actions and with Harlan. Two
 * Agents already commit 16 GiB, so a higher ceiling would promise memory the
 * desktop cannot hold.
 */
export const DESKTOP_AGENT_SLOT_CEILING = 2

export function parseDesktopReport(value: unknown): DesktopReport {
  if (!record(value) || !['memoryGiB', 'reservedGiB', 'agents', 'actions'].every(key => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
    || Number(value.memoryGiB) < 1 || Number(value.memoryGiB) > 256) {
    throw new Error('Desktop memory and activity must be whole numbers.')
  }
  // A desktop that names no protocol predates this field, so it cannot be one
  // this controller may send a turn to.
  const protocol = Number.isSafeInteger(value.protocol) ? Number(value.protocol) : 1
  const jobs = record(value.jobs) && value.jobs._tag === 'Available' && Array.isArray(value.jobs.jobs)
    ? parseRunnerJobs({ updatedAt: 0, runners: value.jobs.jobs.map(job => record(job) ? { activity: 'Running', name: job.runner, repository: job.repository, job } : job) }, 0)
    : { _tag: 'Unavailable' as const }
  return { protocol, memoryGiB: Number(value.memoryGiB), reservedGiB: Number(value.reservedGiB), agents: Number(value.agents), actions: Number(value.actions), jobs }
}

export function parseDesktopMemory(value: unknown): number {
  if (!record(value) || !Number.isSafeInteger(value.memoryGiB) || Number(value.memoryGiB) < 1 || Number(value.memoryGiB) > 256)
    throw new Error('Desktop memory must be between 1 and 256 GiB.')
  return Number(value.memoryGiB)
}

/** A turn carries only what the receiver cannot reach, so the shape says which. */
function parseDesktopHistory(value: unknown): DesktopHistory {
  if (record(value) && value._tag === 'Held')
    return { _tag: 'Held' }
  if (record(value) && (value._tag === 'Incremental' || value._tag === 'Whole') && typeof value.bundle === 'string')
    return { _tag: value._tag, bundle: value.bundle }
  throw new Error('The desktop Worktree history is invalid.')
}

/**
 * Reads one Worktree the other host sent.
 *
 * Every refusal names the part that failed. One message covered eight
 * conditions before, so a repository too large to offload and a corrupt
 * payload read the same, and the cause took a bundle measurement to find.
 */
export function parseDesktopWorktree(value: unknown): DesktopWorktree {
  if (!record(value) || typeof value.head !== 'string' || !/^[a-f0-9]{40,64}$/.test(value.head))
    throw new Error('The desktop Worktree head commit is invalid.')
  if (typeof value.origin !== 'string' || !/^(?:https:\/\/github.com\/|git@github.com:)[\w.-]+\/[\w.-]+$/.test(value.origin))
    throw new Error('The desktop Worktree origin is not a GitHub repository.')
  if (typeof value.patch !== 'string' || !Array.isArray(value.files))
    throw new Error('Desktop Worktree data is invalid.')
  const history = parseDesktopHistory(value.history)
  const files = value.files.map((file) => {
    if (!record(file) || typeof file.path !== 'string' || typeof file.data !== 'string' || file.data.length > DESKTOP_WORKTREE_LIMITS.file || !Number.isInteger(file.mode) || Number(file.mode) < 0 || Number(file.mode) > 0o777)
      throw new Error('Desktop file data is invalid.')
    return { path: file.path, data: file.data, mode: Number(file.mode) }
  })
  const worktree = { head: value.head, origin: value.origin, history, patch: value.patch, files }
  const refusal = desktopWorktreeRefusal(worktree)
  if (refusal !== null)
    throw new Error(`The desktop cannot run a turn for ${worktree.origin}. ${refusal}`, { cause: 'desktop-unsupported' })
  return worktree
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
