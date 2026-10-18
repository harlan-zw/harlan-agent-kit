import type { TerminalCapacity } from '../dashboard/app/utils/terminal-capacity.ts'
import { expect, it } from 'vitest'
import { terminalForceAvailable } from '../dashboard/app/utils/terminal-capacity.ts'
import { retainedTerminalLaunch, terminalLaunchBlocked, terminalLaunchIntent } from '../dashboard/app/utils/terminal-launch.ts'

const full = { _tag: 'Available', manualPolicy: { _tag: 'Enabled' }, manual: { _tag: 'AtCapacity', reason: 'OverrideSlots' } } as Extract<TerminalCapacity, { _tag: 'Available' }>
const previous = { requestId: 'retained-request', projectId: 'project', provider: 'codex', initialPrompt: 'original prompt', mode: 'Force' } as const
const selection = { projectId: 'project', provider: 'codex', initialPrompt: 'original prompt' } as const

it('keeps a receipt recovery available after its reservation consumed the last slot', () => {
  const retry = retainedTerminalLaunch(previous, selection)
  expect(terminalForceAvailable(full)).toBe(false)
  expect(terminalForceAvailable(full, retry?.requestId)).toBe(true)
  expect(terminalLaunchIntent(retry, selection, 'must-not-be-used', 'Force')).toEqual(previous)
})
it.each([
  { ...selection, projectId: 'different' },
  { ...selection, provider: 'claude' as const },
  { ...selection, initialPrompt: 'edited prompt' },
])('does not turn edited input into a capacity-exempt retry: %j', (changed) => {
  const retry = retainedTerminalLaunch(previous, changed)
  expect(retry).toBeUndefined()
  expect(terminalLaunchBlocked(previous, changed)).toBe(true)
  expect(terminalForceAvailable(full, retry?.requestId)).toBe(false)
})
it('allows new force requests only when manual admission is available', () => {
  expect(retainedTerminalLaunch(undefined, selection)).toBeUndefined()
  expect(terminalLaunchBlocked(undefined, selection)).toBe(false)
  expect(terminalLaunchBlocked(previous, selection)).toBe(false)
  expect(terminalForceAvailable({ _tag: 'Unavailable' })).toBe(false)
  expect(terminalForceAvailable({ ...full, manual: { _tag: 'Allowed' } })).toBe(true)
  expect(terminalForceAvailable({ ...full, manualPolicy: { _tag: 'Disabled' } })).toBe(false)
})
