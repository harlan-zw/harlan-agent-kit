import type {
  AgentFeedback,
  AgentRole,
  DashboardSnapshot,
  ReviewAgent,
  ReviewGateState,
} from '../../../src/types.ts'
import type { CardBadge, HistoryCategory, HistoryRecord } from './dashboard.ts'
import {
  buildHistory,
  historyCategory,
  reviewOutcomeTone,
  routineRunPresentation,
  routineTrackingUrl,
  taskStateTone,
  taskSubjectUrl,
  taskWork,
} from './dashboard.ts'

/**
 * Presentation logic for History. Pure, unit tested, no Vue.
 *
 * A row is a finished record with everything the list needs decided once:
 * badge, work kind, and the instant it finished. The page holds layout and the
 * two local filters only.
 */
export type HistoryRow = HistoryRecord

/** The outcome chips, in chip order. Names follow the GLOSSARY, not the internal category. */
export type OutcomeFilter = 'all' | 'ready' | 'findings' | 'pending' | 'blocked' | 'superseded'

export const outcomeFilters: ReadonlyArray<{ label: string, value: OutcomeFilter }> = [
  { label: 'All', value: 'all' },
  { label: 'Ready', value: 'ready' },
  { label: 'Findings', value: 'findings' },
  { label: 'Pending', value: 'pending' },
  { label: 'Blocked', value: 'blocked' },
  { label: 'Superseded', value: 'superseded' },
]

const filterCategories: Record<Exclude<OutcomeFilter, 'all'>, HistoryCategory> = {
  ready: 'ready',
  findings: 'issues',
  pending: 'pending',
  blocked: 'failed',
  superseded: 'superseded',
}

export function outcomeFilterMatches(row: HistoryRow, filter: OutcomeFilter): boolean {
  return filter === 'all' || historyCategory(row) === filterCategories[filter]
}

/**
 * The range Stats hands over in the query. Absent means every record.
 *
 * Dates are `YYYY-MM-DD` in the reader's own time zone, the same way Stats
 * counted them, so a row lands on the same day on both pages.
 */
export type HistoryRange
  = | { _tag: 'All' }
    | { _tag: 'Stats', from: string | undefined, to: string | undefined, work: AgentRole | undefined }

const agentRoles: ReadonlySet<string> = new Set<AgentRole>([
  'conflict_resolution',
  'review_fix',
  'baseline_repair',
  'adversarial_review',
  'pull_request_triage',
  'issue_triage',
  'issue_work',
  'routine_scan',
  'routine_fix',
])

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Parses the route query once at the boundary. Anything malformed reads as no range. */
export function historyRangeFromQuery(query: Record<string, unknown>): HistoryRange {
  const from = queryString(query.from)
  const to = queryString(query.to)
  const workValue = queryString(query.work)
  const work = workValue !== undefined && agentRoles.has(workValue) ? workValue as AgentRole : undefined
  if (from === undefined && to === undefined && work === undefined)
    return { _tag: 'All' }
  return { _tag: 'Stats', from, to, work }
}

export function historyRowWork(row: HistoryRow): AgentRole {
  switch (row._tag) {
    case 'Review': return 'adversarial_review'
    case 'Routine': return 'routine_scan'
    case 'Task': return taskWork(row.task)
  }
}

function localDate(at: string): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function rangeMatches(row: HistoryRow, range: HistoryRange): boolean {
  if (range._tag === 'All')
    return true
  if (range.work !== undefined && historyRowWork(row) !== range.work)
    return false
  const date = localDate(row.at)
  if (range.from !== undefined && date < range.from)
    return false
  return range.to === undefined || date <= range.to
}

/** Everything finished, newest first, after both filters. */
export function historyRows(snapshot: DashboardSnapshot, filter: OutcomeFilter = 'all', range: HistoryRange = { _tag: 'All' }): HistoryRow[] {
  const reviews = snapshot.agents.filter((agent): agent is ReviewAgent => agent._tag === 'ReviewAgent')
  return buildHistory(reviews, snapshot.tasks, snapshot.routineRuns)
    .filter(row => outcomeFilterMatches(row, filter) && rangeMatches(row, range))
}

/** The one badge a row carries. Uppercase only for Review outcomes. */
export function historyRowBadge(row: HistoryRow): CardBadge {
  switch (row._tag) {
    case 'Review': return {
      label: row.agent.outcome._tag.toUpperCase(),
      tone: reviewOutcomeTone(row.agent),
      confidence: row.agent.outcome._tag === 'Ready' ? row.agent.outcome.confidence : undefined,
      uppercase: true,
    }
    case 'Task': return { label: row.task.state._tag, tone: taskStateTone(row.task), uppercase: false }
    case 'Routine': {
      const presentation = routineRunPresentation(row.run)
      return { label: presentation.label, tone: presentation.tone === 'primary' ? 'neutral' : presentation.tone, uppercase: false }
    }
  }
}

/**
 * Whether the controller would accept a review run for this Review run's pull request.
 *
 * Mirrors the store's refusal rules, so the menu never offers a control that
 * is certain to fail: the pull request must still be at this head, open, not
 * a draft, mergeable, and not waiting on Approval.
 */
export function canRerunReview(agent: ReviewAgent, snapshot: DashboardSnapshot): boolean {
  return snapshot.items.some(item =>
    item.kind === 'pull_request'
    && item.repository === agent.repository
    && item.number === agent.pullRequestNumber
    && item.revisionId === agent.revisionId
    && item.state === 'open'
    && !item.draft
    && item.mergeState === 'clean'
    && item.approval._tag !== 'ReviewRequired',
  )
}

export type FeedbackVerdict = AgentFeedback['_tag']

const feedbackTones: Record<FeedbackVerdict, 'success' | 'warning' | 'error'> = {
  Useful: 'success',
  Noisy: 'warning',
  Wrong: 'error',
}

export function feedbackTone(verdict: FeedbackVerdict): 'success' | 'warning' | 'error' {
  return feedbackTones[verdict]
}

/**
 * What the Agent feedback block shows.
 *
 * Recorded feedback replaces the form: one judgment per Review run. While the
 * form is open, Noisy and Wrong wait for a reason, because the weekly Routine
 * cannot improve a skill from a verdict alone.
 */
export type FeedbackFormState
  = | { _tag: 'Recorded', feedback: AgentFeedback }
    | {
      _tag: 'Open'
      reason: string
      usefulEnabled: boolean
      reasonedEnabled: boolean
      pending: boolean
      error: string | undefined
    }

export function feedbackFormState(agent: ReviewAgent, draft: string, pending: boolean, error?: string): FeedbackFormState {
  if (agent.feedback !== null)
    return { _tag: 'Recorded', feedback: agent.feedback }
  const reason = draft.trim()
  return {
    _tag: 'Open',
    reason,
    usefulEnabled: !pending,
    reasonedEnabled: !pending && reason.length > 0,
    pending,
    error,
  }
}

export interface GateRow {
  name: 'Merge' | 'Review' | 'CI'
  state: ReviewGateState
}

export function gateRows(agent: ReviewAgent): GateRow[] {
  return [
    { name: 'Merge', state: agent.gates.merge },
    { name: 'Review', state: agent.gates.review },
    { name: 'CI', state: agent.gates.ci },
  ]
}

/** The canonical comment this Review run published, when a Publication succeeded. */
export function reviewCommentUrl(agent: ReviewAgent): string | undefined {
  const published = agent.publications.find(publication => publication.result._tag === 'Published')
  return published?.result._tag === 'Published' ? published.result.url : undefined
}

/** Where Open on GitHub goes. A Routine run has no Item, so it opens its tracking issue or its repository. */
export function historyRowUrl(row: HistoryRow, snapshot: DashboardSnapshot): string {
  switch (row._tag) {
    case 'Review': return row.agent.subjectUrl
    case 'Task': return taskSubjectUrl(row.task)
    case 'Routine': {
      const routine = snapshot.routines.find(candidate => candidate.id === row.run.routineId)
      return (routine === undefined ? undefined : routineTrackingUrl(routine)) ?? `https://github.com/${row.run.repository}`
    }
  }
}
