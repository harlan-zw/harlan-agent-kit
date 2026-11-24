import type { DatabaseSync } from 'node:sqlite'
import type { AutoMergeHoldCause } from './auto-merge.ts'
import type { RoutineName } from './routines/index.ts'
import type { ReviewOutcome, RoutineRunState } from './types.ts'
import { isAutoMergeHoldCause } from './auto-merge.ts'
import { openingWork } from './implicit-signal-store.ts'

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

/** One open pull request whose current head has a READY Review and passing CI. */
export interface ReadyPullRequest {
  repository: string
  pullRequestNumber: number
  title: string
  /** When a Review first read READY on this head. */
  readyAt: string
}

/** One `agent-retro` Candidate, and what it became. */
export interface TrialRetroCandidate {
  repository: string
  createdAt: string
  /** The issue the controller filed for it, or null while none is published. */
  issueNumber: number | null
  /** When the pull request that resolved it merged, or null while none has. */
  mergedAt: string | null
}

/** One merged pull request whose merged head has a Review run, and the revert that names it, if any. */
export interface TrialReviewedMerge {
  repository: string
  pullRequestNumber: number
  url: string
  mergedAt: string
  /** The latest Review outcome on the merged head. */
  outcome: ReviewOutcome['_tag']
  /** True when a service publication opened the pull request. */
  serviceOpened: boolean
  /** When the reverting pull request merged, or null while none has. */
  revertedAt: string | null
  revertedBy: number | null
}

/** One reason Auto merge held one candidate head, when it was first recorded. */
export interface TrialAutoMergeHold {
  repository: string
  pullRequestNumber: number
  headSha: string
  cause: AutoMergeHoldCause
  /** True when the head had no label and the label alone would have merged it. */
  heldOnlyByLabel: boolean
  occurredAt: string
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
  /** Open pull requests in enabled repositories whose current head is READY with passing CI, oldest READY first. */
  listReadyPullRequests: () => ReadyPullRequest[]
  /** `agent-retro` Candidates recorded in the range. */
  listTrialRetroCandidates: (range: TrialRange) => TrialRetroCandidate[]
  /** Pull requests merged in the range whose merged head has a Review run, oldest merge first. */
  listTrialReviewedMerges: (range: TrialRange) => TrialReviewedMerge[]
  /** Auto merge holds first recorded in the range, oldest first. `unreadable` counts records that did not parse. */
  listTrialAutoMergeHolds: (range: TrialRange) => { holds: TrialAutoMergeHold[], unreadable: number }
}

/**
 * When a Review first read READY on each head, for one base branch.
 *
 * A run can finish READY, or turn READY later when the controller reprojects
 * its gates. Some reprojections record a `review_gate` event and some only
 * move the projection row, so all three sources count.
 */
const firstReadySql = `
  first_ready AS (
    SELECT subject_id, head_sha, base_ref, min(at) AS ready_at FROM (
      SELECT subject_id, head_sha, base_ref, completed_at AS at
      FROM review_runs
      WHERE kind = 'adversarial_review' AND outcome_tag = 'Ready'
      UNION ALL
      SELECT review_runs.subject_id, review_runs.head_sha, review_runs.base_ref, workflow_events.occurred_at
      FROM workflow_events
      JOIN review_runs ON review_runs.id = workflow_events.entity_id
      WHERE workflow_events.stream = 'review_gate' AND workflow_events.event = 'Projected'
        AND workflow_events.to_state = 'Ready' AND review_runs.kind = 'adversarial_review'
      UNION ALL
      SELECT review_runs.subject_id, review_runs.head_sha, review_runs.base_ref, review_gate_projections.updated_at
      FROM review_gate_projections
      JOIN review_runs ON review_runs.id = review_gate_projections.review_run_id
      WHERE review_gate_projections.outcome_tag = 'Ready' AND review_runs.kind = 'adversarial_review'
    )
    GROUP BY subject_id, head_sha, base_ref
  )
`

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

interface ReadyPullRequestRow {
  repository: string
  pull_request_number: number
  title: string
  ready_at: string
}

interface RetroCandidateRow {
  repository: string
  created_at: string
  issue_number: number | null
  merged_at: string | null
}

interface AutoMergeHoldRow {
  repository: string
  item_number: number
  cause: string
  reason: string | null
  occurred_at: string
}

interface ReviewedMergeRow {
  subject_id: number
  repository: string
  pull_request_number: number
  url: string
  merged_at: string
  outcome_tag: ReviewOutcome['_tag']
  reverted_at: string | null
  reverted_by: number | null
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
  const autoMergeHolds = database.prepare(`
    SELECT repository, item_number, to_state AS cause, reason, occurred_at
    FROM workflow_events
    WHERE stream = 'review_run' AND event = 'auto_merge_hold' AND occurred_at >= ? AND occurred_at < ?
      AND repository IS NOT NULL AND item_number IS NOT NULL
    ORDER BY occurred_at, id
  `)
  // The latest Review run on the current head and base decides; a settled run counts through its settlement.
  const readyPullRequests = database.prepare(`
    WITH ${firstReadySql}, latest AS (
      SELECT review_runs.subject_id, review_runs.head_sha, review_runs.base_ref,
        COALESCE(review_gate_projections.outcome_tag, review_runs.outcome_tag) AS outcome_tag,
        json_extract(COALESCE(review_gate_projections.gates, review_runs.gates), '$.ci._tag') AS ci_tag,
        ROW_NUMBER() OVER (
          PARTITION BY review_runs.subject_id, review_runs.head_sha, review_runs.base_ref
          ORDER BY review_runs.completed_at DESC, review_runs.id DESC
        ) AS position
      FROM review_runs
      LEFT JOIN review_gate_projections ON review_gate_projections.review_run_id = review_runs.id
      WHERE review_runs.kind = 'adversarial_review'
        AND NOT EXISTS (SELECT 1 FROM review_runs AS settled WHERE settled.supersedes_review_run_id = review_runs.id)
    )
    SELECT repositories.github AS repository, subjects.github_number AS pull_request_number,
      json_extract(revisions.payload, '$.title') AS title, first_ready.ready_at
    FROM subjects
    JOIN repositories ON repositories.id = subjects.repository_id
    JOIN revisions ON revisions.id = subjects.current_revision_id
    JOIN latest ON latest.subject_id = subjects.id AND latest.position = 1
      AND latest.head_sha = json_extract(revisions.payload, '$.headSha')
      AND latest.base_ref IS json_extract(revisions.payload, '$.baseRef')
    JOIN first_ready ON first_ready.subject_id = latest.subject_id
      AND first_ready.head_sha = latest.head_sha AND first_ready.base_ref IS latest.base_ref
    WHERE subjects.kind = 'pull_request' AND repositories.enabled = 1
      AND json_extract(revisions.payload, '$.state') = 'open'
      AND json_extract(revisions.payload, '$.draft') = 0
      AND latest.outcome_tag = 'Ready' AND latest.ci_tag = 'Passed'
    ORDER BY first_ready.ready_at, repositories.github, subjects.github_number
  `)
  // Reconciliation marks a Candidate Merged with its pull request; the merge instant lives on that pull request.
  // Only a Review run that answered the merged head speaks for the merge.
  const reviewedMerges = database.prepare(`
    WITH merged AS (
      SELECT subjects.id AS subject_id, repositories.github AS repository, subjects.github_number AS pull_request_number,
        json_extract(revisions.payload, '$.url') AS url,
        json_extract(revisions.payload, '$.mergedAt') AS merged_at,
        (
          SELECT COALESCE(review_gate_projections.outcome_tag, review_runs.outcome_tag)
          FROM review_runs
          LEFT JOIN review_gate_projections ON review_gate_projections.review_run_id = review_runs.id
          WHERE review_runs.subject_id = subjects.id AND review_runs.head_sha = json_extract(revisions.payload, '$.headSha')
          ORDER BY review_runs.completed_at DESC, review_runs.id DESC
          LIMIT 1
        ) AS outcome_tag
      FROM subjects
      JOIN repositories ON repositories.id = subjects.repository_id
      JOIN revisions ON revisions.id = subjects.current_revision_id
      WHERE subjects.kind = 'pull_request'
        AND json_extract(revisions.payload, '$.mergedAt') >= ? AND json_extract(revisions.payload, '$.mergedAt') < ?
    )
    SELECT merged.*, implicit_signals.occurred_at AS reverted_at, implicit_signals.reverted_by
    FROM merged
    LEFT JOIN implicit_signals ON implicit_signals.subject_id = merged.subject_id AND implicit_signals.kind = 'Reverted'
    WHERE merged.outcome_tag IS NOT NULL
    ORDER BY merged.merged_at, merged.repository, merged.pull_request_number
  `)
  const retroCandidates = database.prepare(`
    SELECT routines.repository, candidates.created_at, commands.github_issue_number AS issue_number,
      CASE WHEN candidates.result_tag = 'Merged' THEN json_extract(revisions.payload, '$.mergedAt') END AS merged_at
    FROM candidates
    JOIN routines ON routines.id = candidates.routine_id
    LEFT JOIN candidate_issue_commands AS commands ON commands.candidate_id = candidates.id AND commands.state_tag = 'Published'
    LEFT JOIN repositories ON repositories.github = commands.repository
    LEFT JOIN subjects ON subjects.repository_id = repositories.id
      AND subjects.kind = 'pull_request' AND subjects.github_number = candidates.pull_request
    LEFT JOIN revisions ON revisions.id = subjects.current_revision_id
    WHERE routines.name = 'agent-retro' AND candidates.created_at >= ? AND candidates.created_at < ?
    ORDER BY candidates.created_at, candidates.id
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
    listReadyPullRequests: () => (readyPullRequests.all() as unknown as ReadyPullRequestRow[])
      .map(row => ({ repository: row.repository, pullRequestNumber: row.pull_request_number, title: row.title, readyAt: row.ready_at })),
    listTrialRetroCandidates: range => (retroCandidates.all(range.from, range.to) as unknown as RetroCandidateRow[])
      .map(row => ({ repository: row.repository, createdAt: row.created_at, issueNumber: row.issue_number, mergedAt: row.merged_at })),
    listTrialReviewedMerges: range => (reviewedMerges.all(range.from, range.to) as unknown as ReviewedMergeRow[])
      .map(row => ({
        repository: row.repository,
        pullRequestNumber: row.pull_request_number,
        url: row.url,
        mergedAt: row.merged_at,
        outcome: row.outcome_tag,
        serviceOpened: openingWork(database, row.subject_id) !== null,
        revertedAt: row.reverted_at,
        revertedBy: row.reverted_by,
      })),
    listTrialAutoMergeHolds: (range) => {
      const holds: TrialAutoMergeHold[] = []
      let unreadable = 0
      for (const row of autoMergeHolds.all(range.from, range.to) as unknown as AutoMergeHoldRow[]) {
        const reason = parseJson(row.reason)
        if (!isAutoMergeHoldCause(row.cause) || !isRecord(reason) || typeof reason.headSha !== 'string' || typeof reason.heldOnlyByLabel !== 'boolean') {
          unreadable += 1
          continue
        }
        holds.push({
          repository: row.repository,
          pullRequestNumber: row.item_number,
          headSha: reason.headSha,
          cause: row.cause,
          heldOnlyByLabel: reason.heldOnlyByLabel,
          occurredAt: row.occurred_at,
        })
      }
      return { holds, unreadable }
    },
  }
}
