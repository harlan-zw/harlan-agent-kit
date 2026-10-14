import { expect, it } from 'vitest'
import { terminalLaunchIntent } from '../dashboard/app/utils/terminal-launch.ts'

it('keeps uncertain request identity while explicitly upgrading the requested admission mode', () => {
  const selection = { projectId: 'project', provider: 'codex' as const, initialPrompt: '--literal task' }
  const regular = terminalLaunchIntent(undefined, selection, 'stable-request', 'Regular')
  expect(terminalLaunchIntent(regular, selection, 'discarded-new-id', 'Force')).toEqual({ ...regular, mode: 'Force' })
  expect(regular.mode).toBe('Regular')
})
it('creates a new request for a different prompt rather than changing saved work', () => {
  const selection = { projectId: 'project', provider: 'codex' as const, initialPrompt: 'first task' }
  const regular = terminalLaunchIntent(undefined, selection, 'old-request', 'Regular')
  expect(terminalLaunchIntent(regular, { ...selection, initialPrompt: 'second task' }, 'new-request', 'Force')).toEqual(
    { ...selection, initialPrompt: 'second task', requestId: 'new-request', mode: 'Force' },
  )
})
