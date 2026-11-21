import type { ConflictWriteBoundary } from './repository-policy.ts'
import type { GitHubPullRequestItem, RepositoryMapping } from './types.ts'
import { APPROVAL_LABELS } from './approval-labels.ts'
import { cleanLine } from './text.ts'

/**
 * Why the Service stopped before it published a merge for a merge conflict.
 *
 * Every stop names one exact step. The dashboard shows the reason verbatim, so
 * the wording lives here, beside the cause, and never in the dashboard.
 */
export type ConflictStop
  = | { _tag: 'Boundary', boundary: ConflictWriteBoundary }
    | { _tag: 'ApprovalRequired' }
    | { _tag: 'ProtectedHead' }
    /** The agent resolved the merge, a local check could not start, and the head is a contributor fork. */
    | { _tag: 'UncheckedFork', command: string, error: string }
    /** The agent found ambiguous intent, or a check failed that it could not fix inside the merge. */
    | { _tag: 'AgentBlocked', summary: string }

const prefixList = new Intl.ListFormat('en', { type: 'disjunction' })

function sentence(value: string): string {
  return `${cleanLine(value).replace(/[.\s]+$/, '')}.`
}

export function conflictStopReason(stop: ConflictStop, mapping: RepositoryMapping, pullRequest: GitHubPullRequestItem): string {
  const repository = mapping.github
  const base = pullRequest.baseRef ?? mapping.defaultBranch
  const fork = pullRequest.headRepository.toLowerCase() !== repository.toLowerCase()
  const head = fork ? `${pullRequest.headRepository}:${pullRequest.headRef}` : pullRequest.headRef
  const byHand = `Merge ${base} into ${head} by hand.`
  switch (stop._tag) {
    case 'ApprovalRequired':
      return `This contributor commit needs Approval before conflict resolution. Add the ${APPROVAL_LABELS.review} label to approve it.`
    case 'ProtectedHead':
      return `Branch ${head} is protected. Merge ${base} into it by hand.`
    case 'UncheckedFork':
      return `The agent resolved the merge conflict, but ${cleanLine(stop.command)} could not start: ${sentence(stop.error)} `
        + `The Service pushes an unchecked merge only to a branch in ${repository}. ${byHand}`
    case 'AgentBlocked':
      return `${sentence(stop.summary)} ${byHand}`
    case 'Boundary':
      switch (stop.boundary._tag) {
        case 'ConflictResolutionOff':
          return `Conflict resolution is off for ${repository}. Set conflict_resolution: true for ${repository} in the Service configuration, or merge ${base} into ${head} by hand.`
        case 'RepositoryNotWritable':
          return `The Service does not write to ${repository}. ${byHand}`
        case 'DefaultBranchHead':
          return `The pull request head is the default branch ${pullRequest.headRef}. ${byHand}`
        case 'MaintainerEditsOff':
          return `The contributor fork does not allow edits by maintainers. Ask ${pullRequest.author} to allow edits by maintainers on ${head}, or merge ${base} into it by hand.`
        case 'HeadPrefixNotWritable':
          return stop.boundary.prefixes.length === 0
            ? `${repository} has no writable branch prefix. ${byHand}`
            : `Branch ${head} does not start with ${prefixList.format(stop.boundary.prefixes)}. Merge ${base} into it by hand. Use a writable prefix for the next branch.`
        case 'AuthorNotWritable':
          return `${pullRequest.author} is not a writable pull request author for ${repository}. ${byHand}`
      }
  }
}
