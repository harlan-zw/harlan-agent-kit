import type { ReviewPublicationAuthority } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { RepositoryMapping, ReviewFinding } from './types.ts'
import { Buffer } from 'node:buffer'
import { loggedFindingBaseMarker, loggedFindingControl, normalizeLoggedFindingControls } from './logged-finding-pickup.ts'
import { AUTOMATED_REVIEW_MARKER, automatedDisclosure } from './review-comment.ts'
import { cleanLine, cleanText } from './text.ts'

/** One review thread this service opened for one Review finding. */
export interface ReviewFindingThread {
  threadId: string
  fingerprint: string
  resolved: boolean
  comment?: { id: number, body: string }
}

/** One inline comment on the reviewed head. A null line comments on the whole file. */
export interface ReviewFindingComment {
  headSha: string
  path: string
  line: number | null
  body: string
  lineOnly?: true
}

/**
 * What one inline comment write did.
 *
 * GitHub only accepts a comment on a file the pull request changes. A finding
 * in any other file answers `OutsideDiff`, and its code link in the canonical
 * comment is the only place it shows.
 */
export type ReviewFindingCommentOutcome
  = | { _tag: 'Posted', comment?: { id: number, body: string } }
    | { _tag: 'OutsideDiff' }

export interface ReviewFindingThreadSource {
  /** Every review thread on the pull request that this service opened for a finding. */
  listReviewFindingThreads: (repository: RepositoryMapping, pullRequestNumber: number, signal: AbortSignal) => Promise<Result<ReviewFindingThread[], string>>
  postReviewFindingComment: (repository: RepositoryMapping, pullRequestNumber: number, comment: ReviewFindingComment, signal: AbortSignal, authorize: ReviewPublicationAuthority) => Promise<Result<ReviewFindingCommentOutcome, string>>
  resolveReviewFindingThread: (repository: RepositoryMapping, threadId: string, signal: AbortSignal, authorize: ReviewPublicationAuthority) => Promise<Result<void, string>>
  editReviewFindingComment?: (repository: RepositoryMapping, comment: { id: number, body: string }, body: string, signal: AbortSignal, authorize: ReviewPublicationAuthority) => Promise<Result<{ id: number, body: string }, string>>
}

export interface InlineFindingReceipt {
  fingerprint: string
  commentId: number
  body: string
  resolved: boolean
}

export interface VerifiedFindingRepair {
  fingerprint: string
  commitSha: string
}

interface FindingThreadOptions {
  controls?: boolean
  baseRef?: string
  fixed?: readonly VerifiedFindingRepair[]
  recordInline?: (receipts: InlineFindingReceipt[]) => void
}

export type ReviewFindingThreadsOutcome
  = | { _tag: 'Written', posted: number, outsideDiff: number, resolved: number }
    | { _tag: 'Failed', message: string }

export interface ReviewFindingThreadMirror {
  source: ReviewFindingThreadSource
  /** Hears every sync, so a failure always reaches a person. */
  report: (repository: string, outcome: ReviewFindingThreadsOutcome) => void
}

const FINDING_MARKER_PATTERN = /<!-- review-finding: ([a-f\d]{64})(?: ([\w-]+))? -->/i
const FINDING_HEADING_PATTERN = /^\*\*(?:Finding|(?:Trivial|Minor|Major|Critical) \(\d+\/100\)): (.+)\*\*$/
const LEGACY_FINDING_HEADING_PATTERN = /^\*\*(Open|Logged|Dismissal recommended)(?: \(\d+\/100\))?:\*\* (.+)$/
const LOGGED_FINDING_MARKER = '<!-- review-finding-disposition: logged -->'
const OPTIONAL_ACTION_PREFIX = /^(?:(?:optional follow-up[.:]|as an optional follow-up,)\s*)+/i

/** What one finding thread's first comment says about its finding. */
export interface ReviewFindingThreadMarker {
  fingerprint: string
  /** The Review's own name for the finding, so a later Review can reuse it exactly. */
  identity: string | null
  summary: string | null
  logged: boolean
}

/** Reads the finding one inline comment opened, or null on any other comment. */
export function reviewFindingThreadMarker(body: string): ReviewFindingThreadMarker | null {
  if (!body.includes(AUTOMATED_REVIEW_MARKER))
    return null
  const marker = FINDING_MARKER_PATTERN.exec(body)
  if (marker?.[1] === undefined)
    return null
  const [firstLine, nextLine] = body.slice(marker.index + marker[0].length).trimStart().split(/\r?\n/, 2)
  const logged = firstLine === LOGGED_FINDING_MARKER
  const heading = (logged ? nextLine : firstLine) ?? ''
  const legacyHeading = LEGACY_FINDING_HEADING_PATTERN.exec(heading)
  const summary = FINDING_HEADING_PATTERN.exec(heading)?.[1] ?? legacyHeading?.[2]
  return {
    fingerprint: marker[1].toLowerCase(),
    identity: marker[2] === undefined ? null : Buffer.from(marker[2], 'base64url').toString('utf8'),
    summary: summary === undefined ? null : sentence(summary),
    logged: logged || legacyHeading?.[1] === 'Logged',
  }
}

/** The finding fingerprint one inline comment carries, or null on any other comment. */
export function reviewFindingThreadFingerprint(body: string): string | null {
  return reviewFindingThreadMarker(body)?.fingerprint ?? null
}

type OpenFinding = Extract<ReviewFinding, { _tag: 'Open' }> & { details: NonNullable<Extract<ReviewFinding, { _tag: 'Open' }>['details']> }
type ThreadFinding = OpenFinding | Extract<ReviewFinding, { _tag: 'Logged' }>

function sentence(text: string): string {
  const line = cleanLine(text)
  return /[.!?]$/.test(line) ? line : `${line}.`
}

function findingSeverity(impact: number): string {
  if (impact >= 91)
    return 'Critical'
  if (impact >= 81)
    return 'Major'
  return impact >= 40 ? 'Minor' : 'Trivial'
}

/**
 * Renders one finding as the inline comment a reader sees beside the code.
 *
 * It carries the canonical comment's marker, so the next Review reads it as
 * this service's own words and never as feedback from a person.
 */
export function reviewFindingThreadBody(finding: ThreadFinding, headSha?: string, baseRef?: string): string {
  const { impact } = finding
  const heading = impact === undefined ? 'Finding' : `${findingSeverity(impact)} (${impact}/100)`
  const summary = cleanLine(finding.summary).replace(/\.$/, '')
  const recommendation = cleanText(finding.nextAction ?? '')
  const action = OPTIONAL_ACTION_PREFIX.test(recommendation)
    ? recommendation.replace(OPTIONAL_ACTION_PREFIX, '').replace(/^[a-z]/, letter => letter.toUpperCase())
    : recommendation
  return [
    AUTOMATED_REVIEW_MARKER,
    // The identity rides base64url encoded, so no finding text can close the HTML comment.
    `<!-- review-finding: ${finding.details.fingerprint.toLowerCase()}${finding.details.identity === undefined ? '' : ` ${Buffer.from(finding.details.identity, 'utf8').toString('base64url')}`} -->`,
    ...(finding._tag === 'Logged' ? [LOGGED_FINDING_MARKER] : []),
    `**${heading}: ${summary}**`,
    '',
    cleanText(finding.details.proof),
    ...(action === '' ? [] : ['', action]),
    '',
    ...(headSha === undefined || finding._tag !== 'Logged'
      ? []
      : [
          `<!-- reviewed-sha: ${headSha} -->`,
          ...(baseRef === undefined ? [] : [loggedFindingBaseMarker(baseRef)]),
          loggedFindingControl(finding.details.fingerprint),
          '',
        ]),
    automatedDisclosure({ kind: 'review', disclaimer: `It is not Harlan's personal review or approval.` }),
  ].join('\n')
}

export interface ReviewFindingThreadPlan {
  post: ReviewFindingComment[]
  resolve: { thread: ReviewFindingThread, commitSha: string | undefined }[]
}

/**
 * Decides which findings get a new thread and which old threads close.
 *
 * Reuse the thread for the same finding across Reviews. Keep a resolved thread
 * closed. A Logged finding needs evidence of a fix before automatic resolution.
 */
export function planReviewFindingThreads(headSha: string, findings: ReviewFinding[], threads: ReviewFindingThread[], options: FindingThreadOptions = {}): ReviewFindingThreadPlan {
  const current = findings.filter((finding): finding is ThreadFinding => finding._tag === 'Logged' || (finding._tag === 'Open' && finding.details !== undefined))
  const currentFingerprints = new Set(current.map(finding => finding.details.fingerprint.toLowerCase()))
  const fixedSummaries = new Set(findings.filter(finding => finding._tag === 'Fixed').map(finding => sentence(finding.summary)))
  const repairs = new Map(options.fixed?.map(repair => [repair.fingerprint, repair.commitSha]))
  const threaded = new Set(threads.map(thread => thread.fingerprint))
  const post = new Map<string, ReviewFindingComment>()
  for (const finding of current) {
    const fingerprint = finding.details.fingerprint.toLowerCase()
    if (threaded.has(fingerprint) || post.has(fingerprint))
      continue
    const { path, line } = finding.details.location
    const anchor = line !== null && Number.isSafeInteger(line) && line > 0 ? line : null
    if (finding._tag === 'Logged' && anchor === null)
      continue
    post.set(fingerprint, {
      headSha,
      path,
      line: anchor,
      body: reviewFindingThreadBody(finding, options.controls ? headSha : undefined, options.baseRef),
      ...(finding._tag === 'Logged' ? { lineOnly: true } as const : {}),
    })
  }
  return {
    post: [...post.values()],
    resolve: threads.filter((thread) => {
      if (thread.resolved || currentFingerprints.has(thread.fingerprint))
        return false
      const marker = thread.comment === undefined ? null : reviewFindingThreadMarker(thread.comment.body)
      if (marker?.logged !== true)
        return true
      return repairs.has(thread.fingerprint) || (marker.summary !== null && fixedSummaries.has(marker.summary))
    }).map(thread => ({ thread, commitSha: repairs.get(thread.fingerprint) })),
  }
}

/**
 * Puts findings beside their code and closes threads when the finding is cleared.
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
  state: 'open' | 'merged' = 'open',
  options: FindingThreadOptions = {},
): Promise<ReviewFindingThreadsOutcome> {
  const outcome = await syncReviewFindingThreads(mirror.source, repository, pullRequestNumber, headSha, findings, signal, authorize, state, options)
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
  state: 'open' | 'merged',
  options: FindingThreadOptions,
): Promise<ReviewFindingThreadsOutcome> {
  const threads = await source.listReviewFindingThreads(repository, pullRequestNumber, signal)
  if (threads._tag === 'Err')
    return { _tag: 'Failed', message: threads.error }
  const plan = planReviewFindingThreads(headSha, findings, threads.value, options)
  const receipts: InlineFindingReceipt[] = []
  const logged = new Map(findings.filter(finding => finding._tag === 'Logged').map(finding => [finding.details.fingerprint, finding]))
  for (const thread of threads.value) {
    const finding = logged.get(thread.fingerprint)
    if (thread.comment === undefined || finding === undefined)
      continue
    let comment = thread.comment
    if (state === 'open' && !thread.resolved && source.editReviewFindingComment !== undefined) {
      const body = reviewFindingThreadBody(finding, options.controls ? headSha : undefined, options.baseRef)
      const edited = await source.editReviewFindingComment(repository, comment, body, signal, authorize)
      if (edited._tag === 'Err')
        return { _tag: 'Failed', message: edited.error }
      comment = edited.value
    }
    receipts.push({ fingerprint: thread.fingerprint, commentId: comment.id, body: normalizeLoggedFindingControls(comment.body), resolved: thread.resolved })
  }
  let posted = 0
  let outsideDiff = 0
  for (const comment of state === 'merged' ? [] : plan.post) {
    const result = await source.postReviewFindingComment(repository, pullRequestNumber, comment, signal, authorize)
    if (result._tag === 'Err')
      return { _tag: 'Failed', message: result.error }
    if (result.value._tag === 'Posted') {
      posted++
      const fingerprint = reviewFindingThreadFingerprint(comment.body)
      if (result.value.comment !== undefined && fingerprint !== null && logged.has(fingerprint))
        receipts.push({ fingerprint, commentId: result.value.comment.id, body: result.value.comment.body, resolved: false })
    }
    else {
      outsideDiff++
    }
  }
  for (const { thread, commitSha } of plan.resolve) {
    const comment = thread.comment
    if (commitSha !== undefined && comment !== undefined && source.editReviewFindingComment !== undefined) {
      const footer = `✅ Addressed in commit [${commitSha.slice(0, 7)}](https://github.com/${repository.github}/commit/${commitSha})`
      if (!comment.body.endsWith(`\n\n${footer}`)) {
        const control = loggedFindingControl(thread.fingerprint)
        const lines = normalizeLoggedFindingControls(comment.body).split('\n')
        const body = lines.filter(line => line !== control).join('\n').trimEnd()
        const edited = await source.editReviewFindingComment(repository, comment, `${body}\n\n${footer}`, signal, authorize)
        if (edited._tag === 'Err')
          return { _tag: 'Failed', message: edited.error }
      }
    }
    const result = await source.resolveReviewFindingThread(repository, thread.threadId, signal, authorize)
    if (result._tag === 'Err')
      return { _tag: 'Failed', message: result.error }
  }
  options.recordInline?.(receipts)
  return { _tag: 'Written', posted, outsideDiff, resolved: plan.resolve.length }
}

/** One inline review comment as GitHub lists it, reduced to what a finding discussion reads. */
export interface InlineReviewComment {
  id: number
  inReplyToId: number | null
  author: string
  body: string
  path: string
  line: number | null
  updatedAt: string
}

/** One inline review comment as the finding discussion reads it. */
export function inlineReviewComment(comment: { id: number, in_reply_to_id?: number, user: { login: string } | null, body: string, path: string, line?: number | null, updated_at: string }): InlineReviewComment {
  return {
    id: comment.id,
    inReplyToId: comment.in_reply_to_id ?? null,
    author: comment.user?.login ?? '',
    body: comment.body,
    path: comment.path,
    line: comment.line ?? null,
    updatedAt: comment.updated_at,
  }
}

/** One reply a person left on a finding thread. */
export interface FindingReply {
  commentId: number
  author: string
  body: string
  updatedAt: string
}

/** The replies on one finding thread this service opened. */
export interface FindingDiscussion {
  fingerprint: string
  identity: string | null
  summary: string | null
  path: string
  line: number | null
  replies: FindingReply[]
}

/**
 * Groups the replies people left on this service's finding threads.
 *
 * GitHub points every reply at the thread's first comment, so the root decides
 * which finding a reply answers. This service's own comments never count as a
 * reply, or a thread it writes would answer itself.
 */
export function findingDiscussions(comments: InlineReviewComment[], actorLogin: string): FindingDiscussion[] {
  const actor = actorLogin.toLowerCase().replace(/\[bot\]$/, '')
  const own = (comment: InlineReviewComment): boolean => comment.author.toLowerCase().replace(/\[bot\]$/, '') === actor
  const roots = new Map<number, FindingDiscussion>()
  for (const comment of comments) {
    const marker = comment.inReplyToId === null && own(comment) ? reviewFindingThreadMarker(comment.body) : null
    if (marker !== null) {
      const { fingerprint, identity, summary } = marker
      roots.set(comment.id, { fingerprint, identity, summary, path: comment.path, line: comment.line, replies: [] })
    }
  }
  for (const comment of comments) {
    const root = comment.inReplyToId === null ? undefined : roots.get(comment.inReplyToId)
    if (root !== undefined && !own(comment))
      root.replies.push({ commentId: comment.id, author: comment.author, body: comment.body, updatedAt: comment.updatedAt })
  }
  return [...roots.values()]
    .filter(discussion => discussion.replies.length > 0)
    .map(discussion => ({ ...discussion, replies: discussion.replies.toSorted((left, right) => left.commentId - right.commentId) }))
}
