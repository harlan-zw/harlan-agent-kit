import type { AgentRole, DashboardSnapshot } from '../../../src/types.ts'
import type { BoardCard } from './dashboard.ts'
import { boardCardIdentity, boardColumns } from './dashboard.ts'

/**
 * The Timeline: time runs left to right, now sits near the right edge, and
 * every row is one issue, pull request, or Routine. This module is pure. It
 * turns the live snapshot and the stored history into rows and marks, and it
 * owns the view math. The page only draws what it returns.
 */

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour

/* ---------- History, as the Timeline API returns it ---------- */

export type TimelineOutcome = 'READY' | 'PENDING' | 'BLOCKED' | 'Completed' | 'Failed' | 'Needs info'

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

/* ---------- View math ---------- */

/** What the canvas shows: its scale and the time at its right edge. */
export interface TimelineView {
  msPerPx: number
  end: number
}

/** Now sits at three quarters of the width, so the next hour is visible. */
export const nowFraction = 0.75
export const minMsPerPx = minute / 40
export const maxMsPerPx = (30 * day) / 900

export const zoomPresets = [
  { label: '1h', span: hour },
  { label: '6h', span: 6 * hour },
  { label: '1d', span: day },
  { label: '7d', span: 7 * day },
] as const

export function xOf(view: TimelineView, width: number, at: number): number {
  return width - (view.end - at) / view.msPerPx
}

export function timeAt(view: TimelineView, width: number, x: number): number {
  return view.end - (width - x) * view.msPerPx
}

export function clampScale(msPerPx: number): number {
  return Math.min(maxMsPerPx, Math.max(minMsPerPx, msPerPx))
}

/** The view that keeps now at its resting place. */
export function followView(now: number, width: number, msPerPx: number): TimelineView {
  return { msPerPx, end: now + (1 - nowFraction) * width * msPerPx }
}

/** Zoom by `factor` while the time under `x` stays under `x`. */
export function zoomAt(view: TimelineView, width: number, x: number, factor: number): TimelineView {
  const anchor = timeAt(view, width, x)
  const msPerPx = clampScale(view.msPerPx * factor)
  return { msPerPx, end: anchor + (width - x) * msPerPx }
}

/** The span label for the zoom control: the closest preset, or hours and days. */
export function spanLabel(view: TimelineView, width: number): string {
  const span = view.msPerPx * width
  const preset = zoomPresets.find(entry => Math.abs(entry.span - span) / entry.span < 0.08)
  if (preset)
    return preset.label
  if (span < hour)
    return `${Math.round(span / minute)}m`
  if (span < 2 * day)
    return `${Math.round(span / hour)}h`
  return `${Math.round(span / day)}d`
}

/* ---------- Ruler ---------- */

export interface TimeTick {
  at: number
  label: string
  /** A local midnight. The ruler names the day there. */
  day: boolean
}

const tickSteps = [5 * minute, 10 * minute, 15 * minute, 30 * minute, hour, 2 * hour, 3 * hour, 6 * hour, 12 * hour, day]

/** Ticks at a step that keeps labels at least `spacing` pixels apart, in local time. */
export function timeTicks(view: TimelineView, width: number, spacing = 110): TimeTick[] {
  const start = timeAt(view, width, 0)
  const step = tickSteps.find(candidate => candidate / view.msPerPx >= spacing) ?? day
  const offset = new Date(start).getTimezoneOffset() * minute
  const first = Math.ceil((start - offset) / step) * step + offset
  const ticks: TimeTick[] = []
  for (let at = first; at <= view.end; at += step) {
    const date = new Date(at)
    const midnight = date.getHours() === 0 && date.getMinutes() === 0
    ticks.push({
      at,
      day: midnight,
      label: midnight
        ? date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
        : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    })
  }
  return ticks
}

/* ---------- Deliveries ---------- */

export interface DeliveryBin {
  start: number
  end: number
  count: number
}

/**
 * Sum delivery buckets into bins of at least `binMs`, covering `[from, to)`.
 * Bins align to the series, so panning never makes bars shimmer.
 */
export function deliveryBins(series: DeliverySeries, from: number, to: number, binMs: number): DeliveryBin[] {
  const bucketMs = series.bucketSeconds * 1000
  const origin = Date.parse(series.start)
  const perBin = Math.max(1, Math.round(binMs / bucketMs))
  const width = perBin * bucketMs
  const firstBin = Math.max(0, Math.floor((from - origin) / width))
  const lastBin = Math.floor((Math.min(to, origin + series.counts.length * bucketMs) - origin - 1) / width)
  const bins: DeliveryBin[] = []
  for (let bin = firstBin; bin <= lastBin; bin++) {
    let count = 0
    for (let index = bin * perBin; index < (bin + 1) * perBin && index < series.counts.length; index++)
      count += series.counts[index]!
    bins.push({ start: origin + bin * width, end: origin + (bin + 1) * width, count })
  }
  return bins
}

/** Deliveries in the last hour of the series, for the row label. */
export function deliveriesLastHour(series: DeliverySeries): number {
  const perHour = Math.round(3600 / series.bucketSeconds)
  return series.counts.slice(-perHour).reduce((total, count) => total + count, 0)
}

/* ---------- Rows and marks ---------- */

export type TimelineMark
  = | { _tag: 'Span', start: number, end: number, work: AgentRole, outcome?: TimelineOutcome }
  /** A GitHub delivery that moved this item. */
    | { _tag: 'Event', at: number, event: string }
  /** Running now. The span ends at the now line and grows with it. */
    | { _tag: 'Live', start: number, work: AgentRole }
  /** Waiting on a decision since `since`. You is amber; Agent is neutral. */
    | { _tag: 'Wait', since: number, owner: 'You' | 'Agent' }
  /** In the Queue. `position` is null while it waits on something outside the engine. */
    | { _tag: 'Queued', position: number | null }
    | { _tag: 'RoutineRun', at: number, end: number | null, result: RoutineResult }
    | { _tag: 'RoutineNext', at: number }

export interface TimelineItem {
  repository: string
  number: number
  kind: 'issue' | 'pull_request'
  title: string
  url: string
}

export type TimelineRow
  = | { _tag: 'Card', key: string, card: BoardCard, marks: TimelineMark[] }
    | { _tag: 'Item', key: string, item: TimelineItem, work: AgentRole, marks: TimelineMark[], lastAt: number }
    | { _tag: 'Routine', key: string, name: string, repository: string, marks: TimelineMark[] }

export type TimelineSectionTag = 'NeedsYou' | 'AgentTasks' | 'Running' | 'UpNext' | 'Routines' | 'Earlier'

export interface TimelineSection {
  _tag: TimelineSectionTag
  label: string
  rows: TimelineRow[]
  /** Rows folded under "Show more". */
  folded: TimelineRow[]
}

export interface SectionInput {
  snapshot: DashboardSnapshot
  history: TimelineHistory | undefined
  now: number
  /** The visible time range. Routine and Earlier rows depend on it. */
  from: number
  to: number
  /** Rows kept open per section before the rest fold. */
  limit?: number
}

/** A Routine due this soon stays open, whatever else folds. */
const dueSoon = 2 * hour

const itemKey = (repository: string, number: number): string => `${repository}#${number}`

function historyMarks(tasks: TimelineTaskRecord[] | undefined, events: TimelineItemEvent[] | undefined): TimelineMark[] {
  return [
    ...(events ?? []).map((event): TimelineMark => ({ _tag: 'Event', at: Date.parse(event.at), event: event.event })),
    ...(tasks ?? []).map((task): TimelineMark => ({ _tag: 'Span', start: Date.parse(task.startedAt), end: Date.parse(task.endedAt), work: task.work, outcome: task.outcome })),
  ]
}

function cardItemKey(card: BoardCard, snapshot: DashboardSnapshot): string | undefined {
  const identity = boardCardIdentity(card, snapshot)
  return identity === undefined ? undefined : itemKey(identity.repository, identity.number)
}

/**
 * The Timeline's sections, in the Board's order of questions. A row lives in
 * exactly one section. An item that already has a live row never repeats in
 * Earlier, and a Routine due within two hours never folds.
 */
export function timelineSections(input: SectionInput): TimelineSection[] {
  const { snapshot, history, now, from, to, limit = 8 } = input
  const columns = boardColumns(snapshot)
  const tasksByItem = new Map<string, TimelineTaskRecord[]>()
  for (const task of history?.tasks ?? []) {
    const key = itemKey(task.repository, task.number)
    tasksByItem.set(key, [...(tasksByItem.get(key) ?? []), task])
  }
  const eventsByItem = new Map<string, TimelineItemEvent[]>()
  for (const event of history?.itemEvents ?? []) {
    const key = itemKey(event.repository, event.number)
    eventsByItem.set(key, [...(eventsByItem.get(key) ?? []), event])
  }
  const claimed = new Set<string>()
  const cardRow = (card: BoardCard, current: TimelineMark[]): TimelineRow => {
    const key = cardItemKey(card, snapshot)
    if (key !== undefined)
      claimed.add(key)
    return { _tag: 'Card', key: card.key, card, marks: [...(key === undefined ? [] : historyMarks(tasksByItem.get(key), eventsByItem.get(key))), ...current] }
  }

  const needsYou = columns.needsYou.map(card => cardRow(card, card._tag === 'NeedsYou' ? [{ _tag: 'Wait', since: Date.parse(card.entry.updatedAt), owner: 'You' }] : []))
  const agentTasks = columns.agentTasks.map(card => cardRow(card, card._tag === 'AgentTask' ? [{ _tag: 'Wait', since: Date.parse(card.entry.updatedAt), owner: 'Agent' }] : []))
  const running = columns.running.map(card => cardRow(card, card._tag === 'Running'
    ? [{ _tag: 'Live', start: Date.parse(card.agent.startedAt), work: card.agent.role }]
    : card._tag === 'Starting' ? [{ _tag: 'Queued', position: null }] : []))
  const upNext = [
    ...columns.queued.map(card => cardRow(card, card._tag === 'Queued' ? [{ _tag: 'Queued', position: card.entry.position }] : [])),
    ...columns.waiting.map(card => cardRow(card, [{ _tag: 'Queued', position: null }])),
  ]

  // Routines: every Routine with a run in view or an instant in the visible future.
  const routineRows = new Map<string, { name: string, repository: string, marks: TimelineMark[], next: number | undefined, last: number }>()
  const routineRow = (id: string, name: string, repository: string) => {
    const existing = routineRows.get(id)
    if (existing)
      return existing
    const row = { name, repository, marks: [] as TimelineMark[], next: undefined as number | undefined, last: Number.NEGATIVE_INFINITY }
    routineRows.set(id, row)
    return row
  }
  for (const run of history?.routineRuns ?? []) {
    const at = Date.parse(run.scheduledFor)
    const end = run.endedAt === null ? null : Date.parse(run.endedAt)
    if ((end ?? at) < from || at > to)
      continue
    const row = routineRow(run.routineId, run.name, run.repository)
    row.marks.push({ _tag: 'RoutineRun', at, end, result: run.result })
    row.last = Math.max(row.last, at)
  }
  for (const instant of history?.upcoming ?? []) {
    const at = Date.parse(instant.at)
    if (at < now || at > to)
      continue
    const row = routineRow(instant.routineId, instant.name, instant.repository)
    row.marks.push({ _tag: 'RoutineNext', at })
    row.next = Math.min(row.next ?? at, at)
  }
  const routines = [...routineRows.entries()]
    .sort(([, a], [, b]) => (a.next ?? Number.POSITIVE_INFINITY) - (b.next ?? Number.POSITIVE_INFINITY) || b.last - a.last)
    .map(([id, row]): TimelineRow & { due: boolean } => ({ _tag: 'Routine', key: `routine:${id}`, name: row.name, repository: row.repository, marks: row.marks, due: row.next !== undefined && row.next - now <= dueSoon }))

  // Earlier: finished items in view that no live row claims, newest first.
  const earlier = [...tasksByItem.entries()]
    .filter(([key]) => !claimed.has(key))
    .flatMap(([key, tasks]): TimelineRow[] => {
      const inView = tasks.filter(task => Date.parse(task.endedAt) >= from && Date.parse(task.startedAt) <= to)
      if (inView.length === 0)
        return []
      const last = tasks.at(-1)!
      return [{
        _tag: 'Item',
        key: `item:${key}`,
        item: { repository: last.repository, number: last.number, kind: last.kind, title: last.title, url: `https://github.com/${last.repository}/${last.kind === 'issue' ? 'issues' : 'pull'}/${last.number}` },
        work: last.work,
        marks: historyMarks(tasks, eventsByItem.get(key)),
        lastAt: Math.max(...tasks.map(task => Date.parse(task.endedAt))),
      }]
    })
    .sort((a, b) => (b._tag === 'Item' ? b.lastAt : 0) - (a._tag === 'Item' ? a.lastAt : 0))

  const dueRoutines = routines.filter(row => row.due)
  const otherRoutines = routines.filter(row => !row.due)
  const routineLimit = Math.max(Math.ceil(limit / 2) - dueRoutines.length, 2)
  const sections: TimelineSection[] = [
    { _tag: 'NeedsYou', label: 'Needs you', rows: needsYou, folded: [] },
    { _tag: 'AgentTasks', label: 'Agent tasks', rows: agentTasks, folded: [] },
    { _tag: 'Running', label: 'Running', rows: running, folded: [] },
    { _tag: 'UpNext', label: 'Up next', rows: upNext.slice(0, limit), folded: upNext.slice(limit) },
    { _tag: 'Routines', label: 'Routines', rows: [...dueRoutines, ...otherRoutines.slice(0, routineLimit)], folded: otherRoutines.slice(routineLimit) },
    { _tag: 'Earlier', label: 'Earlier', rows: earlier.slice(0, limit), folded: earlier.slice(limit) },
  ]
  return sections.filter(section => section.rows.length > 0 || section._tag === 'NeedsYou')
}

/* ---------- Routine instants ---------- */

/** Minutes until a future instant, for the countdown beside the next Routine run. */
export function countdown(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((at - now) / minute))
  if (minutes < 60)
    return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 === 0 || hours >= 6 ? `in ${hours}h` : `in ${hours}h ${minutes % 60}m`
}

/** What a hovered mark says, at the pointer. */
export interface MarkTip {
  x: number
  y: number
  title: string
  detail: string
}
