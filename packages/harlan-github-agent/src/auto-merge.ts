import type { ChangedLines } from './finding-scope.ts'
import type { Result } from './result.ts'
import type { GitHubPullRequestItem, RepositoryMapping, ReviewRun } from './types.ts'
import type { ConflictMergeWithFailingChecks } from './worktree.ts'
import { isProtectedPath } from './pull-request-triage.ts'

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

/**
 * Each reason Auto merge holds a head, with one fixed sentence.
 *
 * A Hold's own reason can carry a path, a GitHub error, or Review prose. The
 * hold record and the weekly trial report keep only the name, so no private
 * detail leaves the Service.
 */
export const AUTO_MERGE_HOLD_CAUSES = {
  Disabled: 'Auto merge is disabled.',
  NoLabel: `The pull request has no ${AUTO_MERGE_LABEL} label.`,
  RepositoryDisabled: 'The repository is disabled.',
  NotOwned: 'The repository is not owned.',
  UntrustedAuthor: 'The author is not a trusted author.',
  NotOpen: 'The pull request is not open.',
  Draft: 'The pull request is a draft.',
  NotDefaultBranch: 'The pull request does not target the default branch.',
  NotMergeable: 'GitHub does not report it mergeable.',
  NoReadyReview: 'The head has no READY review.',
  NoPublishedReadyReview: 'The READY review is not published.',
  OpenFinding: 'The review left an open finding.',
  ChangedFilesUnavailable: 'Its changed files are unavailable.',
  ChangedFilesStale: 'Its changed files were compared for other commits.',
  ProtectedPath: 'It changes a Protected path.',
  NoMergeRisk: 'The review recorded no Merge risk.',
  SensitiveMergeRisk: 'Merge risk is Sensitive.',
  MergeRiskNotContained: 'Merge risk is not Contained, and it has no label.',
  NoConfidence: 'The review reported no confidence.',
  BelowConfidence: 'Review confidence is below the bar.',
  MergedWithFailingChecks: 'A conflict resolution pushed this head with checks failing.',
} as const

export type AutoMergeHoldCause = keyof typeof AUTO_MERGE_HOLD_CAUSES

export function isAutoMergeHoldCause(value: string): value is AutoMergeHoldCause {
  return Object.hasOwn(AUTO_MERGE_HOLD_CAUSES, value)
}

export type AutoMergeDecision
  = | { _tag: 'Merge', headSha: string, method: AutoMergeMethod, reviewRunId: string }
    | { _tag: 'Hold', cause: AutoMergeHoldCause, reason: string }

function hold(cause: AutoMergeHoldCause, reason: string): Extract<AutoMergeDecision, { _tag: 'Hold' }> {
  return { _tag: 'Hold', cause, reason }
}

/** One hold of one candidate head, as the Service records it. */
export interface AutoMergeHoldRecord {
  repository: string
  pullRequestNumber: number
  headSha: string
  cause: AutoMergeHoldCause
  /** True when the head has no label and the label alone would merge it. */
  heldOnlyByLabel: boolean
  at: string
}

/**
 * The changed paths of one exact comparison, `baseSha...headSha`.
 *
 * GitHub compared the two commits by SHA, so the reading belongs to them and
 * to no other head or base. `paths` holds each changed path and the old path
 * of each rename. `Unavailable` covers a failed read and a list GitHub may
 * have cut. Auto merge holds on it, because a Protected path it cannot see
 * must never merge.
 */
export type HeadChangedFiles
  = | { _tag: 'Read', baseSha: string, headSha: string, paths: readonly string[] }
    | { _tag: 'Unavailable', reason: string }

/** Stamps one exact comparison with the two commits it was asked for. */
export function comparedChangedFiles(commits: { baseSha: string, headSha: string }, comparison: Result<ChangedLines, string>): HeadChangedFiles {
  if (comparison._tag === 'Err')
    return { _tag: 'Unavailable', reason: comparison.error }
  if (!comparison.value.complete)
    return { _tag: 'Unavailable', reason: 'GitHub lists at most 300 files in one comparison, so some may be missing.' }
  const paths = comparison.value.files.flatMap(file => file._tag === 'Changed' && file.previousPath !== null ? [file.path, file.previousPath] : [file.path])
  return { _tag: 'Read', baseSha: commits.baseSha, headSha: commits.headSha, paths }
}

export interface AutoMergeInput {
  attempts: ReviewRun[]
  /** Required in every scope: no label and no Merge risk verdict skips the Protected path check. */
  changedFiles: HeadChangedFiles
  /**
   * The failing checks a conflict resolution recorded when it pushed the head commit, or null.
   *
   * GitHub CI may never run those commands, so a green head and a READY
   * Review cannot clear them. Only a later head commit does.
   */
  mergedWithFailingChecks: ConflictMergeWithFailingChecks | null
  policy: AutoMergePolicy
  pullRequest: GitHubPullRequestItem
  repository: RepositoryMapping
}

/**
 * Why the changed files keep this head from Auto merge, or null when they do not.
 *
 * The reading must name the exact head and base commits the decision is
 * about. A new base commit can change the merge base, so an older comparison
 * proves nothing about it.
 */
function changedFilesHold(changedFiles: HeadChangedFiles, pullRequest: GitHubPullRequestItem): AutoMergeDecision | null {
  if (changedFiles._tag === 'Unavailable')
    return hold('ChangedFilesUnavailable', `The changed files of the head commit are unavailable: ${changedFiles.reason}`)
  if (changedFiles.headSha !== pullRequest.headSha)
    return hold('ChangedFilesStale', 'The changed files were compared for another head commit.')
  if (changedFiles.baseSha !== pullRequest.baseSha)
    return hold('ChangedFilesStale', 'The changed files were compared against another base commit.')
  if (changedFiles.paths.length === 0)
    return hold('ChangedFilesUnavailable', 'GitHub lists no changed file for the head commit.')
  const path = changedFiles.paths.find(isProtectedPath)
  return path === undefined ? null : hold('ProtectedPath', `${path} is a Protected path. Auto merge never merges it.`)
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
  const { attempts, changedFiles, policy, pullRequest, repository } = input
  if (policy._tag === 'Disabled')
    return hold('Disabled', 'Auto merge is disabled.')
  if (!autoMergeCandidate(repository, pullRequest))
    return hold('NoLabel', `The pull request has no ${AUTO_MERGE_LABEL} label.`)
  if (!repository.enabled)
    return hold('RepositoryDisabled', 'The repository is disabled.')
  if (repository.ownership !== 'owned')
    return hold('NotOwned', 'Auto merge covers owned repositories only.')
  if (!repository.writablePullRequestAuthors.some(author => author.toLowerCase() === pullRequest.author.toLowerCase()))
    return hold('UntrustedAuthor', 'The pull request author is not a trusted author.')
  if (pullRequest.state !== 'open' || pullRequest.mergedAt !== null)
    return hold('NotOpen', 'The pull request is not open.')
  if (pullRequest.draft)
    return hold('Draft', 'The pull request is a draft.')
  if (pullRequest.baseRef !== repository.defaultBranch)
    return hold('NotDefaultBranch', 'The pull request must target the default branch before Auto merge.')
  if (pullRequest.mergeState !== 'clean')
    return hold('NotMergeable', 'GitHub does not report the pull request as mergeable.')

  const attempt = latestReviewForHead(attempts, pullRequest.headSha, pullRequest.baseRef)
  if (attempt === undefined || attempt.outcome._tag !== 'Ready')
    return hold('NoReadyReview', 'The current head commit has no READY review.')
  if (!hasCurrentPublishedReadyReview(attempts, pullRequest.headSha, pullRequest.baseRef)) {
    return hold('NoPublishedReadyReview', 'The current head commit has no published READY review.')
  }
  if (attempt.findings.some(finding => finding._tag === 'Open'))
    return hold('OpenFinding', 'The review left an open finding.')
  // Before any scope rule, so neither the label nor a Merge risk verdict can
  // merge a head whose local checks failed where CI may never look.
  if (input.mergedWithFailingChecks?.commitSha === pullRequest.headSha)
    return hold('MergedWithFailingChecks', AUTO_MERGE_HOLD_CAUSES.MergedWithFailingChecks)
  // Before any scope rule, so neither the label nor a Merge risk verdict can
  // reach around it.
  const filesHold = changedFilesHold(changedFiles, pullRequest)
  if (filesHold !== null)
    return filesHold
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
      return hold('NoMergeRisk', 'The current review recorded no Merge risk.')
    if (risk._tag === 'Sensitive' && !scope.labelOverridesRisk)
      return hold('SensitiveMergeRisk', `Merge risk is Sensitive: ${risk.reason}`)
    if (risk._tag !== 'Contained' && !pullRequest.autoMerge)
      return hold('MergeRiskNotContained', `Merge risk is ${risk._tag}: ${risk.reason}`)
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
  // Apart from the bar, so a lower bar never reads as releasing a head with no confidence at all.
  if (confidence === undefined)
    return hold('NoConfidence', 'The review reported no confidence.')
  if (confidence < minimumConfidence)
    return hold('BelowConfidence', `Review confidence is below ${minimumConfidence}.`)

  return { _tag: 'Merge', headSha: pullRequest.headSha, method: policy.method, reviewRunId: attempt.id }
}

/**
 * Whether the label alone keeps this head from Auto merge.
 *
 * Only an unlabelled head can answer yes, and only where the label changes the
 * decision: a `contained` scope whose Merge risk is not `Contained`, or whose
 * own confidence bar sits above the service-wide one.
 */
export function heldOnlyByLabel(input: AutoMergeInput): boolean {
  return !input.pullRequest.autoMerge
    && autoMergeDecision(input)._tag === 'Hold'
    && autoMergeDecision({ ...input, pullRequest: { ...input.pullRequest, autoMerge: true } })._tag === 'Merge'
}
