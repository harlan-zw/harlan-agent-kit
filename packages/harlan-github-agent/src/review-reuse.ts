import type { ReviewRun } from './types.ts'

/**
 * What the commits since an earlier reviewed head contain, read from Git.
 *
 * Only `CleanBaseMerges` leaves the pull request's own change as it was. Each
 * of its merges brings the base branch in, Git merged its parents without a
 * conflict, and its tree is exactly the tree Git produced. The pull request
 * still adds and removes the same lines at the same paths.
 */
export type HeadAdvance
  /** The earlier head is not an ancestor: a rebase or force push. */
  = | { _tag: 'Rewritten' }
  /** At least one commit outside the base branch is not a merge. */
    | { _tag: 'NewCommits' }
  /** Every new commit merges the base branch, with no conflict resolution. */
    | { _tag: 'CleanBaseMerges', changedPaths: readonly string[] }
  /** Every merge is clean, but the pull request's own edits moved or changed, as through a base rename. */
    | { _tag: 'ChangedDiff' }
  /** Every new commit merges the base branch, and at least one differs from Git's own merge. */
    | { _tag: 'ResolvedBaseMerges', merges: readonly string[], changedPaths: readonly string[] }

export type ReviewReuse
  = | { _tag: 'Reuse', run: ReviewRun }
    | { _tag: 'Review', reason: string }

export interface ReviewReuseInput {
  /** A rerun or the manual Review label asks for a fresh Review whatever changed. */
  forced: boolean
  /** The latest current Review of an earlier head of this pull request. */
  earlier: ReviewRun | undefined
  /** Null when Git could not answer. */
  advance: HeadAdvance | null
}

/**
 * Whether a new head can carry the Review of an earlier head.
 *
 * A clean merge of the base branch changes nothing the pull request wrote. The
 * same holds when the base branch moves under an unchanged head, and the
 * service already keeps that Review. So the earlier verdict carries over, and
 * the controller gates still answer for the new head.
 *
 * It carries only a Review whose review gate passed, so no Repair waits on it.
 * A carried finding whose file the merge touched could point at a moved line,
 * so that case reviews again.
 */
export function decideReviewReuse(input: ReviewReuseInput): ReviewReuse {
  if (input.forced)
    return { _tag: 'Review', reason: 'A fresh Review was requested.' }
  const earlier = input.earlier
  if (earlier === undefined)
    return { _tag: 'Review', reason: 'No earlier head has a current Review.' }
  if (earlier.gates.review._tag !== 'Passed' || earlier.findings.some(finding => finding._tag === 'Open'))
    return { _tag: 'Review', reason: 'The earlier Review left a finding for Repair.' }
  const advance = input.advance
  if (advance === null)
    return { _tag: 'Review', reason: 'Git could not compare the new head with the reviewed head.' }
  if (advance._tag === 'Rewritten')
    return { _tag: 'Review', reason: 'The reviewed head is not an ancestor of the new head.' }
  if (advance._tag === 'NewCommits')
    return { _tag: 'Review', reason: 'The new head adds commits that are not base merges.' }
  if (advance._tag === 'ResolvedBaseMerges')
    return { _tag: 'Review', reason: 'A base merge resolved a conflict.' }
  if (advance._tag === 'ChangedDiff')
    return { _tag: 'Review', reason: 'The base merge moved or changed the pull request\'s own edits.' }
  const changed = new Set(advance.changedPaths)
  const moved = earlier.findings.find(finding => finding._tag === 'Logged' && changed.has(finding.details.location.path))
  if (moved !== undefined && moved._tag === 'Logged')
    return { _tag: 'Review', reason: `The base merge changed ${moved.details.location.path}, which a carried finding names.` }
  return { _tag: 'Reuse', run: earlier }
}

/** The `Checked` clause of a carried Review, so the canonical comment says what happened. */
export function carriedCoverage(earlier: Pick<ReviewRun, 'checked' | 'headSha'>, baseRef: string | null): string {
  const merged = `the new commits only merge ${baseRef ?? 'the base branch'} without conflicts`
  const head = earlier.headSha.slice(0, 7)
  return earlier.checked === null || earlier.checked === undefined || earlier.checked.trim() === ''
    ? `the Review of ${head}, carried forward because ${merged}`
    : `${earlier.checked.trim().replace(/[.;,\s]+$/, '')} at ${head}; ${merged}`
}
