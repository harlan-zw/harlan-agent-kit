import type { RepositoryMapping } from './types.ts'

/**
 * What Harlan may do in a repository, named once instead of compared everywhere.
 *
 * Ownership is not a permission. It says how Harlan relates to the repository:
 * `owned` is his own, `maintained` is an organization repository he maintains,
 * `external` is one he only watches. Each capability below states which of those
 * relationships it needs, so a new capability never guesses.
 */

/**
 * True when the controller may push an agent branch to this repository.
 *
 * Harlan can push to every repository he owns or maintains. He cannot push to a
 * repository he only watches.
 */
export function canPushBranch(mapping: RepositoryMapping): boolean {
  return mapping.ownership !== 'external'
}

/**
 * True when the controller may open a Baseline repair pull request here.
 *
 * Baseline repair opens a pull request against the default branch. It never
 * pushes to the default branch itself, so maintaining the repository is enough.
 */
export function canRepairBaseline(mapping: RepositoryMapping): boolean {
  return mapping.enabled
    && canPushBranch(mapping)
    && mapping.pullRequestReview
    && mapping.writablePullRequestHeadPrefixes.length > 0
}

/**
 * True when the controller may write to a pull request head branch here.
 *
 * Approval and branch checks run before publication.
 */
export function canWritePullRequestHead(mapping: RepositoryMapping): boolean {
  return mapping.enabled
    && canPushBranch(mapping)
    && (mapping.pullRequestReview || mapping.conflictResolution)
}

/**
 * True when the controller may open a pull request for an issue here.
 *
 * Issue work writes new code nobody asked for yet, so it stays on repositories
 * Harlan owns outright.
 */
export function canWorkIssues(mapping: RepositoryMapping): boolean {
  return mapping.ownership === 'owned'
}
