import type { Token } from 'marked'
import type { GitHubIssuePublisher } from './github.ts'
import type { Result } from './result.ts'
import type { CheckinVerdict } from './routines/contract.ts'
import type { JournalStore } from './store.ts'
import type { Candidate, ClaimedRoutineReportCommand, GitHubAccount, ReportedCandidate, RoutineName, RoutineReportCommand, RoutineRun, RunLogEntry } from './types.ts'
import { Lexer } from 'marked'
import { routineIssueLabel } from './candidate-issue-controller.ts'
import { githubAccountBody } from './github-account.ts'
import { err, ok } from './result.ts'
import { MAXIMUM_REPORT_DETAIL_LENGTH } from './routines/contract.ts'
import { cleanLine, cleanText } from './text.ts'

/** The issue every run of one Routine reports to. */
export function trackingIssueTitle(name: RoutineName, repository: string): string {
  return `${name}: run log for ${repository}`
}

function trackingIssueBodyText(name: string): string {
  return `Every run of the \`${name}\` routine reports here, including runs that found nothing. A run that was skipped or had nothing to check writes nothing here. The Dashboard lists it.

Close a proposal's own issue to reject it. Closing this one stops the log, not the routine.

> The Harlan Agent Kit opened this issue automatically. It is not Harlan's own report.`
}

/**
 * The body tracking issues carried while skipped runs still reported.
 *
 * Recognition compares the whole body, and GitHub keeps every issue opened
 * with it. Without this text, the next report would open a second run log.
 */
function legacyTrackingIssueBodyText(name: string): string {
  return `Every run of the \`${name}\` routine reports here, including the runs that found nothing and the runs that were skipped.

Close a proposal's own issue to reject it. Closing this one stops the log, not the routine.

> The Harlan Agent Kit opened this issue automatically. It is not Harlan's own report.`
}

export function trackingIssueBody(name: RoutineName): string {
  return trackingIssueBodyText(name)
}

/** Stable identity for one Run report comment. */
export function routineRunMarker(runId: string): string {
  return `<!-- routine-run: ${runId} -->`
}

/** Recognises a run log even when another controller filed it. */
export function isRoutineTrackingIssue(input: {
  repository: string
  account?: GitHubAccount | undefined
  title: string
  body: string | null | undefined
  labels: readonly string[]
}): boolean {
  if (input.labels.includes('routine:daily-checkin')) {
    if (input.body?.startsWith(`<!-- routine-log: ${input.repository}:daily-checkin -->\n`))
      return true
    const runId = input.body?.match(/^<!-- routine-run: (.+) -->\n/)?.[1]
    if (runId?.startsWith(`${input.repository}:daily-checkin:`) && (input.body === dailyCheckinIssueBody(runId) || input.body === githubAccountBody(dailyCheckinIssueBody(runId), input.account)))
      return true
  }
  const prefix = 'routine:'
  return input.labels.some((label) => {
    if (!label.toLowerCase().startsWith(prefix))
      return false
    const routineName = label.slice(prefix.length)
    return routineName.length > 0
      && input.title.toLowerCase() === `${routineName}: run log for ${input.repository}`.toLowerCase()
      && [trackingIssueBodyText(routineName), legacyTrackingIssueBodyText(routineName)]
        .some(body => input.body === body || input.body === githubAccountBody(body, input.account))
  })
}

/**
 * One status for both the issue title and the comment heading.
 *
 * The run's stated verdict decides it. Reading the status back out of the
 * report prose does not work: a report that opens with a Markdown heading
 * carries no verdict on its first line, and a verdict ending "no incomplete
 * coverage" matches a keyword scan for incomplete. Both shipped on 2026-09-15
 * and every one of the eight daily titles read BLOCKED, GREEN mornings
 * included. A run that states no verdict is BLOCKED, because an unstated
 * status is exactly what a reader cannot act on.
 *
 * The run's Candidates fold in later, when the report is claimed, because a
 * retry can record Candidates after the report was staged.
 */
function dailyCheckinStatus(report: RoutineRunReport): 'CLEAR' | 'ACTION NEEDED' | 'BLOCKED' {
  if (report._tag !== 'Scanned' || report.verdict === undefined)
    return 'BLOCKED'
  if (report.verdict.coverage === 'incomplete')
    return 'BLOCKED'
  return report.verdict.severity === 'GREEN' ? 'CLEAR' : 'ACTION NEEDED'
}

const CLEAR_DAILY_HEADING = /^# \[CLEAR\] (Daily check-in: \d{4}-\d{2}-\d{2})$/m

/**
 * Refolds the run's current Candidates into the staged daily heading.
 *
 * The heading is derived when the report is staged, but a retried run can
 * record Candidates after that stage, and its re-stage is a no-op on the run's
 * identity. Claiming refolds the run's Candidates in, so the issue title and
 * the comment body, which both come from this claimed body, read the same
 * status as the proposal block the comment lists: a clear morning with open
 * proposals reads as ACTION NEEDED everywhere.
 */
export function foldCandidatesIntoDailyHeading(body: string, candidates: readonly Candidate[]): string {
  if (candidates.length === 0)
    return body
  return body.replace(CLEAR_DAILY_HEADING, '# [ACTION NEEDED] $1')
}

function dailyCheckinIssueBody(runId: string): string {
  return `${routineRunMarker(runId)}
One daily check-in. The report follows in a comment.

Link existing issues for ongoing work. Update the title status when the findings change.
Close this issue when its actions are resolved or tracked in linked issues.

> Harlan Agent Kit wrote this automated report.`
}

type ScannedEntry = Extract<RunLogEntry, { _tag: 'Scanned' }>

/** What one scan counted, before the controller writes anything. */
export type RoutineScanTally = Pick<ScannedEntry, 'found' | 'fresh' | 'known' | 'outsideScope' | 'oversized' | 'fingerprints'>

/**
 * What one finished run did, in the words the log records.
 *
 * A skipped run has no variant. A run that did nothing writes nothing, and the
 * Dashboard keeps the skipped run itself.
 */
export type RoutineRunReport
  = | {
    _tag: 'Scanned'
    /** The archive's one-line count summary, also kept as the run's evidence. */
    evidence: string
    tally: RoutineScanTally
    detail?: string
    verdict?: CheckinVerdict
  }
  | { _tag: 'ReadyDigest', evidence: string, total: number, list: string }
  | { _tag: 'Failed', reason: string }

/**
 * Writes one run's line in the private archive.
 *
 * A run that found nothing says so. That is the whole point: without it a quiet
 * morning and a broken scheduler read exactly the same, which is nothing at all.
 */
function candidateDetails(candidates: readonly Candidate[]): string {
  if (candidates.length === 0)
    return ''
  return `\n\n${candidates.map(candidate => `${candidate.claim}

**Target:** \`${candidate.target}\`

**Verify with:** \`${candidate.verification}\`

Estimated to change ${candidate.estimatedChangedFiles} ${candidate.estimatedChangedFiles === 1 ? 'file' : 'files'}.`).join('\n\n---\n\n')}`
}

export function routineReportBody(run: Pick<RoutineRun, 'scheduledFor'>, report: RoutineRunReport, candidates: readonly Candidate[] = []): string {
  const headline = report._tag === 'Failed' ? `Failed. ${report.reason}` : report.evidence
  // GitHub caps a comment at 65536 characters, and the Candidates follow.
  const detail = report._tag === 'Scanned' && report.detail !== undefined && report.detail !== ''
    ? `\n\n${report.detail.slice(0, MAXIMUM_REPORT_DETAIL_LENGTH)}`
    : report._tag === 'ReadyDigest' ? `\n\n${report.list}` : ''
  return `**${run.scheduledFor}** — ${headline}${detail}${candidateDetails(candidates)}`
}

/** The summary, paragraph breaks included, never passes this length. */
const MAXIMUM_SUMMARY_LENGTH = 600

/** Home, absolute, Windows, and file paths. A path needs two segments, so `and/or` and `/etc` pass. */
const PRIVATE_PATH = /~\/|\$HOME\b|%USERPROFILE%|file:\/\/|(?<![\w.~:/-])\/[\w.@-]+\/|\b[a-z]:\\|\[::1\]|\blocalhost\b/i
const URL_HOST = /\b[a-z][a-z\d+.-]*:\/\/(?:[^\s@/]+@)?(\[[^\]\s]+\]|[^\s/?#:)\]>'"`]+)/gi
const BARE_HOST = /(?<![\w.@/-])((?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z][a-z\d-]*)(?![\w-])/gi
const IPV4 = /(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?!\d)/g
const ADDRESS = /^\d{1,3}(?:\.\d{1,3}){3}$/
/** Suffixes that only name hosts on a private network. */
const PRIVATE_SUFFIXES = ['localhost', 'local', 'internal', 'lan', 'home.arpa', 'ts.net', 'corp', 'intranet'] as const

function isPrivateAddress(address: string): boolean {
  const [a = -1, b = -1] = address.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

function isPrivateHost(host: string, privateHosts: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (name === '::1' || (ADDRESS.test(name) && isPrivateAddress(name)))
    return true
  return [...PRIVATE_SUFFIXES, ...privateHosts.map(entry => entry.toLowerCase())]
    .some(suffix => name === suffix || name.endsWith(`.${suffix}`))
}

/**
 * Whether one line names a local path or a private host.
 *
 * The run log is public, and an Agent writes its report for the private
 * Dashboard. A link to a single-label host such as `http://hogwild:3210`, a
 * private address, a private-network suffix, or a host the configuration
 * names all count, with or without a scheme.
 */
function isPrivateLine(line: string, privateHosts: readonly string[]): boolean {
  if (PRIVATE_PATH.test(line))
    return true
  const linked = [...line.matchAll(URL_HOST)].map(match => match[1]!)
  if (linked.some(host => !host.includes('.') || isPrivateHost(host, privateHosts)))
    return true
  if ([...line.matchAll(IPV4)].some(match => isPrivateAddress(match[1]!)))
    return true
  return [...line.matchAll(BARE_HOST)].some(match => isPrivateHost(match[1]!, privateHosts))
}

/** Drops every line that names a private detail, then every paragraph left empty. */
function publicProse(text: string, privateHosts: readonly string[]): string | null {
  const paragraphs = text.split(/\n\s*\n/)
    .map(paragraph => paragraph.split('\n').filter(line => !isPrivateLine(line, privateHosts)).join('\n').trim())
    .filter(paragraph => paragraph !== '')
  return paragraphs.length === 0 ? null : paragraphs.join('\n\n')
}

/** Remove parsed comments without treating code spans as HTML. */
function withoutComments(token: Token): string {
  if (token.type === 'html' && token.raw.startsWith('<!--'))
    return ''
  if (!('tokens' in token) || !Array.isArray(token.tokens))
    return token.raw
  let result = ''
  let offset = 0
  for (const child of token.tokens as Token[]) {
    const index = token.raw.indexOf(child.raw, offset)
    // If a child has no source range, omit this paragraph rather than expose it.
    if (index < 0)
      return ''
    result += token.raw.slice(offset, index) + withoutComments(child)
    offset = index + child.raw.length
  }
  return result + token.raw.slice(offset)
}

/**
 * The opening prose of an Agent report, short enough to fold into the log.
 *
 * The Markdown is parsed before any line is filtered, so a removed line cannot
 * move a block boundary. Only top-level paragraphs before the first other
 * block qualify. A heading, table, or list ends the summary, even before prose.
 * A leading title has no exception. Quoted, fenced, and HTML evidence never qualifies.
 * HTML blocks end extraction. Markdown tokens cannot prove that nested HTML has closed.
 * Parsed comments are removed within each paragraph.
 * The original tokens decide boundaries, even when redaction removes all prose.
 * A line that names a private path or host drops out. A paragraph that would
 * pass the limit ends the summary, because a cut sentence can break its Markdown.
 */
function reportSummary(detail: string): string | null {
  const kept: string[] = []
  let length = 0
  let sawParagraph = false
  for (const token of Lexer.lex(detail)) {
    if (token.type === 'space')
      continue
    if (token.type !== 'paragraph') {
      if (sawParagraph || token.type !== 'code')
        break
      continue
    }
    sawParagraph = true
    const text = publicProse(cleanText(withoutComments(token)).replaceAll(/<\/?details>/gi, ''), [])
    if (text === null)
      continue
    const next = length + (kept.length === 0 ? 0 : 2) + text.length
    if (next > MAXIMUM_SUMMARY_LENGTH)
      break
    kept.push(text)
    length = next
  }
  return kept.length === 0 ? null : kept.join('\n\n')
}

function runLogEntry(report: RoutineRunReport): RunLogEntry {
  switch (report._tag) {
    case 'Scanned':
      return {
        _tag: 'Scanned',
        ...report.tally,
        fingerprints: [...new Set(report.tally.fingerprints)],
        verdict: report.verdict ?? null,
        summary: reportSummary(report.detail ?? ''),
      }
    case 'ReadyDigest':
      return { _tag: 'ReadyDigest', total: report.total, list: report.list }
    case 'Failed':
      return { _tag: 'Failed', reason: report.reason }
  }
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function parseVerdict(value: unknown): CheckinVerdict | null | undefined {
  if (value === null)
    return null
  if (!isRecord(value))
    return undefined
  const { severity, coverage } = value
  return (severity === 'GREEN' || severity === 'AMBER' || severity === 'RED') && (coverage === 'complete' || coverage === 'incomplete')
    ? { severity, coverage }
    : undefined
}

/**
 * Reads a stored entry back. The column holds valid JSON by constraint; its
 * shape is checked here. Null, or a shape this version does not know, leaves
 * the report on its archive body.
 */
export function parseRunLogEntry(text: string | null): RunLogEntry | null {
  if (text === null)
    return null
  const value: unknown = JSON.parse(text)
  if (!isRecord(value))
    return null
  switch (value._tag) {
    case 'Failed':
      return typeof value.reason === 'string' ? { _tag: 'Failed', reason: value.reason } : null
    case 'ReadyDigest':
      return isCount(value.total) && typeof value.list === 'string' ? { _tag: 'ReadyDigest', total: value.total, list: value.list } : null
    case 'Scanned': {
      const { found, fresh, known, outsideScope, oversized, fingerprints, summary } = value
      const verdict = parseVerdict(value.verdict)
      const limit = oversized === null
        ? null
        : isRecord(oversized) && isCount(oversized.limit) && isCount(oversized.count) ? { limit: oversized.limit, count: oversized.count } : undefined
      if (!isCount(found) || !isCount(fresh) || !isCount(known) || !isCount(outsideScope) || limit === undefined || verdict === undefined
        || !Array.isArray(fingerprints) || !fingerprints.every(fingerprint => typeof fingerprint === 'string')
        || (summary !== null && typeof summary !== 'string')) {
        return null
      }
      return { _tag: 'Scanned', found, fresh, known, outsideScope, oversized: limit, fingerprints, verdict, summary }
    }
    default:
      return null
  }
}

/** Builds the report command one finished run owes its log. */
export function routineReportCommand(input: {
  repository: string
  routineId: string
  routineName: RoutineName
  run: Pick<RoutineRun, 'id' | 'scheduledFor'>
  report: RoutineRunReport
}): RoutineReportCommand {
  return {
    id: `${input.run.id}:report`,
    routineId: input.routineId,
    runId: input.run.id,
    repository: input.repository,
    routineName: input.routineName,
    verdict: input.report._tag === 'Scanned' ? input.report.verdict ?? null : null,
    body: `${routineRunMarker(input.run.id)}\n${input.routineName === 'daily-checkin'
      ? `# [${dailyCheckinStatus(input.report)}] Daily check-in: ${input.run.scheduledFor.slice(0, 10)}\n\n`
      : ''}${routineReportBody(input.run, input.report)}`,
    entry: runLogEntry(input.report),
  }
}

const KIT_LINK = '[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit)'
const POLICY_LINK = '[AI policy](https://harlanzw.com/blog/ai-in-open-source)'
const RUN_LOG_FOOTER = `<sub>${KIT_LINK} posted this automated Routine report, not Harlan. ${POLICY_LINK}.</sub>`

/** 🟠 when a person must act on the run; ⚪ for a quiet run. */
const DOT = { act: '🟠', quiet: '⚪' } as const

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** `2026-11-22T23:00:00.000Z` → `Nov 22, 23:00 UTC`. GitHub dates the comment, so the year adds nothing. */
function utcLabel(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime()))
    return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}, ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/** A `#123` or `@login` written by an Agent would link or notify every week. */
const REFERENCE = /(?<![\w/])(?:[\w.-]+\/[\w.-]+)?#\d+|\B@[\w-]+/g

/**
 * One line of Agent or provider text, safe inside a table cell.
 *
 * Code spans keep GitHub from linking a reference or notifying a login, and
 * an escaped pipe keeps the cell whole.
 */
function tableText(value: string): string {
  return cleanLine(value)
    .split(/(`[^`]*`)/)
    .map((part, index) => index % 2 === 1 ? part : part.replaceAll(REFERENCE, match => `\`${match}\``))
    .join('')
    .replaceAll('|', '\\|')
}

/** A cell whose text names a private path or host prints the fallback instead. */
function publicCell(value: string | null, privateHosts: readonly string[], fallback: string): string {
  return value === null || cleanLine(value) === '' || isPrivateLine(cleanLine(value), privateHosts) ? fallback : tableText(value)
}

/** Who holds one Candidate now. A filed issue wins, because it carries the evidence. */
function ownerCell(candidate: ReportedCandidate): string {
  if (candidate.issue._tag === 'Filed')
    return `#${candidate.issue.number}`
  switch (candidate.result._tag) {
    case 'Merged':
      return candidate.result.pullRequest > 0 ? `#${candidate.result.pullRequest}` : 'merged'
    case 'Rejected':
      return 'rejected'
    case 'Superseded':
      return 'superseded'
    case 'Proposed':
      if (candidate.result.pullRequest !== null)
        return `#${candidate.result.pullRequest}`
  }
  switch (candidate.issue._tag) {
    case 'Requested':
      return 'issue queued'
    case 'Refused':
      return 'filing failed'
    case 'NotRequested':
      return 'no issue'
  }
}

function scannedLines(entry: ScannedEntry, reported: readonly ReportedCandidate[], privateHosts: readonly string[]): string[] {
  const counts = entry.verdict === null
    ? ['| Found | New | Known |', '| --: | --: | --: |', `| ${entry.found} | ${entry.fresh} | ${entry.known} |`]
    : ['| Found | New | Known | Coverage |', '| --: | --: | --: | :-- |', `| ${entry.found} | ${entry.fresh} | ${entry.known} | ${entry.verdict.coverage} |`]
  const owners = reported.length === 0
    ? []
    : ['', '| Proposal | Owner |', '| :-- | :-- |', ...reported.map(candidate => `| ${publicCell(candidate.title, privateHosts, 'Untitled proposal')} | ${ownerCell(candidate)} |`)]
  const summary = entry.summary === null ? null : publicProse(entry.summary, privateHosts)
  // A Routine's rules drop work for several causes: scope, a per-run cap, or
  // an open issue that already holds it. The count alone carries no cause.
  const dropped = [
    ...(entry.outsideScope > 0 ? [`- This Routine's rules left out ${plural(entry.outsideScope, 'proposal')}.`] : []),
    ...(entry.oversized !== null && entry.oversized.count > 0 ? [`- ${plural(entry.oversized.count, 'proposal')} would change more than ${entry.oversized.limit} files.`] : []),
  ]
  return [
    ...counts,
    ...owners,
    ...(dropped.length === 0 ? [] : ['', '<details><summary>Dropped proposals</summary>', '', ...dropped, '', 'The run filed no issue for these proposals.', '', '</details>']),
    ...(summary === null ? [] : ['', '<details><summary>Summary</summary>', '', summary, '', 'The Dashboard History page keeps the full report.', '', '</details>']),
  ]
}

/**
 * Writes one run's entry in the public run log.
 *
 * A heading carries one dot and the run time. Tables carry the counts and the
 * issue that owns each Candidate. Only fields reach a table; the Agent's prose
 * reaches the log as a folded summary at most. The full report stays private.
 *
 * `privateHosts` names the Service's own hosts from configuration. Any text
 * that names one of them, a local path, or a private network host stays out.
 */
export function runLogEntryComment(command: Pick<ClaimedRoutineReportCommand, 'runId' | 'routineName' | 'scheduledFor' | 'reported'> & { entry: RunLogEntry, privateHosts?: readonly string[] }): string {
  const { entry } = command
  const privateHosts = command.privateHosts ?? []
  const when = utcLabel(command.scheduledFor)
  const lines = (dot: string, heading: string, body: readonly string[]): string =>
    [routineRunMarker(command.runId), `### ${dot} ${command.routineName} · ${heading}`, '', ...body, '', RUN_LOG_FOOTER].join('\n')
  switch (entry._tag) {
    case 'Failed':
      return lines(DOT.act, 'failed', ['| Run | Cause | Next |', '| :-- | :-- | :-- |', `| ${when} | ${publicCell(entry.reason, privateHosts, 'The Dashboard History page keeps this cause.')} | next scheduled run |`])
    case 'ReadyDigest':
      return lines(entry.total > 0 ? DOT.act : DOT.quiet, when, [entry.list])
    case 'Scanned': {
      const act = entry.fingerprints.length > 0 || (entry.verdict !== null && entry.verdict.severity !== 'GREEN')
      return lines(act ? DOT.act : DOT.quiet, when, scannedLines(entry, command.reported, privateHosts))
    }
  }
}

function dailyReportTitle(command: Pick<RoutineReportCommand, 'body' | 'repository'>): string {
  const status = command.body.match(/^# \[([^\]]+)\] Daily check-in:/m)?.[1] ?? 'BLOCKED'
  return `[${status}] Daily check-in: ${command.repository}`
}

function dailyReportBody(command: Pick<RoutineReportCommand, 'body' | 'routineId'> & { candidates: Candidate[] }): string {
  return `<!-- routine-log: ${command.routineId} -->
Harlan Agent Kit maintains this report automatically. Each run remains in the private archive.

${command.body}${candidateDetails(command.candidates)}`
}

/**
 * The comment one non-daily report writes.
 *
 * A report staged before run log entries had fields carries no entry, so its
 * archive body publishes the way it always did.
 */
function runComment(command: ClaimedRoutineReportCommand, privateHosts: readonly string[]): string {
  return command.entry === null
    ? `${command.body}${candidateDetails(command.candidates)}`
    : runLogEntryComment({ ...command, entry: command.entry, privateHosts })
}

export interface RoutineReportControllerOptions {
  /** Pending reports wait until the held GitHub quota becomes available. */
  canPublish?: () => boolean
  /** The Service's own host names from configuration. Run log text never names one. */
  privateHosts?: readonly string[]
  github: Pick<GitHubIssuePublisher, 'createComment' | 'createIssue' | 'updateIssue' | 'findIssueCommentByMarker' | 'findRoutineTrackingIssue'>
  leaseMilliseconds?: number
  now: () => Date
  store: Pick<JournalStore, 'claimNextRoutineReport' | 'completeRoutineReport' | 'failRoutineReport' | 'recordRoutineReportReceipt'>
  workerId: string
}

export interface RoutineReportController {
  publishPending: (signal: AbortSignal, limit?: number) => Promise<Array<Result<{ repository: string, issueNumber: number }, string>>>
}

/**
 * Writes pending run log entries, opening the tracking issue the first time.
 *
 * The issue number is stored only once the comment lands. A run that opened the
 * issue and then failed to comment would otherwise leave the Routine pointing
 * at an empty issue, and the retry would comment on it while the log claims the
 * run never reported.
 */
export function createRoutineReportController(options: RoutineReportControllerOptions): RoutineReportController {
  const leaseMilliseconds = options.leaseMilliseconds ?? 60_000
  const canPublish = options.canPublish ?? (() => true)

  return {
    publishPending: async (signal, limit = 3) => {
      const results: Array<Result<{ repository: string, issueNumber: number }, string>> = []
      const attemptedCommandIds: string[] = []
      for (let written = 0; written < limit; written += 1) {
        if (signal.aborted || !canPublish())
          return results
        const command = options.store.claimNextRoutineReport(
          options.workerId,
          options.now().toISOString(),
          leaseMilliseconds,
          attemptedCommandIds,
        )
        if (command === null)
          return results
        attemptedCommandIds.push(command.id)

        const fail = (message: string): void => {
          if (signal.aborted)
            return
          options.store.failRoutineReport({
            commandId: command.id,
            workerId: command.workerId,
            fence: command.fence,
            at: options.now().toISOString(),
            reason: message,
          })
          results.push(err(`${command.repository}: ${message}`))
        }

        const daily = command.routineName === 'daily-checkin'
        let issueNumber = daily ? null : command.trackingIssueNumber
        if (issueNumber === null) {
          const existing = await options.github.findRoutineTrackingIssue({
            repository: command.repositoryMapping,
            routineName: command.routineName,
          }, signal)
          if (existing._tag === 'Err') {
            fail(existing.error.message)
            continue
          }
          if (existing.value !== null) {
            issueNumber = existing.value.number
          }
          else {
            const created = await options.github.createIssue({
              repository: command.repositoryMapping,
              // The staged heading already folds the run's Candidates in, so
              // the title reads the very status the comment heading carries.
              title: daily
                ? dailyReportTitle(command)
                : trackingIssueTitle(command.routineName, command.repository),
              body: daily ? dailyReportBody(command) : trackingIssueBody(command.routineName),
              labels: [routineIssueLabel(command.routineName)],
            }, signal)
            if (created._tag === 'Err') {
              fail(created.error.message)
              continue
            }
            issueNumber = created.value.number
          }
        }

        const issueConfirmed = options.store.recordRoutineReportReceipt({
          commandId: command.id,
          workerId: command.workerId,
          fence: command.fence,
          at: options.now().toISOString(),
          sink: 'tracking_issue',
        })
        if (!issueConfirmed) {
          results.push(err(`${command.repository}: The Routine report lease changed after GitHub confirmed the tracking Issue.`))
          continue
        }

        if (daily) {
          const updated = await options.github.updateIssue({ repository: command.repositoryMapping, issueNumber, title: dailyReportTitle(command), body: dailyReportBody(command) }, signal)
          if (updated._tag === 'Err') {
            fail(updated.error.message)
            continue
          }
        }
        const marker = daily ? `<!-- routine-report-index: ${command.routineId} -->` : routineRunMarker(command.runId)
        const existingComment = await options.github.findIssueCommentByMarker({
          repository: command.repositoryMapping,
          issueNumber,
          marker,
        }, signal)
        if (existingComment._tag === 'Err') {
          fail(existingComment.error.message)
          continue
        }
        if (existingComment.value !== null) {
          const commentConfirmed = options.store.recordRoutineReportReceipt({
            commandId: command.id,
            workerId: command.workerId,
            fence: command.fence,
            at: options.now().toISOString(),
            sink: 'run_comment',
          })
          if (!commentConfirmed) {
            results.push(err(`${command.repository}: The Routine report lease changed after GitHub confirmed the run comment.`))
            continue
          }
          options.store.completeRoutineReport({
            commandId: command.id,
            workerId: command.workerId,
            fence: command.fence,
            at: options.now().toISOString(),
            commentId: existingComment.value.id,
            trackingIssueNumber: issueNumber,
          })
          results.push(ok({ repository: command.repository, issueNumber }))
          continue
        }

        const commented = await options.github.createComment({
          repository: command.repositoryMapping,
          issueNumber,
          body: daily ? `${marker}\nHarlan Agent Kit updates the latest report in this issue body. Each run remains in the private archive and Dashboard history.` : runComment(command, options.privateHosts ?? []),
        }, signal)
        if (commented._tag === 'Err') {
          fail(commented.error.message)
          continue
        }

        const commentConfirmed = options.store.recordRoutineReportReceipt({
          commandId: command.id,
          workerId: command.workerId,
          fence: command.fence,
          at: options.now().toISOString(),
          sink: 'run_comment',
        })
        if (!commentConfirmed) {
          results.push(err(`${command.repository}: The Routine report lease changed after GitHub accepted the run comment.`))
          continue
        }

        options.store.completeRoutineReport({
          commandId: command.id,
          workerId: command.workerId,
          fence: command.fence,
          at: options.now().toISOString(),
          commentId: commented.value.id,
          trackingIssueNumber: issueNumber,
        })
        results.push(ok({ repository: command.repository, issueNumber }))
      }
      return results
    },
  }
}
