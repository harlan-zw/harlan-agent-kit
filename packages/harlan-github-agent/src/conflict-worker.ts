import type { CodexOptions, ThreadEvent, ThreadOptions } from '@openai/codex-sdk'
import type { AgentActivityLog } from './agent-activity.ts'
import type { GitHubSource } from './github.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { AgentProgress, ClaimedConflictResolutionTask, MutationWorkerOutcome, RepositoryMapping } from './types.ts'
import type { ConflictWorktreeManager } from './worktree.ts'
import { Codex } from '@openai/codex-sdk'
import { agentActivityFromEvent } from './agent-activity.ts'
import { codexEventProgress } from './agent-progress.ts'
import { runCodexTurn } from './codex-session.ts'
import { CODEX_WORKER_PROFILE } from './codex-worker-profile.ts'
import { isAutomatedGitHubActor } from './github.ts'
import { err, ok } from './result.ts'

export interface ConflictWorker {
  run: (task: ClaimedConflictResolutionTask, signal: AbortSignal) => Promise<Result<MutationWorkerOutcome, string>>
}

export interface ConflictWorkerOptions {
  createCodex?: (options: CodexOptions) => {
    startThread: (options: ThreadOptions) => { runStreamed: (prompt: string, options: { outputSchema: unknown, signal: AbortSignal }) => Promise<{ events: AsyncIterable<ThreadEvent> }> }
    resumeThread: (sessionId: string, options: ThreadOptions) => { runStreamed: (prompt: string, options: { outputSchema: unknown, signal: AbortSignal }) => Promise<{ events: AsyncIterable<ThreadEvent> }> }
  }
  github: Pick<GitHubSource, 'getPullRequest'>
  now: () => Date
  activityLog?: Pick<AgentActivityLog, 'record'>
  store: Pick<JournalStore, 'getWorkerSession' | 'saveWorkerSession' | 'updateAgentProgress'>
  validateMapping: (mapping: RepositoryMapping) => Promise<Result<RepositoryMapping, string>>
  worktrees: ConflictWorktreeManager
}

interface WorkerResponse {
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

Work as a normal local Codex session inside this Git worktree. Use the user's global Codex context, installed skills, environment, and authenticated GitHub CLI.
Select every installed skill whose trigger matches the work. Apply the unit-tests skill before regression repair.
The controller already merged the current base into this worktree. Only resolve the conflicted files.
Follow repository AGENTS.md and contributor instructions. Preserve the pull request intent.
Use live search when useful. Run focused checks and repository-required checks.
Edit the conflicted files only. Do not stage files. The controller stages verified conflict files.
Do not commit, push, amend, rebase, abort the merge, or edit Git configuration.
Choose a commit message that describes the resolved conflict.
Use GitHub read commands when issue or pull request history clarifies intent. Do not post comments.
Return the required JSON result. Use outcome blocked when intent is ambiguous or safe verification cannot finish.`
}

function parseWorkerResponse(text: string): Result<WorkerResponse, string> {
  try {
    const value = JSON.parse(text) as Partial<WorkerResponse>
    if (
      (value.outcome !== 'resolved' && value.outcome !== 'blocked')
      || typeof value.summary !== 'string'
      || !Array.isArray(value.checks)
      || !value.checks.every(check => typeof check === 'string')
      || typeof value.commitMessage !== 'string'
      || (value.outcome === 'resolved' && value.commitMessage.trim().length === 0)
    ) {
      return err('Codex returned an invalid conflict resolution result.')
    }
    return ok(value as WorkerResponse)
  }
  catch {
    return err('Codex returned malformed conflict resolution JSON.')
  }
}

export function createCodexConflictWorker(options: ConflictWorkerOptions): ConflictWorker {
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
      if (
        current.value.state !== 'open'
        || current.value.draft
        || current.value.mergeState !== 'conflicting'
        || current.value.headSha !== task.pullRequest.headSha
        || current.value.headRepository.toLowerCase() !== validated.value.github.toLowerCase()
        || isAutomatedGitHubActor({ login: current.value.author })
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

      const sessionId = options.store.getWorkerSession(task.repository, task.pullRequestNumber, 'conflict_resolution')
      const codex = (options.createCodex ?? (codexOptions => new Codex(codexOptions)))({})
      const threadOptions = {
        model: CODEX_WORKER_PROFILE.roles.conflict_resolution.model,
        modelReasoningEffort: CODEX_WORKER_PROFILE.roles.conflict_resolution.reasoningEffort,
        workingDirectory: prepared.value.path,
        webSearchMode: 'live' as const,
        approvalPolicy: 'never' as const,
      }
      const streamed = await runCodexTurn({
        client: codex,
        outputSchema,
        prompt: workerPrompt(currentTask),
        sessionId,
        signal,
        threadOptions,
      })
      let response: string | undefined
      let failure: string | undefined
      let currentPercent = 35
      for await (const event of streamed.events) {
        if (event.type === 'thread.started')
          options.store.saveWorkerSession(task.repository, task.pullRequestNumber, 'conflict_resolution', event.thread_id, options.now().toISOString())
        if (event.type === 'item.completed' && event.item.type === 'agent_message')
          response = event.item.text
        if (event.type === 'turn.failed')
          failure = event.error.message
        if (event.type === 'error')
          failure = event.message
        const activity = agentActivityFromEvent(event, options.now().toISOString())
        if (activity !== undefined)
          options.activityLog?.record(task.id, activity)
        const progress = codexEventProgress(event, 'conflict')
        if (progress !== undefined && progress.percent > currentPercent) {
          const reported = reportProgress(progress)
          if (reported._tag === 'Err')
            failure ??= reported.error
          else
            currentPercent = progress.percent
        }
      }
      if (failure !== undefined)
        return err(failure)
      if (response === undefined)
        return err('Codex completed without a conflict resolution result.')

      const parsed = parseWorkerResponse(response)
      if (parsed._tag === 'Err')
        return parsed
      if (parsed.value.outcome === 'blocked')
        return err(parsed.value.summary)

      const verified = await options.worktrees.verify(currentTask, prepared.value, signal)
      if (verified._tag === 'Err')
        return verified
      const checksPassed = reportProgress({ percent: 90, label: 'Conflict fix checked' })
      if (checksPassed._tag === 'Err')
        return checksPassed

      const publishSnapshot = await options.github.getPullRequest(validated.value, task.pullRequestNumber, signal)
      if (publishSnapshot._tag === 'Err')
        return err(publishSnapshot.error.message)
      if (
        publishSnapshot.value.state !== 'open'
        || publishSnapshot.value.draft
        || publishSnapshot.value.mergeState !== 'conflicting'
        || publishSnapshot.value.headSha !== prepared.value.headSha
        || publishSnapshot.value.headRepository.toLowerCase() !== validated.value.github.toLowerCase()
      ) {
        return err('The pull request changed before the fix was committed.')
      }

      const committed = await options.worktrees.commit(
        currentTask,
        prepared.value,
        verified.value,
        parsed.value.commitMessage.replaceAll(/[\r\n]/g, ' ').replaceAll(/\s+/g, ' ').trim().slice(0, 240),
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
