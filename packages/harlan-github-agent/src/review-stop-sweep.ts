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
    | { _tag: 'Retired', repository: string, pullRequestNumber: number, reason: string }

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
  github: Pick<GitHubAgentSource, 'clearAgentLabels' | 'editReviewStatus' | 'getPullRequestReviewSnapshot'>
  now: () => Date
  repositories: RepositoryMapping[]
  store: Pick<JournalStore, 'listStoppedReviews' | 'recordDeletedReviewComment' | 'recordReviewClosure' | 'recordStoppedReviewStatus'>
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
      workflowVersion: 2,
      headSha: review.currentHeadSha,
      baseSha: review.currentBaseSha,
    })
    const action = disposition._tag === 'Merged' ? 'merged' : 'closed'
    return `${AUTOMATED_REVIEW_MARKER}
<!-- reviewed-sha: ${review.currentHeadSha} -->
<!-- workflow-state: ${workflow} -->
### 🤖 ${disposition._tag.toUpperCase()}

${automatedDisclosure({ kind: 'review', disclaimer: `It is not Harlan's personal review or approval.`, updatedAt: updatedAtLabel(at) })}

GitHub ${action} this pull request. No further automated Review will run.`
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
    const statusReview = live !== null && live.value.pullRequest.state === 'closed'
      ? {
          ...review,
          currentHeadSha: live.value.pullRequest.headSha,
          currentBaseSha: live.value.pullRequest.baseSha,
        }
      : review
    const body = stoppedReviewComment(statusReview, at, disposition)
    const edited = await options.github.editReviewStatus(mapping, review.pullRequestNumber, review.commentId, review.publishedBody, body, signal)
    if (edited._tag === 'Err')
      return err(`${review.repository}#${review.pullRequestNumber}: ${edited.error}`)
    const closure = disposition._tag === 'Stopped' ? null : disposition
    if (edited.value._tag === 'Missing') {
      if (closure !== null) {
        const labels = await options.github.clearAgentLabels(mapping, review.pullRequestNumber, signal)
        if (labels._tag === 'Err')
          return err(`${review.repository}#${review.pullRequestNumber}: ${labels.error}`)
        const recorded = options.store.recordReviewClosure({
          repository: review.repository,
          pullRequestNumber: review.pullRequestNumber,
          revisionId: review.closureRevisionId,
          headSha: review.currentHeadSha,
          baseSha: review.currentBaseSha,
          disposition: closure,
          result: { _tag: 'CommentGone' },
          at,
        })
        if (!recorded)
          return err(`${review.repository}#${review.pullRequestNumber}: the final pull request state could not be saved.`)
      }
      // Retire the publication after closure succeeds. If label cleanup fails,
      // the row stays eligible and the next sweep can try again.
      options.store.recordDeletedReviewComment({
        taskKind: review.taskKind,
        taskId: review.taskId,
        commentId: review.commentId,
        at,
        reason: 'A person deleted the comment.',
      })
      return ok({ _tag: 'CommentGone', repository: review.repository, pullRequestNumber: review.pullRequestNumber })
    }
    // Changed: another Task now owns the comment. Foreign: the stored id names
    // a comment another actor or pull request owns, which no pass can change.
    // Both end this publication; the closure still records that the pull
    // request left, so the row stops asking.
    if (edited.value._tag === 'Changed' || edited.value._tag === 'Foreign') {
      const foreign = edited.value._tag === 'Foreign' ? edited.value.reason : null
      if (closure !== null) {
        const labels = await options.github.clearAgentLabels(mapping, review.pullRequestNumber, signal)
        if (labels._tag === 'Err')
          return err(`${review.repository}#${review.pullRequestNumber}: ${labels.error}`)
        const recorded = options.store.recordReviewClosure({
          repository: review.repository,
          pullRequestNumber: review.pullRequestNumber,
          revisionId: review.closureRevisionId,
          headSha: review.currentHeadSha,
          baseSha: review.currentBaseSha,
          disposition: closure,
          result: { _tag: 'Superseded' },
          at,
        })
        if (!recorded)
          return err(`${review.repository}#${review.pullRequestNumber}: the final pull request state could not be saved.`)
      }
      options.store.recordDeletedReviewComment({
        taskKind: review.taskKind,
        taskId: review.taskId,
        commentId: review.commentId,
        at,
        reason: foreign ?? 'Another Task replaced the canonical comment.',
      })
      return ok(foreign === null
        ? { _tag: 'Superseded', repository: review.repository, pullRequestNumber: review.pullRequestNumber }
        : { _tag: 'Retired', repository: review.repository, pullRequestNumber: review.pullRequestNumber, reason: foreign })
    }
    const labels = await options.github.clearAgentLabels(mapping, review.pullRequestNumber, signal)
    if (labels._tag === 'Err')
      return err(`${review.repository}#${review.pullRequestNumber}: ${labels.error}`)
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
    if (!recorded)
      return err(`${review.repository}#${review.pullRequestNumber}: the final review comment could not be saved.`)
    if (closure !== null) {
      const closureRecorded = options.store.recordReviewClosure({
        repository: review.repository,
        pullRequestNumber: review.pullRequestNumber,
        revisionId: review.closureRevisionId,
        headSha: review.currentHeadSha,
        baseSha: review.currentBaseSha,
        disposition: closure,
        result: { _tag: 'Published', body, commentId: edited.value.commentId, url: edited.value.url },
        at,
      })
      if (!closureRecorded)
        return err(`${review.repository}#${review.pullRequestNumber}: the final pull request state could not be saved.`)
    }
    return ok({ _tag: 'Published', repository: review.repository, pullRequestNumber: review.pullRequestNumber })
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
