import type { CiGateCause } from './ci-gate-pending.ts'
import type { GitHubAgentSource } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { JournalStore, ReviewGateRefresh } from './store.ts'
import type { RepositoryMapping, ReviewGates, ReviewOutcomeName } from './types.ts'
import { createHash } from 'node:crypto'
import { ciGatePendingMessage, readCiGate } from './ci-gate-pending.ts'
import { refreshControllerGates, reviewOutcome, terminalComment } from './item-agent.ts'
import { err, ok } from './result.ts'

export type ReviewGateRefreshOutcome
  = | { _tag: 'PublicationQueued', repository: string, pullRequestNumber: number, outcome: ReviewOutcomeName }
    | { _tag: 'Unchanged', repository: string, pullRequestNumber: number, outcome: ReviewOutcomeName, reason: string }
    | { _tag: 'Superseded', repository: string, pullRequestNumber: number }
    | { _tag: 'Retired', repository: string, pullRequestNumber: number, reason: string }

export interface ReviewGateSweepOptions {
  github: Pick<GitHubAgentSource, 'editReviewStatus' | 'getPullRequestReviewSnapshot' | 'stampAgentLabel'>
  now: () => Date
  repositories: RepositoryMapping[]
  store: Pick<JournalStore, 'listReviewGateRefreshes' | 'recordIncident' | 'recordReviewPublication' | 'resolveIncidents' | 'stageReviewGateStatus'>
}

/**
 * The operation every long PENDING CI Review gate reports under.
 *
 * The sweep resolves this operation alone, so a repository keeps its other
 * Incidents while its gates clear.
 */
const CI_GATE_OPERATION = 'ci_gate_pending'

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
  /** Every overdue CI Review gate message this pass raised, by repository. */
  const stalled = new Map<string, string[]>()
  /** Repositories whose live state this pass could not read. */
  const unread = new Set<string>()

  const settle = async (review: ReviewGateRefresh): Promise<Result<ReviewGateRefreshOutcome, string>> => {
    const mapping = mappings.get(review.repository.toLowerCase())
    if (mapping === undefined)
      return err(`${review.repository}: the repository is no longer configured.`)
    const live = await options.github.getPullRequestReviewSnapshot(mapping, review.pullRequestNumber, signal)
    if (live._tag === 'Err') {
      unread.add(review.repository.toLowerCase())
      return err(`${review.repository}#${review.pullRequestNumber}: ${live.error}`)
    }
    // A moved head commit gets its own Review. Restating this verdict against it
    // would answer for a diff nothing read.
    if (live.value.pullRequest.state !== 'open' || live.value.pullRequest.headSha !== review.headSha)
      return ok({ _tag: 'Superseded', repository: review.repository, pullRequestNumber: review.pullRequestNumber })

    const { gates, reportedChecks, ciCause } = refreshControllerGates(review.gates, live.value, mapping)
    const outcome = reviewOutcome(gates)
    const confidence = outcome === 'READY' ? review.confidence : undefined
    const body = terminalComment(review.headSha, live.value.pullRequest.baseSha, gates, review.findings, confidence, reportedChecks)
    const gatesChanged = JSON.stringify(gates) !== JSON.stringify(review.gates)
    if (!gatesChanged) {
      // Only a gate that did not move can be overdue. A gate that changed this
      // pass rewrites its own timestamp, so the old one would report a wait
      // that has just ended.
      reportOverdueCiGate(options, review, gates, ciCause, stalled)
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
      if (confirmed.value._tag === 'Foreign') {
        // The stored id names a comment another actor or pull request owns.
        // Staging a fresh status would send the publish loop back to the same
        // id every pass. A failed Publication with the reason takes this
        // Review out of the refresh list, and the next Review opens its own.
        const at = options.now().toISOString()
        const recorded = options.store.recordReviewPublication({
          id: createHash('sha256').update(`${review.reviewRunId}:foreign:${review.commentId}`).digest('hex'),
          reviewRunId: review.reviewRunId,
          body: review.publishedBody,
          at,
          result: { _tag: 'Failed', reason: confirmed.value.reason },
        })
        if (recorded._tag === 'Rejected')
          return err(`${review.repository}#${review.pullRequestNumber}: ${confirmed.value.reason} The refusal could not be recorded.`)
        return ok({ _tag: 'Retired', repository: review.repository, pullRequestNumber: review.pullRequestNumber, reason: confirmed.value.reason })
      }
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
  resolveSettledCiGates(options, signal, unread, stalled)
  return results
}

/**
 * Records one Incident for a CI Review gate that has read PENDING too long.
 *
 * The controller keeps waiting. It cancels nothing, re-runs nothing, and
 * queues nothing here, because every one of those decisions belongs to Harlan.
 * The Recovery therefore reads Action required, which is what the pane must
 * say about work that only a person moves.
 */
function reportOverdueCiGate(
  options: ReviewGateSweepOptions,
  review: ReviewGateRefresh,
  gates: ReviewGates,
  ciCause: CiGateCause,
  stalled: Map<string, string[]>,
): void {
  const reading = readCiGate({ gates, cause: ciCause, pendingSince: review.gatesUpdatedAt, now: options.now() })
  if (reading._tag !== 'Overdue')
    return
  const message = ciGatePendingMessage(review.repository, review.pullRequestNumber, reading)
  stalled.set(review.repository, [...(stalled.get(review.repository) ?? []), message])
  options.store.recordIncident({
    scope: { _tag: 'Repository', repository: review.repository },
    kind: 'ci_gate_pending',
    severity: 'warning',
    operation: CI_GATE_OPERATION,
    message,
    recovery: { _tag: 'ActionRequired' },
    at: options.now().toISOString(),
  })
}

/**
 * Closes the Incident of every gate that moved since the last pass.
 *
 * An Incident nobody clears trains the reader to skip the pane, so the sweep
 * that raises these also owns closing them. A repository whose snapshot could
 * not be read is skipped, because silence there says nothing about its gates.
 */
function resolveSettledCiGates(
  options: ReviewGateSweepOptions,
  signal: AbortSignal,
  unread: Set<string>,
  stalled: Map<string, string[]>,
): void {
  if (signal.aborted)
    return
  const at = options.now().toISOString()
  options.repositories
    .filter(mapping => !unread.has(mapping.github.toLowerCase()))
    .forEach(mapping => options.store.resolveIncidents(
      { _tag: 'Repository', repository: mapping.github },
      at,
      CI_GATE_OPERATION,
      stalled.get(mapping.github) ?? [],
    ))
}
