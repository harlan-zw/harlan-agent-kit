import type { GitHubAgentSource, PublishedReviewStatus } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { AgentProgress, ClaimedAdversarialReviewTask, ClaimedReviewFixTask, ClaimedReviewStatusCommand, ReviewDesiredOutcome, ReviewStatusTaskPhase } from './types.ts'
import { formatPhaseDuration } from './agent-progress.ts'
import { repairRoundLabel } from './repair-rounds.ts'
import { err, ok } from './result.ts'
import { AUTOMATED_REVIEW_MARKER, automatedDisclosure } from './review-comment.ts'
import { updatedAtLabel } from './text.ts'

export interface ReviewStatusController {
  publish: (task: ClaimedAdversarialReviewTask, phase: 'snapshot' | 'review' | 'terminal', body: string, signal: AbortSignal) => Promise<Result<PublishedReviewStatus, string>>
  stageTerminal?: (task: ClaimedAdversarialReviewTask, body: string, desiredOutcome: ReviewDesiredOutcome, reviewRunId?: string) => Result<{ commandId: string }, string>
  publishRepair: (task: ClaimedReviewFixTask, progress: AgentProgress, signal: AbortSignal) => Promise<Result<void, string>>
}

export interface ReviewStatusControllerOptions {
  github: Pick<GitHubAgentSource, 'getPullRequestReviewSnapshot' | 'stampAgentLabel' | 'upsertReviewStatus'>
  leaseMilliseconds: number
  now: () => Date
  store: Pick<JournalStore, 'claimReviewStatus' | 'completeReviewStatus' | 'deferReviewStatus' | 'recordReviewStatusReceipt' | 'stageReviewStatus'>
  workerId: string
}

export interface ReviewStatusPublicationOptions {
  github: Pick<GitHubAgentSource, 'getPullRequestReviewSnapshot' | 'stampAgentLabel' | 'upsertReviewStatus'>
  now: () => Date
  store: Pick<JournalStore, 'completeReviewStatus' | 'deferReviewStatus' | 'recordReviewStatusReceipt'>
}

/** Publishes one already fenced command. Terminal commands may outlive their Agent Task. */
export async function publishClaimedReviewStatus(
  options: ReviewStatusPublicationOptions,
  command: ClaimedReviewStatusCommand,
  replacePriorReview: boolean,
  signal: AbortSignal,
): Promise<Result<PublishedReviewStatus, string>> {
  const current = await options.github.getPullRequestReviewSnapshot(command.repositoryMapping, command.pullRequestNumber, signal)
  if (current._tag === 'Err') {
    options.store.deferReviewStatus({
      commandId: command.id,
      workerId: command.workerId,
      fence: command.fence,
      at: options.now().toISOString(),
      reason: current.error,
    })
    return current
  }
  if (current.value.pullRequest.state !== 'open' || current.value.pullRequest.headSha !== command.expectedHeadSha) {
    const reason = 'The pull request changed before the review comment was posted.'
    options.store.deferReviewStatus({
      commandId: command.id,
      workerId: command.workerId,
      fence: command.fence,
      at: options.now().toISOString(),
      reason,
    })
    return err(reason)
  }

  const published = await options.github.upsertReviewStatus(
    command.repositoryMapping,
    command.pullRequestNumber,
    command.commentId,
    command.body,
    replacePriorReview,
    signal,
  )
  if (published._tag === 'Err') {
    options.store.deferReviewStatus({
      commandId: command.id,
      workerId: command.workerId,
      fence: command.fence,
      at: options.now().toISOString(),
      reason: published.error,
    })
    return published
  }
  const commentConfirmed = options.store.recordReviewStatusReceipt({
    commandId: command.id,
    workerId: command.workerId,
    fence: command.fence,
    at: options.now().toISOString(),
    sink: 'comment',
    commentId: published.value.commentId,
    url: published.value.url,
  })
  if (!commentConfirmed)
    return err('GitHub accepted the review comment, but its receipt lost the Publication lease.')

  const label = command.phase !== 'terminal'
    ? null
    : command.desiredOutcome === 'READY' || command.desiredOutcome === 'BLOCKED' || command.desiredOutcome === 'PENDING'
      ? command.desiredOutcome
      : command.desiredOutcome === 'WAITING'
        ? 'PENDING'
        : null
  if (label !== null) {
    const stamped = await options.github.stampAgentLabel(
      command.repositoryMapping,
      command.pullRequestNumber,
      label,
      signal,
    )
    if (stamped._tag === 'Err') {
      options.store.deferReviewStatus({
        commandId: command.id,
        workerId: command.workerId,
        fence: command.fence,
        at: options.now().toISOString(),
        reason: stamped.error,
      })
      return stamped
    }
    const labelConfirmed = options.store.recordReviewStatusReceipt({
      commandId: command.id,
      workerId: command.workerId,
      fence: command.fence,
      at: options.now().toISOString(),
      sink: 'outcome_label',
    })
    if (!labelConfirmed)
      return err('GitHub accepted the Review label, but its receipt lost the Publication lease.')
  }
  const completed = options.store.completeReviewStatus({
    commandId: command.id,
    workerId: command.workerId,
    fence: command.fence,
    at: options.now().toISOString(),
    commentId: published.value.commentId,
    url: published.value.url,
  })
  return completed
    ? ok(published.value)
    : err('GitHub accepted the review comment, but the local review changed. Refresh before retrying.')
}

function repairProgressComment(task: ClaimedReviewFixTask, progress: AgentProgress, at: string): string {
  // Declarative, and about the Repair rather than the reader. These lines read
  // as instructions to whoever opened the pull request when they are imperative,
  // and every other automated comment states what the work does next.
  const next = progress.percent >= 90
    ? 'Repair pushes its commit, then a new Review reads the new head.'
    : progress.percent >= 70
      ? 'Repair verifies its fix.'
      : progress.percent >= 55
        ? 'Repair finishes its fix.'
        : progress.percent >= 35
          ? 'Repair fixes the Review findings.'
          : 'Repair creates its Git worktree.'
  return `${AUTOMATED_REVIEW_MARKER}
<!-- reviewed-sha: ${task.pullRequest.headSha} -->
### 🤖 REPAIR · ${repairRoundLabel(task.rounds)} · ${progress.percent}% · ${progress.label}${formatPhaseDuration(progress.since, at)}

${automatedDisclosure({ kind: 'repair update', updatedAt: updatedAtLabel(at) })}

Next: ${next}`
}

export function createReviewStatusController(options: ReviewStatusControllerOptions): ReviewStatusController {
  async function publishStatus(
    task: ClaimedAdversarialReviewTask | ClaimedReviewFixTask,
    taskPhase: ReviewStatusTaskPhase,
    body: string,
    replacePriorReview: boolean,
    signal: AbortSignal,
  ): Promise<Result<PublishedReviewStatus, string>> {
    const at = options.now().toISOString()
    const staged = options.store.stageReviewStatus({
      ...taskPhase,
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at,
      revisionId: task.revisionId,
      expectedHeadSha: task.pullRequest.headSha,
      body,
    })
    if (staged._tag === 'Rejected')
      return err(staged.reason)
    const command = options.store.claimReviewStatus(staged.commandId, options.workerId, at, options.leaseMilliseconds)
    if (command === null)
      return err('The review comment could not be queued.')
    return publishClaimedReviewStatus(options, command, replacePriorReview, signal)
  }

  return {
    publish(task, phase, body, signal) {
      return publishStatus(
        task,
        { taskKind: 'adversarial_review', phase },
        body,
        task.rerun._tag === 'Requested',
        signal,
      )
    },
    stageTerminal(task, body, desiredOutcome, reviewRunId) {
      const staged = options.store.stageReviewStatus({
        taskKind: 'adversarial_review',
        phase: 'terminal',
        taskId: task.id,
        workerId: task.state.workerId,
        fence: task.state.fence,
        at: options.now().toISOString(),
        revisionId: task.revisionId,
        expectedHeadSha: task.pullRequest.headSha,
        body,
        desiredOutcome,
        ...(reviewRunId === undefined ? {} : { reviewRunId }),
      })
      return staged._tag === 'Rejected' ? err(staged.reason) : ok({ commandId: staged.commandId })
    },
    async publishRepair(task, progress, signal) {
      const published = await publishStatus(
        task,
        { taskKind: 'review_fix', phase: 'repair' },
        repairProgressComment(task, progress, options.now().toISOString()),
        true,
        signal,
      )
      return published._tag === 'Err' ? published : ok(undefined)
    },
  }
}
