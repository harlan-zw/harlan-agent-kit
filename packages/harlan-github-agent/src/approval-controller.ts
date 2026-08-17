import type { GitHubAgentSource } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { GitHubItem, GitHubPullRequestItem, RepositoryMapping } from './types.ts'
import { APPROVAL_LABELS } from './approval-labels.ts'
import { err, ok } from './result.ts'
import { AUTOMATED_REVIEW_MARKER } from './review-comment.ts'

export interface ApprovalController {
  reconcile: (repository: RepositoryMapping, subject: GitHubItem, revisionId: string, signal: AbortSignal) => Promise<Result<void, string>>
}

export interface ApprovalControllerOptions {
  github: Pick<GitHubAgentSource, 'consumeApprovalLabel' | 'ensureApprovalLabel' | 'upsertReviewStatus'>
  now: () => Date
  store: Pick<JournalStore, 'approveIssueWork' | 'approvePullRequest' | 'hasPullRequestApproval' | 'isIssueWorkApprovalReady'>
}

function approvalPrompt(label: string, headSha: string): string {
  return `${AUTOMATED_REVIEW_MARKER}
<!-- reviewed-sha: ${headSha} -->
### 🤖 REVIEW PAUSED

> Harlan GitHub Agent posted this automated comment. [AI open source policy](https://harlanzw.com/blog/ai-in-open-source).

This pull request is from an outside contributor. Add the \`${label}\` label to approve automated review and verified repairs for head commit \`${headSha.slice(0, 12)}\`.`
}

export function createApprovalController(options: ApprovalControllerOptions): ApprovalController {
  return {
    async reconcile(repository, subject, revisionId, signal) {
      const trustedAuthor = repository.writablePullRequestAuthors.some(author => author.toLowerCase() === subject.author.toLowerCase())
      if (subject.kind === 'issue') {
        if (!repository.enabled || !repository.issueWork || trustedAuthor || !options.store.isIssueWorkApprovalReady(repository.github, subject.number, revisionId))
          return ok(undefined)
        const label = APPROVAL_LABELS.review
        if (!subject.approvalLabels.includes('review'))
          return options.github.ensureApprovalLabel(repository, label, signal)
        const consumed = await options.github.consumeApprovalLabel(repository, 'issue', subject.number, label, signal)
        if (consumed._tag === 'Err')
          return consumed
        const approved = options.store.approveIssueWork({
          repository: repository.github,
          issueNumber: subject.number,
          revisionId,
          at: options.now().toISOString(),
        })
        if (approved._tag === 'Approved' || approved._tag === 'Duplicate' || approved.reason._tag === 'ApprovalNotRequired')
          return ok(undefined)
        return err(`Issue label Approval failed: ${approved.reason._tag}.`)
      }

      const pullRequest: GitHubPullRequestItem = subject
      if (!repository.enabled || !repository.pullRequestReview || trustedAuthor)
        return ok(undefined)
      if (options.store.hasPullRequestApproval(repository.github, pullRequest.number, revisionId, 'review'))
        return ok(undefined)

      const label = APPROVAL_LABELS.review
      if (!pullRequest.approvalLabels.includes('review')) {
        const available = await options.github.ensureApprovalLabel(repository, label, signal)
        if (available._tag === 'Err')
          return available
        return options.github.upsertReviewStatus(repository, pullRequest.number, null, approvalPrompt(label, pullRequest.headSha), false, signal).then(result => result._tag === 'Err' ? result : ok(undefined))
      }

      const approved = options.store.approvePullRequest({
        repository: repository.github,
        pullRequestNumber: pullRequest.number,
        revisionId,
        kind: 'review',
        at: options.now().toISOString(),
      })
      if (approved._tag === 'Approved' || approved._tag === 'Duplicate' || approved.reason._tag === 'ApprovalNotRequired')
        return ok(undefined)
      return err(`Review label Approval failed: ${approved.reason._tag}.`)
    },
  }
}
