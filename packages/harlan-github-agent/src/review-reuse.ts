import type { GitHubAgentSource } from './github-agent-source.ts'
import type { ReviewWorker } from './item-agent.ts'
import type { Result } from './result.ts'
import type { ReviewStatusController } from './review-status-controller.ts'
import type { JournalStore, ReusableReviewRun } from './store.ts'
import type { ClaimedAdversarialReviewTask, GitHubPullRequestItem, ReviewResolution } from './types.ts'
import type { AgentWorkspaceManager, DiffIdentity } from './worktree.ts'
import { randomUUID } from 'node:crypto'
import { refreshControllerGates, reviewOutcome, terminalComment } from './item-agent.ts'
import { err, ok } from './result.ts'

export type ReviewReuseCandidate
  = | { _tag: 'Candidate', prior: ReusableReviewRun }
    | { _tag: 'Fresh', reason: string }

/**
 * Whether the newest Review report may answer for a new head at all.
 *
 * Pure. The diff identity is the expensive check, so it runs only after this
 * one passes. A Repair handoff belongs to the fresh Review path, so a report
 * with an open repairable finding never comes through here.
 */
export function reviewReuseCandidate(input: {
  prior: ReusableReviewRun | null
  /** The live pull request. A stored Revision carries no labels. */
  pullRequest: Pick<GitHubPullRequestItem, 'approvalLabels' | 'baseRef' | 'headSha'>
}): ReviewReuseCandidate {
  const { prior, pullRequest } = input
  if (prior === null)
    return { _tag: 'Fresh', reason: 'No completed Review exists for this pull request.' }
  if (prior.headSha === pullRequest.headSha)
    return { _tag: 'Fresh', reason: 'The current head commit already has an automated review.' }
  if (pullRequest.approvalLabels.includes('review'))
    return { _tag: 'Fresh', reason: 'The manual Review label asks for a fresh Review.' }
  if (prior.baseRef === undefined || pullRequest.baseRef === undefined || prior.baseRef !== pullRequest.baseRef)
    return { _tag: 'Fresh', reason: 'The base branch changed since the last Review.' }
  if (prior.findings.some(finding => finding._tag === 'Open' && finding.resolution !== 'Dismissal'))
    return { _tag: 'Fresh', reason: 'The last Review holds an open finding that Repair must answer.' }
  return { _tag: 'Candidate', prior }
}

/** Two heads carry the same change only when both diffs exist and share one patch id. */
export function sameDiff(prior: DiffIdentity, current: DiffIdentity): boolean {
  return prior._tag === 'Patch' && current._tag === 'Patch' && prior.patchId === current.patchId
}

export function reusedReviewLine(priorHeadSha: string): string {
  return `Reused the Review of \`${priorHeadSha.slice(0, 12)}\`. This head has the same diff against the base branch.`
}

export interface ReviewReuseOptions {
  github: Pick<GitHubAgentSource, 'getPullRequestReviewSnapshot'>
  now: () => Date
  /** The reuse path failed, so the fresh Review runs. Reported, never swallowed. */
  onReuseFailure?: (task: ClaimedAdversarialReviewTask, reason: string) => void
  onReused?: (task: ClaimedAdversarialReviewTask, priorHeadSha: string) => void
  status: Pick<ReviewStatusController, 'stageTerminal'>
  store: Pick<JournalStore, 'getReusableReviewRun' | 'reuseReviewRun'>
  workspaces: Pick<AgentWorkspaceManager, 'reviewDiffIdentity'>
}

export type ReviewReuseOutcome
  = | { _tag: 'Reused', evidence: string, resolution: ReviewResolution, priorHeadSha: string }
    | { _tag: 'Fresh', reason: string }

/**
 * Answers a new head with the newest Review report when its diff did not change.
 *
 * A merge of the base branch into the head, by a contributor or by Conflict
 * resolution, moves the head commit and leaves `git diff base...head` byte
 * for byte the same. A fresh Review of that head reads the same diff for ten
 * minutes and reaches the same verdict. This path stores the prior report
 * for the new head and publishes it through the ordinary terminal status.
 * Review stays read only: no Agent session starts.
 */
export async function reuseReview(
  options: ReviewReuseOptions,
  task: ClaimedAdversarialReviewTask,
  signal: AbortSignal,
): Promise<Result<ReviewReuseOutcome, string>> {
  if (!task.repositoryMapping.enabled || !task.repositoryMapping.pullRequestReview)
    return ok({ _tag: 'Fresh', reason: 'Repository policy does not authorize an automated review comment.' })
  // An explicit rerun request already took the newest report out of the store's answer.
  const prior = options.store.getReusableReviewRun(task.repository, task.pullRequestNumber)
  if (prior === null)
    return ok({ _tag: 'Fresh', reason: 'No completed Review exists for this pull request.' })
  const snapshot = await options.github.getPullRequestReviewSnapshot(task.repositoryMapping, task.pullRequestNumber, signal)
  if (snapshot._tag === 'Err')
    return snapshot
  const live = snapshot.value.pullRequest
  if (live.headSha !== task.pullRequest.headSha || live.state !== 'open')
    return ok({ _tag: 'Fresh', reason: 'The pull request changed before review started.' })
  const candidate = reviewReuseCandidate({ prior, pullRequest: live })
  if (candidate._tag === 'Fresh')
    return ok(candidate)

  const previous = await options.workspaces.reviewDiffIdentity(task, { baseSha: candidate.prior.baseSha, headSha: candidate.prior.headSha }, signal)
  if (previous._tag === 'Err')
    return previous
  const current = await options.workspaces.reviewDiffIdentity(task, { baseSha: live.baseSha, headSha: live.headSha }, signal)
  if (current._tag === 'Err')
    return current
  if (!sameDiff(previous.value, current.value))
    return ok({ _tag: 'Fresh', reason: 'The diff against the base branch changed since the last Review.' })

  const refreshed = refreshControllerGates(candidate.prior.gates, snapshot.value, task.repositoryMapping)
  const reviewRunId = randomUUID()
  const reason = reusedReviewLine(candidate.prior.headSha)
  const recorded = options.store.reuseReviewRun({
    id: reviewRunId,
    repository: task.repository,
    pullRequestNumber: task.pullRequestNumber,
    revisionId: task.revisionId,
    headSha: live.headSha,
    reusesReviewRunId: candidate.prior.reviewRunId,
    controllerGates: { merge: refreshed.gates.merge, ci: refreshed.gates.ci },
    reason,
    at: options.now().toISOString(),
  })
  if (recorded._tag === 'Rejected')
    return err(`The reused review could not be saved: ${recorded.reason._tag}.`)

  const gates = { ...refreshed.gates, review: candidate.prior.gates.review }
  const outcome = reviewOutcome(gates)
  const confidence = outcome === 'READY' ? candidate.prior.confidence : undefined
  const body = `${terminalComment(live.headSha, live.baseSha, gates, candidate.prior.findings, confidence, refreshed.reportedChecks)}\n\n${reason}`
  const staged = options.status.stageTerminal?.(task, body, outcome, reviewRunId) ?? err('The terminal Review status could not be staged.')
  if (staged._tag === 'Err')
    return staged
  return ok({
    _tag: 'Reused',
    evidence: reviewRunId,
    resolution: { _tag: 'Reviewed', reviewRunId },
    priorHeadSha: candidate.prior.headSha,
  })
}

/**
 * Wraps the Review worker so an unchanged diff never starts an Agent.
 *
 * A failure on the reuse path is reported and the fresh Review runs. The
 * expensive path is the safe one, so nothing here can make a head go unreviewed.
 */
export function createReviewReuseWorker(options: ReviewReuseOptions, inner: ReviewWorker): ReviewWorker {
  return {
    async run(task, signal) {
      const reused = await reuseReview(options, task, signal)
      if (reused._tag === 'Err') {
        if (signal.aborted)
          return reused
        options.onReuseFailure?.(task, reused.error)
        return inner.run(task, signal)
      }
      if (reused.value._tag === 'Fresh')
        return inner.run(task, signal)
      options.onReused?.(task, reused.value.priorHeadSha)
      return ok({ evidence: reused.value.evidence, resolution: reused.value.resolution })
    },
  }
}
