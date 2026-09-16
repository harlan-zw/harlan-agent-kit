import type { GitHubPullRequestItem, RepositoryMapping, ReviewRun } from './types.ts'

/**
 * Auto merge lets the controller merge one pull request without a per-pull-request
 * instruction. Only a user with write access can label a pull request, so the label
 * cannot come from an outside contributor. Without it, the pull request waits for Harlan.
 *
 * The label never changes whether a pull request is reviewed.
 */
export const AUTO_MERGE_LABEL = 'harlan-agent-auto-merge'

export function hasAutoMergeLabel(labels: string[]): boolean {
  return labels.some(label => label.toLowerCase() === AUTO_MERGE_LABEL)
}

/**
 * Whether Auto merge should look at this pull request at all.
 *
 * A repository scoped to every pull request needs no label. Everywhere else
 * the label is the instruction.
 */
export function autoMergeCandidate(repository: RepositoryMapping, pullRequest: GitHubPullRequestItem): boolean {
  return pullRequest.autoMerge || repository.autoMerge._tag === 'Every' || repository.autoMerge._tag === 'Contained'
}

export type AutoMergeMethod = 'merge' | 'rebase' | 'squash'

export type AutoMergePolicy
  = | { _tag: 'Disabled' }
    | { _tag: 'Enabled', minimumConfidence: number, method: AutoMergeMethod }

export type AutoMergeDecision
  = | { _tag: 'Merge', headSha: string, method: AutoMergeMethod, reviewRunId: string }
    | { _tag: 'Hold', reason: string }

export interface AutoMergeInput {
  attempts: ReviewRun[]
  policy: AutoMergePolicy
  pullRequest: GitHubPullRequestItem
  repository: RepositoryMapping
}

function latestReviewForHead(attempts: ReviewRun[], headSha: string, baseRef: string): ReviewRun | undefined {
  return attempts
    .filter(attempt => attempt.headSha === headSha && attempt.baseRef === baseRef)
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0]
}

/** A gate Publication is usable only while the store confirms its current authority. */
export function hasCurrentPublishedReadyReview(attempts: ReviewRun[], headSha: string, baseRef: string): boolean {
  const attempt = latestReviewForHead(attempts, headSha, baseRef)
  if (attempt?.outcome._tag !== 'Ready' || attempt.gatePublication._tag !== 'Published')
    return false
  const publicationId = attempt.gatePublication.publicationId
  return attempt.publications.some(publication => publication.id === publicationId && publication.result._tag === 'Published')
}

/** Every condition is rechecked against GitHub immediately before the merge. */
export function autoMergeDecision(input: AutoMergeInput): AutoMergeDecision {
  const { attempts, policy, pullRequest, repository } = input
  if (policy._tag === 'Disabled')
    return { _tag: 'Hold', reason: 'Auto merge is disabled.' }
  if (!autoMergeCandidate(repository, pullRequest))
    return { _tag: 'Hold', reason: `The pull request has no ${AUTO_MERGE_LABEL} label.` }
  if (!repository.enabled)
    return { _tag: 'Hold', reason: 'The repository is disabled.' }
  if (repository.ownership !== 'owned')
    return { _tag: 'Hold', reason: 'Auto merge covers owned repositories only.' }
  if (!repository.writablePullRequestAuthors.some(author => author.toLowerCase() === pullRequest.author.toLowerCase()))
    return { _tag: 'Hold', reason: 'The pull request author is not a trusted author.' }
  if (pullRequest.state !== 'open' || pullRequest.mergedAt !== null)
    return { _tag: 'Hold', reason: 'The pull request is not open.' }
  if (pullRequest.draft)
    return { _tag: 'Hold', reason: 'The pull request is a draft.' }
  if (pullRequest.baseRef !== repository.defaultBranch)
    return { _tag: 'Hold', reason: 'The pull request must target the default branch before Auto merge.' }
  if (pullRequest.mergeState !== 'clean')
    return { _tag: 'Hold', reason: 'GitHub does not report the pull request as mergeable.' }

  const attempt = latestReviewForHead(attempts, pullRequest.headSha, pullRequest.baseRef)
  if (attempt === undefined || attempt.outcome._tag !== 'Ready')
    return { _tag: 'Hold', reason: 'The current head commit has no READY review.' }
  if (!hasCurrentPublishedReadyReview(attempts, pullRequest.headSha, pullRequest.baseRef)) {
    return { _tag: 'Hold', reason: 'The current head commit has no published READY review.' }
  }
  if (attempt.findings.some(finding => finding._tag === 'Open'))
    return { _tag: 'Hold', reason: 'The review left an open finding.' }
  const scope = repository.autoMerge
  // A pull request qualifies through Merge risk or through the label. Which one
  // it used decides which confidence bar it must clear, because the repository's
  // Contained bar may sit below the service-wide one a label has always needed.
  let qualifiedByRisk = false
  if (scope._tag === 'Contained') {
    // The verdict is read off this exact Review run, so a stale one from an
    // earlier head can never merge a pull request that has since grown.
    const risk = attempt.mergeRisk?.combined
    if (risk === undefined)
      return { _tag: 'Hold', reason: 'The current review recorded no Merge risk.' }
    if (risk._tag === 'Sensitive' && !scope.labelOverridesRisk)
      return { _tag: 'Hold', reason: `Merge risk is Sensitive: ${risk.reason}` }
    if (risk._tag !== 'Contained' && !pullRequest.autoMerge)
      return { _tag: 'Hold', reason: `Merge risk is ${risk._tag}: ${risk.reason}` }
    // The label is the qualification whenever it is present, so only an
    // unlabelled pull request ever clears the repository's Merge risk bar.
    qualifiedByRisk = risk._tag === 'Contained' && !pullRequest.autoMerge
  }

  const minimumConfidence = scope._tag === 'Every'
    ? scope.minimumConfidence
    : scope._tag === 'Contained' && qualifiedByRisk
      ? scope.minimumConfidence
      : policy.minimumConfidence
  const confidence = attempt.outcome.confidence
  if (confidence === undefined || confidence < minimumConfidence)
    return { _tag: 'Hold', reason: `Review confidence is below ${minimumConfidence}.` }

  return { _tag: 'Merge', headSha: pullRequest.headSha, method: policy.method, reviewRunId: attempt.id }
}
