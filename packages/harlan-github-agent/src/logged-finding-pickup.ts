import type { ReviewFinding } from './types.ts'
import { AUTOMATED_REVIEW_MARKER, automatedReviewHead } from './review-comment.ts'
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
  before: string
}

export interface LoggedFindingStatus {
  fingerprint: string
  status: string
}

const pickupHint = 'Selected findings run after merge and open separate pull requests.'
const controlPattern = /^ {2}- \[([ xX])\] Ask an agent to verify and fix this finding <!-- logged-finding: ([a-f\d]{64}) -->$/gm
const statusPattern = /^ {2}(?:- \[[ xX]\] Ask an agent to verify and fix this finding|Repair: [^\n]+) <!-- logged-finding: [a-f\d]{64} -->\n?/gm

/** Removes controller decorations when another canonical writer compares its source body. */
export function withoutLoggedFindingControls(body: string): string {
  return body.replace(statusPattern, '').split('\n').filter(line => line !== pickupHint).join('\n').trimEnd()
}

export function normalizeLoggedFindingControls(body: string): string {
  return body.replace(controlPattern, (_line, _checked, fingerprint: string) => control(fingerprint))
}

function control(fingerprint: string): string {
  return `  - [ ] Ask an agent to verify and fix this finding <!-- logged-finding: ${fingerprint} -->`
}

/** Adds one control beside each recorded finding. Task status replaces its control. */
export function withLoggedFindingControls(body: string, findings: readonly ReviewFinding[], statuses: readonly LoggedFindingStatus[]): string {
  const lines = withoutLoggedFindingControls(body).split('\n')
  const rendered = new Set<string>()
  const decorated = lines.flatMap((line) => {
    const finding = findings.find((finding): finding is LoggedReviewFinding => finding._tag === 'Logged'
      && /^[a-f\d]{64}$/.test(finding.details.fingerprint)
      && !rendered.has(finding.details.fingerprint)
      && line.startsWith('- ') && line.includes(`Logged (${finding.impact}/100)`)
      && line.includes(cleanLine(finding.summary)))
    if (finding === undefined)
      return [line]
    rendered.add(finding.details.fingerprint)
    const status = statuses.find(status => status.fingerprint === finding.details.fingerprint)
    return [line, status === undefined
      ? control(finding.details.fingerprint)
      : `  Repair: ${status.status.replace(/\s+/g, ' ').trim()} <!-- logged-finding: ${finding.details.fingerprint} -->`]
  }).join('\n')
  return decorated.includes('Ask an agent to verify and fix this finding') ? `${decorated}\n\n${pickupHint}` : decorated
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/** Accepts only unchecked to checked transitions, without any other body edit. */
export function loggedFindingPickup(event: string, payload: unknown): LoggedFindingPickup | null {
  const input = object(payload)
  if (event !== 'issue_comment' || input.action !== 'edited')
    return null
  const comment = object(input.comment)
  const before = object(object(input.changes).body).from
  const after = comment.body
  if (typeof before !== 'string' || typeof after !== 'string' || !before.includes(AUTOMATED_REVIEW_MARKER)
    || normalizeLoggedFindingControls(before) !== normalizeLoggedFindingControls(after)) {
    return null
  }
  const unchecked = new Set([...before.matchAll(controlPattern)].filter(match => match[1] === ' ').map(match => match[2]))
  const fingerprints = [...new Set([...after.matchAll(controlPattern)].filter(match => match[1] !== ' ' && unchecked.has(match[2])).map(match => match[2]!))]
  const headSha = automatedReviewHead(before)
  const repository = object(input.repository).full_name
  const issue = object(input.issue)
  const requestedBy = object(input.sender).login
  const commentAuthor = object(comment.user).login
  if (fingerprints.length === 0 || headSha === undefined || typeof repository !== 'string'
    || typeof issue.number !== 'number' || !Number.isSafeInteger(issue.number) || issue.number <= 0
    || issue.pull_request === undefined || typeof comment.id !== 'number' || !Number.isSafeInteger(comment.id) || comment.id <= 0
    || typeof requestedBy !== 'string' || typeof commentAuthor !== 'string') {
    return null
  }
  return { repository, pullRequestNumber: issue.number, headSha, commentId: comment.id, requestedBy, commentAuthor, fingerprints, before }
}
