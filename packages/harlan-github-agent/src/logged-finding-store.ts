import type { DatabaseSync } from 'node:sqlite'
import type { LoggedFindingPickup, LoggedFindingStatus, LoggedReviewFinding } from './logged-finding-pickup.ts'
import type { GitHubPullRequestItem, RepositoryMapping, ReviewFinding } from './types.ts'
import { normalizeLoggedFindingControls, withLoggedFindingControls } from './logged-finding-pickup.ts'
import { canRepairBaseline } from './repository-policy.ts'
import { automatedReviewHead } from './review-comment.ts'

export const loggedFindingSchema = `
  CREATE TABLE IF NOT EXISTS logged_finding_requests (
    id TEXT PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    head_sha TEXT NOT NULL,
    base_ref TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    finding_json TEXT NOT NULL CHECK (json_valid(finding_json)),
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    task_id TEXT UNIQUE REFERENCES tasks(id),
    UNIQUE (subject_id, head_sha, fingerprint)
  );
  CREATE TABLE IF NOT EXISTS logged_finding_comments (
    subject_id INTEGER PRIMARY KEY REFERENCES subjects(id),
    source_body TEXT NOT NULL,
    published_body TEXT NOT NULL,
    desired_body TEXT NOT NULL,
    comment_id INTEGER NOT NULL,
    worker_id TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    lease_expires_at TEXT
  );
`

export interface LoggedFindingComment {
  subjectId: number
  repository: string
  pullRequestNumber: number
  headSha: string
  commentId: number
  sourceBody: string
  expectedBody: string
  body: string
  workerId: string
  fence: number
}

export interface LoggedFindingStore {
  requestLoggedFindingPickup: (input: LoggedFindingPickup & { requestId: string, at: string }) => boolean
  planLoggedFindingPickups: (at: string) => void
  getLoggedFindingForTask: (taskId: string) => LoggedReviewFinding | null
  decorateLoggedFindings: (body: string, reviewRunId: string) => string
  claimLoggedFindingComment: (workerId: string, at: string, leaseMilliseconds: number) => LoggedFindingComment | null
  authorizeLoggedFindingComment: (command: LoggedFindingComment, at: string) => boolean
  completeLoggedFindingComment: (command: LoggedFindingComment, at: string) => boolean
}

interface Candidate {
  subject_id: number
  repository: string
  github_number: number
  payload: string
  policy_json: string
  findings: string
  body: string
  github_comment_id: number
}

/** The newest confirmed canonical write, including closure after merge. */
const candidatesSql = `
  WITH publications AS (
    SELECT review_runs.subject_id, review_publications.body, review_publications.github_comment_id,
      review_publications.created_at AS at, 0 AS source_rank
    FROM review_publications JOIN review_runs ON review_runs.id = review_publications.review_run_id
    WHERE review_publications.result_tag = 'Published'
    UNION ALL
    SELECT revisions.subject_id, status.body, status.github_comment_id, status.updated_at, 1 AS source_rank
    FROM review_status_commands AS status JOIN revisions ON revisions.id = status.revision_id
    WHERE status.state_tag = 'Published' AND status.task_kind != 'existing_review'
    UNION ALL
    SELECT subject_id, body, github_comment_id, created_at, 2 AS source_rank FROM review_closure_resolutions
    WHERE result_tag = 'Published'
  ), ranked AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY subject_id ORDER BY at DESC, source_rank DESC, body DESC) AS rank FROM publications
  )
  SELECT subjects.id AS subject_id, repositories.github AS repository, subjects.github_number,
    revisions.payload, repositories.policy_json, review_runs.findings, ranked.body, ranked.github_comment_id
  FROM subjects
  JOIN repositories ON repositories.id = subjects.repository_id
  JOIN revisions ON revisions.id = subjects.current_revision_id
  JOIN ranked ON ranked.subject_id = subjects.id AND ranked.rank = 1
  JOIN review_runs ON review_runs.id = (
    SELECT latest.id FROM review_runs AS latest
    WHERE latest.subject_id = subjects.id AND latest.kind = 'adversarial_review'
      AND latest.head_sha = json_extract(revisions.payload, '$.headSha')
      AND latest.base_ref = json_extract(revisions.payload, '$.baseRef')
    ORDER BY latest.completed_at DESC, latest.id DESC LIMIT 1
  )
  WHERE subjects.kind = 'pull_request' AND repositories.enabled = 1 AND repositories.paused = 0
    AND repositories.ownership != 'external'
    AND json_extract(repositories.policy_json, '$.pullRequestReview') = 1
    AND (json_extract(revisions.payload, '$.state') = 'open' OR json_extract(revisions.payload, '$.mergedAt') IS NOT NULL)
    AND EXISTS (SELECT 1 FROM review_evidence_scopes WHERE review_run_id = review_runs.id AND policy_digest = repositories.policy_digest)
    AND NOT EXISTS (SELECT 1 FROM review_stops WHERE subject_id = subjects.id AND head_sha = review_runs.head_sha)
    AND NOT EXISTS (SELECT 1 FROM item_dismissals WHERE subject_id = subjects.id)
    AND NOT EXISTS (SELECT 1 FROM worker_tasks WHERE subject_id = subjects.id AND state_tag IN ('Queued', 'Running'))
    AND NOT EXISTS (SELECT 1 FROM tasks WHERE subject_id = subjects.id AND kind = 'review_fix'
      AND state_tag IN ('Queued', 'Running', 'Publishing')
      AND id NOT IN (SELECT task_id FROM logged_finding_requests WHERE task_id IS NOT NULL))
    AND NOT EXISTS (SELECT 1 FROM review_status_commands WHERE revision_id = revisions.id AND state_tag IN ('Pending', 'Running'))
`

export function createLoggedFindingStore(database: DatabaseSync, options: {
  writeAuthoritySql: string
  digest: (value: string) => string
  transition: (taskId: string, at: string) => void
}): LoggedFindingStore {
  function candidates(): Candidate[] {
    const rows = database.prepare(`${candidatesSql} ${options.writeAuthoritySql}
      AND (SELECT state_tag FROM agent_control WHERE singleton = 1) = 'Running'
    `).all() as unknown as Candidate[]
    return rows.filter(row => automatedReviewHead(row.body) === (JSON.parse(row.payload) as GitHubPullRequestItem).headSha)
  }

  function publishedBody(candidate: Candidate): string {
    const own = database.prepare('SELECT source_body, published_body, comment_id FROM logged_finding_comments WHERE subject_id = ?')
      .get(candidate.subject_id) as { source_body: string, published_body: string, comment_id: number } | undefined
    return own?.source_body === candidate.body && own.comment_id === candidate.github_comment_id ? own.published_body : candidate.body
  }

  function statuses(subjectId: number, pullRequest: GitHubPullRequestItem): LoggedFindingStatus[] {
    const rows = database.prepare(`
      SELECT requests.fingerprint, tasks.state_tag, tasks.progress_label, tasks.reason, tasks.evidence
      FROM logged_finding_requests AS requests LEFT JOIN tasks ON tasks.id = requests.task_id
      WHERE requests.subject_id = ? AND requests.head_sha = ?
    `).all(subjectId, pullRequest.headSha) as unknown as Array<{
      fingerprint: string
      state_tag: string | null
      progress_label: string | null
      reason: string | null
      evidence: string | null
    }>
    return rows.map(row => ({
      fingerprint: row.fingerprint,
      status: row.state_tag === null
        ? pullRequest.mergedAt === null ? 'Queued after merge.' : 'Queued.'
        : row.state_tag === 'Completed'
          ? row.evidence ?? 'Completed.'
          : row.state_tag === 'Running'
            ? row.progress_label ?? 'Verifying the finding.'
            : row.state_tag === 'Publishing'
              ? 'Opening the repair pull request.'
              : row.state_tag === 'Queued' ? 'Queued.' : row.reason ?? 'Action required.',
    }))
  }

  return {
    requestLoggedFindingPickup(input) {
      const candidate = candidates().find(candidate => candidate.repository.toLowerCase() === input.repository.toLowerCase()
        && candidate.github_number === input.pullRequestNumber && candidate.github_comment_id === input.commentId)
      if (candidate === undefined || normalizeLoggedFindingControls(publishedBody(candidate)) !== normalizeLoggedFindingControls(input.before))
        return false
      const pullRequest = JSON.parse(candidate.payload) as GitHubPullRequestItem
      if (pullRequest.headSha !== input.headSha || typeof pullRequest.baseRef !== 'string'
        || !canRepairBaseline(JSON.parse(candidate.policy_json) as RepositoryMapping)) {
        return false
      }
      const findings = JSON.parse(candidate.findings) as ReviewFinding[]
      const selected = input.fingerprints.map(fingerprint => findings.find((finding): finding is LoggedReviewFinding => finding._tag === 'Logged' && finding.details.fingerprint === fingerprint))
      if (selected.includes(undefined))
        return false
      database.exec('BEGIN IMMEDIATE')
      try {
        for (const finding of selected) {
          if (finding === undefined)
            continue
          database.prepare(`INSERT OR IGNORE INTO logged_finding_requests
            (id, subject_id, head_sha, base_ref, fingerprint, finding_json, requested_by, requested_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(options.digest(`${candidate.subject_id}:${input.headSha}:${finding.details.fingerprint}`), candidate.subject_id, input.headSha, pullRequest.baseRef, finding.details.fingerprint, JSON.stringify(finding), input.requestedBy, input.at)
        }
        database.exec('COMMIT')
        return true
      }
      catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
    planLoggedFindingPickups(at) {
      database.exec('BEGIN IMMEDIATE')
      try {
        const rows = database.prepare(`
          SELECT requests.id, requests.subject_id, subjects.current_revision_id, repositories.policy_json
          FROM logged_finding_requests AS requests
          JOIN subjects ON subjects.id = requests.subject_id
          JOIN repositories ON repositories.id = subjects.repository_id
          JOIN revisions ON revisions.id = subjects.current_revision_id
          WHERE requests.task_id IS NULL AND requests.head_sha = json_extract(revisions.payload, '$.headSha')
            AND requests.base_ref = json_extract(revisions.payload, '$.baseRef')
            AND json_extract(revisions.payload, '$.mergedAt') IS NOT NULL
            AND repositories.enabled = 1 AND repositories.paused = 0 ${options.writeAuthoritySql}
            AND NOT EXISTS (SELECT 1 FROM item_dismissals WHERE subject_id = subjects.id)
            AND NOT EXISTS (SELECT 1 FROM review_stops WHERE subject_id = subjects.id AND head_sha = requests.head_sha)
          ORDER BY requests.requested_at, requests.id
        `).all() as unknown as Array<{ id: string, subject_id: number, current_revision_id: string, policy_json: string }>
        for (const row of rows) {
          if (!canRepairBaseline(JSON.parse(row.policy_json) as RepositoryMapping)
            || database.prepare(`SELECT 1 FROM tasks WHERE subject_id = ? AND kind = 'review_fix'
              AND state_tag IN ('Queued', 'ActionRequired', 'Running', 'Publishing')`).get(row.subject_id) !== undefined) {
            continue
          }
          const taskId = `logged-finding:${row.id}`
          database.prepare(`INSERT INTO tasks (id, subject_id, revision_id, kind, state_tag, updated_at)
            VALUES (?, ?, ?, 'review_fix', 'Queued', ?)`).run(taskId, row.subject_id, row.current_revision_id, at)
          database.prepare('UPDATE logged_finding_requests SET task_id = ? WHERE id = ?').run(taskId, row.id)
          database.prepare(`INSERT OR IGNORE INTO pull_request_approvals (subject_id, revision_id, kind, approved_at)
            VALUES (?, ?, 'fixes', ?)`).run(row.subject_id, row.current_revision_id, at)
          options.transition(taskId, at)
        }
        database.exec('COMMIT')
      }
      catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
    getLoggedFindingForTask(taskId) {
      const row = database.prepare('SELECT finding_json FROM logged_finding_requests WHERE task_id = ?').get(taskId) as { finding_json: string } | undefined
      return row === undefined ? null : JSON.parse(row.finding_json) as LoggedReviewFinding
    },
    decorateLoggedFindings(body, reviewRunId) {
      const row = database.prepare('SELECT findings FROM review_runs WHERE id = ?').get(reviewRunId) as { findings: string } | undefined
      return row === undefined ? body : withLoggedFindingControls(body, JSON.parse(row.findings) as ReviewFinding[], [])
    },
    claimLoggedFindingComment(workerId, at, leaseMilliseconds) {
      for (const candidate of candidates()) {
        const pullRequest = JSON.parse(candidate.payload) as GitHubPullRequestItem
        if (!canRepairBaseline(JSON.parse(candidate.policy_json) as RepositoryMapping))
          continue
        const expectedBody = publishedBody(candidate)
        const body = withLoggedFindingControls(candidate.body, JSON.parse(candidate.findings) as ReviewFinding[], statuses(candidate.subject_id, pullRequest))
        if (body === expectedBody)
          continue
        const row = database.prepare(`INSERT INTO logged_finding_comments
          (subject_id, source_body, published_body, desired_body, comment_id, worker_id, fence, lease_expires_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?)
          ON CONFLICT(subject_id) DO UPDATE SET source_body = excluded.source_body,
            published_body = excluded.published_body, desired_body = excluded.desired_body, comment_id = excluded.comment_id,
            worker_id = excluded.worker_id, fence = logged_finding_comments.fence + 1, lease_expires_at = excluded.lease_expires_at
          WHERE logged_finding_comments.lease_expires_at IS NULL OR logged_finding_comments.lease_expires_at <= ?
          RETURNING fence
        `).get(candidate.subject_id, candidate.body, expectedBody, body, candidate.github_comment_id, workerId, new Date(new Date(at).getTime() + leaseMilliseconds).toISOString(), at) as { fence: number } | undefined
        if (row !== undefined) {
          return { subjectId: candidate.subject_id, repository: candidate.repository, pullRequestNumber: candidate.github_number, headSha: pullRequest.headSha, commentId: candidate.github_comment_id, sourceBody: candidate.body, expectedBody, body, workerId, fence: row.fence }
        }
      }
      return null
    },
    authorizeLoggedFindingComment(command, at) {
      return database.prepare(`SELECT 1 FROM logged_finding_comments WHERE subject_id = ? AND worker_id = ? AND fence = ? AND lease_expires_at > ?`)
        .get(command.subjectId, command.workerId, command.fence, at) !== undefined
        && candidates().some(candidate => candidate.subject_id === command.subjectId && candidate.body === command.sourceBody
          && candidate.github_comment_id === command.commentId && (JSON.parse(candidate.payload) as GitHubPullRequestItem).headSha === command.headSha)
    },
    completeLoggedFindingComment(command, at) {
      return database.prepare(`UPDATE logged_finding_comments SET published_body = desired_body, worker_id = NULL, lease_expires_at = NULL
        WHERE subject_id = ? AND worker_id = ? AND fence = ? AND lease_expires_at > ?`)
        .run(command.subjectId, command.workerId, command.fence, at)
        .changes === 1
    },
  }
}
