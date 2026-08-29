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
  if (selected.some(entry => entry === undefined || entry.capacity._tag === 'Unavailable'))
    return { _tag: 'CapacityUnavailable' }
  return { _tag: 'ReserveReached' }
}
