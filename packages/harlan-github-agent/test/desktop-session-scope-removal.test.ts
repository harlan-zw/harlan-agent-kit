import { beforeEach, expect, it, vi } from 'vitest'
import { desktopSessionScopeInvocation, stopDesktopSessionScope } from '../src/desktop-session-scope.ts'

const boundary = vi.hoisted(() => ({
  readFile: vi.fn(),
  execFile: vi.fn(),
  invocation: 'current',
}))
vi.mock('node:fs/promises', () => ({ readFile: boundary.readFile }))
vi.mock('node:child_process', () => ({ execFile: boundary.execFile }))

const unit = 'harlan-desktop-agent-123.scope'
const removed = Object.assign(new Error('The cgroup was removed.'), { code: 'ENODEV' })

beforeEach(() => {
  boundary.invocation = 'current'
  boundary.readFile.mockReset().mockImplementation(async (path: string) => {
    if (path.endsWith('cgroup.procs'))
      return '123\n'
    if (path.endsWith('/environ'))
      return Buffer.from('HARLAN_SESSION_PROCESS_OWNER=owner\0')
    return 'populated 0\n'
  })
  boundary.execFile.mockReset().mockImplementation((_file, args, options, callback) => {
    const done = typeof options === 'function' ? options : callback
    const stopped = boundary.execFile.mock.calls.some(call => call[1].includes('stop'))
    const stdout = args.includes('show')
      ? `LoadState=loaded\nControlGroup=/test.scope\nActiveState=${stopped ? 'inactive' : 'active'}\nInvocationID=${boundary.invocation}\n`
      : ''
    done(null, { stdout, stderr: '' })
  })
})

it.each(['poll', 'after stop'])('stops when the cgroup disappears during %s reads', async (stage) => {
  boundary.readFile.mockImplementation(async () => {
    const stopped = boundary.execFile.mock.calls.some(call => call[1].includes('stop'))
    if (stage === 'poll' || stopped)
      throw removed
    return 'populated 0\n'
  })
  await stopDesktopSessionScope(unit, { invocation: 'current' })
  expect(boundary.execFile.mock.calls.map(call => call[1])).toContainEqual(['--user', 'stop', unit])
})

it('does not bind or stop a scope whose owner disappeared during a cgroup read', async () => {
  boundary.readFile.mockRejectedValue(removed)
  expect(await desktopSessionScopeInvocation(unit, 'owner')).toBeUndefined()
  await expect(stopDesktopSessionScope(unit, { owner: 'owner' })).rejects.toThrow('owner cannot be verified')
  expect(boundary.execFile.mock.calls.every(call => call[1].includes('show'))).toBe(true)
})

it.each(['EACCES', 'EIO'])('propagates %s instead of acknowledging Stop', async (code) => {
  const failure = Object.assign(new Error('The cgroup read failed.'), { code })
  boundary.readFile.mockRejectedValue(failure)
  await expect(stopDesktopSessionScope(unit, { invocation: 'current' })).rejects.toBe(failure)
  expect(boundary.execFile.mock.calls.some(call => call[1].includes('stop'))).toBe(false)
})

it('leaves a replacement invocation untouched even when cgroup reads would fail', async () => {
  boundary.invocation = 'replacement'
  boundary.readFile.mockRejectedValue(removed)
  await stopDesktopSessionScope(unit, { invocation: 'previous' })
  expect(boundary.execFile.mock.calls.map(call => call[1])).toEqual([
    ['--user', 'show', unit, '--property=LoadState,ControlGroup,ActiveState,InvocationID'],
  ])
  expect(boundary.readFile).not.toHaveBeenCalled()
})
