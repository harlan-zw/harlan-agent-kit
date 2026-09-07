import type { DashboardRoutineRun, Routine } from '../../../src/types.ts'
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
  if (sorted.join(',') === '1,2,3,4,5')
    return 'Weekdays'
  if (sorted.join(',') === '0,6')
    return 'Weekends'
  return sorted.map(day => dayNames[day] ?? String(day)).join(', ')
}

/**
 * One cron expression as a sentence: `Daily at 07:00`, `Weekdays at 09:30`.
 * Anything the sentence cannot say stays as the expression, because a wrong
 * paraphrase of a schedule is worse than the schedule.
 */
export function describeCron(text: string): string {
  const parsed = parseCron(text)
  if (parsed._tag !== 'Ok')
    return text
  const { minutes, hours, daysOfMonth, months, daysOfWeek } = parsed.value
  if (months.size !== 12 || daysOfMonth.size !== 31 || hours.size > 4 || minutes.size !== 1)
    return text
  const minute = [...minutes][0]!
  const times = [...hours].sort((a, b) => a - b).map(hour => clock(hour, minute)).join(' and ')
  if (daysOfWeek.size === 7)
    return `Daily at ${times}`
  return `${dayList([...daysOfWeek])} at ${times}`
}

export function routineSchedule(routine: Pick<Routine, 'crons' | 'timeZone'>): string {
  return `${routine.crons.map(describeCron).join('; ')} ${routine.timeZone}`
}

/**
 * Every Routine, soonest first. Disabled Routines and ones outside the horizon
 * sort last, so the top of the page is always the next check.
 */
export function routineRows(routines: readonly Routine[], runs: readonly DashboardRoutineRun[], now: Date): RoutineRow[] {
  return scheduledRoutineRecords(routines, runs)
    .map((record) => {
      const presentation = routineRunPresentation(record.latestRun)
      return {
        ...record,
        next: nextRoutineInstant(record.routine, now)?.toISOString() ?? null,
        schedule: routineSchedule(record.routine),
        label: presentation.label,
        tone: presentation.tone === 'primary' ? 'neutral' as const : presentation.tone,
        detail: presentation.detail,
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
export function routineRunDetail(run: Pick<DashboardRoutineRun, 'name' | 'repository' | 'state' | 'progress'>): string | undefined {
  const detail = routineRunPresentation(run as DashboardRoutineRun).detail
  if (detail === undefined)
    return undefined
  const prefix = `${run.name} on ${run.repository}`
  const trimmed = detail.startsWith(prefix) ? detail.slice(prefix.length).replace(/^\s*\|\s*/, '') : detail
  return trimmed.split(/\s*\|\s*/).filter(part => part.length > 0).join(' · ')
}

/** The newest runs across every Routine, for the log below the schedule. */
export function recentRoutineRuns(runs: readonly DashboardRoutineRun[], limit = 20): DashboardRoutineRun[] {
  return [...runs].sort((left, right) => right.scheduledFor.localeCompare(left.scheduledFor)).slice(0, limit)
}
