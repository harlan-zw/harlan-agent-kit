import type { ReviewApprovalSource } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { RepositoryMapping } from './types.ts'
import { APPROVAL_LABELS } from './approval-labels.ts'
import { ok } from './result.ts'
import { AUTOMATED_REVIEW_MARKER, automatedReviewHead } from './review-comment.ts'

export const REVIEW_APPROVAL_CONTROL = '- [ ] Review and repair'

export interface ReviewApproval {
  repository: string
  pullRequestNumber: number
  headSha: string
  commentId: number
  beforeBody: string
  requestedBy: string
  commentAuthor: string
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/** Reads one isolated checkbox click from a signed GitHub delivery. */
export function reviewApproval(event: string, payload: unknown): ReviewApproval | null {
  const input = object(payload)
  if (event !== 'issue_comment' || input.action !== 'edited')
    return null
  const comment = object(input.comment)
  const before = object(object(input.changes).body).from
  const after = comment.body
  if (typeof before !== 'string' || typeof after !== 'string'
    || !before.includes(AUTOMATED_REVIEW_MARKER)
    || !before.split('\n').includes(REVIEW_APPROVAL_CONTROL)
    || after === before
    || after.replace(/^- \[[xX]\] Review and repair$/m, REVIEW_APPROVAL_CONTROL) !== before) {
    return null
  }
  const headSha = automatedReviewHead(before)
  const repository = object(input.repository).full_name
  const issue = object(input.issue)
  const requestedBy = object(input.sender).login
  const commentAuthor = object(comment.user).login
  if (headSha === undefined || typeof repository !== 'string'
    || typeof issue.number !== 'number' || !Number.isSafeInteger(issue.number) || issue.number <= 0
    || issue.pull_request === undefined
    || typeof comment.id !== 'number' || !Number.isSafeInteger(comment.id) || comment.id <= 0
    || typeof requestedBy !== 'string' || typeof commentAuthor !== 'string') {
    return null
  }
  return { repository, pullRequestNumber: issue.number, headSha, commentId: comment.id, beforeBody: before, requestedBy, commentAuthor }
}

/** Uses the same label path as manual Approval after checking the current prompt and GitHub head. */
export async function applyReviewApproval(
  options: {
    github: ReviewApprovalSource
    store: Pick<JournalStore, 'getApprovalPrompt' | 'hasPullRequestApproval'>
  },
  repository: RepositoryMapping,
  request: ReviewApproval,
  signal: AbortSignal,
): Promise<Result<void, string>> {
  if (!repository.enabled || !repository.pullRequestReview || repository.github.toLowerCase() !== request.repository.toLowerCase())
    return ok(undefined)
  const prompt = options.store.getApprovalPrompt(request)
  if (prompt === null || options.store.hasPullRequestApproval(repository.github, request.pullRequestNumber, prompt.revisionId, 'review'))
    return ok(undefined)
  const current = await options.github.getPullRequestStatusIdentity(repository, request.pullRequestNumber, signal)
  if (current._tag === 'Err')
    return current
  if (current.value.state !== 'open' || current.value.headSha !== request.headSha || current.value.baseRef !== prompt.baseRef)
    return ok(undefined)
  // The journal may advance while GitHub answers. Recheck before the write.
  if (options.store.getApprovalPrompt(request)?.revisionId !== prompt.revisionId)
    return ok(undefined)
  return options.github.addApprovalLabel(repository, request.pullRequestNumber, APPROVAL_LABELS.review, signal)
}
