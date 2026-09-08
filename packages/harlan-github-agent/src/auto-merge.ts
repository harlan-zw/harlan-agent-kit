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
  return pullRequest.autoMerge || repository.autoMerge._tag === 'Every'
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

function readyAttemptForHead(attempts: ReviewRun[], headSha: string): ReviewRun | undefined {
  return attempts
    .filter(attempt => attempt.headSha === headSha && attempt.outcome._tag === 'Ready')
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0]
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

  const attempt = readyAttemptForHead(attempts, pullRequest.headSha)
  if (attempt === undefined || attempt.outcome._tag !== 'Ready')
    return { _tag: 'Hold', reason: 'The current head commit has no READY review.' }
  if (!attempt.publications.some(publication => publication.result._tag === 'Published'))
    return { _tag: 'Hold', reason: 'The current head commit has no published READY review.' }
  if (attempt.findings.some(finding => finding._tag === 'Open'))
    return { _tag: 'Hold', reason: 'The review left an open finding.' }
  const minimumConfidence = repository.autoMerge._tag === 'Every' ? repository.autoMerge.minimumConfidence : policy.minimumConfidence
  const confidence = attempt.outcome.confidence
  if (confidence === undefined || confidence < minimumConfidence)
    return { _tag: 'Hold', reason: `Review confidence is below ${minimumConfidence}.` }

  return { _tag: 'Merge', headSha: pullRequest.headSha, method: policy.method, reviewRunId: attempt.id }
}
