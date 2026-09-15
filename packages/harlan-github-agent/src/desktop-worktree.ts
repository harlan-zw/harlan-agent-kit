import { execFile } from 'node:child_process'
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { parseWtWorktrees } from './worktree.ts'

const exec = promisify(execFile)
export async function desktopCommand(command: string, args: string[], cwd: string, signal?: AbortSignal, raw = false): Promise<string> {
  const result = await exec(command, args, { cwd, signal, maxBuffer: 128 * 1024 ** 2, env: { ...process.env, HARLAN_GITHUB_AGENT: '1' } })
  return raw ? result.stdout : result.stdout.trim()
}

export interface DesktopWorktree {
  head: string
  origin: string
  bundle: string
  patch: string
  files: Array<{ path: string, data: string, mode: number }>
}

/** Only repository files cross hosts. Credentials and dependency directories stay local. */
export async function exportDesktopWorktree(workspace: string, temporary: string, signal?: AbortSignal): Promise<DesktopWorktree> {
  const git = (args: string[]) => desktopCommand('git', args, workspace, signal, args[0] === 'diff' || args[0] === 'ls-files')
  const head = await git(['rev-parse', 'HEAD'])
  const origin = await git(['remote', 'get-url', 'origin'])
  const bundle = join(temporary, 'repository.bundle')
  await git(['bundle', 'create', bundle, 'HEAD', 'refs/heads/main', 'refs/remotes/origin/main'])
  const files = await desktopFiles(workspace, signal)
  return { head, origin, bundle: (await readFile(bundle)).toString('base64'), patch: await git(['diff', '--binary', 'HEAD']), files }
}

async function desktopFiles(workspace: string, signal?: AbortSignal): Promise<DesktopWorktree['files']> {
  const git = (args: string[]) => desktopCommand('git', args, workspace, signal, true)
  const files: DesktopWorktree['files'] = []
  const paths = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
  for (const path of paths) {
    const absolute = await regularDesktopFile(workspace, path)
    const data = await readFile(absolute)
    files.push({ path, data: data.toString('base64'), mode: (await lstat(absolute)).mode & 0o777 })
  }
  const diagrams = join(workspace, '.pr-lens')
  const stat = await lstat(diagrams).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return null
    throw error
  })
  if (stat?.isDirectory() === true) {
    for (const entry of await readdir(diagrams, { withFileTypes: true })) {
      const path = `.pr-lens/${entry.name}`
      if (!entry.isFile() || files.some(file => file.path === path))
        continue
      const absolute = await regularDesktopFile(workspace, path)
      files.push({ path, data: (await readFile(absolute)).toString('base64'), mode: (await lstat(absolute)).mode & 0o777 })
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

async function regularDesktopFile(root: string, path: string): Promise<string> {
  if (isAbsolute(path) || path.split('/').some(part => part === '..' || part === '.git') || path.includes('\0'))
    throw new Error('Desktop file path is outside the Worktree.')
  const absolute = resolve(root, path)
  if (!absolute.startsWith(resolve(root) + sep))
    throw new Error('Desktop file path is outside the Worktree.')
  let parent = dirname(absolute)
  while (parent !== resolve(root)) {
    const stat = await lstat(parent).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT')
        return null
      throw error
    })
    if (stat !== null && !stat.isDirectory())
      throw new Error('Desktop file parent must be a directory.')
    parent = dirname(parent)
  }
  const stat = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return null
    throw error
  })
  if (stat !== null && !stat.isFile())
    throw new Error('Desktop files must be regular files.')
  return absolute
}

export async function applyDesktopFiles(workspace: string, snapshot: DesktopWorktree, temporary: string, signal?: AbortSignal): Promise<void> {
  if (snapshot.patch !== '') {
    const patch = join(temporary, 'changes.patch')
    await writeFile(patch, `${snapshot.patch}\n`)
    await desktopCommand('git', ['apply', '--binary', patch], workspace, signal)
  }
  for (const file of snapshot.files) {
    const path = await regularDesktopFile(workspace, file.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, Buffer.from(file.data, 'base64'), { mode: file.mode })
  }
}

/** Import only into the same task-owned Worktree from which the turn was exported. */
export async function importDesktopWorktree(workspace: string, initial: DesktopWorktree, result: DesktopWorktree, temporary: string, signal?: AbortSignal): Promise<void> {
  const git = (args: string[]) => desktopCommand('git', args, workspace, signal, args[0] === 'diff' || args[0] === 'ls-files')
  if (await git(['rev-parse', 'HEAD']) !== initial.head || await git(['diff', '--binary', 'HEAD']) !== initial.patch
    || JSON.stringify(await desktopFiles(workspace, signal)) !== JSON.stringify(initial.files)) {
    throw new Error('The Hogwild Worktree changed during desktop execution.')
  }
  const bundle = join(temporary, 'result.bundle')
  await writeFile(bundle, Buffer.from(result.bundle, 'base64'))
  await git(['fetch', '--no-tags', bundle, 'HEAD'])
  if (await git(['rev-parse', 'FETCH_HEAD']) !== result.head)
    throw new Error('The desktop result does not match its commit.')
  await git(['merge-base', '--is-ancestor', initial.head, result.head])
  for (const file of initial.files)
    await rm(await regularDesktopFile(workspace, file.path), { force: true })
  await git(['reset', '--hard', result.head])
  await applyDesktopFiles(workspace, result, temporary, signal)
}

/** Desktop tasks get isolated control checkouts and Worktrunk-owned Worktrees. */
export async function prepareDesktopWorktree(snapshot: DesktopWorktree, directory: string, signal?: AbortSignal): Promise<string> {
  await mkdir(directory, { recursive: true })
  const bundle = join(directory, 'input.bundle')
  await writeFile(bundle, Buffer.from(snapshot.bundle, 'base64'))
  const control = join(directory, 'control')
  if (!(await readdir(directory)).includes('control')) {
    await desktopCommand('git', ['clone', '--branch', 'main', bundle, control], directory, signal)
    await desktopCommand('git', ['remote', 'set-url', 'origin', snapshot.origin], control, signal)
    const repository = snapshot.origin.replace(/\.git$/, '').split(/[/:]/).slice(-1)[0]!
    for (const root of ['pkg', 'sites']) {
      const local = join(process.env.HOME!, root, repository)
      const exists = await lstat(local).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT')
          return null
        throw error
      })
      if (exists?.isDirectory() !== true)
        continue
      const origin = await desktopCommand('git', ['remote', 'get-url', 'origin'], local, signal)
      const normalized = (value: string) => value.replace('git@github.com:', 'https://github.com/').replace(/\.git$/, '')
      if (normalized(origin) === normalized(snapshot.origin)) {
        await desktopCommand(join(process.env.HOME!, '.local/bin/harlan-repository-env'), ['seed', local, control], control, signal)
        break
      }
    }
  }
  await desktopCommand('git', ['fetch', bundle, 'HEAD'], control, signal)
  const branch = 'desktop-turn'
  const list = async () => {
    const parsed = parseWtWorktrees(await desktopCommand('wt', ['--config-set', 'list.json-schema=2', 'list', '--format=json'], control, signal))
    if (parsed._tag === 'Err')
      throw new Error(parsed.error)
    return parsed.value
  }
  const existing = (await list()).find(item => item.branch === branch)
  if (existing === undefined)
    await desktopCommand('wt', ['switch', '--create', branch, '--base', snapshot.head], control, signal)
  const current = (await list()).find(item => item.branch === branch)
  if (current === undefined)
    throw new Error('Worktrunk did not create the desktop Worktree.')
  const workspace = current.path
  for (const file of await desktopFiles(workspace, signal))
    await rm(await regularDesktopFile(workspace, file.path), { force: true })
  await desktopCommand('git', ['reset', '--hard', snapshot.head], workspace, signal)
  await applyDesktopFiles(workspace, snapshot, directory, signal)
  return workspace
}
