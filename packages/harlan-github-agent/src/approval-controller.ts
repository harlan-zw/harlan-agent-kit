import type { GitHubAgentSource } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { GitHubItem, GitHubPullRequestItem, RepositoryMapping } from './types.ts'
import { APPROVAL_LABELS } from './approval-labels.ts'
import { err, ok } from './result.ts'
import { AUTOMATED_REVIEW_MARKER, automatedDisclosure } from './review-comment.ts'

export interface ApprovalController {
  reconcile: (repository: RepositoryMapping, subject: GitHubItem, revisionId: string, signal: AbortSignal) => Promise<Result<void, string>>
}

export interface ApprovalControllerOptions {
  github: Pick<GitHubAgentSource, 'consumeApprovalLabel' | 'ensureApprovalLabel' | 'upsertReviewStatus'>
  now: () => Date
  store: Pick<JournalStore, 'approveIssueWork' | 'approvePullRequest' | 'getSelectionMode' | 'hasPullRequestApproval' | 'isIssueWorkApprovalReady' | 'recordApprovalPromptComment'>
}

function approvalPrompt(label: string, headSha: string): string {
  return `${AUTOMATED_REVIEW_MARKER}
<!-- reviewed-sha: ${headSha} -->
### 🤖 REVIEW PAUSED

${automatedDisclosure({ kind: 'status' })}

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
      const manualSelection = options.store.getSelectionMode() === 'manual'
      if (!repository.enabled || !repository.pullRequestReview || (trustedAuthor && !manualSelection))
        return ok(undefined)
      if (options.store.hasPullRequestApproval(repository.github, pullRequest.number, revisionId, 'review'))
        return ok(undefined)

      const label = APPROVAL_LABELS.review
      if (!pullRequest.approvalLabels.includes('review')) {
        // Manual Selection mode already offers Review and repair on the
        // dashboard, so the pull request itself needs no invitation. Saying it
        // out loud put one public comment on every open contributor pull
        // request the moment a repository became tracked, which is ninety eight
        // comments across four repositories in the case that taught us this.
        //
        // A trusted author never needed the comment either, and the label is a
        // repository-wide write, so both wait until there is something to say.
        if (manualSelection || trustedAuthor)
          return ok(undefined)
        const available = await options.github.ensureApprovalLabel(repository, label, signal)
        if (available._tag === 'Err')
          return available
        const body = approvalPrompt(label, pullRequest.headSha)
        const posted = await options.github.upsertReviewStatus(repository, pullRequest.number, null, body, false, signal)
        if (posted._tag === 'Err')
          return posted
        // This comment asks for a label and then has nothing left to say. It
        // went on asking after the label arrived, because no Task exists yet to
        // own it. Recording it hands it to the sweep that corrects stale
        // comments once the review joins the Queue.
        const recorded = options.store.recordApprovalPromptComment({
          repository: repository.github,
          pullRequestNumber: pullRequest.number,
          revisionId,
          commentId: posted.value.commentId,
          body,
          at: options.now().toISOString(),
        })
        if (!recorded)
          return err(`The REVIEW PAUSED prompt for ${repository.github}#${pullRequest.number} could not be recorded.`)
        return ok(undefined)
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
