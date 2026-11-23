import type { DatabaseSync } from 'node:sqlite'
import type { FollowUpIssue } from './follow-up-issue.ts'
import type { FollowUpControls, LoggedFindingPickup, LoggedFindingStatus, LoggedReviewFinding } from './logged-finding-pickup.ts'
import type { InlineFindingReceipt, ReviewFindingThread } from './review-finding-threads.ts'
import type { GitHubPullRequestItem, RepositoryMapping, ReviewFinding } from './types.ts'
import { mayRetryFailure, publicFailureCause } from './failure.ts'
import { followUpIssue, isPublishedFollowUp, mergedFollowUpsIssue } from './follow-up-issue.ts'
import { githubAccountBody } from './github-account.ts'
import { recordLoggedFindingSignal } from './implicit-signal-store.ts'
import { followUpRoute, normalizeLoggedFindingControls, unfixedFollowUps, withLoggedFindingControls } from './logged-finding-pickup.ts'
import { isPublishedForm } from './public-text.ts'
import { canFileFollowUpIssue, canRepairBaseline, canRepairSelectedFindingOnHead } from './repository-policy.ts'
import { automatedReviewHead } from './review-comment.ts'
import { reviewFindingThreadBody } from './review-finding-threads.ts'

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

/**
 * One issue a follow-up tick asked for, staged before any GitHub write.
 *
 * `Finding` dedupes by pull request and finding fingerprint, so a second tick
 * on a later head never files twice. `Merged` dedupes by pull request and
 * head. The title and body are fixed at the tick, from the stored findings.
 */
export const followUpIssueSchema = `
  CREATE TABLE IF NOT EXISTS follow_up_issues (
    id TEXT PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    kind TEXT NOT NULL CHECK (kind IN ('Finding', 'Merged')),
    dedupe_key TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    fingerprints TEXT NOT NULL CHECK (json_valid(fingerprints)),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    marker TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    state_tag TEXT NOT NULL DEFAULT 'Pending' CHECK (state_tag IN ('Pending', 'Running', 'Published', 'Failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    worker_id TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    lease_expires_at TEXT,
    github_issue_number INTEGER,
    github_url TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (subject_id, kind, dedupe_key)
  );
`

/** A follow-up issue filing tries this many times before it stops for a person. */
const followUpIssueAttempts = 5

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

/** One staged follow-up issue, leased to one publisher. */
export interface FollowUpIssueCommand extends FollowUpIssue {
  id: string
  repository: string
  repositoryMapping: RepositoryMapping
  pullRequestNumber: number
  workerId: string
  fence: number
}

export interface LoggedFindingStore {
  holdLoggedFindingSelection: (selection: { repository: string, pullRequestNumber: number }, held: boolean) => void
  heldLoggedFindingSelections: () => Array<{ repository: string, pullRequestNumber: number }>
  listLoggedFindingThreadSelections: (taskId?: string) => Array<{ repository: string, pullRequestNumber: number }>
  reconcileLoggedFindingThreads: (repository: string, pullRequestNumber: number, threads: readonly ReviewFindingThread[], at: string) => void
  requestLoggedFindingPickup: (input: LoggedFindingPickup & { requestId: string, at: string }) => boolean
  planLoggedFindingPickups: (at: string) => void
  getLoggedFindingForTask: (taskId: string) => LoggedReviewFinding | null
  loggedFindingRepairsHead: (taskId: string) => boolean
  decorateLoggedFindings: (body: string, reviewRunId: string) => string
  claimLoggedFindingComment: (workerId: string, at: string, leaseMilliseconds: number, controls?: (repository: string) => boolean) => LoggedFindingComment | null
  authorizeLoggedFindingComment: (command: LoggedFindingComment, at: string) => boolean
  completeLoggedFindingComment: (command: LoggedFindingComment, at: string) => boolean
  claimFollowUpIssue: (workerId: string, at: string, leaseMilliseconds: number) => FollowUpIssueCommand | null
  authorizeFollowUpIssue: (command: FollowUpIssueCommand, at: string) => boolean
  isPublishedFollowUpIssue: (repository: RepositoryMapping, issue: { number: number, title: string, body: string | null }) => boolean
  completeFollowUpIssue: (input: { id: string, workerId: string, fence: number, at: string, issueNumber: number, url: string }) => boolean
  failFollowUpIssue: (input: { id: string, workerId: string, fence: number, at: string, reason: string, status?: number | undefined }) => 'Deferred' | 'Failed' | 'Unchanged'
}

interface Candidate {
  subject_id: number
  repository: string
  github_number: number
  payload: string
  policy_json: string
  review_run_id: string
  findings: string
  body: string
  github_comment_id: number
}

/**
 * The follow-up controls a canonical comment offers now.
 *
 * An open pull request routes each tick by Finding scope. A merged one offers
 * one control for every unfixed follow-up. A pull request closed unmerged
 * offers none.
 */
function followUpControls(mapping: RepositoryMapping, pull: GitHubPullRequestItem): FollowUpControls | undefined {
  if (!canFileFollowUpIssue(mapping))
    return undefined
  if (pull.state === 'open')
    return { _tag: 'Open', repairOnHead: canRepairSelectedFindingOnHead(mapping, pull) }
  return pull.mergedAt === null ? undefined : { _tag: 'Merged', headSha: pull.headSha }
}

/** The status one follow-up issue shows in place of its control. */
function issueStatus(row: { state_tag: string, github_issue_number: number | null }, one: boolean): string {
  if (row.state_tag === 'Published' && row.github_issue_number !== null)
    return `Filed as #${row.github_issue_number}.`
  if (row.state_tag === 'Failed')
    return 'GitHub refused the issue.'
  return one ? 'Filing an issue.' : 'Filing these as one issue.'
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
    revisions.payload, repositories.policy_json, review_runs.id AS review_run_id, review_runs.findings, ranked.body, ranked.github_comment_id
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
  cancel: (taskId: string, at: string) => void
}): LoggedFindingStore {
  const heldSelections = new Map<string, { repository: string, pullRequestNumber: number }>()
  /**
   * Whether GitHub's control body is one this body produced.
   *
   * The publish boundary may have redacted it, under any deny list, so the
   * Journal text and GitHub's text compare through `isPublishedForm`.
   */
  const heldByGitHub = (body: string, account: RepositoryMapping['githubAccount'], before: string): boolean =>
    isPublishedForm(before, normalizeLoggedFindingControls(githubAccountBody(body, account)))
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

  function inlineFindings(reviewRunId: string): InlineFindingReceipt[] {
    const row = database.prepare('SELECT inline_findings FROM finding_thread_syncs WHERE review_run_id = ?')
      .get(reviewRunId) as { inline_findings: string } | undefined
    return row === undefined ? [] : JSON.parse(row.inline_findings) as InlineFindingReceipt[]
  }

  /** Each finding's thread beside the code, by fingerprint. After merge, only a resolved thread, which dismissed its finding, replaces its row's place in the Merged issue. */
  function inlineThreads(reviewRunId: string, pullRequest: GitHubPullRequestItem, controls: FollowUpControls | undefined): Map<string, string> {
    return new Map(inlineFindings(reviewRunId)
      .filter(receipt => controls?._tag !== 'Merged' || receipt.resolved)
      .map(receipt => [receipt.fingerprint, `${pullRequest.url}#discussion_r${receipt.commentId}`]))
  }

  function statuses(subjectId: number, pullRequest: GitHubPullRequestItem): LoggedFindingStatus[] {
    // A filed issue answers its finding on every later head, so it outranks a Repair row.
    const issues = (database.prepare(`SELECT dedupe_key AS fingerprint, state_tag, github_issue_number
      FROM follow_up_issues WHERE subject_id = ? AND kind = 'Finding'`)
      .all(subjectId) as Array<{ fingerprint: string, state_tag: string, github_issue_number: number | null }>)
      .map((row): LoggedFindingStatus => ({ _tag: 'Issue', fingerprint: row.fingerprint, status: issueStatus(row, true) }))
    const rows = database.prepare(`
      SELECT requests.fingerprint, requests.on_head, requests.dismissed, tasks.state_tag, tasks.progress_label, tasks.reason, tasks.evidence
      FROM logged_finding_requests AS requests LEFT JOIN tasks ON tasks.id = requests.task_id
      WHERE requests.subject_id = ? AND requests.head_sha = ? AND requests.base_ref = ?
    `).all(subjectId, pullRequest.headSha, pullRequest.baseRef ?? '') as unknown as Array<{
      fingerprint: string
      on_head: number
      dismissed: number
      state_tag: string | null
      progress_label: string | null
      reason: string | null
      evidence: string | null
    }>
    const repairs = rows.filter(row => !issues.some(issue => issue.fingerprint === row.fingerprint)).map((row): LoggedFindingStatus => ({
      _tag: 'Repair',
      fingerprint: row.fingerprint,
      cancellable: row.on_head === 1 && row.dismissed === 0 && (row.state_tag === null || ['Queued', 'Running', 'Publishing'].includes(row.state_tag)),
      status: row.dismissed === 1
        ? 'Dismissed.'
        : row.state_tag === null
          ? row.on_head === 0 && pullRequest.mergedAt === null ? 'Queued after merge.' : 'Queued.'
          : row.state_tag === 'Completed'
            ? row.evidence ?? 'Completed.'
            : row.state_tag === 'Running'
              ? row.progress_label ?? 'Verifying the finding.'
              : row.state_tag === 'Publishing'
                ? row.on_head === 1 ? 'Publishing the fix.' : 'Opening the repair pull request.'
                : row.state_tag === 'Queued' ? 'Queued.' : row.reason === null ? 'Action required.' : publicFailureCause(row.reason),
    }))
    return [...issues, ...repairs]
  }

  /** The Merged issue's status for this head, once a person ticked it. */
  function mergedIssue(subjectId: number, headSha: string): string | undefined {
    const row = database.prepare(`SELECT state_tag, github_issue_number FROM follow_up_issues
      WHERE subject_id = ? AND kind = 'Merged' AND dedupe_key = ?`)
      .get(subjectId, headSha) as { state_tag: string, github_issue_number: number | null } | undefined
    return row === undefined ? undefined : issueStatus(row, false)
  }

  function decorate(body: string, findings: ReviewFinding[], subjectId: number, reviewRunId: string, pull: GitHubPullRequestItem, controls: FollowUpControls | undefined): string {
    return withLoggedFindingControls(body, findings, statuses(subjectId, pull), {
      controls,
      baseRef: pull.baseRef ?? undefined,
      // A merged pull request keeps an unresolved inline finding in its list, so the Merged issue can carry it.
      inline: inlineThreads(reviewRunId, pull, controls),
      mergedIssue: controls?._tag === 'Merged' ? mergedIssue(subjectId, pull.headSha) : undefined,
    })
  }

  /** Stages one follow-up issue. A second tick on the same finding or head writes nothing. */
  function stageIssue(input: { subjectId: number, kind: 'Finding' | 'Merged', dedupeKey: string, headSha: string, fingerprints: string[], issue: FollowUpIssue, requestedBy: string, at: string }): void {
    database.prepare(`INSERT INTO follow_up_issues
      (id, subject_id, kind, dedupe_key, head_sha, fingerprints, title, body, marker, requested_by, requested_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subject_id, kind, dedupe_key) DO NOTHING`)
      .run(options.digest(JSON.stringify(['follow-up-issue', input.subjectId, input.kind, input.dedupeKey])), input.subjectId, input.kind, input.dedupeKey, input.headSha, JSON.stringify(input.fingerprints), input.issue.title, input.issue.body, input.issue.marker, input.requestedBy, input.at, input.at)
  }

  const listLoggedFindingThreadSelections: LoggedFindingStore['listLoggedFindingThreadSelections'] = taskId => database.prepare(`SELECT DISTINCT repositories.github AS repository, subjects.github_number AS pullRequestNumber
    FROM logged_finding_requests AS requests
    JOIN subjects ON subjects.id = requests.subject_id JOIN repositories ON repositories.id = subjects.repository_id
    LEFT JOIN tasks ON tasks.id = requests.task_id
    WHERE requests.inline_comment_id IS NOT NULL AND requests.dismissed = 0
      AND (requests.task_id IS NULL OR tasks.state_tag IN ('Queued', 'Running', 'Publishing'))
      AND (? IS NULL OR requests.task_id = ?)`)
    .all(taskId ?? null, taskId ?? null) as Array<{ repository: string, pullRequestNumber: number }>

  return {
    isPublishedFollowUpIssue(repository, issue) {
      const receipts = database.prepare(`SELECT issues.title, issues.body FROM follow_up_issues AS issues
        JOIN subjects ON subjects.id = issues.subject_id
        JOIN repositories ON repositories.id = subjects.repository_id
        WHERE repositories.github = ? AND issues.github_issue_number = ? AND issues.state_tag = 'Published'`)
        .all(repository.github, issue.number) as Array<{ title: string, body: string }>
      // GitHub holds the body the publish boundary sent, which may have lines removed.
      return receipts.some(receipt => isPublishedFollowUp(issue, receipt, repository.githubAccount))
    },
    holdLoggedFindingSelection(selection, held) {
      const key = JSON.stringify([selection.repository, selection.pullRequestNumber])
      if (held)
        heldSelections.set(key, selection)
      else
        heldSelections.delete(key)
    },
    heldLoggedFindingSelections() {
      // Cancellation or a new head must not retain an unrelated scheduling hold.
      const active = listLoggedFindingThreadSelections()
      for (const [key, selection] of heldSelections) {
        if (!active.some(target => target.repository === selection.repository && target.pullRequestNumber === selection.pullRequestNumber))
          heldSelections.delete(key)
      }
      return [...heldSelections.values()]
    },
    listLoggedFindingThreadSelections,
    reconcileLoggedFindingThreads(repository, pullRequestNumber, threads, at) {
      // The root comment binds a selection to its conversation, across Reviews.
      const rows = database.prepare(`SELECT requests.id, requests.task_id, requests.inline_comment_id, requests.fingerprint
        FROM logged_finding_requests AS requests JOIN subjects ON subjects.id = requests.subject_id
        JOIN repositories ON repositories.id = subjects.repository_id
        WHERE repositories.github = ? AND subjects.github_number = ? AND requests.inline_comment_id IS NOT NULL
          AND requests.dismissed = 0 AND (requests.task_id IS NULL OR EXISTS (
            SELECT 1 FROM tasks WHERE tasks.id = requests.task_id AND tasks.state_tag IN ('Queued', 'Running', 'Publishing')
          ))`).all(repository, pullRequestNumber) as Array<{ id: string, task_id: string | null, inline_comment_id: number, fingerprint: string }>
      database.exec('BEGIN IMMEDIATE')
      try {
        for (const row of rows) {
          if (threads.some(thread => thread.comment?.id === row.inline_comment_id && thread.fingerprint === row.fingerprint && !thread.resolved))
            continue
          database.prepare('UPDATE logged_finding_requests SET dismissed = 1 WHERE id = ?').run(row.id)
          if (row.task_id !== null)
            options.cancel(row.task_id, at)
        }
        database.exec('COMMIT')
      }
      catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
    requestLoggedFindingPickup(input) {
      const candidate = candidates().find(candidate => candidate.repository.toLowerCase() === input.repository.toLowerCase()
        && candidate.github_number === input.pullRequestNumber)
      if (candidate === undefined)
        return false
      const mapping = JSON.parse(candidate.policy_json) as RepositoryMapping
      const pullRequest = JSON.parse(candidate.payload) as GitHubPullRequestItem
      const findings = JSON.parse(candidate.findings) as ReviewFinding[]
      const before = normalizeLoggedFindingControls(input.before)
      const controls = followUpControls(mapping, pullRequest)
      if (pullRequest.headSha !== input.headSha || typeof pullRequest.baseRef !== 'string' || controls === undefined)
        return false

      if (input._tag === 'MergedFollowUps') {
        // The Merged control files one issue from the stored findings, never from comment text.
        // A resolved thread dismissed its finding, so the issue leaves it out.
        const resolved = inlineThreads(candidate.review_run_id, pullRequest, controls)
        const rows = unfixedFollowUps(findings, statuses(candidate.subject_id, pullRequest)).filter(finding => !resolved.has(finding.details.fingerprint))
        if (controls._tag !== 'Merged' || input.inline === true || candidate.github_comment_id !== input.commentId
          || !heldByGitHub(publishedBody(candidate), mapping.githubAccount, before) || rows.length === 0) {
          return false
        }
        stageIssue({
          subjectId: candidate.subject_id,
          kind: 'Merged',
          dedupeKey: pullRequest.headSha,
          headSha: pullRequest.headSha,
          fingerprints: rows.map(finding => finding.details.fingerprint),
          issue: mergedFollowUpsIssue({ repository: candidate.repository, pullRequestNumber: candidate.github_number, headSha: pullRequest.headSha, findings: rows }),
          requestedBy: input.requestedBy,
          at: input.at,
        })
        return true
      }

      // A finding tick needs an open pull request. After merge, only the Merged control files.
      if (controls._tag !== 'Open')
        return false
      const repairs = input.fingerprints
      const issues = input.issueFingerprints ?? []
      const dismissed = input.dismissedFingerprints ?? []
      const logged = (fingerprint: string) => findings.find((finding): finding is LoggedReviewFinding => finding._tag === 'Logged' && finding.details.fingerprint === fingerprint)
      // The signed webhook already verifies the comment's actor and pull request.
      // Recognize each exact control while GitHub's write response is still pending.
      const inlineFingerprint = [...repairs, ...issues][0]
      const publishingInline = input.inline === true && inlineFingerprint !== undefined && database.prepare(`SELECT 1 FROM finding_thread_syncs
        WHERE review_run_id = ? AND state_tag IN ('Pending', 'Running')`).get(candidate.review_run_id) !== undefined
        && findings.some(finding => finding._tag === 'Logged'
          && finding.details.fingerprint === inlineFingerprint
          && heldByGitHub(reviewFindingThreadBody(finding, { headSha: pullRequest.headSha, baseRef: pullRequest.baseRef ?? undefined, repairOnHead: controls.repairOnHead }), mapping.githubAccount, before))
      // A delayed Dismiss addresses the same selection, even after its progress changes.
      // Accept only an exact issued control body from this Review and comment.
      const delayedDismiss = input.inline !== true && repairs.length + issues.length === 0 && dismissed.length > 0
        && (heldByGitHub(candidate.body, mapping.githubAccount, before)
          || (database.prepare(`SELECT body FROM logged_finding_control_receipts WHERE review_run_id = ? AND comment_id = ?`)
            .all(candidate.review_run_id, input.commentId) as Array<{ body: string }>).some(receipt => isPublishedForm(before, receipt.body)))
      const authorizedComment = input.inline === true
        ? inlineFingerprint !== undefined && repairs.length + issues.length === 1 && (publishingInline || inlineFindings(candidate.review_run_id).some(receipt => !receipt.resolved
          && receipt.commentId === input.commentId && receipt.fingerprint === inlineFingerprint && receipt.body === before))
        : candidate.github_comment_id === input.commentId
          && (heldByGitHub(publishedBody(candidate), mapping.githubAccount, before) || delayedDismiss)
      if (!authorizedComment)
        return false
      // Only a finding this change added goes to Repair here, and Dismiss sits only
      // beside that control, or beside a Repair selected before Finding scope existed.
      const repairFindings = repairs.map(logged)
      const dismissFindings = dismissed.map(logged)
      const issueFindings = issues.map(logged)
      const selectedOnHead = (fingerprint: string) => database.prepare(`SELECT 1 FROM logged_finding_requests
        WHERE subject_id = ? AND head_sha = ? AND base_ref = ? AND fingerprint = ? AND on_head = 1`)
        .get(candidate.subject_id, input.headSha, pullRequest.baseRef ?? '', fingerprint) !== undefined
      const routesToRepair = (finding: LoggedReviewFinding | undefined) => finding !== undefined && followUpRoute(finding, controls.repairOnHead) === 'Repair'
      if ([...repairFindings, ...dismissFindings, ...issueFindings].includes(undefined)
        || repairFindings.some(finding => !routesToRepair(finding))
        || dismissFindings.some(finding => !routesToRepair(finding) && (finding === undefined || !selectedOnHead(finding.details.fingerprint)))
        || (dismissed.length > 0 && (input.inline === true || dismissed.some(fingerprint => repairs.includes(fingerprint))))) {
        return false
      }
      database.exec('BEGIN IMMEDIATE')
      try {
        for (const finding of [...repairFindings, ...dismissFindings]) {
          if (finding === undefined)
            continue
          const fingerprint = finding.details.fingerprint
          const dismiss = dismissed.includes(fingerprint)
          if (dismiss) {
            const existing = database.prepare(`SELECT id, task_id FROM logged_finding_requests
              WHERE subject_id = ? AND head_sha = ? AND base_ref = ? AND fingerprint = ? AND on_head = 1`)
              .get(candidate.subject_id, input.headSha, pullRequest.baseRef, fingerprint) as { id: string, task_id: string | null } | undefined
            if (existing !== undefined) {
              database.prepare('UPDATE logged_finding_requests SET dismissed = 1 WHERE id = ?').run(existing.id)
              if (existing.task_id !== null)
                options.cancel(existing.task_id, input.at)
              continue
            }
          }
          database.prepare(`INSERT INTO logged_finding_requests
            (id, subject_id, head_sha, base_ref, fingerprint, finding_json, requested_by, requested_at, on_head, dismissed, inline_comment_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
            ON CONFLICT(subject_id, head_sha, base_ref, fingerprint) DO UPDATE SET on_head = excluded.on_head, dismissed = excluded.dismissed,
              inline_comment_id = excluded.inline_comment_id
              WHERE logged_finding_requests.task_id IS NULL AND logged_finding_requests.on_head = 0 AND excluded.on_head = 1
          `).run(options.digest(JSON.stringify([candidate.subject_id, input.headSha, pullRequest.baseRef, fingerprint])), candidate.subject_id, input.headSha, pullRequest.baseRef, fingerprint, JSON.stringify(finding), input.requestedBy, input.at, Number(dismiss), input.inline ? input.commentId : null)
          if (!dismiss)
            recordLoggedFindingSignal(database, { subjectId: candidate.subject_id, headSha: input.headSha, fingerprint, reviewRunId: candidate.review_run_id, at: input.at })
        }
        for (const finding of issueFindings) {
          if (finding === undefined)
            continue
          stageIssue({
            subjectId: candidate.subject_id,
            kind: 'Finding',
            dedupeKey: finding.details.fingerprint,
            headSha: input.headSha,
            fingerprints: [finding.details.fingerprint],
            issue: followUpIssue({ repository: candidate.repository, pullRequestNumber: candidate.github_number, headSha: input.headSha, finding }),
            requestedBy: input.requestedBy,
            at: input.at,
          })
          recordLoggedFindingSignal(database, { subjectId: candidate.subject_id, headSha: input.headSha, fingerprint: finding.details.fingerprint, reviewRunId: candidate.review_run_id, at: input.at })
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
          SELECT requests.id, requests.subject_id, requests.on_head, subjects.current_revision_id, repositories.policy_json, revisions.payload
          FROM logged_finding_requests AS requests
          JOIN subjects ON subjects.id = requests.subject_id
          JOIN repositories ON repositories.id = subjects.repository_id
          JOIN revisions ON revisions.id = subjects.current_revision_id
          WHERE requests.task_id IS NULL AND requests.dismissed = 0 AND requests.head_sha = json_extract(revisions.payload, '$.headSha')
            AND requests.base_ref = json_extract(revisions.payload, '$.baseRef')
            AND ((requests.on_head = 1 AND json_extract(revisions.payload, '$.state') = 'open')
              OR (requests.on_head = 0 AND json_extract(revisions.payload, '$.mergedAt') IS NOT NULL))
            AND repositories.enabled = 1 AND repositories.paused = 0 ${options.writeAuthoritySql}
            AND NOT EXISTS (SELECT 1 FROM worker_tasks WHERE subject_id = subjects.id AND state_tag IN ('Queued', 'Running', 'Publishing'))
            AND NOT EXISTS (SELECT 1 FROM item_dismissals WHERE subject_id = subjects.id)
            AND NOT EXISTS (SELECT 1 FROM review_stops WHERE subject_id = subjects.id AND head_sha = requests.head_sha)
          ORDER BY requests.requested_at, requests.id
        `).all() as unknown as Array<{ id: string, subject_id: number, on_head: number, current_revision_id: string, policy_json: string, payload: string }>
        for (const row of rows) {
          const mapping = JSON.parse(row.policy_json) as RepositoryMapping
          const pull = JSON.parse(row.payload) as GitHubPullRequestItem
          // A selection made before merge for the default branch still runs after merge.
          // No tick creates one now: a finding outside this change files an issue instead.
          const authorized = row.on_head === 1
            ? canRepairSelectedFindingOnHead(mapping, pull)
            : pull.mergedAt !== null && canRepairBaseline(mapping)
          if (!authorized || database.prepare(`SELECT 1 FROM tasks WHERE subject_id = ? AND kind = 'review_fix'
            AND state_tag IN ('Queued', 'Running', 'Publishing')`).get(row.subject_id) !== undefined) {
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
    loggedFindingRepairsHead(taskId) {
      return database.prepare('SELECT 1 FROM logged_finding_requests WHERE task_id = ? AND on_head = 1').get(taskId) !== undefined
    },
    decorateLoggedFindings(body, reviewRunId) {
      const row = database.prepare(`
        SELECT review_runs.subject_id, review_runs.findings, revisions.payload, repositories.policy_json
        FROM review_runs JOIN subjects ON subjects.id = review_runs.subject_id
        JOIN revisions ON revisions.id = subjects.current_revision_id
        JOIN repositories ON repositories.id = subjects.repository_id WHERE review_runs.id = ?
      `).get(reviewRunId) as { subject_id: number, findings: string, payload: string, policy_json: string } | undefined
      if (row === undefined)
        return body
      const pull = JSON.parse(row.payload) as GitHubPullRequestItem
      return decorate(body, JSON.parse(row.findings) as ReviewFinding[], row.subject_id, reviewRunId, pull, followUpControls(JSON.parse(row.policy_json) as RepositoryMapping, pull))
    },
    claimLoggedFindingComment(workerId, at, leaseMilliseconds, controls = () => true) {
      for (const candidate of candidates()) {
        const pullRequest = JSON.parse(candidate.payload) as GitHubPullRequestItem
        const mapping = JSON.parse(candidate.policy_json) as RepositoryMapping
        if (!canFileFollowUpIssue(mapping))
          continue
        const expectedBody = publishedBody(candidate)
        const body = decorate(candidate.body, JSON.parse(candidate.findings) as ReviewFinding[], candidate.subject_id, candidate.review_run_id, pullRequest, controls(candidate.repository) ? followUpControls(mapping, pullRequest) : undefined)
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
          const receipt = database.prepare('INSERT OR IGNORE INTO logged_finding_control_receipts (review_run_id, comment_id, body) VALUES (?, ?, ?)')
          for (const issued of [expectedBody, body])
            receipt.run(candidate.review_run_id, candidate.github_comment_id, normalizeLoggedFindingControls(githubAccountBody(issued, mapping.githubAccount)))
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
    claimFollowUpIssue(workerId, at, leaseMilliseconds) {
      database.exec('BEGIN IMMEDIATE')
      try {
        const row = database.prepare(`
          SELECT issues.id, issues.fence, issues.title, issues.body, issues.marker, subjects.github_number,
            repositories.github AS repository, repositories.policy_json
          FROM follow_up_issues AS issues
          JOIN subjects ON subjects.id = issues.subject_id
          JOIN repositories ON repositories.id = subjects.repository_id
          WHERE (issues.state_tag = 'Pending' OR (issues.state_tag = 'Running' AND issues.lease_expires_at <= ?))
            AND repositories.enabled = 1 AND repositories.paused = 0 AND repositories.ownership != 'external'
            ${options.writeAuthoritySql}
            AND (SELECT state_tag FROM agent_control WHERE singleton = 1) = 'Running'
          ORDER BY issues.requested_at, issues.id LIMIT 1
        `).get(at) as { id: string, fence: number, title: string, body: string, marker: string, github_number: number, repository: string, policy_json: string } | undefined
        if (row === undefined) {
          database.exec('COMMIT')
          return null
        }
        const fence = row.fence + 1
        database.prepare(`UPDATE follow_up_issues SET state_tag = 'Running', worker_id = ?, fence = ?, lease_expires_at = ?,
          attempts = attempts + 1, updated_at = ? WHERE id = ?`)
          .run(workerId, fence, new Date(new Date(at).getTime() + leaseMilliseconds).toISOString(), at, row.id)
        database.exec('COMMIT')
        return { id: row.id, repository: row.repository, repositoryMapping: JSON.parse(row.policy_json) as RepositoryMapping, pullRequestNumber: row.github_number, title: row.title, body: row.body, marker: row.marker, workerId, fence }
      }
      catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
    authorizeFollowUpIssue(command, at) {
      return database.prepare(`SELECT 1 FROM follow_up_issues AS issues
        JOIN subjects ON subjects.id = issues.subject_id
        JOIN repositories ON repositories.id = subjects.repository_id
        WHERE issues.id = ? AND issues.state_tag = 'Running' AND issues.worker_id = ? AND issues.fence = ?
          AND issues.lease_expires_at > ? AND repositories.github = ? AND repositories.policy_json = ?
          AND repositories.enabled = 1 AND repositories.paused = 0 AND repositories.ownership != 'external'
          ${options.writeAuthoritySql}
          AND (SELECT state_tag FROM agent_control WHERE singleton = 1) = 'Running'`)
        .get(command.id, command.workerId, command.fence, at, command.repository, JSON.stringify(command.repositoryMapping)) !== undefined
    },
    completeFollowUpIssue(input) {
      return database.prepare(`UPDATE follow_up_issues SET state_tag = 'Published', github_issue_number = ?, github_url = ?, reason = NULL,
          worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?`)
        .run(input.issueNumber, input.url, input.at, input.id, input.workerId, input.fence)
        .changes === 1
    },
    failFollowUpIssue(input) {
      const row = database.prepare(`SELECT attempts FROM follow_up_issues WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?`)
        .get(input.id, input.workerId, input.fence) as { attempts: number } | undefined
      if (row === undefined)
        return 'Unchanged'
      // A refusal no retry can change stops here, and so does a spent budget.
      const terminal = !mayRetryFailure({ message: input.reason, status: input.status }) || row.attempts >= followUpIssueAttempts
      database.prepare(`UPDATE follow_up_issues SET state_tag = ?, reason = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?`)
        .run(terminal ? 'Failed' : 'Pending', input.reason, input.at, input.id, input.workerId, input.fence)
      return terminal ? 'Failed' : 'Deferred'
    },
  }
}
