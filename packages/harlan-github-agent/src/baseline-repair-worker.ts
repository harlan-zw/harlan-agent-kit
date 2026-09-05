import type { AgentActivityLog } from './agent-activity.ts'
import type { RepositoryMemory } from './agent-context.ts'
import type { AgentRuntimeSource } from './agent-profile.ts'
import type { FailedJobContext, GitHubAgentSource, GitHubCheck, PullRequestReviewSnapshot, PullRequestTemplate } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { AgentProgress, ClaimedBaselineRepairTask, MutationWorkerOutcome, RepositoryMapping } from './types.ts'
import type { BaselineRepairWorktreeManager } from './worktree.ts'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets, truncateOutput } from './agent-activity.ts'
import { CHECK_SCOPES, checkBudgetLines, findRepositoryMemory, repositoryMemoryLine, TOOLCHAIN_LINES, UNIT_TEST_LINES } from './agent-context.ts'
import { runAgentTurn } from './agent-turn.ts'
import { withBaselineRepairMarker } from './baseline-repair-state.ts'
import { classifyCheckFailure } from './failure.ts'
import { canRepairBaseline } from './repository-policy.ts'
import { err, ok } from './result.ts'
import { cleanLine } from './text.ts'

interface RepairedResponse {
  outcome: 'repaired'
  summary: string
  checks: string[]
  commitMessage: string
  pullRequestTitle: string
  pullRequestBody: string
}

interface BlockedResponse {
  outcome: 'blocked'
  summary: string
  checks: string[]
}

type AgentResponse = RepairedResponse | BlockedResponse

interface AgentResponsePayload {
  outcome?: 'repaired' | 'blocked'
  summary?: string
  checks?: unknown[]
  commitMessage?: string
  pullRequestTitle?: string
  pullRequestBody?: string
}

/** What the prepared worktree says about how the repository expects to be worked on. */
export interface WorkspaceFacts {
  hasAgentsFile: boolean
  /** The `NODE_OPTIONS` value the first workflow sets, or null when none does. */
  nodeOptions: string | null
}

export interface WorkspaceFile {
  /** Relative to the worktree root, with `/` separators. */
  path: string
  content: string
}

/** GitHub's own app id for Actions. Only its check run id is also a job id. */
const GITHUB_ACTIONS_APP_ID = 15368

export interface BaselineRepairWorkerOptions {
  /**
   * Harlan's Claude Code home, which holds the per-repository memory.
   *
   * Absent means no memory reaches the turn, which is how a test runs.
   */
  claudeHome?: string
  github: Pick<GitHubAgentSource, 'findOpenPullRequestForBranch' | 'getFailedJobContext' | 'getPullRequestReviewSnapshot' | 'getPullRequestTemplate'>
  /** Reads the prepared worktree. `inspectWorkspaceFiles` reads it from disk. */
  inspectWorkspace: (path: string) => Promise<WorkspaceFacts>
  now: () => Date
  runtime: AgentRuntimeSource
  activityLog?: Pick<AgentActivityLog, 'record'>
  store: Pick<JournalStore, 'getWorkerSession' | 'saveWorkerSession' | 'updateAgentProgress'>
  validateMapping: (mapping: RepositoryMapping) => Promise<Result<RepositoryMapping, string>>
  worktrees: BaselineRepairWorktreeManager
}

export interface BaselineRepairWorker {
  run: (task: ClaimedBaselineRepairTask, signal: AbortSignal) => Promise<Result<MutationWorkerOutcome, string>>
}

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'summary', 'checks', 'commitMessage', 'pullRequestTitle', 'pullRequestBody'],
  properties: {
    outcome: { type: 'string', enum: ['repaired', 'blocked'] },
    summary: { type: 'string' },
    checks: { type: 'array', items: { type: 'string' } },
    commitMessage: { type: 'string' },
    pullRequestTitle: { type: 'string' },
    pullRequestBody: { type: 'string' },
  },
}

const disclosure = '> 🤖 AI disclosure: [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) modified this description. [My AI open-source policy](https://harlanzw.com/blog/ai-in-open-source).'
const failedConclusions = new Set(['action_required', 'cancelled', 'error', 'failure', 'stale', 'timed_out'])

function failedChecks(snapshot: PullRequestReviewSnapshot): GitHubCheck[] {
  return snapshot.baseChecks._tag === 'Available'
    ? snapshot.baseChecks.checks.filter(check => failedConclusions.has(check.conclusion ?? ''))
    : []
}

/** The head branch one Baseline repair publishes for one base commit. */
export function baselineRepairHeadRef(prefix: string, baseSha: string): string {
  return `${prefix}baseline-ci-${baseSha.slice(0, 12)}`
}

/** What the controller could read about one failed check before the Agent starts. */
export type FailedCheckContext
  = | { _tag: 'Available', check: GitHubCheck, job: FailedJobContext }
    | { _tag: 'Unavailable', check: GitHubCheck, reason: string }

const nodeOptionsPattern = /^\s*NODE_OPTIONS:\s*(?:"([^"]*)"|'([^']*)'|([^#\n]*))/m

/** Pure. Decides what the prompt may say about the worktree from the files it holds. */
export function workspaceFactsFromFiles(files: WorkspaceFile[]): WorkspaceFacts {
  const nodeOptions = files
    .filter(file => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file.path))
    .map(file => file.content.match(nodeOptionsPattern))
    .map(match => (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim())
    .find(value => value.length > 0)
  return {
    hasAgentsFile: files.some(file => file.path === 'AGENTS.md'),
    nodeOptions: nodeOptions ?? null,
  }
}

/** Reads the files `workspaceFactsFromFiles` decides from. */
export function inspectWorkspaceFiles(path: string): Promise<WorkspaceFacts> {
  const workflows = join(path, '.github', 'workflows')
  const files: WorkspaceFile[] = existsSync(workflows)
    ? readdirSync(workflows)
        .filter(name => /\.ya?ml$/.test(name))
        .map(name => ({ path: `.github/workflows/${name}`, content: readFileSync(join(workflows, name), 'utf8') }))
    : []
  if (existsSync(join(path, 'AGENTS.md')))
    files.push({ path: 'AGENTS.md', content: '' })
  return Promise.resolve(workspaceFactsFromFiles(files))
}

/** The controller owns the pull request body. The Agent supplies only the why. */
function pullRequestBody(template: PullRequestTemplate, why: string): string {
  return template._tag === 'Found'
    ? `${template.body.trimEnd()}\n\n${why}`
    : why
}

function withDisclosure(body: string): string {
  const description = body
    .split(/\r?\n/)
    .filter(line => !/^>\s*🤖 AI disclosure:/.test(line))
    .join('\n')
    .trimEnd()
  return `${description}\n\n${disclosure}`
}

function controllerBaselineMetadata(): RepairedResponse {
  const title = 'fix: repair default branch CI'
  return {
    outcome: 'repaired',
    summary: 'The controller published the verified Baseline repair patch.',
    checks: [],
    commitMessage: title,
    pullRequestTitle: title,
    pullRequestBody: 'Repairs failing default branch CI.',
  }
}

function isMissingTemplatePlaceholder(value: string): boolean {
  return value.trim() === JSON.stringify({ _tag: 'Missing' })
}

function parseResponse(text: string): Promise<Result<AgentResponse, string>> {
  return Promise.resolve(text)
    .then(value => JSON.parse(value) as AgentResponsePayload)
    .then((value): Result<AgentResponse, string> => {
      // A blocked intent is a completed turn, even when its metadata fields are
      // malformed. Surface it so the caller returns ActionRequired instead of
      // substituting metadata and publishing a patch.
      if (value.outcome === 'blocked') {
        return ok({
          outcome: 'blocked',
          summary: typeof value.summary === 'string' && cleanLine(value.summary).length > 0
            ? value.summary
            : 'The Agent reported that it could not safely repair Baseline CI.',
          checks: Array.isArray(value.checks) ? value.checks.filter((check): check is string => typeof check === 'string') : [],
        })
      }
      if (typeof value.summary !== 'string' || !Array.isArray(value.checks) || !value.checks.every(check => typeof check === 'string'))
        return err('The agent returned an invalid Baseline repair result.')
      if (
        value.outcome !== 'repaired'
        || typeof value.commitMessage !== 'string'
        || typeof value.pullRequestTitle !== 'string'
        || typeof value.pullRequestBody !== 'string'
        || cleanLine(value.commitMessage).length === 0
        || cleanLine(value.pullRequestTitle).length === 0
        || value.pullRequestBody.trim().length === 0
        || isMissingTemplatePlaceholder(value.pullRequestBody)
      ) {
        return err('The agent returned an invalid Baseline repair result.')
      }
      return ok({
        outcome: 'repaired',
        summary: value.summary,
        checks: value.checks as string[],
        commitMessage: cleanLine(value.commitMessage),
        pullRequestTitle: cleanLine(value.pullRequestTitle),
        pullRequestBody: value.pullRequestBody.trim(),
      })
    })
    .catch(() => err('The agent returned malformed Baseline repair JSON.'))
}

function checkBlock(context: FailedCheckContext): string {
  const head = `- Check "${context.check.name}", conclusion ${context.check.conclusion ?? 'unknown'}.`
  if (context._tag === 'Unavailable')
    return `${head}\n  Run id, job, step, and log: unavailable (${context.reason}).`
  const step = context.job.failedStep === null ? 'no step reports failure' : `failed step "${context.job.failedStep}"`
  const log = context.job.logTail.length === 0
    ? '  Log: unavailable (the job log is empty).'
    : `  Last ${context.job.logTail.length} log lines:\n  \`\`\`\n${context.job.logTail.map(line => `  ${line}`).join('\n')}\n  \`\`\``
  return `${head}\n  Run id ${context.job.runId}, job "${context.job.jobName}", ${step}.\n${log}`
}

export interface BaselineRepairPromptInput {
  repository: string
  baseSha: string
  repairable: FailedCheckContext[]
  infrastructure: Array<{ check: GitHubCheck, reason: string }>
  workspace: WorkspaceFacts
  /** The memory index this repository has, or null when it has none. */
  memory?: RepositoryMemory | null
}

/** Pure. Everything the Agent needs, in the order it needs it. */
export function baselineRepairPrompt(input: BaselineRepairPromptInput): string {
  const agents = input.workspace.hasAgentsFile
    ? 'Read AGENTS.md in this worktree before you change code.\n'
    : ''
  const nodeOptions = input.workspace.nodeOptions === null
    ? ''
    : `The workflow sets NODE_OPTIONS=${input.workspace.nodeOptions}. Use the same value for every local command.\n`
  const outOfScope = input.infrastructure.length === 0
    ? ''
    : `\nThese checks failed for an infrastructure reason. Do not change the repository for them:\n${input.infrastructure.map(entry => `- Check "${entry.check.name}": ${entry.reason}`).join('\n')}\n`
  return `Repair the failing default branch CI for ${input.repository} at commit ${input.baseSha}.

Own the work end to end. Find the root cause, implement the complete fix, and verify it.
Work as a normal local agent session. Use the user's global agent context and installed skills.
This worktree was prepared fresh for this turn. No work from an earlier turn of this session is present in it. Redo the whole change here before you return a result.
${agents}${repositoryMemoryLine(input.memory ?? null)}
${UNIT_TEST_LINES}

Failing checks:
${input.repairable.map(checkBlock).join('\n')}
${outOfScope}
${checkBudgetLines(CHECK_SCOPES.failingCheck)}
${TOOLCHAIN_LINES}
${nodeOptions}Never run sudo or systemctl. Never start, stop, or change a host service, a runner, or a container. If the fix needs a host change, return blocked and say why.
Do not hide a failure with a retry wrapper, a concurrency limit, or a longer timeout. Fix the cause.
Do not stage, commit, push, or publish. The controller owns those steps.
Do not write a pull request body. The controller writes it.
Return only the required JSON:
- commitMessage: one line, Conventional Commit format, names the actual fix.
- pullRequestTitle: the same line as commitMessage.
- pullRequestBody: two sentences that say why this change is needed.
- checks: the exact commands you ran to verify the fix.
Return blocked only when you cannot safely complete the fix.`
}

export function createBaselineRepairWorker(options: BaselineRepairWorkerOptions): BaselineRepairWorker {
  return {
    async run(task, signal) {
      const progress = (value: AgentProgress): Result<void, string> => options.store.updateAgentProgress({
        taskId: task.id,
        taskKind: task.kind,
        workerId: task.state.workerId,
        fence: task.state.fence,
        progress: value,
        at: options.now().toISOString(),
      })
        ? ok(undefined)
        : err('This agent is no longer assigned to the Baseline repair.')
      const validated = await options.validateMapping(task.repositoryMapping)
      if (validated._tag === 'Err')
        return validated
      const prefix = validated.value.writablePullRequestHeadPrefixes[0]
      if (!canRepairBaseline(validated.value) || prefix === undefined)
        return err('Repository policy no longer authorizes Baseline repair.')
      const [snapshot, template] = await Promise.all([
        options.github.getPullRequestReviewSnapshot(validated.value, task.pullRequestNumber, signal),
        options.github.getPullRequestTemplate(validated.value, signal),
      ])
      if (snapshot._tag === 'Err')
        return snapshot
      if (template._tag === 'Err')
        return template
      const checks = failedChecks(snapshot.value)
      // A Baseline repair exists for one red base commit. If that commit moved on,
      // or its CI went green, there is nothing left to repair.
      if (snapshot.value.pullRequest.baseSha !== task.pullRequest.baseSha)
        return ok({ _tag: 'Superseded', reason: `The pull request now builds on ${snapshot.value.pullRequest.baseSha}, not the failing ${task.pullRequest.baseSha}.` })
      if (checks.length === 0)
        return ok({ _tag: 'Superseded', reason: `Default branch CI no longer fails at ${task.pullRequest.baseSha}.` })
      // One Baseline repair per base commit. The Journal learns about a
      // published repair only when it next observes the pull request, so a
      // second Task for the same commit asks GitHub before it spends a turn.
      const headRef = baselineRepairHeadRef(prefix, task.pullRequest.baseSha)
      const published = await options.github.findOpenPullRequestForBranch(validated.value, headRef, signal)
      if (published._tag === 'Err')
        return published
      if (published.value !== null)
        return ok({ _tag: 'Completed', evidence: `GitHub reports Baseline repair pull request #${published.value.number}: ${published.value.url}` })
      const contexts = await Promise.all(checks.map(async (check): Promise<FailedCheckContext> => {
        if (check.source._tag !== 'CheckRun' || check.source.appId !== GITHUB_ACTIONS_APP_ID)
          return { _tag: 'Unavailable', check, reason: 'the check is not a GitHub Actions job' }
        const job = await options.github.getFailedJobContext(validated.value, check.id, signal)
        return job._tag === 'Ok'
          ? { _tag: 'Available', check, job: job.value }
          : { _tag: 'Unavailable', check, reason: job.error }
      }))
      const classified = contexts.map(context => ({
        context,
        failure: classifyCheckFailure({
          name: context.check.name,
          conclusion: context.check.conclusion,
          runnerLost: context.check.failure._tag === 'RunnerLost',
          logTail: context._tag === 'Available' ? context.job.logTail : [],
        }),
      }))
      const infrastructure = classified.flatMap(entry => entry.failure._tag === 'Infrastructure' ? [{ check: entry.context.check, reason: entry.failure.reason }] : [])
      const repairable = classified.flatMap(entry => entry.failure._tag === 'Repairable' ? [entry.context] : [])
      // No change to the repository fixes a dead runner or a remote outage.
      // Every Agent turn spent on one produced a mask, so none starts.
      if (repairable.length === 0) {
        return ok({
          _tag: 'ActionRequired',
          reason: cleanLine(`Infrastructure failure. ${infrastructure.map(entry => entry.reason).join(' ')} Repair the host, then re-run the check.`),
          evidence: JSON.stringify(infrastructure.map(entry => ({ check: entry.check.name, reason: entry.reason }))),
        })
      }
      const prepared = await options.worktrees.prepare({ ...task, repositoryMapping: validated.value }, signal)
      if (prepared._tag === 'Err')
        return prepared
      if (prepared.value.headSha !== task.pullRequest.baseSha)
        return ok({ _tag: 'Superseded', reason: `The default branch moved to ${prepared.value.headSha}. This repair targeted ${task.pullRequest.baseSha}.` })
      const ready = progress({ percent: 35, label: 'Git worktree ready' })
      if (ready._tag === 'Err')
        return ready
      const workspace = await options.inspectWorkspace(prepared.value.path)
      // The slug comes from the primary checkout, never from this worktree.
      const memory = options.claudeHome === undefined
        ? null
        : await findRepositoryMemory({ claudeHome: options.claudeHome, checkoutPath: validated.value.checkout })
      const turn = await runAgentTurn(options, {
        freshSession: task.state.fence > 1,
        ...(memory === null ? {} : { instructionPaths: [memory.indexPath] }),
        number: task.pullRequestNumber,
        progress: { current: { percent: 35, label: 'Git worktree ready' }, report: progress, work: 'baseline' },
        prompt: baselineRepairPrompt({
          repository: task.repository,
          baseSha: task.pullRequest.baseSha,
          repairable,
          infrastructure,
          workspace,
          memory,
        }),
        repository: task.repository,
        role: 'baseline_repair',
        schema: outputSchema,
        taskId: task.id,
        workspace: prepared.value.path,
      }, signal)
      if (turn._tag === 'Err')
        return turn
      const parsed = await parseResponse(turn.value.response)
      // A bad metadata envelope must not discard a finished patch. Review and
      // Repair own code quality after publication, so the controller supplies
      // safe PR metadata and keeps the Agent's work moving.
      let response: RepairedResponse
      if (parsed._tag === 'Err') {
        options.activityLog?.record(task.id, {
          _tag: 'Reasoning',
          at: options.now().toISOString(),
          text: `The agent response could not be parsed (${parsed.error}) and the controller substituted the pull request metadata. Raw response: ${truncateOutput(redactSecrets(turn.value.response))}`,
        })
        response = controllerBaselineMetadata()
      }
      else {
        if (parsed.value.outcome === 'blocked') {
          return ok({
            _tag: 'ActionRequired',
            reason: cleanLine(parsed.value.summary),
            evidence: JSON.stringify(parsed.value),
            usage: turn.value.usage,
          })
        }
        response = parsed.value
      }
      const verified = await options.worktrees.verify(task, prepared.value, signal)
      if (verified._tag === 'Err')
        return verified
      const frozen = await options.github.getPullRequestReviewSnapshot(validated.value, task.pullRequestNumber, signal)
      if (frozen._tag === 'Err')
        return frozen
      if (frozen.value.pullRequest.baseSha !== prepared.value.baseSha)
        return err('Default branch changed before the controller committed the Baseline repair.')
      const committed = await options.worktrees.commit(task, prepared.value, verified.value, response.commitMessage, signal)
      if (committed._tag === 'Err')
        return committed
      return ok({
        _tag: 'Publish',
        usage: turn.value.usage,
        publication: {
          _tag: 'OpenPullRequest',
          taskKind: 'baseline_repair',
          pullRequestNumber: task.pullRequestNumber,
          pullRequestTitle: response.pullRequestTitle,
          pullRequestBody: withBaselineRepairMarker(withDisclosure(pullRequestBody(template.value, response.pullRequestBody))),
          commitSha: committed.value.commitSha,
          baseSha: committed.value.baseSha,
          // A Baseline repair fixes the default branch, so it never stacks.
          baseRef: validated.value.defaultBranch,
          expectedHeadSha: committed.value.baseSha,
          headRef,
          artifactRef: committed.value.artifactRef,
          patchDigest: committed.value.digest,
          changedFiles: committed.value.changedFiles,
        },
      })
    },
  }
}
