import type { Result } from './result.ts'
import type { RoutineMode, RoutineName, RoutineSpec, RoutineSpecEntry } from './types.ts'
import { parse as parseYaml } from 'yaml'
import { err, ok } from './result.ts'

/** Where every repository declares its own Routine schedule. */
export const ROUTINE_SPEC_PATH = '.github/routines.yml'

/**
 * Every Routine the service knows how to run.
 *
 * A repository spec selects from this list and never extends it. The spec is
 * source code, so a pull request can change it, and a name it could invent
 * would be a name it could point at anything.
 */
export const ROUTINE_NAMES = ['sentry-checkin', 'pr-triage', 'agent-feedback', 'daily-checkin'] as const satisfies readonly RoutineName[]

export const ROUTINE_MODES = ['report', 'propose'] as const satisfies readonly RoutineMode[]

/** Keys a repository spec entry may set. Anything else is refused by name. */
const ALLOWED_ENTRY_KEYS = new Set(['name', 'on', 'timezone', 'mode', 'enabled'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether the runtime knows this time zone.
 *
 * A spec that names a zone this machine cannot resolve would otherwise run at
 * UTC and silently answer at the wrong hour.
 */
function knowsTimeZone(timeZone: string): boolean {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone !== undefined
  }
  catch {
    return false
  }
}

function parseCronList(value: unknown): Result<string[], string> {
  if (!isRecord(value))
    return err('Write an `on` object with a `schedule` list.')
  const extra = Object.keys(value).find(key => key !== 'schedule')
  if (extra !== undefined)
    return err(`Remove \`on.${extra}\`. A Routine answers a schedule and nothing else.`)
  const schedule = value.schedule
  if (!Array.isArray(schedule) || schedule.length === 0)
    return err('Write at least one `on.schedule` entry.')

  const crons: string[] = []
  for (const entry of schedule) {
    if (!isRecord(entry))
      return err('Write each schedule entry as an object with a `cron` key.')
    const entryExtra = Object.keys(entry).find(key => key !== 'cron')
    if (entryExtra !== undefined)
      return err(`Remove \`${entryExtra}\` from the schedule entry. Only \`cron\` belongs there.`)
    if (typeof entry.cron !== 'string' || entry.cron.trim() === '')
      return err('Write a cron expression for every schedule entry.')
    crons.push(entry.cron.trim())
  }
  return ok(crons)
}

function parseEntry(value: unknown, index: number): Result<RoutineSpecEntry, string> {
  if (!isRecord(value))
    return err(`Write routine ${index + 1} as an object.`)

  const unknownKey = Object.keys(value).find(key => !ALLOWED_ENTRY_KEYS.has(key))
  if (unknownKey !== undefined)
    return err(`Remove \`${unknownKey}\` from routine ${index + 1}. A repository sets the schedule, the mode, and enabled.`)

  const name = ROUTINE_NAMES.find(candidate => candidate === value.name)
  if (name === undefined)
    return err(`Name one Routine the service runs: ${ROUTINE_NAMES.join(' or ')}.`)

  const crons = parseCronList(value.on)
  if (crons._tag === 'Err')
    return err(`${name}: ${crons.error}`)

  const timeZone = value.timezone === undefined ? 'UTC' : value.timezone
  if (typeof timeZone !== 'string' || !knowsTimeZone(timeZone))
    return err(`${name}: write a time zone this machine knows, for example Australia/Sydney.`)

  const mode = value.mode === undefined ? 'report' : ROUTINE_MODES.find(candidate => candidate === value.mode)
  if (mode === undefined)
    return err(`${name}: set the mode to report or propose.`)

  const enabled = value.enabled === undefined ? true : value.enabled
  if (typeof enabled !== 'boolean')
    return err(`${name}: set enabled to true or false.`)

  return ok({ name, crons: crons.value, timeZone, mode, enabled })
}

/**
 * Parses one repository's Routine spec into a precise type.
 *
 * The spec is untrusted input. Every field it may set is read here, and every
 * field it may not set is refused by name rather than ignored, so a spec that
 * tries to widen its own authority fails loudly instead of quietly doing
 * nothing.
 *
 * A repository with no spec file runs no Routines. That is the default and it
 * is not an error.
 */
export function parseRoutineSpec(text: string): Result<RoutineSpec, string> {
  let document: unknown
  try {
    document = parseYaml(text)
  }
  catch (error) {
    return err(error instanceof Error ? error.message : 'The Routine spec is not valid YAML.')
  }
  if (document === null || document === undefined)
    return ok({ routines: [] })
  if (!isRecord(document))
    return err('Write the Routine spec as an object.')

  if (document.version !== 1)
    return err('Set `version: 1` in the Routine spec.')

  const routines = document.routines
  if (routines === undefined)
    return ok({ routines: [] })
  if (!Array.isArray(routines))
    return err('Write `routines` as a list.')

  const entries: RoutineSpecEntry[] = []
  for (const [index, value] of routines.entries()) {
    const entry = parseEntry(value, index)
    if (entry._tag === 'Err')
      return entry
    if (entries.some(existing => existing.name === entry.value.name))
      return err(`Declare ${entry.value.name} once. Give one Routine every schedule it needs.`)
    entries.push(entry.value)
  }
  return ok({ routines: entries })
}
