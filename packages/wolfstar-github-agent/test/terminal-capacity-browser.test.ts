import { describe, expect, it } from 'vitest'
import { parseTerminalCapacity } from '../dashboard/app/utils/terminal-capacity.ts'

const available = {
  _tag: 'Available',
  agentSlots: 2,
  maintenanceReserve: 1,
  interactiveFree: 1,
  memoryGiB: 16,
  reservedGiB: 8,
}
const invalid = { _tag: 'Err', reason: 'InvalidRequest' }

describe('browser terminal capacity boundary', () => {
  it('parses available capacity into owned data', () => {
    const input = { ...available }
    const result = parseTerminalCapacity(input)
    input.interactiveFree = 0
    expect(result).toEqual({ _tag: 'Ok', value: available })
  })
  it('keeps unavailable capacity distinct from malformed data', () => {
    expect(parseTerminalCapacity({ _tag: 'Unavailable' })).toEqual({ _tag: 'Ok', value: { _tag: 'Unavailable' } })
    expect(parseTerminalCapacity({ _tag: 'Unknown' })).toEqual(invalid)
  })
  it('supports disabled slots and fractional memory observations', () => {
    const value = {
      ...available,
      agentSlots: 0,
      maintenanceReserve: 0,
      interactiveFree: 0,
      memoryGiB: 16.5,
      reservedGiB: 24.125,
    }
    expect(parseTerminalCapacity(value)).toEqual({ _tag: 'Ok', value })
  })
  it('supports the maximum host policy and zero reserved memory', () => {
    const value = {
      ...available,
      agentSlots: 256,
      maintenanceReserve: 0,
      interactiveFree: 256,
      memoryGiB: 256,
      reservedGiB: 0,
    }
    expect(parseTerminalCapacity(value)).toEqual({ _tag: 'Ok', value })
  })
  it.each(['agentSlots', 'maintenanceReserve', 'interactiveFree'] as const)('rejects invalid %s values', (field) => {
    for (const value of [-1, 257, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '2', null, undefined])
      expect(parseTerminalCapacity({ ...available, [field]: value })).toEqual(invalid)
  })
  it.each(['agentSlots', 'maintenanceReserve', 'interactiveFree', 'memoryGiB', 'reservedGiB'] as const)(
    'requires %s',
    (field) => {
      const input: Record<string, unknown> = { ...available }
      delete input[field]
      expect(parseTerminalCapacity(input)).toEqual(invalid)
    },
  )
  it('rejects reserve or free slots beyond the host slot count', () => {
    expect(parseTerminalCapacity({ ...available, maintenanceReserve: 3 })).toEqual(invalid)
    expect(parseTerminalCapacity({ ...available, interactiveFree: 3 })).toEqual(invalid)
  })
  it.each([-1, 0, 257, Number.NaN, Number.POSITIVE_INFINITY, '16', null])(
    'rejects invalid memory budgets',
    (memoryGiB) => {
      expect(parseTerminalCapacity({ ...available, memoryGiB })).toEqual(invalid)
    },
  )
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, '8', null])('rejects invalid reserved memory', (reservedGiB) => {
    expect(parseTerminalCapacity({ ...available, reservedGiB })).toEqual(invalid)
  })
  it.each([null, [], 'Available', {}, { ...available, extra: true }, { _tag: 'Unavailable', agentSlots: 2 }])(
    'rejects malformed response shapes',
    (value) => {
      expect(parseTerminalCapacity(value)).toEqual(invalid)
    },
  )
})
