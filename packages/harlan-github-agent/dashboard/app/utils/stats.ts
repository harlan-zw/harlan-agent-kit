import type { StatsComparison, StatsRange } from '../../../src/stats.ts'

export interface StatsDateInputs {
  from: string
  to: string
}

export type StatsRequestRange
  = | { _tag: 'Valid', range: StatsRange }
    | { _tag: 'Invalid', message: string }

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
