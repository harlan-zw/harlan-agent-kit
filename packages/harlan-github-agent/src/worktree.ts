import type { GitIdentity } from './git-identity.ts'
import type { GitHubTokenProvider } from './github-auth.ts'
import type { GitHubPullRequestPublisher, GitHubSource } from './github.ts'
import type { PublicationRemote } from './publication-scheduler.ts'
import type { Result } from './result.ts'
import type { ClaimedAdversarialReviewTask, ClaimedBaselineRepairTask, ClaimedConflictResolutionTask, ClaimedIssueTriageTask, ClaimedIssueWorkTask, ClaimedPublicationCommand, ClaimedReviewFixTask, PullRequestBase } from './types.ts'
import { Buffer } from 'node:buffer'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'
import { StringDecoder } from 'node:string_decoder'
import { canPushBranch, canRepairBaseline, canWorkIssues, canWritePullRequestHead } from './repository-policy.ts'
import { err, ok } from './result.ts'
import { cleanLine } from './text.ts'

export interface PreparedConflictWorktree {
  path: string
  headSha: string
  baseSha: string
  conflictedFiles: string[]
}

export interface VerifiedConflictPatch {
  digest: string
  changedFiles: number
}

/** A verified change with the paths it touches, which decide the stack base. */
export interface VerifiedIssuePatch extends VerifiedConflictPatch {
  changedPaths: string[]
}

export interface PreparedConflictPublication extends VerifiedConflictPatch {
  commitSha: string
  baseSha: string
  artifactRef: string
}

export interface ConflictWorktreeManager {
  commit: (task: ClaimedConflictResolutionTask, worktree: PreparedConflictWorktree, patch: VerifiedConflictPatch, message: string, signal: AbortSignal) => Promise<Result<PreparedConflictPublication, string>>
  prepare: (task: ClaimedConflictResolutionTask, signal: AbortSignal) => Promise<Result<PreparedConflictWorktree, string>>
  verify: (task: ClaimedConflictResolutionTask, worktree: PreparedConflictWorktree, signal: AbortSignal) => Promise<Result<VerifiedConflictPatch, string>>
}

export interface ConflictWorktreeManagerOptions {
  gitIdentity?: GitIdentity
  remoteUrl?: (repository: string) => string
  root: string
  tokens: GitHubTokenProvider
}

export interface PreparedWorkerWorkspace {
  baseSha: string
  headSha: string
  path: string
}

/**
 * An issue workspace with the default branch tip it was prepared against.
 *
 * `baseSha` follows the chosen base, which a stack moves off the default branch.
 * `defaultBranchSha` never moves, so the triage session key stays stable whether
 * or not the pull request stacks.
 */
export interface PreparedIssueWorkspace extends PreparedWorkerWorkspace {
  defaultBranchSha: string
}

/**
 * Whether finished work moved onto a stack base.
 *
 * `Unstacked` is an expected outcome, not a failure. The work stays exactly
 * where it was prepared, so the pull request targets the default branch instead.
 */
export type RestackOutcome
  = | { _tag: 'Restacked', workspace: PreparedWorkerWorkspace, patch: VerifiedIssuePatch }
    | { _tag: 'Unstacked', reason: string }

export interface AgentWorkspaceManager {
  prepareBaseline: (task: ClaimedBaselineRepairTask, signal: AbortSignal) => Promise<Result<PreparedWorkerWorkspace, string>>
  prepareFix: (task: ClaimedReviewFixTask, signal: AbortSignal) => Promise<Result<PreparedWorkerWorkspace, string>>
  prepareIssue: (task: ClaimedIssueTriageTask | ClaimedIssueWorkTask, base: PullRequestBase, signal: AbortSignal) => Promise<Result<PreparedIssueWorkspace, string>>
  prepareReview: (task: ClaimedAdversarialReviewTask, signal: AbortSignal) => Promise<Result<PreparedWorkerWorkspace, string>>
}

export interface BaselineRepairWorktreeManager {
  commit: (task: ClaimedBaselineRepairTask, worktree: PreparedWorkerWorkspace, patch: VerifiedConflictPatch, message: string, signal: AbortSignal) => Promise<Result<PreparedConflictPublication, string>>
  prepare: (task: ClaimedBaselineRepairTask, signal: AbortSignal) => Promise<Result<PreparedWorkerWorkspace, string>>
  verify: (task: ClaimedBaselineRepairTask, worktree: PreparedWorkerWorkspace, signal: AbortSignal) => Promise<Result<VerifiedConflictPatch, string>>
}

export interface ReviewFixWorktreeManager {
  commit: (task: ClaimedReviewFixTask, worktree: PreparedWorkerWorkspace, patch: VerifiedConflictPatch, message: string, signal: AbortSignal) => Promise<Result<PreparedConflictPublication, string>>
  prepare: (task: ClaimedReviewFixTask, signal: AbortSignal) => Promise<Result<PreparedWorkerWorkspace, string>>
  verify: (task: ClaimedReviewFixTask, worktree: PreparedWorkerWorkspace, signal: AbortSignal) => Promise<Result<VerifiedConflictPatch, string>>
}

export interface IssueWorktreeManager {
  commit: (task: ClaimedIssueWorkTask, worktree: PreparedWorkerWorkspace, patch: VerifiedConflictPatch, message: string, signal: AbortSignal) => Promise<Result<PreparedConflictPublication, string>>
  prepare: (task: ClaimedIssueWorkTask, base: PullRequestBase, signal: AbortSignal) => Promise<Result<PreparedIssueWorkspace, string>>
  /** Moves verified, staged work onto one open pull request's head commit. */
  restack: (task: ClaimedIssueWorkTask, worktree: PreparedWorkerWorkspace, target: { headRef: string, headSha: string }, signal: AbortSignal) => Promise<Result<RestackOutcome, string>>
  verify: (task: ClaimedIssueWorkTask, worktree: PreparedWorkerWorkspace, signal: AbortSignal) => Promise<Result<VerifiedIssuePatch, string>>
}

interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

interface CommandDigestResult {
  digest: string
  exitCode: number
  stderr: string
}

interface WtWorktree {
  branch: string
  path: string
}

function gitEnvironment(githubToken?: string): NodeJS.ProcessEnv {
  const allowed = [
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_CONFIG_SYSTEM',
    'GNUPGHOME',
    'GPG_TTY',
    'HOME',
    'LANG',
    'LC_ALL',
    'LOGNAME',
    'PATH',
    'SHELL',
    'SSH_AUTH_SOCK',
    'SSL_CERT_DIR',
    'SSL_CERT_FILE',
    'TMPDIR',
    'USER',
    'XDG_CONFIG_HOME',
  ]
  const environment = Object.fromEntries(allowed.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]))
  if (githubToken === undefined) {
    return {
      ...environment,
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_PROTOCOL_FROM_USER: '0',
      GIT_TERMINAL_PROMPT: '0',
    }
  }

  return {
    ...environment,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${githubToken}`).toString('base64')}`,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_TERMINAL_PROMPT: '0',
  }
}

function runGit(checkout: string, args: string[], signal: AbortSignal, githubToken?: string, allowFileProtocol = false): Promise<CommandResult> {
  return new Promise((resolve) => {
    const protocols = allowFileProtocol
      ? ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.file.allow=always']
      : ['-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always']
    execFile(
      'git',
      ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', ...protocols, '-C', checkout, ...args],
      { encoding: 'utf8', env: gitEnvironment(githubToken), signal },
      (error, stdout, stderr) => resolve({
        exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
        stdout: stdout.trim(),
        stderr: stderr.trim() || error?.message.trim() || '',
      }),
    )
  })
}

function runWt(checkout: string, args: string[], signal: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      'wt',
      ['-C', checkout, ...args],
      { encoding: 'utf8', env: gitEnvironment(), signal },
      (error, stdout, stderr) => resolve({
        exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
        stdout: stdout.trim(),
        stderr: stderr.trim() || error?.message.trim() || '',
      }),
    )
  })
}

function runGitDigest(checkout: string, args: string[], signal: AbortSignal): Promise<CommandDigestResult> {
  return new Promise((resolve) => {
    const hash = createHash('sha256')
    const decoder = new StringDecoder('utf8')
    const stderr: Buffer[] = []
    let started = false
    let trailingWhitespace = ''
    let spawnError = ''

    const update = (value: string) => {
      let text = trailingWhitespace + value
      trailingWhitespace = ''
      if (!started) {
        text = text.trimStart()
        if (text.length === 0)
          return
        started = true
      }
      const trailing = text.match(/\s+$/u)?.[0] ?? ''
      if (trailing.length > 0) {
        trailingWhitespace = trailing
        text = text.slice(0, -trailing.length)
      }
      hash.update(text)
    }

    const child = spawn(
      'git',
      ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-C', checkout, ...args],
      { env: gitEnvironment(), signal, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    child.stdout.on('data', (chunk: Buffer) => update(decoder.write(chunk)))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', (error: Error) => {
      spawnError = error.message
    })
    child.on('close', (code) => {
      update(decoder.end())
      resolve({
        digest: hash.digest('hex'),
        exitCode: code ?? 1,
        stderr: Buffer.concat(stderr).toString('utf8').trim() || spawnError,
      })
    })
  })
}

/**
 * The `git diff` arguments that identify one change by content alone.
 *
 * A change is verified in a checkout and published from the controller mirror,
 * so its digest must read the same in both. Patch text does not: `git` scales
 * index line abbreviation with the object count of the repository, so a large
 * checkout wrote 11 character blob names where the mirror wrote 9, and every
 * publication of that repository failed on a digest that described the same
 * commit. Raw lines carry full blob names, the mode, and the path, and no diff
 * setting, `.gitattributes` driver, or object count can change them.
 */
function contentDiffArgs(...args: string[]): string[] {
  return ['diff', '--raw', '--no-abbrev', '--no-renames', ...args]
}

function repositoryGitDirectory(root: string, repository: string): string {
  return join(root, 'repositories', `${repository.replace('/', '__')}.git`)
}

function publicationArtifactRef(taskId: string): string {
  return `refs/harlan-github-agent/publications/${taskId}`
}

/**
 * Reads `wt list --format=json` into the branch worktrees the controller can claim.
 *
 * An entry only names a claimable worktree when it carries a branch name and an
 * absolute path. Everything else describes something the controller cannot use:
 * a detached head, a pruned directory, or a listing field `wt` grew after this
 * code was written. Those are skipped. A reader that failed the whole list on
 * one of them stranded every agent task in the repository, and one conflict
 * task restarted twenty one times behind it.
 *
 * Output that is not a list of entries at all is still a broken contract, so it
 * still fails rather than reporting an empty repository.
 */
export function parseWtWorktrees(stdout: string): Result<WtWorktree[], string> {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  }
  catch {
    return err('wt list returned invalid JSON.')
  }
  if (!Array.isArray(value))
    return err('wt list returned an invalid worktree list.')
  const worktrees: WtWorktree[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null)
      continue
    const branch: unknown = 'branch' in entry ? entry.branch : undefined
    const path: unknown = 'path' in entry ? entry.path : undefined
    if (typeof branch !== 'string' || branch.length === 0)
      continue
    if (typeof path !== 'string' || !isAbsolute(path))
      continue
    worktrees.push({ branch, path })
  }
  return ok(worktrees)
}

async function listWtWorktrees(checkout: string, signal: AbortSignal): Promise<Result<WtWorktree[], string>> {
  const listed = await runWt(checkout, ['list', '--format=json'], signal)
  if (listed.exitCode !== 0)
    return err(`Could not list wt worktrees: ${listed.stderr}`)
  return parseWtWorktrees(listed.stdout)
}

/** Every branch the agent creates for its own worktrees starts here. */
export const AGENT_WORKTREE_PREFIX = 'harlan-agent/'

/** One Task lease: the Task and the fence its Lease holder claimed. */
export interface AgentWorktreeLease {
  taskId: string
  fence: number
}

/**
 * Names the worktree one Task lease owns.
 *
 * The fence changes on every claim, so a fenced out Lease holder can never
 * share a working directory with the Lease holder that replaced it. Reusing
 * one worktree across fences would let a stale agent's uncommitted edits join
 * the next agent's published commit, and no HEAD check can see that, because
 * agents never commit.
 */
export function agentWorktreeLeaseKey(lease: AgentWorktreeLease): string {
  return createHash('sha256').update(`${lease.taskId}:${lease.fence}`).digest('hex').slice(0, 12)
}

function agentWorktreeLeaseKeyOf(branch: string): string | null {
  if (!branch.startsWith(AGENT_WORKTREE_PREFIX))
    return null
  const key = branch.slice(branch.lastIndexOf('-') + 1)
  return /^[0-9a-f]{12}$/u.test(key) ? key : null
}

export function agentWorktreeBranch(label: string, lease: AgentWorktreeLease): string {
  const safeLabel = label.replace(/[^\w.-]+/gu, '-').replace(/^[.-]+|[.-]+$/gu, '')
  return `${AGENT_WORKTREE_PREFIX}${safeLabel}-${agentWorktreeLeaseKey(lease)}`
}

async function prepareWtWorktree(
  checkout: string,
  branch: string,
  baseSha: string,
  signal: AbortSignal,
): Promise<Result<string, string>> {
  if (!isAbsolute(checkout))
    return err('The repository checkout must be an absolute path.')
  if (!isSafeGitRef(branch))
    return err('The agent worktree branch is unsafe.')

  const before = await listWtWorktrees(checkout, signal)
  if (before._tag === 'Err')
    return before
  let prepared = before.value.find(worktree => worktree.branch === branch)
  if (prepared === undefined) {
    const created = await runWt(checkout, ['switch', '--create', branch, '--base', baseSha, '--yes'], signal)
    if (created.exitCode !== 0) {
      const branchExists = await runGit(checkout, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], signal)
      if (branchExists.exitCode !== 0)
        return err(`Could not create the agent worktree with wt: ${created.stderr}`)
      const switched = await runWt(checkout, ['switch', branch, '--yes'], signal)
      if (switched.exitCode !== 0)
        return err(`Could not enter the agent worktree with wt: ${switched.stderr}`)
    }
    const after = await listWtWorktrees(checkout, signal)
    if (after._tag === 'Err')
      return after
    prepared = after.value.find(worktree => worktree.branch === branch)
  }
  if (prepared === undefined)
    return err('wt did not report the prepared agent worktree.')

  const head = await runGit(prepared.path, ['rev-parse', 'HEAD'], signal)
  if (head.exitCode !== 0 || head.stdout !== baseSha)
    return err('The wt worktree does not match the required head commit.')
  return ok(prepared.path)
}

export interface AgentWorktreeSweep {
  removed: string[]
  failures: Array<{ branch: string, reason: string }>
}

export interface AgentWorktreeSweepOptions {
  checkout: string
  /**
   * Reads the lease keys that may still write, called after the worktrees are
   * listed. A lease claimed after the listing owns no worktree yet, so reading
   * later can only keep more worktrees, never remove a live one.
   */
  readLiveLeaseKeys: () => ReadonlySet<string>
}

/**
 * Removes one agent worktree with wt, the only tool that owns worktrees here.
 *
 * wt refuses a worktree that holds uncommitted or untracked files, and agents
 * always leave both. The worktree is reset and cleaned first, so removal never
 * needs a force flag.
 */
export async function releaseAgentWorktree(
  checkout: string,
  branch: string,
  signal: AbortSignal,
): Promise<Result<'Removed' | 'Absent', string>> {
  if (!isAbsolute(checkout))
    return err('The repository checkout must be an absolute path.')
  if (!branch.startsWith(AGENT_WORKTREE_PREFIX))
    return err('The branch is outside the agent worktree namespace.')
  if (!isSafeGitRef(branch))
    return err('The agent worktree branch is unsafe.')

  const listed = await listWtWorktrees(checkout, signal)
  if (listed._tag === 'Err')
    return listed
  const worktree = listed.value.find(entry => entry.branch === branch)
  if (worktree === undefined)
    return ok('Absent')
  if (worktree.path === checkout)
    return err('The agent worktree branch names the repository checkout.')

  const reset = await runGit(worktree.path, ['reset', '--hard'], signal)
  if (reset.exitCode !== 0)
    return err(`Could not reset the agent worktree: ${reset.stderr}`)
  const cleaned = await runGit(worktree.path, ['clean', '-fdq'], signal)
  if (cleaned.exitCode !== 0)
    return err(`Could not clean the agent worktree: ${cleaned.stderr}`)
  const removed = await runWt(checkout, ['remove', branch, '--yes', '--foreground'], signal)
  return removed.exitCode === 0
    ? ok('Removed')
    : err(`Could not remove the agent worktree with wt: ${removed.stderr || removed.stdout}`)
}

/**
 * Names every agent worktree in one checkout that no live Task lease uses.
 *
 * A Task keeps one worktree per fence, and only the current fence can still be
 * written. Every earlier fence was already fenced out of the journal, so
 * nothing may write its worktree again.
 */
export async function listSweepableAgentWorktrees(
  options: AgentWorktreeSweepOptions,
  signal: AbortSignal,
): Promise<Result<string[], string>> {
  const listed = await listWtWorktrees(options.checkout, signal)
  if (listed._tag === 'Err')
    return listed
  // A branch outside the agent namespace is Harlan's, and the checkout itself
  // is never a candidate.
  const candidates = listed.value.filter(worktree =>
    worktree.branch.startsWith(AGENT_WORKTREE_PREFIX) && worktree.path !== options.checkout)
  if (candidates.length === 0)
    return ok([])

  // The live leases are read after the listing. A lease claimed later owns no
  // worktree yet, so reading later can only keep more worktrees.
  const live = options.readLiveLeaseKeys()
  return ok(candidates
    .filter((worktree) => {
      const key = agentWorktreeLeaseKeyOf(worktree.branch)
      return key === null || !live.has(key)
    })
    .map(worktree => worktree.branch))
}

/**
 * Removes every agent worktree in one checkout that no live Task lease uses.
 *
 * Without this sweep every retry left its worktree behind for good.
 */
export async function sweepAgentWorktrees(
  options: AgentWorktreeSweepOptions,
  signal: AbortSignal,
): Promise<Result<AgentWorktreeSweep, string>> {
  const sweepable = await listSweepableAgentWorktrees(options, signal)
  if (sweepable._tag === 'Err')
    return sweepable

  const removed: string[] = []
  const failures: Array<{ branch: string, reason: string }> = []
  for (const branch of sweepable.value) {
    const release = await releaseAgentWorktree(options.checkout, branch, signal)
    if (release._tag === 'Err')
      failures.push({ branch, reason: release.error })
    else if (release.value === 'Removed')
      removed.push(branch)
  }
  return ok({ removed, failures })
}

function isSafeGitRef(ref: string): boolean {
  return /^[A-Z0-9][\w./-]*$/i.test(ref)
    && !ref.includes('..')
    && !ref.includes('@{')
    && !ref.endsWith('.')
    && !ref.endsWith('/')
    && !ref.includes('//')
}

async function ensureControllerRepository(root: string, repositoryName: string, signal: AbortSignal): Promise<Result<string, string>> {
  const repository = repositoryGitDirectory(root, repositoryName)
  await mkdir(repository, { recursive: true, mode: 0o700 })
  const initialized = await runGit(repository, ['rev-parse', '--is-bare-repository'], signal)
  if (initialized.exitCode === 0)
    return ok(repository)
  const init = await runGit(repository, ['init', '--bare', '.'], signal)
  return init.exitCode === 0
    ? ok(repository)
    : err(`Could not create the controller repository: ${init.stderr}`)
}

async function pinPublicationArtifact(
  root: string,
  repositoryName: string,
  taskId: string,
  worktree: string,
  commitSha: string,
  signal: AbortSignal,
): Promise<Result<string, string>> {
  const repository = await ensureControllerRepository(root, repositoryName, signal)
  if (repository._tag === 'Err')
    return repository
  const artifactRef = publicationArtifactRef(taskId)
  const pinned = await runGit(repository.value, [
    'fetch',
    '--no-tags',
    worktree,
    `+${commitSha}:${artifactRef}`,
  ], signal, undefined, true)
  return pinned.exitCode === 0
    ? ok(artifactRef)
    : err(`Could not pin the publication artifact: ${pinned.stderr}`)
}

export function createConflictWorktreeManager(options: ConflictWorktreeManagerOptions): ConflictWorktreeManager {
  if (options.gitIdentity === undefined)
    throw new Error('A Git commit identity is required.')
  const gitIdentity = options.gitIdentity
  async function prepare(task: ClaimedConflictResolutionTask, signal: AbortSignal): Promise<Result<PreparedConflictWorktree, string>> {
    const branch = agentWorktreeBranch(`pull-${task.pullRequestNumber}-${task.revisionId.slice(0, 12)}`, { taskId: task.id, fence: task.state.fence })
    const repository = task.repositoryMapping.checkout

    const headRef = `refs/harlan-github-agent/pull/${task.pullRequestNumber}`
    const baseRef = `refs/harlan-github-agent/base/${task.pullRequestNumber}`
    const token = await options.tokens.getToken(task.repository, 'read', signal)
    if (token._tag === 'Err')
      return err(token.error.message)
    const remoteUrl = options.remoteUrl?.(task.repository) ?? `https://github.com/${task.repository}.git`
    const fetch = await runGit(repository, [
      'fetch',
      '--no-tags',
      remoteUrl,
      `+refs/pull/${task.pullRequestNumber}/head:${headRef}`,
      `+refs/heads/${task.repositoryMapping.defaultBranch}:${baseRef}`,
    ], signal, token.value.token, options.remoteUrl !== undefined)
    if (fetch.exitCode !== 0)
      return err(`Git fetch failed: ${fetch.stderr}`)

    const head = await runGit(repository, ['rev-parse', headRef], signal)
    if (head.exitCode !== 0 || head.stdout !== task.pullRequest.headSha)
      return err('Fetched pull request head no longer matches the claimed commit SHA.')
    const base = await runGit(repository, ['rev-parse', baseRef], signal)
    if (base.exitCode !== 0)
      return err(`Could not resolve the base branch: ${base.stderr}`)
    const worktree = await prepareWtWorktree(repository, branch, head.stdout, signal)
    if (worktree._tag === 'Err')
      return worktree

    const merge = await runGit(worktree.value, [
      '-c',
      `user.name=${gitIdentity.name}`,
      '-c',
      `user.email=${gitIdentity.email}`,
      'merge',
      '--no-commit',
      '--no-ff',
      base.stdout,
    ], signal)
    const unmerged = await runGit(worktree.value, ['diff', '--name-only', '--diff-filter=U'], signal)
    if (merge.exitCode === 0 || unmerged.stdout.length === 0) {
      await runGit(worktree.value, ['merge', '--abort'], signal)
      return err('Git no longer reports merge conflicts for this head commit.')
    }

    return ok({
      path: worktree.value,
      headSha: head.stdout,
      baseSha: base.stdout,
      conflictedFiles: unmerged.stdout.split('\n').filter(Boolean).sort(),
    })
  }

  async function commit(
    task: ClaimedConflictResolutionTask,
    worktree: PreparedConflictWorktree,
    patch: VerifiedConflictPatch,
    message: string,
    signal: AbortSignal,
  ): Promise<Result<PreparedConflictPublication, string>> {
    const add = await runGit(worktree.path, ['add', '--all'], signal)
    if (add.exitCode !== 0)
      return err(`Could not stage the conflict resolution: ${add.stderr}`)
    const committed = await runGit(worktree.path, [
      '-c',
      `user.name=${gitIdentity.name}`,
      '-c',
      `user.email=${gitIdentity.email}`,
      'commit',
      '-m',
      message,
    ], signal)
    if (committed.exitCode !== 0)
      return err(`Could not commit the conflict resolution: ${committed.stderr || committed.stdout}`)
    const commitSha = await runGit(worktree.path, ['rev-parse', 'HEAD'], signal)
    if (commitSha.exitCode !== 0)
      return err(`Could not resolve the conflict commit: ${commitSha.stderr}`)
    const parents = await runGit(worktree.path, ['show', '--no-patch', '--format=%P', commitSha.stdout], signal)
    const expectedParents = [worktree.headSha, worktree.baseSha]
    if (parents.exitCode !== 0 || !expectedParents.every(parent => parents.stdout.split(' ').includes(parent)))
      return err('The conflict commit does not contain the expected head and base parents.')

    const artifactRef = await pinPublicationArtifact(options.root, task.repository, task.id, worktree.path, commitSha.stdout, signal)
    if (artifactRef._tag === 'Err')
      return artifactRef

    return ok({ ...patch, commitSha: commitSha.stdout, baseSha: worktree.baseSha, artifactRef: artifactRef.value })
  }

  async function verify(
    task: ClaimedConflictResolutionTask,
    worktree: PreparedConflictWorktree,
    signal: AbortSignal,
  ): Promise<Result<VerifiedConflictPatch, string>> {
    const head = await runGit(worktree.path, ['rev-parse', 'HEAD'], signal)
    if (head.exitCode !== 0 || head.stdout !== task.pullRequest.headSha)
      return err('The worker changed HEAD. Workers must not commit or rewrite history.')

    const workerChanged = await runGit(worktree.path, ['diff', '--name-only'], signal)
    if (workerChanged.exitCode !== 0)
      return err(`Could not inspect the conflict fix: ${workerChanged.stderr}`)
    const workerChangedPaths = workerChanged.stdout.split('\n').filter(Boolean).sort()
    // The merge, not the conflict list, bounds what a resolution may touch. A
    // marker is only where two edits met: reconciling them often means the test
    // or the call site the base branch moved, and refusing those killed correct
    // resolutions outright. Anything the merge did not touch is still unrelated
    // work that has no place in a merge commit.
    const mergeBase = await runGit(worktree.path, ['merge-base', worktree.headSha, worktree.baseSha], signal)
    if (mergeBase.exitCode !== 0)
      return err(`Could not resolve the merge base: ${mergeBase.stderr}`)
    const merged = await runGit(worktree.path, ['diff', '--name-only', mergeBase.stdout, worktree.baseSha], signal)
    if (merged.exitCode !== 0)
      return err(`Could not inspect what the base branch changed: ${merged.stderr}`)
    const writablePaths = new Set([...worktree.conflictedFiles, ...merged.stdout.split('\n').filter(Boolean)])
    const unexpectedPath = workerChangedPaths.find(path => !writablePaths.has(path))
    if (unexpectedPath !== undefined)
      return err(`The worker changed a file the merge did not touch: ${unexpectedPath}.`)
    const untracked = await runGit(worktree.path, ['ls-files', '--others', '--exclude-standard'], signal)
    if (untracked.exitCode !== 0)
      return err(`Could not inspect untracked files: ${untracked.stderr}`)
    if (untracked.stdout.length > 0)
      return err(`The worker created an untracked file: ${untracked.stdout.split('\n')[0]}.`)

    const diffCheck = await runGit(worktree.path, ['diff', '--check'], signal)
    if (diffCheck.exitCode !== 0)
      return err(`Resolved patch failed git diff check: ${diffCheck.stdout || diffCheck.stderr}`)

    // Conflicted files stage even when the worker left one side untouched, or
    // the merge stays unresolved. Everything the worker touched stages with them.
    const staged = await runGit(worktree.path, ['add', '--', ...new Set([...worktree.conflictedFiles, ...workerChangedPaths])], signal)
    if (staged.exitCode !== 0)
      return err(`Could not stage the conflict fix: ${staged.stderr}`)
    const unmerged = await runGit(worktree.path, ['diff', '--name-only', '--diff-filter=U'], signal)
    if (unmerged.exitCode !== 0 || unmerged.stdout.length > 0)
      return err(`Merge conflicts remain: ${unmerged.stdout || unmerged.stderr}`)

    const patch = await runGitDigest(worktree.path, contentDiffArgs('--cached', 'HEAD'), signal)
    if (patch.exitCode !== 0)
      return err(`Could not read the conflict resolution patch: ${patch.stderr}`)
    const changed = await runGit(worktree.path, ['diff', '--cached', '--name-only', 'HEAD'], signal)
    const changedPaths = changed.stdout.split('\n').filter(Boolean).sort()
    const changedFiles = changedPaths.length

    return ok({
      digest: patch.digest,
      changedFiles,
    })
  }

  return { commit, prepare, verify }
}

export function createAgentWorkspaceManager(options: ConflictWorktreeManagerOptions): AgentWorkspaceManager {
  async function prepareRepository(
    task: ClaimedAdversarialReviewTask | ClaimedReviewFixTask | ClaimedBaselineRepairTask | ClaimedIssueTriageTask | ClaimedIssueWorkTask,
    label: string,
    refs: string[],
    headRef: string,
    signal: AbortSignal,
  ): Promise<Result<PreparedWorkerWorkspace, string>> {
    const repository = task.repositoryMapping.checkout

    const token = await options.tokens.getToken(task.repository, 'read', signal)
    if (token._tag === 'Err')
      return err(token.error.message)
    const remoteUrl = options.remoteUrl?.(task.repository) ?? `https://github.com/${task.repository}.git`
    const fetch = await runGit(repository, ['fetch', '--no-tags', remoteUrl, ...refs], signal, token.value.token, options.remoteUrl !== undefined)
    if (fetch.exitCode !== 0)
      return err(`Git fetch failed: ${fetch.stderr}`)

    const head = await runGit(repository, ['rev-parse', headRef], signal)
    if (head.exitCode !== 0)
      return err(`Could not resolve the Worker head: ${head.stderr}`)
    const branch = agentWorktreeBranch(label, { taskId: task.id, fence: task.state.fence })
    const worktree = await prepareWtWorktree(repository, branch, head.stdout, signal)
    return worktree._tag === 'Err'
      ? worktree
      : ok({ path: worktree.value, baseSha: head.stdout, headSha: head.stdout })
  }

  return {
    async prepareBaseline(task, signal) {
      const baseRef = `refs/harlan-github-agent/baselines/${task.pullRequest.baseSha}`
      const prepared = await prepareRepository(
        task,
        `baseline-${task.pullRequest.baseSha.slice(0, 12)}`,
        [`+refs/heads/${task.repositoryMapping.defaultBranch}:${baseRef}`],
        baseRef,
        signal,
      )
      // The fetched default branch tip is returned as-is. The worker compares it
      // to the queued base commit, because a moved default branch retires the
      // repair rather than failing it.
      return prepared
    },

    async prepareFix(task, signal) {
      const headRef = `refs/harlan-github-agent/fixes/${task.pullRequestNumber}/head`
      const baseRef = `refs/harlan-github-agent/fixes/${task.pullRequestNumber}/base`
      const prepared = await prepareRepository(
        task,
        `fix-${task.pullRequestNumber}-${task.revisionId.slice(0, 12)}`,
        [
          `+refs/pull/${task.pullRequestNumber}/head:${headRef}`,
          `+${task.pullRequest.baseSha}:${baseRef}`,
        ],
        headRef,
        signal,
      )
      if (prepared._tag === 'Err')
        return prepared
      if (prepared.value.headSha !== task.pullRequest.headSha)
        return err('Fetched pull request head no longer matches the approved repair commit SHA.')
      const repository = task.repositoryMapping.checkout
      const base = await runGit(repository, ['rev-parse', baseRef], signal)
      if (base.exitCode !== 0 || base.stdout !== task.pullRequest.baseSha)
        return err('Fetched base branch no longer matches the approved repair base commit SHA.')
      return ok({ ...prepared.value, baseSha: base.stdout })
    },

    async prepareIssue(task, base, signal) {
      const defaultRef = `refs/harlan-github-agent/issues/${task.issueNumber}/base`
      const stackRef = `refs/harlan-github-agent/issues/${task.issueNumber}/stack`
      if (!isSafeGitRef(base.ref))
        return err('The pull request base branch is unsafe.')
      const stacked = base._tag === 'Stacked'
      const prepared = await prepareRepository(
        task,
        `issue-${task.issueNumber}-${task.revisionId.slice(0, 12)}`,
        [
          `+refs/heads/${task.repositoryMapping.defaultBranch}:${defaultRef}`,
          ...(stacked ? [`+refs/heads/${base.ref}:${stackRef}`] : []),
        ],
        stacked ? stackRef : defaultRef,
        signal,
      )
      if (prepared._tag === 'Err')
        return prepared
      const defaultBranch = await runGit(task.repositoryMapping.checkout, ['rev-parse', defaultRef], signal)
      if (defaultBranch.exitCode !== 0)
        return err(`Could not resolve the default branch: ${defaultBranch.stderr}`)
      if (stacked && prepared.value.baseSha !== base.headSha)
        return err('The stack base branch moved before the worktree was prepared.')
      return ok({ ...prepared.value, defaultBranchSha: defaultBranch.stdout })
    },

    async prepareReview(task, signal) {
      const headRef = `refs/harlan-github-agent/reviews/${task.pullRequestNumber}/head`
      const baseRef = `refs/harlan-github-agent/reviews/${task.pullRequestNumber}/base`
      const prepared = await prepareRepository(
        task,
        `review-${task.pullRequestNumber}-${task.revisionId.slice(0, 12)}`,
        [
          `+refs/pull/${task.pullRequestNumber}/head:${headRef}`,
          `+${task.pullRequest.baseSha}:${baseRef}`,
        ],
        headRef,
        signal,
      )
      if (prepared._tag === 'Err')
        return prepared
      if (prepared.value.headSha !== task.pullRequest.headSha)
        return err('Fetched pull request head no longer matches the claimed review commit SHA.')
      const repository = task.repositoryMapping.checkout
      const base = await runGit(repository, ['rev-parse', baseRef], signal)
      if (base.exitCode !== 0 || base.stdout !== task.pullRequest.baseSha)
        return err('Fetched base branch no longer matches the claimed review base commit SHA.')
      return ok({ ...prepared.value, baseSha: base.stdout })
    },
  }
}

export function createReviewFixWorktreeManager(options: ConflictWorktreeManagerOptions): ReviewFixWorktreeManager {
  if (options.gitIdentity === undefined)
    throw new Error('A Git commit identity is required.')
  const gitIdentity = options.gitIdentity
  const workspaces = createAgentWorkspaceManager(options)

  return {
    prepare: workspaces.prepareFix,

    async verify(task, worktree, signal) {
      const head = await runGit(worktree.path, ['rev-parse', 'HEAD'], signal)
      if (head.exitCode !== 0 || head.stdout !== task.pullRequest.headSha)
        return err('The agent changed HEAD. Agents must not commit or rewrite history.')
      const staged = await runGit(worktree.path, ['diff', '--cached', '--quiet'], signal)
      if (staged.exitCode !== 0)
        return err('The agent staged files. The controller must stage the verified repair.')
      const diffCheck = await runGit(worktree.path, ['diff', '--check'], signal)
      if (diffCheck.exitCode !== 0)
        return err(`The repair failed git diff check: ${diffCheck.stdout || diffCheck.stderr}`)
      const add = await runGit(worktree.path, ['add', '--all'], signal)
      if (add.exitCode !== 0)
        return err(`Could not stage the verified repair: ${add.stderr}`)
      const patch = await runGitDigest(worktree.path, contentDiffArgs('--cached', 'HEAD'), signal)
      if (patch.exitCode !== 0)
        return err(`Could not read the verified repair: ${patch.stderr}`)
      const changed = await runGit(worktree.path, ['diff', '--cached', '--name-only', '-z', 'HEAD'], signal)
      if (changed.exitCode !== 0)
        return err(`Could not inspect repaired files: ${changed.stderr}`)
      const changedPaths = changed.stdout.split('\0').filter(Boolean)
      const contributorFork = task.pullRequest.headRepository.toLowerCase() !== task.repository.toLowerCase()
      const workflowPath = contributorFork
        ? changedPaths.find(path => path.startsWith('.github/workflows/'))
        : undefined
      if (workflowPath !== undefined)
        return err(`The controller cannot publish workflow changes to a contributor fork: ${workflowPath}.`)
      const changedFiles = changedPaths.length
      if (changedFiles === 0)
        return err('The agent completed without changing any files.')
      return ok({
        digest: patch.digest,
        changedFiles,
      })
    },

    async commit(task, worktree, patch, message, signal) {
      const committed = await runGit(worktree.path, [
        '-c',
        `user.name=${gitIdentity.name}`,
        '-c',
        `user.email=${gitIdentity.email}`,
        'commit',
        '-m',
        message,
      ], signal)
      if (committed.exitCode !== 0)
        return err(`Could not commit the verified repair: ${committed.stderr || committed.stdout}`)
      const commitSha = await runGit(worktree.path, ['rev-parse', 'HEAD'], signal)
      if (commitSha.exitCode !== 0)
        return err(`Could not resolve the repair commit: ${commitSha.stderr}`)
      const parent = await runGit(worktree.path, ['show', '--no-patch', '--format=%P', commitSha.stdout], signal)
      if (parent.exitCode !== 0 || parent.stdout !== worktree.headSha)
        return err('The repair commit does not have the approved head commit as its parent.')
      const artifactRef = await pinPublicationArtifact(options.root, task.repository, task.id, worktree.path, commitSha.stdout, signal)
      if (artifactRef._tag === 'Err')
        return err(`Could not pin the repair artifact: ${artifactRef.error}`)
      return ok({ ...patch, commitSha: commitSha.stdout, baseSha: worktree.baseSha, artifactRef: artifactRef.value })
    },
  }
}

export function createBaselineRepairWorktreeManager(options: ConflictWorktreeManagerOptions): BaselineRepairWorktreeManager {
  if (options.gitIdentity === undefined)
    throw new Error('A Git commit identity is required.')
  const gitIdentity = options.gitIdentity
  const workspaces = createAgentWorkspaceManager(options)

  return {
    prepare: workspaces.prepareBaseline,

    async verify(_task, worktree, signal) {
      const head = await runGit(worktree.path, ['rev-parse', 'HEAD'], signal)
      if (head.exitCode !== 0 || head.stdout !== worktree.baseSha)
        return err('The agent changed HEAD. Agents must not commit or rewrite history.')
      const staged = await runGit(worktree.path, ['diff', '--cached', '--quiet'], signal)
      if (staged.exitCode !== 0)
        return err('The agent staged files. The controller must stage the verified change.')
      const diffCheck = await runGit(worktree.path, ['diff', '--check'], signal)
      if (diffCheck.exitCode !== 0)
        return err(`The Baseline repair failed git diff check: ${diffCheck.stdout || diffCheck.stderr}`)
      const add = await runGit(worktree.path, ['add', '--all'], signal)
      if (add.exitCode !== 0)
        return err(`Could not stage the verified Baseline repair: ${add.stderr}`)
      const patch = await runGitDigest(worktree.path, contentDiffArgs('--cached', 'HEAD'), signal)
      if (patch.exitCode !== 0)
        return err(`Could not read the verified Baseline repair: ${patch.stderr}`)
      const changed = await runGit(worktree.path, ['diff', '--cached', '--name-only', '-z', 'HEAD'], signal)
      if (changed.exitCode !== 0)
        return err(`Could not inspect repaired files: ${changed.stderr}`)
      const changedFiles = changed.stdout.split('\0').filter(Boolean).length
      return changedFiles === 0
        ? err('The agent completed without changing any files.')
        : ok({ digest: patch.digest, changedFiles })
    },

    async commit(task, worktree, patch, message, signal) {
      const committed = await runGit(worktree.path, [
        '-c',
        `user.name=${gitIdentity.name}`,
        '-c',
        `user.email=${gitIdentity.email}`,
        'commit',
        '-m',
        message,
      ], signal)
      if (committed.exitCode !== 0)
        return err(`Could not commit the verified Baseline repair: ${committed.stderr || committed.stdout}`)
      const commitSha = await runGit(worktree.path, ['rev-parse', 'HEAD'], signal)
      if (commitSha.exitCode !== 0)
        return err(`Could not resolve the Baseline repair commit: ${commitSha.stderr}`)
      const parent = await runGit(worktree.path, ['show', '--no-patch', '--format=%P', commitSha.stdout], signal)
      if (parent.exitCode !== 0 || parent.stdout !== worktree.baseSha)
        return err('The Baseline repair commit does not have the failing base commit as its parent.')
      const artifactRef = await pinPublicationArtifact(options.root, task.repository, task.id, worktree.path, commitSha.stdout, signal)
      if (artifactRef._tag === 'Err')
        return err(`Could not pin the Baseline repair artifact: ${artifactRef.error}`)
      return ok({ ...patch, commitSha: commitSha.stdout, baseSha: worktree.baseSha, artifactRef: artifactRef.value })
    },
  }
}

export function createIssueWorktreeManager(options: ConflictWorktreeManagerOptions): IssueWorktreeManager {
  if (options.gitIdentity === undefined)
    throw new Error('A Git commit identity is required.')
  const gitIdentity = options.gitIdentity
  const workspaces = createAgentWorkspaceManager(options)

  return {
    prepare: workspaces.prepareIssue,

    async verify(task, worktree, signal) {
      const head = await runGit(worktree.path, ['rev-parse', 'HEAD'], signal)
      if (head.exitCode !== 0 || head.stdout !== worktree.baseSha)
        return err('The agent changed HEAD. Agents must not commit or rewrite history.')
      const staged = await runGit(worktree.path, ['diff', '--cached', '--quiet'], signal)
      if (staged.exitCode !== 0)
        return err('The agent staged files. The controller must stage the verified change.')
      const diffCheck = await runGit(worktree.path, ['diff', '--check'], signal)
      if (diffCheck.exitCode !== 0)
        return err(`The change failed git diff check: ${diffCheck.stdout || diffCheck.stderr}`)
      const add = await runGit(worktree.path, ['add', '--all'], signal)
      if (add.exitCode !== 0)
        return err(`Could not stage the verified change: ${add.stderr}`)
      const patch = await runGitDigest(worktree.path, contentDiffArgs('--cached', 'HEAD'), signal)
      if (patch.exitCode !== 0)
        return err(`Could not read the verified change: ${patch.stderr}`)
      const changed = await runGit(worktree.path, ['diff', '--cached', '--name-only', '-z', 'HEAD'], signal)
      if (changed.exitCode !== 0)
        return err(`Could not inspect changed files: ${changed.stderr}`)
      const changedPaths = changed.stdout.split('\0').filter(Boolean)
      if (changedPaths.length === 0)
        return err('The agent completed without changing any files.')
      return ok({ digest: patch.digest, changedFiles: changedPaths.length, changedPaths })
    },

    /**
     * Stacking is optional, and the agent turn before it is not. Every failure
     * before the change is captured returns `Unstacked`, so the pull request
     * still goes out. Only a failure that could leave the worktree half moved
     * fails the Task.
     */
    async restack(task, worktree, target, signal) {
      if (!isSafeGitRef(target.headRef))
        return err('The stack base branch is unsafe.')
      const token = await options.tokens.getToken(task.repository, 'read', signal)
      if (token._tag === 'Err')
        return ok({ _tag: 'Unstacked', reason: `GitHub refused a token for the stack base: ${token.error.message}` })
      const remoteUrl = options.remoteUrl?.(task.repository) ?? `https://github.com/${task.repository}.git`
      const stackRef = `refs/harlan-github-agent/issues/${task.issueNumber}/stack`
      const fetched = await runGit(
        worktree.path,
        ['fetch', '--no-tags', remoteUrl, `+refs/heads/${target.headRef}:${stackRef}`],
        signal,
        token.value.token,
        options.remoteUrl !== undefined,
      )
      if (fetched.exitCode !== 0)
        return ok({ _tag: 'Unstacked', reason: `Could not fetch the stack base branch: ${cleanLine(fetched.stderr)}` })
      const stackHead = await runGit(worktree.path, ['rev-parse', stackRef], signal)
      if (stackHead.exitCode !== 0)
        return ok({ _tag: 'Unstacked', reason: `Could not resolve the stack base branch: ${cleanLine(stackHead.stderr)}` })
      if (stackHead.stdout !== target.headSha)
        return ok({ _tag: 'Unstacked', reason: 'The stack base branch moved.' })

      // The staged change becomes one commit so it survives the reset below.
      const captured = await runGit(worktree.path, [
        '-c',
        `user.name=${gitIdentity.name}`,
        '-c',
        `user.email=${gitIdentity.email}`,
        'commit',
        '-m',
        'chore: capture the verified change before it moves',
      ], signal)
      if (captured.exitCode !== 0)
        return err(`Could not capture the verified change: ${captured.stderr || captured.stdout}`)
      const capturedSha = await runGit(worktree.path, ['rev-parse', 'HEAD'], signal)
      if (capturedSha.exitCode !== 0)
        return err(`Could not resolve the captured change: ${capturedSha.stderr}`)

      /** Puts the worktree back exactly where `verify` left it. */
      const restore = async (): Promise<Result<void, string>> => {
        const reset = await runGit(worktree.path, ['reset', '--hard', capturedSha.stdout], signal)
        if (reset.exitCode !== 0)
          return err(`Could not restore the verified change: ${reset.stderr}`)
        const unstage = await runGit(worktree.path, ['reset', '--soft', worktree.baseSha], signal)
        return unstage.exitCode === 0 ? ok(undefined) : err(`Could not restore the prepared base: ${unstage.stderr}`)
      }

      const moved = await runGit(worktree.path, ['reset', '--hard', target.headSha], signal)
      if (moved.exitCode !== 0)
        return err(`Could not move the worktree onto the stack base: ${moved.stderr}`)
      const applied = await runGit(worktree.path, ['cherry-pick', '--no-commit', capturedSha.stdout], signal)
      if (applied.exitCode !== 0) {
        const reason = `The stack base conflicts with this change: ${cleanLine(applied.stderr || applied.stdout)}`
        // `cherry-pick --no-commit` leaves no sequencer state to abort when it
        // fails outright, so a failed abort is not evidence of a broken worktree.
        await runGit(worktree.path, ['cherry-pick', '--abort'], signal)
        const restored = await restore()
        return restored._tag === 'Err' ? restored : ok({ _tag: 'Unstacked', reason })
      }
      const patch = await runGitDigest(worktree.path, contentDiffArgs('--cached', 'HEAD'), signal)
      if (patch.exitCode !== 0)
        return err(`Could not read the restacked change: ${patch.stderr}`)
      const changed = await runGit(worktree.path, ['diff', '--cached', '--name-only', '-z', 'HEAD'], signal)
      if (changed.exitCode !== 0)
        return err(`Could not inspect restacked files: ${changed.stderr}`)
      const changedPaths = changed.stdout.split('\0').filter(Boolean)
      if (changedPaths.length === 0) {
        const restored = await restore()
        return restored._tag === 'Err' ? restored : ok({ _tag: 'Unstacked', reason: 'The stack base already carries this change.' })
      }
      return ok({
        _tag: 'Restacked',
        workspace: { ...worktree, baseSha: target.headSha, headSha: target.headSha },
        patch: { digest: patch.digest, changedFiles: changedPaths.length, changedPaths },
      })
    },

    async commit(task, worktree, patch, message, signal) {
      const committed = await runGit(worktree.path, [
        '-c',
        `user.name=${gitIdentity.name}`,
        '-c',
        `user.email=${gitIdentity.email}`,
        'commit',
        '-m',
        message,
      ], signal)
      if (committed.exitCode !== 0)
        return err(`Could not commit the verified change: ${committed.stderr || committed.stdout}`)
      const commitSha = await runGit(worktree.path, ['rev-parse', 'HEAD'], signal)
      if (commitSha.exitCode !== 0)
        return err(`Could not resolve the issue work commit: ${commitSha.stderr}`)
      const parent = await runGit(worktree.path, ['show', '--no-patch', '--format=%P', commitSha.stdout], signal)
      if (parent.exitCode !== 0 || parent.stdout !== worktree.baseSha)
        return err('The issue work commit does not have the approved base commit as its parent.')
      const artifactRef = await pinPublicationArtifact(options.root, task.repository, task.id, worktree.path, commitSha.stdout, signal)
      if (artifactRef._tag === 'Err')
        return err(`Could not pin the issue work artifact: ${artifactRef.error}`)
      return ok({ ...patch, commitSha: commitSha.stdout, baseSha: worktree.baseSha, artifactRef: artifactRef.value })
    },
  }
}

export interface GitPublicationRemoteOptions {
  github: Pick<GitHubSource, 'getPullRequest' | 'hasOpenPullRequestForBranch' | 'isBranchProtected'>
  pullRequests?: GitHubPullRequestPublisher
  root: string
  remoteUrl?: (repository: string) => string
  tokens: GitHubTokenProvider
}

function publicationRemoteUrl(repository: string): string {
  return `https://github.com/${repository}.git`
}

function publicationTargetRepository(command: ClaimedPublicationCommand): string {
  return command._tag === 'UpdatePullRequest'
    ? command.headRepository ?? command.repository
    : command.repository
}

export function createGitPublicationRemote(options: GitPublicationRemoteOptions): PublicationRemote {
  const remoteUrl = options.remoteUrl ?? publicationRemoteUrl

  async function token(command: ClaimedPublicationCommand, signal: AbortSignal): Promise<Result<string, string>> {
    const result = await options.tokens.getToken(command.repository, 'contents_write', signal)
    return result._tag === 'Ok' ? ok(result.value.token) : err(result.error.message)
  }

  return {
    async validateAuthority(command, signal) {
      if (
        !canPushBranch(command.repositoryMapping)
        || command.headRef === command.repositoryMapping.defaultBranch
        || !command.repositoryMapping.writablePullRequestHeadPrefixes.some(prefix => command.headRef.startsWith(prefix))
      ) {
        return err('Repository policy does not authorize this pull request branch.')
      }
      if (command._tag === 'OpenPullRequest') {
        if (command.taskKind === 'issue_work' && (!command.repositoryMapping.issueWork || !canWorkIssues(command.repositoryMapping)))
          return err('Repository policy no longer authorizes issue work.')
        if (command.taskKind === 'baseline_repair' && !canRepairBaseline(command.repositoryMapping))
          return err('Repository policy no longer authorizes Baseline repair.')
        // A Baseline repair exists to fix the default branch, so it always targets it.
        if (command.taskKind === 'baseline_repair' && command.baseRef !== command.repositoryMapping.defaultBranch)
          return err('A Baseline repair must target the default branch.')
        // The controller replaces its own branch. A branch already under review belongs to its reviewers.
        const reviewed = await options.github.hasOpenPullRequestForBranch(command.repositoryMapping, command.headRef, signal)
        if (reviewed._tag === 'Err')
          return err(reviewed.error.message)
        if (reviewed.value)
          return err('An open pull request already uses this branch.')
      }
      else {
        // Approval and the repository policy decide whether this head is writable.
        if (!canWritePullRequestHead(command.repositoryMapping))
          return err('Repository policy does not authorize writing this pull request head.')
        const headRepository = publicationTargetRepository(command)
        const pullRequest = await options.github.getPullRequest(command.repositoryMapping, command.pullRequestNumber, signal)
        if (pullRequest._tag === 'Err')
          return err(pullRequest.error.message)
        const ownedHead = pullRequest.value.headRepository.toLowerCase() === command.repository.toLowerCase()
        const canWriteHead = ownedHead
          || ((command.taskKind === 'review_fix' || command.taskKind === 'resolve_conflict') && pullRequest.value.maintainerCanModify === true)
        if (
          pullRequest.value.state !== 'open'
          || pullRequest.value.draft
          || pullRequest.value.mergeState !== (command.taskKind === 'resolve_conflict' ? 'conflicting' : 'clean')
          || pullRequest.value.headSha !== command.expectedHeadSha
          || pullRequest.value.headRef !== command.headRef
          || pullRequest.value.headRepository.toLowerCase() !== headRepository.toLowerCase()
          || !canWriteHead
          || (command.taskKind === 'resolve_conflict' && ownedHead && !command.repositoryMapping.writablePullRequestAuthors.some(author => author.toLowerCase() === pullRequest.value.author.toLowerCase()))
        ) {
          return err('The pull request no longer authorizes publication.')
        }
        if (headRepository.toLowerCase() === command.repository.toLowerCase()) {
          const protectedBranch = await options.github.isBranchProtected(command.repositoryMapping, command.headRef, signal)
          if (protectedBranch._tag === 'Err')
            return err(protectedBranch.error.message)
          if (protectedBranch.value)
            return err('The pull request head branch is protected.')
        }
      }
      if (!isSafeGitRef(command.baseRef) || command.baseRef === command.headRef)
        return err('The pull request base branch is unsafe.')
      const credential = await token(command, signal)
      if (credential._tag === 'Err')
        return credential
      // A stacked pull request merges into another pull request's head branch, so
      // the branch this pins is the recorded base, never the default branch.
      const base = await runGit(repositoryGitDirectory(options.root, command.repository), [
        'ls-remote',
        '--heads',
        remoteUrl(command.repository),
        `refs/heads/${command.baseRef}`,
      ], signal, credential.value, options.remoteUrl !== undefined)
      if (base.exitCode !== 0)
        return err(`Could not read the remote base branch: ${base.stderr}`)
      const baseSha = base.stdout.split(/\s+/)[0]
      return baseSha === command.baseSha
        ? ok(undefined)
        : err('The base branch changed before publication.')
    },
    async getHeadSha(command, signal) {
      if (!isSafeGitRef(command.headRef))
        return err('Pull request head ref is unsafe.')
      const credential = await token(command, signal)
      if (credential._tag === 'Err')
        return credential
      const result = await runGit(repositoryGitDirectory(options.root, command.repository), [
        'ls-remote',
        '--heads',
        remoteUrl(publicationTargetRepository(command)),
        `refs/heads/${command.headRef}`,
      ], signal, credential.value, options.remoteUrl !== undefined)
      if (result.exitCode !== 0)
        return err(`Could not read the remote branch: ${result.stderr}`)
      const headSha = result.stdout.split(/\s+/)[0]
      return headSha === undefined || headSha.length === 0 ? ok(null) : ok(headSha)
    },
    async push(command, signal) {
      if (!isSafeGitRef(command.headRef))
        return err('Pull request head ref is unsafe.')
      const repository = repositoryGitDirectory(options.root, command.repository)
      const artifact = await runGit(repository, ['rev-parse', command.artifactRef], signal)
      if (artifact.exitCode !== 0 || artifact.stdout !== command.commitSha)
        return err('The pinned publication artifact does not match the prepared commit.')
      const parents = await runGit(repository, ['show', '--no-patch', '--format=%P', command.commitSha], signal)
      const expectedParents = command.taskKind === 'resolve_conflict'
        ? `${command.expectedHeadSha} ${command.baseSha}`
        : command.expectedHeadSha
      if (parents.exitCode !== 0 || parents.stdout !== expectedParents)
        return err('The publication artifact has unexpected parents.')
      const patch = await runGitDigest(repository, contentDiffArgs(command.expectedHeadSha, command.commitSha), signal)
      if (patch.exitCode !== 0 || patch.digest !== command.patchDigest)
        return err('The publication artifact patch digest does not match.')
      const changed = await runGit(repository, ['diff', '--name-only', command.expectedHeadSha, command.commitSha], signal)
      if (changed.exitCode !== 0 || changed.stdout.split('\n').filter(Boolean).length !== command.changedFiles)
        return err('The publication artifact changed file count does not match.')
      const ancestor = await runGit(repository, [
        'merge-base',
        '--is-ancestor',
        command.expectedHeadSha,
        command.commitSha,
      ], signal)
      if (ancestor.exitCode !== 0)
        return err('The prepared commit is not based on the expected pull request head.')
      const credential = await token(command, signal)
      if (credential._tag === 'Err')
        return credential
      const ref = `refs/heads/${command.headRef}`
      // Replace a leftover branch from an earlier attempt. Never rewrite a contributor's pull request branch.
      const refspec = command._tag === 'OpenPullRequest'
        ? `+${command.artifactRef}:${ref}`
        : `${command.artifactRef}:${ref}`
      const result = await runGit(repository, [
        'push',
        remoteUrl(publicationTargetRepository(command)),
        refspec,
      ], signal, credential.value, options.remoteUrl !== undefined)
      return result.exitCode === 0
        ? ok(undefined)
        : err(`Could not publish the prepared commit: ${result.stderr}`)
    },
    async finalize(command, signal) {
      if (command._tag === 'UpdatePullRequest')
        return ok(`Published ${command.commitSha}.`)
      if (options.pullRequests === undefined)
        return err('Pull request publication is unavailable.')
      const pullRequest = await options.pullRequests.ensurePullRequest({
        repository: command.repositoryMapping,
        baseRef: command.baseRef,
        headRef: command.headRef,
        expectedHeadSha: command.commitSha,
        title: command.pullRequestTitle,
        body: command.pullRequestBody,
      }, signal)
      return pullRequest._tag === 'Err'
        ? err(pullRequest.error.message)
        : ok(`Opened pull request #${pullRequest.value.number}: ${pullRequest.value.url}`)
    },
  }
}
