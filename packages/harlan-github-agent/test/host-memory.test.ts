import { expect, it } from 'vitest'
import { agentSlotLine, agentSlotSizing } from '../src/host-memory.ts'

it('suggests whole Agent allocations within the service memory limit', () => {
  expect(agentSlotSizing(16, 18 * 1024 ** 3, 8).suggested).toBe(2)
  expect(agentSlotSizing(1, 18 * 1024 ** 3, 8).suggested).toBe(1)
  expect(agentSlotSizing(4, 4 * 1024 ** 3, 8).suggested).toBe(0)
})

it('suggests more Agents when one Agent is assumed to need less memory', () => {
  expect(agentSlotSizing(4, 22 * 1024 ** 3, 8).suggested).toBe(2)
  expect(agentSlotSizing(4, 22 * 1024 ** 3, 5).suggested).toBe(4)
})

it('warns when the Agent slots in force ask for more than memory suggests', () => {
  const line = agentSlotLine({ hogwild: 4, desktop: 1 }, agentSlotSizing(4, 22 * 1024 ** 3, 8))
  expect(line).toContain('Agent slots: 4 on Hogwild, 1 on the desktop.')
  expect(line).toContain('Host memory suggests 2 at 8 GiB for each Agent')
  expect(line).toContain('Hogwild may run out of memory.')
})

it('warns about nothing when the Agent slots in force fit the memory suggestion', () => {
  const line = agentSlotLine({ hogwild: 2, desktop: 0 }, agentSlotSizing(4, 22 * 1024 ** 3, 8))
  expect(line).toContain('Agent slots: 2 on Hogwild, 0 on the desktop.')
  expect(line).not.toContain('may run out of memory')
})
