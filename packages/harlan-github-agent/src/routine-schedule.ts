import type { Result } from './result.ts'
import { err, ok } from './result.ts'

/**
 * One parsed five-field cron expression.
 *
 * Each field holds the exact values it matches, so matching is a set test and
 * never re-parses. GitHub Actions uses the same five fields, and the spec
 * copies its `on.schedule[].cron` key, so this parser answers the same
 * expressions a workflow would.
 */
export interface CronExpression {
  minutes: ReadonlySet<number>
  hours: ReadonlySet<number>
  daysOfMonth: ReadonlySet<number>
  months: ReadonlySet<number>
  daysOfWeek: ReadonlySet<number>
  /** True when both day fields are restricted, which cron matches as an OR. */
  restrictsBothDayFields: boolean
}

interface FieldRange {
  min: number
  max: number
  name: string
}

const FIELDS: readonly FieldRange[] = [
  { min: 0, max: 59, name: 'minute' },
  { min: 0, max: 23, name: 'hour' },
  { min: 1, max: 31, name: 'day of month' },
  { min: 1, max: 12, name: 'month' },
  { min: 0, max: 7, name: 'day of week' },
]

function parseField(text: string, range: FieldRange): Result<Set<number>, string> {
  const values = new Set<number>()
  for (const part of text.split(',')) {
    if (part === '')
      return err(`Write a value for every ${range.name} in the cron expression.`)
    const [spec, stepText, ...extra] = part.split('/')
    if (extra.length > 0 || spec === undefined)
      return err(`Write one step for each ${range.name} in the cron expression.`)
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1)
      return err(`Write a whole step above zero for the ${range.name}.`)

    let low: number
    let high: number
    if (spec === '*') {
      low = range.min
      high = range.max
    }
    else {
      const [lowText, highText, ...rest] = spec.split('-')
      if (rest.length > 0)
        return err(`Write one range for the ${range.name}.`)
      low = Number(lowText)
      high = highText === undefined ? (stepText === undefined ? low : range.max) : Number(highText)
      if (!Number.isInteger(low) || !Number.isInteger(high))
        return err(`Write whole numbers for the ${range.name}.`)
      if (low < range.min || high > range.max || low > high)
        return err(`Write a ${range.name} from ${range.min} to ${range.max}.`)
    }
    for (let value = low; value <= high; value += step)
      values.add(value)
  }
  return ok(values)
}

/**
 * Parses one five-field cron expression.
 *
 * Cron writes Sunday as both 0 and 7. Both fold to 0 here, so a match never has
 * to remember which spelling the expression used.
 */
export function parseCron(text: string): Result<CronExpression, string> {
  const parts = text.trim().split(/\s+/)
  if (parts.length !== 5)
    return err('Write five cron fields: minute, hour, day of month, month, and day of week.')

  const parsed: Array<Set<number>> = []
  for (const [index, part] of parts.entries()) {
    const range = FIELDS[index]
    if (range === undefined)
      return err('Write five cron fields: minute, hour, day of month, month, and day of week.')
    const field = parseField(part, range)
    if (field._tag === 'Err')
      return field
    parsed.push(field.value)
  }

  const [minutes, hours, daysOfMonth, months, rawDaysOfWeek] = parsed as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]
  const daysOfWeek = new Set([...rawDaysOfWeek].map(day => day === 7 ? 0 : day))
  return ok({
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    restrictsBothDayFields: parts[2] !== '*' && parts[4] !== '*',
  })
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

/** Reads one instant as wall-clock parts in the Routine's own time zone. */
export function wallClockParts(at: Date, timeZone: string): {
  minute: number
  hour: number
  dayOfMonth: number
  month: number
  dayOfWeek: number
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  })
  const parts = new Map(formatter.formatToParts(at).map(part => [part.type, part.value]))
  // `hour12: false` still answers midnight as 24 in some runtimes, so fold it.
  const hour = Number(parts.get('hour')) % 24
  return {
    minute: Number(parts.get('minute')),
    hour,
    dayOfMonth: Number(parts.get('day')),
    month: Number(parts.get('month')),
    dayOfWeek: WEEKDAY_INDEX[parts.get('weekday') ?? 'Sun'] ?? 0,
  }
}

/** Whether one instant matches the expression, read in the Routine's time zone. */
export function matchesCron(expression: CronExpression, at: Date, timeZone: string): boolean {
  const parts = wallClockParts(at, timeZone)
  if (!expression.minutes.has(parts.minute) || !expression.hours.has(parts.hour) || !expression.months.has(parts.month))
    return false
  const dayOfMonth = expression.daysOfMonth.has(parts.dayOfMonth)
  const dayOfWeek = expression.daysOfWeek.has(parts.dayOfWeek)
  // Standard cron matches either day field when both are restricted.
  return expression.restrictsBothDayFields ? dayOfMonth || dayOfWeek : dayOfMonth && dayOfWeek
}

/**
 * How far back a missed instant may still run.
 *
 * A machine that slept through the night wakes with several instants behind it.
 * Six hours runs this morning's check-in and drops the ones from days ago,
 * which is what a person would do on opening the laptop.
 */
export const DEFAULT_CATCH_UP_MINUTES = 6 * 60

/**
 * How far back the search looks to name a missed instant.
 *
 * Eight days covers a weekly Routine, so even the sparsest schedule reports the
 * run it did not get rather than going quiet.
 */
export const DEFAULT_MISSED_HORIZON_MINUTES = 8 * 24 * 60

const MINUTE = 60_000

export type DueRoutine
  = | { _tag: 'NotDue' }
    | { _tag: 'Due', scheduledFor: Date }
    | { _tag: 'Missed', scheduledFor: Date, reason: string }

export interface DueRoutineInput {
  catchUpMinutes?: number
  expression: CronExpression
  /** When this Routine last ran, or null when it never has. */
  lastRunAt: Date | null
  /** How far back to look when naming a missed instant. */
  missedHorizonMinutes?: number
  now: Date
  timeZone: string
}

/**
 * Decides whether one Routine owes a run right now.
 *
 * The search walks back one minute at a time from now, bounded by the catch-up
 * window, and stops at the first matching instant. That answers with the newest
 * missed instant and never with a queue of them, so a machine that slept for
 * two days runs each Routine once and not ninety-six times.
 *
 * `Missed` names an instant that matched but fell outside the window. The
 * caller records it, so a check-in that did not happen is visible rather than
 * silently absent.
 */
export function dueRoutine(input: DueRoutineInput): DueRoutine {
  const catchUpMinutes = input.catchUpMinutes ?? DEFAULT_CATCH_UP_MINUTES
  // Seconds inside the current minute would make the first step skip an instant
  // that has only just matched, so the walk starts on a minute boundary.
  const start = Math.floor(input.now.getTime() / MINUTE) * MINUTE

  for (let step = 0; step <= catchUpMinutes; step += 1) {
    const candidate = new Date(start - step * MINUTE)
    if (!matchesCron(input.expression, candidate, input.timeZone))
      continue
    if (input.lastRunAt !== null && candidate.getTime() <= input.lastRunAt.getTime())
      return { _tag: 'NotDue' }
    return { _tag: 'Due', scheduledFor: candidate }
  }

  // Nothing matched inside the window. Look back far enough to name the missed
  // instant, so a check-in that did not happen is recorded and not lost.
  //
  // This walk is long, and it runs at most once per missed instant: recording
  // the skip moves `lastRunAt` forward, so the next tick answers `NotDue` from
  // the short walk above.
  for (let step = catchUpMinutes + 1; step <= (input.missedHorizonMinutes ?? DEFAULT_MISSED_HORIZON_MINUTES); step += 1) {
    const candidate = new Date(start - step * MINUTE)
    if (!matchesCron(input.expression, candidate, input.timeZone))
      continue
    if (input.lastRunAt !== null && candidate.getTime() <= input.lastRunAt.getTime())
      return { _tag: 'NotDue' }
    return {
      _tag: 'Missed',
      scheduledFor: candidate,
      reason: `This run was due more than ${Math.round(catchUpMinutes / 60)} hours ago, so it was skipped.`,
    }
  }
  return { _tag: 'NotDue' }
}
