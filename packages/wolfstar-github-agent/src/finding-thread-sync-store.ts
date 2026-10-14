import type { DatabaseSync } from 'node:sqlite'
import type { RepositoryMapping, ReviewFinding } from './types.ts'

export interface FindingThreadSync {
  reviewRunId: string
  repository: string
  pullRequestNumber: number
  headSha: string
  baseRef: string
  repositoryMapping: RepositoryMapping
  findings: ReviewFinding[]
  workerId: string
  fence: number
}

export interface FindingThreadSyncStore {
  queueReviewFindingThreadSync: (reviewRunId: string, at: string) => void
  restoreReviewFindingThreadSyncs: (at: string) => number
  claimReviewFindingThreadSync: (workerId: string, at: string, leaseMilliseconds: number) => FindingThreadSync | null
  authorizeReviewFindingThreadSync: (command: FindingThreadSync, at: string) => boolean
  completeReviewFindingThreadSync: (command: FindingThreadSync, at: string) => boolean
  deferReviewFindingThreadSync: (command: FindingThreadSync, at: string, reason: string) => boolean
  supersedeReviewFindingThreadSync: (command: FindingThreadSync, at: string) => boolean
  hasPendingReviewFindingThreadSync: (repository: string) => boolean
}

export const findingThreadSyncSchema = `
  CREATE TABLE IF NOT EXISTS finding_thread_syncs (
    review_run_id TEXT PRIMARY KEY REFERENCES review_runs(id) ON DELETE CASCADE,
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Pending', 'Running', 'Written', 'Superseded')),
    worker_id TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    lease_expires_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    reason TEXT,
    updated_at TEXT NOT NULL,
    CHECK ((state_tag = 'Running' AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state_tag != 'Running' AND worker_id IS NULL AND lease_expires_at IS NULL))
  );
  CREATE INDEX IF NOT EXISTS finding_thread_syncs_due ON finding_thread_syncs(state_tag, next_attempt_at);
`

const joins = `
  JOIN review_runs ON review_runs.id = sync.review_run_id
  JOIN subjects ON subjects.id = review_runs.subject_id
  JOIN repositories ON repositories.id = subjects.repository_id
  JOIN revisions ON revisions.id = subjects.current_revision_id`

// A new head, target, policy, Review, Stop, or Dismissal revokes the old intent.
const currentEvidence = `
  subjects.kind = 'pull_request'
  AND review_runs.kind = 'adversarial_review'
  AND json_extract(revisions.payload, '$.headSha') = review_runs.head_sha
  AND json_extract(revisions.payload, '$.baseRef') = review_runs.base_ref
  AND (json_extract(revisions.payload, '$.state') = 'open' OR json_extract(revisions.payload, '$.mergedAt') IS NOT NULL)
  AND review_runs.id = (
    SELECT latest.id FROM review_runs AS latest
    WHERE latest.subject_id = subjects.id AND latest.kind = 'adversarial_review'
      AND latest.head_sha = review_runs.head_sha AND latest.base_ref = review_runs.base_ref
      AND NOT EXISTS (SELECT 1 FROM review_runs AS settled WHERE settled.supersedes_review_run_id = latest.id)
    ORDER BY latest.completed_at DESC, latest.id DESC LIMIT 1
  )
  AND EXISTS (SELECT 1 FROM review_evidence_scopes
    WHERE review_run_id = review_runs.id AND policy_digest = repositories.policy_digest)
  AND NOT EXISTS (SELECT 1 FROM item_dismissals WHERE subject_id = subjects.id)
  AND NOT EXISTS (SELECT 1 FROM review_stops WHERE subject_id = subjects.id AND head_sha = review_runs.head_sha)
  AND NOT EXISTS (
    SELECT 1 FROM task_cancellations JOIN worker_tasks ON worker_tasks.id = task_cancellations.task_id
    JOIN revisions AS cancelled_revision ON cancelled_revision.id = worker_tasks.revision_id
    WHERE worker_tasks.subject_id = subjects.id AND worker_tasks.kind = 'adversarial_review'
      AND json_extract(cancelled_revision.payload, '$.headSha') = review_runs.head_sha
      AND task_cancellations.cancelled_at >= review_runs.started_at
  )`

export function createFindingThreadSyncStore(
  database: DatabaseSync,
  writeAuthoritySql: string,
): FindingThreadSyncStore {
  const canWrite = `${currentEvidence}
    AND repositories.enabled = 1 AND repositories.paused = 0
    ${writeAuthoritySql}
    AND json_extract(repositories.policy_json, '$.pullRequestReview') = 1
    AND (SELECT state_tag FROM agent_control WHERE singleton = 1) = 'Running'
    AND NOT EXISTS (SELECT 1 FROM restart_requests WHERE state_tag IN ('Requested', 'Restarting'))
    AND NOT EXISTS (SELECT 1 FROM worker_tasks WHERE subject_id = subjects.id AND state_tag IN ('Queued', 'Running'))
    AND NOT EXISTS (SELECT 1 FROM tasks WHERE subject_id = subjects.id AND kind = 'review_fix'
      AND state_tag IN ('Queued', 'Running', 'Publishing'))`
  const queueReviewFindingThreadSync = (reviewRunId: string, at: string): void => {
    database
      .prepare(`INSERT OR IGNORE INTO finding_thread_syncs
      (review_run_id, state_tag, next_attempt_at, updated_at)
      SELECT ?, 'Pending', ?, ? WHERE EXISTS (
        SELECT 1 FROM review_publications WHERE review_run_id = ? AND result_tag = 'Published'
      )`)
      .run(reviewRunId, at, at, reviewRunId)
  }
  const restoreReviewFindingThreadSyncs = (at: string): number => {
    // Recover earlier lost intents only where a finding could have opened an inline thread.
    const restored = database
      .prepare(`INSERT OR IGNORE INTO finding_thread_syncs
      (review_run_id, state_tag, next_attempt_at, updated_at)
      SELECT review_runs.id, 'Pending', ?, ? FROM review_runs
      JOIN subjects ON subjects.id = review_runs.subject_id
      JOIN repositories ON repositories.id = subjects.repository_id
      JOIN revisions ON revisions.id = subjects.current_revision_id
      WHERE ${currentEvidence}
        AND EXISTS (SELECT 1 FROM review_publications
          WHERE review_run_id = review_runs.id AND result_tag = 'Published')
        AND EXISTS (
          SELECT 1 FROM incidents
          WHERE incidents.repository = repositories.github AND incidents.scope_tag = 'Repository'
            AND incidents.operation = 'review_finding_threads'
            AND EXISTS (SELECT 1 FROM review_publications AS published
              WHERE published.review_run_id = review_runs.id AND published.result_tag = 'Published'
                AND published.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', incidents.first_seen_at, '-5 minutes'))
        )
        AND EXISTS (
          SELECT 1 FROM review_runs AS history, json_each(history.findings) AS finding
          WHERE history.subject_id = subjects.id
            AND json_extract(finding.value, '$._tag') = 'Open'
            AND json_extract(finding.value, '$.details.fingerprint') IS NOT NULL
        )`)
      .run(at, at)
    return Number(restored.changes)
  }
  const claimReviewFindingThreadSync: FindingThreadSyncStore['claimReviewFindingThreadSync'] = (
    workerId,
    at,
    leaseMilliseconds,
  ) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      database
        .prepare(`UPDATE finding_thread_syncs SET state_tag = 'Superseded', worker_id = NULL,
        lease_expires_at = NULL, updated_at = ? WHERE state_tag IN ('Pending', 'Running')
        AND review_run_id NOT IN (SELECT sync.review_run_id FROM finding_thread_syncs AS sync ${joins} WHERE ${currentEvidence})`)
        .run(at)
      const row = database
        .prepare(`SELECT sync.review_run_id, sync.fence, repositories.github,
        repositories.policy_json, subjects.github_number, review_runs.head_sha, review_runs.base_ref, review_runs.findings
        FROM finding_thread_syncs AS sync ${joins}
        WHERE ((sync.state_tag = 'Pending' AND sync.next_attempt_at <= ?)
          OR (sync.state_tag = 'Running' AND sync.lease_expires_at <= ?)) AND ${canWrite}
        ORDER BY sync.next_attempt_at, review_runs.completed_at DESC, sync.review_run_id LIMIT 1`)
        .get(at, at) as
        | {
            review_run_id: string
            fence: number
            github: string
            policy_json: string
            github_number: number
            head_sha: string
            base_ref: string
            findings: string
          }
        | undefined
      if (row === undefined) {
        database.exec('COMMIT')
        return null
      }
      const fence = row.fence + 1
      database
        .prepare(`UPDATE finding_thread_syncs SET state_tag = 'Running', worker_id = ?, fence = ?,
        lease_expires_at = ?, attempts = attempts + 1, updated_at = ? WHERE review_run_id = ?`)
        .run(workerId, fence, new Date(Date.parse(at) + leaseMilliseconds).toISOString(), at, row.review_run_id)
      database.exec('COMMIT')
      return {
        reviewRunId: row.review_run_id,
        repository: row.github,
        pullRequestNumber: row.github_number,
        headSha: row.head_sha,
        baseRef: row.base_ref,
        repositoryMapping: JSON.parse(row.policy_json),
        findings: JSON.parse(row.findings),
        workerId,
        fence,
      }
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
  const authorizeReviewFindingThreadSync: FindingThreadSyncStore['authorizeReviewFindingThreadSync'] = (command, at) =>
    database
      .prepare(`SELECT 1 FROM finding_thread_syncs AS sync ${joins}
      WHERE sync.review_run_id = ? AND sync.state_tag = 'Running' AND sync.worker_id = ?
        AND sync.fence = ? AND sync.lease_expires_at > ? AND ${canWrite}`)
      .get(command.reviewRunId, command.workerId, command.fence, at) !== undefined
  const settle = (command: FindingThreadSync, at: string, state: 'Written' | 'Superseded'): boolean =>
    database
      .prepare(`UPDATE finding_thread_syncs SET state_tag = ?, worker_id = NULL,
      lease_expires_at = NULL, reason = NULL, updated_at = ?
      WHERE review_run_id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?`)
      .run(state, at, command.reviewRunId, command.workerId, command.fence).changes === 1
  return {
    queueReviewFindingThreadSync,
    restoreReviewFindingThreadSyncs,
    claimReviewFindingThreadSync,
    authorizeReviewFindingThreadSync,
    completeReviewFindingThreadSync: (command, at) => settle(command, at, 'Written'),
    supersedeReviewFindingThreadSync: (command, at) => settle(command, at, 'Superseded'),
    deferReviewFindingThreadSync(command, at, reason) {
      return (
        database
          .prepare(`UPDATE finding_thread_syncs SET state_tag = 'Pending', worker_id = NULL,
        lease_expires_at = NULL, reason = ?, updated_at = ?, next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?,
          '+' || min(3600, 60 * (1 << min(attempts - 1, 6))) || ' seconds')
        WHERE review_run_id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?`)
          .run(reason, at, at, command.reviewRunId, command.workerId, command.fence).changes === 1
      )
    },
    hasPendingReviewFindingThreadSync: (repository) =>
      database
        .prepare(`SELECT 1 FROM finding_thread_syncs AS sync ${joins}
      WHERE repositories.github = ? AND sync.state_tag IN ('Pending', 'Running') AND ${currentEvidence} LIMIT 1`)
        .get(repository) !== undefined,
  }
}
