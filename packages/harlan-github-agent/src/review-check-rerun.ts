import type { JournalStore } from './store.ts'
import type { ReviewRerunResult } from './types.ts'
import { REVIEW_CHECK_RUN_NAME } from './review-check-run.ts'

/**
 * One Re-run click on the Review check run.
 *
 * GitHub cannot request a review from a regular App bot, so this click is how
 * Harlan asks the App for a fresh Review without a comment.
 */
export interface ReviewCheckRerun {
  repository: string
  headSha: string
  appId: number
  requestedBy: string
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/**
 * Parses a Re-run click from an authenticated GitHub delivery.
 *
 * The caller still checks the App id, because another App can borrow the
 * check run name.
 */
export function reviewCheckRerun(event: string, payload: unknown): ReviewCheckRerun | null {
  const input = object(payload)
  if (event !== 'check_run' || input.action !== 'rerequested')
    return null
  const checkRun = object(input.check_run)
  const repository = object(input.repository).full_name
  const requestedBy = object(input.sender).login
  const appId = object(checkRun.app).id
  const headSha = checkRun.head_sha
  if (checkRun.name !== REVIEW_CHECK_RUN_NAME
    || typeof repository !== 'string' || typeof requestedBy !== 'string'
    || typeof appId !== 'number' || !Number.isSafeInteger(appId)
    || typeof headSha !== 'string' || !/^[a-f\d]{40}$/.test(headSha)) {
    return null
  }
  return { repository, headSha, appId, requestedBy }
}

/**
 * Requests a fresh Review for each open pull request at the clicked head.
 *
 * A check run names a commit. GitHub leaves its pull request list empty for a
 * fork, so the journal's open pull requests decide. A pull request that moved
 * past the clicked head gets nothing, because that Review is already stale.
 */
export function requestReviewCheckRerun(
  store: Pick<JournalStore, 'listOpenPullRequestRevisions' | 'getOpenPullRequest' | 'requestReviewRerun'>,
  request: ReviewCheckRerun & { requestId: string, at: string },
): ReviewRerunResult[] {
  return store.listOpenPullRequestRevisions(request.repository).flatMap(({ number, revisionId }) =>
    store.getOpenPullRequest(request.repository, number)?.headSha === request.headSha
      ? [store.requestReviewRerun({
          repository: request.repository,
          pullRequestNumber: number,
          revisionId,
          requestId: `github-check-run:${request.repository}:${number}:${request.requestId}`,
          source: 'github_check_run',
          requestedBy: request.requestedBy,
          at: request.at,
        })]
      : [])
}
