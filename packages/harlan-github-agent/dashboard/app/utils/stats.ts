import type { StatsComparison, StatsCoverage, StatsDay, StatsRange, StatsSnapshot, StatsWork } from '../../../src/stats.ts'
import type { AgentRole } from '../../../src/types.ts'

/**
 * Pure presentation for the Stats page. The page holds layout and the range
 * form; every number, label, and width comes from here so it can be tested.
 */

export interface StatsDateInputs {
  from: string
  to: string
}

export type StatsRequestRange
  = | { _tag: 'Valid', range: StatsRange }
    | { _tag: 'Invalid', message: string }

export const statsPresets = [7, 30, 90] as const
export type StatsPreset = typeof statsPresets[number]

function dateInput(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function statsDateRange(days: number, now: Date): StatsDateInputs {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1)
  return { from: dateInput(from), to: dateInput(now) }
}

/** The preset whose inclusive range ends today and matches the inputs exactly. */
export function activeStatsPreset(input: StatsDateInputs, now: Date): StatsPreset | undefined {
  return statsPresets.find((days) => {
    const range = statsDateRange(days, now)
    return range.from === input.from && range.to === input.to
  })
}

function parseDateInput(value: string): { year: number, month: number, day: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null)
    return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
    return undefined
  return { year, month, day }
}

function addDay(parts: { year: number, month: number, day: number }): { year: number, month: number, day: number } {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1))
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
}

function instantAtMidnight(parts: { year: number, month: number, day: number }, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone,
    year: 'numeric',
  })
  const target = Date.UTC(parts.year, parts.month - 1, parts.day)
  let instant = target
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const formatted = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]))
    const shown = Date.UTC(Number(formatted.year), Number(formatted.month) - 1, Number(formatted.day), Number(formatted.hour), Number(formatted.minute), Number(formatted.second))
    instant -= shown - target
  }
  return new Date(instant).toISOString()
}

export function statsRequestRange(input: StatsDateInputs, timeZone: string): StatsRequestRange {
  const from = parseDateInput(input.from)
  if (from === undefined)
    return { _tag: 'Invalid', message: 'Choose a valid start date.' }
  const to = parseDateInput(input.to)
  if (to === undefined)
    return { _tag: 'Invalid', message: 'Choose a valid end date.' }
  const fromValue = instantAtMidnight(from, timeZone)
  const toValue = instantAtMidnight(addDay(to), timeZone)
  if (Date.parse(fromValue) >= Date.parse(toValue))
    return { _tag: 'Invalid', message: 'The end date must follow the start date.' }
  return { _tag: 'Valid', range: { from: fromValue, to: toValue, timeZone } }
}

export function comparisonText(comparison: StatsComparison): string {
  const difference = comparison.value - comparison.previous
  if (difference === 0)
    return 'Same as the previous period'
  return difference > 0
    ? `${difference} more than the previous period`
    : `${Math.abs(difference)} fewer than the previous period`
}

/**
 * A bar's width as a share of the series maximum. Every bar starts at zero and
 * zero draws nothing, so the visual size equals the numeric size.
 */
export function barWidth(value: number, maximum: number): string {
  if (maximum <= 0 || value <= 0)
    return '0%'
  const share = Math.min(1, value / maximum)
  return `${Math.round(share * 1000) / 10}%`
}

/** Whether a value label fits above a bar column at the 14px mono glyph width. */
export function labelFits(value: number, columnWidth: number, glyphWidth = 8.5): boolean {
  return String(value).length * glyphWidth <= columnWidth
}

export interface OutcomeRow {
  label: string
  comparison: StatsComparison
  /** The comparison sentence, for assistive technology. */
  text: string
}

export function outcomeRows(summary: StatsSnapshot['summary']): OutcomeRow[] {
  const rows: Array<[string, StatsComparison]> = [
    ['Pull requests changed', summary.changedPullRequests],
    ['Repair commits', summary.fixCommits],
    ['Conflicts resolved', summary.conflictResolutions],
    ['Pull requests opened', summary.openedPullRequests],
    ['Review issues found', summary.reviewFindings],
  ]
  return rows.map(([label, comparison]) => ({ label, comparison, text: comparisonText(comparison) }))
}

/**
 * One scale for every Outcomes row: the largest value in either period. A bar
 * is then proportional across rows, so a 4 never draws as long as a 34.
 */
export function outcomeScale(rows: readonly OutcomeRow[]): number {
  return rows.reduce((maximum, row) => Math.max(maximum, row.comparison.value, row.comparison.previous), 0)
}

export function dayTotal(day: StatsDay): number {
  return day.fixCommits + day.conflictResolutions + day.openedPullRequests + day.reviewFindings
}

export function dayLabel(date: string): string {
  return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00.000Z`))
}

export function dayTitle(day: StatsDay): string {
  return `${dayLabel(day.date)}: ${day.fixCommits} repair commits, ${day.conflictResolutions} conflicts resolved, ${day.openedPullRequests} pull requests opened, ${day.reviewFindings} Review issues found`
}

export function hasStatsResults(snapshot: StatsSnapshot): boolean {
  return Object.values(snapshot.summary).some(comparison => comparison.value > 0)
    || snapshot.work.some(entry => entry.runs > 0)
}

export function coverageText(coverage: StatsCoverage): string | undefined {
  if (coverage._tag === 'Complete')
    return undefined
  return `Pull request triage counts start on ${dayLabel(coverage.startedAt.slice(0, 10))}.`
}

/** The work kind a Stats row stands for, so the row carries the same chip as the board. */
export function workRole(entry: StatsWork): AgentRole {
  switch (entry._tag) {
    case 'PullRequestTriage':
      return 'pull_request_triage'
    case 'Review':
      return 'adversarial_review'
    case 'Routine':
      return 'routine_scan'
    case 'Task':
      return entry.work
  }
}

export function workKey(entry: StatsWork): string {
  return entry._tag === 'Task' ? entry.work : entry._tag
}

function countList(parts: Array<[number, string, boolean?]>): string {
  return parts
    .filter(([count, , optional]) => optional !== true || count > 0)
    .map(([count, label]) => `${count} ${label}`)
    .join(', ')
}

export function workResultText(entry: StatsWork): string {
  switch (entry._tag) {
    case 'PullRequestTriage':
      return countList([[entry.reviewRequired, 'sent to Review'], [entry.reviewSkipped, 'skipped'], [entry.reviewRequiredAfterFailure, 'could not decide']])
    case 'Review':
      return countList([[entry.ready, 'READY'], [entry.pending, 'PENDING'], [entry.blocked, 'BLOCKED']])

    case 'Routine':
      return countList([[entry.completed, 'completed'], [entry.actionRequired, 'needed you'], [entry.failed, 'failed'], [entry.skipped, 'skipped'], [entry.superseded, 'superseded', true], [entry.candidates, 'candidates', true]])
    case 'Task':
      return countList([[entry.completed, 'completed'], [entry.actionRequired, 'needed you'], [entry.failed, 'failed'], [entry.superseded, 'superseded', true], [entry.publishedCommits, 'commits pushed'], [entry.changedFiles, 'files changed', true]])
  }
}

export function medianText(milliseconds: number | null): string {
  if (milliseconds === null)
    return 'No time yet'
  if (milliseconds < 60_000)
    return `${Math.max(1, Math.round(milliseconds / 1_000))}s`
  if (milliseconds < 3_600_000)
    return `${Math.round(milliseconds / 60_000)}m`
  return `${Math.round(milliseconds / 360_000) / 10}h`
}

/** The History query that shows the records behind one Stats row. */
export function historyQuery(entry: StatsWork, input: StatsDateInputs): { from: string, to: string, work: AgentRole } {
  return { from: input.from, to: input.to, work: workRole(entry) }
}
