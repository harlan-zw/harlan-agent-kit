import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

/**
 * Worktree snapshots in Cloudflare Artifacts.
 *
 * A Container's disk is gone when it is replaced, and an Agent's work that was
 * never pushed goes with it. Every few minutes this saves each linked
 * worktree's working state as one commit on a `snapshots/<branch>` ref in an
 * Artifacts repository, and a fresh Container brings the work back.
 *
 * A snapshot is a tree, not a history: it carries no parent from the
 * worktree, so a first push uploads only the files, never the repository's
 * past. The commit names the merge base with the default branch, and a
 * restore rebuilds the worktree from that commit plus the saved files.
 *
 * Everything here is best effort. A failure is returned or logged, and the
 * controller never waits on it.
 */

const execFileAsync = promisify(execFile)

export const SNAPSHOT_REF_PREFIX = 'refs/heads/snapshots/'
/** Where fetched snapshots land in the local checkout, away from every branch. */
export const LOCAL_SNAPSHOT_REF_PREFIX = 'refs/wolfstar/snapshots/'
/** Older than this and a snapshot is work somebody already finished or dropped. */
export const MAXIMUM_SNAPSHOT_AGE_SECONDS = 3 * 24 * 60 * 60
/** Artifacts refuses a blob over 32 MB, and one refusal would fail the whole push. */
const MAXIMUM_FILE_BYTES = 30 * 1024 * 1024

/**
 * Secrets a worktree holds and a snapshot must never carry.
 *
 * Worktrunk seeds `.env` into each worktree, and a repository that does not
 * ignore it would otherwise send it to storage.
 */
const SECRET_PATHSPECS = [
  ':(exclude,glob).env',
  ':(exclude,glob)**/.env',
  ':(exclude,glob).env.*',
  ':(exclude,glob)**/.env.*',
  ':(exclude,glob)**/*.pem',
  ':(exclude,glob)**/*.key',
] as const

export type AccessScope = 'read' | 'write'

export interface SnapshotAccess {
  remote: string
  token: string
}

/** Asks for a token. Answers null when the repository has nothing saved and `scope` is read. */
export type RequestAccess = (repository: string, scope: AccessScope) => Promise<SnapshotAccess | null>

export interface GitRunner {
  (args: string[], options?: { cwd?: string; env?: Record<string, string> }): Promise<string>
}

/** Runs the real git. Tests pass their own identity through `env`. */
export const runGit: GitRunner = async (args, options = {}) => {
  const { stdout } = await execFileAsync('git', args, {
    cwd: options.cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...options.env },
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout
}

export interface SnapshotDependencies {
  git: GitRunner
  request: RequestAccess
  log: (message: string) => void
  /** Seconds since the epoch. */
  now: () => number
}

/** A branch name as one ref component, so `a` and `a/b` never collide in the ref tree. */
export function encodeBranch(branch: string): string {
  return encodeURIComponent(branch)
    .replace(/[!'()*~]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/^\./, '%2E')
}

export function decodeBranch(encoded: string): string {
  return decodeURIComponent(encoded)
}

/**
 * The Artifacts repository name for a checkout's `origin`, or null when the
 * remote is not a GitHub repository this Container manages.
 */
export function repositoryNameFromRemote(remote: string): string | null {
  const match = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote.trim())
  if (match === null) return null
  const name = `${match[1]}-${match[2]}`.toLowerCase()
  return /^[a-z0-9][a-z0-9._-]{1,62}$/.test(name) ? name : null
}

export interface LinkedWorktree {
  path: string
  head: string
  branch: string
}

/** Reads `git worktree list --porcelain`, keeping linked worktrees that sit on a branch. */
export function parseLinkedWorktrees(porcelain: string): LinkedWorktree[] {
  const blocks = porcelain.trim().split(/\n\s*\n/)
  const linked: LinkedWorktree[] = []
  // The first block is the main checkout. Agents work in linked worktrees.
  for (const block of blocks.slice(1)) {
    let path = ''
    let head = ''
    let branch = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length)
      else if (line.startsWith('branch refs/heads/')) branch = line.slice('branch refs/heads/'.length)
    }
    if (path !== '' && branch !== '') linked.push({ path, head, branch })
  }
  return linked
}

function authenticated(access: SnapshotAccess): Record<string, string> {
  // The header travels in the environment, so the token is in no argument list.
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'protocol.version',
    GIT_CONFIG_VALUE_0: '1',
    GIT_CONFIG_KEY_1: 'http.extraHeader',
    GIT_CONFIG_VALUE_1: `Authorization: Bearer ${access.token}`,
  }
}

async function optional(git: GitRunner, args: string[], cwd: string): Promise<string | null> {
  try {
    return (await git(args, { cwd })).trim()
  } catch {
    return null
  }
}

/** The commit the worktree's work started from: its merge base with the default branch. */
async function mergeBaseOf(git: GitRunner, cwd: string): Promise<string | null> {
  for (const base of ['refs/remotes/origin/HEAD', 'refs/remotes/origin/main', 'refs/remotes/origin/master']) {
    const found = await optional(git, ['merge-base', 'HEAD', base], cwd)
    if (found !== null && found !== '') return found
  }
  return null
}

/**
 * The tree of everything in a worktree that is not ignored, through a
 * scratch index so the worktree's own index and files are never touched.
 */
async function workingTree(git: GitRunner, worktree: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'wolfstar-snapshot-'))
  const env = { GIT_INDEX_FILE: join(directory, 'index') }
  try {
    await git(['read-tree', 'HEAD'], { cwd: worktree, env })
    await git(['add', '--all', '--', '.', ...SECRET_PATHSPECS], { cwd: worktree, env })
    const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: worktree }))
      .split('\0')
      .filter((path) => path !== '')
    for (const path of untracked) {
      const size = await stat(join(worktree, path)).then(
        (info) => info.size,
        () => 0,
      )
      if (size > MAXIMUM_FILE_BYTES) await git(['rm', '--cached', '--quiet', '--', path], { cwd: worktree, env })
    }
    return (await git(['write-tree'], { cwd: worktree, env })).trim()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function snapshotMessage(input: { branch: string; mergeBase: string; head: string; takenAt: string }): string {
  return [
    `snapshot: ${input.branch}`,
    '',
    `Branch: ${input.branch}`,
    `Merge-Base: ${input.mergeBase}`,
    `Head: ${input.head}`,
    `Taken-At: ${input.takenAt}`,
    '',
  ].join('\n')
}

export type SnapshotOutcome =
  | { _tag: 'Saved'; branch: string; commit: string }
  | { _tag: 'Clean'; branch: string }
  | { _tag: 'Unchanged'; branch: string }
  | { _tag: 'Skipped'; branch: string; reason: string }
  | { _tag: 'Failed'; branch: string; reason: string }

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Wolfstar snapshots',
  GIT_AUTHOR_EMAIL: 'snapshots@wolfstar.invalid',
  GIT_COMMITTER_NAME: 'Wolfstar snapshots',
  GIT_COMMITTER_EMAIL: 'snapshots@wolfstar.invalid',
}

function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  // A failed git command repeats the whole command line, token headers included. Keep the last line.
  return text.split('\n').filter(Boolean).at(-1) ?? 'unknown'
}

/**
 * Saves one worktree. `access` is asked for only when the worktree differs
 * from its merge base, so a repository with nothing in flight creates nothing.
 */
export async function snapshotWorktree(
  dependencies: SnapshotDependencies,
  input: {
    checkout: string
    worktree: LinkedWorktree
    repository: string
    access: () => Promise<SnapshotAccess | null>
  },
): Promise<SnapshotOutcome> {
  const { git, now } = dependencies
  const { branch } = input.worktree
  try {
    const mergeBase = await mergeBaseOf(git, input.worktree.path)
    if (mergeBase === null) return { _tag: 'Skipped', branch, reason: 'no merge base with origin' }

    const [tree, baseTree] = await Promise.all([
      workingTree(git, input.worktree.path),
      git(['rev-parse', `${mergeBase}^{tree}`], { cwd: input.worktree.path }).then((out) => out.trim()),
    ])
    if (tree === baseTree) return { _tag: 'Clean', branch }

    const access = await input.access()
    if (access === null) return { _tag: 'Skipped', branch, reason: 'no access to the snapshot repository' }

    const reference = `${SNAPSHOT_REF_PREFIX}${encodeBranch(branch)}`
    const local = `${LOCAL_SNAPSHOT_REF_PREFIX}${encodeBranch(branch)}`
    const env = authenticated(access)

    // Chain on the saved snapshot, so the push is a fast forward and history of the work is kept.
    let parent: string | null = null
    const listed = await git(['ls-remote', access.remote, reference], { cwd: input.checkout, env }).catch(() => '')
    if (listed.trim() !== '') {
      await git(['fetch', '--quiet', access.remote, `+${reference}:${local}`], { cwd: input.checkout, env })
      parent = (await git(['rev-parse', local], { cwd: input.checkout })).trim()
      const parentTree = (await git(['rev-parse', `${parent}^{tree}`], { cwd: input.checkout })).trim()
      if (parentTree === tree) return { _tag: 'Unchanged', branch }
    }

    const commit = (
      await git(
        [
          'commit-tree',
          tree,
          ...(parent === null ? [] : ['-p', parent]),
          '-m',
          snapshotMessage({
            branch,
            mergeBase,
            head: input.worktree.head,
            takenAt: new Date(now() * 1000).toISOString(),
          }),
        ],
        { cwd: input.worktree.path, env: IDENTITY },
      )
    ).trim()

    await git(['push', '--quiet', access.remote, `${commit}:${reference}`], { cwd: input.worktree.path, env })
    return { _tag: 'Saved', branch, commit }
  } catch (error) {
    return { _tag: 'Failed', branch, reason: reasonOf(error) }
  }
}

/** A checkout's repository name, from its `origin`. */
async function repositoryOf(git: GitRunner, checkout: string): Promise<string | null> {
  const remote = await optional(git, ['remote', 'get-url', 'origin'], checkout)
  return remote === null ? null : repositoryNameFromRemote(remote)
}

/** Memoises one access request per repository and scope for the length of one round. */
function memoised(request: RequestAccess): RequestAccess {
  const answers = new Map<string, Promise<SnapshotAccess | null>>()
  return (repository, scope) => {
    const key = `${scope}:${repository}`
    const known = answers.get(key)
    if (known !== undefined) return known
    const answer = request(repository, scope)
    answers.set(key, answer)
    return answer
  }
}

export interface RoundResult {
  saved: string[]
  failed: { branch: string; reason: string }[]
  /** Every linked worktree branch seen, by checkout, so a later round can tell which one finished. */
  seen: Map<string, Set<string>>
}

/** Saves every linked worktree of every checkout. */
export async function snapshotRound(
  dependencies: SnapshotDependencies,
  checkouts: readonly string[],
): Promise<RoundResult> {
  const result: RoundResult = { saved: [], failed: [], seen: new Map() }
  const request = memoised(dependencies.request)
  for (const checkout of checkouts) {
    const repository = await repositoryOf(dependencies.git, checkout)
    if (repository === null) continue
    const listing = await optional(dependencies.git, ['worktree', 'list', '--porcelain'], checkout)
    if (listing === null) continue
    const worktrees = parseLinkedWorktrees(listing)
    result.seen.set(checkout, new Set(worktrees.map((worktree) => worktree.branch)))
    for (const worktree of worktrees) {
      const outcome = await snapshotWorktree(dependencies, {
        checkout,
        worktree,
        repository,
        access: () => request(repository, 'write'),
      })
      if (outcome._tag === 'Saved') result.saved.push(outcome.branch)
      else if (outcome._tag === 'Failed') result.failed.push({ branch: outcome.branch, reason: outcome.reason })
    }
  }
  return result
}

/**
 * Removes the snapshot of a worktree that existed in this Container and is
 * gone, which is how a finished or merged task looks. A branch this Container
 * never saw is left alone: it may be the work a restore has yet to bring back.
 */
export async function pruneFinished(
  dependencies: SnapshotDependencies,
  checkout: string,
  finished: readonly string[],
): Promise<string[]> {
  if (finished.length === 0) return []
  const { git } = dependencies
  const repository = await repositoryOf(git, checkout)
  if (repository === null) return []
  const access = await dependencies.request(repository, 'write')
  if (access === null) return []
  const env = authenticated(access)
  const removed: string[] = []
  for (const branch of finished) {
    const reference = `${SNAPSHOT_REF_PREFIX}${encodeBranch(branch)}`
    try {
      await git(['push', '--quiet', access.remote, `:${reference}`], { cwd: checkout, env })
      removed.push(branch)
    } catch (error) {
      dependencies.log(`Could not remove the snapshot of ${branch}: ${reasonOf(error)}`)
    }
  }
  return removed
}

export interface RestoreDependencies extends SnapshotDependencies {
  /** Makes a worktree for `branch` at `base` and returns its path. */
  createWorktree: (checkout: string, branch: string, base: string) => Promise<string>
}

export type RestoreOutcome =
  | { _tag: 'Restored'; branch: string; path: string }
  | { _tag: 'Skipped'; branch: string; reason: string }
  | { _tag: 'Failed'; branch: string; reason: string }

function trailer(message: string, name: string): string | null {
  const match = new RegExp(`^${name}: (.+)$`, 'm').exec(message)
  return match === null ? null : match[1]!.trim()
}

/**
 * Brings back the work of worktrees this Container never had.
 *
 * A snapshot comes back only when no local branch or worktree carries the
 * name and it is recent. The worktree starts at the saved merge base and the
 * saved files go on top, unstaged, so the work looks as it did when it was
 * lost: changes to review, not a commit nobody made.
 */
export async function restoreSnapshots(dependencies: RestoreDependencies, checkout: string): Promise<RestoreOutcome[]> {
  const { git, log } = dependencies
  const repository = await repositoryOf(git, checkout)
  if (repository === null) return []
  const access = await dependencies.request(repository, 'read')
  if (access === null) return []
  const env = authenticated(access)

  const listed = await git(['ls-remote', access.remote, `${SNAPSHOT_REF_PREFIX}*`], { cwd: checkout, env }).catch(
    () => '',
  )
  if (listed.trim() === '') return []
  await git(['fetch', '--quiet', access.remote, `+${SNAPSHOT_REF_PREFIX}*:${LOCAL_SNAPSHOT_REF_PREFIX}*`], {
    cwd: checkout,
    env,
  })

  const existing = new Set(
    parseLinkedWorktrees((await optional(git, ['worktree', 'list', '--porcelain'], checkout)) ?? '').map(
      (worktree) => worktree.branch,
    ),
  )
  const outcomes: RestoreOutcome[] = []
  const refs = (await git(['for-each-ref', '--format=%(refname)', LOCAL_SNAPSHOT_REF_PREFIX], { cwd: checkout }))
    .split('\n')
    .filter(Boolean)

  for (const ref of refs) {
    const encoded = ref.slice(LOCAL_SNAPSHOT_REF_PREFIX.length)
    const fallback = decodeBranch(encoded)
    try {
      const message = await git(['log', '-1', '--format=%B', ref], { cwd: checkout })
      const committed = Number((await git(['log', '-1', '--format=%ct', ref], { cwd: checkout })).trim())
      const branch = trailer(message, 'Branch') ?? fallback
      const mergeBase = trailer(message, 'Merge-Base')

      if (dependencies.now() - committed > MAXIMUM_SNAPSHOT_AGE_SECONDS) {
        outcomes.push({ _tag: 'Skipped', branch, reason: 'older than three days' })
        continue
      }
      if (
        existing.has(branch) ||
        (await optional(git, ['show-ref', '--verify', `refs/heads/${branch}`], checkout)) !== null
      ) {
        outcomes.push({ _tag: 'Skipped', branch, reason: 'the branch already exists here' })
        continue
      }
      if (mergeBase === null || (await optional(git, ['cat-file', '-e', `${mergeBase}^{commit}`], checkout)) === null) {
        outcomes.push({ _tag: 'Skipped', branch, reason: 'the merge base is not in this checkout' })
        continue
      }

      const path = await dependencies.createWorktree(checkout, branch, mergeBase)
      await git(['read-tree', '--reset', '-u', ref], { cwd: path })
      // Back to the merge base in the index, so the saved files read as unstaged work.
      await git(['reset', '--quiet'], { cwd: path })
      outcomes.push({ _tag: 'Restored', branch, path })
      log(`Restored the work on ${branch} from its snapshot.`)
    } catch (error) {
      outcomes.push({ _tag: 'Failed', branch: fallback, reason: reasonOf(error) })
    }
  }
  return outcomes
}
