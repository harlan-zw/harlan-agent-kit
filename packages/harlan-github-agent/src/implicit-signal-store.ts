import type { DatabaseSync } from 'node:sqlite'
import type { LoggedReviewFinding } from './logged-finding-pickup.ts'
import type { GitHubPullRequestItem, ReviewOutcome } from './types.ts'
import { createHash } from 'node:crypto'

/**
 * What a person did on GitHub to agent work, read from state the service
 * already observes. It records an action, never a judgment, so it is never
 * Agent feedback.
 */
export type ImplicitSignalKind = 'HumanCommit' | 'ClosedUnmerged' | 'MergedUntouched' | 'LoggedFindingPickedUp'

/** The Agent role whose publication opened a pull request. */
export type OpeningWork = 'issue_work' | 'baseline_repair' | 'review_fix' | 'conflict_resolution'

export interface ImplicitSignalReview {
  id: string
  headSha: string
  outcome: ReviewOutcome
}

interface ImplicitSignalBase {
  repository: string
  pullRequestNumber: number
  title: string
  headSha: string
  occurredAt: string
  /** The work whose publication opened the pull request, or null when the service only reviewed it. */
  openedBy: OpeningWork | null
}

/** A HumanCommit always names the READY Review run whose head it replaced. */
export type ImplicitSignal
  = | ImplicitSignalBase & { _tag: 'HumanCommit', reviewRun: ImplicitSignalReview }
    | ImplicitSignalBase & { _tag: 'ClosedUnmerged' | 'MergedUntouched', reviewRun: ImplicitSignalReview | null }
    | ImplicitSignalBase & { _tag: 'LoggedFindingPickedUp', reviewRun: ImplicitSignalReview | null, finding: LoggedReviewFinding }

/** `ServiceOpened` keeps only pull requests a service publication opened. */
export interface ImplicitSignalQuery {
  kinds: readonly ImplicitSignalKind[]
  limitPerKind: number
  origin: 'ServiceOpened' | 'Any'
}

export interface ImplicitSignalStore {
  /** The newest signals of each requested kind, newest first. */
  listImplicitSignals: (input: ImplicitSignalQuery) => ImplicitSignal[]
}

export const implicitSignalSchema = `
  CREATE TABLE IF NOT EXISTS implicit_signals (
    id TEXT PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    kind TEXT NOT NULL CHECK (kind IN ('HumanCommit', 'ClosedUnmerged', 'MergedUntouched', 'LoggedFindingPickedUp')),
    head_sha TEXT NOT NULL,
    fingerprint TEXT,
    review_run_id TEXT REFERENCES review_runs(id),
    opened_by TEXT CHECK (opened_by IS NULL OR opened_by IN ('issue_work', 'baseline_repair', 'review_fix', 'conflict_resolution')),
    occurred_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    CHECK ((kind = 'LoggedFindingPickedUp') = (fingerprint IS NOT NULL)),
    CHECK (kind != 'HumanCommit' OR review_run_id IS NOT NULL)
  );
  CREATE INDEX IF NOT EXISTS implicit_signals_kind_occurred ON implicit_signals(kind, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS implicit_signals_occurred ON implicit_signals(occurred_at);
  CREATE INDEX IF NOT EXISTS publication_commands_commit_sha ON publication_commands(commit_sha);
  CREATE INDEX IF NOT EXISTS publication_commands_pull_request ON publication_commands(pull_request_number);
`

/** The id names what makes a signal one event, so a repeat observation inserts nothing. */
function signalId(parts: ReadonlyArray<string | number>): string {
  return createHash('sha256').update(`implicit-signal:${parts.join(':')}`).digest('hex')
}

interface SignalRow {
  id: string
  subjectId: number
  kind: ImplicitSignalKind
  headSha: string
  fingerprint: string | null
  reviewRunId: string | null
  openedBy: OpeningWork | null
  occurredAt: string
  recordedAt: string
}

function insertSignal(database: DatabaseSync, row: SignalRow): void {
  database.prepare(`
    INSERT OR IGNORE INTO implicit_signals
      (id, subject_id, kind, head_sha, fingerprint, review_run_id, opened_by, occurred_at, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(row.id, row.subjectId, row.kind, row.headSha, row.fingerprint, row.reviewRunId, row.openedBy, row.occurredAt, row.recordedAt)
}

/** Agent work is a pull request the service opened, or one a trusted author such as Harlan opened. */
export function isAgentPullRequest(pullRequest: Pick<GitHubPullRequestItem, 'author' | 'controllerOwned'>, trustedAuthors: readonly string[]): boolean {
  return pullRequest.controllerOwned === true || trustedAuthors.some(author => author.toLowerCase() === pullRequest.author.toLowerCase())
}

function servicePublished(database: DatabaseSync, commitSha: string): boolean {
  return database.prepare('SELECT 1 FROM publication_commands WHERE commit_sha = ? LIMIT 1').get(commitSha) !== undefined
}

/** Issue work opens its pull request from the issue, so the Task's own Item names the repository. */
export function openingWork(database: DatabaseSync, subjectId: number): OpeningWork | null {
  const row = database.prepare(`
    SELECT tasks.kind FROM subjects AS pull_requests
    JOIN publication_commands
      ON publication_commands.pull_request_number = pull_requests.github_number
      AND publication_commands.state_tag = 'Published'
    JOIN tasks ON tasks.id = publication_commands.task_id
    JOIN subjects AS items ON items.id = tasks.subject_id AND items.repository_id = pull_requests.repository_id
      AND items.id != pull_requests.id
    WHERE pull_requests.id = ?
    ORDER BY publication_commands.published_at
    LIMIT 1
  `).get(subjectId) as { kind: string } | undefined
  switch (row?.kind) {
    case 'issue_work':
    case 'baseline_repair':
    case 'review_fix':
      return row.kind
    case 'resolve_conflict':
      return 'conflict_resolution'
    default:
      return null
  }
}

/**
 * Records a human commit: a head with no Publication command replaced a READY head.
 * Every service push has one. Sessions on the service host commit as the GitHub App, so the author cannot tell.
 */
export function recordHeadChangeSignal(database: DatabaseSync, input: { subjectId: number, headSha: string, occurredAt: string, at: string }): void {
  // CI can settle after the Review run, so the gate projection holds the READY GitHub shows.
  const latest = database.prepare(`
    SELECT review_runs.id, COALESCE(review_gate_projections.outcome_tag, review_runs.outcome_tag) AS outcome_tag
    FROM review_runs
    LEFT JOIN review_gate_projections ON review_gate_projections.review_run_id = review_runs.id
    WHERE review_runs.subject_id = ? AND review_runs.head_sha != ?
    ORDER BY review_runs.completed_at DESC, review_runs.id DESC
    LIMIT 1
  `).get(input.subjectId, input.headSha) as { id: string, outcome_tag: ReviewOutcome['_tag'] } | undefined
  if (latest?.outcome_tag !== 'Ready' || servicePublished(database, input.headSha))
    return
  insertSignal(database, {
    id: signalId(['HumanCommit', latest.id]),
    subjectId: input.subjectId,
    kind: 'HumanCommit',
    headSha: input.headSha,
    fingerprint: null,
    reviewRunId: latest.id,
    openedBy: openingWork(database, input.subjectId),
    occurredAt: input.occurredAt,
    recordedAt: input.at,
  })
}

/** True when every head after the first observed one is a service publication. */
function untouched(database: DatabaseSync, subjectId: number): boolean {
  return database.prepare(`
    WITH heads AS (
      SELECT json_extract(payload, '$.headSha') AS head_sha, MIN(json_extract(payload, '$.updatedAt')) AS first_seen
      FROM revisions WHERE subject_id = ?
      GROUP BY head_sha
    )
    SELECT 1 FROM heads
    WHERE first_seen > (SELECT MIN(first_seen) FROM heads)
      AND NOT EXISTS (SELECT 1 FROM publication_commands WHERE commit_sha = heads.head_sha)
    LIMIT 1
  `).get(subjectId) === undefined
}

/**
 * Records a close or merge GitHub confirmed, on a pull request the service
 * opened or reviewed. The service never closes a pull request, so a close
 * without merge came from a person.
 */
export function recordClosureSignal(database: DatabaseSync, input: { subjectId: number, pullRequest: GitHubPullRequestItem, at: string }): void {
  const openedBy = openingWork(database, input.subjectId)
  const reviewed = database.prepare('SELECT 1 FROM review_runs WHERE subject_id = ? LIMIT 1').get(input.subjectId) !== undefined
  if (openedBy === null && !reviewed)
    return
  const { headSha, mergedAt } = input.pullRequest
  if (mergedAt !== null && !untouched(database, input.subjectId))
    return
  const review = database.prepare(`
    SELECT id FROM review_runs WHERE subject_id = ? AND head_sha = ?
    ORDER BY completed_at DESC, id DESC
    LIMIT 1
  `).get(input.subjectId, headSha) as { id: string } | undefined
  const kind = mergedAt === null ? 'ClosedUnmerged' : 'MergedUntouched'
  insertSignal(database, {
    id: signalId(mergedAt === null ? [kind, input.subjectId, headSha] : [kind, input.subjectId]),
    subjectId: input.subjectId,
    kind,
    headSha,
    fingerprint: null,
    reviewRunId: review?.id ?? null,
    openedBy,
    occurredAt: mergedAt ?? input.pullRequest.updatedAt,
    recordedAt: input.at,
  })
}

/** Records a person asking an agent to fix one Logged Review finding. */
export function recordLoggedFindingSignal(database: DatabaseSync, input: { subjectId: number, headSha: string, fingerprint: string, reviewRunId: string, at: string }): void {
  insertSignal(database, {
    id: signalId(['LoggedFindingPickedUp', input.subjectId, input.headSha, input.fingerprint]),
    subjectId: input.subjectId,
    kind: 'LoggedFindingPickedUp',
    headSha: input.headSha,
    fingerprint: input.fingerprint,
    reviewRunId: input.reviewRunId,
    openedBy: openingWork(database, input.subjectId),
    occurredAt: input.at,
    recordedAt: input.at,
  })
}

interface ImplicitSignalListRow {
  kind: ImplicitSignalKind
  repository: string
  github_number: number
  title: string | null
  head_sha: string
  occurred_at: string
  opened_by: OpeningWork | null
  review_run_id: string | null
  review_head_sha: string | null
  outcome_tag: ReviewOutcome['_tag'] | null
  confidence: number | null
  finding_json: string | null
}

function reviewOf(row: ImplicitSignalListRow): ImplicitSignalReview | null {
  if (row.review_run_id === null || row.review_head_sha === null || row.outcome_tag === null)
    return null
  return {
    id: row.review_run_id,
    headSha: row.review_head_sha,
    outcome: row.confidence === null ? { _tag: row.outcome_tag } : { _tag: row.outcome_tag, confidence: row.confidence },
  }
}

function signalOf(row: ImplicitSignalListRow): ImplicitSignal | null {
  const base: ImplicitSignalBase = {
    repository: row.repository,
    pullRequestNumber: row.github_number,
    title: row.title ?? '',
    headSha: row.head_sha,
    occurredAt: row.occurred_at,
    openedBy: row.opened_by,
  }
  const reviewRun = reviewOf(row)
  switch (row.kind) {
    case 'HumanCommit':
      // The schema requires the Review run; a missing one means it was deleted.
      return reviewRun === null ? null : { ...base, _tag: 'HumanCommit', reviewRun }
    case 'ClosedUnmerged':
    case 'MergedUntouched':
      return { ...base, _tag: row.kind, reviewRun }
    case 'LoggedFindingPickedUp':
      return row.finding_json === null ? null : { ...base, _tag: 'LoggedFindingPickedUp', reviewRun, finding: JSON.parse(row.finding_json) as LoggedReviewFinding }
  }
}

export function createImplicitSignalStore(database: DatabaseSync): ImplicitSignalStore {
  const latest = database.prepare(`
    SELECT implicit_signals.kind, repositories.github AS repository, subjects.github_number,
      json_extract(revisions.payload, '$.title') AS title,
      implicit_signals.head_sha, implicit_signals.occurred_at, implicit_signals.opened_by,
      review_runs.id AS review_run_id, review_runs.head_sha AS review_head_sha,
      COALESCE(review_gate_projections.outcome_tag, review_runs.outcome_tag) AS outcome_tag,
      COALESCE(review_gate_projections.confidence, review_runs.confidence) AS confidence,
      logged_finding_requests.finding_json
    FROM implicit_signals
    JOIN subjects ON subjects.id = implicit_signals.subject_id
    JOIN repositories ON repositories.id = subjects.repository_id
    LEFT JOIN revisions ON revisions.id = subjects.current_revision_id
    LEFT JOIN review_runs ON review_runs.id = implicit_signals.review_run_id
    LEFT JOIN review_gate_projections ON review_gate_projections.review_run_id = review_runs.id
    LEFT JOIN logged_finding_requests
      ON logged_finding_requests.subject_id = implicit_signals.subject_id
      AND logged_finding_requests.head_sha = implicit_signals.head_sha
      AND logged_finding_requests.fingerprint = implicit_signals.fingerprint
    WHERE implicit_signals.kind = ? AND (? = 'Any' OR implicit_signals.opened_by IS NOT NULL)
    ORDER BY implicit_signals.occurred_at DESC, implicit_signals.id
    LIMIT ?
  `)
  return {
    listImplicitSignals: ({ kinds, limitPerKind, origin }) => {
      const limit = Math.max(0, Math.min(100, Math.trunc(limitPerKind)))
      return [...new Set(kinds)]
        .flatMap(kind => (latest.all(kind, origin, limit) as unknown as ImplicitSignalListRow[]).flatMap(row => signalOf(row) ?? []))
        .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    },
  }
}
