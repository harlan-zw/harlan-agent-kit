import { expect, it } from 'vitest'
import { agentSlotSizing, agentSlotSizingLine } from '../src/host-memory.ts'

it('grants whole Agent allocations within the service memory limit', () => {
  expect(agentSlotSizing(16, 18 * 1024 ** 3, 8).granted).toBe(2)
  expect(agentSlotSizing(1, 18 * 1024 ** 3, 8).granted).toBe(1)
  expect(agentSlotSizing(4, 4 * 1024 ** 3, 8).granted).toBe(0)
})

it('grants more Agents when one Agent is assumed to need less memory', () => {
  expect(agentSlotSizing(4, 22 * 1024 ** 3, 8).granted).toBe(2)
  expect(agentSlotSizing(4, 22 * 1024 ** 3, 5).granted).toBe(4)
})

it('names the clamp and how to lift it when memory grants fewer Agents', () => {
  const line = agentSlotSizingLine(agentSlotSizing(4, 22 * 1024 ** 3, 8))
  expect(line).toContain('Agent slots: 2 of 4 requested')
  expect(line).toContain('agent.memory_per_agent_gib')
})

it('names no remedy when memory grants every requested Agent', () => {
  const line = agentSlotSizingLine(agentSlotSizing(2, 22 * 1024 ** 3, 8))
  expect(line).toContain('Agent slots: 2 of 2 requested')
  expect(line).not.toContain('agent.memory_per_agent_gib')
})
