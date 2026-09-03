import type { AgentTask, GitHubPullRequestItem, RepositoryMapping } from './types.ts'

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

/** True when one exact pull request branch is safe for a verified repair. */
export function canRepairPullRequestHead(mapping: RepositoryMapping, pullRequest: GitHubPullRequestItem): boolean {
  return canWritePullRequestHead(mapping)
    && (pullRequest.headRepository.toLowerCase() === mapping.github.toLowerCase() || pullRequest.maintainerCanModify === true)
    && mapping.writablePullRequestHeadPrefixes.some(prefix => pullRequest.headRef.startsWith(prefix))
    && pullRequest.headRef !== mapping.defaultBranch
}

/**
 * True when the controller may open a pull request for an issue here.
 *
 * A maintained repository must opt in. Authentication decides which trusted
 * controller credential publishes the branch and pull request.
 */
export function canWorkIssues(mapping: RepositoryMapping): boolean {
  return mapping.enabled
    && canPushBranch(mapping)
    && mapping.issueWork
    && mapping.writablePullRequestHeadPrefixes.length > 0
}

/**
 * True when a Task of this kind changes the repository, so its worktree gets
 * the repository prepare step before the Agent starts.
 *
 * Review and Issue triage read the tree and never run a check, so they skip
 * the step. Every kind that may publish a change runs it.
 */
export function preparesRepository(kind: AgentTask['kind'] | 'routine'): boolean {
  switch (kind) {
    case 'review_fix':
    case 'resolve_conflict':
    case 'baseline_repair':
    case 'issue_work':
      return true
    case 'adversarial_review':
    case 'issue_triage':
    case 'routine':
      return false
  }
}
