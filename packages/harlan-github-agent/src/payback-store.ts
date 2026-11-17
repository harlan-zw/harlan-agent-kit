import type { DatabaseSync } from 'node:sqlite'
import type { PaybackPullRequest, PaybackRoutineRunFact, PaybackSignalFact, PaybackTaskFact } from './payback.ts'
import { ROUTINE_NAMES } from './routines/index.ts'

export interface PaybackStore {
  /** Each Task, Review run, Routine run, or Batch that spent an Agent turn in the range, and what its pull request became. */
  listPaybackTasks: (range: { from: string, to: string }) => PaybackTaskFact[]
  /** Each Routine run that spent an Agent turn in the range, and what its Candidates became. */
  listPaybackRoutineRuns: (range: { from: string, to: string }) => PaybackRoutineRunFact[]
  /** Each Implicit signal that occurred in the range. */
  listPaybackSignals: (range: { from: string, to: string }) => PaybackSignalFact[]
}

interface PaybackRoutineRunRow {
  run_id: string
  routine_name: string
  mode: PaybackRoutineRunFact['mode']
  state: PaybackRoutineRunFact['state']
  merged: number
  open: number
  closed: number
}

function routineWork(name: string): PaybackRoutineRunFact['work'] {
  const known = ROUTINE_NAMES.find(routine => routine === name)
  return known === undefined ? { _tag: 'UnnamedRoutine' } : { _tag: 'Routine', name: known }
}

interface PaybackTaskRow {
  task_id: string
  state: PaybackTaskFact['state']
  published: number
  pull_request_state: string | null
  merged_at: string | null
}

function pullRequest(row: PaybackTaskRow): PaybackPullRequest {
  if (row.merged_at !== null)
    return 'Merged'
  if (row.pull_request_state === 'closed')
    return 'Closed'
  if (row.pull_request_state === 'open')
    return 'Open'
  return 'None'
}

export function createPaybackStore(database: DatabaseSync): PaybackStore {
  // Issue work opens its own pull request; every other Task changes the one it belongs to.
  const tasks = database.prepare(`
    WITH spent AS (
      SELECT DISTINCT task_id FROM agent_turns WHERE completed_at >= ? AND completed_at < ?
    )
    SELECT
      spent.task_id,
      tasks.state_tag AS state,
      publication_commands.id IS NOT NULL AS published,
      json_extract(pull_request_revisions.payload, '$.state') AS pull_request_state,
      json_extract(pull_request_revisions.payload, '$.mergedAt') AS merged_at
    FROM spent
    LEFT JOIN tasks ON tasks.id = spent.task_id
    -- The IN term matches one_live_publication_command_per_task, so SQLite reads one row per Task.
    LEFT JOIN publication_commands
      ON publication_commands.task_id = tasks.id
      AND publication_commands.state_tag IN ('Pending', 'Running', 'Published')
      AND publication_commands.state_tag = 'Published'
    LEFT JOIN subjects AS items ON items.id = tasks.subject_id
    LEFT JOIN subjects AS pull_requests
      ON pull_requests.repository_id = items.repository_id
      AND pull_requests.kind = 'pull_request'
      AND pull_requests.github_number = COALESCE(
        publication_commands.pull_request_number,
        CASE WHEN items.kind = 'pull_request' THEN items.github_number END
      )
    LEFT JOIN revisions AS pull_request_revisions ON pull_request_revisions.id = pull_requests.current_revision_id
    ORDER BY spent.task_id
  `)
  // candidates.run_id has no index. The routine_id term lets candidates_routine find a run's few rows.
  const routineRuns = database.prepare(`
    WITH spent AS (
      SELECT DISTINCT task_id FROM agent_turns
      WHERE completed_at >= ? AND completed_at < ? AND role IN ('routine_scan', 'routine_fix')
    )
    SELECT
      routine_runs.id AS run_id,
      routines.name AS routine_name,
      routine_runs.mode,
      routine_runs.state_tag AS state,
      COUNT(CASE WHEN candidates.result_tag = 'Merged' THEN 1 END) AS merged,
      COUNT(CASE WHEN candidates.result_tag = 'Proposed' THEN 1 END) AS open,
      COUNT(CASE WHEN candidates.result_tag IN ('Rejected', 'Superseded') THEN 1 END) AS closed
    FROM spent
    JOIN routine_runs ON routine_runs.id = spent.task_id
    JOIN routines ON routines.id = routine_runs.routine_id
    LEFT JOIN candidates
      ON candidates.routine_id = routine_runs.routine_id
      AND candidates.run_id = routine_runs.id
    GROUP BY routine_runs.id
    ORDER BY routine_runs.id
  `)
  const signals = database.prepare(`
    SELECT kind, opened_by, review_run_id IS NOT NULL AS reviewed
    FROM implicit_signals
    WHERE occurred_at >= ? AND occurred_at < ?
    ORDER BY occurred_at, id
  `)
  return {
    listPaybackSignals: range => (signals.all(range.from, range.to) as unknown as Array<{ kind: PaybackSignalFact['kind'], opened_by: PaybackSignalFact['openedBy'], reviewed: number }>).map(row => ({
      kind: row.kind,
      openedBy: row.opened_by,
      reviewed: row.reviewed === 1,
    })),
    listPaybackTasks: range => (tasks.all(range.from, range.to) as unknown as PaybackTaskRow[]).map(row => ({
      taskId: row.task_id,
      state: row.state,
      published: row.published === 1,
      pullRequest: pullRequest(row),
    })),
    listPaybackRoutineRuns: range => (routineRuns.all(range.from, range.to) as unknown as PaybackRoutineRunRow[]).map(row => ({
      runId: row.run_id,
      work: routineWork(row.routine_name),
      mode: row.mode,
      state: row.state,
      candidates: { merged: row.merged, open: row.open, closed: row.closed },
    })),
  }
}
