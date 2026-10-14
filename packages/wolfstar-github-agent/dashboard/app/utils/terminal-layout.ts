import type { TerminalProject, TerminalResult, TerminalSession } from '../../../src/terminal-protocol.ts'

export type TerminalProjectView =
  | { _tag: 'Empty' }
  | { _tag: 'Single'; sessionId: string }
  | { _tag: 'Split'; left: string; right: string; active: 'left' | 'right' }
export interface TerminalProjectLayout {
  tabs: string[]
  view: TerminalProjectView
}
export interface TerminalLayout {
  projectId: string
  projects: Record<string, TerminalProjectLayout>
}
export type TerminalLayoutAction =
  | { _tag: 'Open'; sessionId: string }
  | { _tag: 'Close'; sessionId: string }
  | { _tag: 'Split' }
  | { _tag: 'Unsplit' }

export function emptyTerminalLayout(): TerminalLayout {
  return { projectId: '', projects: {} }
}
export function emptyTerminalProjectLayout(): TerminalProjectLayout {
  return { tabs: [], view: { _tag: 'Empty' } }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('\0')
}
export function parseTerminalLayout(value: unknown): TerminalResult<TerminalLayout> {
  const invalid = (): TerminalResult<never> => ({ _tag: 'Err', reason: 'InvalidRequest' })
  if (
    !record(value) ||
    !(value.projectId === '' || id(value.projectId)) ||
    !record(value.projects) ||
    Object.keys(value.projects).length > 20000
  )
    return invalid()
  const projects: [string, TerminalProjectLayout][] = []
  let totalTabs = 0
  for (const [projectId, item] of Object.entries(value.projects)) {
    if (
      !id(projectId) ||
      !record(item) ||
      !Array.isArray(item.tabs) ||
      item.tabs.length > 20000 ||
      !item.tabs.every(id) ||
      new Set(item.tabs).size !== item.tabs.length ||
      !record(item.view)
    ) {
      return invalid()
    }
    totalTabs += item.tabs.length
    if (totalTabs > 20000) return invalid()
    const view = item.view
    let parsed: TerminalProjectView
    if (view._tag === 'Empty' && item.tabs.length === 0) {
      parsed = { _tag: 'Empty' }
    } else if (view._tag === 'Single' && id(view.sessionId) && item.tabs.includes(view.sessionId)) {
      parsed = { _tag: 'Single', sessionId: view.sessionId }
    } else if (
      view._tag === 'Split' &&
      id(view.left) &&
      id(view.right) &&
      view.left !== view.right &&
      item.tabs.includes(view.left) &&
      item.tabs.includes(view.right) &&
      (view.active === 'left' || view.active === 'right')
    ) {
      parsed = { _tag: 'Split', left: view.left, right: view.right, active: view.active }
    } else {
      return invalid()
    }
    projects.push([projectId, { tabs: [...item.tabs], view: parsed }])
  }
  return { _tag: 'Ok', value: { projectId: value.projectId, projects: Object.fromEntries(projects) } }
}
export function activeTerminalSession(layout: TerminalProjectLayout): string | undefined {
  return layout.view._tag === 'Empty'
    ? undefined
    : layout.view._tag === 'Single'
      ? layout.view.sessionId
      : layout.view[layout.view.active]
}
/** Display-only metadata. Launches must use the original host Project inventory. */
export function terminalDisplayProjects(
  projects: readonly TerminalProject[],
  sessions: readonly TerminalSession[],
): TerminalProject[] {
  const display = [...projects]
  const known = new Set(projects.map((project) => project.id))
  for (const session of sessions) {
    if (!known.has(session.projectId)) {
      known.add(session.projectId)
      display.push({ id: session.projectId, name: session.projectId, path: session.worktree ?? '' })
    }
  }
  return display
}
export function reconcileTerminalLayout(
  layout: TerminalLayout,
  projects: readonly TerminalProject[],
  sessions: readonly TerminalSession[],
): TerminalLayout {
  const validSessions = new Map(sessions.map((session) => [session.id, session.projectId]))
  const next = projects.map((project): [string, TerminalProjectLayout] => {
    const prior = Object.hasOwn(layout.projects, project.id)
      ? layout.projects[project.id]!
      : emptyTerminalProjectLayout()
    const tabs = prior.tabs.filter((sessionId) => validSessions.get(sessionId) === project.id)
    const view = prior.view
    let result: TerminalProjectView = tabs.length ? { _tag: 'Single', sessionId: tabs[0]! } : { _tag: 'Empty' }
    if (view._tag === 'Single' && tabs.includes(view.sessionId)) result = view
    if (view._tag === 'Split') {
      if (tabs.includes(view.left) && tabs.includes(view.right)) result = view
      else if (tabs.includes(view.left) || tabs.includes(view.right))
        result = { _tag: 'Single', sessionId: tabs.includes(view.left) ? view.left : view.right }
    }
    return [project.id, { tabs, view: result }]
  })
  return {
    projectId: projects.some((project) => project.id === layout.projectId) ? layout.projectId : (projects[0]?.id ?? ''),
    projects: Object.fromEntries(next),
  }
}
export function updateTerminalProjectLayout(
  layout: TerminalProjectLayout,
  action: TerminalLayoutAction,
): TerminalProjectLayout {
  const active = activeTerminalSession(layout)
  if (action._tag === 'Open') {
    const tabs = layout.tabs.includes(action.sessionId) ? layout.tabs : [...layout.tabs, action.sessionId]
    const view = layout.view
    if (view._tag !== 'Split') return { tabs, view: { _tag: 'Single', sessionId: action.sessionId } }
    if (view.left === action.sessionId || view.right === action.sessionId)
      return { tabs, view: { ...view, active: view.left === action.sessionId ? 'left' : 'right' } }
    return { tabs, view: { ...view, [view.active]: action.sessionId } }
  }
  if (action._tag === 'Split') {
    const other = layout.tabs.find((sessionId) => sessionId !== active)
    return active && other
      ? { tabs: layout.tabs, view: { _tag: 'Split', left: active, right: other, active: 'left' } }
      : layout
  }
  if (action._tag === 'Unsplit')
    return active ? { tabs: layout.tabs, view: { _tag: 'Single', sessionId: active } } : layout
  const index = layout.tabs.indexOf(action.sessionId)
  const tabs = layout.tabs.filter((sessionId) => sessionId !== action.sessionId)
  if (layout.view._tag === 'Split' && (layout.view.left === action.sessionId || layout.view.right === action.sessionId))
    return {
      tabs,
      view: { _tag: 'Single', sessionId: layout.view.left === action.sessionId ? layout.view.right : layout.view.left },
    }
  const next = tabs[Math.min(Math.max(index, 0), tabs.length - 1)]
  return {
    tabs,
    view: active === action.sessionId ? (next ? { _tag: 'Single', sessionId: next } : { _tag: 'Empty' }) : layout.view,
  }
}
