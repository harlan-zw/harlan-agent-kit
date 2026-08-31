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
  year: number
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
    year: Number(parts.get('year')),
    minute: Number(parts.get('minute')),
    hour,
    dayOfMonth: Number(parts.get('day')),
    month: Number(parts.get('month')),
    dayOfWeek: WEEKDAY_INDEX[parts.get('weekday') ?? 'Sun'] ?? 0,
  }
}

function matchesCronDate(expression: CronExpression, parts: ReturnType<typeof wallClockParts>): boolean {
  if (!expression.months.has(parts.month))
    return false
  const dayOfMonth = expression.daysOfMonth.has(parts.dayOfMonth)
  const dayOfWeek = expression.daysOfWeek.has(parts.dayOfWeek)
  return expression.restrictsBothDayFields ? dayOfMonth || dayOfWeek : dayOfMonth && dayOfWeek
}

/** Whether one instant matches the expression, read in the Routine's time zone. */
export function matchesCron(expression: CronExpression, at: Date, timeZone: string): boolean {
  const parts = wallClockParts(at, timeZone)
  if (!expression.minutes.has(parts.minute) || !expression.hours.has(parts.hour))
    return false
  // Standard cron matches either day field when both are restricted.
  return matchesCronDate(expression, parts)
}

/**
 * How far back a missed instant may still run.
 *
 * A machine that slept through the night wakes with several instants behind it.
 * Six hours runs this morning's check-in and drops the ones from days ago,
 * which is what a person would do on opening the laptop.
 */
export const DEFAULT_CATCH_UP_MINUTES = 6 * 60

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
// A five-field cron has no year. Its longest valid calendar gap is the eight
// years between leap days around a non-leap century year.
const MAXIMUM_CRON_GAP_DAYS = 8 * 366

export type DueRoutine
  = | { _tag: 'NotDue' }
    | { _tag: 'Due', scheduledFor: Date }
    | { _tag: 'Missed', scheduledFor: Date, reason: string }

export interface DueRoutineInput {
  catchUpMinutes?: number
  expression: CronExpression
  /** When this Routine last ran, or null when it never has. */
  lastRunAt: Date | null
  now: Date
  timeZone: string
}

function sameWallClockDate(left: ReturnType<typeof wallClockParts>, right: ReturnType<typeof wallClockParts>): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.dayOfMonth === right.dayOfMonth
}

/** Whether the last run already answered this local schedule instant. */
function alreadyAnswered(candidate: Date, lastRunAt: Date, timeZone: string): boolean {
  if (candidate.getTime() <= lastRunAt.getTime())
    return true

  const candidateParts = wallClockParts(candidate, timeZone)
  const lastRunParts = wallClockParts(lastRunAt, timeZone)
  if (!sameWallClockDate(candidateParts, lastRunParts))
    return false

  const candidateMinute = candidateParts.hour * 60 + candidateParts.minute
  const lastRunMinute = lastRunParts.hour * 60 + lastRunParts.minute
  return candidateMinute <= lastRunMinute
}

function utcDayCanMatch(expression: CronExpression, utcDayStart: number, timeZone: string): boolean {
  // A UTC day normally spans two local dates. Noon also covers historical
  // offset jumps, so a skipped local date cannot hide a nearby valid one.
  return [utcDayStart, utcDayStart + DAY / 2, utcDayStart + DAY - MINUTE]
    .some(at => matchesCronDate(expression, wallClockParts(new Date(at), timeZone)))
}

/** Finds the newest matching minute without scanning every minute for years. */
function newestMatchBetween(input: {
  expression: CronExpression
  newest: number
  oldest: number
  timeZone: string
}): Date | null {
  const oldestDay = Math.floor(input.oldest / DAY) * DAY
  for (let utcDay = Math.floor(input.newest / DAY) * DAY; utcDay >= oldestDay; utcDay -= DAY) {
    if (!utcDayCanMatch(input.expression, utcDay, input.timeZone))
      continue
    const newest = Math.min(input.newest, utcDay + DAY - MINUTE)
    const oldest = Math.max(input.oldest, utcDay)
    for (let at = Math.floor(newest / MINUTE) * MINUTE; at >= oldest; at -= MINUTE) {
      const candidate = new Date(at)
      if (matchesCron(input.expression, candidate, input.timeZone))
        return candidate
    }
  }
  return null
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
    if (input.lastRunAt !== null && alreadyAnswered(candidate, input.lastRunAt, input.timeZone))
      return { _tag: 'NotDue' }
    return { _tag: 'Due', scheduledFor: candidate }
  }

  // Search calendar dates instead of an arbitrary minute horizon. This finds
  // monthly and annual schedules without making common daily checks slower.
  const oldest = Math.max(
    start - MAXIMUM_CRON_GAP_DAYS * DAY,
    input.lastRunAt?.getTime() ?? Number.NEGATIVE_INFINITY,
  )
  const candidate = newestMatchBetween({
    expression: input.expression,
    newest: start - (catchUpMinutes + 1) * MINUTE,
    oldest,
    timeZone: input.timeZone,
  })
  if (candidate === null)
    return { _tag: 'NotDue' }
  if (input.lastRunAt !== null && alreadyAnswered(candidate, input.lastRunAt, input.timeZone))
    return { _tag: 'NotDue' }
  return {
    _tag: 'Missed',
    scheduledFor: candidate,
    reason: `This run was due more than ${Math.round(catchUpMinutes / 60)} hours ago, so it was skipped.`,
  }
}
