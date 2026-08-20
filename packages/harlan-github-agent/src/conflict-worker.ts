import type { AgentActivityLog } from './agent-activity.ts'
import type { AgentRuntimeSource } from './agent-profile.ts'
import type { GitHubSource } from './github.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { AgentProgress, ClaimedConflictResolutionTask, MutationWorkerOutcome, RepositoryMapping } from './types.ts'
import type { ConflictWorktreeManager } from './worktree.ts'
import { runAgentTurn } from './agent-turn.ts'
import { isAutomatedGitHubActor } from './github.ts'
import { err, ok } from './result.ts'
import { cleanLine } from './text.ts'

export interface ConflictWorker {
  run: (task: ClaimedConflictResolutionTask, signal: AbortSignal) => Promise<Result<MutationWorkerOutcome, string>>
}

export interface ConflictWorkerOptions {
  github: Pick<GitHubSource, 'getPullRequest'>
  now: () => Date
  runtime: AgentRuntimeSource
  activityLog?: Pick<AgentActivityLog, 'record'>
  store: Pick<JournalStore, 'getWorkerSession' | 'saveWorkerSession' | 'updateAgentProgress'>
  validateMapping: (mapping: RepositoryMapping) => Promise<Result<RepositoryMapping, string>>
  worktrees: ConflictWorktreeManager
}

interface AgentResponse {
  outcome: 'resolved' | 'blocked'
  summary: string
  checks: string[]
  commitMessage: string
}

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'summary', 'checks', 'commitMessage'],
  properties: {
    outcome: { type: 'string', enum: ['resolved', 'blocked'] },
    summary: { type: 'string' },
    checks: { type: 'array', items: { type: 'string' } },
    commitMessage: { type: 'string' },
  },
}

function workerPrompt(task: ClaimedConflictResolutionTask): string {
  return `Resolve the existing merge conflicts for ${task.repository}#${task.pullRequestNumber}.

Work as a normal local agent session inside this Git worktree. Use the user's global agent context, installed skills, environment, and authenticated GitHub CLI.
This worktree was prepared fresh for this turn. No work from an earlier turn of this session is present in it. Redo the whole change here before returning a result.
Select every installed skill whose trigger matches the work. Apply the unit-tests skill before regression repair.
The controller already merged the current base into this worktree. Only resolve the conflicted files.
Follow repository AGENTS.md and contributor instructions. Preserve the pull request intent.
Use live search when useful. Run focused checks and repository-required checks.
Edit the conflicted files only. Do not stage files. The controller stages verified conflict files.
Do not commit, push, amend, rebase, abort the merge, or edit Git configuration.
Choose a commit message that describes the resolved conflict.
Use GitHub read commands when issue or pull request history clarifies intent. Do not post comments.
Return the required JSON result. Use outcome blocked when intent is ambiguous or safe verification cannot finish.
The controller rejects a resolved outcome without a commit message. Return an empty commit message only with outcome blocked.`
}

function parseAgentResponse(text: string): Result<AgentResponse, string> {
  try {
    const value = JSON.parse(text) as Partial<AgentResponse>
    if (
      (value.outcome !== 'resolved' && value.outcome !== 'blocked')
      || typeof value.summary !== 'string'
      || !Array.isArray(value.checks)
      || !value.checks.every(check => typeof check === 'string')
      || typeof value.commitMessage !== 'string'
      || (value.outcome === 'resolved' && value.commitMessage.trim().length === 0)
    ) {
      return err('The agent returned an invalid conflict resolution result.')
    }
    return ok(value as AgentResponse)
  }
  catch {
    return err('The agent returned malformed conflict resolution JSON.')
  }
}

export function createConflictWorker(options: ConflictWorkerOptions): ConflictWorker {
  return {
    async run(task, signal) {
      const reportProgress = (progress: AgentProgress): Result<void, string> => options.store.updateAgentProgress({
        taskId: task.id,
        taskKind: task.kind,
        workerId: task.state.workerId,
        fence: task.state.fence,
        progress,
        at: options.now().toISOString(),
      })
        ? ok(undefined)
        : err('This agent is no longer assigned to the current pull request.')

      const validated = await options.validateMapping(task.repositoryMapping)
      if (validated._tag === 'Err')
        return validated

      const current = await options.github.getPullRequest(validated.value, task.pullRequestNumber, signal)
      if (current._tag === 'Err')
        return err(current.error.message)
      const forkHead = current.value.headRepository.toLowerCase() !== validated.value.github.toLowerCase()
      if (
        current.value.state !== 'open'
        || current.value.draft
        || current.value.mergeState !== 'conflicting'
        || current.value.headSha !== task.pullRequest.headSha
        || (forkHead && current.value.maintainerCanModify !== true)
        || isAutomatedGitHubActor({ login: current.value.author }, validated.value.writablePullRequestAuthors)
      ) {
        return err('The pull request no longer matches the claimed head and base commit SHAs.')
      }
      const loaded = reportProgress({ percent: 10, label: 'Pull request loaded' })
      if (loaded._tag === 'Err')
        return loaded

      const currentTask = { ...task, pullRequest: current.value }
      const prepared = await options.worktrees.prepare(currentTask, signal)
      if (prepared._tag === 'Err')
        return prepared
      const worktreeReady = reportProgress({ percent: 35, label: 'Git worktree ready' })
      if (worktreeReady._tag === 'Err')
        return worktreeReady

      const turn = await runAgentTurn(options, {
        number: task.pullRequestNumber,
        progress: { currentPercent: 35, report: reportProgress, work: 'conflict' },
        prompt: workerPrompt(currentTask),
        repository: task.repository,
        role: 'conflict_resolution',
        schema: outputSchema,
        taskId: task.id,
        workspace: prepared.value.path,
      }, signal)
      if (turn._tag === 'Err')
        return turn

      const parsed = parseAgentResponse(turn.value.response)
      if (parsed._tag === 'Err')
        return parsed
      if (parsed.value.outcome === 'blocked')
        return err(cleanLine(parsed.value.summary))

      const verified = await options.worktrees.verify(currentTask, prepared.value, signal)
      if (verified._tag === 'Err')
        return verified
      const checksPassed = reportProgress({ percent: 90, label: 'Conflict fix checked' })
      if (checksPassed._tag === 'Err')
        return checksPassed

      const publishSnapshot = await options.github.getPullRequest(validated.value, task.pullRequestNumber, signal)
      if (publishSnapshot._tag === 'Err')
        return err(publishSnapshot.error.message)
      const publishForkHead = publishSnapshot.value.headRepository.toLowerCase() !== validated.value.github.toLowerCase()
      if (
        publishSnapshot.value.state !== 'open'
        || publishSnapshot.value.draft
        || publishSnapshot.value.mergeState !== 'conflicting'
        || publishSnapshot.value.headSha !== prepared.value.headSha
        || (publishForkHead && publishSnapshot.value.maintainerCanModify !== true)
      ) {
        return err('The pull request changed before the fix was committed.')
      }

      const committed = await options.worktrees.commit(
        currentTask,
        prepared.value,
        verified.value,
        cleanLine(parsed.value.commitMessage),
        signal,
      )
      if (committed._tag === 'Err')
        return committed
      const commitReady = reportProgress({ percent: 95, label: 'Fix committed' })
      if (commitReady._tag === 'Err')
        return commitReady
      return ok({
        _tag: 'Publish',
        publication: {
          _tag: 'UpdatePullRequest',
          taskKind: 'resolve_conflict',
          pullRequestNumber: task.pullRequestNumber,
          commitSha: committed.value.commitSha,
          baseSha: committed.value.baseSha,
          baseRef: currentTask.pullRequest.baseRef ?? task.repositoryMapping.defaultBranch,
          expectedHeadSha: currentTask.pullRequest.headSha,
          headRef: currentTask.pullRequest.headRef,
          headRepository: currentTask.pullRequest.headRepository,
          artifactRef: committed.value.artifactRef,
          patchDigest: committed.value.digest,
          changedFiles: committed.value.changedFiles,
        },
      })
    },
  }
}
