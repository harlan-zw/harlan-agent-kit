import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { AgentProviderName } from './agent-provider.ts'
import type { ProviderCapacity } from './types.ts'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'

/**
 * One seven-day subscription window, in minutes.
 *
 * Codex reports several windows at once and names each one by its duration.
 * The weekly window is the one that bounds a week of unattended work, so it is
 * the only one this service reads.
 */
export const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60

export type CodexProcess = ChildProcessByStdio<Writable, Readable, null>

interface RateLimitWindow {
  windowDurationMins?: unknown
  usedPercent?: unknown
  resetsAt?: unknown
}

/**
 * Reads the weekly window out of one `account/rateLimits/read` result.
 *
 * Codex moved these from `rateLimits` to `rateLimitsByLimitId.codex`, and both
 * shapes are still answered depending on the installed version, so both are
 * read here rather than pinned to one.
 */
export function weeklyCodexCapacity(result: unknown): ProviderCapacity {
  if (typeof result !== 'object' || result === null)
    return { _tag: 'Unavailable', reason: 'Codex answered no rate limits.' }
  const record = result as Record<string, unknown>
  const byLimitId = record.rateLimitsByLimitId
  const scoped = typeof byLimitId === 'object' && byLimitId !== null
    ? (byLimitId as Record<string, unknown>).codex
    : undefined
  const limits = (scoped ?? record.rateLimits) as Record<string, unknown> | undefined
  if (typeof limits !== 'object' || limits === null)
    return { _tag: 'Unavailable', reason: 'Codex answered no rate limits.' }

  const windows = [limits.primary, limits.secondary].filter(
    (candidate): candidate is RateLimitWindow => typeof candidate === 'object' && candidate !== null,
  )
  const weekly = windows.find(candidate => candidate.windowDurationMins === WEEKLY_WINDOW_MINUTES)
  if (weekly === undefined)
    return { _tag: 'Unavailable', reason: 'Codex reported no seven-day window.' }
  if (typeof weekly.usedPercent !== 'number' || typeof weekly.resetsAt !== 'number')
    return { _tag: 'Unavailable', reason: 'Codex reported an unreadable seven-day window.' }

  return {
    _tag: 'Available',
    usedPercent: Math.max(0, Math.min(100, weekly.usedPercent)),
    resetsAt: new Date(weekly.resetsAt * 1_000).toISOString(),
  }
}

export interface CodexCapacityOptions {
  binaryPath?: string
  /** Injected for tests. Returns the JSON-RPC line stream of one app server. */
  spawnCodex?: () => CodexProcess
  timeoutMilliseconds?: number
}

/**
 * Asks the local Codex app server what the weekly window has left.
 *
 * The account owns this window, so every machine signed in to the same account
 * reads the same figure. That is why two machines need no protocol to agree on
 * remaining capacity.
 */
export async function readCodexCapacity(options: CodexCapacityOptions = {}): Promise<ProviderCapacity> {
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 10_000
  const child = options.spawnCodex?.() ?? spawn(options.binaryPath ?? 'codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'ignore'],
  }) as CodexProcess

  const send = (message: unknown): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  const lines = createInterface({ input: child.stdout })
  let timer: NodeJS.Timeout | undefined

  try {
    return await new Promise<ProviderCapacity>((resolve) => {
      timer = setTimeout(resolve, timeoutMilliseconds, { _tag: 'Unavailable', reason: 'The Codex rate limit request timed out.' })
      timer.unref()

      child.on('error', (error: Error) => {
        resolve({ _tag: 'Unavailable', reason: `The Codex app server did not start: ${error.message}` })
      })
      lines.on('close', () => {
        resolve({ _tag: 'Unavailable', reason: 'The Codex app server closed before answering.' })
      })

      lines.on('line', (line) => {
        let message: Record<string, unknown>
        try {
          message = JSON.parse(line) as Record<string, unknown>
        }
        catch {
          // The app server prints other lines. Only JSON-RPC replies matter.
          return
        }
        if (message.id === 0) {
          if (message.error !== undefined) {
            resolve({ _tag: 'Unavailable', reason: 'Codex refused the rate limit session.' })
            return
          }
          send({ method: 'initialized', params: {} })
          send({ method: 'account/rateLimits/read', id: 1 })
          return
        }
        if (message.id === 1) {
          resolve(message.error === undefined
            ? weeklyCodexCapacity(message.result)
            : { _tag: 'Unavailable', reason: 'Codex refused to report its rate limits.' })
        }
      })

      send({
        method: 'initialize',
        id: 0,
        params: {
          clientInfo: {
            name: 'harlan_github_agent',
            title: 'Harlan GitHub Agent',
            version: '0.1.0',
          },
        },
      })
    })
  }
  finally {
    if (timer !== undefined)
      clearTimeout(timer)
    lines.close()
    if (child.exitCode === null)
      child.kill()
  }
}

export const OPENCODE_DATABASE = join(homedir(), '.local', 'share', 'opencode', 'db.sqlite')

/**
 * Reads what opencode has spent this week.
 *
 * opencode publishes no quota, so there is no percentage to compare a reserve
 * against. Spend is the only figure its own store knows, which is why opencode
 * capacity reads as `Unpublished` and never blocks a turn on its own. It leaves
 * the ladder when a turn fails naming its limit, not when a number is crossed.
 */
export function readOpencodeSpend(database: string = OPENCODE_DATABASE, now: Date = new Date()): { turns: number, cost: number } | null {
  const since = now.getTime() - WEEKLY_WINDOW_MINUTES * 60_000
  let connection: DatabaseSync
  try {
    connection = new DatabaseSync(database, { readOnly: true })
  }
  catch {
    // No opencode store means opencode has never run here. That is not a fault.
    return null
  }
  try {
    const row = connection.prepare(`
      SELECT
        COUNT(*) AS turns,
        COALESCE(SUM(COALESCE(json_extract(data, '$.cost'), 0)), 0) AS cost
      FROM message
      WHERE json_extract(data, '$.role') = 'assistant' AND time_created > ?
    `).get(since) as { turns: number, cost: number } | undefined
    return row === undefined ? null : { turns: row.turns, cost: row.cost }
  }
  catch {
    return null
  }
  finally {
    connection.close()
  }
}

/**
 * Whether unattended work may spend this provider's window right now.
 *
 * A provider that publishes no quota always passes. Refusing an unknown figure
 * would mean opencode could never answer a turn, which is the opposite of what
 * a fallback ladder is for.
 */
export function hasSpendableCapacity(capacity: ProviderCapacity, reservePercent: number): boolean {
  if (capacity._tag === 'Unpublished')
    return true
  if (capacity._tag === 'Unavailable')
    return false
  return 100 - capacity.usedPercent > reservePercent
}

/**
 * Picks the first Agent provider in preference order that may spend its window.
 *
 * Returns null when none may. The caller stops claiming new agent Tasks rather
 * than starting one it cannot pay for.
 */
export function chooseAgentProvider(input: {
  capacity: (provider: AgentProviderName) => ProviderCapacity
  order: readonly AgentProviderName[]
  reservePercent: number
}): AgentProviderName | null {
  return input.order.find(provider => hasSpendableCapacity(input.capacity(provider), input.reservePercent)) ?? null
}

export interface ProviderCapacitySource {
  /** The last reading. Never blocks an agent turn on a subprocess. */
  read: (provider: AgentProviderName) => ProviderCapacity
  refresh: () => Promise<void>
  start: () => void
  stop: () => Promise<void>
}

export interface ProviderCapacitySourceOptions {
  intervalMilliseconds?: number
  onError: (error: unknown) => void
  readCodex?: () => Promise<ProviderCapacity>
}

/**
 * Keeps one current capacity reading per Agent provider.
 *
 * Reading Codex costs a subprocess and a round trip, so a turn never waits for
 * it. The refresh runs on its own interval and every turn reads the last
 * answer. A window moves over hours, so a reading minutes old still decides
 * correctly.
 */
export function createProviderCapacitySource(options: ProviderCapacitySourceOptions): ProviderCapacitySource {
  const intervalMilliseconds = options.intervalMilliseconds ?? 5 * 60_000
  const readCodex = options.readCodex ?? (() => readCodexCapacity())
  let codex: ProviderCapacity = { _tag: 'Unavailable', reason: 'The Codex weekly window has not been read yet.' }
  let timer: NodeJS.Timeout | undefined
  let stopped = true
  let active: Promise<void> = Promise.resolve()

  const refresh = (): Promise<void> => {
    active = active
      .then(async () => {
        codex = await readCodex()
      })
      .catch(options.onError)
    return active
  }

  const schedule = (): void => {
    if (stopped)
      return
    timer = setTimeout(() => void refresh().finally(schedule), intervalMilliseconds)
    timer.unref()
  }

  return {
    read: provider => provider === 'codex' ? codex : { _tag: 'Unpublished' },
    refresh,
    start: () => {
      if (!stopped)
        return
      stopped = false
      void refresh().finally(schedule)
    },
    stop: async () => {
      stopped = true
      if (timer !== undefined)
        clearTimeout(timer)
      await active
    },
  }
}
