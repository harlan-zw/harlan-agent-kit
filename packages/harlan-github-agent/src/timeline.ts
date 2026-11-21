import type { Result } from './result.ts'
import type { AgentRole } from './types.ts'
import { err, ok } from './result.ts'

/**
 * What `GET /api/timeline` answers: the stored history behind the dashboard
 * Timeline. The dashboard parses it once at its boundary and draws it beside
 * the live snapshot. Everything here is wire shape and pure decisions; the
 * journal reads live in `timeline-store.ts`.
 */

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour

export type TimelineOutcome = 'READY' | 'PENDING' | 'BLOCKED' | 'Completed' | 'Failed' | 'Needs info' | 'Action required' | 'Superseded'

export interface TimelineTaskRecord {
  id: string
  repository: string
  number: number
  kind: 'issue' | 'pull_request'
  title: string
  work: AgentRole
  startedAt: string
  endedAt: string
  outcome: TimelineOutcome
}

export type RoutineResult = 'Clear' | 'Action required' | 'Blocked' | 'Skipped' | 'Unchanged'

export interface TimelineRoutineRun {
  routineId: string
  repository: string
  name: string
  scheduledFor: string
  endedAt: string | null
  result: RoutineResult
}

export interface TimelineRoutineInstant {
  routineId: string
  repository: string
  name: string
  at: string
}

/** Delivery counts in fixed buckets, oldest first. */
export interface DeliverySeries {
  start: string
  bucketSeconds: number
  counts: number[]
}

/** One work-causing delivery for one issue or pull request, such as `pull_request · synchronize`. */
export interface TimelineItemEvent {
  repository: string
  number: number
  at: string
  event: string
}

export interface TimelineHistory {
  generatedAt: string
  deliveries: DeliverySeries
  tasks: TimelineTaskRecord[]
  itemEvents: TimelineItemEvent[]
  routineRuns: TimelineRoutineRun[]
  upcoming: TimelineRoutineInstant[]
  pauses: Array<{ from: string, to: string | null }>
}

/* ---------- Window ---------- */

/** The longest window one request may read. Its delivery series stays under 43,200 minutes. */
export const TIMELINE_MAXIMUM_DAYS = 30
export const TIMELINE_DEFAULT_PAST_DAYS = 7
export const TIMELINE_DEFAULT_FUTURE_DAYS = 2

/** A half-open window `[from, to)` in Unix milliseconds. */
export interface TimelineWindow {
  from: number
  to: number
}

export type TimelineWindowError
  = | { _tag: 'InvalidFrom' }
    | { _tag: 'InvalidTo' }
    | { _tag: 'EmptyWindow' }
    | { _tag: 'WindowTooLong', maximumDays: number }

const isoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/

function parseInstant(value: string | undefined, fallback: number): number | undefined {
  if (value === undefined)
    return fallback
  if (!isoInstant.test(value))
    return undefined
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : undefined
}

/**
 * Parse `from` and `to` once, at the route. A missing bound means the last
 * seven days or the next two, so the dashboard's default view needs no query.
 */
export function parseTimelineWindow(input: { from?: string | undefined, to?: string | undefined }, now: number): Result<TimelineWindow, TimelineWindowError> {
  const from = parseInstant(input.from, now - TIMELINE_DEFAULT_PAST_DAYS * day)
  if (from === undefined)
    return err({ _tag: 'InvalidFrom' })
  const to = parseInstant(input.to, now + TIMELINE_DEFAULT_FUTURE_DAYS * day)
  if (to === undefined)
    return err({ _tag: 'InvalidTo' })
  if (to <= from)
    return err({ _tag: 'EmptyWindow' })
  if (to - from > TIMELINE_MAXIMUM_DAYS * day)
    return err({ _tag: 'WindowTooLong', maximumDays: TIMELINE_MAXIMUM_DAYS })
  return ok({ from, to })
}

export function timelineWindowMessage(error: TimelineWindowError): string {
  switch (error._tag) {
    case 'InvalidFrom': return 'Set from to an ISO 8601 time.'
    case 'InvalidTo': return 'Set to to an ISO 8601 time.'
    case 'EmptyWindow': return 'The end time must follow the start time.'
    case 'WindowTooLong': return `Choose a window of ${error.maximumDays} days or less.`
  }
}

/* ---------- Deliveries ---------- */

/**
 * The minute buckets for delivery counts between `from` and now. The series
 * starts on the hour, so a refetch a minute later keeps every bin in place,
 * and it ends at now, so its tail is the last hour. Every window uses one
 * minute per bucket, so the dashboard can join series from adjacent windows.
 */
export function deliveryBuckets(window: TimelineWindow, now: number): { start: number, length: number } {
  const start = Math.floor(window.from / hour) * hour
  const end = Math.min(window.to, now)
  return { start, length: Math.max(0, Math.ceil((end - start) / minute)) }
}

/* ---------- Outcomes ---------- */

/** The state a finished Task or Review Task ended in. */
export type TaskEnd = 'Completed' | 'Failed' | 'ActionRequired' | 'Superseded'

/**
 * The cap one finished Task shows. A Review takes its gate outcome, and an
 * Issue triage that asked for information says so. Superseded never reads as
 * a failure: newer work replaced it.
 */
export function timelineOutcome(input: { end: TaskEnd, review: 'Ready' | 'Pending' | 'Blocked' | null, triageRoute: string | null }): TimelineOutcome {
  switch (input.end) {
    case 'Failed': return 'Failed'
    case 'ActionRequired': return 'Action required'
    case 'Superseded': return 'Superseded'
    case 'Completed':
      if (input.review === 'Ready')
        return 'READY'
      if (input.review === 'Pending')
        return 'PENDING'
      if (input.review === 'Blocked')
        return 'BLOCKED'
      return input.triageRoute === 'NEEDS_INFO' ? 'Needs info' : 'Completed'
  }
}

/** The state a finished Routine run ended in. */
export type RoutineRunEnd = 'Completed' | 'Failed' | 'Skipped' | 'ActionRequired' | 'Superseded'

/** A Routine report verdict, as `routine_report_commands.verdict_json` stores it. */
export interface RoutineVerdict {
  severity: 'GREEN' | 'AMBER' | 'RED'
  coverage: 'complete' | 'incomplete'
}

/**
 * The diamond one finished Routine run shows. It follows the Routines page:
 * incomplete coverage is Blocked, and a verdict that is not GREEN or a
 * Proposed Candidate asks for action. An unchanged run spent no Agent turn.
 */
export function routineResult(input: { end: RoutineRunEnd, evidence: string | null, verdict: RoutineVerdict | null, proposedCandidates: number }): RoutineResult {
  switch (input.end) {
    case 'Failed': return 'Blocked'
    case 'ActionRequired': return 'Action required'
    case 'Skipped':
    case 'Superseded': return 'Skipped'
    case 'Completed':
      if (input.evidence?.includes('unchanged since run'))
        return 'Unchanged'
      if (input.verdict?.coverage === 'incomplete')
        return 'Blocked'
      if ((input.verdict !== null && input.verdict.severity !== 'GREEN') || input.proposedCandidates > 0)
        return 'Action required'
      return 'Clear'
  }
}
