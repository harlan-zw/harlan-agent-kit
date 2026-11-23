import type { ReviewFinding } from './types.ts'
import { Buffer } from 'node:buffer'
import { AUTOMATED_REVIEW_MARKER, automatedReviewHead, FOLLOW_UP_GROUP_LABEL, FOLLOW_UP_ROW_MARKER, FOLLOW_UP_STATUS_LIMIT, isCanonicalFooter, listedFollowUp, plural } from './review-comment.ts'
import { cleanLine } from './text.ts'

export type LoggedReviewFinding = Extract<ReviewFinding, { _tag: 'Logged' }>

interface PickupSource {
  repository: string
  pullRequestNumber: number
  headSha: string
  commentId: number
  requestedBy: string
  commentAuthor: string
  before: string
  inline?: true
}

/**
 * One isolated tick on a published follow-up control.
 *
 * `Findings` names the follow-ups ticked for Repair on the head, for an
 * issue, or for Dismissal. `MergedFollowUps` is the one control on a Merged
 * comment that files every unfixed follow-up as one issue.
 */
export type LoggedFindingPickup = PickupSource & (
  | { _tag: 'Findings', fingerprints: string[], issueFingerprints?: string[], dismissedFingerprints?: string[] }
  | { _tag: 'MergedFollowUps' }
)

/**
 * The progress one follow-up shows in place of its control.
 *
 * `IssueRefused` is an issue GitHub refused for good. It shows the refusal,
 * but it owns nothing, so the finding stays unfixed for the Merged issue.
 */
export type LoggedFindingStatus
  = | { _tag: 'Repair', fingerprint: string, status: string, cancellable: boolean }
    | { _tag: 'Issue', fingerprint: string, status: string }
    | { _tag: 'IssueRefused', fingerprint: string, status: string }

/**
 * Where a tick sends one follow-up on an open pull request.
 *
 * `Repair` fixes it on this branch before merge. `Issue` files it, so Issue
 * triage picks it up and Harlan's review queue does not grow.
 */
export type FollowUpRoute = 'Repair' | 'Issue'

/**
 * Routes one follow-up by who owns its fix.
 *
 * Only a finding on a line this change added goes to Repair, and only where
 * Repair may write this head. Every other finding, an unknown Finding scope
 * included, becomes an issue.
 */
export function followUpRoute(finding: LoggedReviewFinding, repairOnHead: boolean): FollowUpRoute {
  return finding.details.scope === 'change' && repairOnHead ? 'Repair' : 'Issue'
}

/**
 * The follow-up controls one canonical comment offers.
 *
 * An open pull request offers one control per follow-up. A merged one offers
 * a single control that files every unfixed follow-up as one issue.
 */
export type FollowUpControls
  = | { _tag: 'Open', repairOnHead: boolean }
    | { _tag: 'Merged', headSha: string }

/** The words that told a reader a selection would wait for merge, from comments written before fix before merge. */
const afterMergePickupHint = 'Selected findings run after merge and open separate pull requests.'
/** The words that told a reader a selection ran on the head, from comments written before the follow-up groups. */
const onHeadPickupHint = 'Selected findings run on this pull request.'
const REPAIR_CONTROL = 'Ask an agent to verify and fix this finding'
const ISSUE_CONTROL = 'File this finding as an issue'
const MERGED_CONTROL = 'File these as one issue'
const controlPattern = /^( {0,2})- \[([ xX])\] Ask an agent to verify and fix this finding <!-- logged-finding: ([a-f\d]{64}) -->$/gm
const issuePattern = /^( {0,2})- \[([ xX])\] File this finding as an issue <!-- logged-finding: ([a-f\d]{64}) -->$/gm
const dismissalPattern = /^ {2}- \[([ xX])\] Dismiss this finding <!-- dismiss-logged-finding: ([a-f\d]{64}) -->$/gm
const mergedPattern = /^- \[([ xX])\] File these as one issue <!-- logged-findings: ([a-f\d]{40,64}) -->$/gm
/** Every line a decoration adds under a follow-up row: a control, a Dismiss control, or a status. */
const rowDecorationPattern = /^ {2}[^\n]* <!-- (?:dismiss-)?logged-finding: [a-f\d]{64} -->\n?/gm
/** The Merged control, or its status, above the footer. */
const mergedDecorationPattern = /\n\n[^\n]* <!-- logged-findings: [a-f\d]{40,64} -->(?=\n|$)/g

const threadLinkText = 'Open the thread beside the code'

const tickSentence: Record<FollowUpRoute, string> = {
  Repair: 'Tick to have Repair fix it here, before merge.',
  Issue: 'Tick to file it as an issue.',
}

/** Removes controller decorations when another canonical writer compares its source body. */
export function withoutLoggedFindingControls(body: string): string {
  return body
    .replace(rowDecorationPattern, '')
    .replace(mergedDecorationPattern, '')
    .replace(/^<!-- finding-base: [\w-]+ -->\n(?=Selected findings run)/gm, '')
    .replaceAll(`\n\n${afterMergePickupHint}`, '')
    .replaceAll(`\n\n${onHeadPickupHint}`, '')
    .replace(/\n\n<!-- finding-base: [\w-]+ -->(?=\n|$)/g, '')
    .split('\n')
    .filter(line => line !== afterMergePickupHint && line !== onHeadPickupHint)
    // A group label carries its tick sentence only while its rows carry controls.
    .map(line => FOLLOW_UP_GROUP_LABEL.exec(line)?.[0] ?? line)
    .join('\n')
    .trimEnd()
}

export function normalizeLoggedFindingControls(body: string): string {
  return body.replaceAll('\r\n', '\n')
    .replace(controlPattern, (_line, indent: string, _checked, fingerprint: string) => `${indent}${loggedFindingControl(fingerprint)}`)
    .replace(issuePattern, (_line, indent: string, _checked, fingerprint: string) => `${indent}${loggedFindingControl(fingerprint, 'Issue')}`)
    .replace(dismissalPattern, (_line, _checked, fingerprint: string) => dismissalControl(fingerprint))
    .replace(mergedPattern, (_line, _checked, headSha: string) => mergedFollowUpsControl(headSha))
}

/** The checkbox that sends one follow-up where its route goes. */
export function loggedFindingControl(fingerprint: string, route: FollowUpRoute = 'Repair'): string {
  return `- [ ] ${route === 'Repair' ? REPAIR_CONTROL : ISSUE_CONTROL} <!-- logged-finding: ${fingerprint} -->`
}

/** The one checkbox on a Merged comment that files every unfixed follow-up as one issue. */
export function mergedFollowUpsControl(headSha: string): string {
  return `- [ ] ${MERGED_CONTROL} <!-- logged-findings: ${headSha} -->`
}

export function loggedFindingBaseMarker(baseRef: string): string {
  return `<!-- finding-base: ${Buffer.from(baseRef, 'utf8').toString('base64url')} -->`
}

function dismissalControl(fingerprint: string): string {
  return `  - [ ] Dismiss this finding <!-- dismiss-logged-finding: ${fingerprint} -->`
}

/**
 * Each follow-up that has an owner, by fingerprint, to the kind of work that owns it.
 *
 * A Repair selection owns its finding, dismissed or not, and so does an
 * issue filed or on its way. One finding never gets both kinds of work, and
 * a finding with an owner gets no control. An issue GitHub refused for good
 * owns nothing.
 */
export function followUpOwners(statuses: readonly LoggedFindingStatus[]): Map<string, 'Repair' | 'Issue'> {
  return new Map(statuses.flatMap(status => status._tag === 'IssueRefused' ? [] : [[status.fingerprint, status._tag] as const]))
}

/**
 * The follow-ups the Merged control would file: listed, and with no owner.
 *
 * An owner is a Repair selected before merge, an issue filed or on its way,
 * or a Dismissal. An issue GitHub refused for good owns nothing, so the
 * Merged issue is its fallback.
 */
export function unfixedFollowUps(findings: readonly ReviewFinding[], statuses: readonly LoggedFindingStatus[]): LoggedReviewFinding[] {
  const owned = followUpOwners(statuses)
  return findings.filter((finding): finding is LoggedReviewFinding => listedFollowUp(finding)
    && /^[a-f\d]{64}$/.test(finding.details.fingerprint)
    && !owned.has(finding.details.fingerprint))
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

/**
 * One status on one line, cut to `FOLLOW_UP_STATUS_LIMIT`.
 *
 * A Repair's evidence can be a whole Agent summary. The canonical body keeps
 * a fixed room per row for its status, so the verdict always fits GitHub's limit.
 */
function statusText(status: string): string {
  const line = status.replace(/\s+/g, ' ').trim()
  return line.length <= FOLLOW_UP_STATUS_LIMIT ? line : `${line.slice(0, FOLLOW_UP_STATUS_LIMIT - 1).trimEnd()}…`
}

/** Puts one block above the footer, which stays last. */
function aboveFooter(body: string, block: string): string {
  const footer = body.split('\n').at(-1)
  return footer !== undefined && isCanonicalFooter(footer)
    ? `${body.slice(0, -footer.length)}${block}\n\n${footer}`
    : `${body}\n\n${block}`
}

/**
 * Adds each follow-up's control or status, and the sentence that says what a tick does.
 *
 * A group label gets its sentence only when a row under it got a control.
 * A merged pull request gets one control for every unfixed follow-up.
 * `withoutLoggedFindingControls` undoes every decoration exactly.
 */
export function withLoggedFindingControls(body: string, findings: readonly ReviewFinding[], statuses: readonly LoggedFindingStatus[], options: {
  controls?: FollowUpControls | undefined
  /**
   * Findings whose thread opened beside the code, by fingerprint, to that thread's URL.
   *
   * The row stays, so the fold keeps the count the native review shows, and
   * the thread link replaces the control: the thread carries its own.
   */
  inline?: ReadonlyMap<string, string>
  baseRef?: string | undefined
  /** The Merged issue's status, which replaces its control once ticked. */
  mergedIssue?: string | undefined
} = {}): string {
  const lines = withoutLoggedFindingControls(body).split('\n')
  // A row names its finding with a marker. A body stored before the marker
  // has none, so its rows still match by score and title.
  const marked = lines.some(line => FOLLOW_UP_ROW_MARKER.test(line))
  const rendered = new Set<string>()
  const open = options.controls?._tag === 'Open' ? options.controls : undefined
  const groupRoutes = new Map<number, FollowUpRoute>()
  let group: number | null = null
  let offered = false
  const decorated: string[] = []
  for (const line of lines) {
    if (FOLLOW_UP_GROUP_LABEL.test(line))
      group = decorated.length
    else if (line === '</details>')
      group = null
    const rowFingerprint = FOLLOW_UP_ROW_MARKER.exec(line)?.[1]
    const finding = findings.find((finding): finding is LoggedReviewFinding => finding._tag === 'Logged'
      && /^[a-f\d]{64}$/.test(finding.details.fingerprint)
      && !rendered.has(finding.details.fingerprint)
      && (marked ? rowFingerprint === finding.details.fingerprint : loggedFindingRow(line, finding)))
    if (finding === undefined) {
      decorated.push(line)
      continue
    }
    const fingerprint = finding.details.fingerprint
    rendered.add(fingerprint)
    const status = statuses.find(status => status.fingerprint === fingerprint)
    if (status !== undefined) {
      decorated.push(line, status._tag === 'Repair'
        ? `  Repair: ${statusText(status.status)} <!-- logged-finding: ${fingerprint} -->`
        : `  ${statusText(status.status)} <!-- logged-finding: ${fingerprint} -->`)
      if (open !== undefined && status._tag === 'Repair' && status.cancellable)
        decorated.push(dismissalControl(fingerprint))
      continue
    }
    decorated.push(line)
    // The thread beside the code carries its own control, so the row links it instead.
    const thread = options.inline?.get(fingerprint)
    if (thread !== undefined) {
      decorated.push(`  [${threadLinkText}](${thread}) <!-- logged-finding: ${fingerprint} -->`)
      continue
    }
    if (open === undefined)
      continue
    const route = followUpRoute(finding, open.repairOnHead)
    decorated.push(`  ${loggedFindingControl(fingerprint, route)}`, ...(route === 'Repair' ? [dismissalControl(fingerprint)] : []))
    offered = true
    if (group !== null)
      groupRoutes.set(group, route)
  }
  for (const [index, route] of groupRoutes)
    decorated[index] = `${decorated[index]} ${tickSentence[route]}`
  const settled = decorated.join('\n').replace(/<details><summary><b>\d+ follow-ups?<\/b> · none block merge<\/summary>\n([\s\S]*?)<\/details>/g, (_block, content: string) => {
    // A row moved to its inline thread leaves the fold, so the count follows.
    const count = [...content.matchAll(/^- `\d+` /gm)].length
    return count === 0 ? '' : `<details><summary><b>${plural(count, 'follow-up')}</b> · none block merge</summary>\n${content}</details>`
  }).replace(/<details>\n<summary>Logged findings \(\d+\)<\/summary>\n([\s\S]*?)<\/details>/g, (_block, content: string) => {
    const count = [...content.matchAll(/^- \*\*Logged \(/gm)].length
    return count === 0 ? '' : `<details>\n<summary>Logged findings (${count})</summary>\n${content}</details>`
  }).replace(/\n{3,}/g, '\n\n').trimEnd()
  if (options.controls?._tag === 'Merged') {
    const { headSha } = options.controls
    if (options.mergedIssue !== undefined)
      return aboveFooter(settled, `${options.mergedIssue.replace(/\s+/g, ' ').trim()} <!-- logged-findings: ${headSha} -->`)
    // A resolved thread dismissed its finding, so only the other rows need the issue.
    return unfixedFollowUps(findings, statuses).some(finding => rendered.has(finding.details.fingerprint) && options.inline?.has(finding.details.fingerprint) !== true)
      ? aboveFooter(settled, mergedFollowUpsControl(headSha))
      : settled
  }
  // The base marker binds the issued controls to the target branch they answer.
  return offered && options.baseRef !== undefined ? aboveFooter(settled, loggedFindingBaseMarker(options.baseRef)) : settled
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
  const issueFingerprints = checkedFindings(before, after, issuePattern, 2, 3)
  const dismissed = checkedFindings(before, after, dismissalPattern, 1, 2)
  const merged = checkedFindings(before, after, mergedPattern, 1, 2)
  if (fingerprints === null || issueFingerprints === null || dismissed === null || merged === null
    || fingerprints.some(fingerprint => dismissed.includes(fingerprint) || issueFingerprints.includes(fingerprint))
    || (merged.length > 0 && (inline || fingerprints.length + issueFingerprints.length + dismissed.length > 0))
    || (inline && (fingerprints.length + issueFingerprints.length !== 1 || dismissed.length !== 0 || comment.in_reply_to_id != null))) {
    return null
  }
  const headSha = automatedReviewHead(before)
  const repository = object(input.repository).full_name
  const issue = object(inline ? input.pull_request : input.issue)
  const requestedBy = object(input.sender).login
  const commentAuthor = object(comment.user).login
  if (fingerprints.length + issueFingerprints.length + dismissed.length + merged.length === 0 || headSha === undefined || typeof repository !== 'string'
    || typeof issue.number !== 'number' || !Number.isSafeInteger(issue.number) || issue.number <= 0
    || (!inline && issue.pull_request === undefined) || typeof comment.id !== 'number' || !Number.isSafeInteger(comment.id) || comment.id <= 0
    || typeof requestedBy !== 'string' || typeof commentAuthor !== 'string') {
    return null
  }
  const source = { repository, pullRequestNumber: issue.number, headSha, commentId: comment.id, requestedBy, commentAuthor, before, ...(inline ? { inline: true as const } : {}) }
  if (merged.length > 0)
    return merged.length === 1 && merged[0] === headSha ? { ...source, _tag: 'MergedFollowUps' } : null
  return {
    ...source,
    _tag: 'Findings',
    fingerprints,
    ...(issueFingerprints.length === 0 ? {} : { issueFingerprints }),
    ...(dismissed.length === 0 ? {} : { dismissedFingerprints: dismissed }),
  }
}
