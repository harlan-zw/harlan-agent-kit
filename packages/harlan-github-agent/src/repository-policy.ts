import type { GitHubPullRequestItem, RepositoryMapping } from './types.ts'

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
 * True when a follow-up tick may file an issue here.
 *
 * Filing writes an issue, never a branch, and needs no trusted pull request
 * author. It keeps the gate every follow-up control had before fix before
 * merge, so no repository gains controls it never offered.
 */
export function canFileFollowUpIssue(mapping: RepositoryMapping): boolean {
  return canRepairBaseline(mapping)
}

/** A finding checkbox grants scoped Repair on a trusted author's open branch. */
export function canRepairSelectedFindingOnHead(mapping: RepositoryMapping, pullRequest: GitHubPullRequestItem): boolean {
  return pullRequest.state === 'open' && !pullRequest.draft && mapping.pullRequestReview
    && mapping.writablePullRequestAuthors.some(author => author.toLowerCase() === pullRequest.author.toLowerCase())
    && canRepairPullRequestHead(mapping, pullRequest)
}

/**
 * The first rule that stops the controller resolving a merge conflict on one branch.
 *
 * Each rule has its own tag, so a stopped conflict names the rule and one step.
 * A single "cannot write" reason left Harlan to guess which rule applied.
 */
export type ConflictWriteBoundary
  = | { _tag: 'ConflictResolutionOff' }
    | { _tag: 'RepositoryNotWritable' }
    | { _tag: 'DefaultBranchHead' }
    | { _tag: 'MaintainerEditsOff' }
    | { _tag: 'HeadPrefixNotWritable', prefixes: string[] }
    | { _tag: 'AuthorNotWritable' }

function isForkHead(mapping: RepositoryMapping, pullRequest: GitHubPullRequestItem): boolean {
  return pullRequest.headRepository.toLowerCase() !== mapping.github.toLowerCase()
}

/** Null when conflict planning and publication have branch and author authority. */
export function conflictWriteBoundary(mapping: RepositoryMapping, pullRequest: GitHubPullRequestItem): ConflictWriteBoundary | null {
  if (!mapping.conflictResolution)
    return { _tag: 'ConflictResolutionOff' }
  if (!canWritePullRequestHead(mapping))
    return { _tag: 'RepositoryNotWritable' }
  if (pullRequest.headRef === mapping.defaultBranch)
    return { _tag: 'DefaultBranchHead' }
  const fork = isForkHead(mapping, pullRequest)
  if (fork && pullRequest.maintainerCanModify !== true)
    return { _tag: 'MaintainerEditsOff' }
  if (!mapping.writablePullRequestHeadPrefixes.some(prefix => pullRequest.headRef.startsWith(prefix)))
    return { _tag: 'HeadPrefixNotWritable', prefixes: mapping.writablePullRequestHeadPrefixes }
  if (!fork && !mapping.writablePullRequestAuthors.some(author => author.toLowerCase() === pullRequest.author.toLowerCase()))
    return { _tag: 'AuthorNotWritable' }
  return null
}

/** Conflict planning and publication require the same branch and author authority. */
export function canResolveConflictPullRequestHead(mapping: RepositoryMapping, pullRequest: GitHubPullRequestItem): boolean {
  return conflictWriteBoundary(mapping, pullRequest) === null
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
 * True when the controller may offer and publish package releases here.
 *
 * An owned repository needs a release policy. A maintained repository also
 * needs the explicit `credential: user` opt in, so every release write there
 * uses Harlan's own token and never the App.
 */
export function canReleasePackages(mapping: RepositoryMapping): boolean {
  if (!mapping.enabled || !mapping.pullRequestReview || mapping.release === undefined)
    return false
  if (mapping.ownership === 'owned')
    return true
  return mapping.ownership === 'maintained' && mapping.release.credential._tag === 'User'
}

/** One pull request comment command, tagged as `parsePullRequestCommand` tags it. */
export type PullRequestCommand = 'Change' | 'Rerun' | 'Stop'

/**
 * The comment commands the controller accepts on this pull request.
 *
 * Mirrors the command sync and the store, so the canonical comment never offers
 * a command they refuse. An author needs both `allowedAuthors` and a writable
 * author entry. A change also needs the owner of an owned repository and a
 * writable head branch. A stop needs a repository that is not external, as the
 * Stop Review checkbox does. Mergeability, Approval, Dismissal, and a stopped
 * Review stay with the store, which reads them from the journal.
 */
export function acceptedPullRequestCommands(
  mapping: RepositoryMapping,
  pullRequest: GitHubPullRequestItem,
  allowedAuthors: readonly string[],
): PullRequestCommand[] {
  if (!mapping.enabled || !mapping.pullRequestReview || pullRequest.state !== 'open' || pullRequest.draft)
    return []
  const allowed = new Set(allowedAuthors.map(author => author.toLowerCase()))
  const authors = mapping.writablePullRequestAuthors.map(author => author.toLowerCase()).filter(author => allowed.has(author))
  if (authors.length === 0)
    return []
  const owner = mapping.github.split('/')[0]!.toLowerCase()
  const change = mapping.ownership === 'owned' && authors.includes(owner) && canRepairPullRequestHead(mapping, pullRequest)
  return [
    ...(change ? ['Change' as const] : []),
    'Rerun',
    ...(mapping.ownership === 'external' ? [] : ['Stop' as const]),
  ]
}
