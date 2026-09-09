import type { ExistingReviewLabelFailure, ExistingReviewLabelSource, GitHubAgentSource, PublishedReviewStatus } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { AgentProgress, ClaimedAdversarialReviewTask, ClaimedReviewFixTask, ClaimedReviewStatusCommand, ReviewDesiredOutcome, ReviewGates, ReviewStatusTaskPhase } from './types.ts'
import { formatPhaseDuration } from './agent-progress.ts'
import { repairRoundLabel } from './repair-rounds.ts'
import { err, ok } from './result.ts'
import { AUTOMATED_REVIEW_MARKER, automatedDisclosure } from './review-comment.ts'
import { updatedAtLabel } from './text.ts'

export interface ReviewStatusController {
  publish: (task: ClaimedAdversarialReviewTask, phase: 'snapshot' | 'review' | 'terminal', body: string, signal: AbortSignal) => Promise<Result<PublishedReviewStatus, string>>
  stageTerminal?: (task: ClaimedAdversarialReviewTask, body: string, desiredOutcome: ReviewDesiredOutcome, reviewRunId?: string, gates?: ReviewGates) => Result<{ commandId: string }, string>
  publishRepair: (task: ClaimedReviewFixTask, progress: AgentProgress, signal: AbortSignal) => Promise<Result<void, string>>
}

export interface ReviewStatusControllerOptions {
  github: Pick<GitHubAgentSource, 'getPullRequestReviewSnapshot' | 'stampAgentLabel' | 'upsertReviewStatus'> & ExistingReviewLabelSource
  leaseMilliseconds: number
  now: () => Date
  store: Pick<JournalStore, 'claimReviewStatus' | 'completeReviewStatus' | 'deferReviewStatus' | 'recordReviewStatusReceipt' | 'stageReviewStatus' | 'supersedeReviewStatus'>
  workerId: string
}

export interface ReviewStatusPublicationOptions {
  github: Pick<GitHubAgentSource, 'getPullRequestReviewSnapshot' | 'stampAgentLabel' | 'upsertReviewStatus'> & ExistingReviewLabelSource
  now: () => Date
  store: Pick<JournalStore, 'completeReviewStatus' | 'deferReviewStatus' | 'recordReviewStatusReceipt' | 'supersedeReviewStatus'>
}

/** Files one failure with the store that answers for it: defer or retire. */
function settleUnpublished(
  options: ReviewStatusPublicationOptions,
  command: ClaimedReviewStatusCommand,
  failure: ExistingReviewLabelFailure,
): void {
  const input = {
    commandId: command.id,
    workerId: command.workerId,
    fence: command.fence,
    at: options.now().toISOString(),
    reason: failure.message,
  }
  if (failure._tag === 'Transient')
    options.store.deferReviewStatus(input)
  else
    options.store.supersedeReviewStatus(input)
}

/** Restores one outcome label for a trusted review comment this service must not edit. */
async function publishExistingReviewLabel(
  options: ReviewStatusPublicationOptions,
  command: ClaimedReviewStatusCommand,
  baseRef: string,
  signal: AbortSignal,
): Promise<Result<PublishedReviewStatus, string>> {
  // The read re-validates the state, head, and base branch, so the heavier review
  // snapshot would spend GitHub calls re-reading the same truth.
  const existing = command.commentId === null
    ? err({ _tag: 'Permanent' as const, message: 'The existing review has no comment identifier.' })
    : await options.github.readExistingReviewLabel(
        command.repositoryMapping,
        command.pullRequestNumber,
        command.commentId,
        command.expectedHeadSha,
        baseRef,
        signal,
      )
  if (existing._tag === 'Err') {
    settleUnpublished(options, command, existing.error)
    return err(existing.error.message)
  }
  const stamped = await options.github.stampAgentLabel(
    command.repositoryMapping,
    command.pullRequestNumber,
    existing.value.label,
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
  const completed = options.store.completeReviewStatus({
    commandId: command.id,
    workerId: command.workerId,
    fence: command.fence,
    at: options.now().toISOString(),
    commentId: existing.value.commentId,
    url: existing.value.url,
  })
  return completed
    ? ok(existing.value)
    : err('GitHub accepted the review comment, but the local review changed. Refresh before retrying.')
}

/** Publishes one already fenced command. Terminal commands may outlive their Agent Task. */
export async function publishClaimedReviewStatus(
  options: ReviewStatusPublicationOptions,
  command: ClaimedReviewStatusCommand,
  replacePriorReview: boolean,
  signal: AbortSignal,
): Promise<Result<PublishedReviewStatus, string>> {
  if (command.expectedBaseRef === null) {
    const reason = 'The review has no recorded base branch. Run a new Review.'
    options.store.supersedeReviewStatus({
      commandId: command.id,
      workerId: command.workerId,
      fence: command.fence,
      at: options.now().toISOString(),
      reason,
    })
    return err(reason)
  }
  if (command.taskKind === 'existing_review')
    return publishExistingReviewLabel(options, command, command.expectedBaseRef, signal)

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
  if (
    current.value.pullRequest.state !== 'open'
    || current.value.pullRequest.headSha !== command.expectedHeadSha
    || current.value.pullRequest.baseRef !== command.expectedBaseRef
  ) {
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
    stageTerminal(task, body, desiredOutcome, reviewRunId, gates) {
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
        ...(gates === undefined ? {} : { gates }),
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
