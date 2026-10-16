import type { TerminalProject, TerminalSession } from '../../../src/terminal-protocol.ts'

/** Recent starts and local visits keep the picker small; search can pass the full inventory. */
export function terminalProjectGroups(options: {
  projects: readonly TerminalProject[]
  sessions: readonly TerminalSession[]
  visited: unknown
  now: number
  all: boolean
  selected?: string
}) {
  const activity = new Map<string, number>()
  const active = new Set<string>()
  const visits = typeof options.visited === 'object' && options.visited !== null ? options.visited : {}
  for (const [id, value] of Object.entries(visits)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0)
      activity.set(id, Math.min(value, options.now))
  }
  for (const session of options.sessions) {
    const started = Date.parse(session.createdAt)
    if (Number.isFinite(started))
      activity.set(session.projectId, Math.max(activity.get(session.projectId) ?? 0, started))
    if (['Starting', 'Running', 'Stopping', 'Queued', 'Unknown'].includes(session.state))
      active.add(session.projectId)
  }
  const sorted = options.projects.toSorted((a, b) => (activity.get(b.id) ?? 0) - (activity.get(a.id) ?? 0) || a.name.localeCompare(b.name))
  const recent = sorted.filter(project => active.has(project.id) || (activity.get(project.id) ?? 0) >= options.now - 14 * 86400000).slice(0, 8)
  const visible = options.all ? sorted : sorted.filter(project => active.has(project.id) || recent.includes(project) || project.id === options.selected)
  const groups = [
    { id: 'packages', label: 'Packages', projects: [] as TerminalProject[] },
    { id: 'sites', label: 'Sites', projects: [] as TerminalProject[] },
    { id: 'other', label: 'Other projects', projects: [] as TerminalProject[] },
  ]
  for (const project of visible) {
    const path = project.path.replaceAll('\\', '/')
    const category = /(?:^|\/)pkg\//.test(path) ? 0 : /(?:^|\/)sites\//.test(path) ? 1 : 2
    groups[category]!.projects.push(project)
  }
  return { groups: groups.filter(group => group.projects.length), hidden: options.projects.length - visible.length }
}
