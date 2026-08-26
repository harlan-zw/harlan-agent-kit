import type { GitHubAgentSource } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { JournalStore, StoppedReview } from './store.ts'
import type { RepositoryMapping } from './types.ts'
import { formatProgressBar } from './agent-progress.ts'
import { err, ok } from './result.ts'
import { AUTOMATED_REVIEW_MARKER } from './review-comment.ts'
import { cleanLine, updatedAtLabel } from './text.ts'

export type StoppedReviewOutcome
  = | { _tag: 'Published', repository: string, pullRequestNumber: number }
    | { _tag: 'CommentGone', repository: string, pullRequestNumber: number }
    | { _tag: 'Superseded', repository: string, pullRequestNumber: number }

export type StoppedReviewDisposition
  = | { _tag: 'Stopped' }
    | { _tag: 'Merged' }
    | { _tag: 'Closed' }

export interface ReviewStopSweepOptions {
  github: Pick<GitHubAgentSource, 'editReviewStatus' | 'getPullRequestReviewSnapshot'>
  now: () => Date
  repositories: RepositoryMapping[]
  store: Pick<JournalStore, 'listStoppedReviews' | 'recordStoppedReviewStatus'>
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

> [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) posted this automated review. It is not Harlan's personal review or approval. [AI open source policy](https://harlanzw.com/blog/ai-in-open-source). Last updated: ${updatedAtLabel(at)}.

\`${formatProgressBar(100)}\`

GitHub ${action} this pull request. The unfinished automated review stopped.`
  }
  if (review.taskKind === 'review_fix') {
    const findings = review.findings.map(finding => finding._tag === 'Fixed'
      ? `- **Fixed:** ${cleanLine(finding.summary)}`
      : `- **Open:** ${cleanLine(finding.summary)}${/[.!?]$/.test(cleanLine(finding.summary)) ? '' : '.'} Next: ${cleanLine(finding.nextAction)}`)
    return `${AUTOMATED_REVIEW_MARKER}
<!-- reviewed-sha: ${review.headSha} -->
### 🤖 BLOCKED

> [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) posted this automated review. It is not Harlan's personal review or approval. [AI open source policy](https://harlanzw.com/blog/ai-in-open-source). Human merge decision still required. Last updated: ${updatedAtLabel(at)}.

\`${formatProgressBar(100)}\`

Repair stopped: ${cleanLine(review.reason)}

${findings.join('\n')}`
  }
  return `${AUTOMATED_REVIEW_MARKER}
<!-- reviewed-sha: ${review.headSha} -->
### 🤖 STOPPED

> [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) posted this automated review. It is not Harlan's personal review or approval. [AI open source policy](https://harlanzw.com/blog/ai-in-open-source). Human merge decision still required. Last updated: ${updatedAtLabel(at)}.

\`${formatProgressBar(100)}\`

The automated review stopped before it finished. Reason: ${cleanLine(review.reason)}

Push a new commit or ask for a review rerun to start a new review.`
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
): Promise<Array<Result<StoppedReviewOutcome, string>>> {
  const mappings = new Map(options.repositories.map(mapping => [mapping.github.toLowerCase(), mapping]))
  const reviews = options.store.listStoppedReviews()
  return Promise.all(reviews.map(async (review): Promise<Result<StoppedReviewOutcome, string>> => {
    const mapping = mappings.get(review.repository.toLowerCase())
    if (mapping === undefined)
      return err(`${review.repository}: the repository is no longer configured.`)
    const current = await options.github.getPullRequestReviewSnapshot(mapping, review.pullRequestNumber, signal)
    if (current._tag === 'Err')
      return err(`${review.repository}#${review.pullRequestNumber}: ${current.error}`)
    if (current.value.pullRequest.state === 'open' && current.value.pullRequest.headSha !== review.headSha)
      return ok({ _tag: 'Superseded', repository: review.repository, pullRequestNumber: review.pullRequestNumber })

    const at = options.now().toISOString()
    const disposition: StoppedReviewDisposition = current.value.pullRequest.state === 'open'
      ? { _tag: 'Stopped' }
      : current.value.pullRequest.mergedAt === null
        ? { _tag: 'Closed' }
        : { _tag: 'Merged' }
    const body = stoppedReviewComment(review, at, disposition)
    const edited = await options.github.editReviewStatus(mapping, review.pullRequestNumber, review.commentId, review.publishedBody, body, signal)
    if (edited._tag === 'Err')
      return err(`${review.repository}#${review.pullRequestNumber}: ${edited.error}`)
    if (edited.value._tag === 'Missing')
      return ok({ _tag: 'CommentGone', repository: review.repository, pullRequestNumber: review.pullRequestNumber })
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
  }))
}
