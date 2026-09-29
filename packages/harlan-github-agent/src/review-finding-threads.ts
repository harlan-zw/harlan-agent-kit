import type { ReviewPublicationAuthority } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { RepositoryMapping, ReviewFinding } from './types.ts'
import { AUTOMATED_REVIEW_MARKER, automatedDisclosure } from './review-comment.ts'
import { cleanLine } from './text.ts'

/** One review thread this service opened for one Review finding. */
export interface ReviewFindingThread {
  threadId: string
  fingerprint: string
  resolved: boolean
}

/** One inline comment on the reviewed head. A null line comments on the whole file. */
export interface ReviewFindingComment {
  headSha: string
  path: string
  line: number | null
  body: string
}

/**
 * What one inline comment write did.
 *
 * GitHub only accepts a comment on a file the pull request changes. A finding
 * in any other file answers `OutsideDiff`, and its code link in the canonical
 * comment is the only place it shows.
 */
export type ReviewFindingCommentOutcome
  = | { _tag: 'Posted' }
    | { _tag: 'OutsideDiff' }

export interface ReviewFindingThreadSource {
  /** Every review thread on the pull request that this service opened for a finding. */
  listReviewFindingThreads: (repository: RepositoryMapping, pullRequestNumber: number, signal: AbortSignal) => Promise<Result<ReviewFindingThread[], string>>
  postReviewFindingComment: (repository: RepositoryMapping, pullRequestNumber: number, comment: ReviewFindingComment, signal: AbortSignal, authorize: ReviewPublicationAuthority) => Promise<Result<ReviewFindingCommentOutcome, string>>
  resolveReviewFindingThread: (repository: RepositoryMapping, threadId: string, signal: AbortSignal, authorize: ReviewPublicationAuthority) => Promise<Result<void, string>>
}

export type ReviewFindingThreadsOutcome
  = | { _tag: 'Written', posted: number, outsideDiff: number, resolved: number }
    | { _tag: 'Failed', message: string }

export interface ReviewFindingThreadMirror {
  source: ReviewFindingThreadSource
  /** The findings one Review run recorded, or null when the journal no longer holds the run. */
  findings: (repository: string, pullRequestNumber: number, reviewRunId: string) => ReviewFinding[] | null
  /** Hears every sync, so a failure always reaches a person. */
  report: (repository: string, outcome: ReviewFindingThreadsOutcome) => void
}

const FINDING_MARKER_PATTERN = /<!-- review-finding: ([a-f\d]{64}) -->/i

/** The finding fingerprint one inline comment carries, or null on any other comment. */
export function reviewFindingThreadFingerprint(body: string): string | null {
  if (!body.includes(AUTOMATED_REVIEW_MARKER))
    return null
  return FINDING_MARKER_PATTERN.exec(body)?.[1]?.toLowerCase() ?? null
}

type OpenFinding = Extract<ReviewFinding, { _tag: 'Open' }> & { details: NonNullable<Extract<ReviewFinding, { _tag: 'Open' }>['details']> }

function sentence(text: string): string {
  const line = cleanLine(text)
  return /[.!?]$/.test(line) ? line : `${line}.`
}

/**
 * Renders one finding as the inline comment a reader sees beside the code.
 *
 * It carries the canonical comment's marker, so the next Review reads it as
 * this service's own words and never as feedback from a person.
 */
export function reviewFindingThreadBody(finding: OpenFinding): string {
  const heading = finding.resolution === 'Dismissal' ? 'Dismissal recommended' : 'Open'
  return [
    AUTOMATED_REVIEW_MARKER,
    `<!-- review-finding: ${finding.details.fingerprint.toLowerCase()} -->`,
    `**${heading}:** ${sentence(finding.summary)}`,
    '',
    `**Proof:** ${sentence(finding.details.proof)}`,
    '',
    `Next: ${sentence(finding.nextAction)}`,
    '',
    automatedDisclosure({ kind: 'review', disclaimer: `It is not Harlan's personal review or approval.` }),
  ].join('\n')
}

export interface ReviewFindingThreadPlan {
  post: ReviewFindingComment[]
  resolve: string[]
}

/**
 * Decides which findings get a new thread and which old threads close.
 *
 * A fingerprint that already has a thread gets no second one, resolved or
 * not: a person who resolved it has answered it, and a new head only marks it
 * outdated. A thread closes when the latest Review no longer reports its
 * finding as open.
 */
export function planReviewFindingThreads(headSha: string, findings: ReviewFinding[], threads: ReviewFindingThread[]): ReviewFindingThreadPlan {
  const open = findings.filter((finding): finding is OpenFinding => finding._tag === 'Open' && finding.details !== undefined)
  const openFingerprints = new Set(open.map(finding => finding.details.fingerprint.toLowerCase()))
  const threaded = new Set(threads.map(thread => thread.fingerprint))
  const post = new Map<string, ReviewFindingComment>()
  for (const finding of open) {
    const fingerprint = finding.details.fingerprint.toLowerCase()
    if (threaded.has(fingerprint) || post.has(fingerprint))
      continue
    const { path, line } = finding.details.location
    post.set(fingerprint, {
      headSha,
      path,
      line: line !== null && Number.isSafeInteger(line) && line > 0 ? line : null,
      body: reviewFindingThreadBody(finding),
    })
  }
  return {
    post: [...post.values()],
    resolve: threads.filter(thread => !thread.resolved && !openFingerprints.has(thread.fingerprint)).map(thread => thread.threadId),
  }
}

/**
 * Puts each open finding beside its code and closes the threads a Review no longer reports.
 *
 * The threads mirror the canonical comment. They never gate the comment, the
 * outcome label, or the command that carries them.
 */
export async function mirrorReviewFindingThreads(
  mirror: ReviewFindingThreadMirror,
  repository: RepositoryMapping,
  pullRequestNumber: number,
  headSha: string,
  findings: ReviewFinding[],
  signal: AbortSignal,
  authorize: ReviewPublicationAuthority,
): Promise<ReviewFindingThreadsOutcome> {
  const outcome = await syncReviewFindingThreads(mirror.source, repository, pullRequestNumber, headSha, findings, signal, authorize)
  mirror.report(repository.github, outcome)
  return outcome
}

async function syncReviewFindingThreads(
  source: ReviewFindingThreadSource,
  repository: RepositoryMapping,
  pullRequestNumber: number,
  headSha: string,
  findings: ReviewFinding[],
  signal: AbortSignal,
  authorize: ReviewPublicationAuthority,
): Promise<ReviewFindingThreadsOutcome> {
  const threads = await source.listReviewFindingThreads(repository, pullRequestNumber, signal)
  if (threads._tag === 'Err')
    return { _tag: 'Failed', message: threads.error }
  const plan = planReviewFindingThreads(headSha, findings, threads.value)
  let posted = 0
  let outsideDiff = 0
  for (const comment of plan.post) {
    const result = await source.postReviewFindingComment(repository, pullRequestNumber, comment, signal, authorize)
    if (result._tag === 'Err')
      return { _tag: 'Failed', message: result.error }
    if (result.value._tag === 'Posted')
      posted++
    else
      outsideDiff++
  }
  for (const threadId of plan.resolve) {
    const result = await source.resolveReviewFindingThread(repository, threadId, signal, authorize)
    if (result._tag === 'Err')
      return { _tag: 'Failed', message: result.error }
  }
  return { _tag: 'Written', posted, outsideDiff, resolved: plan.resolve.length }
}
