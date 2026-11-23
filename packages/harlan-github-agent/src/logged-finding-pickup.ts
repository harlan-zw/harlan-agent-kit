import type { ReviewFinding } from './types.ts'
import { Buffer } from 'node:buffer'
import { AUTOMATED_REVIEW_MARKER, automatedReviewHead, isCanonicalFooter, plural } from './review-comment.ts'
import { cleanLine } from './text.ts'

export type LoggedReviewFinding = Extract<ReviewFinding, { _tag: 'Logged' }>

export interface LoggedFindingPickup {
  repository: string
  pullRequestNumber: number
  headSha: string
  commentId: number
  requestedBy: string
  commentAuthor: string
  fingerprints: string[]
  dismissedFingerprints?: string[]
  before: string
  inline?: true
}

export interface LoggedFindingStatus {
  fingerprint: string
  status: string
  cancellable?: boolean
}

const afterMergePickupHint = 'Selected findings run after merge and open separate pull requests.'
export const onHeadPickupHint = 'Selected findings run on this pull request.'
const controlPattern = /^( {0,2})- \[([ xX])\] Ask an agent to verify and fix this finding <!-- logged-finding: ([a-f\d]{64}) -->$/gm
const dismissalPattern = /^ {2}- \[([ xX])\] Dismiss this finding <!-- dismiss-logged-finding: ([a-f\d]{64}) -->$/gm
const statusPattern = /^ {2}(?:(?:- \[[ xX]\] Ask an agent to verify and fix this finding|Repair: [^\n]+) <!-- logged-finding: [a-f\d]{64} -->|- \[[ xX]\] Dismiss this finding <!-- dismiss-logged-finding: [a-f\d]{64} -->)\n?/gm

/** Removes controller decorations when another canonical writer compares its source body. */
export function withoutLoggedFindingControls(body: string): string {
  return body.replace(statusPattern, '').replace(/^<!-- finding-base: [\w-]+ -->\n/gm, '').replaceAll(`\n\n${afterMergePickupHint}`, '').replaceAll(`\n\n${onHeadPickupHint}`, '').split('\n').filter(line => line !== afterMergePickupHint && line !== onHeadPickupHint).join('\n').trimEnd()
}

export function normalizeLoggedFindingControls(body: string): string {
  return body.replaceAll('\r\n', '\n').replace(controlPattern, (_line, indent: string, _checked, fingerprint: string) => `${indent}${loggedFindingControl(fingerprint)}`).replace(dismissalPattern, (_line, _checked, fingerprint: string) => dismissalControl(fingerprint))
}

export function loggedFindingControl(fingerprint: string): string {
  return `- [ ] Ask an agent to verify and fix this finding <!-- logged-finding: ${fingerprint} -->`
}

export function loggedFindingBaseMarker(baseRef: string): string {
  return `<!-- finding-base: ${Buffer.from(baseRef, 'utf8').toString('base64url')} -->`
}

function dismissalControl(fingerprint: string): string {
  return `  - [ ] Dismiss this finding <!-- dismiss-logged-finding: ${fingerprint} -->`
}

/**
 * True for the row that lists one Logged finding.
 *
 * A follow-up row starts with its score in a code span. A comment written
 * before the Status line labelled the row `Logged (N/100)`, and stored
 * bodies still do.
 */
function loggedFindingRow(line: string, finding: LoggedReviewFinding): boolean {
  return (line.startsWith(`- \`${finding.impact}\` `) || (line.startsWith('- ') && line.includes(`Logged (${finding.impact}/100)`)))
    && line.includes(cleanLine(finding.summary))
}

/** Adds one control beside each recorded finding. Task status replaces its control. */
export function withLoggedFindingControls(body: string, findings: readonly ReviewFinding[], statuses: readonly LoggedFindingStatus[], options: {
  target?: 'head' | 'after-merge' | undefined
  inline?: ReadonlySet<string>
  baseRef?: string | undefined
} = { target: 'after-merge' }): string {
  const lines = withoutLoggedFindingControls(body).split('\n')
  const rendered = new Set<string>()
  const decorated = lines.flatMap((line) => {
    const finding = findings.find((finding): finding is LoggedReviewFinding => finding._tag === 'Logged'
      && /^[a-f\d]{64}$/.test(finding.details.fingerprint)
      && !rendered.has(finding.details.fingerprint)
      && loggedFindingRow(line, finding))
    if (finding === undefined)
      return [line]
    rendered.add(finding.details.fingerprint)
    const status = statuses.find(status => status.fingerprint === finding.details.fingerprint)
    if (status !== undefined)
      return [line, `  Repair: ${status.status.replace(/\s+/g, ' ').trim()} <!-- logged-finding: ${finding.details.fingerprint} -->`, ...(options.target === 'head' && status.cancellable ? [dismissalControl(finding.details.fingerprint)] : [])]
    if (options.inline?.has(finding.details.fingerprint))
      return []
    return [
      line,
      ...(options.target === undefined ? [] : [`  ${loggedFindingControl(finding.details.fingerprint)}`]),
      ...(options.target === 'head' ? [dismissalControl(finding.details.fingerprint)] : []),
    ]
  }).join('\n').replace(/<details><summary><b>\d+ follow-ups?<\/b> · none block merge<\/summary>\n([\s\S]*?)<\/details>/g, (_block, content: string) => {
    // A row moved to its inline thread leaves the fold, so the count follows.
    const count = [...content.matchAll(/^- `\d+` /gm)].length
    return count === 0 ? '' : `<details><summary><b>${plural(count, 'follow-up')}</b> · none block merge</summary>\n${content}</details>`
  }).replace(/<details>\n<summary>Logged findings \(\d+\)<\/summary>\n([\s\S]*?)<\/details>/g, (_block, content: string) => {
    const count = [...content.matchAll(/^- \*\*Logged \(/gm)].length
    return count === 0 ? '' : `<details>\n<summary>Logged findings (${count})</summary>\n${content}</details>`
  }).replace(/\n{3,}/g, '\n\n').trimEnd()
  if (options.target === undefined || !/ {2}- \[ \] (?:Ask an agent to verify and fix this finding|Dismiss this finding)/.test(decorated))
    return decorated
  const pickupHint = options.target === 'head'
    ? [options.baseRef === undefined ? '' : loggedFindingBaseMarker(options.baseRef), onHeadPickupHint].filter(Boolean).join('\n')
    : afterMergePickupHint
  // The footer stays last, so the hint goes above it.
  const footer = decorated.split('\n').at(-1)
  return footer !== undefined && isCanonicalFooter(footer)
    ? `${decorated.slice(0, -footer.length)}${pickupHint}\n\n${footer}`
    : `${decorated}\n\n${pickupHint}`
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function checkedFindings(before: string, after: string, pattern: RegExp, checkGroup: number, fingerprintGroup: number): string[] | null {
  const edited = [...after.matchAll(pattern)]
  const checked = new Set<string>()
  for (const [index, match] of [...before.matchAll(pattern)].entries()) {
    const next = edited[index]
    const fingerprint = match[fingerprintGroup]
    if (next === undefined || fingerprint === undefined || match[checkGroup] === next[checkGroup])
      continue
    if (match[checkGroup] !== ' ' || next[checkGroup] === ' ')
      return null
    checked.add(fingerprint)
  }
  return [...checked]
}

/** Accepts only unchecked to checked transitions, without any other body edit. */
export function loggedFindingPickup(event: string, payload: unknown): LoggedFindingPickup | null {
  const input = object(payload)
  const inline = event === 'pull_request_review_comment'
  if ((!inline && event !== 'issue_comment') || input.action !== 'edited')
    return null
  const comment = object(input.comment)
  const before = object(object(input.changes).body).from
  const after = comment.body
  if (typeof before !== 'string' || typeof after !== 'string' || !before.includes(AUTOMATED_REVIEW_MARKER)
    || normalizeLoggedFindingControls(before) !== normalizeLoggedFindingControls(after)) {
    return null
  }
  const fingerprints = checkedFindings(before, after, controlPattern, 2, 3)
  const dismissed = checkedFindings(before, after, dismissalPattern, 1, 2)
  if (fingerprints === null || dismissed === null || fingerprints.some(fingerprint => dismissed.includes(fingerprint))
    || (inline && (fingerprints.length !== 1 || dismissed.length !== 0 || comment.in_reply_to_id != null))) {
    return null
  }
  const headSha = automatedReviewHead(before)
  const repository = object(input.repository).full_name
  const issue = object(inline ? input.pull_request : input.issue)
  const requestedBy = object(input.sender).login
  const commentAuthor = object(comment.user).login
  if (fingerprints.length + dismissed.length === 0 || headSha === undefined || typeof repository !== 'string'
    || typeof issue.number !== 'number' || !Number.isSafeInteger(issue.number) || issue.number <= 0
    || (!inline && issue.pull_request === undefined) || typeof comment.id !== 'number' || !Number.isSafeInteger(comment.id) || comment.id <= 0
    || typeof requestedBy !== 'string' || typeof commentAuthor !== 'string') {
    return null
  }
  return { repository, pullRequestNumber: issue.number, headSha, commentId: comment.id, requestedBy, commentAuthor, fingerprints, before, ...(inline ? { inline: true } : {}), ...(dismissed.length === 0 ? {} : { dismissedFingerprints: dismissed }) }
}
