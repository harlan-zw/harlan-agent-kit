export type TerminalCapacity =
  | {
      _tag: 'Available'
      agentSlots: number
      maintenanceReserve: number
      interactiveFree: number
      memoryGiB: number
      reservedGiB: number
    }
  | { _tag: 'Unavailable' }

export type TerminalCapacityParseResult =
  | { _tag: 'Ok'; value: TerminalCapacity }
  | { _tag: 'Err'; reason: 'InvalidRequest' }

function isSlotCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 256
}

function isFiniteMemory(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

export function parseTerminalCapacity(input: unknown): TerminalCapacityParseResult {
  const invalid = { _tag: 'Err', reason: 'InvalidRequest' } as const
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid

  const value = input as Record<string, unknown>
  const keys = Object.keys(value)
  if (value._tag === 'Unavailable') return keys.length === 1 ? { _tag: 'Ok', value: { _tag: 'Unavailable' } } : invalid

  if (
    value._tag !== 'Available' ||
    keys.length !== 6 ||
    !keys.every((key) =>
      ['_tag', 'agentSlots', 'maintenanceReserve', 'interactiveFree', 'memoryGiB', 'reservedGiB'].includes(key),
    ) ||
    !isSlotCount(value.agentSlots) ||
    !isSlotCount(value.maintenanceReserve) ||
    !isSlotCount(value.interactiveFree) ||
    value.maintenanceReserve > value.agentSlots ||
    value.interactiveFree > value.agentSlots ||
    !isFiniteMemory(value.memoryGiB) ||
    value.memoryGiB === 0 ||
    value.memoryGiB > 256 ||
    !isFiniteMemory(value.reservedGiB)
  ) {
    return invalid
  }

  return {
    _tag: 'Ok',
    value: {
      _tag: 'Available',
      agentSlots: value.agentSlots,
      maintenanceReserve: value.maintenanceReserve,
      interactiveFree: value.interactiveFree,
      memoryGiB: value.memoryGiB,
      reservedGiB: value.reservedGiB,
    },
  }
}
