import type { GitHubAgentSource } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { JournalStore, ReviewGateRefresh } from './store.ts'
import type { RepositoryMapping, ReviewOutcomeName } from './types.ts'
import { randomUUID } from 'node:crypto'
import { refreshControllerGates, reviewOutcome, terminalComment } from './item-agent.ts'
import { err, ok } from './result.ts'

export type ReviewGateRefreshOutcome
  = | { _tag: 'Republished', repository: string, pullRequestNumber: number, outcome: ReviewOutcomeName }
    | { _tag: 'Unchanged', repository: string, pullRequestNumber: number, outcome: ReviewOutcomeName, reason: string }
    | { _tag: 'CommentGone', repository: string, pullRequestNumber: number }
    | { _tag: 'Superseded', repository: string, pullRequestNumber: number }

export interface ReviewGateSweepOptions {
  github: Pick<GitHubAgentSource, 'editReviewStatus' | 'getPullRequestReviewSnapshot' | 'stampAgentLabel'>
  now: () => Date
  repositories: RepositoryMapping[]
  store: Pick<JournalStore, 'listReviewGateRefreshes' | 'recordReviewPublication' | 'supersedeReviewRun'>
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
    const movingGateChanged = ([gates.merge, gates.ci] as const).some((gate, index) => {
      const previous = index === 0 ? review.gates.merge : review.gates.ci
      const reason = gate._tag === 'Passed' ? '' : gate.reason
      const previousReason = previous._tag === 'Passed' ? '' : previous.reason
      return gate._tag !== previous._tag || reason !== previousReason
    })
    if (!movingGateChanged) {
      const unsettled = [gates.merge, gates.ci].find(gate => gate._tag !== 'Passed')
      return ok({
        _tag: 'Unchanged',
        repository: review.repository,
        pullRequestNumber: review.pullRequestNumber,
        outcome,
        reason: unsettled === undefined ? 'The controller gates did not change.' : unsettled.reason,
      })
    }

    const confidence = outcome === 'READY' ? review.confidence : undefined
    const body = terminalComment(review.headSha, gates, review.findings, confidence, reportedChecks)
    const at = options.now().toISOString()
    const reviewRunId = randomUUID()
    // Write GitHub first. The compare and swap is idempotent when this body
    // already landed, so a later journal failure can retry safely.
    const edited = await options.github.editReviewStatus(mapping, review.pullRequestNumber, review.commentId, review.publishedBody, body, signal)
    if (edited._tag === 'Err')
      return err(`${review.repository}#${review.pullRequestNumber}: ${edited.error}`)
    if (edited.value._tag === 'Missing' || edited.value._tag === 'Changed') {
      const abandoned = options.store.recordReviewPublication({
        id: randomUUID(),
        reviewRunId: review.reviewRunId,
        body,
        at,
        result: {
          _tag: 'Failed',
          reason: edited.value._tag === 'Missing'
            ? 'The automated Review comment was deleted.'
            : 'Another writer changed the automated Review comment.',
        },
      })
      if (abandoned._tag === 'Rejected' || abandoned._tag === 'Conflict')
        return err(`${review.repository}#${review.pullRequestNumber}: the abandoned gate refresh could not be saved.`)
    }
    if (edited.value._tag === 'Missing')
      return ok({ _tag: 'CommentGone', repository: review.repository, pullRequestNumber: review.pullRequestNumber })
    if (edited.value._tag === 'Changed')
      return ok({ _tag: 'Superseded', repository: review.repository, pullRequestNumber: review.pullRequestNumber })

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
      publication: {
        id: randomUUID(),
        body,
        at,
        result: { _tag: 'Published', githubCommentId: edited.value.commentId, url: edited.value.url },
      },
    })
    if (recorded._tag === 'Rejected')
      return err(`${review.repository}#${review.pullRequestNumber}: the settled review could not be saved: ${recorded.reason._tag}.`)
    if (recorded._tag === 'Conflict')
      return err(`${review.repository}#${review.pullRequestNumber}: a different review result already uses this ID.`)

    const stamped = await options.github.stampAgentLabel(mapping, review.pullRequestNumber, outcome, signal)
    if (stamped._tag === 'Err')
      return err(`${review.repository}#${review.pullRequestNumber}: ${stamped.error}`)
    return ok({ _tag: 'Republished', repository: review.repository, pullRequestNumber: review.pullRequestNumber, outcome })
  }

  const results: Array<Result<ReviewGateRefreshOutcome, string>> = []
  for (const review of reviews)
    results.push(await settle(review))
  return results
}
