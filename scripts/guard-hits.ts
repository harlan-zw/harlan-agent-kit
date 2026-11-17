// Summarises the Hook hit log: hits per guard, per surface, per ISO week (UTC).
// harlan-agent-kit/hooks/hit-log.sh writes the log. Run: pnpm guard-hits [--file <path>]
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/** The log file name. hit-log.sh writes the same name. */
const hitLogFile = 'guard-hits.jsonl'

const decisions = ['deny', 'rewrite'] as const
const surfaces = ['claude', 'codex', 'opencode', 'unknown'] as const
const utcTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

export interface Hit {
  time: Date
  guard: string
  decision: typeof decisions[number]
  surface: typeof surfaces[number]
  reason: string
}

export interface MalformedLine { line: number, problem: string }

export interface SummaryRow { week: string, guard: string, surface: string, hits: number }

type LineRead = { _tag: 'Ok', hit: Hit } | { _tag: 'Err', problem: string }

/** The log path for this environment. An empty XDG_STATE_HOME counts as unset, as in bash. */
export function hitLogPath(env: Record<string, string | undefined>, home: string): string {
  const state = env.XDG_STATE_HOME || join(home, '.local', 'state')
  return join(state, 'harlan-agent-kit', hitLogFile)
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
}

function readLine(text: string): LineRead {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    return { _tag: 'Err', problem: 'not JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null)
    return { _tag: 'Err', problem: 'not an object' }
  const { time, guard, decision, surface, reason } = parsed as Record<string, unknown>
  if (typeof time !== 'string' || !utcTime.test(time) || Number.isNaN(Date.parse(time)))
    return { _tag: 'Err', problem: 'no UTC time' }
  if (typeof guard !== 'string' || guard === '')
    return { _tag: 'Err', problem: 'no guard' }
  if (!isOneOf(decisions, decision))
    return { _tag: 'Err', problem: 'unknown decision' }
  if (!isOneOf(surfaces, surface))
    return { _tag: 'Err', problem: 'unknown surface' }
  return { _tag: 'Ok', hit: { time: new Date(time), guard, decision, surface, reason: typeof reason === 'string' ? reason : '' } }
}

/** Parses the log once. Blank lines are skipped; every other unreadable line is reported. */
export function parseHitLog(text: string): { hits: Hit[], malformed: MalformedLine[] } {
  const hits: Hit[] = []
  const malformed: MalformedLine[] = []
  text.split('\n').forEach((raw, index) => {
    if (raw.trim() === '')
      return
    const read = readLine(raw)
    if (read._tag === 'Ok')
      hits.push(read.hit)
    else
      malformed.push({ line: index + 1, problem: read.problem })
  })
  return { hits, malformed }
}

/** The ISO 8601 week of a moment, in UTC, such as 2026-W47. */
export function isoWeek(date: Date): string {
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  // The Thursday of a Monday-first week decides its ISO year and week.
  thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7))
  const year = thursday.getUTCFullYear()
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 / 7) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** Counts hits per ISO week, guard, and surface. Oldest week first, then most hits. */
export function summariseHits(hits: readonly Hit[]): SummaryRow[] {
  const counts = new Map<string, SummaryRow>()
  for (const hit of hits) {
    const week = isoWeek(hit.time)
    const key = `${week}\0${hit.guard}\0${hit.surface}`
    const row = counts.get(key) ?? { week, guard: hit.guard, surface: hit.surface, hits: 0 }
    row.hits++
    counts.set(key, row)
  }
  return [...counts.values()].sort((a, b) =>
    a.week.localeCompare(b.week) || b.hits - a.hits || a.guard.localeCompare(b.guard) || a.surface.localeCompare(b.surface))
}

function formatTable(rows: readonly SummaryRow[]): string {
  const table = [['week', 'guard', 'surface', 'hits'], ...rows.map(row => [row.week, row.guard, row.surface, String(row.hits)])]
  const widths = table[0]!.map((_, column) => Math.max(...table.map(cells => cells[column]!.length)))
  return table
    .map(cells => cells.map((cell, column) => column === 3 ? cell.padStart(widths[column]!) : cell.padEnd(widths[column]!)).join('  '))
    .join('\n')
}

type Options = { _tag: 'Ok', file: string | undefined } | { _tag: 'Err', reason: string }

function readOptions(args: readonly string[]): Options {
  if (args.length === 0)
    return { _tag: 'Ok', file: undefined }
  if (args.length === 2 && args[0] === '--file' && args[1] !== '')
    return { _tag: 'Ok', file: args[1] }
  return { _tag: 'Err', reason: 'Usage: pnpm guard-hits [--file <path>]' }
}

function main(): number {
  const options = readOptions(process.argv.slice(2))
  if (options._tag === 'Err') {
    process.stderr.write(`${options.reason}\n`)
    return 64
  }
  const path = options.file ?? hitLogPath(process.env, homedir())
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error
    process.stdout.write(`No Hook hits logged at ${path}.\n`)
    return 0
  }
  const { hits, malformed } = parseHitLog(text)
  process.stdout.write(`${formatTable(summariseHits(hits))}\n`)
  if (malformed.length > 0) {
    const noun = malformed.length === 1 ? 'line' : 'lines'
    const where = malformed.map(entry => entry.line).join(', ')
    process.stderr.write(`Skipped ${malformed.length} malformed ${noun} in ${path}: ${noun} ${where}.\n`)
  }
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main()
