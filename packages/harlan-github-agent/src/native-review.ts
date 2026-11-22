import type { Octokit } from 'octokit'
import type { ReviewPublicationAuthority } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { RepositoryMapping, ReviewDesiredOutcome, ReviewFinding } from './types.ts'
import { err, ok } from './result.ts'
import { automatedDisclosure, reviewFindingCodeLink, reviewFindingFollowUp, reviewFindingSeverity } from './review-comment.ts'
import { cleanLine, cleanText } from './text.ts'

export const NATIVE_REVIEW_MARKER = '<!-- harlan-agent-kit:native-review -->'

export interface NativeReviewPublisher {
  upsertNativeReview: (repository: RepositoryMapping, pullRequestNumber: number, headSha: string, body: string, signal: AbortSignal, authorize: ReviewPublicationAuthority) => Promise<Result<void, string>>
}

export interface NativeReviewMirror {
  publisher: NativeReviewPublisher
  readFindings: (reviewRunId: string) => ReviewFinding[]
  report: (repository: string, result: Result<void, string>) => void
}

function findingText(value: string): string {
  return value.replaceAll(/[&<>@[\]#`*_~]/g, character => `&#${character.charCodeAt(0)};`)
}

export function nativeReviewBody({ repository, headSha, outcome, commentUrl, findings }: {
  repository: string
  headSha: string
  outcome: ReviewDesiredOutcome | null
  commentUrl: string
  findings: readonly ReviewFinding[]
}): string {
  const status = `${NATIVE_REVIEW_MARKER}
<!-- reviewed-sha: ${headSha} -->
${automatedDisclosure({ kind: 'review' })}

Automated Review: ${outcome ?? 'PENDING'}.

[Read the Review results](${commentUrl})`
  const followUps = findings.filter(finding => finding._tag === 'Logged')
  if (followUps.length === 0)
    return status

  let body = `${status}\n\n## Optional follow-ups`
  for (const finding of followUps) {
    const summary = findingText(cleanLine(finding.summary))
    const proof = findingText(cleanText(finding.details.proof).replaceAll(/\s+/g, ' '))
    const action = findingText(reviewFindingFollowUp(finding))
    const link = reviewFindingCodeLink(repository, headSha, finding).trimStart()
    const section = `\n\n<details>
<summary>${reviewFindingSeverity(finding.impact)} (${finding.impact}/100) · ${summary}</summary>

${proof}

${action}

${link}

</details>`
    if (Buffer.byteLength(body) + Buffer.byteLength(section) > 60_000)
      return `${body}\n\nSee the Review results for more follow-ups.`
    body += section
  }
  return body
}

/** One native COMMENT review per head. Reruns update its body. */
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
