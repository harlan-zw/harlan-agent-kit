import type { Octokit } from 'octokit'
import type { ReviewPublicationAuthority } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { RepositoryMapping, ReviewDesiredOutcome } from './types.ts'
import { err, ok } from './result.ts'
import { automatedDisclosure } from './review-comment.ts'

export const NATIVE_REVIEW_MARKER = '<!-- harlan-agent-kit:native-review -->'

export interface NativeReviewPublisher {
  upsertNativeReview: (repository: RepositoryMapping, pullRequestNumber: number, headSha: string, body: string, signal: AbortSignal, authorize: ReviewPublicationAuthority) => Promise<Result<void, string>>
}

export interface NativeReviewMirror {
  publisher: NativeReviewPublisher
  report: (repository: string, result: Result<void, string>) => void
}

export function nativeReviewBody(headSha: string, outcome: ReviewDesiredOutcome | null, commentUrl: string): string {
  return `${NATIVE_REVIEW_MARKER}
<!-- reviewed-sha: ${headSha} -->
${automatedDisclosure({ kind: 'review' })}

Automated Review: ${outcome ?? 'PENDING'}.

[Read the Review results](${commentUrl})`
}

/** One native COMMENT review per head. Reruns update its link and outcome. */
export async function writeNativeReview(
  client: Octokit,
  input: { repository: string, pullRequestNumber: number, actorLogin: string, headSha: string, body: string },
  signal: AbortSignal,
  authorize: ReviewPublicationAuthority,
): Promise<Result<void, string>> {
  const [owner, repo] = input.repository.split('/')
  const request = { owner: owner!, repo: repo!, pull_number: input.pullRequestNumber, request: { signal } }
  return client.paginate(client.rest.pulls.listReviews, { ...request, per_page: 100 }).then(async (reviews): Promise<Result<void, string>> => {
    const existing = reviews.find(review => review.user?.login.toLowerCase() === input.actorLogin.toLowerCase()
      && review.state === 'COMMENTED' && review.commit_id === input.headSha && review.body?.includes(NATIVE_REVIEW_MARKER))
    if (existing?.body === input.body)
      return ok(undefined)
    const authority = authorize()
    if (authority._tag === 'Err')
      return authority
    const written = existing === undefined
      ? await client.rest.pulls.createReview({ ...request, commit_id: input.headSha, event: 'COMMENT', body: input.body })
      : await client.rest.pulls.updateReview({ ...request, review_id: existing.id, body: input.body })
    return written.data.state === 'COMMENTED' && written.data.commit_id === input.headSha
      && written.data.user?.login.toLowerCase() === input.actorLogin.toLowerCase() && written.data.body === input.body
      ? ok(undefined)
      : err('GitHub did not confirm the automated Review.')
  }).catch((error: unknown) => err(error instanceof Error ? error.message : String(error)))
}
