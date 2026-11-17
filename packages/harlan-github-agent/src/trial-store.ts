import type { DatabaseSync } from 'node:sqlite'
import type { RoutineName } from './routines/index.ts'
import type { ReviewOutcome, RoutineRunState } from './types.ts'

/** One window of time, start inclusive and end exclusive, as ISO instants. */
export interface TrialRange {
  from: string
  to: string
}

/** One Routine run, as a trial counts it. */
export interface TrialRoutineRun {
  repository: string
  scheduledFor: string
  state: RoutineRunState['_tag']
  evidence: string | null
  /** Input tokens of the run's Agent turn, or null when it recorded none. */
  inputTokens: number | null
}

/** One Discussion route reading for one issue state. */
export interface TrialIssueRoute {
  repository: string
  issueNumber: number
  route: string
  confidence: number
  needsCodebaseReview: number
  skipsTriage: boolean
  occurredAt: string
}

export type ReviewGateName = 'merge' | 'review' | 'ci'

/** One pull request head with a Review run in the range, and its latest outcome there. */
export interface TrialReviewedHead {
  repository: string
  pullRequestNumber: number
  headSha: string
  outcome: ReviewOutcome['_tag']
  failedGates: ReviewGateName[]
  /** Whether path rule shadow mode recorded this head as prose-only. */
  flagged: boolean
  fileCount: number | null
}

export interface TrialStore {
  /** Every run of one Routine whose cron instant falls in the range. */
  listTrialRoutineRuns: (input: { routineName: RoutineName, range: TrialRange }) => TrialRoutineRun[]
  /** Every Discussion route reading in the range. `unreadable` counts readings whose JSON did not parse. */
  listTrialIssueRoutes: (input: { event: 'discussion_shadow' | 'discussion_live', range: TrialRange }) => { readings: TrialIssueRoute[], unreadable: number }
  /** Each head with an adversarial Review run completed in the range. */
  listTrialReviewedHeads: (range: TrialRange) => TrialReviewedHead[]
  /** When one kind of workflow event was first recorded, or null when it never was. */
  firstTrialEventAt: (input: { stream: 'review_run' | 'issue_triage_status', event: string }) => string | null
}

const GATE_NAMES: readonly ReviewGateName[] = ['merge', 'review', 'ci']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string | null): unknown {
  if (text === null)
    return null
  try {
    return JSON.parse(text)
  }
  catch {
    // A reading truncated in storage is counted as unreadable by its caller.
    return null
  }
}

function failedGates(gates: string): ReviewGateName[] {
  const parsed = parseJson(gates)
  return isRecord(parsed)
    ? GATE_NAMES.filter(name => isRecord(parsed[name]) && (parsed[name] as Record<string, unknown>)._tag === 'Failed')
    : []
}

interface RoutineRunRow {
  repository: string
  scheduled_for: string
  state_tag: RoutineRunState['_tag']
  evidence: string | null
  input_tokens: number | null
}

interface IssueRouteRow {
  repository: string
  item_number: number
  route: string
  reason: string | null
  occurred_at: string
}

interface ReviewedHeadRow {
  repository: string
  pull_request_number: number
  head_sha: string
  outcome_tag: ReviewOutcome['_tag']
  gates: string
  flagged: number
  file_count: number | null
}

export function createTrialStore(database: DatabaseSync): TrialStore {
  const routineRuns = database.prepare(`
    SELECT routines.repository, routine_runs.scheduled_for, routine_runs.state_tag, routine_runs.evidence,
      CASE WHEN json_extract(routine_runs.usage, '$._tag') = 'Available'
        THEN json_extract(routine_runs.usage, '$.input') END AS input_tokens
    FROM routine_runs
    JOIN routines ON routines.id = routine_runs.routine_id
    WHERE routines.name = ? AND routine_runs.scheduled_for >= ? AND routine_runs.scheduled_for < ?
    ORDER BY routine_runs.scheduled_for, routines.repository
  `)
  const issueRoutes = database.prepare(`
    SELECT repository, item_number, to_state AS route, reason, occurred_at
    FROM workflow_events
    WHERE stream = 'issue_triage_status' AND event = ? AND occurred_at >= ? AND occurred_at < ?
      AND repository IS NOT NULL AND item_number IS NOT NULL
    ORDER BY occurred_at, id
  `)
  // The latest Review run of each head inside the range decides how that head ended.
  const reviewedHeads = database.prepare(`
    WITH latest AS (
      SELECT subject_id, head_sha, outcome_tag, gates, completed_at,
        ROW_NUMBER() OVER (PARTITION BY subject_id, head_sha ORDER BY completed_at DESC, id DESC) AS position
      FROM review_runs
      WHERE kind = 'adversarial_review' AND completed_at >= ? AND completed_at < ?
    ), flagged AS (
      SELECT revisions.subject_id, json_extract(revisions.payload, '$.headSha') AS head_sha,
        max(CASE WHEN json_valid(workflow_events.reason) THEN json_extract(workflow_events.reason, '$.fileCount') END) AS file_count
      FROM workflow_events
      JOIN revisions ON revisions.id = workflow_events.revision_id
      WHERE workflow_events.stream = 'review_run' AND workflow_events.event = 'path_rule_shadow'
      GROUP BY revisions.subject_id, json_extract(revisions.payload, '$.headSha')
    )
    SELECT repositories.github AS repository, subjects.github_number AS pull_request_number,
      latest.head_sha, latest.outcome_tag, latest.gates,
      flagged.subject_id IS NOT NULL AS flagged, flagged.file_count
    FROM latest
    JOIN subjects ON subjects.id = latest.subject_id
    JOIN repositories ON repositories.id = subjects.repository_id
    LEFT JOIN flagged ON flagged.subject_id = latest.subject_id AND flagged.head_sha = latest.head_sha
    WHERE latest.position = 1
    ORDER BY latest.completed_at, repositories.github, subjects.github_number
  `)
  const firstEvent = database.prepare(`
    SELECT min(occurred_at) AS at FROM workflow_events WHERE stream = ? AND event = ?
  `)

  return {
    listTrialRoutineRuns: ({ routineName, range }) => (routineRuns.all(routineName, range.from, range.to) as unknown as RoutineRunRow[])
      .map(row => ({
        repository: row.repository,
        scheduledFor: row.scheduled_for,
        state: row.state_tag,
        evidence: row.evidence,
        inputTokens: typeof row.input_tokens === 'number' ? row.input_tokens : null,
      })),
    listTrialIssueRoutes: ({ event, range }) => {
      const readings: TrialIssueRoute[] = []
      let unreadable = 0
      for (const row of issueRoutes.all(event, range.from, range.to) as unknown as IssueRouteRow[]) {
        const reason = parseJson(row.reason)
        if (!isRecord(reason) || typeof reason.confidence !== 'number' || typeof reason.needsCodebaseReview !== 'number' || typeof reason.skipsTriage !== 'boolean') {
          unreadable += 1
          continue
        }
        readings.push({
          repository: row.repository,
          issueNumber: row.item_number,
          route: row.route,
          confidence: reason.confidence,
          needsCodebaseReview: reason.needsCodebaseReview,
          skipsTriage: reason.skipsTriage,
          occurredAt: row.occurred_at,
        })
      }
      return { readings, unreadable }
    },
    listTrialReviewedHeads: range => (reviewedHeads.all(range.from, range.to) as unknown as ReviewedHeadRow[])
      .map(row => ({
        repository: row.repository,
        pullRequestNumber: row.pull_request_number,
        headSha: row.head_sha,
        outcome: row.outcome_tag,
        failedGates: failedGates(row.gates),
        flagged: row.flagged === 1,
        fileCount: typeof row.file_count === 'number' ? row.file_count : null,
      })),
    firstTrialEventAt: ({ stream, event }) => (firstEvent.get(stream, event) as { at: string | null } | undefined)?.at ?? null,
  }
}
