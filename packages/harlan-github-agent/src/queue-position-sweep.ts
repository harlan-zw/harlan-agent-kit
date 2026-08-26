import type { GitHubAgentSource } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { JournalStore, QueuedReviewStatus } from './store.ts'
import type { RepositoryMapping } from './types.ts'
import { formatProgressBar } from './agent-progress.ts'
import { err, ok } from './result.ts'
import { AUTOMATED_REVIEW_MARKER } from './review-comment.ts'

const workLabel: Record<QueuedReviewStatus['taskKind'], string> = {
  adversarial_review: 'Review',
  review_fix: 'Repair',
}

function ordinal(position: number): string {
  const teen = position % 100
  if (teen >= 11 && teen <= 13)
    return `${position}th`
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[position % 10] ?? 'th'
  return `${position}${suffix}`
}

/**
 * The canonical comment while its Task waits in the Queue.
 *
 * No timestamp and no estimate. The comment carries one changing fact, the
 * Queue position, so an unchanged position renders an identical body and the
 * sweep writes nothing. A timestamp here would edit every comment every pass.
 */
export function queuePositionComment(status: QueuedReviewStatus): string {
  const work = workLabel[status.taskKind]
  const ahead = status.position - 1
  const next = ahead === 0
    ? `${work} starts as soon as an agent is free.`
    : ahead === 1
      ? `${work} starts after the 1 Task ahead of it finishes.`
      : `${work} starts after the ${ahead} Tasks ahead of it finish.`
  return `${AUTOMATED_REVIEW_MARKER}
<!-- reviewed-sha: ${status.headSha} -->
### 🤖 QUEUED · ${ordinal(status.position)} of ${status.total}

> [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) posted this automated review. [AI open source policy](https://harlanzw.com/blog/ai-in-open-source). This comment updates as the Queue moves.

\`${formatProgressBar(0)}\`

Next: ${next}`
}

export interface QueuePositionSweepOptions {
  github: Pick<GitHubAgentSource, 'editReviewStatus' | 'getPullRequestReviewSnapshot'>
  now: () => Date
  repositories: RepositoryMapping[]
  store: Pick<JournalStore, 'isQueuedReviewStatus' | 'listQueuedReviewStatuses' | 'recordQueuedReviewStatus'>
}

export type QueuePositionOutcome
  = | { _tag: 'Published', repository: string, pullRequestNumber: number, position: number, total: number }
    | { _tag: 'CommentGone', repository: string, pullRequestNumber: number }
    | { _tag: 'Superseded', repository: string, pullRequestNumber: number }

/**
 * Tells a waiting pull request where its Task sits in the Queue.
 *
 * A Review that queues a Repair leaves its comment reading "Repair queued" and
 * says nothing more, so a pull request behind six other Tasks looked identical
 * to one an agent was about to pick up. The position comes from the claim
 * predicate itself, so it is the count of Tasks that must finish first.
 *
 * Only a comment this service already published is rewritten. The edit cannot
 * open a comment, so a quiet pull request stays quiet and a comment a person
 * deleted stays deleted.
 *
 * An agent can claim the Task between the Queue read and the comment write,
 * because both GitHub round trips sit in between. No local check closes that
 * window: whatever it reads can go stale before the write lands. The edit is a
 * compare and swap against the body the Queue read saw, so a claimed agent that
 * published first keeps its comment and this sweep reports Superseded.
 */
export async function publishQueuePositions(
  options: QueuePositionSweepOptions,
  signal: AbortSignal,
): Promise<Array<Result<QueuePositionOutcome, string>>> {
  const mappings = new Map(options.repositories.map(mapping => [mapping.github.toLowerCase(), mapping]))
  const changed = options.store.listQueuedReviewStatuses()
    .filter(status => queuePositionComment(status) !== status.publishedBody)
  return Promise.all(changed.map(async (status): Promise<Result<QueuePositionOutcome, string>> => {
    const mapping = mappings.get(status.repository.toLowerCase())
    if (mapping === undefined)
      return err(`${status.repository}: the repository is no longer configured.`)
    if (!options.store.isQueuedReviewStatus({ taskId: status.taskId, taskKind: status.taskKind }))
      return ok({ _tag: 'Superseded', repository: status.repository, pullRequestNumber: status.pullRequestNumber })
    const current = await options.github.getPullRequestReviewSnapshot(mapping, status.pullRequestNumber, signal)
    if (current._tag === 'Err')
      return err(`${status.repository}#${status.pullRequestNumber}: ${current.error}`)
    if (current.value.pullRequest.state !== 'open' || current.value.pullRequest.headSha !== status.headSha)
      return err(`${status.repository}#${status.pullRequestNumber}: the pull request changed before the Queue position comment.`)

    const at = options.now().toISOString()
    const body = queuePositionComment(status)
    const edited = await options.github.editReviewStatus(mapping, status.pullRequestNumber, status.commentId, status.publishedBody, body, signal)
    if (edited._tag === 'Err')
      return err(`${status.repository}#${status.pullRequestNumber}: ${edited.error}`)
    if (edited.value._tag === 'Missing')
      return ok({ _tag: 'CommentGone', repository: status.repository, pullRequestNumber: status.pullRequestNumber })
    if (edited.value._tag === 'Changed')
      return ok({ _tag: 'Superseded', repository: status.repository, pullRequestNumber: status.pullRequestNumber })
    const recorded = options.store.recordQueuedReviewStatus({
      taskId: status.taskId,
      taskKind: status.taskKind,
      revisionId: status.revisionId,
      expectedHeadSha: status.headSha,
      body,
      at,
      commentId: edited.value.commentId,
      url: edited.value.url,
    })
    return recorded
      ? ok({
          _tag: 'Published',
          repository: status.repository,
          pullRequestNumber: status.pullRequestNumber,
          position: status.position,
          total: status.total,
        })
      // The claim was lost while the edit was in flight, so the claimed agent
      // now owns the comment. Nothing was saved and nothing needs to be.
      : ok({ _tag: 'Superseded', repository: status.repository, pullRequestNumber: status.pullRequestNumber })
  }))
}
