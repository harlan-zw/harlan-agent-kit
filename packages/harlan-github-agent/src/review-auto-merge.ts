import type { MergeRisk } from './merge-risk.ts'
import type { GitHubPullRequestItem, RepositoryMapping } from './types.ts'
import { reviewAutoMergeMinimumConfidence } from './auto-merge.ts'
import { AUTOMATED_REVIEW_MARKER, automatedReviewHead, isPullRequestCommandFooter } from './review-comment.ts'

export const REVIEW_AUTO_MERGE_CONTROL = '- [ ] Enable auto-merge for this commit'

export interface ReviewAutoMergeRequest {
  repository: string
  pullRequestNumber: number
  headSha: string
  commentId: number
  beforeBody: string
  requestedBy: string
  commentAuthor: string
  selection: 'Selected' | 'Cleared'
  updatedAt: number
}

export function normalizeReviewAutoMergeControl(body: string): string {
  return body.replaceAll('\r\n', '\n').replace(/^- \[[xX]\] Enable auto-merge for this commit$/m, REVIEW_AUTO_MERGE_CONTROL)
}

export function withReviewAutoMergeControl(body: string, repository: RepositoryMapping, pullRequest: GitHubPullRequestItem, confidence: number | undefined, risk: MergeRisk | undefined): string {
  if (confidence === undefined || confidence < reviewAutoMergeMinimumConfidence(repository)
    || repository.ownership !== 'owned' || pullRequest.state !== 'open' || pullRequest.draft
    || pullRequest.baseRef !== repository.defaultBranch
    || pullRequest.headRepository?.toLowerCase() !== repository.github.toLowerCase()
    || !repository.writablePullRequestAuthors.some(author => author.toLowerCase() === pullRequest.author.toLowerCase())) {
    return body
  }
  if (repository.autoMerge._tag === 'Contained'
    && (risk === undefined || (risk._tag === 'Sensitive' && !repository.autoMerge.labelOverridesRisk))) {
    return body
  }
  const footer = body.split('\n').at(-1)!
  return isPullRequestCommandFooter(footer)
    ? `${body.slice(0, -footer.length)}${REVIEW_AUTO_MERGE_CONTROL}\n\n${footer}`
    : `${body}\n\n${REVIEW_AUTO_MERGE_CONTROL}`
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/** Accepts one checkbox change in the confirmed Review comment. */
export function reviewAutoMergeRequest(event: string, payload: unknown): ReviewAutoMergeRequest | null {
  const input = object(payload)
  if (event !== 'issue_comment' || input.action !== 'edited')
    return null
  const comment = object(input.comment)
  const before = object(object(input.changes).body).from
  const after = comment.body
  if (typeof before !== 'string' || typeof after !== 'string')
    return null
  const previous = before.replaceAll('\r\n', '\n')
  const next = after.replaceAll('\r\n', '\n')
  const beforeBody = normalizeReviewAutoMergeControl(previous)
  if (!beforeBody.includes(AUTOMATED_REVIEW_MARKER) || !beforeBody.split('\n').includes(REVIEW_AUTO_MERGE_CONTROL)
    || previous === next || normalizeReviewAutoMergeControl(next) !== beforeBody) {
    return null
  }
  const selection = previous === beforeBody ? 'Selected' : next === beforeBody ? 'Cleared' : null
  const updatedAt = typeof comment.updated_at === 'string' ? Date.parse(comment.updated_at) : Number.NaN
  if (selection === null || !Number.isFinite(updatedAt))
    return null

  const headSha = automatedReviewHead(beforeBody)
  const repository = object(input.repository).full_name
  const requestedBy = object(input.sender).login
  const commentAuthor = object(comment.user).login
  const issue = object(input.issue)
  if (headSha === undefined || typeof repository !== 'string' || typeof requestedBy !== 'string' || typeof commentAuthor !== 'string'
    || issue.pull_request === undefined || typeof issue.number !== 'number' || !Number.isSafeInteger(issue.number) || issue.number <= 0
    || typeof comment.id !== 'number' || !Number.isSafeInteger(comment.id) || comment.id <= 0) {
    return null
  }
  return { repository, pullRequestNumber: issue.number, headSha, commentId: comment.id, beforeBody, requestedBy, commentAuthor, selection, updatedAt }
}
