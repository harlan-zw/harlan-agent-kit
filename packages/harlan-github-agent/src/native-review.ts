import type { Octokit } from 'octokit'
import type { ReviewPublicationAuthority } from './github-agent-source.ts'
import type { PublicBody } from './public-text.ts'
import type { Result } from './result.ts'
import type { RepositoryMapping, ReviewDesiredOutcome, ReviewFinding } from './types.ts'
import { err, ok } from './result.ts'
import { automatedDisclosure, listedFollowUp, plural, statusLine } from './review-comment.ts'

export const NATIVE_REVIEW_MARKER = '<!-- harlan-agent-kit:native-review -->'

export interface NativeReviewPublisher {
  upsertNativeReview: (repository: RepositoryMapping, pullRequestNumber: number, headSha: string, body: string, signal: AbortSignal, authorize: ReviewPublicationAuthority) => Promise<Result<void, string>>
}

export interface NativeReviewMirror {
  publisher: NativeReviewPublisher
  readFindings: (reviewRunId: string) => ReviewFinding[]
  report: (repository: string, result: Result<void, string>) => void
}

/**
 * The native COMMENT review: one Status line that links the canonical comment.
 *
 * It exists so the bot appears in GitHub's Reviewers sidebar. Its folded
 * findings used to repeat the canonical comment, so it now carries only the
 * outcome, the count a reader acts on, and the link.
 */
export function nativeReviewBody({ headSha, outcome, commentUrl, findings }: {
  headSha: string
  outcome: ReviewDesiredOutcome | null
  commentUrl: string
  findings: readonly ReviewFinding[]
}): string {
  const read = `[read the review](${commentUrl})`
  const blocking = findings.filter(finding => finding._tag === 'Open').length
  const followUps = findings.filter(listedFollowUp).length
  const line = outcome === 'READY'
    ? statusLine('ready', 'Ready', [...(followUps === 0 ? [] : [plural(followUps, 'follow-up')]), read].join(' · '))
    : outcome === 'BLOCKED'
      ? statusLine('act', 'Blocked', [...(blocking === 0 ? [] : [`${plural(blocking, 'issue')} to fix before merge`]), read].join(' · '))
      : outcome === 'SKIPPED'
        ? statusLine('work', 'Review skipped', read)
        : outcome === 'WAITING'
          ? statusLine('act', 'Stuck', read)
          : statusLine('work', 'Pending', read)
  return [NATIVE_REVIEW_MARKER, `<!-- reviewed-sha: ${headSha} -->`, line, '', automatedDisclosure({ kind: 'review' })].join('\n')
}

/** One native COMMENT review per head. Reruns update its body. */
export async function writeNativeReview(
  client: Octokit,
  input: { repository: string, pullRequestNumber: number, actorLogin: string, headSha: string, body: PublicBody },
  signal: AbortSignal,
  authorize: ReviewPublicationAuthority,
): Promise<Result<void, string>> {
  const [owner, repo] = input.repository.split('/')
  const request = { owner: owner!, repo: repo!, pull_number: input.pullRequestNumber, request: { signal } }
  return client.paginate(client.rest.pulls.listReviews, { ...request, per_page: 100 }).then(async (reviews): Promise<Result<void, string>> => {
    const existing = reviews.find(review => review.user?.login.toLowerCase() === input.actorLogin.toLowerCase()
      && review.state === 'COMMENTED' && review.commit_id === input.headSha && review.body?.includes(NATIVE_REVIEW_MARKER))
    if (existing?.body === input.body.text)
      return ok(undefined)
    const authority = authorize()
    if (authority._tag === 'Err')
      return authority
    const written = await input.body.send(body => existing === undefined
      ? client.rest.pulls.createReview({ ...request, commit_id: input.headSha, event: 'COMMENT', body })
      : client.rest.pulls.updateReview({ ...request, review_id: existing.id, body }))
    return written.data.state === 'COMMENTED' && written.data.commit_id === input.headSha
      && written.data.user?.login.toLowerCase() === input.actorLogin.toLowerCase() && written.data.body === input.body.text
      ? ok(undefined)
      : err('GitHub did not confirm the automated Review.')
  }).catch((error: unknown) => err(error instanceof Error ? error.message : String(error)))
}
