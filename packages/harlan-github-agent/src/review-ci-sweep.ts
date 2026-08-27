import type { GitHubAgentSource } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { CiPendingReview, JournalStore } from './store.ts'
import type { RepositoryMapping, ReviewOutcomeName } from './types.ts'
import { randomUUID } from 'node:crypto'
import { regateReviewCi, reviewOutcome, terminalComment } from './item-agent.ts'
import { err, ok } from './result.ts'

export type CiRegateOutcome
  = | { _tag: 'Republished', repository: string, pullRequestNumber: number, outcome: ReviewOutcomeName }
    | { _tag: 'StillWaiting', repository: string, pullRequestNumber: number, reason: string }
    | { _tag: 'CommentGone', repository: string, pullRequestNumber: number }
    | { _tag: 'Superseded', repository: string, pullRequestNumber: number }

export interface ReviewCiSweepOptions {
  github: Pick<GitHubAgentSource, 'editReviewStatus' | 'getPullRequestReviewSnapshot' | 'stampAgentLabel'>
  now: () => Date
  repositories: RepositoryMapping[]
  store: Pick<JournalStore, 'listCiPendingReviews' | 'recordReviewPublication' | 'supersedeReviewRun'>
}

/**
 * Settles a Review that only CI still holds back.
 *
 * A Review reads CI once, at the moment it finishes. Every other gate answers
 * for one head commit, but CI answers for one instant, and a base branch whose
 * deploy is still running turns green minutes later. Nothing in the pull
 * request payload moves when it does, so no new Revision appears and no new
 * Review runs. One healthy pull request read PENDING for three hours that way.
 *
 * The sweep reads CI again and restates the same verdict against the new
 * answer. It starts no agent, because the agent already answered for this head
 * commit and only the gate was unfinished.
 */
export async function publishResolvedCiReviews(
  options: ReviewCiSweepOptions,
  signal: AbortSignal,
): Promise<Array<Result<CiRegateOutcome, string>>> {
  const mappings = new Map(options.repositories.map(mapping => [mapping.github.toLowerCase(), mapping]))
  const reviews = options.store.listCiPendingReviews()

  const settle = async (review: CiPendingReview): Promise<Result<CiRegateOutcome, string>> => {
    const mapping = mappings.get(review.repository.toLowerCase())
    if (mapping === undefined)
      return err(`${review.repository}: the repository is no longer configured.`)
    const live = await options.github.getPullRequestReviewSnapshot(mapping, review.pullRequestNumber, signal)
    if (live._tag === 'Err')
      return err(`${review.repository}#${review.pullRequestNumber}: ${live.error}`)
    // A moved head commit gets its own Review. Restating this verdict against it
    // would answer for a diff nothing read.
    if (live.value.pullRequest.state !== 'open' || live.value.pullRequest.headSha !== review.headSha)
      return ok({ _tag: 'Superseded', repository: review.repository, pullRequestNumber: review.pullRequestNumber })

    // Mergeability answers for the live pull request, not for the head commit.
    // The stored merge gate froze hours ago, so a conflict that arrived while CI
    // ran would be restated as READY. GitHub has to report clean again first.
    if (live.value.pullRequest.mergeState !== 'clean')
      return ok({ _tag: 'StillWaiting', repository: review.repository, pullRequestNumber: review.pullRequestNumber, reason: 'GitHub does not report the pull request as mergeable.' })

    const { gates, reportedChecks } = regateReviewCi(review.gates, live.value, mapping)
    if (gates.ci._tag === 'Pending')
      return ok({ _tag: 'StillWaiting', repository: review.repository, pullRequestNumber: review.pullRequestNumber, reason: gates.ci.reason })

    const outcome = reviewOutcome(gates)
    const confidence = outcome === 'READY' ? review.confidence : undefined
    const body = terminalComment(review.headSha, gates, review.findings, confidence, reportedChecks)
    const at = options.now().toISOString()
    const reviewRunId = randomUUID()
    // The settlement supersedes the stored run before the comment is written,
    // so a failed edit still leaves auto merge and the dashboard reading the
    // settled verdict, and one agent turn keeps exactly one journal entry.
    const recorded = options.store.supersedeReviewRun({
      id: reviewRunId,
      repository: review.repository,
      pullRequestNumber: review.pullRequestNumber,
      revisionId: review.revisionId,
      headSha: review.headSha,
      provider: review.provider,
      sessionId: review.sessionId,
      model: review.model,
      agentVersion: review.agentVersion,
      skillDigest: review.skillDigest,
      startedAt: review.startedAt,
      completedAt: at,
      usage: review.usage,
      gates,
      ...(review.confidence === undefined ? {} : { confidence: review.confidence }),
      findings: review.findings,
      supersedesReviewRunId: review.reviewRunId,
    })
    if (recorded._tag === 'Rejected')
      return err(`${review.repository}#${review.pullRequestNumber}: the settled review could not be saved: ${recorded.reason._tag}.`)
    if (recorded._tag === 'Conflict')
      return err(`${review.repository}#${review.pullRequestNumber}: a different review result already uses this ID.`)

    const edited = await options.github.editReviewStatus(mapping, review.pullRequestNumber, review.commentId, review.publishedBody, body, signal)
    if (edited._tag === 'Err')
      return err(`${review.repository}#${review.pullRequestNumber}: ${edited.error}`)
    // A person who deleted the comment has answered it, and another writer who
    // took it owns it now. Neither gets overruled here.
    if (edited.value._tag === 'Missing')
      return ok({ _tag: 'CommentGone', repository: review.repository, pullRequestNumber: review.pullRequestNumber })
    if (edited.value._tag === 'Changed')
      return ok({ _tag: 'Superseded', repository: review.repository, pullRequestNumber: review.pullRequestNumber })

    const publication = options.store.recordReviewPublication({
      id: randomUUID(),
      reviewRunId,
      body,
      at,
      result: { _tag: 'Published', githubCommentId: edited.value.commentId, url: edited.value.url },
    })
    if (publication._tag === 'Rejected' || publication._tag === 'Conflict')
      return err(`${review.repository}#${review.pullRequestNumber}: the settled review comment could not be saved.`)
    const stamped = await options.github.stampAgentLabel(mapping, review.pullRequestNumber, outcome, signal)
    if (stamped._tag === 'Err')
      return err(`${review.repository}#${review.pullRequestNumber}: ${stamped.error}`)
    return ok({ _tag: 'Republished', repository: review.repository, pullRequestNumber: review.pullRequestNumber, outcome })
  }

  const results: Array<Result<CiRegateOutcome, string>> = []
  for (const review of reviews)
    results.push(await settle(review))
  return results
}
