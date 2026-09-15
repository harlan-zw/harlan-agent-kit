import { expect, it } from 'vitest'
import { agentSlotsForMemory } from '../src/host-memory.ts'

it('reserves whole Agent allocations within the service memory limit', () => {
  expect(agentSlotsForMemory(16, 18 * 1024 ** 3, 8)).toBe(2)
  expect(agentSlotsForMemory(1, 18 * 1024 ** 3, 8)).toBe(1)
  expect(agentSlotsForMemory(4, 4 * 1024 ** 3, 8)).toBe(0)
})
