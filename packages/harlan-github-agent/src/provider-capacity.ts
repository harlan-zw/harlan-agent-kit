import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { AgentProviderName } from './agent-provider.ts'
import type { ProviderCapacity } from './types.ts'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

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

/** Where opencode declares the GLM Coding Plan credential the service reads. */
export const OPENCODE_CONFIG_PATH = join(homedir(), '.config', 'opencode', 'opencode.json')

export const ZAI_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit'

interface ZaiLimit {
  /** The window's allowance. Z.AI names this `usage`, and it is the ceiling. */
  usage?: unknown
  /** How much of the allowance this window has spent. */
  currentValue?: unknown
  nextResetTime?: unknown
}

/**
 * Reads the tightest GLM Coding Plan window out of one quota response.
 *
 * The plan publishes several windows at once: a five-hour credit window and a
 * weekly one. Either can stop a turn, so the fullest window decides. Spending
 * the whole five-hour window stalls the fleet for hours even with most of the
 * week left, which reads as a broken service rather than a busy one.
 *
 * The percentage Z.AI sends is rounded, so this computes its own.
 */
export function zaiPlanCapacity(body: unknown): ProviderCapacity {
  if (typeof body !== 'object' || body === null)
    return { _tag: 'Unavailable', reason: 'The GLM Coding Plan answered no quota.' }
  const data = (body as { data?: unknown }).data
  const limits = typeof data === 'object' && data !== null ? (data as { limits?: unknown }).limits : undefined
  if (!Array.isArray(limits) || limits.length === 0)
    return { _tag: 'Unavailable', reason: 'The GLM Coding Plan answered no quota windows.' }

  let tightest: { usedPercent: number, resetsAt: string } | null = null
  for (const limit of limits as ZaiLimit[]) {
    if (typeof limit?.usage !== 'number' || typeof limit.currentValue !== 'number' || limit.usage <= 0)
      continue
    const usedPercent = Math.max(0, Math.min(100, (limit.currentValue / limit.usage) * 100))
    if (tightest !== null && usedPercent <= tightest.usedPercent)
      continue
    const resetsAt = typeof limit.nextResetTime === 'number'
      ? new Date(limit.nextResetTime).toISOString()
      : ''
    tightest = { usedPercent, resetsAt }
  }
  return tightest === null
    ? { _tag: 'Unavailable', reason: 'The GLM Coding Plan answered no readable quota window.' }
    : { _tag: 'Available', ...tightest }
}

/**
 * Reads the GLM Coding Plan credential opencode already holds.
 *
 * opencode owns this provider, so its configuration is the one place the key
 * lives. Copying it into service configuration would give the same secret two
 * homes and let them disagree.
 */
export function readZaiApiKey(configPath: string = OPENCODE_CONFIG_PATH): string | null {
  try {
    const raw = readFileSync(configPath, 'utf8')
    const config = JSON.parse(raw) as {
      provider?: Record<string, { options?: { apiKey?: unknown } }>
    }
    const key = config.provider?.['zai-coding-plan']?.options?.apiKey
    return typeof key === 'string' && key.trim() !== '' ? key.trim() : null
  }
  catch {
    // No opencode configuration means the plan is not set up here. Not a fault.
    return null
  }
}

export interface ZaiCapacityOptions {
  apiKey?: string | null
  fetchQuota?: (apiKey: string, signal: AbortSignal) => Promise<unknown>
  timeoutMilliseconds?: number
}

/** Asks the GLM Coding Plan what its windows have left. */
export async function readZaiCapacity(options: ZaiCapacityOptions = {}): Promise<ProviderCapacity> {
  const apiKey = options.apiKey === undefined ? readZaiApiKey() : options.apiKey
  if (apiKey === null)
    return { _tag: 'Unpublished' }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMilliseconds ?? 10_000)
  timeout.unref()
  try {
    const body = options.fetchQuota === undefined
      ? await fetch(ZAI_QUOTA_URL, {
          headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
          signal: controller.signal,
        }).then(async (response) => {
          if (!response.ok)
            throw new Error(`The GLM Coding Plan answered ${response.status}.`)
          return response.json() as Promise<unknown>
        })
      : await options.fetchQuota(apiKey, controller.signal)
    return zaiPlanCapacity(body)
  }
  catch (error) {
    // Never let the key reach a log. Only the shape of the failure is reported.
    return {
      _tag: 'Unavailable',
      reason: error instanceof Error && error.name === 'AbortError'
        ? 'The GLM Coding Plan quota request timed out.'
        : 'The GLM Coding Plan quota could not be read.',
    }
  }
  finally {
    clearTimeout(timeout)
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
  reservePercent: Record<AgentProviderName, number>
}): AgentProviderName | null {
  return input.order.find(
    provider => hasSpendableCapacity(input.capacity(provider), input.reservePercent[provider]),
  ) ?? null
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
  readOpencode?: () => Promise<ProviderCapacity>
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
  const readOpencode = options.readOpencode ?? (() => readZaiCapacity())
  let codex: ProviderCapacity = { _tag: 'Unavailable', reason: 'The Codex weekly window has not been read yet.' }
  let opencode: ProviderCapacity = { _tag: 'Unavailable', reason: 'The GLM Coding Plan quota has not been read yet.' }
  let timer: NodeJS.Timeout | undefined
  let stopped = true
  let active: Promise<void> = Promise.resolve()

  const refresh = (): Promise<void> => {
    active = active
      .then(async () => {
        // One failing provider must not stop the other being read, or a Codex
        // outage would make opencode look exhausted and stop the fleet.
        const [nextCodex, nextOpencode] = await Promise.all([
          readCodex().catch(() => ({ _tag: 'Unavailable', reason: 'The Codex weekly window could not be read.' }) as ProviderCapacity),
          readOpencode().catch(() => ({ _tag: 'Unavailable', reason: 'The GLM Coding Plan quota could not be read.' }) as ProviderCapacity),
        ])
        codex = nextCodex
        opencode = nextOpencode
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
    read: provider => provider === 'codex' ? codex : opencode,
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
