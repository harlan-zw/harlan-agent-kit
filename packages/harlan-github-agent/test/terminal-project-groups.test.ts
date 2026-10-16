import type { TerminalProject, TerminalSession } from '../src/terminal-protocol.ts'
import { expect, it } from 'vitest'
import { terminalProjectGroups } from '../dashboard/app/utils/terminal-project-groups.ts'

const now = Date.parse('2026-10-17T00:00:00Z')
const projects: TerminalProject[] = [
  { id: 'package', name: 'Package', path: '/home/harlan/pkg/package' },
  { id: 'site', name: 'Site', path: '/home/harlan/sites/site' },
  { id: 'unused', name: 'Unused', path: '/home/harlan/pkg/unused' },
  { id: 'other', name: 'Other', path: '/work/other' },
]
const sessions = [{ projectId: 'package', createdAt: '2026-10-16T00:00:00Z' }] as TerminalSession[]

it('shows recent projects by folder and keeps the full inventory available', () => {
  const result = terminalProjectGroups({ projects, sessions, visited: { site: now - 1000 }, now, all: false })
  expect(result.groups.map(group => [group.label, group.projects.map(project => project.id)])).toEqual([
    ['Packages', ['package']],
    ['Sites', ['site']],
  ])
  expect(result.hidden).toBe(2)
  expect(terminalProjectGroups({ projects, sessions, visited: {}, now, all: true }).groups.flatMap(group => group.projects).map(project => project.id)).toEqual(['package', 'unused', 'site', 'other'])
})

it('hides old projects without losing a selected project or matching search result', () => {
  const older = [{ projectId: 'package', createdAt: '2025-01-01T00:00:00Z' }] as TerminalSession[]
  expect(terminalProjectGroups({ projects, sessions: older, visited: {}, now, all: false }).groups).toEqual([])
  expect(terminalProjectGroups({ projects, sessions: older, visited: {}, now, all: false, selected: 'package' }).groups[0]?.projects.map(project => project.id)).toEqual(['package'])
  expect(terminalProjectGroups({ projects: [projects[2]!], sessions: older, visited: {}, now, all: true }).groups[0]?.projects[0]?.id).toBe('unused')
})

it('bounds recent projects and ignores malformed stored visits', () => {
  const inventory = Array.from({ length: 12 }, (_, index) => ({ id: `p${index}`, name: `P${index}`, path: `/home/harlan/pkg/p${index}` }))
  const visited = Object.fromEntries(inventory.map((project, index) => [project.id, now - index * 1000]))
  const result = terminalProjectGroups({ projects: inventory, sessions: [], visited, now, all: false })
  expect(result.groups[0]?.projects.map(project => project.id)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'])
  expect(result.hidden).toBe(4)
  expect(terminalProjectGroups({ projects, sessions: [], visited: { package: 'bad' }, now, all: false }).groups).toEqual([])
})

it('keeps older running projects visible when recent visits fill the short list', () => {
  const inventory = Array.from({ length: 10 }, (_, index) => ({ id: `p${index}`, name: `P${index}`, path: `/home/harlan/pkg/p${index}` }))
  const visited = Object.fromEntries(inventory.slice(0, 8).map(project => [project.id, now]))
  const running = [{ projectId: 'p9', createdAt: '2025-01-01T00:00:00Z', state: 'Running' }] as TerminalSession[]
  const result = terminalProjectGroups({ projects: inventory, sessions: running, visited, now, all: false })
  expect(result.groups[0]?.projects.map(project => project.id)).toContain('p9')
  expect(result.hidden).toBe(1)
})
