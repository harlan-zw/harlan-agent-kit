import { AUTOMATED_REVIEW_MARKER, automatedReviewHead } from './review-comment.ts'

export const REVIEW_CANCEL_CONTROL = '- [ ] Stop Review and any follow-up repair'

export interface ReviewCancellation {
  repository: string
  pullRequestNumber: number
  headSha: string
  commentId: number
  requestedBy: string
  commentAuthor: string
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

export function normalizeReviewControl(body: string): string {
  return body.replace(/^- \[[xX]\] Stop Review and any follow-up repair$/m, REVIEW_CANCEL_CONTROL)
}

/** Parses a checkbox transition from an authenticated GitHub delivery. */
export function reviewCancellation(event: string, payload: unknown): ReviewCancellation | null {
  const input = object(payload)
  if (event !== 'issue_comment' || input.action !== 'edited')
    return null
  const comment = object(input.comment)
  const before = object(object(input.changes).body).from
  const after = comment.body
  if (typeof before !== 'string' || typeof after !== 'string'
    || !before.includes(AUTOMATED_REVIEW_MARKER)
    || !before.split('\n').includes(REVIEW_CANCEL_CONTROL)
    || normalizeReviewControl(after) === after
    || normalizeReviewControl(after) !== before) {
    return null
  }
  const headSha = automatedReviewHead(before)
  const repository = object(input.repository).full_name
  const issue = object(input.issue)
  const requestedBy = object(input.sender).login
  const commentAuthor = object(comment.user).login
  if (headSha === undefined || typeof repository !== 'string'
    || typeof issue.number !== 'number' || !Number.isSafeInteger(issue.number)
    || issue.pull_request === undefined || typeof comment.id !== 'number' || !Number.isSafeInteger(comment.id)
    || typeof requestedBy !== 'string' || typeof commentAuthor !== 'string') {
    return null
  }
  return { repository, pullRequestNumber: issue.number, headSha, commentId: comment.id, requestedBy, commentAuthor }
}
