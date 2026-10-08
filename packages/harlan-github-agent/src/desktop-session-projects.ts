import { lstat, readdir, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { desktopCommand } from './desktop-worktree.ts'
import { parseWtWorktrees } from './worktree.ts'

export interface DesktopSessionProject { id: string, name: string, path: string, kind: 'pkg' | 'sites' }
async function present(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return null
    throw error
  })
}
/** Only immediate, ordinary Git control checkouts may start sessions. */
export async function resolveDesktopSessionProject(home: string, id: string): Promise<DesktopSessionProject> {
  const match = /^(pkg|sites)\/([^/]+)$/.exec(id)
  if (match === null || match[2] === '.' || match[2] === '..')
    throw new Error('Choose a project in pkg or sites.')
  const kind = match[1] as 'pkg' | 'sites'
  const name = match[2]!
  const root = join(resolve(home), kind)
  const path = join(root, name)
  if ((await present(root))?.isDirectory() !== true || await realpath(root) !== root
    || (await present(path))?.isDirectory() !== true || await realpath(path) !== path
    || (await present(join(path, '.git')))?.isDirectory() !== true
    || await desktopCommand('git', ['rev-parse', '--show-toplevel'], path) !== path) {
    throw new Error('The project must be a Git control checkout inside pkg or sites.')
  }
  return { id, name, path, kind }
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
      projects.push(await resolveDesktopSessionProject(home, `${kind}/${entry.name}`))
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
