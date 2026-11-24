import type { PullRequestCommand } from './repository-policy.ts'
import type { ReviewFinding } from './types.ts'
import { cleanLine, cleanText, relativeTime } from './text.ts'

export const AUTOMATED_REVIEW_MARKER = '<!-- harlan-agent-kit:pr-triage -->'
/** The login the GitHub App posts as. */
export const AGENT_ACTOR_LOGIN = 'harlan-github-agent[bot]'

/**
 * The states a canonical comment shows besides a Review verdict.
 *
 * Each one writes its own `workflow-state` tag, so a reader never parses the
 * visible words. None of these tags reads as a finished Review: only `Review`
 * and `ReviewSkipped` tell a later head that this head was reviewed.
 */
export type CanonicalWorkState
  = | { _tag: 'Queued', headSha: string, taskKind: 'adversarial_review' | 'review_fix' }
    | { _tag: 'Stuck', headSha: string, taskKind: 'adversarial_review' | 'review_fix' }
    | { _tag: 'Repair', headSha: string }
    | { _tag: 'ReviewStopped', headSha: string }
    | { _tag: 'RepairStopped', headSha: string }
    | { _tag: 'ApprovalRequired', headSha: string }

/** The hidden marker line that names one canonical comment state. */
export function workflowStateLine(state: CanonicalWorkState): string {
  return `<!-- workflow-state: ${JSON.stringify(state)} -->`
}

/** Agents open Logged advice with these. The template names a follow-up itself. */
const OPTIONAL_FOLLOW_UP_PREFIX = /^(?:(?:optional follow-up[.:]|as an optional follow-up,)\s*)+/i

/**
 * One finding's next action, without the optional follow-up wording an Agent adds.
 *
 * The parser applies it where an answer enters, and each renderer applies it
 * again, because findings stored before the parser did still carry the prefix.
 * The rest keeps its casing: an action can open with a command such as `pnpm`.
 */
export function findingNextAction(text: string): string {
  return cleanText(text).replace(OPTIONAL_FOLLOW_UP_PREFIX, '')
}

const AGENT_LINK = '[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit)'
const POLICY_URL = 'https://harlanzw.com/blog/ai-in-open-source'
const POLICY_LINK = `[AI policy](${POLICY_URL})`

/**
 * Who holds the work, as one dot at the start of the Status line.
 *
 * Orange means one thing only: Harlan or the author must act.
 */
export type StatusDot = 'work' | 'ready' | 'act' | 'done'

const dots: Record<StatusDot, string> = { work: '⚪', ready: '🟢', act: '🟠', done: '🟣' }

/**
 * The first visible line of every comment: a dot, the outcome in bold, and one fact only this comment knows.
 *
 * A notification preview shows this line alone, so it answers whether a
 * person must act. CI and merge conflicts stay out: GitHub's merge box shows
 * them before a reader reaches the comment.
 */
export function statusLine(dot: StatusDot, outcome: string, detail?: string): string {
  return `${dots[dot]} **${outcome}**${detail === undefined || detail === '' ? '' : ` · ${detail}`}`
}

/** `1 issue`, `2 issues`. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/** Sentence case for an outcome word stored in capitals, such as `BLOCKED`. */
export function outcomeWord(outcome: string): string {
  return `${outcome.slice(0, 1).toUpperCase()}${outcome.slice(1).toLowerCase()}`
}

function validRepository(repository: string | undefined): repository is string {
  return repository !== undefined && /^[\w.-]+\/[\w.-]+$/.test(repository)
}

/** A short commit SHA in a code span, linked to the commit when the repository is known. */
export function commitLink(repository: string | undefined, sha: string): string {
  const short = `\`${sha.slice(0, 7)}\``
  return validRepository(repository) && /^[a-f\d]{6,64}$/i.test(sha) ? `[${short}](https://github.com/${repository}/commit/${sha})` : short
}

/**
 * Links a finding to the code that was reviewed, even after the branch moves.
 *
 * The link text is the file name and line, so a reader sees where without
 * opening it. Empty when the finding has no location or the path is unsafe.
 */
export function findingLocation(repository: string | undefined, headSha: string, finding: ReviewFinding): string {
  if (!validRepository(repository) || finding._tag === 'Fixed' || finding.details === undefined)
    return ''
  if (!/^[a-f\d]{6,64}$/i.test(headSha))
    return ''
  const { path, line } = finding.details.location
  const segments = path.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment.includes('\\')))
    return ''
  const encodedPath = segments.map(segment => encodeURIComponent(segment).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')
  const hasLine = line !== null && Number.isSafeInteger(line) && line > 0
  const name = `${segments.at(-1)!.replaceAll('`', '')}${hasLine ? `:${line}` : ''}`
  return `[\`${name}\`](https://github.com/${repository}/blob/${headSha}/${encodedPath}${hasLine ? `#L${line}` : ''})`
}

/**
 * Logged findings below this impact are counted and never listed.
 *
 * The Trivial band drew the most "nit" complaints across automated reviewers.
 * They get no row, no control, and no inline thread.
 */
export const FOLLOW_UP_FLOOR = 40

type LoggedFinding = Extract<ReviewFinding, { _tag: 'Logged' }>

/** True for a Logged finding that the comments list as a follow-up. */
export function listedFollowUp(finding: ReviewFinding): finding is LoggedFinding {
  return finding._tag === 'Logged' && finding.impact >= FOLLOW_UP_FLOOR
}

/**
 * The hidden marker that ends one follow-up row and names its finding.
 *
 * Two follow-ups can share a score and a title, and the fold lists its rows
 * by Finding scope, in another order than the findings. So a control binds to
 * a row by this marker, never by the row's words.
 */
export function followUpRowMarker(fingerprint: string): string {
  return `<!-- follow-up: ${fingerprint.toLowerCase()} -->`
}

/** The fingerprint a follow-up row names, or undefined for a row written before the marker. */
export const FOLLOW_UP_ROW_MARKER = /<!-- follow-up: ([a-f\d]{64}) -->$/

/** The longest body GitHub accepts for a comment or an issue, in characters. */
export const GITHUB_BODY_LIMIT = 65_536

/** The longest status a follow-up shows in place of its control. */
export const FOLLOW_UP_STATUS_LIMIT = 200

/**
 * The room one listed follow-up keeps for the lines its controls add later.
 *
 * `withLoggedFindingControls` adds a control and a Dismiss control, or a
 * status cut to `FOLLOW_UP_STATUS_LIMIT` and a Dismiss control, under a row.
 */
const FOLLOW_UP_DECORATION = 480

/**
 * The room a canonical body keeps for what the decorator adds outside its rows.
 *
 * That is the base marker or the Merged control above the footer, and one
 * tick sentence beside each group label.
 */
export const BODY_DECORATION = 400

/** The fold's own lines around its rows: the summary, the group labels, and the floor note under it. */
const SECTION_OVERHEAD = 600

/** The room `fitNotes` needs under a cut list. */
const FIT_NOTES = 200

/**
 * The hidden marker that ends one follow-up's detail line: its proof and its fix.
 *
 * The decorator drops that line when the finding has a thread beside the
 * code, because the thread shows the same proof and fix there.
 */
export function followUpDetailMarker(fingerprint: string): string {
  return `<!-- follow-up-detail: ${fingerprint.toLowerCase()} -->`
}

/** One follow-up's detail line, and the fingerprint it names. */
export const FOLLOW_UP_DETAIL_LINE = /^ {2}[^\n]* <!-- follow-up-detail: ([a-f\d]{64}) -->$/

/**
 * Where a follow-up list goes, which sets the room each row keeps and where its proof and fix sit.
 *
 * A `Comment` row keeps room for the controls the decorator adds. Its proof
 * and fix go on their own line, which the decorator drops for a finding with
 * a thread beside the code. An `Issue` gets no controls and no threads, so
 * each row carries its proof and fix, joined with `<br>`.
 */
export type FollowUpSurface = 'Comment' | 'Issue'

interface FollowUpParts {
  head: string
  proof: string
  fix: string
  fingerprint: string | undefined
}

function followUpParts(repository: string | undefined, headSha: string, finding: LoggedFinding): FollowUpParts {
  const location = findingLocation(repository, headSha, finding)
  const proof = cleanText(finding.details.proof).replaceAll(/\s+/g, ' ')
  const fix = finding.nextAction === undefined ? '' : findingNextAction(finding.nextAction).replaceAll(/\s+/g, ' ')
  return {
    head: `- \`${finding.impact}\` ${cleanLine(finding.summary)}${location === '' ? '' : ` · ${location}`}`,
    proof,
    fix: fix === '' ? '' : `Fix: ${fix}`,
    fingerprint: /^[a-f\d]{64}$/i.test(finding.details.fingerprint) ? finding.details.fingerprint : undefined,
  }
}

/**
 * The text with a Markdown block opener at its start escaped.
 *
 * A detail line continues its row's list item. A proof that opens with a
 * heading, a quote, a list marker, a fence, or an HTML tag such as `<head>`
 * would start a new block there. An HTML block would also swallow the
 * controls below. Inline Markdown, such as a code span, stays as written.
 */
function inlineStart(text: string): string {
  return text
    .replace(/^(\d{1,9})([.)]\s)/, '$1\\$2')
    .replace(/^(?:#{1,6}(?:\s|$)|>|[-+*]\s|`{3}|~{3}|<[a-z/!?])/i, '\\$&')
}

/**
 * One follow-up: score, title, and where, then its proof and its fix.
 *
 * The row stays one physical line that ends with its marker, because
 * `withLoggedFindingControls` finds the row by that marker and adds the
 * finding's controls directly under it.
 */
function followUpLines(parts: FollowUpParts, shown: { fix: boolean, proof: boolean }, surface: FollowUpSurface): string[] {
  const detail = [
    ...(shown.proof && parts.proof !== '' ? [parts.proof] : []),
    ...(shown.fix && parts.fix !== '' ? [parts.fix] : []),
  ]
  const marker = parts.fingerprint === undefined ? '' : ` ${followUpRowMarker(parts.fingerprint)}`
  if (surface === 'Issue' || detail.length === 0)
    return [`${[parts.head, ...detail].join('<br>')}${marker}`]
  return [
    `${parts.head}${marker}`,
    `  ${inlineStart(detail.join('<br>'))}${parts.fingerprint === undefined ? '' : ` ${followUpDetailMarker(parts.fingerprint)}`}`,
  ]
}

/** The characters some lines add to a body, with the line break after them. */
function size(lines: readonly string[]): number {
  return lines.join('\n').length + 1
}

/** Follow-up rows cut to fit a body, and what the cut left out. */
export interface FittedFollowUps {
  rows: Array<{ finding: LoggedFinding, lines: string[] }>
  proofsLeftOut: number
  unlisted: number
}

/**
 * The follow-up rows that fit `budget` characters, each with room for its controls.
 *
 * GitHub refuses a body over its limit, and a refused verdict never
 * publishes. So every listed row keeps its score, title, and location first.
 * Fixes fill the room that is left, then proofs, each in list order. Only
 * when the titles alone overflow does the list stop, and it counts the rest.
 * The budget includes the notes `fitNotes` writes under the list.
 */
export function fitFollowUpRows(repository: string | undefined, headSha: string, findings: readonly LoggedFinding[], budget: number, surface: FollowUpSurface = 'Comment'): FittedFollowUps {
  const decoration = surface === 'Comment' ? FOLLOW_UP_DECORATION : 0
  let room = budget - FIT_NOTES
  const listed: Array<{ finding: LoggedFinding, parts: FollowUpParts, fix: boolean, proof: boolean }> = []
  for (const finding of findings) {
    const parts = followUpParts(repository, headSha, finding)
    const cost = size(followUpLines(parts, { fix: false, proof: false }, surface)) + decoration
    if (cost > room)
      break
    room -= cost
    listed.push({ finding, parts, fix: false, proof: false })
  }
  /** What showing one more part of an entry adds to the body. */
  const added = (entry: typeof listed[number], shown: { fix: boolean, proof: boolean }): number =>
    size(followUpLines(entry.parts, shown, surface)) - size(followUpLines(entry.parts, entry, surface))
  for (const entry of listed) {
    const cost = added(entry, { fix: true, proof: false })
    if (cost <= room) {
      room -= cost
      entry.fix = true
    }
  }
  let proofsLeftOut = 0
  for (const entry of listed) {
    if (entry.parts.proof === '')
      continue
    const cost = added(entry, { fix: entry.fix, proof: true })
    if (cost > room) {
      proofsLeftOut += 1
      continue
    }
    room -= cost
    entry.proof = true
  }
  return {
    rows: listed.map(entry => ({ finding: entry.finding, lines: followUpLines(entry.parts, entry, surface) })),
    proofsLeftOut,
    unlisted: findings.length - listed.length,
  }
}

/** The small print under a cut list, which says what it left out. */
export function fitNotes(fitted: FittedFollowUps): string[] {
  return [
    ...(fitted.unlisted === 0 ? [] : [`<sub>${plural(fitted.unlisted, 'more follow-up', 'more follow-ups')} not listed to fit GitHub's size limit.</sub>`, '']),
    ...(fitted.proofsLeftOut === 0 ? [] : [`<sub>${plural(fitted.proofsLeftOut, 'proof')} left out to fit GitHub's size limit.</sub>`, '']),
  ]
}

/** The room left for follow-ups once a body's other lines are known. */
export function followUpBudget(lines: readonly string[]): number {
  return GITHUB_BODY_LIMIT - BODY_DECORATION - lines.join('\n').length - 1
}

/**
 * Who owns one follow-up's fix, by its Finding scope.
 *
 * `unknown` covers a line the diff could not place and every run recorded
 * before Finding scope existed. It never reads as this change.
 */
export type FollowUpGroup = 'change' | 'existing' | 'unknown'

const followUpGroups: readonly FollowUpGroup[] = ['change', 'existing', 'unknown']

export function followUpGroup(finding: LoggedFinding): FollowUpGroup {
  return finding.details.scope ?? 'unknown'
}

/** The bold label above one group of follow-ups. The real base branch names where existing code lives. */
export function followUpGroupLabel(group: FollowUpGroup, baseRef?: string): string {
  switch (group) {
    case 'change':
      return '**In this change.**'
    case 'existing':
      return baseRef === undefined || baseRef.replaceAll('`', '') === ''
        ? '**Already in the base branch.**'
        : `**Already in \`${baseRef.replaceAll('`', '')}\`.**`
    case 'unknown':
      return '**Not matched to the diff.**'
  }
}

/** Matches a group label at the start of a line, with or without the sentence controls add after it. */
export const FOLLOW_UP_GROUP_LABEL = /^\*\*(?:In this change|Already in (?:the base branch|`[^`\n]+`)|Not matched to the diff)\.\*\*/

/**
 * The folded follow-up list, grouped by who owns each fix, then a count of the notes below the floor.
 *
 * The labels say where each finding sits. They never say what a tick does:
 * the controls add that sentence, and only where a control exists.
 *
 * `budget` is the room the body leaves for this section, as `followUpBudget`
 * measures it. The rows shrink to fit it, so the verdict always publishes.
 */
export function followUpSection(repository: string | undefined, headSha: string, findings: readonly ReviewFinding[], baseRef?: string, budget = Number.POSITIVE_INFINITY): string[] {
  const logged = findings.filter((finding): finding is LoggedFinding => finding._tag === 'Logged')
  const shown = logged.filter(listedFollowUp)
  const hidden = logged.length - shown.length
  // Fit the rows in the order the fold lists them, so the room goes to the first groups first.
  const ordered = followUpGroups.flatMap(group => shown.filter(finding => followUpGroup(finding) === group))
  const fitted = fitFollowUpRows(repository, headSha, ordered, budget - SECTION_OVERHEAD)
  const groups = followUpGroups.flatMap((group) => {
    const rows = fitted.rows.filter(({ finding }) => followUpGroup(finding) === group)
    return rows.length === 0 ? [] : [followUpGroupLabel(group, baseRef), '', ...rows.flatMap(({ lines }) => lines), '']
  })
  return [
    ...(fitted.rows.length === 0
      ? []
      : [
          `<details><summary><b>${plural(fitted.rows.length, 'follow-up')}</b> · none block merge</summary>`,
          '',
          ...groups,
          '</details>',
          '',
        ]),
    ...fitNotes(fitted),
    ...(hidden === 0 ? [] : [`<sub>${plural(hidden, 'note')} below ${FOLLOW_UP_FLOOR}/100 not shown.</sub>`, '']),
  ]
}

export interface AutomatedDisclosure {
  /** What this comment is, as one noun. */
  kind: 'review' | 'repair' | 'status' | 'triage' | 'release' | 'issue'
  /**
   * When this state settled. Only a settled state passes it, and only a stored
   * time, so a re-render of an unchanged state writes an unchanged body.
   */
  at?: string
  /** Says a person still decides the merge. Verdicts carry it. */
  merge?: boolean
  /** The comment commands this pull request accepts, as `acceptedPullRequestCommands` returns them. */
  commands?: readonly PullRequestCommand[]
  /** What the comment is not. Defaults to "not Harlan's". */
  disclaimer?: string
}

const commandSpans: Record<PullRequestCommand, string> = {
  Rerun: '`@harlan-agent rerun`',
  Stop: '`@harlan-agent stop`',
  Change: '`@harlan-agent <change>`',
}

/**
 * The last line of every automated comment: the disclosure, then the commands.
 *
 * The disclosure licenses posting without Harlan's approval, so it shrinks but
 * never goes. It names the bot, says it is not Harlan, and links the AI policy.
 *
 * GitHub's mention picker does not offer the App, so a person cannot discover
 * the commands from the comment box. Code spans keep the handle from notifying
 * the Organization and keep `<change>` visible.
 */
export function automatedDisclosure(input: AutomatedDisclosure): string {
  const commands = (['Rerun', 'Stop', 'Change'] as const).filter(command => input.commands?.includes(command)).map(command => commandSpans[command])
  return `<sub>${[
    ...(input.at === undefined ? [] : [relativeTime(input.at)]),
    `${AGENT_LINK} automated ${input.kind}, ${input.disclaimer ?? 'not Harlan\'s'}${input.merge === true ? '; a person merges' : ''}`,
    POLICY_LINK,
    ...commands,
  ].join(' · ')}</sub>`
}

const COMMAND_LINE_START = 'Comment `@harlan-agent '

/**
 * True for the last line of a canonical comment.
 *
 * Today that is the `<sub>` disclosure. A comment written before the Status
 * line ended with its command sentence instead, and stored bodies still do.
 */
export function isCanonicalFooter(line: string): boolean {
  return line.startsWith(COMMAND_LINE_START)
    || (line.startsWith('<sub>') && line.endsWith('</sub>') && line.includes(POLICY_URL))
}

/**
 * The same comment with no command left to offer.
 *
 * A closed or merged pull request refuses every command, so a verdict that
 * stands after a close keeps its words and drops the command spans from its
 * footer. A verdict written before the Status line drops its command sentence.
 */
export function withoutCommands(body: string): string {
  const lines = body.split('\n')
  const last = lines.at(-1)
  if (last === undefined)
    return body
  if (last.startsWith(COMMAND_LINE_START))
    return lines.slice(0, -1).join('\n').trimEnd()
  if (!isCanonicalFooter(last))
    return body
  return [...lines.slice(0, -1), last.replaceAll(/ · `@harlan-agent [^`]+`/g, '')].join('\n')
}

/** Puts a block above the comment's footer, so the disclosure and commands stay last. */
export function aboveFooter(body: string, block: string): string {
  const lines = body.split('\n')
  const last = lines.at(-1)
  if (last === undefined || !isCanonicalFooter(last))
    return `${body}\n\n${block}`
  return [...lines.slice(0, -1), block, '', last].join('\n')
}

export type PriorAutomatedReview
  = | { _tag: 'None' }
    | {
      _tag: 'Found'
      authorLogin: string
      state: 'active' | 'complete'
      url: string
    }

export interface AutomatedReviewComment {
  authorAssociation: string
  authorLogin: string
  body: string
  url: string
}

const trustedAssociations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

interface ReviewWorkflowState {
  _tag: 'Review'
  headSha: string
  baseSha: string
  outcome: 'READY' | 'PENDING' | 'BLOCKED'
}

interface ReviewSkippedWorkflowState {
  _tag: 'ReviewSkipped'
  headSha: string
  baseSha: string
}

type AutomatedReviewWorkflowState = ReviewWorkflowState | ReviewSkippedWorkflowState

/** The parsed `workflow-state` marker of one comment, or undefined when it has none or it is malformed. */
function workflowStateMarker(body: string): Record<string, unknown> & { _tag: string } | undefined {
  const encoded = body.match(/<!-- workflow-state: (\{[^\n]+\}) -->/)?.[1]
  if (encoded === undefined)
    return undefined
  let value: unknown
  try {
    value = JSON.parse(encoded)
  }
  catch {
    // GitHub comment text is untrusted. A malformed marker carries no state.
    return undefined
  }
  if (typeof value !== 'object' || value === null || !('_tag' in value) || typeof value._tag !== 'string')
    return undefined
  return value as Record<string, unknown> & { _tag: string }
}

/** What a canonical comment says about its head: the Review outcome, or a state with none. */
export type CanonicalCommentOutcome = 'READY' | 'PENDING' | 'BLOCKED' | 'WAITING' | 'SKIPPED'

/**
 * The first visible line of every canonical comment: one dot, then the bold outcome.
 *
 * A trusted maintainer's comment may carry this line without a marker, so a
 * reader falls back to it.
 */
const STATUS_LINE = /^([⚪🟢🟠🟣]) (\*\*[^*\n]+\*\*.*)$/mu
/** The heading every comment carried before the Status line. Old comments stay on GitHub and in the Journal. */
const LEGACY_HEADING = /^### 🤖 (READY|PENDING|BLOCKED|WAITING|REVIEW SKIPPED)\b/m

const statusOutcomes: Record<string, CanonicalCommentOutcome> = {
  'Ready': 'READY',
  'Pending': 'PENDING',
  'Blocked': 'BLOCKED',
  'Review skipped': 'SKIPPED',
}

/**
 * The outcome one canonical comment shows, read without its visible words where it can be.
 *
 * The `workflow-state` marker decides when the comment carries one. A body
 * without one falls back to the Status line, then to the `### 🤖` heading of
 * a comment written before the Status line existed. Repair stopping reads as
 * BLOCKED, as its old heading did.
 */
export function canonicalCommentOutcome(body: string): CanonicalCommentOutcome | null {
  const state = workflowStateMarker(body)
  if (state !== undefined) {
    switch (state._tag) {
      case 'Review':
        return ['READY', 'PENDING', 'BLOCKED'].includes(String(state.outcome)) ? state.outcome as CanonicalCommentOutcome : null
      case 'ReviewSkipped':
        return 'SKIPPED'
      case 'WaitingForBaselineRepair':
        return 'WAITING'
      case 'RepairStopped':
        return 'BLOCKED'
      default:
        return null
    }
  }
  const status = body.match(STATUS_LINE)?.[2]?.match(/^\*\*([^*]+)\*\*/)?.[1]
  if (status !== undefined)
    return statusOutcomes[status] ?? null
  const heading = body.match(LEGACY_HEADING)?.[1]
  return heading === undefined ? null : heading === 'REVIEW SKIPPED' ? 'SKIPPED' : heading as CanonicalCommentOutcome
}

/**
 * The first visible line of a canonical comment as plain text, for a check run title.
 *
 * Reads the Status line without its Markdown, or the old `### ` heading.
 */
export function canonicalCommentHeadline(body: string): string | undefined {
  const status = body.match(STATUS_LINE)
  if (status !== null) {
    const text = status[2]!
      .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replaceAll(/\*\*|~~|`/g, '')
    return `${status[1]} ${text}`.trim()
  }
  return body.match(/^### (.+)$/m)?.[1]
}

function automatedReviewWorkflowState(body: string): AutomatedReviewWorkflowState | undefined {
  const value = workflowStateMarker(body)
  if (value === undefined || typeof value.headSha !== 'string' || typeof value.baseSha !== 'string')
    return undefined
  if (value._tag === 'ReviewSkipped')
    return { _tag: 'ReviewSkipped', headSha: value.headSha, baseSha: value.baseSha }
  if (value._tag !== 'Review' || !['READY', 'PENDING', 'BLOCKED'].includes(String(value.outcome)))
    return undefined
  return {
    _tag: 'Review',
    headSha: value.headSha,
    baseSha: value.baseSha,
    outcome: value.outcome as ReviewWorkflowState['outcome'],
  }
}

/** The head commit a canonical comment answers for: its workflow marker, else its reviewed-sha marker. */
export function canonicalCommentHead(body: string): string | undefined {
  const head = workflowStateMarker(body)?.headSha
  return typeof head === 'string' ? head : automatedReviewHead(body)
}

export function automatedReviewHead(body: string): string | undefined {
  const current = body.match(/<!-- reviewed-sha: ([a-f\d]{40,64}) -->/i)?.[1]
  if (current !== undefined)
    return current
  return body.match(/^- Reviewed `([a-f\d]{40,64})` against /im)?.[1]
}

function reviewState(body: string): 'active' | 'complete' {
  const outcome = canonicalCommentOutcome(body)
  return outcome === 'READY' || outcome === 'BLOCKED' || outcome === 'SKIPPED'
    || /^\*\*(?:PASS|PENDING|BLOCKED)\b/m.test(body)
    ? 'complete'
    : 'active'
}

export function priorAutomatedReviewForHead(
  comments: AutomatedReviewComment[],
  headSha: string,
  currentAgentLogin: string,
  _baseSha?: string,
): PriorAutomatedReview {
  const currentAgent = currentAgentLogin.toLowerCase()
  const found = comments.findLast((comment) => {
    if (!comment.body.includes(AUTOMATED_REVIEW_MARKER) || automatedReviewHead(comment.body)?.toLowerCase() !== headSha.toLowerCase())
      return false
    if (comment.authorLogin.toLowerCase() !== currentAgent)
      return trustedAssociations.has(comment.authorAssociation.toUpperCase())
    const workflow = automatedReviewWorkflowState(comment.body)
    if (workflow === undefined || workflow.headSha.toLowerCase() !== headSha.toLowerCase())
      return false
    return workflow._tag === 'ReviewSkipped' || workflow.outcome !== 'PENDING'
  })

  return found === undefined
    ? { _tag: 'None' }
    : {
        _tag: 'Found',
        authorLogin: found.authorLogin,
        state: reviewState(found.body),
        url: found.url,
      }
}

type OpenFinding = Extract<ReviewFinding, { _tag: 'Open' }>

/**
 * The issues to fix before merge, numbered, each with where it is and what to do.
 *
 * Two lines per issue: the title and score, then the location and the fix.
 * The trailing double space is Markdown's hard line break.
 */
export function issueRows(repository: string | undefined, headSha: string, findings: readonly OpenFinding[]): string[] {
  return findings.flatMap((finding, index) => {
    const score = finding.impact === undefined ? '' : ` \`${finding.impact}/100\``
    const location = findingLocation(repository, headSha, finding)
    const action = finding.resolution === 'Dismissal'
      ? 'Dismissal recommended.'
      : `Fix: ${cleanLine(findingNextAction(finding.nextAction))}`
    return [
      `${index + 1}. **${cleanLine(finding.summary)}**${score}  `,
      `   ${location === '' ? action : `${location} · ${action}`}`,
    ]
  })
}

/** Findings a Repair already fixed, struck through. */
export function fixedRows(findings: readonly ReviewFinding[]): string[] {
  return findings.flatMap(finding => finding._tag === 'Fixed' ? [`- ~~${cleanLine(finding.summary)}~~ fixed`] : [])
}
