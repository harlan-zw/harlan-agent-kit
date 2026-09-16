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

/**
 * How the receiving host obtains the commits behind one turn.
 *
 * Both hosts fetch the same GitHub repository, so the history itself does not
 * have to travel. Only work the receiver cannot reach does. `Whole` is the last
 * resort, for a checkout with no commit in common with its origin.
 */
export type DesktopHistory
  /** The receiver holds every commit already. Nothing travels. */
  = | { _tag: 'Held' }
  /** The receiver holds the bundle's prerequisites. Only newer commits travel. */
    | { _tag: 'Incremental', bundle: string }
  /** Nothing in common, so the entire history travels. */
    | { _tag: 'Whole', bundle: string }

export interface DesktopWorktree {
  head: string
  origin: string
  history: DesktopHistory
  patch: string
  files: Array<{ path: string, data: string, mode: number }>
}

/** The carried bundle, as base64, or an empty string when none travels. */
export function desktopHistoryBundle(history: DesktopHistory): string {
  return history._tag === 'Held' ? '' : history.bundle
}

export interface DesktopWorktreeLimits {
  bundle: number
  patch: number
  file: number
  files: number
}

/**
 * What one desktop turn may carry across the host boundary.
 *
 * The turn travels as one JSON body, so every part counts as base64 text.
 * Raising these would move hundreds of megabytes through a single string.
 * A repository whose history does not fit runs on Hogwild instead.
 */
export const DESKTOP_WORKTREE_LIMITS: DesktopWorktreeLimits = {
  bundle: 256 * 1024 ** 2,
  patch: 64 * 1024 ** 2,
  file: 64 * 1024 ** 2,
  files: 50_000,
}

function size(bytes: number): string {
  return bytes >= 1024 ** 2 ? `${Math.ceil(bytes / 1024 ** 2)} MiB` : `${Math.ceil(bytes / 1024)} KiB`
}

/**
 * Why this Worktree cannot cross the host boundary, or null when it can.
 *
 * The exporter and the parser read the same limits here. They used to hold
 * their own copies, so Hogwild built a payload the desktop had to reject, and
 * every offloaded turn on a large repository died reading `invalid`.
 */
export function desktopWorktreeRefusal(worktree: DesktopWorktree, limits: DesktopWorktreeLimits = DESKTOP_WORKTREE_LIMITS): string | null {
  const bundle = desktopHistoryBundle(worktree.history)
  if (bundle.length > limits.bundle)
    return `Its history is ${size(bundle.length)}, and the limit is ${size(limits.bundle)}.`
  if (worktree.patch.length > limits.patch)
    return `Its uncommitted change is ${size(worktree.patch.length)}, and the limit is ${size(limits.patch)}.`
  if (worktree.files.length > limits.files)
    return `Its untracked file count is ${worktree.files.length}, and the limit is ${limits.files}.`
  const large = worktree.files.find(file => file.data.length > limits.file)
  if (large !== undefined)
    return `Its untracked file ${large.path} is ${size(large.data.length)}, and the limit is ${size(limits.file)}.`
  return null
}

export interface DesktopExportOptions {
  /**
   * A commit the receiving host already holds.
   *
   * The result of a turn names the commit the turn started from, so the bundle
   * back carries one turn's work. Leave it out on the way to the desktop, where
   * the shared origin decides what has to travel.
   */
  against?: string
  limits?: DesktopWorktreeLimits
  signal?: AbortSignal
}

type Git = (args: string[]) => Promise<string>

/**
 * Packs the commits the receiving host cannot already reach.
 *
 * Git answers this itself: the boundary of `HEAD --not --remotes=origin` is the
 * set of commits origin holds, and those become the bundle's prerequisites. No
 * boundary at all means the two repositories share nothing.
 */
async function exportDesktopHistory(git: Git, path: string, against: string | undefined): Promise<DesktopHistory> {
  const exclude = against === undefined ? ['--not', '--remotes=origin'] : [`^${against}`]
  const walked = (await git(['rev-list', '--boundary', 'HEAD', ...exclude])).split('\n').filter(Boolean)
  if (walked.length === 0)
    return { _tag: 'Held' }
  const shared = walked.some(line => line.startsWith('-'))
  // A bundle against an explicit commit always has that commit as its
  // prerequisite, because the caller promised the receiver holds it.
  if (shared || against !== undefined) {
    await git(['bundle', 'create', path, 'HEAD', ...exclude])
    return { _tag: 'Incremental', bundle: (await readFile(path)).toString('base64') }
  }
  // Only the refs this checkout actually has. A repository mid-clone, or one
  // that never tracked origin, still has to produce a bundle the desktop can
  // clone `main` from.
  const refs = (await git(['for-each-ref', '--format=%(refname)', 'refs/heads/main', 'refs/remotes/origin/main'])).split('\n').filter(Boolean)
  await git(['bundle', 'create', path, 'HEAD', ...refs])
  return { _tag: 'Whole', bundle: (await readFile(path)).toString('base64') }
}

/** Only repository files cross hosts. Credentials and dependency directories stay local. */
export async function exportDesktopWorktree(workspace: string, temporary: string, options: DesktopExportOptions = {}): Promise<DesktopWorktree> {
  const { signal, against, limits = DESKTOP_WORKTREE_LIMITS } = options
  const git: Git = args => desktopCommand('git', args, workspace, signal, args[0] === 'diff' || args[0] === 'ls-files' || args[0] === 'rev-list')
  const head = await git(['rev-parse', 'HEAD'])
  const origin = await git(['remote', 'get-url', 'origin'])
  const history = await exportDesktopHistory(git, join(temporary, 'repository.bundle'), against)
  const files = await desktopFiles(workspace, signal)
  const worktree = { head, origin, history, patch: await git(['diff', '--binary', 'HEAD']), files }
  const refusal = desktopWorktreeRefusal(worktree, limits)
  if (refusal !== null)
    throw new Error(`The desktop cannot run a turn for ${origin}. ${refusal}`, { cause: 'desktop-unsupported' })
  return worktree
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
  if (result.history._tag === 'Held') {
    // Nothing travelled, so the desktop committed nothing. Any other head here
    // names a commit this host was never given.
    if (result.head !== initial.head)
      throw new Error('The desktop result names a commit it did not send.')
  }
  else {
    const bundle = join(temporary, 'result.bundle')
    await writeFile(bundle, Buffer.from(result.history.bundle, 'base64'))
    await git(['fetch', '--no-tags', bundle, 'HEAD'])
    if (await git(['rev-parse', 'FETCH_HEAD']) !== result.head)
      throw new Error('The desktop result does not match its commit.')
  }
  await git(['merge-base', '--is-ancestor', initial.head, result.head])
  for (const file of initial.files)
    await rm(await regularDesktopFile(workspace, file.path), { force: true })
  await git(['reset', '--hard', result.head])
  await applyDesktopFiles(workspace, result, temporary, signal)
}

/**
 * Where one repository's cached control checkout lives on the receiving host.
 *
 * Two repositories may share a name across owners, so the owner is part of the
 * path. A remote this cannot read has no cache and no turn.
 */
export function desktopRepositoryPath(root: string, origin: string): string {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(origin)
  if (match === null || match[1] === '..' || match[2] === '..')
    throw new Error('The desktop Worktree origin is not a GitHub repository.')
  return join(root, match[1]!, match[2]!)
}

/** Copies the ignored state files a repository needs, from a matching local checkout. */
async function seedRepositoryEnvironment(origin: string, control: string, signal?: AbortSignal): Promise<void> {
  const repository = origin.replace(/\.git$/, '').split(/[/:]/).slice(-1)[0]!
  for (const root of ['pkg', 'sites']) {
    const local = join(process.env.HOME!, root, repository)
    const exists = await lstat(local).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT')
        return null
      throw error
    })
    if (exists?.isDirectory() !== true)
      continue
    const localOrigin = await desktopCommand('git', ['remote', 'get-url', 'origin'], local, signal)
    const normalized = (value: string) => value.replace('git@github.com:', 'https://github.com/').replace(/\.git$/, '')
    if (normalized(localOrigin) === normalized(origin)) {
      await desktopCommand(join(process.env.HOME!, '.local/bin/harlan-repository-env'), ['seed', local, control], control, signal)
      return
    }
  }
}

/**
 * Desktop turns get one cached control checkout per repository, and
 * Worktrunk-owned Worktrees inside it.
 *
 * The checkout is keyed by repository, not by task, because cloning a history
 * both hosts can fetch from GitHub is the whole cost this design removes. The
 * first turn clones. Every later turn fetches.
 */
/** Every desktop Worktree branch starts with this, so a stale one is findable. */
export const DESKTOP_BRANCH_PREFIX = 'desktop-turn-'

/**
 * Whether this branch is a desktop Worktree the controller owns.
 *
 * Every cache built before the Worktree was named after its Task holds one
 * called exactly `desktop-turn`. The prefix alone never matches it, so it would
 * have sat on disk for the life of the machine.
 */
export function isDesktopBranch(branch: string): boolean {
  return branch === DESKTOP_BRANCH_PREFIX.slice(0, -1) || branch.startsWith(DESKTOP_BRANCH_PREFIX)
}

/** A Task identity reduced to something safe to name a Git branch after. */
export function desktopTaskKey(task: string): string {
  const safe = task.replace(/[^\w-]/g, '').slice(0, 24)
  if (safe === '')
    throw new Error('The desktop turn has no usable Task identity.')
  return safe
}

/**
 * The line a failed Worktrunk command actually failed on.
 *
 * Worktrunk echoes the body of every hook it ran, so its stderr carries the
 * text of checks that passed. That whole body reached the controller as the
 * failure reason, and a hook echoing `origin fetch failed` had a missing pnpm
 * read as a network fault for days. Only the marked line says what went wrong.
 */
export function worktrunkFailure(stderr: string): string | null {
  const marked = stderr.split('\n').map(line => line.trim()).filter(line => line.startsWith('\u2717') || line.startsWith('\u2718'))
  return marked.at(-1) ?? null
}

/** Runs one Worktrunk command and reports the line it failed on, not its hooks. */
async function worktrunk(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  try {
    return await desktopCommand('wt', args, cwd, signal)
  }
  catch (error) {
    const stderr = error !== null && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : ''
    const failure = worktrunkFailure(stderr)
    if (failure === null)
      throw error
    throw new Error(`Worktrunk stopped: ${failure}`, { cause: error })
  }
}

export async function prepareDesktopWorktree(snapshot: DesktopWorktree, directory: string, temporary: string, task: string, signal?: AbortSignal): Promise<string> {
  await mkdir(directory, { recursive: true })
  await mkdir(temporary, { recursive: true })
  const carried = desktopHistoryBundle(snapshot.history)
  const bundle = join(temporary, 'input.bundle')
  if (carried !== '')
    await writeFile(bundle, Buffer.from(carried, 'base64'))
  const control = join(directory, 'control')
  if (!(await readdir(directory)).includes('control')) {
    // A checkout with nothing in common with its origin is the only one that
    // has to be built from the payload.
    const source = snapshot.history._tag === 'Whole' ? bundle : snapshot.origin
    await desktopCommand('git', ['clone', '--branch', 'main', source, control], directory, signal)
    await desktopCommand('git', ['remote', 'set-url', 'origin', snapshot.origin], control, signal)
    await seedRepositoryEnvironment(snapshot.origin, control, signal)
  }
  else if (snapshot.history._tag !== 'Whole') {
    await desktopCommand('git', ['fetch', '--prune', '--no-tags', 'origin'], control, signal)
  }
  if (carried !== '')
    await desktopCommand('git', ['fetch', '--no-tags', bundle, 'HEAD'], control, signal)
  // One Worktree per Task, not per repository. Worktrunk runs its pre-start
  // hooks only when it creates one, and those hooks install dependencies and
  // seed the repository state files. A single shared `desktop-turn` ran them
  // once for the life of the cache, and every later Task inherited whatever
  // the previous one left behind.
  const branch = `${DESKTOP_BRANCH_PREFIX}${desktopTaskKey(task)}`
  const list = async () => {
    const parsed = parseWtWorktrees(await worktrunk(['--config-set', 'list.json-schema=2', 'list', '--format=json'], control, signal))
    if (parsed._tag === 'Err')
      throw new Error(parsed.error)
    return parsed.value
  }
  for (const item of await list()) {
    if (item.branch !== undefined && item.branch !== branch && isDesktopBranch(item.branch))
      await worktrunk(['remove', item.branch], control, signal)
  }
  const existing = (await list()).find(item => item.branch === branch)
  if (existing === undefined)
    await worktrunk(['switch', '--create', branch, '--base', snapshot.head], control, signal)
  const current = (await list()).find(item => item.branch === branch)
  if (current === undefined)
    throw new Error('Worktrunk did not create the desktop Worktree.')
  const workspace = current.path
  for (const file of await desktopFiles(workspace, signal))
    await rm(await regularDesktopFile(workspace, file.path), { force: true })
  await desktopCommand('git', ['reset', '--hard', snapshot.head], workspace, signal)
  await applyDesktopFiles(workspace, snapshot, temporary, signal)
  return workspace
}
