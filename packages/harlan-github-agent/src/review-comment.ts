import type { PullRequestCommand } from './repository-policy.ts'
import type { ReviewFinding } from './types.ts'
import { cleanText } from './text.ts'

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

export function reviewFindingSeverity(impact: number): string {
  if (impact >= 91)
    return 'Critical'
  if (impact >= 81)
    return 'Major'
  return impact >= 40 ? 'Minor' : 'Trivial'
}

/** Agents open Logged advice with these, and every surface already says "Optional follow-up". */
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

/** Show advice without implying that a Logged finding requires Repair. */
export function reviewFindingFollowUp(finding: Extract<ReviewFinding, { _tag: 'Logged' }>): string {
  const action = finding.nextAction === undefined
    ? ''
    : findingNextAction(finding.nextAction).replaceAll(/\s+/g, ' ')
  return action === '' ? 'Optional follow-up.' : `Optional follow-up: ${action}`
}

const AGENT_LINK = '[Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit)'
const POLICY_LINK = '[AI open source policy](https://harlanzw.com/blog/ai-in-open-source)'

/** Links a finding to the code that was reviewed, even after the branch moves. */
export function reviewFindingCodeLink(repository: string | undefined, headSha: string, finding: ReviewFinding): string {
  if (repository === undefined || finding._tag === 'Fixed' || finding.details === undefined)
    return ''
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f\d]{6,64}$/i.test(headSha))
    return ''
  const { path, line } = finding.details.location
  const segments = path.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment.includes('\\')))
    return ''
  const encodedPath = segments.map(segment => encodeURIComponent(segment).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')
  const lineAnchor = line !== null && Number.isSafeInteger(line) && line > 0 ? `#L${line}` : ''
  return ` [View code](https://github.com/${repository}/blob/${headSha}/${encodedPath}${lineAnchor})`
}

export interface AutomatedDisclosure {
  /** What this comment is, as one noun. The reader sees it in the first sentence. */
  kind: 'review' | 'repair update' | 'status' | 'triage'
  /** Says the comment is not Harlan speaking, where a reader could take it that way. */
  disclaimer?: string
  /** Sentences after the policy link, before the timestamp. */
  notes?: string[]
  /** Absent on a comment that carries no timestamp, so an unchanged body writes nothing. */
  updatedAt?: string
}

/**
 * The disclosure line every automated comment carries.
 *
 * Eight templates wrote eight versions of this sentence, under two different
 * names for the same bot, and one of them linked no policy at all. A reader
 * cannot tell one bot from two. One function means one name and one wording.
 */
export function automatedDisclosure(input: AutomatedDisclosure): string {
  return `> ${[
    `${AGENT_LINK} posted this automated ${input.kind}.`,
    ...(input.disclaimer === undefined ? [] : [input.disclaimer]),
    `${POLICY_LINK}.`,
    ...(input.notes ?? []),
    ...(input.updatedAt === undefined ? [] : [`Last updated: ${input.updatedAt}.`]),
  ].join(' ')}`
}

const COMMAND_LINE_START = 'Comment `@harlan-agent '

const commandPhrases: Record<PullRequestCommand, string> = {
  Change: '`@harlan-agent <change to make>` to request a change',
  Rerun: '`@harlan-agent rerun` to review this commit again',
}

/**
 * The last line of the canonical comment: the commands this pull request accepts.
 *
 * GitHub's mention picker does not offer the App, so a person cannot discover
 * the commands from the comment box. Code spans keep the handle from notifying
 * the Organization and keep `<change to make>` visible.
 */
export function pullRequestCommandFooter(commands: readonly PullRequestCommand[]): string | undefined {
  const phrases = (['Change', 'Rerun'] as const).filter(command => commands.includes(command)).map(command => commandPhrases[command])
  return phrases.length === 0 ? undefined : `Comment ${phrases.join(', or ')}.`
}

export function isPullRequestCommandFooter(line: string): boolean {
  return line.startsWith(COMMAND_LINE_START)
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
