import type { AgentActivityLog } from './agent-activity.ts'
import type { AgentProvider } from './agent-provider.ts'
import type { GitHubAgentSource, PullRequestReviewSnapshot, PullRequestTemplate } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { AgentProfile, AgentProgress, ClaimedBaselineRepairTask, MutationWorkerOutcome, RepositoryMapping } from './types.ts'
import type { BaselineRepairWorktreeManager } from './worktree.ts'
import { runAgentTurn } from './agent-turn.ts'
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
  profile: AgentProfile
  provider: AgentProvider
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

function parseResponse(text: string): Promise<Result<AgentResponse, string>> {
  return Promise.resolve(text)
    .then(value => JSON.parse(value) as AgentResponsePayload)
    .then((value): Result<AgentResponse, string> => {
      if (typeof value.summary !== 'string' || !Array.isArray(value.checks) || !value.checks.every(check => typeof check === 'string'))
        return err('The agent returned an invalid Baseline repair result.')
      if (value.outcome === 'blocked')
        return ok({ outcome: 'blocked', summary: value.summary, checks: value.checks as string[] })
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
      if (!validated.value.enabled || validated.value.ownership !== 'owned' || !validated.value.pullRequestReview || prefix === undefined)
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
      if (snapshot.value.pullRequest.baseSha !== task.pullRequest.baseSha || checks.length === 0)
        return err('Default branch CI no longer fails at the queued base commit.')
      const prepared = await options.worktrees.prepare({ ...task, repositoryMapping: validated.value }, signal)
      if (prepared._tag === 'Err')
        return prepared
      const ready = progress({ percent: 35, label: 'Git worktree ready' })
      if (ready._tag === 'Err')
        return ready
      const turn = await runAgentTurn(options, {
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
      if (parsed._tag === 'Err')
        return parsed
      if (parsed.value.outcome === 'blocked')
        return ok({ _tag: 'ActionRequired', reason: cleanLine(parsed.value.summary), evidence: JSON.stringify(parsed.value) })
      const verified = await options.worktrees.verify(task, prepared.value, signal)
      if (verified._tag === 'Err')
        return verified
      const frozen = await options.github.getPullRequestReviewSnapshot(validated.value, task.pullRequestNumber, signal)
      if (frozen._tag === 'Err')
        return frozen
      if (frozen.value.pullRequest.baseSha !== prepared.value.baseSha)
        return err('Default branch changed before the controller committed the Baseline repair.')
      const committed = await options.worktrees.commit(task, prepared.value, verified.value, parsed.value.commitMessage, signal)
      if (committed._tag === 'Err')
        return committed
      return ok({
        _tag: 'Publish',
        publication: {
          _tag: 'OpenPullRequest',
          taskKind: 'baseline_repair',
          pullRequestNumber: task.pullRequestNumber,
          pullRequestTitle: parsed.value.pullRequestTitle,
          pullRequestBody: withDisclosure(parsed.value.pullRequestBody),
          commitSha: committed.value.commitSha,
          baseSha: committed.value.baseSha,
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
