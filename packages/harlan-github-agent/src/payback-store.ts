import type { DatabaseSync } from 'node:sqlite'
import type { PaybackPullRequest, PaybackTaskFact } from './payback.ts'

export interface PaybackStore {
  /** Each Task, Review run, Routine run, or Batch that spent an Agent turn in the range, and what its pull request became. */
  listPaybackTasks: (range: { from: string, to: string }) => PaybackTaskFact[]
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
  return {
    listPaybackTasks: range => (tasks.all(range.from, range.to) as unknown as PaybackTaskRow[]).map(row => ({
      taskId: row.task_id,
      state: row.state,
      published: row.published === 1,
      pullRequest: pullRequest(row),
    })),
  }
}
