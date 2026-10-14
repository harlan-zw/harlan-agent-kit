import type { AgentProviderName } from './agent-provider.ts'
import type {
  AgentControl,
  AgentProfile,
  AgentSelection,
  AgentStartState,
  DashboardSnapshot,
  ProviderCapacity,
  ProviderCapacityStatus,
  RestartRequest,
} from './types.ts'
import { restartAllowsTaskClaims } from './restart-request.ts'

/** Whether unattended work may spend this provider's limit right now. */
export function hasSpendableCapacity(capacity: ProviderCapacity, reservePercent: number): boolean {
  if (capacity._tag === 'Unpublished') return true
  if (capacity._tag === 'Unavailable') return false
  return 100 - capacity.usedPercent > reservePercent
}

/** Picks the first Agent provider in preference order that may spend. */
export function chooseAgentProvider(input: {
  capacity: (provider: AgentProviderName) => ProviderCapacity
  order: readonly AgentProviderName[]
  reservePercent: Record<AgentProviderName, number>
}): AgentProviderName | null {
  return (
    input.order.find((provider) => hasSpendableCapacity(input.capacity(provider), input.reservePercent[provider])) ??
    null
  )
}

/** Resolves the same scheduler state for every dashboard client. */
export function resolveAgentStartState(input: {
  mutationsEnabled: boolean
  agentControl: AgentControl
  restartRequest: RestartRequest | null
  agentSelection: AgentSelection
  agentProfile?: Pick<AgentProfile, 'provider'>
  providerCapacities: readonly ProviderCapacityStatus[]
}): AgentStartState {
  if (!input.mutationsEnabled) return { _tag: 'WritesDisabled' }
  if (input.agentControl._tag === 'Paused') return { _tag: 'Paused' }
  if (!restartAllowsTaskClaims(input.restartRequest)) return { _tag: 'RestartRequested' }
  const capacities = new Map(input.providerCapacities.map((entry) => [entry.provider, entry]))
  const order =
    input.agentSelection._tag === 'Automatic'
      ? input.agentSelection.order
      : input.agentSelection._tag === 'Pinned'
        ? [input.agentSelection.provider]
        : [input.agentProfile?.provider ?? input.providerCapacities[0]?.provider].filter(
            (provider): provider is AgentProviderName => provider !== undefined,
          )
  const selected = order.map((provider) => capacities.get(provider))
  if (selected.some((entry) => entry !== undefined && hasSpendableCapacity(entry.capacity, entry.reservePercent)))
    return { _tag: 'Available' }
  // A Reserve a person can lower outranks a provider that would not answer.
  // One unreadable provider used to name the whole state CapacityUnavailable,
  // which reads as a broken provider API. The truth was that the other
  // provider had published its usage and only its own Reserve stopped it.
  if (selected.some((entry) => entry !== undefined && entry.capacity._tag === 'Available'))
    return { _tag: 'ReserveReached' }
  if (selected.some((entry) => entry === undefined || entry.capacity._tag === 'Unavailable'))
    return { _tag: 'CapacityUnavailable' }
  return { _tag: 'ReserveReached' }
}

/** Model choices in one OpenCode CLI use different subscriptions. */
export function selectedModelCapacity(
  snapshot: Pick<DashboardSnapshot, 'agentModelCapacities' | 'providerCapacities'>,
  provider: AgentProviderName,
  model: string | null | undefined,
): ProviderCapacity {
  if (provider === 'opencode' && model?.startsWith('opencode-go/'))
    return (
      snapshot.agentModelCapacities?.opencodeGo ?? {
        _tag: 'Unavailable',
        reason: 'Reload Service data to check OpenCode Go.',
      }
    )
  if (provider === 'opencode' && model?.startsWith('zai-coding-plan/'))
    return (
      snapshot.agentModelCapacities?.zaiCodingPlan ??
      snapshot.providerCapacities.find((entry) => entry.provider === provider)?.capacity ?? {
        _tag: 'Unavailable',
        reason: 'Usage is unavailable.',
      }
    )
  if (provider === 'opencode' && model != null) return { _tag: 'Unpublished' }
  return (
    snapshot.providerCapacities.find((entry) => entry.provider === provider)?.capacity ?? {
      _tag: 'Unavailable',
      reason: 'Usage is unavailable.',
    }
  )
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
  runningTasks: number
  agentSelection: AgentSelection
  providerCapacities: readonly ProviderCapacityStatus[]
}): string | null {
  if (input.startState._tag !== 'ReserveReached' && input.startState._tag !== 'CapacityUnavailable') return null
  if (input.queuedTasks === 0) return null
  // A capacity reading can miss a provider or fail for one pass, and that read
  // alone named the whole fleet blocked while six Agents were working. An Agent
  // holding a Task is proof that claims are not blocked, whatever one reading
  // of a provider limit says.
  if (input.runningTasks > 0) return null
  const order = new Set<AgentProviderName>(
    input.agentSelection._tag === 'Automatic'
      ? input.agentSelection.order
      : input.agentSelection._tag === 'Pinned'
        ? [input.agentSelection.provider]
        : input.providerCapacities.map((entry) => entry.provider),
  )
  const detail = input.providerCapacities
    .filter((entry) => order.has(entry.provider))
    .map((entry) => {
      if (entry.capacity._tag === 'Unavailable')
        // The provider's own reason may end in a stop. One sentence, one stop.
        return `${entry.provider} did not report a limit: ${entry.capacity.reason.replace(/\.+$/, '')}`
      if (entry.capacity._tag === 'Unpublished') return `${entry.provider} publishes no limit`
      return `${entry.provider} used ${entry.capacity.usedPercent.toFixed(1)}% and reserves ${entry.reservePercent}%, resetting ${entry.capacity.resetsAt}`
    })
  const tasks = input.queuedTasks === 1 ? '1 queued Task' : `${input.queuedTasks} queued Tasks`
  const head =
    input.startState._tag === 'ReserveReached'
      ? `Every Agent provider reached its Reserve, so ${tasks} cannot start.`
      : `No Agent provider reported spendable capacity, so ${tasks} cannot start.`
  return detail.length === 0 ? head : `${head} ${detail.join('. ')}.`
}
