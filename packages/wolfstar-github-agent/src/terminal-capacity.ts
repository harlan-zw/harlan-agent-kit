export type TerminalMemoryDecision =
  | { _tag: 'Allowed' }
  | {
      _tag: 'AtCapacity'
      reason: 'Memory' | 'MemoryPressure' | 'Slots' | 'MaintenanceReserve' | 'OverrideMemory' | 'OverrideSlots'
    }
  | { _tag: 'Unavailable' }
export type TerminalCapacity =
  | {
      _tag: 'Available'
      memoryGiB: number
      reservedGiB: number
      agentSlots: number
      agentSlotsUsed: number
      maintenanceReserve: number
      forcedGiB: number
      sessionMemoryGiB: number
      memory:
        | { _tag: 'Physical'; availableGiB: number; totalGiB: number }
        | { _tag: 'Available'; availableGiB: number }
        | { _tag: 'Unknown' }
      manualPolicy:
        | { _tag: 'Disabled' }
        | { _tag: 'Enabled'; memoryGiB: number; agentSlotsMax: number; physicalReserveGiB: number }
      regular: TerminalMemoryDecision
      manual: TerminalMemoryDecision
    }
  | { _tag: 'Unavailable' }
export type TerminalCapacityParseResult =
  | { _tag: 'Ok'; value: TerminalCapacity }
  | { _tag: 'Err'; reason: 'InvalidRequest' }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
function memory(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 4096
}
function slots(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 256
}
function decision(input: unknown): TerminalMemoryDecision | undefined {
  const value = record(input)
  if (value?._tag === 'Allowed' || value?._tag === 'Unavailable') return { _tag: value._tag }
  if (
    value?._tag === 'AtCapacity' &&
    typeof value.reason === 'string' &&
    ['Memory', 'MemoryPressure', 'Slots', 'MaintenanceReserve', 'OverrideMemory', 'OverrideSlots'].includes(
      value.reason,
    )
  )
    return {
      _tag: 'AtCapacity',
      reason: value.reason as Extract<TerminalMemoryDecision, { _tag: 'AtCapacity' }>['reason'],
    }
}

// Root diagnostics remain private. Browser responses contain aggregate memory and policy only.
export function parseHostTerminalCapacity(input: unknown): TerminalCapacityParseResult {
  const invalid = { _tag: 'Err', reason: 'InvalidRequest' } as const
  const value = record(input)
  if (!value || value._tag !== 'Capacity') return invalid
  if (
    !memory(value.memoryGiB) ||
    value.memoryGiB === 0 ||
    !memory(value.reservedGiB) ||
    !memory(value.forcedGiB) ||
    value.forcedGiB > value.reservedGiB ||
    value.sessionMemoryGiB !== 8 ||
    !slots(value.agentSlots) ||
    !slots(value.agentSlotsUsed) ||
    !slots(value.maintenanceReserve) ||
    value.maintenanceReserve > value.agentSlots
  ) {
    return invalid
  }
  const observed = record(value.memory)
  const policy = record(value.manualPolicy)
  const regular = decision(value.regular)
  const manual = decision(value.manual)
  if (!observed || !policy || !regular || !manual) return invalid
  let physical: Extract<TerminalCapacity, { _tag: 'Available' }>['memory']
  if (observed._tag === 'Unknown') physical = { _tag: 'Unknown' }
  else if (
    observed._tag === 'Physical' &&
    memory(observed.availableGiB) &&
    memory(observed.totalGiB) &&
    observed.availableGiB <= observed.totalGiB
  )
    physical = { _tag: 'Physical', availableGiB: observed.availableGiB, totalGiB: observed.totalGiB }
  else if (observed._tag === 'Available' && memory(observed.availableGiB))
    physical = { _tag: 'Available', availableGiB: observed.availableGiB }
  else return invalid
  let manualPolicy: Extract<TerminalCapacity, { _tag: 'Available' }>['manualPolicy']
  if (policy._tag === 'Disabled') manualPolicy = { _tag: 'Disabled' }
  else if (
    policy._tag === 'Enabled' &&
    memory(policy.memoryGiB) &&
    slots(policy.agentSlotsMax) &&
    memory(policy.physicalReserveGiB)
  )
    manualPolicy = {
      _tag: 'Enabled',
      memoryGiB: policy.memoryGiB,
      agentSlotsMax: policy.agentSlotsMax,
      physicalReserveGiB: policy.physicalReserveGiB,
    }
  else return invalid
  return {
    _tag: 'Ok',
    value: {
      _tag: 'Available',
      memoryGiB: value.memoryGiB,
      reservedGiB: value.reservedGiB,
      agentSlots: value.agentSlots,
      agentSlotsUsed: value.agentSlotsUsed,
      maintenanceReserve: value.maintenanceReserve,
      forcedGiB: value.forcedGiB,
      sessionMemoryGiB: value.sessionMemoryGiB,
      memory: physical,
      manualPolicy,
      regular,
      manual,
    },
  }
}
