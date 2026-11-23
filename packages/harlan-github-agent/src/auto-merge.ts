import type { PullRequestFile } from './merge-risk.ts'
import type { GitHubPullRequestItem, RepositoryMapping, ReviewRun } from './types.ts'
import { protectedPathChanged } from './merge-risk.ts'

/**
 * Auto merge lets the controller merge one pull request without a per-pull-request
 * instruction. Only a user with write access can label a pull request, so the label
 * cannot come from an outside contributor. Without it, the pull request waits for Harlan.
 *
 * The label never changes whether a pull request is reviewed.
 */
export const AUTO_MERGE_LABEL = 'harlan-agent-auto-merge'

export const AUTO_MERGE_LABEL_SPEC = {
  name: AUTO_MERGE_LABEL,
  color: '0e8a16',
  description: 'Lets harlan-github-agent merge this after a READY review',
}

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

/**
 * The changed files Auto merge read for one head commit.
 *
 * `Unavailable` covers every failed read. Auto merge holds on it, because a
 * Protected path it cannot see must never merge.
 */
export type HeadChangedFiles
  = | { _tag: 'Read', headSha: string, files: readonly PullRequestFile[] }
    | { _tag: 'Unavailable', reason: string }

/**
 * GitHub lists at most this many files for one pull request.
 *
 * A list this long may be cut, and a Protected path past the end would merge.
 */
export const PULL_REQUEST_FILES_LIMIT = 3000

export interface AutoMergeInput {
  attempts: ReviewRun[]
  /** Required in every scope: no label and no Merge risk verdict skips the Protected path check. */
  changedFiles: HeadChangedFiles
  policy: AutoMergePolicy
  pullRequest: GitHubPullRequestItem
  repository: RepositoryMapping
}

/** Why the changed files keep this head from Auto merge, or null when they do not. */
function changedFilesHold(changedFiles: HeadChangedFiles, headSha: string): string | null {
  if (changedFiles._tag === 'Unavailable')
    return `The changed files of the head commit are unavailable: ${changedFiles.reason}`
  if (changedFiles.headSha !== headSha)
    return 'The changed files were read for another head commit.'
  if (changedFiles.files.length === 0)
    return 'GitHub lists no changed file for the head commit.'
  if (changedFiles.files.length >= PULL_REQUEST_FILES_LIMIT)
    return `GitHub lists at most ${PULL_REQUEST_FILES_LIMIT} changed files, so the list may be incomplete.`
  const path = protectedPathChanged(changedFiles.files)
  return path === null ? null : `${path} is a Protected path. Auto merge never merges it.`
}

/** The newest Review run for this exact head commit and base branch. */
export function latestReviewForHead(attempts: ReviewRun[], headSha: string, baseRef: string): ReviewRun | undefined {
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
  const { attempts, changedFiles, policy, pullRequest, repository } = input
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
  // Before any scope rule, so neither the label nor a Merge risk verdict can
  // reach around it.
  const filesHold = changedFilesHold(changedFiles, pullRequest.headSha)
  if (filesHold !== null)
    return { _tag: 'Hold', reason: filesHold }
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
      : scope._tag === 'Labelled' && scope.minimumConfidence !== null
        ? scope.minimumConfidence
        : policy.minimumConfidence
  const confidence = attempt.outcome.confidence
  if (confidence === undefined || confidence < minimumConfidence)
    return { _tag: 'Hold', reason: `Review confidence is below ${minimumConfidence}.` }

  return { _tag: 'Merge', headSha: pullRequest.headSha, method: policy.method, reviewRunId: attempt.id }
}
