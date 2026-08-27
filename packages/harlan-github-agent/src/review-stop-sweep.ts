import type { GitHubAgentSource } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { JournalStore, StoppedReview, StoppedReviewDisposition } from './store.ts'
import type { RepositoryMapping } from './types.ts'
import { err, ok } from './result.ts'
import { AUTOMATED_REVIEW_MARKER, automatedDisclosure } from './review-comment.ts'
import { cleanLine, updatedAtLabel } from './text.ts'

export type StoppedReviewOutcome
  = | { _tag: 'Published', repository: string, pullRequestNumber: number }
    | { _tag: 'CommentGone', repository: string, pullRequestNumber: number }
    | { _tag: 'Superseded', repository: string, pullRequestNumber: number }

export type { StoppedReviewDisposition }

/**
 * What one pass of the sweep did, and what it left behind.
 *
 * `remaining` is never silent. A sweep that closes three comments out of a
 * hundred and says nothing reads exactly like a sweep with nothing to do.
 */
export interface StoppedReviewSweep {
  results: Array<Result<StoppedReviewOutcome, string>>
  remaining: number
}

export interface ReviewStopSweepOptions {
  github: Pick<GitHubAgentSource, 'editReviewStatus' | 'getPullRequestReviewSnapshot'>
  now: () => Date
  repositories: RepositoryMapping[]
  store: Pick<JournalStore, 'listStoppedReviews' | 'recordDeletedReviewComment' | 'recordStoppedReviewStatus'>
  /**
   * How long one pass may spend closing comments.
   *
   * Every row costs a GitHub round trip, and the whole list used to run inside
   * a pass that has a fixed deadline. A backlog of 139 rows spent that deadline
   * and the poller aborted the sweep at the same place every pass, so two
   * comments closed and the rest never ran. The sweep stops on its own budget
   * now and the next pass carries on.
   */
  budgetMilliseconds?: number
}

export function stoppedReviewComment(
  review: StoppedReview,
  at: string,
  disposition: StoppedReviewDisposition = { _tag: 'Stopped' },
): string {
  if (disposition._tag !== 'Stopped') {
    const workflow = JSON.stringify({
      _tag: disposition._tag === 'Merged' ? 'PullRequestMerged' : 'PullRequestClosed',
      headSha: review.headSha,
    })
    const action = disposition._tag === 'Merged' ? 'merged' : 'closed'
    return `${AUTOMATED_REVIEW_MARKER}
<!-- reviewed-sha: ${review.headSha} -->
<!-- workflow-state: ${workflow} -->
### 🤖 ${disposition._tag.toUpperCase()}

${automatedDisclosure({ kind: 'review', disclaimer: `It is not Harlan's personal review or approval.`, updatedAt: updatedAtLabel(at) })}

GitHub ${action} this pull request. The unfinished automated review stopped.`
  }
  if (review.taskKind === 'review_fix') {
    const findings = review.findings.map(finding => finding._tag === 'Fixed'
      ? `- **Fixed:** ${cleanLine(finding.summary)}`
      : `- **Open:** ${cleanLine(finding.summary)}${/[.!?]$/.test(cleanLine(finding.summary)) ? '' : '.'} Next: ${cleanLine(finding.nextAction)}`)
    return `${AUTOMATED_REVIEW_MARKER}
<!-- reviewed-sha: ${review.headSha} -->
### 🤖 BLOCKED

${automatedDisclosure({ kind: 'review', disclaimer: `It is not Harlan's personal review or approval.`, notes: ['A person still decides the merge.'], updatedAt: updatedAtLabel(at) })}

Repair stopped: ${cleanLine(review.reason)}

${findings.join('\n')}`
  }
  return `${AUTOMATED_REVIEW_MARKER}
<!-- reviewed-sha: ${review.headSha} -->
### 🤖 STOPPED

${automatedDisclosure({ kind: 'review', disclaimer: `It is not Harlan's personal review or approval.`, notes: ['A person still decides the merge.'], updatedAt: updatedAtLabel(at) })}

The automated review stopped. Reason: ${cleanLine(review.reason)}

Push a new commit to start a new review. To review this commit again, comment \`/harlan-agent rerun\`.`
}

/**
 * Replaces a progress comment left behind by a review that stopped.
 *
 * A review writes one canonical comment as it works. When its Task dies, that
 * comment keeps claiming a review is running, so the controller closes it out.
 *
 * The write is an edit, never an open. A person who deletes the stale comment
 * has answered it, and posting it again would overrule them.
 */
export async function publishStoppedReviews(
  options: ReviewStopSweepOptions,
  signal: AbortSignal,
): Promise<StoppedReviewSweep> {
  const mappings = new Map(options.repositories.map(mapping => [mapping.github.toLowerCase(), mapping]))
  const reviews = options.store.listStoppedReviews()
  const publish = async (review: StoppedReview): Promise<Result<StoppedReviewOutcome, string>> => {
    const mapping = mappings.get(review.repository.toLowerCase())
    if (mapping === undefined)
      return err(`${review.repository}: the repository is no longer configured.`)
    // A closed pull request takes no more commits, so the stored answer is the
    // current one and the read is skipped. GitHub answers no snapshot request
    // at all once the head branch is deleted, which is every merged pull
    // request whose branch GitHub cleaned up.
    const live = review.disposition._tag === 'Stopped'
      ? await options.github.getPullRequestReviewSnapshot(mapping, review.pullRequestNumber, signal)
      : null
    if (live !== null && live._tag === 'Err')
      return err(`${review.repository}#${review.pullRequestNumber}: ${live.error}`)
    if (live !== null && live.value.pullRequest.state === 'open' && live.value.pullRequest.headSha !== review.headSha)
      return ok({ _tag: 'Superseded', repository: review.repository, pullRequestNumber: review.pullRequestNumber })

    const at = options.now().toISOString()
    const disposition: StoppedReviewDisposition = live === null
      ? review.disposition
      : live.value.pullRequest.state === 'open'
        ? { _tag: 'Stopped' }
        : live.value.pullRequest.mergedAt === null
          ? { _tag: 'Closed' }
          : { _tag: 'Merged' }
    const body = stoppedReviewComment(review, at, disposition)
    const edited = await options.github.editReviewStatus(mapping, review.pullRequestNumber, review.commentId, review.publishedBody, body, signal)
    if (edited._tag === 'Err')
      return err(`${review.repository}#${review.pullRequestNumber}: ${edited.error}`)
    if (edited.value._tag === 'Missing') {
      // Deleting the comment is how a person answers it. Retiring the
      // publication is what stops this sweep asking again on every pass.
      options.store.recordDeletedReviewComment({
        taskKind: review.taskKind,
        taskId: review.taskId,
        commentId: review.commentId,
        at,
      })
      return ok({ _tag: 'CommentGone', repository: review.repository, pullRequestNumber: review.pullRequestNumber })
    }
    if (edited.value._tag === 'Changed')
      return ok({ _tag: 'Superseded', repository: review.repository, pullRequestNumber: review.pullRequestNumber })
    const recorded = options.store.recordStoppedReviewStatus({
      taskId: review.taskId,
      taskKind: review.taskKind,
      revisionId: review.revisionId,
      expectedHeadSha: review.headSha,
      body,
      at,
      commentId: edited.value.commentId,
      url: edited.value.url,
    })
    return recorded
      ? ok({ _tag: 'Published', repository: review.repository, pullRequestNumber: review.pullRequestNumber })
      : err(`${review.repository}#${review.pullRequestNumber}: the final review comment could not be saved.`)
  }

  const budgetMilliseconds = options.budgetMilliseconds ?? 30_000
  const startedAt = options.now().getTime()
  const results: Array<Result<StoppedReviewOutcome, string>> = []
  let index = 0
  for (const review of reviews) {
    if (signal.aborted || options.now().getTime() - startedAt >= budgetMilliseconds)
      break
    index += 1
    // One row must not take the rest of the sweep with it. A throw here used
    // to abandon every row behind it, and the pass reported nothing at all.
    results.push(await publish(review).catch((error: unknown) =>
      err(`${review.repository}#${review.pullRequestNumber}: ${error instanceof Error ? error.message : 'The stopped review comment failed unexpectedly.'}`)))
  }
  return { results, remaining: reviews.length - index }
}
