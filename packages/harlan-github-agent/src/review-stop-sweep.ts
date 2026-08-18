import type { GitHubAgentSource } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { JournalStore, StoppedReview } from './store.ts'
import type { RepositoryMapping } from './types.ts'
import { formatProgressBar } from './agent-progress.ts'
import { err, ok } from './result.ts'
import { AUTOMATED_REVIEW_MARKER } from './review-comment.ts'
import { cleanLine, updatedAtLabel } from './text.ts'

export interface ReviewStopSweepOptions {
  github: Pick<GitHubAgentSource, 'getPullRequestReviewSnapshot' | 'upsertReviewStatus'>
  now: () => Date
  repositories: RepositoryMapping[]
  store: Pick<JournalStore, 'listStoppedReviews' | 'recordStoppedReviewStatus'>
}

export function stoppedReviewComment(review: StoppedReview, at: string): string {
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
 */
export async function publishStoppedReviews(
  options: ReviewStopSweepOptions,
  signal: AbortSignal,
): Promise<Array<Result<{ repository: string, pullRequestNumber: number }, string>>> {
  const mappings = new Map(options.repositories.map(mapping => [mapping.github.toLowerCase(), mapping]))
  const reviews = options.store.listStoppedReviews()
  return Promise.all(reviews.map(async (review): Promise<Result<{ repository: string, pullRequestNumber: number }, string>> => {
    const mapping = mappings.get(review.repository.toLowerCase())
    if (mapping === undefined)
      return err(`${review.repository}: the repository is no longer configured.`)
    const current = await options.github.getPullRequestReviewSnapshot(mapping, review.pullRequestNumber, signal)
    if (current._tag === 'Err')
      return err(`${review.repository}#${review.pullRequestNumber}: ${current.error}`)
    if (current.value.pullRequest.state !== 'open' || current.value.pullRequest.headSha !== review.headSha)
      return err(`${review.repository}#${review.pullRequestNumber}: the pull request changed before the final comment.`)

    const at = options.now().toISOString()
    const body = stoppedReviewComment(review, at)
    const published = await options.github.upsertReviewStatus(mapping, review.pullRequestNumber, review.commentId, body, false, signal)
    if (published._tag === 'Err')
      return err(`${review.repository}#${review.pullRequestNumber}: ${published.error}`)
    const recorded = options.store.recordStoppedReviewStatus({
      taskId: review.taskId,
      revisionId: review.revisionId,
      expectedHeadSha: review.headSha,
      body,
      at,
      commentId: published.value.commentId,
      url: published.value.url,
    })
    return recorded
      ? ok({ repository: review.repository, pullRequestNumber: review.pullRequestNumber })
      : err(`${review.repository}#${review.pullRequestNumber}: the final review comment could not be saved.`)
  }))
}
