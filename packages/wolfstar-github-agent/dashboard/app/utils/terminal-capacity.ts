import type { TerminalCapacityParseResult } from '../../../src/terminal-capacity.ts'
import { parseHostTerminalCapacity } from '../../../src/terminal-capacity.ts'

export type { TerminalCapacity } from '../../../src/terminal-capacity.ts'

export function parseTerminalCapacity(input: unknown): TerminalCapacityParseResult {
  const invalid = { _tag: 'Err', reason: 'InvalidRequest' } as const
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid
  const value = input as Record<string, unknown>
  if (value._tag === 'Unavailable')
    return Object.keys(value).length === 1 ? { _tag: 'Ok', value: { _tag: 'Unavailable' } } : invalid
  const fields = [
    '_tag',
    'memoryGiB',
    'reservedGiB',
    'agentSlots',
    'agentSlotsUsed',
    'maintenanceReserve',
    'forcedGiB',
    'sessionMemoryGiB',
    'memory',
    'manualPolicy',
    'regular',
    'manual',
  ]
  if (
    value._tag !== 'Available' ||
    Object.keys(value).length !== fields.length ||
    !Object.keys(value).every((key) => fields.includes(key))
  )
    return invalid
  return parseHostTerminalCapacity({ ...value, _tag: 'Capacity' })
}
