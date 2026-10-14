import type { TerminalProject, TerminalSession } from '../src/terminal-protocol.ts'
import { expect, it } from 'vitest'
import {
  activeTerminalSession,
  emptyTerminalLayout,
  emptyTerminalProjectLayout,
  parseTerminalLayout,
  reconcileTerminalLayout,
  terminalDisplayProjects,
  updateTerminalProjectLayout,
} from '../dashboard/app/utils/terminal-layout.ts'

const projects: TerminalProject[] = [
  { id: 'p', name: 'Project', path: '/project' },
  { id: 'q', name: 'Other', path: '/other' },
]
const sessions = ['a', 'b', 'c'].map((id) => ({ id, projectId: 'p' }) as TerminalSession)
function opened() {
  let layout = emptyTerminalProjectLayout()
  for (const sessionId of ['a', 'b', 'c']) layout = updateTerminalProjectLayout(layout, { _tag: 'Open', sessionId })
  return layout
}
it('opens tabs once and preserves their order when focusing', () => {
  const next = updateTerminalProjectLayout(opened(), { _tag: 'Open', sessionId: 'a' })
  expect(next).toEqual({ tabs: ['a', 'b', 'c'], view: { _tag: 'Single', sessionId: 'a' } })
})
it('keeps at most two distinct sessions visible and replaces only the active pane', () => {
  const split = updateTerminalProjectLayout(opened(), { _tag: 'Split' })
  expect(split.view).toEqual({ _tag: 'Split', left: 'c', right: 'a', active: 'left' })
  const focused = updateTerminalProjectLayout(split, { _tag: 'Open', sessionId: 'a' })
  expect(activeTerminalSession(focused)).toBe('a')
  expect(updateTerminalProjectLayout(focused, { _tag: 'Open', sessionId: 'b' }).view).toEqual({
    _tag: 'Split',
    left: 'c',
    right: 'b',
    active: 'right',
  })
})
it('closing a visible split tab retains the other session; closing an inactive tab preserves panes', () => {
  const split = updateTerminalProjectLayout(opened(), { _tag: 'Split' })
  expect(updateTerminalProjectLayout(split, { _tag: 'Close', sessionId: 'b' }).view).toEqual(split.view)
  expect(updateTerminalProjectLayout(split, { _tag: 'Close', sessionId: 'c' })).toEqual({
    tabs: ['a', 'b'],
    view: { _tag: 'Single', sessionId: 'a' },
  })
})
it('closing the active tab selects its nearest neighbour and eventually leaves an empty view', () => {
  let layout = updateTerminalProjectLayout(opened(), { _tag: 'Close', sessionId: 'c' })
  expect(activeTerminalSession(layout)).toBe('b')
  layout = updateTerminalProjectLayout(layout, { _tag: 'Close', sessionId: 'b' })
  layout = updateTerminalProjectLayout(layout, { _tag: 'Close', sessionId: 'a' })
  expect(layout).toEqual(emptyTerminalProjectLayout())
})
it('restores each Project independently and removes deleted sessions and Projects', () => {
  const layout = {
    projectId: 'p',
    projects: {
      p: updateTerminalProjectLayout(opened(), { _tag: 'Split' }),
      stale: opened(),
      q: emptyTerminalProjectLayout(),
    },
  }
  expect(reconcileTerminalLayout(layout, projects, sessions.slice(0, 2))).toEqual({
    projectId: 'p',
    projects: { p: { tabs: ['a', 'b'], view: { _tag: 'Single', sessionId: 'a' } }, q: emptyTerminalProjectLayout() },
  })
  expect(reconcileTerminalLayout(layout, projects.slice(1), sessions).projectId).toBe('q')
})
it('refuses impossible stored layouts and projects only known fields', () => {
  const valid = { projectId: 'p', projects: { p: opened() } }
  expect(parseTerminalLayout({ ...valid, secret: 'ignored' })).toEqual({ _tag: 'Ok', value: valid })
  for (const view of [
    { _tag: 'Single', sessionId: 'missing' },
    { _tag: 'Split', left: 'a', right: 'a', active: 'left' },
    { _tag: 'Empty' },
  ])
    expect(parseTerminalLayout({ projectId: 'p', projects: { p: { tabs: ['a'], view } } })).toEqual({
      _tag: 'Err',
      reason: 'InvalidRequest',
    })
  expect(reconcileTerminalLayout(emptyTerminalLayout(), projects, sessions).projects.p).toEqual(
    emptyTerminalProjectLayout(),
  )
})
it('treats inherited object names as Project identifiers without retaining prototypes', () => {
  const project = { id: '__proto__', name: 'Project', path: '/project' }
  const layout = reconcileTerminalLayout(emptyTerminalLayout(), [project], [])
  expect(Object.hasOwn(layout.projects, '__proto__')).toBe(true)
  expect(Object.entries(layout.projects).find(([id]) => id === project.id)?.[1]).toEqual(emptyTerminalProjectLayout())
  expect(parseTerminalLayout(layout)).toEqual({ _tag: 'Ok', value: layout })
})
it('refuses duplicate stored tabs and does not split a single tab', () => {
  const single = updateTerminalProjectLayout(emptyTerminalProjectLayout(), { _tag: 'Open', sessionId: 'a' })
  expect(updateTerminalProjectLayout(single, { _tag: 'Split' })).toEqual(single)
  expect(parseTerminalLayout({ projectId: 'p', projects: { p: { ...single, tabs: ['a', 'a'] } } })).toEqual({
    _tag: 'Err',
    reason: 'InvalidRequest',
  })
})
it('bounds total stored tabs across all Projects', () => {
  const tabs = Array.from({ length: 10000 }, (_, index) => String(index))
  const item = { tabs, view: { _tag: 'Single', sessionId: '0' } }
  expect(parseTerminalLayout({ projectId: 'p', projects: { p: item, q: item } })._tag).toBe('Ok')
  expect(
    parseTerminalLayout({
      projectId: 'p',
      projects: { p: item, q: item, r: { tabs: ['extra'], view: { _tag: 'Single', sessionId: 'extra' } } },
    }),
  ).toEqual({ _tag: 'Err', reason: 'InvalidRequest' })
})
it('preserves orphan Session selection without adding launch authority', () => {
  const current = [{ id: 'a', projectId: 'p', worktree: '/project.terminal-a' }] as TerminalSession[]
  const authoritative = projects.slice(1)
  const display = terminalDisplayProjects(authoritative, current)
  expect(display.map((project) => project.id)).toEqual(['q', 'p'])
  expect(authoritative.map((project) => project.id)).toEqual(['q'])
  const stored = { projectId: 'p', projects: { p: { tabs: ['a'], view: { _tag: 'Single' as const, sessionId: 'a' } } } }
  expect(reconcileTerminalLayout(stored, display, current)).toEqual({
    ...stored,
    projects: { q: emptyTerminalProjectLayout(), ...stored.projects },
  })
  expect(terminalDisplayProjects([], [...current, ...current])).toHaveLength(1)
  expect(terminalDisplayProjects([], [])).toEqual([])
})
