import type { GitHubAgentSource } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { JournalStore, ReviewGateRefresh } from './store.ts'
import type { RepositoryMapping, ReviewOutcomeName } from './types.ts'
import { refreshControllerGates, reviewOutcome, terminalComment } from './item-agent.ts'
import { err, ok } from './result.ts'

export type ReviewGateRefreshOutcome
  = | { _tag: 'PublicationQueued', repository: string, pullRequestNumber: number, outcome: ReviewOutcomeName }
    | { _tag: 'Unchanged', repository: string, pullRequestNumber: number, outcome: ReviewOutcomeName, reason: string }
    | { _tag: 'Superseded', repository: string, pullRequestNumber: number }

export interface ReviewGateSweepOptions {
  github: Pick<GitHubAgentSource, 'editReviewStatus' | 'getPullRequestReviewSnapshot' | 'stampAgentLabel'>
  now: () => Date
  repositories: RepositoryMapping[]
  store: Pick<JournalStore, 'listReviewGateRefreshes' | 'stageReviewGateStatus'>
}

/**
 * Refreshes the moving gates around one completed Agent report.
 *
 * Mergeability and CI can change without a new head commit. This sweep reads
 * both again. It starts no Agent because the report still covers this diff.
 */
export async function refreshReviewGates(
  options: ReviewGateSweepOptions,
  signal: AbortSignal,
): Promise<Array<Result<ReviewGateRefreshOutcome, string>>> {
  const mappings = new Map(options.repositories.map(mapping => [mapping.github.toLowerCase(), mapping]))
  const reviews = options.store.listReviewGateRefreshes()

  const settle = async (review: ReviewGateRefresh): Promise<Result<ReviewGateRefreshOutcome, string>> => {
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

    const { gates, reportedChecks } = refreshControllerGates(review.gates, live.value, mapping)
    const outcome = reviewOutcome(gates)
    const confidence = outcome === 'READY' ? review.confidence : undefined
    const body = terminalComment(review.headSha, live.value.pullRequest.baseSha, gates, review.findings, confidence, reportedChecks)
    const gatesChanged = JSON.stringify(gates) !== JSON.stringify(review.gates)
    if (!gatesChanged) {
      const confirmed = await options.github.editReviewStatus(
        mapping,
        review.pullRequestNumber,
        review.commentId,
        review.publishedBody,
        review.publishedBody,
        signal,
      )
      if (confirmed._tag === 'Err')
        return err(`${review.repository}#${review.pullRequestNumber}: ${confirmed.error}`)
      if (confirmed.value._tag !== 'Edited') {
        const at = options.now().toISOString()
        const staged = options.store.stageReviewGateStatus({
          reviewRunId: review.reviewRunId,
          repository: review.repository,
          pullRequestNumber: review.pullRequestNumber,
          revisionId: review.revisionId,
          expectedHeadSha: review.headSha,
          gates,
          body,
          desiredOutcome: outcome,
          reconciliationId: `${confirmed.value._tag}:${review.commentId}:${at}`,
          at,
        })
        if (staged._tag === 'Rejected')
          return err(`${review.repository}#${review.pullRequestNumber}: ${staged.reason}`)
        return ok({ _tag: 'PublicationQueued', repository: review.repository, pullRequestNumber: review.pullRequestNumber, outcome })
      }
      const stamped = await options.github.stampAgentLabel(mapping, review.pullRequestNumber, outcome, signal)
      if (stamped._tag === 'Err')
        return err(`${review.repository}#${review.pullRequestNumber}: ${stamped.error}`)
      const unsettled = [gates.merge, gates.ci].find(gate => gate._tag !== 'Passed')
      return ok({
        _tag: 'Unchanged',
        repository: review.repository,
        pullRequestNumber: review.pullRequestNumber,
        outcome,
        reason: unsettled === undefined ? 'The controller gates did not change.' : unsettled.reason,
      })
    }

    const at = options.now().toISOString()
    const staged = options.store.stageReviewGateStatus({
      reviewRunId: review.reviewRunId,
      repository: review.repository,
      pullRequestNumber: review.pullRequestNumber,
      revisionId: review.revisionId,
      expectedHeadSha: review.headSha,
      gates,
      body,
      desiredOutcome: outcome,
      at,
    })
    if (staged._tag === 'Rejected')
      return err(`${review.repository}#${review.pullRequestNumber}: ${staged.reason}`)
    return ok({ _tag: 'PublicationQueued', repository: review.repository, pullRequestNumber: review.pullRequestNumber, outcome })
  }

  const results: Array<Result<ReviewGateRefreshOutcome, string>> = []
  for (const review of reviews)
    results.push(await settle(review))
  return results
}
