import type { GitHubAgentSource, PublishedReviewStatus } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { AgentProgress, ClaimedAdversarialReviewTask, ClaimedReviewFixTask, ReviewStatusTaskPhase } from './types.ts'
import { formatPhaseDuration, formatProgressBar } from './agent-progress.ts'
import { err, ok } from './result.ts'
import { AUTOMATED_REVIEW_MARKER, automatedDisclosure } from './review-comment.ts'
import { updatedAtLabel } from './text.ts'

export interface ReviewStatusController {
  publish: (task: ClaimedAdversarialReviewTask, phase: 'snapshot' | 'review' | 'terminal', body: string, signal: AbortSignal) => Promise<Result<PublishedReviewStatus, string>>
  publishRepair: (task: ClaimedReviewFixTask, progress: AgentProgress, signal: AbortSignal) => Promise<Result<void, string>>
}

export interface ReviewStatusControllerOptions {
  github: Pick<GitHubAgentSource, 'getPullRequestReviewSnapshot' | 'upsertReviewStatus'>
  leaseMilliseconds: number
  now: () => Date
  store: Pick<JournalStore, 'claimReviewStatus' | 'completeReviewStatus' | 'deferReviewStatus' | 'stageReviewStatus'>
  workerId: string
}

function repairProgressComment(headSha: string, progress: AgentProgress, at: string): string {
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
<!-- reviewed-sha: ${headSha} -->
### 🤖 REPAIR · ${progress.label}${formatPhaseDuration(progress.since, at)}

${automatedDisclosure({ kind: 'repair update', updatedAt: updatedAtLabel(at) })}

\`${formatProgressBar(progress.percent)}\`

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
    async publishRepair(task, progress, signal) {
      const published = await publishStatus(
        task,
        { taskKind: 'review_fix', phase: 'repair' },
        repairProgressComment(task.pullRequest.headSha, progress, options.now().toISOString()),
        true,
        signal,
      )
      return published._tag === 'Err' ? published : ok(undefined)
    },
  }
}
