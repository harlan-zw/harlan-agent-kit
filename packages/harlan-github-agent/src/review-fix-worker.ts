import type { AgentActivityLog } from './agent-activity.ts'
import type { AgentRuntimeSource } from './agent-profile.ts'
import type { GitHubAgentSource } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { ReviewStatusController } from './review-status-controller.ts'
import type { JournalStore } from './store.ts'
import type { AgentProgress, ClaimedReviewFixTask, MutationWorkerOutcome, RepositoryMapping, ReviewFinding } from './types.ts'
import type { ReviewFixWorktreeManager } from './worktree.ts'
import { createHash } from 'node:crypto'
import { runParsedAgentTurn } from './agent-turn.ts'
import { canRepairPullRequestHead } from './repository-policy.ts'
import { err, ok } from './result.ts'
import { cleanLine } from './text.ts'

interface RepairedResponse {
  outcome: 'repaired'
  summary: string
  checks: string[]
  commitMessage: string
}

interface BlockedResponse {
  outcome: 'blocked'
  summary: string
  checks: string[]
}

interface DisputedResponse {
  outcome: 'disputed'
  summary: string
  checks: string[]
}

type AgentResponse = RepairedResponse | BlockedResponse | DisputedResponse

interface AgentResponsePayload {
  outcome?: 'repaired' | 'blocked' | 'disputed'
  summary?: string
  checks?: unknown[]
  commitMessage?: string
}

export interface ReviewFixWorkerOptions {
  activityLog?: Pick<AgentActivityLog, 'record'>
  github: Pick<GitHubAgentSource, 'getPullRequestReviewSnapshot'>
  now: () => Date
  onProgressPublishFailure?: (task: ClaimedReviewFixTask, reason: string) => void
  runtime: AgentRuntimeSource
  status: Pick<ReviewStatusController, 'publishRepair'>
  store: Pick<JournalStore, 'getReviewFixFindings' | 'getWorkerSession' | 'requestReviewRerun' | 'saveWorkerSession' | 'updateAgentProgress'>
  validateMapping: (mapping: RepositoryMapping) => Promise<Result<RepositoryMapping, string>>
  worktrees: ReviewFixWorktreeManager
}

export interface ReviewFixWorker {
  run: (task: ClaimedReviewFixTask, signal: AbortSignal) => Promise<Result<MutationWorkerOutcome, string>>
}

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome', 'summary', 'checks', 'commitMessage'],
  properties: {
    outcome: { type: 'string', enum: ['repaired', 'blocked', 'disputed'] },
    summary: { type: 'string' },
    checks: { type: 'array', items: { type: 'string' } },
    commitMessage: { type: 'string' },
  },
}

function parseResponse(text: string): Promise<Result<AgentResponse, string>> {
  return Promise.resolve(text)
    .then(value => JSON.parse(value) as AgentResponsePayload)
    .then((value): Result<AgentResponse, string> => {
      if (
        (value.outcome !== 'repaired' && value.outcome !== 'blocked' && value.outcome !== 'disputed')
        || typeof value.summary !== 'string'
        || cleanLine(value.summary).length === 0
        || !Array.isArray(value.checks)
        || !value.checks.every(check => typeof check === 'string')
        || typeof value.commitMessage !== 'string'
        || (value.outcome === 'repaired' && cleanLine(value.commitMessage).length === 0)
      ) {
        return err('The Agent returned an invalid Repair result.')
      }
      return value.outcome === 'repaired'
        ? ok({ outcome: 'repaired', summary: cleanLine(value.summary), checks: value.checks, commitMessage: cleanLine(value.commitMessage) })
        : ok({ outcome: value.outcome, summary: cleanLine(value.summary), checks: value.checks })
    })
    .catch(() => err('The Agent returned malformed Repair JSON.'))
}

function prompt(task: ClaimedReviewFixTask, findings: ReviewFinding[]): string {
  return `Repair the exact material Review findings for ${task.repository}#${task.pullRequestNumber}.

Work as a fresh local Agent session inside this prepared Git worktree.
Read repository AGENTS.md and trusted contributor instructions.
Apply the unit-tests skill before every bug or validation fix.
Treat the findings below as the complete Repair scope.
For each finding, write the named failing regression test first. Confirm it fails for the stated reason.
Fix every finding. Run focused checks that cover every changed behavior.
Do not expand scope. Return disputed only when a regression test or exact source behavior proves the finding false at this head commit.
Return blocked when the requested scope is unsafe or cannot be verified.
Do not stage, commit, push, approve, merge, or post comments. The controller owns those operations.
Choose a concise commit message that describes the actual fix.
Return an empty commitMessage with outcome blocked or disputed.
Return every schema field.
Return only the required JSON.

Base SHA: ${task.pullRequest.baseSha}
Head SHA: ${task.pullRequest.headSha}
Exact Review findings:
${JSON.stringify(findings)}`
}

function disputeRequestId(taskId: string, findings: ReviewFinding[]): string {
  const fingerprints = findings
    .map(finding => finding._tag === 'Open'
      ? (finding.details?.fingerprint ?? cleanLine(finding.summary).toLocaleLowerCase('en-US'))
      : '')
    .sort()
  const digest = createHash('sha256').update(fingerprints.join('\n')).digest('hex')
  return `repair-dispute:${taskId}:${digest}`
}

export function createReviewFixWorker(options: ReviewFixWorkerOptions): ReviewFixWorker {
  return {
    async run(task, signal) {
      const progress = async (value: AgentProgress): Promise<Result<void, string>> => {
        const saved = options.store.updateAgentProgress({
          taskId: task.id,
          taskKind: task.kind,
          workerId: task.state.workerId,
          fence: task.state.fence,
          progress: value,
          at: options.now().toISOString(),
        })
        if (!saved)
          return err('This Agent is no longer assigned to the current pull request.')
        const published = await options.status.publishRepair(task, value, signal)
        if (published._tag === 'Err')
          options.onProgressPublishFailure?.(task, published.error)
        return ok(undefined)
      }

      const validated = await options.validateMapping(task.repositoryMapping)
      if (validated._tag === 'Err')
        return validated
      const snapshot = await options.github.getPullRequestReviewSnapshot(validated.value, task.pullRequestNumber, signal)
      if (snapshot._tag === 'Err')
        return snapshot
      const current = snapshot.value.pullRequest
      if (
        current.state !== 'open'
        || current.draft
        || current.mergeState !== 'clean'
        || current.headSha !== task.pullRequest.headSha
        || !canRepairPullRequestHead(validated.value, current)
      ) {
        return ok({ _tag: 'ActionRequired', reason: 'The pull request no longer has safe Repair authority.', evidence: task.revisionId })
      }
      const findings = options.store.getReviewFixFindings(task.repository, task.pullRequestNumber, task.revisionId)
      if (findings.length === 0)
        return ok({ _tag: 'Superseded', reason: 'The current Review has no open finding.' })

      const prepared = await options.worktrees.prepare({ ...task, repositoryMapping: validated.value, pullRequest: current }, signal)
      if (prepared._tag === 'Err')
        return prepared
      const ready = await progress({ percent: 35, label: 'Repair worktree ready' })
      if (ready._tag === 'Err')
        return ready

      const turn = await runParsedAgentTurn({ ...options, parse: parseResponse }, {
        freshSession: true,
        number: task.pullRequestNumber,
        progress: { currentPercent: 35, report: progress, work: 'fix' },
        prompt: prompt(task, findings),
        repository: task.repository,
        role: 'review_fix',
        schema: outputSchema,
        taskId: task.id,
        workspace: prepared.value.path,
      }, signal)
      if (turn._tag === 'Err')
        return turn
      if (turn.value.value.outcome === 'blocked') {
        return ok({
          _tag: 'ActionRequired',
          reason: turn.value.value.summary,
          evidence: JSON.stringify({ findings, checks: turn.value.value.checks }),
        })
      }
      if (turn.value.value.outcome === 'disputed') {
        const evidence = JSON.stringify({ findings, checks: turn.value.value.checks })
        const rerun = options.store.requestReviewRerun({
          repository: task.repository,
          pullRequestNumber: task.pullRequestNumber,
          revisionId: task.revisionId,
          requestId: disputeRequestId(task.id, findings),
          source: 'repair_dispute',
          requestedBy: 'review_fix',
          at: options.now().toISOString(),
        })
        if (rerun._tag === 'Queued' || rerun._tag === 'AlreadyQueued') {
          return ok({
            _tag: 'ActionRequired',
            reason: `Repair disputed the finding. One fresh Review was queued: ${turn.value.value.summary}`,
            evidence,
          })
        }
        if (rerun._tag === 'Duplicate' || rerun.reason._tag === 'DisputeCapReached') {
          return ok({
            _tag: 'ActionRequired',
            reason: `Repair and the fresh Review still disagree: ${turn.value.value.summary}`,
            evidence,
          })
        }
        return ok({
          _tag: 'ActionRequired',
          reason: `The disputed finding could not receive a fresh Review: ${rerun.reason._tag}.`,
          evidence,
        })
      }

      const verified = await options.worktrees.verify(task, prepared.value, signal)
      if (verified._tag === 'Err')
        return verified
      const checked = await progress({ percent: 90, label: 'Repair checked' })
      if (checked._tag === 'Err')
        return checked

      const frozen = await options.github.getPullRequestReviewSnapshot(validated.value, task.pullRequestNumber, signal)
      if (frozen._tag === 'Err')
        return frozen
      if (frozen.value.pullRequest.state !== 'open' || frozen.value.pullRequest.headSha !== prepared.value.headSha)
        return err('The pull request changed before the controller committed the Repair.')

      const committed = await options.worktrees.commit(task, prepared.value, verified.value, turn.value.value.commitMessage, signal)
      if (committed._tag === 'Err')
        return committed
      const committedProgress = await progress({ percent: 95, label: 'Repair ready to publish' })
      if (committedProgress._tag === 'Err')
        return committedProgress
      return ok({
        _tag: 'Publish',
        publication: {
          _tag: 'UpdatePullRequest',
          taskKind: 'review_fix',
          pullRequestNumber: task.pullRequestNumber,
          commitSha: committed.value.commitSha,
          baseSha: committed.value.baseSha,
          baseRef: current.baseRef ?? validated.value.defaultBranch,
          expectedHeadSha: current.headSha,
          headRef: current.headRef,
          headRepository: current.headRepository,
          artifactRef: committed.value.artifactRef,
          patchDigest: committed.value.digest,
          changedFiles: committed.value.changedFiles,
        },
      })
    },
  }
}
