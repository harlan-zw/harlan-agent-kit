import type { DatabaseSync } from 'node:sqlite'
import type { CompletionEvidence, CompletionResult, CompletionTarget } from './take-ownership-completion.ts'
import type { RepositoryMapping } from './types.ts'

export type CompletionState
  = | { _tag: 'Queued', reason: string | null }
    | { _tag: 'Running', workerId: string, fence: number, leaseExpiresAt: string }
    | { _tag: 'Completed', evidence: CompletionEvidence }
    | { _tag: 'ActionRequired', reason: string }

export interface CompletionTask {
  id: string
  repository: string
  target: CompletionTarget
  state: CompletionState
  updatedAt: string
}

export interface ClaimedCompletionTask extends CompletionTask {
  state: Extract<CompletionState, { _tag: 'Running' }>
  policy: string
  deadline: string
}

export type TakeOwnershipStore = ReturnType<typeof createTakeOwnershipStore>

interface CompletionRow {
  id: string
  repository: string
  target: string
  policy: string
  state: CompletionState['_tag']
  result: string | null
  worker_id: string | null
  fence: number
  lease_until: string | null
  deadline: string
  updated_at: string
}

function completionState(row: CompletionRow): CompletionState {
  const result = row.result === null ? null : JSON.parse(row.result) as CompletionResult
  if (row.state === 'Queued')
    return { _tag: 'Queued', reason: result?._tag === 'Pending' ? result.reason : null }
  if (row.state === 'Running' && row.worker_id !== null && row.lease_until !== null)
    return { _tag: 'Running', workerId: row.worker_id, fence: row.fence, leaseExpiresAt: row.lease_until }
  if (row.state === 'Completed' && result?._tag === 'Completed')
    return result
  if (row.state === 'ActionRequired' && result?._tag === 'ActionRequired')
    return result
  throw new Error(`Completion Task ${row.id} has inconsistent stored state.`)
}

/** Completion uses the existing Journal and exact closure evidence. */
export function createTakeOwnershipStore(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS take_ownership_tasks (
      id TEXT PRIMARY KEY, repository TEXT NOT NULL, pull_request_number INTEGER NOT NULL,
      target TEXT NOT NULL, policy TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('Queued','Running','Completed','ActionRequired')),
      result TEXT, worker_id TEXT, fence INTEGER NOT NULL DEFAULT 0,
      lease_until TEXT, next_attempt TEXT NOT NULL, deadline TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(repository,pull_request_number),
      CHECK((state='Running' AND worker_id IS NOT NULL AND lease_until IS NOT NULL)
        OR (state!='Running' AND worker_id IS NULL AND lease_until IS NULL))
    );
  `)
  const authority = `EXISTS (SELECT 1 FROM repositories WHERE repositories.github=take_ownership_tasks.repository
    AND enabled=1 AND writes_enabled=1 AND paused=0 AND ownership='owned'
    AND json_extract(policy_json,'$.takeOwnership._tag')='Enabled'
    AND json_extract(policy_json,'$.takeOwnership')=take_ownership_tasks.policy)`
  return {
    /** Published numbers recover a missed webhook before the first open observation. */
    listUnverifiedCompletionPullRequestNumbers(repository: RepositoryMapping): number[] {
      if (!repository.enabled || repository.ownership !== 'owned' || repository.takeOwnership._tag === 'Disabled')
        return []
      const rows = database.prepare(`SELECT DISTINCT publication_commands.pull_request_number AS number
        FROM publication_commands JOIN tasks ON tasks.id=publication_commands.task_id
        JOIN subjects AS source ON source.id=tasks.subject_id
        JOIN repositories ON repositories.id=source.repository_id
        LEFT JOIN subjects AS pull ON pull.repository_id=repositories.id AND pull.kind='pull_request'
          AND pull.github_number=publication_commands.pull_request_number
        LEFT JOIN revisions ON revisions.id=pull.current_revision_id
        LEFT JOIN pull_request_closure_verifications AS verification
          ON verification.subject_id=pull.id AND verification.revision_id=revisions.id
        WHERE repositories.github=? AND repositories.enabled=1 AND repositories.writes_enabled=1
          AND repositories.paused=0 AND publication_commands.state_tag='Published'
          AND publication_commands.pull_request_number IS NOT NULL
          AND publication_commands.pull_request_title IS NOT NULL
          AND tasks.kind IN ('issue_work','baseline_repair','review_fix')
          AND (pull.id IS NULL OR (json_extract(revisions.payload,'$.state')='closed'
            AND (verification.subject_id IS NULL OR (verification.disposition_tag='Merged'
              AND json_extract(revisions.payload,'$.mergeCommitSha') IS NULL))))
        ORDER BY number LIMIT 20`).all(repository.github) as Array<{ number: number }>
      return rows.map(row => row.number)
    },
    queueCompletionTasks(repository: RepositoryMapping, at: string): number {
      database.prepare(`UPDATE take_ownership_tasks SET state='ActionRequired',
        result=json_object('_tag','ActionRequired','reason','Take Ownership policy changed. Check delivery for this pull request.'),
        worker_id=NULL, lease_until=NULL, updated_at=?
        WHERE repository=? AND state IN ('Queued','Running') AND policy!=?`)
        .run(at, repository.github, JSON.stringify(repository.takeOwnership))
      if (!repository.enabled || repository.ownership !== 'owned' || repository.takeOwnership._tag === 'Disabled')
        return 0
      const policy = JSON.stringify(repository.takeOwnership)
      return Number(database.prepare(`
        INSERT OR IGNORE INTO take_ownership_tasks
          (id,repository,pull_request_number,target,policy,state,next_attempt,deadline,updated_at)
        SELECT 'take-ownership:' || repositories.github || ':' || subjects.github_number,
          repositories.github, subjects.github_number,
          json_object('pullRequestNumber',subjects.github_number,
            'headSha',verification.head_sha,'mergeSha',json_extract(revisions.payload,'$.mergeCommitSha'),
            'mergedAt',json_extract(revisions.payload,'$.mergedAt')),
          ?, 'Queued', ?, ?, ?
        FROM subjects JOIN repositories ON repositories.id=subjects.repository_id
        JOIN revisions ON revisions.id=subjects.current_revision_id
        JOIN pull_request_closure_verifications AS verification
          ON verification.subject_id=subjects.id AND verification.revision_id=revisions.id
          AND verification.disposition_tag='Merged'
          AND verification.head_sha=json_extract(revisions.payload,'$.headSha')
          AND verification.base_sha=json_extract(revisions.payload,'$.baseSha')
        WHERE repositories.github=? AND repositories.enabled=1 AND repositories.writes_enabled=1
          AND repositories.paused=0 AND repositories.ownership='owned'
          AND json_extract(repositories.policy_json,'$.takeOwnership')=?
          AND json_extract(revisions.payload,'$.baseRef')=?
          AND json_extract(revisions.payload,'$.state')='closed'
          AND json_extract(revisions.payload,'$.mergedAt') IS NOT NULL
          AND length(json_extract(revisions.payload,'$.mergeCommitSha'))=40
          AND EXISTS (SELECT 1 FROM publication_commands
            JOIN tasks ON tasks.id=publication_commands.task_id
            JOIN subjects AS source ON source.id=tasks.subject_id
            WHERE source.repository_id=repositories.id AND publication_commands.state_tag='Published'
              AND publication_commands.pull_request_number=subjects.github_number
              AND publication_commands.pull_request_title IS NOT NULL
              AND tasks.kind IN ('issue_work','baseline_repair','review_fix'))
      `).run(policy, at, new Date(Date.parse(at) + 24 * 60 * 60_000).toISOString(), at, repository.github, policy, repository.defaultBranch).changes)
    },
    listCompletionTasks(repository?: string): CompletionTask[] {
      const rows = database.prepare(`SELECT * FROM take_ownership_tasks WHERE (? IS NULL OR repository=?) ORDER BY updated_at DESC, id LIMIT 100`)
        .all(repository ?? null, repository ?? null) as unknown as CompletionRow[]
      return rows.map(row => ({ id: row.id, repository: row.repository, target: JSON.parse(row.target) as CompletionTarget, state: completionState(row), updatedAt: row.updated_at }))
    },
    claimCompletionTask(repository: string, workerId: string, at: string): ClaimedCompletionTask | null {
      const row = database.prepare(`UPDATE take_ownership_tasks SET state='Running', worker_id=?, fence=fence+1,
          lease_until=?, updated_at=? WHERE id=(
          SELECT id FROM take_ownership_tasks WHERE repository=? AND ${authority}
          AND ((state='Queued' AND next_attempt<=?) OR (state='Running' AND lease_until<=?))
          ORDER BY updated_at, id LIMIT 1
        ) RETURNING *`).get(workerId, new Date(Date.parse(at) + 90_000).toISOString(), at, repository, at, at) as unknown as CompletionRow | undefined
      return row === undefined
        ? null
        : { id: row.id, repository: row.repository, target: JSON.parse(row.target) as CompletionTarget, policy: row.policy, state: { _tag: 'Running', workerId, fence: row.fence, leaseExpiresAt: row.lease_until! }, deadline: row.deadline, updatedAt: at }
    },
    settleCompletionTask(task: ClaimedCompletionTask, result: CompletionResult, at: string): boolean {
      const settled: CompletionResult = result._tag === 'Pending' && at >= task.deadline
        ? { _tag: 'ActionRequired', reason: `Completion exceeded 24 hours. ${result.reason}` }
        : result
      return database.prepare(`UPDATE take_ownership_tasks SET state=?, result=?, worker_id=NULL, lease_until=NULL,
          next_attempt=?, updated_at=? WHERE id=? AND worker_id=? AND fence=? AND state='Running'
          AND lease_until>? AND ${authority}`).run(settled._tag === 'Pending' ? 'Queued' : settled._tag, JSON.stringify(settled), new Date(Date.parse(at) + 60_000).toISOString(), at, task.id, task.state.workerId, task.state.fence, at).changes === 1
    },
  }
}
