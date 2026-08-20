import type { GitHubAgentSource } from './github-agent-source.ts'
import type { RepositoryMapping } from './types.ts'
import { err } from './result.ts'

export interface GitHubWriteGateOptions {
  /** True when a person has trusted the controller to write to this repository. */
  mayWrite: (github: string) => boolean
  /** Called once for each refused write, so a person sees why nothing happened. */
  onRefused: (github: string) => void
  source: GitHubAgentSource
}

/**
 * The reason a quarantined repository refuses every write.
 *
 * One wording, so the failure taxonomy and the dashboard both recognise it.
 */
export function repositoryQuarantineReason(github: string): string {
  return `The controller has never been trusted to write to ${github}. Enable writes for it first.`
}

/**
 * Refuses every GitHub write to a repository nobody has enabled writes for.
 *
 * Discovery decides what the controller can see, and until now nothing decided
 * what it could write to. Widening `allowed_owners` by one organization put
 * four repositories in reach, and the controller published ninety eight
 * automated comments across them under Harlan's own account within the hour.
 *
 * The gate sits here, around the source itself, rather than at the command
 * tables. Two callers already write straight through this interface without
 * staging a command, which is why the journal held no record of those ninety
 * eight. Anything that can write has to come through this object, so this is
 * the only place that can refuse all of it, including callers not yet written.
 */
export function createGitHubWriteGate(options: GitHubWriteGateOptions): GitHubAgentSource {
  const refuse = (repository: RepositoryMapping) => {
    options.onRefused(repository.github)
    return Promise.resolve(err(repositoryQuarantineReason(repository.github)))
  }
  const source = options.source
  return {
    ...source,
    consumeApprovalLabel: (repository, subjectKind, itemNumber, label, signal) => options.mayWrite(repository.github)
      ? source.consumeApprovalLabel(repository, subjectKind, itemNumber, label, signal)
      : refuse(repository),
    ensureApprovalLabel: (repository, label, signal) => options.mayWrite(repository.github)
      ? source.ensureApprovalLabel(repository, label, signal)
      : refuse(repository),
    upsertIssueTriageComment: (repository, issueNumber, commentId, body, signal) => options.mayWrite(repository.github)
      ? source.upsertIssueTriageComment(repository, issueNumber, commentId, body, signal)
      : refuse(repository),
    upsertReviewStatus: (repository, pullRequestNumber, commentId, body, replacePriorReview, signal) => options.mayWrite(repository.github)
      ? source.upsertReviewStatus(repository, pullRequestNumber, commentId, body, replacePriorReview, signal)
      : refuse(repository),
  }
}
