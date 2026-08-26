import type { AgentActivityLog } from './agent-activity.ts'
import type { AgentRuntimeSource } from './agent-profile.ts'
import type { GitHubAgentSource, PullRequestReviewSnapshot, PullRequestTemplate } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { AgentProgress, ClaimedBaselineRepairTask, MutationWorkerOutcome, RepositoryMapping } from './types.ts'
import type { BaselineRepairWorktreeManager } from './worktree.ts'
import { redactSecrets, truncateOutput } from './agent-activity.ts'
import { runAgentTurn } from './agent-turn.ts'
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

export interface BaselineRepairWorkerOptions {
  github: Pick<GitHubAgentSource, 'getPullRequestReviewSnapshot' | 'getPullRequestTemplate'>
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

function failedChecks(snapshot: PullRequestReviewSnapshot): string[] {
  return snapshot.baseChecks._tag === 'Available'
    ? snapshot.baseChecks.checks.filter(check => failedConclusions.has(check.conclusion ?? '')).map(check => check.name)
    : []
}

function withDisclosure(body: string): string {
  const description = body
    .split(/\r?\n/)
    .filter(line => !/^>\s*🤖 AI disclosure:/.test(line))
    .join('\n')
    .trimEnd()
  return `${description}\n\n${disclosure}`
}

function controllerBaselineMetadata(template: PullRequestTemplate): RepairedResponse {
  const title = 'fix: repair default branch CI'
  return {
    outcome: 'repaired',
    summary: 'The controller published the verified Baseline repair patch.',
    checks: [],
    commitMessage: title,
    pullRequestTitle: title,
    pullRequestBody: template._tag === 'Found'
      ? `${template.body.trimEnd()}\n\nRepairs failing default branch CI.`
      : 'Repairs failing default branch CI.',
  }
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

function prompt(task: ClaimedBaselineRepairTask, checks: string[], template: PullRequestTemplate): string {
  return `Repair the failing default branch CI for ${task.repository} at commit ${task.pullRequest.baseSha}.

Own the work end to end. Diagnose the actual failure, implement the complete fix, and verify it.
Work as a normal local agent session. Use the user's global agent context and installed skills.
This worktree was prepared fresh for this turn. No work from an earlier turn of this session is present in it. Redo the whole change here before returning a result.
Read repository AGENTS.md and contributor instructions. Apply the unit-tests skill for bug fixes.
Use GitHub read commands to inspect the failed runs and logs. The failing checks are ${JSON.stringify(checks)}.
Apply the PR skill to draft the pull request title and body. Use this template when useful: ${JSON.stringify(template)}.
Choose a commit message that describes your actual fix. Avoid generic automated-review wording.
Do not stage, commit, push, or publish. The controller handles those safety boundaries.
Return blocked only when you cannot safely complete the fix. Return only the required JSON.`
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
        return ok({ _tag: 'Obsolete', evidence: `The pull request now builds on ${snapshot.value.pullRequest.baseSha}, not the failing ${task.pullRequest.baseSha}.` })
      if (checks.length === 0)
        return ok({ _tag: 'Obsolete', evidence: `Default branch CI no longer fails at ${task.pullRequest.baseSha}.` })
      const prepared = await options.worktrees.prepare({ ...task, repositoryMapping: validated.value }, signal)
      if (prepared._tag === 'Err')
        return prepared
      if (prepared.value.headSha !== task.pullRequest.baseSha)
        return ok({ _tag: 'Obsolete', evidence: `The default branch moved to ${prepared.value.headSha}. This repair targeted ${task.pullRequest.baseSha}.` })
      const ready = progress({ percent: 35, label: 'Git worktree ready' })
      if (ready._tag === 'Err')
        return ready
      const turn = await runAgentTurn(options, {
        freshSession: task.state.fence > 1,
        number: task.pullRequestNumber,
        progress: { currentPercent: 35, report: progress, work: 'baseline' },
        prompt: prompt(task, checks, template.value),
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
        response = controllerBaselineMetadata(template.value)
      }
      else {
        if (parsed.value.outcome === 'blocked')
          return ok({ _tag: 'ActionRequired', reason: cleanLine(parsed.value.summary), evidence: JSON.stringify(parsed.value) })
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
        publication: {
          _tag: 'OpenPullRequest',
          taskKind: 'baseline_repair',
          pullRequestNumber: task.pullRequestNumber,
          pullRequestTitle: response.pullRequestTitle,
          pullRequestBody: withDisclosure(response.pullRequestBody),
          commitSha: committed.value.commitSha,
          baseSha: committed.value.baseSha,
          // A Baseline repair fixes the default branch, so it never stacks.
          baseRef: validated.value.defaultBranch,
          expectedHeadSha: committed.value.baseSha,
          headRef: `${prefix}baseline-ci-${task.pullRequest.baseSha.slice(0, 12)}`,
          artifactRef: committed.value.artifactRef,
          patchDigest: committed.value.digest,
          changedFiles: committed.value.changedFiles,
        },
      })
    },
  }
}
