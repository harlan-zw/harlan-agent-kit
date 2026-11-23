import type { DatabaseSync } from 'node:sqlite'
import type { CheckinVerdict } from './routines/contract.ts'
import type { RoutineName } from './routines/index.ts'
import type { RoutineMode, RoutineRunState } from './types.ts'

/** One Routine run, with what it yielded. */
export interface RoutineYieldRun {
  name: RoutineName
  repository: string
  /** The Publication authority stored when the run opened. */
  mode: RoutineMode
  scheduledFor: string
  state: RoutineRunState['_tag']
  /** Null when the run staged no report, failed, or returned no verdict. */
  verdict: CheckinVerdict | null
  /** Candidates this run recorded. The Journal keeps only first-seen fingerprints. */
  candidates: number
  /** Issues requested for this run's Candidates, whatever their publication state. */
  issuesRequested: number
  /** The staged report text, whatever its publication state. Null when the run staged none. */
  report: string | null
}

export interface RoutineYieldStore {
  /** Every Routine run whose cron instant falls at or after `since`, newest first. */
  listRoutineYieldRuns: (input: { since: string }) => RoutineYieldRun[]
}

interface RoutineYieldRow {
  name: RoutineName
  repository: string
  mode: RoutineMode
  scheduled_for: string
  state_tag: RoutineRunState['_tag']
  verdict_json: string | null
  body: string | null
  candidates: number
  issues_requested: number
}

const severities = new Set<unknown>(['GREEN', 'AMBER', 'RED'])
const coverages = new Set<unknown>(['complete', 'incomplete'])

/** The column holds valid JSON by constraint; its shape is still checked here. */
function parseVerdict(text: string | null): CheckinVerdict | null {
  if (text === null)
    return null
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null)
    return null
  const { severity, coverage } = value as Record<string, unknown>
  return severities.has(severity) && coverages.has(coverage)
    ? { severity, coverage } as CheckinVerdict
    : null
}

export function createRoutineYieldStore(database: DatabaseSync): RoutineYieldStore {
  // A failed or pending report publication still holds what the run said, so
  // every staged report counts.
  const runs = database.prepare(`
    WITH window_runs AS (
      SELECT routine_runs.id, routines.name, routines.repository, routine_runs.mode,
        routine_runs.scheduled_for, routine_runs.state_tag
      FROM routine_runs
      JOIN routines ON routines.id = routine_runs.routine_id
      WHERE routine_runs.scheduled_for >= ?
    ), yields AS (
      SELECT candidates.run_id, count(*) AS candidates, count(commands.id) AS issues_requested
      FROM candidates
      LEFT JOIN candidate_issue_commands AS commands ON commands.candidate_id = candidates.id
      WHERE candidates.run_id IN (SELECT id FROM window_runs)
      GROUP BY candidates.run_id
    )
    SELECT window_runs.name, window_runs.repository, window_runs.mode, window_runs.scheduled_for,
      window_runs.state_tag, reports.verdict_json, reports.body,
      COALESCE(yields.candidates, 0) AS candidates, COALESCE(yields.issues_requested, 0) AS issues_requested
    FROM window_runs
    LEFT JOIN yields ON yields.run_id = window_runs.id
    LEFT JOIN routine_report_commands AS reports ON reports.run_id = window_runs.id
    ORDER BY window_runs.scheduled_for DESC, window_runs.id
  `)

  return {
    listRoutineYieldRuns: ({ since }) => (runs.all(since) as unknown as RoutineYieldRow[]).map(row => ({
      name: row.name,
      repository: row.repository,
      mode: row.mode,
      scheduledFor: row.scheduled_for,
      state: row.state_tag,
      verdict: parseVerdict(row.verdict_json),
      candidates: row.candidates,
      issuesRequested: row.issues_requested,
      report: row.body,
    })),
  }
}
