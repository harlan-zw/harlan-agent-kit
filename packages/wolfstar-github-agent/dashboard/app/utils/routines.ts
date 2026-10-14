import type { DashboardRoutineRun, DashboardSnapshot, Routine } from '../../../src/types.ts'
import { hasSpendableCapacity, selectedModelCapacity } from '../../../src/capacity.ts'
import { parseCron } from '../../../src/routine-schedule.ts'
import { routineRunPresentation, routineTrackingUrl, scheduledRoutineRecords } from './dashboard.ts'
import { nextRoutineInstant } from './system.ts'

/**
 * Presentation logic for the Routines page. Pure and unit tested, so the page
 * holds layout only.
 */

export interface RoutineRow {
  routine: Routine
  latestRun: DashboardRoutineRun | undefined
  resultRun: DashboardRoutineRun | undefined
  resultLabel: string
  resultTone: 'success' | 'warning' | 'error' | 'neutral'
  resultDetail: string | undefined
  /** The next instant this Routine answers, or null when disabled or outside the horizon. */
  next: string | null
  schedule: string
  label: string
  tone: 'success' | 'warning' | 'error' | 'neutral'
  detail: string | undefined
  trackingUrl: string | undefined
}

const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function dayList(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b)
  if (sorted.join(',') === '1,2,3,4,5') return 'Weekdays'
  if (sorted.join(',') === '0,6') return 'Weekends'
  return sorted.map((day) => dayNames[day] ?? String(day)).join(', ')
}

/**
 * One cron expression as a sentence: `Daily at 07:00`, `Weekdays at 09:30`.
 * Anything the sentence cannot say stays as the expression, because a wrong
 * paraphrase of a schedule is worse than the schedule.
 */
export function describeCron(text: string): string {
  const parsed = parseCron(text)
  if (parsed._tag !== 'Ok') return text
  const { minutes, hours, daysOfMonth, months, daysOfWeek } = parsed.value
  if (months.size !== 12 || daysOfMonth.size !== 31 || hours.size > 4 || minutes.size !== 1) return text
  const minute = [...minutes][0]!
  const times = [...hours]
    .sort((a, b) => a - b)
    .map((hour) => clock(hour, minute))
    .join(' and ')
  if (daysOfWeek.size === 7) return `Daily at ${times}`
  return `${dayList([...daysOfWeek])} at ${times}`
}

export function routineSchedule(routine: Pick<Routine, 'crons' | 'timeZone'>): string {
  return `${routine.crons.map(describeCron).join('; ')} ${routine.timeZone}`
}

/**
 * Every Routine, soonest first. Disabled Routines and ones outside the horizon
 * sort last, so the top of the page is always the next check.
 */
export function routineRows(
  routines: readonly Routine[],
  runs: readonly DashboardRoutineRun[],
  now: Date,
): RoutineRow[] {
  return scheduledRoutineRecords(routines, runs)
    .map((record) => {
      const presentation = routineRunPresentation(record.latestRun)
      const result = routineRunPresentation(record.resultRun)
      return {
        ...record,
        resultLabel: result.label,
        resultTone: result.tone === 'primary' ? ('neutral' as const) : result.tone,
        resultDetail:
          record.resultRun?.state._tag === 'Completed' && record.resultRun.report?.verdict?.coverage !== 'incomplete'
            ? undefined
            : result.detail,
        next: nextRoutineInstant(record.routine, now)?.toISOString() ?? null,
        schedule: routineSchedule(record.routine),
        label: presentation.label,
        tone: presentation.tone === 'primary' ? ('neutral' as const) : presentation.tone,
        detail:
          record.latestRun?.state._tag === 'Completed' && record.latestRun.report?.verdict?.coverage !== 'incomplete'
            ? undefined
            : presentation.detail,
        trackingUrl: routineTrackingUrl(record.routine),
      }
    })
    .sort((left, right) => {
      if (left.next === null || right.next === null)
        return left.next === right.next ? left.routine.id.localeCompare(right.routine.id) : left.next === null ? 1 : -1
      return left.next.localeCompare(right.next)
    })
}

/**
 * The run's evidence as one line. The stored text opens by naming the Routine
 * and repository the row already shows, so that prefix goes, and the pipe
 * separators become middots so the counts read as a list, not a log.
 */
export function routineRunDetail(
  run: Pick<DashboardRoutineRun, 'name' | 'repository' | 'state' | 'progress'>,
): string | undefined {
  const detail = routineRunPresentation(run as DashboardRoutineRun).detail
  if (detail === undefined) return undefined
  const prefix = `${run.name} on ${run.repository}`
  const trimmed = detail.startsWith(prefix) ? detail.slice(prefix.length).replace(/^\s*\|\s*/, '') : detail
  return trimmed
    .split(/\s*\|\s*/)
    .filter((part) => part.length > 0)
    .join(' · ')
}

/** The newest runs across every Routine, for the log below the schedule. */
export function recentRoutineRuns(runs: readonly DashboardRoutineRun[], limit = 20): DashboardRoutineRun[] {
  return [...runs].sort((left, right) => right.scheduledFor.localeCompare(left.scheduledFor)).slice(0, limit)
}

export interface RoutineFilters {
  repository: string
  routine: string
  result: string
}

function identityMatches(record: { repository: string; name: string }, filters: RoutineFilters): boolean {
  return (
    (filters.repository === 'all' || record.repository === filters.repository) &&
    (filters.routine === 'all' || record.name === filters.routine)
  )
}

export function filterRoutineRows(rows: readonly RoutineRow[], filters: RoutineFilters): RoutineRow[] {
  return rows.filter(
    (row) =>
      identityMatches(row.routine, filters) &&
      (filters.result === 'all' || row.label === filters.result || row.resultLabel === filters.result),
  )
}

export function filterRoutineRuns(
  runs: readonly DashboardRoutineRun[],
  filters: RoutineFilters,
): DashboardRoutineRun[] {
  return runs.filter(
    (run) =>
      identityMatches(run, filters) &&
      (filters.result === 'all' || routineRunPresentation(run).label === filters.result),
  )
}

export interface RoutineQueueBlock {
  provider: string
  model: string
  reason: string
  retryAt: string | undefined
  count: number
}

/** Each queued run names its own provider, including a manual choice. */
export function routineQueueBlocks(
  snapshot: DashboardSnapshot,
  runs: readonly DashboardRoutineRun[],
  now: Date,
): RoutineQueueBlock[] {
  const groups = new Map<string, RoutineQueueBlock>()
  for (const run of runs) {
    if (run.state._tag !== 'Queued') continue
    const provider = run.agentSelection?.provider ?? snapshot.agentProfile.provider
    const model = run.agentSelection?.model ?? snapshot.agentProfile.roles.routine_scan.model
    const capacity = selectedModelCapacity(snapshot, provider, model)
    const reserve = snapshot.providerCapacities.find((entry) => entry.provider === provider)?.reservePercent ?? 0
    const circuit = snapshot.providerCircuits
      .filter(
        (entry) =>
          entry.provider === provider &&
          (entry.model === model ||
            (entry.failureClass === 'usage_limit' &&
              entry.model.slice(0, entry.model.indexOf('/') + 1) === model.slice(0, model.indexOf('/') + 1))) &&
          entry.state._tag !== 'Closed',
      )
      .find(
        (entry) =>
          (entry.state._tag === 'Open' && Date.parse(entry.state.retryAt) > now.getTime()) ||
          (entry.state._tag === 'HalfOpen' && Date.parse(entry.state.leaseExpiresAt) > now.getTime()),
      )
    let reason: string | undefined
    let retryAt: string | undefined
    if (snapshot.agentControl._tag === 'Paused') {
      reason = 'Paused'
    } else if (!snapshot.mutationsEnabled) {
      reason = 'Writes off'
    } else if (snapshot.agentStart._tag === 'RestartRequested') {
      reason = 'Restarting after current work'
    } else if (!hasSpendableCapacity(capacity, reserve)) {
      reason =
        capacity._tag === 'Unavailable'
          ? capacity.reason
          : capacity._tag === 'Available' && capacity.usedPercent >= 100
            ? 'Usage limit reached.'
            : 'Reserve reached.'
      retryAt = capacity._tag === 'Available' && capacity.resetsAt !== '' ? capacity.resetsAt : undefined
    } else if (circuit !== undefined) {
      reason = circuit.lastDetail
      retryAt =
        circuit.state._tag === 'Open'
          ? circuit.state.retryAt
          : circuit.state._tag === 'HalfOpen'
            ? circuit.state.leaseExpiresAt
            : undefined
    }
    if (reason === undefined) continue
    const key = `${provider}:${model}:${reason}`
    const current = groups.get(key)
    groups.set(key, { provider, model, reason, retryAt, count: (current?.count ?? 0) + 1 })
  }
  return [...groups.values()]
}
