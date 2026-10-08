import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { desktopCommand } from './desktop-worktree.ts'
import { parseWtWorktrees } from './worktree.ts'

export interface DesktopSessionProject { id: string, name: string, path: string, kind: 'pkg' | 'sites' }
type ProjectResult = { _tag: 'Ok', project: DesktopSessionProject } | { _tag: 'Err', reason: string }
const checkoutReason = 'The project must be a Git control checkout inside pkg or sites.'
async function present(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return null
    throw error
  })
}
async function inspectProject(home: string, id: string): Promise<ProjectResult> {
  const match = /^(pkg|sites)\/([^/]+)$/.exec(id)
  if (match === null || match[2] === '.' || match[2] === '..')
    return { _tag: 'Err', reason: 'Choose a project in pkg or sites.' }
  const kind = match[1] as 'pkg' | 'sites'
  const name = match[2]!
  const root = join(resolve(home), kind)
  const path = join(root, name)
  if ((await present(root))?.isDirectory() !== true || await realpath(root) !== root
    || (await present(path))?.isDirectory() !== true || await realpath(path) !== path
    || (await present(join(path, '.git')))?.isDirectory() !== true) {
    return { _tag: 'Err', reason: checkoutReason }
  }
  const top = await desktopCommand('git', ['rev-parse', '--show-toplevel'], path).catch((error: unknown) => {
    // Git identifies malformed repository metadata. Spawn, permission, and I/O failures still propagate.
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 128
      && 'stderr' in error && typeof error.stderr === 'string'
      && /fatal: (?:not a git repository|bad config line \d+ in file)/.test(error.stderr)) {
      return null
    }
    throw error
  })
  return top === path ? { _tag: 'Ok', project: { id, name, path, kind } } : { _tag: 'Err', reason: checkoutReason }
}
/** Only immediate, ordinary Git control checkouts may start sessions. */
export async function resolveDesktopSessionProject(home: string, id: string): Promise<DesktopSessionProject> {
  const result = await inspectProject(home, id)
  if (result._tag === 'Err')
    throw new Error(result.reason)
  return result.project
}
export async function discoverDesktopSessionProjects(home: string): Promise<DesktopSessionProject[]> {
  const projects: DesktopSessionProject[] = []
  for (const kind of ['pkg', 'sites'] as const) {
    const root = join(resolve(home), kind)
    if ((await present(root))?.isDirectory() !== true || await realpath(root) !== root)
      continue
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || (await present(join(root, entry.name, '.git')))?.isDirectory() !== true)
        continue
      const id = `${kind}/${entry.name}`
      const result = await inspectProject(home, id)
      if (result._tag === 'Err') {
        console.warn(`Skipping project ${id}: ${result.reason}`)
        continue
      }
      projects.push(result.project)
    }
  }
  return projects.sort((a, b) => a.id.localeCompare(b.id))
}
/** Resume the exact Worktrunk Worktree. Never reset or sweep session changes. */
export async function prepareDesktopSessionWorkspace(home: string, projectId: string, sessionId: string, saved: string | null, signal: AbortSignal): Promise<string> {
  if (!/^[a-f0-9-]{36}$/.test(sessionId))
    throw new Error('The session identity is invalid.')
  const project = await resolveDesktopSessionProject(home, projectId)
  const branch = `agent/session-${sessionId}`
  const list = async () => {
    const parsed = parseWtWorktrees(await desktopCommand('wt', ['--config-set', 'list.json-schema=2', 'list', '--format=json'], project.path, signal))
    if (parsed._tag === 'Err')
      throw new Error(parsed.error)
    return parsed.value
  }
  let current = (await list()).find(item => item.branch === branch)
  if (saved !== null && (current === undefined || current.path !== saved))
    throw new Error('The saved session Worktree is unavailable.')
  if (current === undefined) {
    await desktopCommand('wt', ['switch', '--create', branch, '--base', 'origin/main'], project.path, signal)
    current = (await list()).find(item => item.branch === branch)
  }
  if (current === undefined || current.path === project.path || await realpath(current.path) !== current.path)
    throw new Error('Worktrunk did not prepare the session Worktree.')
  return current.path
}
