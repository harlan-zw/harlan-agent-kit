import type { TerminalSession } from '../src/terminal-protocol.ts'
import { expect, it } from 'vitest'
import { activeTerminalSession, emptyTerminalProjectLayout, reconcileTerminalLayout, reconcileTerminalSessions, updateTerminalProjectLayout } from '../dashboard/app/utils/terminal-layout.ts'

function session(id: string, state: TerminalSession['state'] = 'Running'): TerminalSession {
  return { id, state, projectId: 'project', provider: 'codex', generation: id, hostId: 'host', bootId: 'boot', createdAt: '2026-10-18T06:00:00Z', worktree: '/fixture/project' }
}
const projects = [{ id: 'project', name: 'Project', path: '/fixture/project' }]

it('keeps a newly opened waiting session selected when an older inventory finishes', () => {
  const running = session('running')
  const queued = session('new', 'Queued')
  const layout = { projectId: 'project', projects: { project: updateTerminalProjectLayout(emptyTerminalProjectLayout(), { _tag: 'Open', sessionId: queued.id }) } }
  const sessions = reconcileTerminalSessions([running], [running, queued], [structuredClone(running)])
  const reconciled = reconcileTerminalLayout(layout, projects, sessions)
  expect(sessions).toEqual([running, queued])
  expect(activeTerminalSession(reconciled.projects.project!)).toBe('new')
})

it('does not rewind a confirmed cancellation or stop with an older inventory', () => {
  for (const [before, after] of [['Queued', 'Cancelled'], ['Running', 'Exited']] as const) {
    const original = session('one', before)
    const stopped = { ...original, state: after }
    expect(reconcileTerminalSessions([original], [stopped], [structuredClone(original)])).toEqual([stopped])
  }
})

it('accepts later host changes and removals once the local result predates the read', () => {
  const queued = session('one', 'Queued')
  const running = { ...queued, state: 'Running' as const }
  expect(reconcileTerminalSessions([queued], [queued], [running])).toEqual([running])
  expect(reconcileTerminalSessions([running], [running], [])).toEqual([])
})

it('refreshes untouched sessions while retaining an overlapping mutation', () => {
  const one = session('one')
  const two = session('two')
  const stopped = { ...one, state: 'Exited' as const }
  const interrupted = { ...two, state: 'Interrupted' as const }
  expect(reconcileTerminalSessions([one, two], [stopped, two], [one, interrupted])).toEqual([stopped, interrupted])
})
