import type { AgentProviderName } from '../../../src/agent-provider.ts'
import type { CronExpression } from '../../../src/routine-schedule.ts'
import type {
  AgentStartState,
  DashboardSnapshot,
  ProviderCapacityStatus,
  ProviderCircuit,
  RestartRequest,
  Routine,
} from '../../../src/types.ts'
import { hasSpendableCapacity } from '../../../src/capacity.ts'
import { matchesCron, parseCron, wallClockParts } from '../../../src/routine-schedule.ts'

/**
 * Pure presentation for the System chip, the System slideover, and the banners.
 *
 * Nothing here reads the clock or the DOM. The composable passes the snapshot
 * in and the components render what comes back.
 */

export const providerLabels: Record<AgentProviderName, string> = {
  codex: 'Codex',
  opencode: 'opencode',
}

export interface SystemChipCounts {
  active: number
  maximum: number
  /** Pulse only while an agent is actually running. */
  live: boolean
}

export type SystemChipState
  = | { _tag: 'Loading' }
    | ({ _tag: 'Normal' } & SystemChipCounts)
    | ({ _tag: 'CannotStart', reason: string } & SystemChipCounts)
    | ({ _tag: 'Incident', incidents: number } & SystemChipCounts)

const cannotStartReasons: Record<Exclude<AgentStartState['_tag'], 'Available'>, string> = {
  Paused: 'Paused',
  WritesDisabled: 'Writes off',
  ReserveReached: 'Reserve reached',
  CapacityUnavailable: 'No capacity',
  RestartRequested: 'Restarting after current work',
}

/**
 * Manual is the reason nothing starts only when every candidate waits on Harlan.
 *
 * With work already queued or running, Manual changes nothing about the next
 * start, so naming it on the chip would be noise.
 */
function manualHoldsQueue(snapshot: DashboardSnapshot): boolean {
  if (snapshot.selectionMode !== 'manual')
    return false
  const startable = snapshot.queue.some(entry => entry.state._tag === 'Active' || entry.state._tag === 'Queued')
  const awaiting = snapshot.queue.some(entry => entry.state._tag === 'AwaitingApproval')
  return !startable && awaiting
}

/**
 * The two facts the chip must carry without opening the pane: capacity and whether an Incident is open.
 *
 * A placeholder snapshot has no `generatedAt`, so it reports nothing: a reason
 * the controller never sent must not render as amber.
 */
export function systemChipState(snapshot: DashboardSnapshot): SystemChipState {
  if (snapshot.generatedAt.length === 0)
    return { _tag: 'Loading' }
  const active = snapshot.agents.filter(agent => agent._tag === 'ActiveAgent').length
  const counts: SystemChipCounts = { active, maximum: snapshot.agentProfile.maximumActiveAgents, live: active > 0 }
  if (snapshot.incidents.length > 0)
    return { _tag: 'Incident', incidents: snapshot.incidents.length, ...counts }
  if (snapshot.agentStart._tag !== 'Available')
    return { _tag: 'CannotStart', reason: cannotStartReasons[snapshot.agentStart._tag], ...counts }
  if (manualHoldsQueue(snapshot))
    return { _tag: 'CannotStart', reason: 'Manual', ...counts }
  return { _tag: 'Normal', ...counts }
}

export interface CapacityRow {
  provider: AgentProviderName
  name: string
  /** Mono, the number that changes while you watch. */
  value: string
  detail: string
  resetsAt: string | null
  tone: 'neutral' | 'warning'
}

export function capacityRow(entry: ProviderCapacityStatus): CapacityRow {
  const name = providerLabels[entry.provider]
  if (entry.capacity._tag === 'Unavailable')
    return { provider: entry.provider, name, value: 'Unavailable', detail: entry.capacity.reason, resetsAt: null, tone: 'warning' }
  if (entry.capacity._tag === 'Unpublished')
    return { provider: entry.provider, name, value: 'Not published', detail: 'No Reserve applies', resetsAt: null, tone: 'neutral' }
  const remaining = Math.max(0, Math.round((100 - entry.capacity.usedPercent) * 10) / 10)
  const reserveReached = !hasSpendableCapacity(entry.capacity, entry.reservePercent)
  return {
    provider: entry.provider,
    name,
    value: `${remaining}% left`,
    detail: `Reserve ${entry.reservePercent}%${reserveReached ? ' reached' : ''}`,
    resetsAt: entry.capacity.resetsAt,
    tone: reserveReached ? 'warning' : 'neutral',
  }
}

export type CircuitNotice
  = | { _tag: 'Open', text: string, retryAt: string }
    | { _tag: 'HalfOpen', text: string }

/** Only an open or half open circuit says anything. Closed is the default and stays silent. */
export function circuitNotice(circuit: ProviderCircuit): CircuitNotice | undefined {
  const name = providerLabels[circuit.provider]
  if (circuit.state._tag === 'Open') {
    const failures = circuit.failures === 1 ? '1 failure' : `${circuit.failures} failures`
    return { _tag: 'Open', text: `${name} circuit is open after ${failures} (${circuit.failureClass}).`, retryAt: circuit.state.retryAt }
  }
  if (circuit.state._tag === 'HalfOpen')
    return { _tag: 'HalfOpen', text: `${name} circuit is half open. One request is testing the provider.` }
  return undefined
}

export type RestartNotice
  = | { _tag: 'Requested', text: string }
    | { _tag: 'Restarting', text: string }
    | { _tag: 'ActionRequired', text: string }

/** A Completed request is history, so it renders nothing. */
export function restartNotice(request: RestartRequest | null): RestartNotice | undefined {
  if (request === null || request._tag === 'Completed')
    return undefined
  if (request._tag === 'Requested')
    return { _tag: 'Requested', text: 'Restart requested. Active work finishes first.' }
  if (request._tag === 'Restarting')
    return { _tag: 'Restarting', text: 'Restarting.' }
  return { _tag: 'ActionRequired', text: `Restart did not complete: ${request.reason}` }
}

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

/** Minutes to add to a UTC instant to read it as wall clock in the zone. */
function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const parts = wallClockParts(at, timeZone)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.dayOfMonth, parts.hour, parts.minute)
  return Math.round((asUtc - Math.floor(at.getTime() / MINUTE) * MINUTE) / MINUTE)
}

/**
 * The next instant one Routine answers, or nothing inside the horizon.
 *
 * Walks day by day and tries only the hours and minutes the expression names,
 * so a daily check costs a handful of zone lookups instead of ten thousand.
 */
export function nextRoutineInstant(routine: Pick<Routine, 'crons' | 'timeZone' | 'enabled'>, from: Date, horizonDays = 8): Date | undefined {
  if (!routine.enabled)
    return undefined
  const start = (Math.floor(from.getTime() / MINUTE) + 1) * MINUTE
  const expressions = routine.crons.flatMap((text) => {
    const parsed = parseCron(text)
    return parsed._tag === 'Ok' ? [parsed.value] : []
  })
  const firstMatch = (expression: CronExpression): Date | undefined => {
    const hours = [...expression.hours].sort((a, b) => a - b)
    const minutes = [...expression.minutes].sort((a, b) => a - b)
    for (let day = 0; day <= horizonDays; day += 1) {
      const anchor = new Date(start + day * DAY)
      const wall = wallClockParts(anchor, routine.timeZone)
      const midnight = Date.UTC(wall.year, wall.month - 1, wall.dayOfMonth) - zoneOffsetMinutes(anchor, routine.timeZone) * MINUTE
      for (const hour of hours) {
        for (const minute of minutes) {
          const candidate = new Date(midnight + (hour * 60 + minute) * MINUTE)
          if (candidate.getTime() >= start && matchesCron(expression, candidate, routine.timeZone))
            return candidate
        }
      }
    }
    return undefined
  }
  return expressions
    .flatMap(expression => firstMatch(expression) ?? [])
    .sort((a, b) => a.getTime() - b.getTime())[0]
}

/** The tab icon has 16 pixels, so it carries one signal: colour. */
export type FaviconTone = 'error' | 'warning' | 'success'

export function faviconTone(snapshot: DashboardSnapshot, decisions: number): FaviconTone {
  const blocking = snapshot.incidents.some(incident => incident.recovery._tag !== 'Retrying')
  const unhealthy = snapshot.repositories.some(repository => repository.lastError !== null)
  if (blocking || unhealthy)
    return 'error'
  return decisions > 0 || snapshot.incidents.length > 0 ? 'warning' : 'success'
}

/** `(n) Page · Harlan GitHub Agent`. The count leads on every page, so the tab reads the same everywhere. */
export function documentTitle(decisions: number, page?: string): string {
  const name = page === undefined ? 'Harlan GitHub Agent' : `${page} · Harlan GitHub Agent`
  return decisions > 0 ? `(${decisions}) ${name}` : name
}
