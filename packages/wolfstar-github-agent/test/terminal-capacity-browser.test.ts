import { describe, expect, it } from 'vitest'
import { parseTerminalCapacity } from '../dashboard/app/utils/terminal-capacity.ts'
import { parseHostTerminalCapacity } from '../src/terminal-capacity.ts'

const available = {
  _tag: 'Available',
  agentSlots: 4,
  agentSlotsUsed: 4,
  maintenanceReserve: 1,
  memoryGiB: 42,
  reservedGiB: 48,
  forcedGiB: 8,
  sessionMemoryGiB: 8,
  memory: { _tag: 'Physical', availableGiB: 58, totalGiB: 96 },
  manualPolicy: { _tag: 'Enabled', memoryGiB: 56, agentSlotsMax: 6, physicalReserveGiB: 4 },
  regular: { _tag: 'AtCapacity', reason: 'Slots' },
  manual: { _tag: 'Allowed' },
}
const invalid = { _tag: 'Err', reason: 'InvalidRequest' }

describe('aggregate terminal host memory boundary', () => {
  it('parses manual overcommit into owned aggregate data', () => {
    const input = structuredClone(available)
    const result = parseTerminalCapacity(input)
    input.memory.availableGiB = 0
    expect(result).toEqual({ _tag: 'Ok', value: available })
  })
  it('removes private diagnostics and process records from root observations', () => {
    const root = {
      ...available,
      _tag: 'Capacity',
      memory: { _tag: 'Unknown', reason: '/private/command PID 127' },
      regular: { _tag: 'Unavailable', reason: 'unit-private' },
      reservations: { secret: { pid: 127 } },
    }
    const parsed = parseHostTerminalCapacity(root)
    expect(parsed).toEqual({
      _tag: 'Ok',
      value: { ...available, memory: { _tag: 'Unknown' }, regular: { _tag: 'Unavailable' } },
    })
    expect(JSON.stringify(parsed)).not.toContain('private')
    expect(JSON.stringify(parsed)).not.toContain('127')
  })
  it('keeps unavailable distinct from malformed data', () => {
    expect(parseTerminalCapacity({ _tag: 'Unavailable' })).toEqual({ _tag: 'Ok', value: { _tag: 'Unavailable' } })
    expect(parseTerminalCapacity({ _tag: 'Unknown' })).toEqual(invalid)
  })
  it.each(['agentSlots', 'agentSlotsUsed', 'maintenanceReserve'] as const)('rejects invalid %s values', (field) => {
    for (const value of [-1, 257, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '2', null, undefined])
      expect(parseTerminalCapacity({ ...available, [field]: value })).toEqual(invalid)
  })
  it.each(['memoryGiB', 'reservedGiB', 'forcedGiB'] as const)('rejects invalid %s values', (field) => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, '16', null, undefined])
      expect(parseTerminalCapacity({ ...available, [field]: value })).toEqual(invalid)
  })
  it('rejects mismatched session charge, slot protection, and physical observations', () => {
    for (const value of [
      { ...available, sessionMemoryGiB: 1 },
      { ...available, maintenanceReserve: 5 },
      { ...available, forcedGiB: 49 },
      { ...available, memory: { _tag: 'Physical', availableGiB: 100, totalGiB: 96 } },
      { ...available, manual: { _tag: 'AtCapacity', reason: 'private-process' } },
    ])
      expect(parseTerminalCapacity(value)).toEqual(invalid)
  })
  it.each([null, [], 'Available', {}, { ...available, extra: true }, { _tag: 'Unavailable', agentSlots: 2 }])(
    'rejects malformed browser response shapes',
    (value) => {
      expect(parseTerminalCapacity(value)).toEqual(invalid)
    },
  )
})
