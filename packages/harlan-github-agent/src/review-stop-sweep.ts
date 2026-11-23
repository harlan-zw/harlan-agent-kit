import type { GitHubAgentSource } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { ReviewCheckRunReport, ReviewCheckRunUpdate } from './review-check-run.ts'
import type { JournalStore, StoppedReview, StoppedReviewDisposition } from './store.ts'
import type { RepositoryMapping } from './types.ts'
import { publicFailureCause, REVIEW_NOT_READY_REASON, REVIEW_REPAIR_REFUSALS } from './failure.ts'
import { err, ok } from './result.ts'
import { mirrorReviewCheckRun, reviewCheckRunUpdate } from './review-check-run.ts'
import { AUTOMATED_REVIEW_MARKER, automatedDisclosure, canonicalCommentOutcome, findingLocation, fixedRows, followUpRow, followUpSection, issueRows, listedFollowUp, plural, statusLine, workflowStateLine } from './review-comment.ts'
import { cleanLine } from './text.ts'

export type StoppedReviewOutcome
  = | { _tag: 'Published', repository: string, pullRequestNumber: number }
    | { _tag: 'CommentGone', repository: string, pullRequestNumber: number }
    | { _tag: 'Superseded', repository: string, pullRequestNumber: number }
    | { _tag: 'Retired', repository: string, pullRequestNumber: number, reason: string }

export type { StoppedReviewDisposition }

/**
 * What one pass of the sweep did, and what it left behind.
 *
 * `remaining` is never silent. A sweep that closes three comments out of a
 * hundred and says nothing reads exactly like a sweep with nothing to do.
 */
export interface StoppedReviewSweep {
  results: Array<Result<StoppedReviewOutcome, string>>
  remaining: number
}

export interface ReviewStopSweepOptions {
  github: Pick<GitHubAgentSource, 'clearAgentLabels' | 'editReviewStatus' | 'getPullRequestReviewSnapshot' | 'upsertReviewCheckRun'>
  now: () => Date
  reportCheckRun: ReviewCheckRunReport
  repositories: RepositoryMapping[]
  store: Pick<JournalStore, 'listStoppedReviews' | 'recordDeletedReviewComment' | 'recordReviewClosure' | 'recordStoppedReviewStatus'>
  /**
   * How long one pass may spend closing comments.
   *
   * Every row costs a GitHub round trip, and the whole list used to run inside
   * a pass that has a fixed deadline. A backlog of 139 rows spent that deadline
   * and the poller aborted the sweep at the same place every pass, so two
   * comments closed and the rest never ran. The sweep stops on its own budget
   * now and the next pass carries on.
   */
  budgetMilliseconds?: number
}

/**
 * Closes the Review check run a stopped review leaves in progress.
 *
 * The comment and the check run must not disagree: a comment that says STOPPED
 * beside a check run that says in progress reads as a stalled Review on every
 * `gh pr checks`. A stopped Review settled nothing, so the check run concludes
 * `neutral`, never a verdict. Skipped for a superseded or foreign comment,
 * because another Task owns the Review there and carries the check run itself.
 */
async function completeStoppedReviewCheckRun(
  options: ReviewStopSweepOptions,
  mapping: RepositoryMapping,
  review: StoppedReview,
  body: string,
  at: string,
  signal: AbortSignal,
): Promise<void> {
  const update: ReviewCheckRunUpdate | null = reviewCheckRunUpdate(
    { taskKind: review.taskKind, phase: 'terminal', desiredOutcome: 'SKIPPED', body },
    at,
  )
  if (update === null)
    return
  await mirrorReviewCheckRun({ publisher: options.github, report: options.reportCheckRun }, mapping, review.headSha, update, signal)
}

/**
 * Why the Task stopped, as the public comment says it, or null when it recorded nothing.
 *
 * A provider error names account state no maintainer can change, so it reads
 * as its cause. The raw reason stays in the Journal and the Dashboard.
 */
function stopCause(review: StoppedReview): string | null {
  if (review.reason === null)
    return null
  const cause = cleanLine(publicFailureCause(review.reason))
  return cause === '' ? null : cause
}

/**
 * The cause's first sentence as a Status line detail, and the rest of it.
 *
 * The first line names the cause, so a notification preview says why. A long
 * first sentence stays below the Status line instead.
 */
function causeDetail(cause: string | null): { detail: string | null, rest: string | null } {
  if (cause === null)
    return { detail: null, rest: null }
  const [first = '', ...others] = cause.split(/(?<=[.!?])\s+/)
  if (first.length > 80)
    return { detail: null, rest: cause }
  const detail = first.replace(/[.!?]$/, '').replace(/^[A-Z](?=[a-z])/, letter => letter.toLowerCase())
  return { detail, rest: others.length === 0 ? null : others.join(' ') }
}

/** True when the comment shows a Review verdict, which a close leaves standing. */
function showsVerdict(body: string): boolean {
  const outcome = canonicalCommentOutcome(body)
  return outcome === 'READY' || outcome === 'PENDING' || outcome === 'BLOCKED' || outcome === 'SKIPPED'
}

/**
 * The canonical comment once its Task ended without a verdict, or its pull request left.
 *
 * A stopped Review reads Stuck, and a stopped Repair reads Blocked: both need
 * a person. A merge lists only what is left to fix. A merge with nothing left
 * still writes one line, because the verdict it replaces carries commands
 * and controls a merged pull request no longer accepts. A close leaves a
 * verdict standing and replaces only a state that still claims work.
 */
export function stoppedReviewComment(
  review: StoppedReview,
  at: string,
  disposition: StoppedReviewDisposition = { _tag: 'Stopped' },
): string {
  const cause = stopCause(review)
  if (disposition._tag === 'Closed' && showsVerdict(review.publishedBody))
    return review.publishedBody
  if (disposition._tag !== 'Stopped') {
    const workflow = JSON.stringify({
      _tag: disposition._tag === 'Merged' ? 'PullRequestMerged' : 'PullRequestClosed',
      workflowVersion: 2,
      headSha: review.currentHeadSha,
      baseSha: review.currentBaseSha,
    })
    const head = [AUTOMATED_REVIEW_MARKER, `<!-- reviewed-sha: ${review.currentHeadSha} -->`, `<!-- workflow-state: ${workflow} -->`]
    const footer = automatedDisclosure({ kind: 'review', at })
    if (disposition._tag === 'Closed')
      return [...head, statusLine('work', 'Closed', 'no further reviews'), '', footer].join('\n')
    const open = review.findings.filter(finding => finding._tag === 'Open')
    const followUps = review.findings.filter(listedFollowUp)
    if (open.length + followUps.length === 0) {
      // A skipped Review reviewed nothing, so only a Review outcome may say it did.
      const outcome = canonicalCommentOutcome(review.publishedBody)
      const reviewed = outcome === 'READY' || outcome === 'PENDING' || outcome === 'BLOCKED'
      const detail = reviewed ? 'reviewed with no issues' : 'no further reviews'
      return [...head, statusLine('done', 'Merged', detail), '', footer].join('\n')
    }
    const left = open.length === 0
      ? plural(followUps.length, 'follow-up')
      : plural(open.length + followUps.length, 'issue')
    const rows = [
      ...open.map((finding) => {
        const location = findingLocation(review.repository, review.headSha, finding)
        return `- ${finding.impact === undefined ? '' : `\`${finding.impact}\` `}${cleanLine(finding.summary)}${location === '' ? '' : ` · ${location}`}`
      }),
      ...followUps.map(finding => followUpRow(review.repository, review.headSha, finding)),
    ]
    return [...head, statusLine('done', 'Merged', `${left} not fixed`), '', ...rows, '', footer].join('\n')
  }
  const { detail, rest } = causeDetail(cause)
  if (review.taskKind === 'review_fix') {
    const open = review.findings.filter(finding => finding._tag === 'Open')
    const fixed = fixedRows(review.findings)
    return [
      AUTOMATED_REVIEW_MARKER,
      `<!-- reviewed-sha: ${review.headSha} -->`,
      workflowStateLine({ _tag: 'RepairStopped', headSha: review.headSha }),
      statusLine('act', 'Blocked', 'repair stopped'),
      '',
      ...(cause === null ? [] : [cause, '']),
      ...(open.length === 0 ? [] : [...issueRows(review.repository, review.headSha, open), '']),
      ...(fixed.length === 0 ? [] : [...fixed, '']),
      ...followUpSection(review.repository, review.headSha, review.findings),
      automatedDisclosure({ kind: 'review', at, merge: true }),
    ].join('\n')
  }
  // A draft, or a pull request no longer eligible, needs nobody: it reads as a skip.
  // The marker stays ReviewStopped, so no reader takes this head as reviewed.
  if (review.reason === REVIEW_NOT_READY_REASON || review.reason === REVIEW_REPAIR_REFUSALS.draft) {
    return [
      AUTOMATED_REVIEW_MARKER,
      `<!-- reviewed-sha: ${review.headSha} -->`,
      workflowStateLine({ _tag: 'ReviewStopped', headSha: review.headSha }),
      statusLine('work', 'Review skipped', detail ?? 'the pull request is not ready for review'),
      '',
      automatedDisclosure({ kind: 'review', at }),
    ].join('\n')
  }
  return [
    AUTOMATED_REVIEW_MARKER,
    `<!-- reviewed-sha: ${review.headSha} -->`,
    workflowStateLine({ _tag: 'ReviewStopped', headSha: review.headSha }),
    statusLine('act', 'Stuck', detail ?? 'the review stopped'),
    '',
    ...(rest === null ? [] : [rest, '']),
    'Push a commit to start a new review, or comment `@harlan-agent rerun` to review this commit again.',
    '',
    automatedDisclosure({ kind: 'review', at }),
  ].join('\n')
}

/**
 * Replaces a progress comment left behind by a review that stopped.
 *
 * A review writes one canonical comment as it works. When its Task dies, that
 * comment keeps claiming a review is running, so the controller closes it out.
 *
 * The write is an edit, never an open. A person who deletes the stale comment
 * has answered it, and posting it again would overrule them.
 */
export async function publishStoppedReviews(
  options: ReviewStopSweepOptions,
  signal: AbortSignal,
): Promise<StoppedReviewSweep> {
  const mappings = new Map(options.repositories.map(mapping => [mapping.github.toLowerCase(), mapping]))
  const reviews = options.store.listStoppedReviews()
  const publish = async (review: StoppedReview): Promise<Result<StoppedReviewOutcome, string>> => {
    const mapping = mappings.get(review.repository.toLowerCase())
    if (mapping === undefined)
      return err(`${review.repository}: the repository is no longer configured.`)
    // A closed pull request takes no more commits, so the stored answer is the
    // current one and the read is skipped. GitHub answers no snapshot request
    // at all once the head branch is deleted, which is every merged pull
    // request whose branch GitHub cleaned up.
    const live = review.disposition._tag === 'Stopped'
      ? await options.github.getPullRequestReviewSnapshot(mapping, review.pullRequestNumber, signal)
      : null
    if (live !== null && live._tag === 'Err')
      return err(`${review.repository}#${review.pullRequestNumber}: ${live.error}`)
    if (live !== null && live.value.pullRequest.state === 'open' && live.value.pullRequest.headSha !== review.headSha)
      return ok({ _tag: 'Superseded', repository: review.repository, pullRequestNumber: review.pullRequestNumber })

    const at = options.now().toISOString()
    const disposition: StoppedReviewDisposition = live === null
      ? review.disposition
      : live.value.pullRequest.state === 'open'
        ? { _tag: 'Stopped' }
        : live.value.pullRequest.mergedAt === null
          ? { _tag: 'Closed' }
          : { _tag: 'Merged' }
    const statusReview = live !== null && live.value.pullRequest.state === 'closed'
      ? {
          ...review,
          currentHeadSha: live.value.pullRequest.headSha,
          currentBaseSha: live.value.pullRequest.baseSha,
        }
      : review
    const body = stoppedReviewComment(statusReview, at, disposition)
    const edited = await options.github.editReviewStatus(mapping, review.pullRequestNumber, review.commentId, review.publishedBody, body, signal)
    if (edited._tag === 'Err')
      return err(`${review.repository}#${review.pullRequestNumber}: ${edited.error}`)
    const closure = disposition._tag === 'Stopped' ? null : disposition
    if (edited.value._tag === 'Missing') {
      // The comment is gone, but the check run it mirrored is not. Close it.
      // It gates nothing: a failure reaches a person through the report.
      await completeStoppedReviewCheckRun(options, mapping, review, body, at, signal)
      if (closure !== null) {
        const labels = await options.github.clearAgentLabels(mapping, review.pullRequestNumber, signal)
        if (labels._tag === 'Err')
          return err(`${review.repository}#${review.pullRequestNumber}: ${labels.error}`)
        const recorded = options.store.recordReviewClosure({
          repository: review.repository,
          pullRequestNumber: review.pullRequestNumber,
          revisionId: review.closureRevisionId,
          headSha: review.currentHeadSha,
          baseSha: review.currentBaseSha,
          disposition: closure,
          result: { _tag: 'CommentGone' },
          at,
        })
        if (!recorded)
          return err(`${review.repository}#${review.pullRequestNumber}: the final pull request state could not be saved.`)
      }
      // Retire the publication after closure succeeds. If label cleanup fails,
      // the row stays eligible and the next sweep can try again.
      options.store.recordDeletedReviewComment({
        taskKind: review.taskKind,
        taskId: review.taskId,
        commentId: review.commentId,
        at,
        reason: 'A person deleted the comment.',
      })
      return ok({ _tag: 'CommentGone', repository: review.repository, pullRequestNumber: review.pullRequestNumber })
    }
    // Changed: another Task now owns the comment. Foreign: the stored id names
    // a comment another actor or pull request owns, which no pass can change.
    // Both end this publication; the closure still records that the pull
    // request left, so the row stops asking.
    if (edited.value._tag === 'Changed' || edited.value._tag === 'Foreign') {
      const foreign = edited.value._tag === 'Foreign' ? edited.value.reason : null
      if (closure !== null) {
        const labels = await options.github.clearAgentLabels(mapping, review.pullRequestNumber, signal)
        if (labels._tag === 'Err')
          return err(`${review.repository}#${review.pullRequestNumber}: ${labels.error}`)
        const recorded = options.store.recordReviewClosure({
          repository: review.repository,
          pullRequestNumber: review.pullRequestNumber,
          revisionId: review.closureRevisionId,
          headSha: review.currentHeadSha,
          baseSha: review.currentBaseSha,
          disposition: closure,
          result: { _tag: 'Superseded' },
          at,
        })
        if (!recorded)
          return err(`${review.repository}#${review.pullRequestNumber}: the final pull request state could not be saved.`)
      }
      options.store.recordDeletedReviewComment({
        taskKind: review.taskKind,
        taskId: review.taskId,
        commentId: review.commentId,
        at,
        reason: foreign ?? 'Another Task replaced the canonical comment.',
      })
      return ok(foreign === null
        ? { _tag: 'Superseded', repository: review.repository, pullRequestNumber: review.pullRequestNumber }
        : { _tag: 'Retired', repository: review.repository, pullRequestNumber: review.pullRequestNumber, reason: foreign })
    }
    // The comment is closed. Close the check run it mirrored. It gates
    // nothing: a failure reaches a person through the report, and the row
    // still settles, because no later pass can grant a missing permission.
    // A verdict left standing already concluded its check run.
    if (body !== review.publishedBody)
      await completeStoppedReviewCheckRun(options, mapping, review, body, at, signal)
    const labels = await options.github.clearAgentLabels(mapping, review.pullRequestNumber, signal)
    if (labels._tag === 'Err')
      return err(`${review.repository}#${review.pullRequestNumber}: ${labels.error}`)
    const recorded = options.store.recordStoppedReviewStatus({
      taskId: review.taskId,
      taskKind: review.taskKind,
      revisionId: review.revisionId,
      expectedHeadSha: review.headSha,
      body,
      at,
      commentId: edited.value.commentId,
      url: edited.value.url,
    })
    if (!recorded)
      return err(`${review.repository}#${review.pullRequestNumber}: the final review comment could not be saved.`)
    if (closure !== null) {
      const closureRecorded = options.store.recordReviewClosure({
        repository: review.repository,
        pullRequestNumber: review.pullRequestNumber,
        revisionId: review.closureRevisionId,
        headSha: review.currentHeadSha,
        baseSha: review.currentBaseSha,
        disposition: closure,
        result: { _tag: 'Published', body, commentId: edited.value.commentId, url: edited.value.url },
        at,
      })
      if (!closureRecorded)
        return err(`${review.repository}#${review.pullRequestNumber}: the final pull request state could not be saved.`)
    }
    return ok({ _tag: 'Published', repository: review.repository, pullRequestNumber: review.pullRequestNumber })
  }

  const budgetMilliseconds = options.budgetMilliseconds ?? 30_000
  const startedAt = options.now().getTime()
  const results: Array<Result<StoppedReviewOutcome, string>> = []
  let index = 0
  for (const review of reviews) {
    if (signal.aborted || options.now().getTime() - startedAt >= budgetMilliseconds)
      break
    index += 1
    // One row must not take the rest of the sweep with it. A throw here used
    // to abandon every row behind it, and the pass reported nothing at all.
    results.push(await publish(review).catch((error: unknown) =>
      err(`${review.repository}#${review.pullRequestNumber}: ${error instanceof Error ? error.message : 'The stopped review comment failed unexpectedly.'}`)))
  }
  return { results, remaining: reviews.length - index }
}
