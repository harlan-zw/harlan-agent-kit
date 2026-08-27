import type { GitHubAgentSource } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { JournalStore, QueuedReviewStatus, ReviewQueueState } from './store.ts'
import type { RepositoryMapping } from './types.ts'
import { formatProgressBar } from './agent-progress.ts'
import { err, ok } from './result.ts'
import { AUTOMATED_REVIEW_MARKER, automatedDisclosure } from './review-comment.ts'

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
 * No timestamp, no estimate, and no Queue length. The comment carries one
 * changing fact, this Task's own position, so a Task nobody overtook renders
 * an identical body and the sweep writes nothing.
 *
 * The length used to appear as "3rd of 7". Every Task joining the Queue moved
 * that number, so one new pull request rewrote the comment on every other
 * waiting pull request, once per poll. A position moves only when the Task
 * ahead leaves, which is the fact worth an edit.
 */
export function queuePositionComment(status: QueuedReviewStatus): string {
  const work = workLabel[status.taskKind]
  const heading = status.queue._tag === 'Paused'
    ? 'PAUSED'
    : `QUEUED · ${ordinal(status.queue.position)}`
  const ahead = status.queue._tag === 'Paused' ? 0 : status.queue.position - 1
  const next = status.queue._tag === 'Paused'
    ? `${work} starts when this repository resumes.`
    : ahead === 0
      ? `${work} starts as soon as an agent is free.`
      : ahead === 1
        ? `${work} starts after the 1 Task ahead of it finishes.`
        : `${work} starts after the ${ahead} Tasks ahead of it finish.`
  return `${AUTOMATED_REVIEW_MARKER}
<!-- reviewed-sha: ${status.headSha} -->
### 🤖 ${heading}

${automatedDisclosure({ kind: 'review', notes: ['This comment updates as the Queue moves.'] })}

\`${formatProgressBar(0)}\`

Next: ${next}`
}

export interface QueuePositionSweepOptions {
  github: Pick<GitHubAgentSource, 'clearReviewOutcome' | 'editReviewStatus' | 'getPullRequestReviewSnapshot'>
  now: () => Date
  repositories: RepositoryMapping[]
  store: Pick<JournalStore, 'isQueuedReviewStatus' | 'listQueuedReviewStatuses' | 'recordDeletedReviewComment' | 'recordQueuedReviewStatus'>
}

export type QueuePositionOutcome
  = | { _tag: 'Published', repository: string, pullRequestNumber: number, queue: ReviewQueueState }
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
 * A paused repository queues Tasks that no agent claims. Its comment used to
 * keep whatever the last Task left on it, so a pause read as work in progress.
 * The comment names the pause instead, and returns to a position on resume.
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
  const publish = async (status: QueuedReviewStatus): Promise<Result<QueuePositionOutcome, string>> => {
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

    // The verdict label names the head its Review answered for. A Task queued
    // against a head no Review has reached leaves that label describing an
    // older one, and a stale READY is the reading that costs a person a trip.
    // This runs only on a pass that rewrites the comment, so a new head clears
    // the label once rather than every pass.
    if (status.verdict._tag === 'Unanswered') {
      const cleared = await options.github.clearReviewOutcome(mapping, status.pullRequestNumber, signal)
      if (cleared._tag === 'Err')
        return err(`${status.repository}#${status.pullRequestNumber}: ${cleared.error}`)
    }

    const at = options.now().toISOString()
    const body = queuePositionComment(status)
    const edited = await options.github.editReviewStatus(mapping, status.pullRequestNumber, status.commentId, status.publishedBody, body, signal)
    if (edited._tag === 'Err')
      return err(`${status.repository}#${status.pullRequestNumber}: ${edited.error}`)
    if (edited.value._tag === 'Missing') {
      // Same as the stopped-review sweep: a deleted comment is answered, and
      // the publication has to retire or every later pass asks again.
      options.store.recordDeletedReviewComment({
        taskKind: status.taskKind,
        taskId: status.taskId,
        commentId: status.commentId,
        at,
      })
      return ok({ _tag: 'CommentGone', repository: status.repository, pullRequestNumber: status.pullRequestNumber })
    }
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
          queue: status.queue,
        })
      // The claim was lost while the edit was in flight, so the claimed agent
      // now owns the comment. Nothing was saved and nothing needs to be.
      : ok({ _tag: 'Superseded', repository: status.repository, pullRequestNumber: status.pullRequestNumber })
  }

  const results: Array<Result<QueuePositionOutcome, string>> = []
  for (const status of changed)
    results.push(await publish(status))
  return results
}
