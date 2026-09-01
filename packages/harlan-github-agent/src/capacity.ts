import type { AgentProviderName } from './agent-provider.ts'
import type { AgentControl, AgentSelection, AgentStartState, ProviderCapacity, ProviderCapacityStatus, RestartRequest } from './types.ts'
import { restartAllowsTaskClaims } from './restart-request.ts'

/** Whether unattended work may spend this provider's limit right now. */
export function hasSpendableCapacity(capacity: ProviderCapacity, reservePercent: number): boolean {
  if (capacity._tag === 'Unpublished')
    return true
  if (capacity._tag === 'Unavailable')
    return false
  return 100 - capacity.usedPercent > reservePercent
}

/** Picks the first Agent provider in preference order that may spend. */
export function chooseAgentProvider(input: {
  capacity: (provider: AgentProviderName) => ProviderCapacity
  order: readonly AgentProviderName[]
  reservePercent: Record<AgentProviderName, number>
}): AgentProviderName | null {
  return input.order.find(
    provider => hasSpendableCapacity(input.capacity(provider), input.reservePercent[provider]),
  ) ?? null
}

/** Resolves the same scheduler state for every dashboard client. */
export function resolveAgentStartState(input: {
  mutationsEnabled: boolean
  agentControl: AgentControl
  restartRequest: RestartRequest | null
  agentSelection: AgentSelection
  providerCapacities: readonly ProviderCapacityStatus[]
}): AgentStartState {
  if (!input.mutationsEnabled)
    return { _tag: 'WritesDisabled' }
  if (input.agentControl._tag === 'Paused')
    return { _tag: 'Paused' }
  if (!restartAllowsTaskClaims(input.restartRequest))
    return { _tag: 'RestartRequested' }
  if (input.agentSelection._tag !== 'Automatic')
    return { _tag: 'Available' }

  const capacities = new Map(input.providerCapacities.map(entry => [entry.provider, entry]))
  const selected = input.agentSelection.order.map(provider => capacities.get(provider))
  if (selected.some(entry => entry !== undefined && hasSpendableCapacity(entry.capacity, entry.reservePercent)))
    return { _tag: 'Available' }
  // A Reserve a person can lower outranks a provider that would not answer.
  // One unreadable provider used to name the whole state CapacityUnavailable,
  // which reads as a broken provider API. The truth was that the other
  // provider had published its usage and only its own Reserve stopped it.
  if (selected.some(entry => entry !== undefined && entry.capacity._tag === 'Available'))
    return { _tag: 'ReserveReached' }
  if (selected.some(entry => entry === undefined || entry.capacity._tag === 'Unavailable'))
    return { _tag: 'CapacityUnavailable' }
  return { _tag: 'ReserveReached' }
}

/**
 * Why no Agent may start, in one line, or null while one may.
 *
 * A Reserve that stops every claim is a designed answer and it was silent.
 * Twenty seven Tasks waited seven hours behind one, with no log line and no
 * Incident, and the only place that said so was the Dashboard.
 */
export function agentStartBlockedReason(input: {
  startState: AgentStartState
  queuedTasks: number
  agentSelection: AgentSelection
  providerCapacities: readonly ProviderCapacityStatus[]
}): string | null {
  if (input.startState._tag !== 'ReserveReached' && input.startState._tag !== 'CapacityUnavailable')
    return null
  if (input.queuedTasks === 0)
    return null
  const order = new Set<AgentProviderName>(input.agentSelection._tag === 'Automatic'
    ? input.agentSelection.order
    : [])
  const detail = input.providerCapacities
    .filter(entry => order.has(entry.provider))
    .map((entry) => {
      if (entry.capacity._tag === 'Unavailable')
        // The provider's own reason may end in a stop. One sentence, one stop.
        return `${entry.provider} did not report a limit: ${entry.capacity.reason.replace(/\.+$/, '')}`
      if (entry.capacity._tag === 'Unpublished')
        return `${entry.provider} publishes no limit`
      return `${entry.provider} used ${entry.capacity.usedPercent.toFixed(1)}% and reserves ${entry.reservePercent}%, resetting ${entry.capacity.resetsAt}`
    })
  const tasks = input.queuedTasks === 1 ? '1 queued Task' : `${input.queuedTasks} queued Tasks`
  const head = input.startState._tag === 'ReserveReached'
    ? `Every Agent provider reached its Reserve, so ${tasks} cannot start.`
    : `No Agent provider reported spendable capacity, so ${tasks} cannot start.`
  return detail.length === 0 ? head : `${head} ${detail.join('. ')}.`
}
