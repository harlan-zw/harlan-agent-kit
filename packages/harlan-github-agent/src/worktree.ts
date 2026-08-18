import type { GitIdentity } from './git-identity.ts'
import type { GitHubTokenProvider } from './github-auth.ts'
import type { GitHubPullRequestPublisher, GitHubSource } from './github.ts'
import type { PublicationRemote } from './publication-scheduler.ts'
import type { Result } from './result.ts'
import type { ClaimedAdversarialReviewTask, ClaimedBaselineRepairTask, ClaimedConflictResolutionTask, ClaimedIssueTriageTask, ClaimedIssueWorkTask, ClaimedPublicationCommand, ClaimedReviewFixTask } from './types.ts'
import { Buffer } from 'node:buffer'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import process from 'node:process'
import { StringDecoder } from 'node:string_decoder'
import { canPushBranch, canRepairBaseline, canWorkIssues, canWritePullRequestHead } from './repository-policy.ts'
import { err, ok } from './result.ts'

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

export interface AgentWorkspaceManager {
  prepareBaseline: (task: ClaimedBaselineRepairTask, signal: AbortSignal) => Promise<Result<PreparedWorkerWorkspace, string>>
  prepareFix: (task: ClaimedReviewFixTask, signal: AbortSignal) => Promise<Result<PreparedWorkerWorkspace, string>>
  prepareIssue: (task: ClaimedIssueTriageTask | ClaimedIssueWorkTask, signal: AbortSignal) => Promise<Result<PreparedWorkerWorkspace, string>>
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
  prepare: (task: ClaimedIssueWorkTask, signal: AbortSignal) => Promise<Result<PreparedWorkerWorkspace, string>>
  verify: (task: ClaimedIssueWorkTask, worktree: PreparedWorkerWorkspace, signal: AbortSignal) => Promise<Result<VerifiedConflictPatch, string>>
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

function repositoryGitDirectory(root: string, repository: string): string {
  return join(root, 'repositories', `${repository.replace('/', '__')}.git`)
}

function publicationArtifactRef(taskId: string): string {
  return `refs/harlan-github-agent/publications/${taskId}`
}

/**
 * Reads `wt list --format=json` into the branch worktrees the controller can claim.
 *
 * A detached worktree reports a null branch. That is a normal wt state, not
 * malformed data, so it is dropped rather than failing the whole list. One
 * detached worktree used to strand every agent task in the repository.
 */
export function parseWtWorktrees(stdout: string): Result<WtWorktree[], string> {
  try {
    const value: unknown = JSON.parse(stdout)
    if (!Array.isArray(value))
      return err('wt list returned an invalid worktree list.')
    const worktrees: WtWorktree[] = []
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null || !('branch' in entry) || !('path' in entry))
        return err('wt list returned an invalid worktree entry.')
      if (typeof entry.path !== 'string' || !isAbsolute(entry.path))
        return err('wt list returned an invalid worktree entry.')
      if (entry.branch === null)
        continue
      if (typeof entry.branch !== 'string')
        return err('wt list returned an invalid worktree entry.')
      worktrees.push({ branch: entry.branch, path: entry.path })
    }
    return ok(worktrees)
  }
  catch {
    return err('wt list returned invalid JSON.')
  }
}

async function listWtWorktrees(checkout: string, signal: AbortSignal): Promise<Result<WtWorktree[], string>> {
  const listed = await runWt(checkout, ['list', '--format=json'], signal)
  if (listed.exitCode !== 0)
    return err(`Could not list wt worktrees: ${listed.stderr}`)
  return parseWtWorktrees(listed.stdout)
}

function worktreeBranch(namespace: string): string {
  const safeNamespace = namespace.replace(/[^\w.-]+/gu, '-').replace(/^[.-]+|[.-]+$/gu, '')
  return `harlan-agent/${safeNamespace}`
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
    const namespace = `pull-${task.pullRequestNumber}-${task.revisionId.slice(0, 12)}-${task.state.fence}`
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
    const worktree = await prepareWtWorktree(repository, worktreeBranch(namespace), head.stdout, signal)
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
    const unexpectedPath = workerChangedPaths.find(path => !worktree.conflictedFiles.includes(path))
    if (unexpectedPath !== undefined)
      return err(`The worker changed a file that was not conflicted: ${unexpectedPath}.`)
    const untracked = await runGit(worktree.path, ['ls-files', '--others', '--exclude-standard'], signal)
    if (untracked.exitCode !== 0)
      return err(`Could not inspect untracked files: ${untracked.stderr}`)
    if (untracked.stdout.length > 0)
      return err(`The worker created an untracked file: ${untracked.stdout.split('\n')[0]}.`)

    const diffCheck = await runGit(worktree.path, ['diff', '--check'], signal)
    if (diffCheck.exitCode !== 0)
      return err(`Resolved patch failed git diff check: ${diffCheck.stdout || diffCheck.stderr}`)

    const staged = await runGit(worktree.path, ['add', '--', ...worktree.conflictedFiles], signal)
    if (staged.exitCode !== 0)
      return err(`Could not stage the conflict fix: ${staged.stderr}`)
    const unmerged = await runGit(worktree.path, ['diff', '--name-only', '--diff-filter=U'], signal)
    if (unmerged.exitCode !== 0 || unmerged.stdout.length > 0)
      return err(`Merge conflicts remain: ${unmerged.stdout || unmerged.stderr}`)

    const patch = await runGitDigest(worktree.path, ['diff', '--binary', 'HEAD'], signal)
    if (patch.exitCode !== 0)
      return err(`Could not read the conflict resolution patch: ${patch.stderr}`)
    const changed = await runGit(worktree.path, ['diff', '--name-only', 'HEAD'], signal)
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
    namespace: string,
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
    const worktree = await prepareWtWorktree(repository, worktreeBranch(namespace), head.stdout, signal)
    return worktree._tag === 'Err'
      ? worktree
      : ok({ path: worktree.value, baseSha: head.stdout, headSha: head.stdout })
  }

  return {
    async prepareBaseline(task, signal) {
      const baseRef = `refs/harlan-github-agent/baselines/${task.pullRequest.baseSha}`
      const prepared = await prepareRepository(
        task,
        `baseline-${task.pullRequest.baseSha.slice(0, 12)}-${task.state.fence}`,
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
        `fix-${task.pullRequestNumber}-${task.revisionId.slice(0, 12)}-${task.state.fence}`,
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

    async prepareIssue(task, signal) {
      const baseRef = `refs/harlan-github-agent/issues/${task.issueNumber}/base`
      return prepareRepository(
        task,
        `issue-${task.issueNumber}-${task.revisionId.slice(0, 12)}-${task.state.fence}`,
        [`+refs/heads/${task.repositoryMapping.defaultBranch}:${baseRef}`],
        baseRef,
        signal,
      )
    },

    async prepareReview(task, signal) {
      const headRef = `refs/harlan-github-agent/reviews/${task.pullRequestNumber}/head`
      const baseRef = `refs/harlan-github-agent/reviews/${task.pullRequestNumber}/base`
      const prepared = await prepareRepository(
        task,
        `review-${task.pullRequestNumber}-${task.revisionId.slice(0, 12)}-${task.state.fence}`,
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
      const patch = await runGitDigest(worktree.path, ['diff', '--cached', '--binary', 'HEAD'], signal)
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
      const patch = await runGitDigest(worktree.path, ['diff', '--cached', '--binary', 'HEAD'], signal)
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
      const patch = await runGitDigest(worktree.path, ['diff', '--cached', '--binary', 'HEAD'], signal)
      if (patch.exitCode !== 0)
        return err(`Could not read the verified change: ${patch.stderr}`)
      const changed = await runGit(worktree.path, ['diff', '--cached', '--name-only', '-z', 'HEAD'], signal)
      if (changed.exitCode !== 0)
        return err(`Could not inspect changed files: ${changed.stderr}`)
      const changedFiles = changed.stdout.split('\0').filter(Boolean).length
      if (changedFiles === 0)
        return err('The agent completed without changing any files.')
      return ok({ digest: patch.digest, changedFiles })
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
        // The controller replaces its own branch. A branch already under review belongs to its reviewers.
        const reviewed = await options.github.hasOpenPullRequestForBranch(command.repositoryMapping, command.headRef, signal)
        if (reviewed._tag === 'Err')
          return err(reviewed.error.message)
        if (reviewed.value)
          return err('An open pull request already uses this branch.')
      }
      else {
        // Writing to a branch someone else opened needs a repository Harlan owns.
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
      if (!isSafeGitRef(command.repositoryMapping.defaultBranch))
        return err('The pull request base branch is unsafe.')
      const credential = await token(command, signal)
      if (credential._tag === 'Err')
        return credential
      const base = await runGit(repositoryGitDirectory(options.root, command.repository), [
        'ls-remote',
        '--heads',
        remoteUrl(command.repository),
        `refs/heads/${command.repositoryMapping.defaultBranch}`,
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
      const patch = await runGitDigest(repository, ['diff', '--binary', command.expectedHeadSha, command.commitSha], signal)
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
