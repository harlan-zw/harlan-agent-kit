import type { AgentProviderName, AgentTokenUsage } from './agent-provider.ts'
import type { TransientKind } from './failure.ts'
import type { IssueTriageState } from './issue-triage.ts'
import type { RecordPullRequestTriageRunInput, RecordPullRequestTriageRunResult, StatsFact, StatsRange, StatsSnapshot, StatsTaskKind } from './stats.ts'
import type {
  AdversarialReviewTask,
  AgentFeedback,
  AgentFeedbackInput,
  AgentFeedbackSignal,
  AgentProfile,
  AgentProgress,
  AgentRole,
  AgentSelection,
  AgentTask,
  BaselineRepairTask,
  Candidate,
  CandidateIssueCommand,
  CandidateResult,
  ClaimedAdversarialReviewTask,
  ClaimedBaselineRepairTask,
  ClaimedCandidateIssueCommand,
  ClaimedConflictResolutionTask,
  ClaimedIssueTriageCommentCommand,
  ClaimedIssueTriageTask,
  ClaimedIssueWorkTask,
  ClaimedPublicationCommand,
  ClaimedReviewFixTask,
  ClaimedReviewStatusCommand,
  ClaimedRoutineReportCommand,
  ClaimedRoutineRun,
  ConflictResolutionTask,
  DashboardAgent,
  DashboardSnapshot,
  DashboardTask,
  GitHubItem,
  GitHubPullRequestItem,
  Incident,
  IncidentKind,
  IncidentRecovery,
  IncidentScope,
  IssueTriageTask,
  IssueWorkApprovalResult,
  IssueWorkTask,
  ItemDismissalResult,
  ItemSummary,
  OpenAgentPullRequest,
  PinnedAgentSelection,
  PreparedPublication,
  ProviderCircuit,
  ProviderFailureClass,
  ProviderStartReservation,
  PullRequestApprovalKind,
  PullRequestApprovalResult,
  PullRequestApprovalState,
  QueueEntry,
  QueueState,
  RecordAgentFeedbackResult,
  RecordReviewPublicationInput,
  RecordReviewPublicationResult,
  RecordReviewRunInput,
  RecordReviewRunRejection,
  RecordReviewRunResult,
  RepairRound,
  RepositoryMapping,
  RepositoryStatus,
  RestartOperation,
  RestartRequest,
  RestartRequestSource,
  ReviewDesiredOutcome,
  ReviewFinding,
  ReviewFixQueueResult,
  ReviewFixTask,
  ReviewGates,
  ReviewOutcome,
  ReviewPublication,
  ReviewPublicationResult,
  ReviewRerunResult,
  ReviewRerunSource,
  ReviewResolution,
  ReviewRun,
  ReviewStatusTaskPhase,
  Routine,
  RoutineIssueSource,
  RoutineReportCommand,
  RoutineReportCommandState,
  RoutineRun,
  RoutineRunState,
  RoutineSpecEntry,
  SelectionMode,
  ServiceUpdateStatus,
  StoredAgentControl,
  SupersedeReviewRunInput,
  SupersedeReviewRunResult,
  TaskState,
  WorkflowEvent,
  WorkflowEventStream,
} from './types.ts'
import type { AgentWorktreeLease } from './worktree.ts'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { redactSecrets, truncateOutput } from './agent-activity.ts'
import { AGENT_MODELS, AGENT_PROVIDER_NAMES, CODEX_AGENT_PROFILE, parseAgentSelection, providerAgentSelection, REASONING_EFFORTS, resolveAgentProfile, resolveAgentSelection } from './agent-profile.ts'
import { classifyFailure, isTransientFailure, MAXIMUM_RECOVERY_ATTEMPTS, mayRetryFailure, nextRecoveryAt, REVIEW_REPAIR_REFUSALS } from './failure.ts'
import { isRepositoryWriteQuarantineReason } from './github-write-gate.ts'
import { isIssueTriageState } from './issue-triage.ts'
import { planRepairRound, REPAIR_ROUND_LIMIT } from './repair-rounds.ts'
import { canRepairBaseline, canRepairPullRequestHead, canWorkIssues } from './repository-policy.ts'
import { buildStats } from './stats.ts'
import { cleanLine } from './text.ts'

export interface RecordIncidentInput {
  scope: IncidentScope
  kind: IncidentKind
  severity: 'warning' | 'error'
  /** What the controller was doing, for example `poll` or `adversarial_review`. */
  operation: string
  message: string
  recovery: IncidentRecovery
  at: string
}

interface IncidentRow {
  id: string
  scope_tag: IncidentScope['_tag']
  repository: string | null
  task_id: string | null
  subject_number: number | null
  kind: IncidentKind
  severity: 'warning' | 'error'
  operation: string
  message: string
  recovery: string
  occurrences: number
  first_seen_at: string
  last_seen_at: string
}

interface RestartRequestRow {
  id: string
  source_tag: RestartRequestSource
  operation_tag: RestartOperation['_tag']
  target_commit: string | null
  state_tag: RestartRequest['_tag']
  requested_at: string
  restarting_at: string | null
  completed_at: string | null
  action_required_at: string | null
  reason: string | null
}

function incidentScope(row: IncidentRow): IncidentScope {
  if (row.scope_tag === 'Repository')
    return { _tag: 'Repository', repository: row.repository ?? '' }
  if (row.scope_tag === 'Task') {
    return {
      _tag: 'Task',
      taskId: row.task_id ?? '',
      repository: row.repository ?? '',
      itemNumber: row.subject_number,
    }
  }
  return { _tag: 'Service' }
}

function incidentFromRow(row: IncidentRow): Incident {
  return {
    id: row.id,
    scope: incidentScope(row),
    kind: row.kind,
    severity: row.severity,
    message: row.message,
    operation: row.operation,
    recovery: JSON.parse(row.recovery) as IncidentRecovery,
    occurrences: row.occurrences,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  }
}

/**
 * Identifies one Incident by what it is, never by when it happened.
 *
 * A degraded GitHub hour repeats the same failure once a minute for every
 * repository. Folding those into one row per cause keeps the pane readable.
 */
function upsertIncident(database: DatabaseSync, input: RecordIncidentInput): Incident {
  const id = incidentId(input)
  const scope = input.scope
  database.prepare(`
    INSERT INTO incidents (
      id, scope_tag, repository, task_id, subject_number, kind, severity,
      operation, message, recovery, occurrences, first_seen_at, last_seen_at, resolved_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET
      occurrences = incidents.occurrences + 1,
      last_seen_at = excluded.last_seen_at,
      severity = excluded.severity,
      recovery = excluded.recovery,
      resolved_at = NULL
  `).run(
    id,
    scope._tag,
    scope._tag === 'Service' ? null : scope.repository,
    scope._tag === 'Task' ? scope.taskId : null,
    scope._tag === 'Task' ? scope.itemNumber : null,
    input.kind,
    input.severity,
    input.operation,
    input.message,
    JSON.stringify(input.recovery),
    input.at,
    input.at,
  )
  return incidentFromRow(database.prepare('SELECT * FROM incidents WHERE id = ?').get(id) as unknown as IncidentRow)
}

/**
 * Names a Task that reached Failed, so the failure has one place a person reads.
 *
 * The recovery it reports is what the controller will actually do next, which
 * is what makes the difference between "this is handling itself" and "this is
 * waiting for you" visible without reading the journal.
 */
function recordTaskIncident(database: DatabaseSync, taskId: string, reason: string, at: string): void {
  const row = database.prepare(`
    SELECT repositories.github AS repository, subjects.github_number, source.kind, source.recovery_attempts
    FROM (
      SELECT id, subject_id, kind, recovery_attempts FROM worker_tasks WHERE id = ?
      UNION ALL
      SELECT id, subject_id, kind, recovery_attempts FROM tasks WHERE id = ?
    ) AS source
    JOIN subjects ON subjects.id = source.subject_id
    JOIN repositories ON repositories.id = subjects.repository_id
  `).get(taskId, taskId) as { repository: string, github_number: number, kind: string, recovery_attempts: number } | undefined
  if (row === undefined)
    return
  // A Task has one current failure. A later failure replaces the earlier cause
  // instead of leaving several contradictory recovery instructions visible.
  resolveTaskIncidents(database, taskId, at)
  if (isRepositoryWriteQuarantineReason(reason))
    return
  const failure = classifyFailure({ message: reason })
  const providerWillRetry = failure._tag === 'Transient' && failure.kind === 'agent_provider'
  const exhausted = row.recovery_attempts >= MAXIMUM_RECOVERY_ATTEMPTS && !providerWillRetry
  upsertIncident(database, {
    // One provider outage can stop every active Task. Keep each Task's retry
    // state in its own journal row, while the System pane reports one cause.
    scope: providerWillRetry
      ? { _tag: 'Service' }
      : { _tag: 'Task', taskId, repository: row.repository, itemNumber: row.github_number },
    kind: failure.kind,
    severity: failure._tag === 'Transient' && !exhausted ? 'warning' : 'error',
    operation: providerWillRetry ? 'agent_provider' : row.kind,
    message: reason,
    recovery: failure._tag !== 'Transient'
      ? { _tag: 'ActionRequired' }
      : exhausted
        ? { _tag: 'Exhausted' }
        : { _tag: 'Retrying', attempt: row.recovery_attempts + 1, nextAttemptAt: nextRecoveryAt(at, row.recovery_attempts) },
    at,
  })
}

/**
 * Closes every open Incident for one Task.
 *
 * An Incident describes work the controller still intends to do. Once the Task
 * completes, or a newer Revision supersedes it, that stops being true and the
 * Incident is only noise in the System pane.
 */
function resolveTaskIncidents(database: DatabaseSync, taskId: string, at: string): void {
  database.prepare(`
    UPDATE incidents SET resolved_at = ?
    WHERE resolved_at IS NULL AND scope_tag = 'Task' AND task_id = ?
  `).run(at, taskId)
}

/** Failure kinds an outage causes, and that a healthy GitHub therefore clears. */
const githubOutageKinds = new Set<TransientKind>(['github_access', 'github_unavailable', 'rate_limit', 'network'])

/**
 * Gives back the recovery budget an outage spent.
 *
 * Only failures GitHub itself caused qualify. A Task that exhausted its budget
 * on a real defect keeps its `Exhausted` recovery, because a healthy GitHub says
 * nothing about that defect.
 *
 * Returns how many Tasks were given another chance.
 */
function restoreRecoveryBudget(database: DatabaseSync, github: string, at: string): number {
  const candidates = (table: 'tasks' | 'worker_tasks') => database.prepare(`
    SELECT ${table}.id, ${table}.reason, ${table}.fence
    FROM ${table}
    JOIN subjects ON subjects.id = ${table}.subject_id
    JOIN repositories ON repositories.id = subjects.repository_id
    WHERE ${table}.state_tag = 'Failed'
      AND ${table}.recovery_attempts >= ?
      AND ${table}.revision_id = subjects.current_revision_id
      AND repositories.github = ?
      AND repositories.enabled = 1
  `).all(MAXIMUM_RECOVERY_ATTEMPTS, github) as unknown as Array<{ id: string, reason: string | null, fence: number }>

  let restored = 0
  for (const table of ['tasks', 'worker_tasks'] as const) {
    const reset = database.prepare(`
      UPDATE ${table}
      SET recovery_attempts = 0, updated_at = ?
      WHERE id = ? AND state_tag = 'Failed'
    `)
    for (const row of candidates(table)) {
      if (row.reason === null)
        continue
      const failure = classifyFailure({ message: row.reason })
      if (failure._tag !== 'Transient' || !githubOutageKinds.has(failure.kind))
        continue
      if (reset.run(at, row.id).changes !== 1)
        continue
      restored += 1
      // The Task is recoverable again, so its Incident stops saying otherwise.
      // `retryRecoverableWorkerFailures` requeues it on the next pass.
      resolveTaskIncidents(database, row.id, at)
    }
  }
  return restored
}

interface RecoveryCandidateRow {
  id: string
  fence: number
  reason: string | null
  recovery_attempts: number
  updated_at: string
  repository: string
  github_number: number
}

/**
 * Decides whether one Failed Task may be requeued now.
 *
 * A Task retries while its failure describes a passing condition, while it has
 * recovery budget left, and once its backoff has elapsed. All three matter: the
 * first stops the controller redoing genuine defects, the second stops one
 * broken repository holding an agent slot forever, and the third stops a
 * degraded GitHub minute turning into a spin.
 */
function isRecoverable(row: RecoveryCandidateRow, at: string): boolean {
  if (row.reason === null)
    return false
  const failure = classifyFailure({ message: row.reason })
  if (failure._tag !== 'Transient')
    return false
  // A provider outage cannot be fixed by a person. Keep checking it at capped
  // backoff so every Task resumes after the selected provider recovers.
  if (row.recovery_attempts >= MAXIMUM_RECOVERY_ATTEMPTS && failure.kind !== 'agent_provider')
    return false
  return Date.parse(at) >= Date.parse(nextRecoveryAt(row.updated_at, row.recovery_attempts))
}

function incidentId(input: Pick<RecordIncidentInput, 'scope' | 'kind' | 'operation' | 'message'>): string {
  const scope = input.scope._tag === 'Repository'
    ? `Repository:${input.scope.repository}`
    : input.scope._tag === 'Task'
      ? `Task:${input.scope.taskId}`
      : 'Service'
  return digest(`${scope}:${input.kind}:${input.operation}:${input.message}`)
}

interface StoppedReviewRow {
  task_id: string
  task_kind: 'adversarial_review' | 'review_fix'
  repository: string
  github_number: number
  revision_id: string
  head_sha: string
  closure_revision_id: string
  current_head_sha: string
  current_base_sha: string
  reason: string
  current_state: string
  current_merged_at: string | null
  github_comment_id: number
  published_body: string
  findings: string
}

/**
 * How the pull request ended, as the last poll saw it.
 *
 * `Stopped` means the pull request is still open, so only the Task behind the
 * comment ended. The other two are final, and GitHub cannot take them back
 * without creating a Revision of its own.
 */
export type StoppedReviewDisposition
  = | { _tag: 'Stopped' }
    | { _tag: 'Merged' }
    | { _tag: 'Closed' }

export type ReviewClosureDisposition = Exclude<StoppedReviewDisposition, { _tag: 'Stopped' }>

export type ReviewClosureResult
  = | { _tag: 'Published', body: string, commentId: number, url: string }
    | { _tag: 'CommentGone' }
    | { _tag: 'Superseded' }

export interface StoppedReview {
  taskId: string
  taskKind: 'adversarial_review' | 'review_fix'
  repository: string
  pullRequestNumber: number
  revisionId: string
  headSha: string
  closureRevisionId: string
  currentHeadSha: string
  currentBaseSha: string
  reason: string
  /**
   * Lets the sweep skip its GitHub read on a closed pull request.
   *
   * A closed pull request whose head branch is deleted answers no snapshot
   * request at all, and its stale comment used to fail every pass with
   * "Branch not found". Nothing about a closed pull request can change without
   * a new Revision, so the stored answer is the current one.
   */
  disposition: StoppedReviewDisposition
  commentId: number
  /** What the canonical comment holds now, so the edit can compare and swap. */
  publishedBody: string
  findings: ReviewFinding[]
}

/** A published clean Review whose moving controller gates need another read. */
export interface ReviewGateRefresh {
  reviewRunId: string
  repository: string
  pullRequestNumber: number
  revisionId: string
  headSha: string
  provider: AgentProviderName | 'claude'
  sessionId: string
  model: string
  agentVersion: string
  skillDigest: string
  startedAt: string
  completedAt: string
  usage: AgentTokenUsage
  gates: ReviewGates
  findings: ReviewFinding[]
  /** The agent's own score, kept whatever the gates said. */
  confidence: number | undefined
  commentId: number
  /** What the canonical comment holds now, so the edit can compare and swap. */
  publishedBody: string
}

interface ReviewGateRefreshRow {
  review_run_id: string
  repository: string
  github_number: number
  revision_id: string
  head_sha: string
  provider: AgentProviderName | 'claude'
  session_id: string
  model: string
  agent_version: string
  skill_digest: string
  started_at: string
  completed_at: string
  usage: string
  gates: string
  findings: string
  confidence: number | null
  github_comment_id: number
  published_body: string
}

interface QueuedReviewStatusRow {
  task_id: string
  task_kind: 'adversarial_review' | 'review_fix'
  repository: string
  github_number: number
  revision_id: string
  head_sha: string
  paused: number
  answered: number
  position: number | null
  total: number | null
  github_comment_id: number
  published_body: string
  prior_head_sha: string | null
  prior_outcome: string | null
  prior_findings: number | null
  head_from_repair: number
}

/**
 * Why a queued Task has not started yet.
 *
 * A paused repository still queues Tasks and still owns the canonical comment,
 * but no agent can claim one until the pause lifts. A Queue position there is a
 * number that never moves, so the comment names the pause instead.
 */
export type ReviewQueueState
  = | {
    _tag: 'Waiting'
    /** 1 for the Task the next free agent claims. */
    position: number
    /** Claimable queued Tasks of the same kind, this one included. */
    total: number
  }
  | { _tag: 'Paused' }

/**
 * Whether a Review has answered for the Revision this Task waits on.
 *
 * The verdict label on the pull request names the head its Review answered
 * for. A Task queued against a head no Review has reached yet means the label
 * still describes an older head, so it says nothing true about this one.
 */
export type ReviewVerdictState
  = | { _tag: 'Answered' }
    | { _tag: 'Unanswered' }

/**
 * What already happened on this pull request, for a Task that has not started.
 *
 * A Review of the controller's own Repair looked exactly like a first Review:
 * a bare QUEUED comment, no defect count, no sign that anything had run. A
 * reader could not tell whether the Queue was making progress at all.
 */
export type QueuedReviewHistory
  = | { _tag: 'FirstReview' }
    | {
      _tag: 'AfterRepair' | 'AfterPush'
      priorHeadSha: string
      priorOutcome: string
      findings: number
    }

export interface QueuedReviewStatus {
  taskId: string
  taskKind: 'adversarial_review' | 'review_fix'
  repository: string
  pullRequestNumber: number
  revisionId: string
  headSha: string
  queue: ReviewQueueState
  verdict: ReviewVerdictState
  /** The Review that answered the previous head, and how this head arrived. */
  history: QueuedReviewHistory
  commentId: number
  /** What the canonical comment holds now, so an unchanged position writes nothing. */
  publishedBody: string
}

export type RecordObservationResult
  = | { _tag: 'Inserted', revisionId: string }
    | { _tag: 'Duplicate', revisionId: string }
    | { _tag: 'Stale', revisionId: string, currentRevisionId: string }
    | { _tag: 'Conflict', existingRevisionId: string, receivedRevisionId: string }

export type StagePublicationResult
  = | { _tag: 'Staged', commandId: string }
    | { _tag: 'Duplicate', commandId: string }
    | { _tag: 'Rejected', reason: string }

export type CancelTaskResult
  = | { _tag: 'Cancelled' }
    | { _tag: 'AlreadyCancelled' }
    | { _tag: 'Rejected', reason: { _tag: 'TaskNotFound' | 'TaskFinished' } }

type StageReviewStatusInput = {
  taskId: string
  workerId: string
  fence: number
  at: string
  revisionId: string
  expectedHeadSha: string
  body: string
  reviewRunId?: string
  desiredOutcome?: ReviewDesiredOutcome
} & ReviewStatusTaskPhase

interface StageReviewGateStatusInput {
  reviewRunId: string
  repository: string
  pullRequestNumber: number
  revisionId: string
  expectedHeadSha: string
  gates: ReviewGates
  body: string
  desiredOutcome: ReviewDesiredOutcome
  /** Adds a fresh repair command when GitHub drifted from an unchanged projection. */
  reconciliationId?: string
  at: string
}

type UnpositionedQueueEntry = QueueEntry extends infer Entry
  ? Entry extends QueueEntry ? Omit<Entry, 'position'> : never
  : never

export interface JournalStore {
  approveIssueWork: (input: {
    repository: string
    issueNumber: number
    revisionId: string
    at: string
  }) => IssueWorkApprovalResult
  isIssueWorkApprovalReady: (repository: string, issueNumber: number, revisionId: string) => boolean
  approvePullRequest: (input: {
    repository: string
    pullRequestNumber: number
    revisionId: string
    kind: PullRequestApprovalKind
    at: string
  }) => PullRequestApprovalResult
  authorizePublication: (input: { commandId: string, workerId: string, fence: number, at: string }) => boolean
  cancelTask: (input: { taskId: string, at: string }) => CancelTaskResult
  recordPullRequestTriageRun: (input: RecordPullRequestTriageRunInput) => RecordPullRequestTriageRunResult
  claimNextAdversarialReviewTask: (workerId: string, now: string, leaseMilliseconds: number) => ClaimedAdversarialReviewTask | null
  claimNextBaselineRepairTask: (workerId: string, now: string, leaseMilliseconds: number) => ClaimedBaselineRepairTask | null
  claimNextConflictTask: (workerId: string, now: string, leaseMilliseconds: number) => ClaimedConflictResolutionTask | null
  claimNextIssueTriageTask: (workerId: string, now: string, leaseMilliseconds: number) => ClaimedIssueTriageTask | null
  claimNextIssueWorkTask: (workerId: string, now: string, leaseMilliseconds: number) => ClaimedIssueWorkTask | null
  claimNextReviewFixTask: (workerId: string, now: string, leaseMilliseconds: number) => ClaimedReviewFixTask | null
  queueReviewFixTaskForReview: (input: {
    taskId: string
    workerId: string
    fence: number
    at: string
  }) => ReviewFixQueueResult
  /** Stores one Repair Agent's report under its fenced lease, before its commit is staged. */
  recordRepairReport: (input: { taskId: string, workerId: string, fence: number, at: string, summary: string, checks: string[] }) => boolean
  queueBaselineRepairForReview: (input: {
    taskId: string
    workerId: string
    fence: number
    baseSha: string
    at: string
  }) => { _tag: 'Queued' | 'Existing', taskId: string }
    | { _tag: 'Rejected', reason: string }
    | { _tag: 'NotAuthorized', reason: string }
  /**
   * Retires a dead Baseline repair once a review proves the base is healthy.
   *
   * A Baseline repair exists for one red base commit. Nothing else ever
   * retires it, so a failed one used to sit in the dashboard for good once
   * that commit went green or moved on.
   */
  retireBaselineRepairForReview: (input: {
    taskId: string
    workerId: string
    fence: number
    at: string
  }) => number
  claimNextPublication: (workerId: string, now: string, leaseMilliseconds: number) => ClaimedPublicationCommand | null
  claimIssueTriageComment: (commandId: string, workerId: string, now: string, leaseMilliseconds: number) => ClaimedIssueTriageCommentCommand | null
  claimReviewStatus: (commandId: string, workerId: string, now: string, leaseMilliseconds: number) => ClaimedReviewStatusCommand | null
  /** Claims one terminal Publication whose Agent Task no longer runs. */
  claimNextTerminalReviewStatus: (workerId: string, now: string, leaseMilliseconds: number) => ClaimedReviewStatusCommand | null
  close: () => void
  /** Replaces one repository's Routines with the spec its default branch declares. */
  syncRoutines: (input: { repository: string, specSha: string, entries: readonly RoutineSpecEntry[], at: string }) => Routine[]
  listRoutines: (repository?: string) => Routine[]
  /** Inserts one run for one exact cron instant. Answers null when it already exists. */
  openRoutineRun: (input: { routineId: string, scheduledFor: string, specSha: string, at: string }) => RoutineRun | null
  /** Records an instant that fell outside the catch-up window, so a missed run stays visible. */
  skipRoutineRun: (input: { routineId: string, scheduledFor: string, specSha: string, reason: string, at: string }) => RoutineRun | null
  getRoutineRun: (runId: string) => RoutineRun | null
  listRoutineRuns: (routineId: string, limit?: number) => RoutineRun[]
  recordCandidates: (input: { routineId: string, runId: string, candidates: ReadonlyArray<Omit<Candidate, 'id' | 'routineId' | 'runId' | 'result' | 'createdAt' | 'updatedAt'>>, at: string }) => Candidate[]
  listCandidates: (routineId: string) => Candidate[]
  /** Finds controller-owned Routine provenance for one published Candidate issue. */
  getRoutineIssueSource: (repository: string, issueNumber: number) => RoutineIssueSource | null
  /** Requests one issue per Candidate. Answers how many are new. */
  stageCandidateIssues: (input: { commands: readonly CandidateIssueCommand[], at: string }) => number
  claimNextCandidateIssue: (workerId: string, now: string, leaseMilliseconds: number) => ClaimedCandidateIssueCommand | null
  completeCandidateIssue: (input: { commandId: string, workerId: string, fence: number, at: string, issueNumber: number, url: string }) => boolean
  /**
   * Records one failed attempt at filing a Candidate's issue.
   *
   * `Deferred` returns the command to Pending for the next pass. `Failed` is
   * terminal: GitHub refused in a way no retry changes, or the command spent
   * its attempts. `Unchanged` means the lease moved on before this call.
   */
  failCandidateIssue: (input: { commandId: string, workerId: string, fence: number, at: string, reason: string, status?: number | undefined }) => 'Deferred' | 'Failed' | 'Unchanged'
  /** Requests the run log entry for one run. Answers false when it already exists. */
  stageRoutineReport: (input: { command: RoutineReportCommand, at: string }) => boolean
  claimNextRoutineReport: (workerId: string, now: string, leaseMilliseconds: number, excludedCommandIds?: readonly string[]) => ClaimedRoutineReportCommand | null
  completeRoutineReport: (input: { commandId: string, workerId: string, fence: number, at: string, commentId: number, trackingIssueNumber: number }) => boolean
  recordRoutineReportReceipt: (input: { commandId: string, workerId: string, fence: number, at: string, sink: 'tracking_issue' | 'run_comment' }) => boolean
  failRoutineReport: (input: { commandId: string, workerId: string, fence: number, at: string, reason: string }) => boolean
  claimNextRoutineRun: (workerId: string, now: string, leaseMilliseconds: number) => ClaimedRoutineRun | null
  heartbeatRoutineRun: (input: { taskId: string, workerId: string, fence: number, at: string, leaseMilliseconds: number }) => boolean
  updateRoutineRunProgress: (input: { taskId: string, workerId: string, fence: number, progress: AgentProgress, at: string }) => boolean
  completeRoutineRun: (input: { taskId: string, workerId: string, fence: number, at: string, evidence: string, usage?: AgentTokenUsage }) => boolean
  failRoutineRun: (input: { taskId: string, workerId: string, fence: number, at: string, reason: string }) => 'Retrying' | 'Failed' | 'Rejected'
  /** Issues absent from the next open snapshot need one exact final GitHub read. */
  listOpenIssueNumbers: (github: string) => number[]
  /** Pull requests absent from the next open snapshot need one exact final GitHub read. */
  listOpenPullRequestNumbers: (github: string) => number[]
  /** Old inferred closures need one exact read before GitHub becomes final truth. */
  listUnverifiedClosedPullRequestNumbers: (github: string, limit?: number) => number[]
  /** Records one exact pull request read without trusting a local closure timestamp. */
  recordExactPullRequestObservation: (input: {
    externalId: string
    observedAt: string
    subject: GitHubPullRequestItem
  }) => RecordObservationResult
  /** Records one exact closed pull request read from GitHub. */
  recordVerifiedPullRequestClosure: (input: {
    repository: string
    pullRequestNumber: number
    revisionId: string
    headSha: string
    baseSha: string
    disposition: ReviewClosureDisposition
    at: string
  }) => boolean
  closeMissingItems: (github: string, seen: Array<{ kind: GitHubItem['kind'], number: number }>, observedAt: string) => number
  completeTask: (input: { taskId: string, workerId: string, fence: number, at: string, evidence: string }) => boolean
  completeReviewTask: (input: { taskId: string, workerId: string, fence: number, at: string, evidence: string, resolution: ReviewResolution }) => boolean
  completeWorkerTask: (input: { taskId: string, workerId: string, fence: number, at: string, evidence: string, usage?: AgentTokenUsage }) => boolean
  completeIssueTriageComment: (input: { commandId: string, workerId: string, fence: number, at: string, commentId: number, url: string }) => boolean
  completeReviewStatus: (input: { commandId: string, workerId: string, fence: number, at: string, commentId: number, url: string }) => boolean
  recordReviewStatusReceipt: (input: {
    commandId: string
    workerId: string
    fence: number
    at: string
    sink: 'comment' | 'outcome_label'
    commentId?: number
    url?: string
  }) => boolean
  completePublication: (input: { commandId: string, workerId: string, fence: number, at: string, evidence: string }) => boolean
  deferPublication: (input: { commandId: string, workerId: string, fence: number, at: string, reason: string }) => boolean
  failTask: (input: { taskId: string, workerId: string, fence: number, at: string, reason: string }) => 'Retrying' | 'Failed' | 'Rejected'
  failWorkerTask: (input: { taskId: string, workerId: string, fence: number, at: string, reason: string }) => 'Retrying' | 'Failed' | 'Rejected'
  deferReviewStatus: (input: { commandId: string, workerId: string, fence: number, at: string, reason: string }) => boolean
  deferIssueTriageComment: (input: { commandId: string, workerId: string, fence: number, at: string, reason: string }) => boolean
  failPublication: (input: { commandId: string, workerId: string, fence: number, at: string, reason: string }) => 'Retrying' | 'Failed' | 'Rejected'
  getDashboardSnapshot: (generatedAt: string) => DashboardSnapshot
  getStats: (range: StatsRange, generatedAt: string) => StatsSnapshot
  /** Newest append-only workflow events. Reasons are redacted before storage. */
  listWorkflowEvents: (input?: { stream?: WorkflowEventStream, limit?: number }) => WorkflowEvent[]
  /** Whether one provider may accept a normal turn or one half-open canary. */
  providerCanStart: (input: { provider: AgentProviderName, credential: string, model?: string, at: string }) => boolean
  /** Atomically reserves the only half-open canary when one is due. */
  reserveProviderStart: (input: {
    provider: AgentProviderName
    credential: string
    model: string
    workerId: string
    at: string
    leaseMilliseconds: number
  }) => ProviderStartReservation
  recordProviderFailure: (input: {
    provider: AgentProviderName
    credential: string
    model: string
    failureClass: ProviderFailureClass
    detail: string
    workerId?: string
    canaryCircuitId?: string
    canaryFence?: number
    at: string
  }) => ProviderCircuit
  recordProviderSuccess: (input: {
    provider: AgentProviderName
    credential: string
    model: string
    workerId: string
    canaryCircuitId?: string
    canaryFence?: number
    at: string
  }) => number
  listProviderCircuits: () => ProviderCircuit[]
  getAgentControl: () => StoredAgentControl
  /** Never act on this Item again. Cancels live work and stops every planner. */
  dismissItem: (input: { repository: string, itemNumber: number, at: string }) => ItemDismissalResult
  /** Undoes a Dismissal, so the planners can queue work for the Item again. */
  restoreItem: (input: { repository: string, itemNumber: number, at: string }) => ItemDismissalResult
  /** The Selection mode in force. Manual waits for Harlan to select each pull request. */
  getSelectionMode: () => SelectionMode
  /** Sets the Selection mode. Active agents finish, matching how Pause behaves. */
  setSelectionMode: (mode: SelectionMode) => SelectionMode
  /** The Agent selection in force. It follows the configuration until pinned. */
  getAgentSelection: () => AgentSelection
  /** Pins the Agent provider, model, and reasoning effort, or follows the configuration. */
  selectAgent: (selection: AgentSelection, at: string) => AgentSelection
  getWorkerSession: (repository: string, itemNumber: number, role: AgentRole, scopeDigest?: string) => string | null
  heartbeatTask: (input: { taskId: string, workerId: string, fence: number, at: string, leaseMilliseconds: number }) => boolean
  heartbeatWorkerTask: (input: { taskId: string, workerId: string, fence: number, at: string, leaseMilliseconds: number }) => boolean
  heartbeatPublication: (input: { commandId: string, workerId: string, fence: number, at: string, leaseMilliseconds: number }) => boolean
  hasPullRequestApproval: (repository: string, pullRequestNumber: number, revisionId: string, kind: PullRequestApprovalKind) => boolean
  /**
   * The open pull requests this service opened in one repository.
   *
   * A new pull request may stack on one of these. Proof of authorship is a
   * Published Publication for the same head branch, so a branch a person opened
   * can never become a stack base.
   */
  listOpenAgentPullRequests: (repository: string) => OpenAgentPullRequest[]
  /**
   * Every Task lease that may still write, so a sweep can tell an agent
   * worktree still in use from one nothing will touch again.
   */
  listActiveTaskLeases: () => AgentWorktreeLease[]
  /** Every Item an Agent holds a Running Task on, so the Running label can answer for it. */
  listRunningTaskItems: () => Array<{ repository: string, itemNumber: number }>
  /**
   * Queued Tasks whose pull request already carries a canonical comment.
   *
   * Position comes from the same predicate and order the claim uses, so the
   * number a person reads is the number of Tasks that must finish first.
   */
  listQueuedReviewStatuses: () => QueuedReviewStatus[]
  /** Reviews that stopped without a final comment, so the pull request still claims one is running. */
  listReviewGateRefreshes: () => ReviewGateRefresh[]
  listStoppedReviews: () => StoppedReview[]
  /**
   * Records the Approval prompt comment, so a sweep can correct it later.
   *
   * No Task exists while a pull request waits for Approval, so this comment has
   * no Task to own it and nothing to hang a review status command on.
   */
  recordApprovalPromptComment: (input: {
    repository: string
    pullRequestNumber: number
    revisionId: string
    commentId: number
    body: string
    at: string
  }) => boolean
  /** Records the Queue position this service published on the canonical comment. */
  recordQueuedReviewStatus: (input: {
    taskId: string
    taskKind: 'adversarial_review' | 'review_fix'
    revisionId: string
    expectedHeadSha: string
    body: string
    at: string
    commentId: number
    url: string
  }) => boolean
  /**
   * True while the Task is still Queued, so a sweep may still write for it.
   *
   * The Queue read and the comment write are separated by GitHub round trips,
   * during which an agent can claim the Task. This check is synchronous, so a
   * sweep that sees false here has lost the comment to the claimed agent.
   */
  isQueuedReviewStatus: (input: { taskId: string, taskKind: 'adversarial_review' | 'review_fix' }) => boolean
  /**
   * Retires a publication after its canonical comment disappeared or moved on.
   *
   * The match is the comment identity alone. A stopped Repair inherits the
   * sibling Review's canonical comment, so the Task pair on the sweep row does
   * not name the row that carried the comment; the comment id does.
   */
  recordDeletedReviewComment: (input: {
    taskKind: 'adversarial_review' | 'review_fix'
    taskId: string
    commentId: number
    at: string
    reason: 'A person deleted the comment.' | 'Another Task replaced the canonical comment.'
  }) => boolean
  recordStoppedReviewStatus: (input: {
    taskId: string
    taskKind: 'adversarial_review' | 'review_fix'
    revisionId: string
    expectedHeadSha: string
    body: string
    at: string
    commentId: number
    url: string
  }) => boolean
  /** Records that GitHub comment and label cleanup finished for one exact closure Revision. */
  recordReviewClosure: (input: {
    repository: string
    pullRequestNumber: number
    revisionId: string
    headSha: string
    baseSha: string
    disposition: ReviewClosureDisposition
    result: ReviewClosureResult
    at: string
  }) => boolean
  listReviewRuns: (repository: string, pullRequestNumber: number) => ReviewRun[]
  /** Replaces one person's explicit judgment about one Review run. */
  recordAgentFeedback: (input: { reviewRunId: string, feedback: AgentFeedbackInput, at: string }) => RecordAgentFeedbackResult
  /** Newest explicit judgments with the Review evidence needed by the feedback Routine. */
  listAgentFeedback: (limit?: number) => AgentFeedbackSignal[]
  /** Exact open findings the current Review handed to its Repair Task. */
  getReviewFixFindings: (repository: string, pullRequestNumber: number, revisionId: string) => ReviewFinding[]
  /**
   * Open findings of the Revision whose published Repair produced one head SHA.
   *
   * A fresh Review session words defects differently, so these stored
   * identities go back into its prompt and it reuses them verbatim.
   */
  getRepairedHeadFindings: (repository: string, pullRequestNumber: number, commitSha: string) => ReviewFinding[]
  /** Open pull requests across enabled repositories, which is the work waiting on Harlan. */
  countOpenPullRequests: () => number
  needsAttentionTask: (input: { taskId: string, workerId: string, fence: number, at: string, reason: string, evidence: string, usage?: AgentTokenUsage }) => boolean
  requestRestart: (input: { id: string, source: RestartRequestSource, operation: RestartOperation, at: string }) => RestartRequest
  getRestartRequest: () => RestartRequest | null
  beginRestart: (input: { id: string, processId: string, at: string }) => RestartRequest | null
  completeRestart: (at: string) => RestartRequest | null
  requireRestartAction: (input: { id: string, at: string, reason: string }) => RestartRequest | null
  prepareForRestart: (at: string) => boolean
  isSafeToRestart: (at?: string) => boolean
  pauseAgents: (at: string) => StoredAgentControl
  setRepositoryPaused: (github: string, paused: boolean) => boolean
  /** True when a person has trusted the controller to write to this repository. */
  mayWriteRepository: (github: string) => boolean
  /** Trusts, or stops trusting, the controller to write to one repository. */
  setRepositoryWritesEnabled: (github: string, writesEnabled: boolean) => boolean
  recordObservation: (input: {
    externalId: string
    observedAt: string
    source: 'poll' | 'webhook'
    subject: GitHubItem
  }) => RecordObservationResult
  recordPollAttempt: (github: string, at: string) => void
  recordPollFailure: (github: string, at: string, message: string, status?: number) => void
  recordPollSuccess: (github: string, at: string) => void
  /** Names one failure for the system pane. Repeats raise `occurrences`. */
  recordIncident: (input: RecordIncidentInput) => Incident
  /** Clears every open Incident for one scope once the work behind it succeeds. */
  resolveIncidents: (scope: IncidentScope, at: string, operation?: string, exceptMessages?: readonly string[]) => number
  listIncidents: () => Incident[]
  recordReviewRun: (input: RecordReviewRunInput) => RecordReviewRunResult
  /** Atomically stores a refreshed Review and its published GitHub projection. */
  supersedeReviewRun: (input: SupersedeReviewRunInput) => SupersedeReviewRunResult
  recordReviewPublication: (input: RecordReviewPublicationInput) => RecordReviewPublicationResult
  requestReviewRerun: (input: {
    repository: string
    pullRequestNumber: number
    revisionId: string
    requestId: string
    source: ReviewRerunSource
    requestedBy: string
    at: string
  }) => ReviewRerunResult
  resumeAgents: (at: string) => StoredAgentControl
  recoverInterruptedAgentTasks: (at: string) => number
  retryRecoverableWorkerFailures: (at: string) => number
  /**
   * Gives back the recovery budget a GitHub outage spent, for every repository
   * GitHub is currently answering. Returns how many Tasks were freed.
   */
  restoreOutageRecoveryBudget: (at: string) => number
  /** Closes Incidents whose Task can no longer run. Returns how many closed. */
  resolveStaleTaskIncidents: (at: string) => number
  saveWorkerSession: (repository: string, itemNumber: number, role: AgentRole, sessionId: string, at: string, scopeDigest?: string) => void
  updateAgentProgress: (input: { taskId: string, taskKind: AgentTask['kind'], workerId: string, fence: number, progress: AgentProgress, at: string }) => boolean
  stageReviewStatus: (input: StageReviewStatusInput) => { _tag: 'Staged' | 'Duplicate', commandId: string } | { _tag: 'Rejected', reason: string }
  stageReviewGateStatus: (input: StageReviewGateStatusInput) => { _tag: 'Staged' | 'Duplicate', commandId: string } | { _tag: 'Rejected', reason: string }
  stageIssueTriageComment: (input: {
    taskId: string
    workerId: string
    fence: number
    at: string
    revisionId: string
    body: string
  }) => { _tag: 'Staged' | 'Duplicate', commandId: string } | { _tag: 'Rejected', reason: string }
  stagePublication: (input: {
    taskId: string
    workerId: string
    fence: number
    at: string
    publication: PreparedPublication
    usage?: AgentTokenUsage
  }) => StagePublicationResult
  supersedeTask: (input: { taskId: string, workerId: string, fence: number, at: string, reason: string, usage?: AgentTokenUsage }) => boolean
  supersedePublication: (input: { commandId: string, workerId: string, fence: number, at: string, reason: string }) => boolean
  syncRepositories: (repositories: RepositoryMapping[], at: string) => void
}

interface RepositoryRow {
  github: string
  enabled: number
  writes_enabled: number
  ownership: RepositoryStatus['ownership']
  last_attempt_at: string | null
  last_success_at: string | null
  last_error: string | null
  subject_count: number
  paused: number
}

interface SubjectRow {
  repository: string
  github_number: number
  kind: 'issue' | 'pull_request'
  state: 'open' | 'closed'
  title: string
  author: string
  url: string
  github_created_at: string
  github_updated_at: string
  content_digest: string | null
  draft: number | null
  base_sha: string | null
  head_sha: string | null
  head_repository: string | null
  head_ref: string | null
  merge_state: 'clean' | 'conflicting' | 'unknown' | null
  merged_at: string | null
  purpose_tag?: 'Change' | 'BaselineRepair' | null
  purpose_base_sha_prefix?: string | null
  revision_id: string
  observed_at: string
}

interface DashboardSubjectRow extends SubjectRow {
  policy_json: string
  review_approved_at: string | null
  dismissed: number
}

interface TaskRow {
  id: string
  kind: AgentTask['kind']
  repository: string
  github_number: number
  revision_id: string
  state_tag: 'Queued' | 'ActionRequired' | 'Running' | 'Publishing' | 'Completed' | 'Failed' | 'Superseded'
  reason: string | null
  worker_id: string | null
  evidence: string | null
  command_id: string | null
  fence: number
  lease_expires_at: string | null
  updated_at: string
  recovery_attempts: number
  progress_percent: number
  progress_label: string
}

interface PublicationRow {
  id: string
  task_id: string
  task_kind: 'resolve_conflict' | 'review_fix' | 'baseline_repair' | 'issue_work'
  repository: string
  github_number: number
  commit_sha: string
  base_sha: string
  base_ref: string
  expected_head_sha: string
  head_ref: string
  artifact_ref: string
  patch_digest: string
  changed_files: number
  outcome_unknown: number
  pull_request_title: string | null
  pull_request_body: string | null
  head_repository: string
  worker_id: string | null
  fence: number
  lease_expires_at: string | null
  policy_json: string
}

interface ClaimRow extends TaskRow {
  policy_json: string
  subject_id: number
  subject_payload: string
}

interface ReviewRunRow {
  id: string
  repository: string
  github_number: number
  revision_id: string
  head_sha: string
  provider: 'codex' | 'opencode' | 'claude'
  session_id: string
  model: string
  agent_version: string
  skill_digest: string
  started_at: string
  completed_at: string
  usage: string
  gates: string
  outcome_tag: 'Ready' | 'Pending' | 'Blocked'
  confidence: number | null
  findings: string
  feedback_tag: AgentFeedback['_tag'] | null
  feedback_reason: string | null
  feedback_updated_at: string | null
}

interface DashboardReviewRunRow extends ReviewRunRow {
  title: string
  author: string
  subject_url: string
  head_repository: string
}

interface ActiveAgentRow extends TaskRow {
  subject_kind: 'issue' | 'pull_request'
  title: string
  author: string
  subject_url: string
  head_sha: string | null
  head_repository: string | null
  session_id: string | null
  started_at: string
}

interface ReviewPublicationRow {
  id: string
  review_run_id: string
  body: string
  body_sha256: string
  created_at: string
  result_tag: 'Published' | 'Failed'
  github_comment_id: number | null
  github_url: string | null
  reason: string | null
}

const initialMigration = `
  CREATE TABLE repositories (
    id INTEGER PRIMARY KEY,
    github TEXT NOT NULL UNIQUE,
    policy_json TEXT NOT NULL,
    policy_digest TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    ownership TEXT NOT NULL CHECK (ownership IN ('owned', 'maintained', 'external')),
    last_attempt_at TEXT,
    last_success_at TEXT,
    last_error TEXT
  );

  CREATE TABLE subjects (
    id INTEGER PRIMARY KEY,
    repository_id INTEGER NOT NULL REFERENCES repositories(id),
    github_number INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('issue', 'pull_request')),
    current_revision_id TEXT,
    UNIQUE (repository_id, github_number, kind)
  );

  CREATE TABLE revisions (
    id TEXT PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    observed_at TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('poll', 'webhook')),
    payload TEXT NOT NULL
  );

  CREATE TABLE observations (
    id INTEGER PRIMARY KEY,
    external_id TEXT NOT NULL UNIQUE,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    revision_id TEXT NOT NULL REFERENCES revisions(id),
    observed_at TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('poll', 'webhook'))
  );

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    revision_id TEXT NOT NULL REFERENCES revisions(id),
    kind TEXT NOT NULL CHECK (kind IN ('resolve_conflict')),
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Queued', 'NeedsAttention', 'Running', 'Completed', 'Failed', 'Superseded')),
    reason TEXT,
    worker_id TEXT,
    evidence TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_expires_at TEXT,
    updated_at TEXT NOT NULL,
    CHECK (
      (state_tag = 'Running' AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state_tag != 'Running' AND worker_id IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (state_tag != 'Completed' OR evidence IS NOT NULL),
    CHECK (state_tag NOT IN ('NeedsAttention', 'Failed', 'Superseded') OR reason IS NOT NULL)
  );

  CREATE TABLE task_transitions (
    id INTEGER PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    from_tag TEXT,
    to_tag TEXT NOT NULL,
    reason TEXT,
    fence INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE worker_sessions (
    id INTEGER PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    role TEXT NOT NULL CHECK (role IN ('conflict_resolution')),
    provider TEXT NOT NULL CHECK (provider IN ('codex')),
    session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (subject_id, role, provider)
  );

  CREATE INDEX subjects_repository_id ON subjects(repository_id);
  CREATE INDEX revisions_subject_id ON revisions(subject_id);
  CREATE INDEX tasks_state_tag ON tasks(state_tag);
  CREATE UNIQUE INDEX one_active_conflict_task
    ON tasks(subject_id, kind)
    WHERE state_tag IN ('Queued', 'NeedsAttention', 'Running');

  PRAGMA user_version = 1;
`

const reviewJournalMigration = `
  CREATE UNIQUE INDEX revision_subject ON revisions(id, subject_id);

  CREATE TABLE attempts (
    id TEXT PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    revision_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind = 'adversarial_review'),
    provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
    session_id TEXT NOT NULL,
    model TEXT NOT NULL,
    agent_version TEXT NOT NULL,
    skill_digest TEXT NOT NULL CHECK (length(skill_digest) = 64),
    head_sha TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    gates TEXT NOT NULL CHECK (json_valid(gates)),
    outcome_tag TEXT NOT NULL CHECK (outcome_tag IN ('Ready', 'Waiting', 'Blocked')),
    confidence INTEGER,
    findings TEXT NOT NULL CHECK (json_valid(findings)),
    content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
    FOREIGN KEY (revision_id, subject_id) REFERENCES revisions(id, subject_id),
    CHECK (completed_at >= started_at),
    CHECK (
      (outcome_tag = 'Ready' AND confidence BETWEEN 0 AND 100)
      OR (outcome_tag != 'Ready' AND confidence IS NULL)
    )
  );

  CREATE TABLE review_publications (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    body TEXT NOT NULL,
    body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
    created_at TEXT NOT NULL,
    result_tag TEXT NOT NULL CHECK (result_tag IN ('Published', 'Failed')),
    github_comment_id INTEGER,
    github_url TEXT,
    reason TEXT,
    content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
    CHECK (
      (result_tag = 'Published' AND github_comment_id IS NOT NULL AND github_url IS NOT NULL AND reason IS NULL)
      OR (result_tag = 'Failed' AND github_comment_id IS NULL AND github_url IS NULL AND reason IS NOT NULL)
    )
  );

  CREATE INDEX attempts_subject_completed ON attempts(subject_id, completed_at DESC);
  CREATE INDEX review_publications_attempt_created ON review_publications(attempt_id, created_at);

  PRAGMA user_version = 2;
`

const publicationJournalMigration = `
  DROP INDEX IF EXISTS publication_events_command_created;
  DROP TABLE IF EXISTS publication_events;
  DROP INDEX IF EXISTS publication_commands_state_tag;
  DROP TABLE IF EXISTS publication_commands;
  ALTER TABLE task_transitions RENAME TO task_transitions_v2;
  ALTER TABLE tasks RENAME TO tasks_v2;

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    revision_id TEXT NOT NULL REFERENCES revisions(id),
    kind TEXT NOT NULL CHECK (kind IN ('resolve_conflict')),
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Queued', 'NeedsAttention', 'Running', 'Publishing', 'Completed', 'Failed', 'Superseded')),
    reason TEXT,
    worker_id TEXT,
    evidence TEXT,
    command_id TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_expires_at TEXT,
    updated_at TEXT NOT NULL,
    CHECK (
      (state_tag = 'Running' AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL AND command_id IS NULL)
      OR (state_tag = 'Publishing' AND worker_id IS NULL AND lease_expires_at IS NULL AND command_id IS NOT NULL)
      OR (state_tag NOT IN ('Running', 'Publishing') AND worker_id IS NULL AND lease_expires_at IS NULL AND command_id IS NULL)
    ),
    CHECK (state_tag != 'Completed' OR evidence IS NOT NULL),
    CHECK (state_tag NOT IN ('NeedsAttention', 'Failed', 'Superseded') OR reason IS NOT NULL)
  );

  INSERT INTO tasks (
    id, subject_id, revision_id, kind, state_tag, reason, worker_id, evidence,
    fence, attempts, max_attempts, lease_expires_at, updated_at
  )
  SELECT
    id, subject_id, revision_id, kind, state_tag, reason, worker_id, evidence,
    fence, attempts, max_attempts, lease_expires_at, updated_at
  FROM tasks_v2;

  CREATE TABLE task_transitions (
    id INTEGER PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    from_tag TEXT,
    to_tag TEXT NOT NULL,
    reason TEXT,
    fence INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  INSERT INTO task_transitions SELECT * FROM task_transitions_v2;
  DROP TABLE task_transitions_v2;
  DROP TABLE tasks_v2;

  CREATE TABLE publication_commands (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Pending', 'Running', 'Published', 'Failed', 'Superseded')),
    commit_sha TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    expected_head_sha TEXT NOT NULL,
    head_ref TEXT NOT NULL,
    artifact_ref TEXT NOT NULL,
    patch_digest TEXT NOT NULL,
    changed_files INTEGER NOT NULL CHECK (changed_files > 0),
    outcome_unknown INTEGER NOT NULL DEFAULT 0 CHECK (outcome_unknown IN (0, 1)),
    reason TEXT,
    worker_id TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_expires_at TEXT,
    published_at TEXT,
    updated_at TEXT NOT NULL,
    CHECK (
      (state_tag = 'Running' AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state_tag != 'Running' AND worker_id IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (state_tag NOT IN ('Failed', 'Superseded') OR reason IS NOT NULL),
    CHECK (state_tag != 'Published' OR published_at IS NOT NULL)
  );

  CREATE TABLE publication_events (
    id INTEGER PRIMARY KEY,
    command_id TEXT NOT NULL REFERENCES publication_commands(id),
    from_tag TEXT,
    to_tag TEXT NOT NULL,
    reason TEXT,
    fence INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX tasks_state_tag ON tasks(state_tag);
  CREATE INDEX publication_commands_state_tag ON publication_commands(state_tag);
  CREATE INDEX publication_events_command_created ON publication_events(command_id, created_at);
  CREATE UNIQUE INDEX one_active_conflict_task
    ON tasks(subject_id, kind)
    WHERE state_tag IN ('Queued', 'NeedsAttention', 'Running', 'Publishing');

  PRAGMA user_version = 4;
`

const pullRequestApprovalMigration = `
  CREATE TABLE pull_request_approvals (
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    revision_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('review', 'fixes')),
    approved_at TEXT NOT NULL,
    PRIMARY KEY (subject_id, revision_id, kind),
    FOREIGN KEY (revision_id, subject_id) REFERENCES revisions(id, subject_id)
  );

  CREATE INDEX pull_request_approvals_revision ON pull_request_approvals(revision_id);

  UPDATE revisions
  SET payload = json_set(payload, '$.createdAt', json_extract(payload, '$.updatedAt'))
  WHERE json_extract(payload, '$.createdAt') IS NULL;

  PRAGMA user_version = 5;
`

const workerTaskMigration = `
  CREATE TABLE worker_tasks (
    id TEXT PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    revision_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('adversarial_review', 'issue_triage')),
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Queued', 'NeedsAttention', 'Running', 'Completed', 'Failed', 'Superseded')),
    reason TEXT,
    worker_id TEXT,
    evidence TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_expires_at TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (revision_id, subject_id) REFERENCES revisions(id, subject_id),
    CHECK (
      (state_tag = 'Running' AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state_tag != 'Running' AND worker_id IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (state_tag != 'Completed' OR evidence IS NOT NULL),
    CHECK (state_tag NOT IN ('NeedsAttention', 'Failed', 'Superseded') OR reason IS NOT NULL)
  );

  CREATE TABLE worker_task_transitions (
    id INTEGER PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES worker_tasks(id),
    from_tag TEXT,
    to_tag TEXT NOT NULL,
    reason TEXT,
    fence INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE subject_worker_sessions (
    id INTEGER PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    role TEXT NOT NULL CHECK (role IN ('adversarial_review', 'issue_triage')),
    provider TEXT NOT NULL CHECK (provider = 'codex'),
    session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (subject_id, role, provider)
  );

  CREATE INDEX worker_tasks_state_tag ON worker_tasks(state_tag);
  CREATE UNIQUE INDEX one_active_worker_task
    ON worker_tasks(subject_id, kind)
    WHERE state_tag IN ('Queued', 'NeedsAttention', 'Running');

  PRAGMA user_version = 6;
`

const reviewStatusMigration = `
  ALTER TABLE subject_worker_sessions RENAME TO subject_worker_sessions_v6;

  CREATE TABLE subject_worker_sessions (
    id INTEGER PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    role TEXT NOT NULL CHECK (role IN ('adversarial_review', 'issue_triage')),
    provider TEXT NOT NULL CHECK (provider = 'codex'),
    scope_digest TEXT NOT NULL CHECK (length(scope_digest) = 64),
    session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (subject_id, role, provider, scope_digest)
  );

  INSERT INTO subject_worker_sessions (
    id, subject_id, role, provider, scope_digest, session_id, updated_at
  )
  SELECT id, subject_id, role, provider,
    '0000000000000000000000000000000000000000000000000000000000000000',
    session_id, updated_at
  FROM subject_worker_sessions_v6;
  DROP TABLE subject_worker_sessions_v6;

  CREATE TABLE review_status_commands (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES worker_tasks(id),
    task_fence INTEGER NOT NULL,
    revision_id TEXT NOT NULL,
    expected_head_sha TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('snapshot', 'review', 'terminal')),
    body TEXT NOT NULL,
    body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Pending', 'Running', 'Published', 'Superseded')),
    outcome_unknown INTEGER NOT NULL DEFAULT 0 CHECK (outcome_unknown IN (0, 1)),
    reason TEXT,
    github_comment_id INTEGER,
    github_url TEXT,
    worker_id TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (revision_id) REFERENCES revisions(id),
    UNIQUE (task_id, task_fence, phase, body_sha256),
    CHECK (
      (state_tag = 'Running' AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state_tag != 'Running' AND worker_id IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (
      (state_tag = 'Published' AND github_comment_id IS NOT NULL AND github_url IS NOT NULL)
      OR state_tag != 'Published'
    )
  );

  CREATE INDEX review_status_commands_state ON review_status_commands(state_tag, updated_at);
  PRAGMA user_version = 7;
`

const agentProgressMigration = `
  ALTER TABLE tasks ADD COLUMN progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100);
  ALTER TABLE tasks ADD COLUMN progress_label TEXT NOT NULL DEFAULT 'Starting';
  ALTER TABLE worker_tasks ADD COLUMN progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100);
  ALTER TABLE worker_tasks ADD COLUMN progress_label TEXT NOT NULL DEFAULT 'Starting';
  PRAGMA user_version = 8;
`

const automatedReviewMigration = `
  UPDATE revisions
  SET payload = json_set(payload, '$.priorAutomatedReview', json('{"_tag":"None"}'))
  WHERE json_extract(payload, '$.kind') = 'pull_request'
    AND json_type(payload, '$.priorAutomatedReview') IS NULL;
  PRAGMA user_version = 9;
`

const contentEquivalentPublicationMigration = `
  CREATE TABLE publication_commands_v10 (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id),
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Pending', 'Running', 'Published', 'Failed', 'Superseded')),
    commit_sha TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    expected_head_sha TEXT NOT NULL,
    head_ref TEXT NOT NULL,
    artifact_ref TEXT NOT NULL,
    patch_digest TEXT NOT NULL,
    changed_files INTEGER NOT NULL CHECK (changed_files >= 0),
    outcome_unknown INTEGER NOT NULL DEFAULT 0 CHECK (outcome_unknown IN (0, 1)),
    reason TEXT,
    worker_id TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_expires_at TEXT,
    published_at TEXT,
    updated_at TEXT NOT NULL,
    CHECK (
      (state_tag = 'Running' AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state_tag != 'Running' AND worker_id IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (state_tag NOT IN ('Failed', 'Superseded') OR reason IS NOT NULL),
    CHECK (state_tag != 'Published' OR published_at IS NOT NULL)
  );

  INSERT INTO publication_commands_v10 SELECT * FROM publication_commands;
  DROP TABLE publication_commands;
  ALTER TABLE publication_commands_v10 RENAME TO publication_commands;
  CREATE INDEX publication_commands_state_tag ON publication_commands(state_tag);
  PRAGMA user_version = 10;
`

const taskCancellationMigration = `
  CREATE TABLE task_cancellations (
    task_id TEXT PRIMARY KEY,
    cancelled_at TEXT NOT NULL,
    reason TEXT NOT NULL
  );
  PRAGMA user_version = 11;
`

const reviewRerunMigration = `
  CREATE TABLE review_rerun_requests (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES worker_tasks(id),
    source TEXT NOT NULL CHECK (source IN ('dashboard', 'github_comment', 'repair_dispute')),
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL
  );
  CREATE INDEX review_rerun_requests_task ON review_rerun_requests(task_id, requested_at);
  PRAGMA user_version = 12;
`

const reviewFixMigration = `
  CREATE TABLE tasks_v13 (
    id TEXT PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    revision_id TEXT NOT NULL REFERENCES revisions(id),
    kind TEXT NOT NULL CHECK (kind IN ('resolve_conflict', 'review_fix')),
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Queued', 'NeedsAttention', 'Running', 'Publishing', 'Completed', 'Failed', 'Superseded')),
    reason TEXT,
    worker_id TEXT,
    evidence TEXT,
    command_id TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_expires_at TEXT,
    updated_at TEXT NOT NULL,
    progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
    progress_label TEXT NOT NULL DEFAULT 'Starting',
    CHECK (
      (state_tag = 'Running' AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL AND command_id IS NULL)
      OR (state_tag = 'Publishing' AND worker_id IS NULL AND lease_expires_at IS NULL AND command_id IS NOT NULL)
      OR (state_tag NOT IN ('Running', 'Publishing') AND worker_id IS NULL AND lease_expires_at IS NULL AND command_id IS NULL)
    ),
    CHECK (state_tag != 'Completed' OR evidence IS NOT NULL),
    CHECK (state_tag NOT IN ('NeedsAttention', 'Failed', 'Superseded') OR reason IS NOT NULL)
  );

  INSERT INTO tasks_v13 SELECT * FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_v13 RENAME TO tasks;

  CREATE TABLE worker_sessions_v13 (
    id INTEGER PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    role TEXT NOT NULL CHECK (role IN ('conflict_resolution', 'review_fix')),
    provider TEXT NOT NULL CHECK (provider IN ('codex')),
    session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (subject_id, role, provider)
  );

  INSERT INTO worker_sessions_v13 SELECT * FROM worker_sessions;
  DROP TABLE worker_sessions;
  ALTER TABLE worker_sessions_v13 RENAME TO worker_sessions;

  CREATE INDEX tasks_state_tag ON tasks(state_tag);
  CREATE UNIQUE INDEX one_active_mutation_task
    ON tasks(subject_id, kind)
    WHERE state_tag IN ('Queued', 'NeedsAttention', 'Running', 'Publishing');

  PRAGMA user_version = 13;
`

const issueWorkMigration = `
  DROP INDEX IF EXISTS tasks_state_tag;
  DROP INDEX IF EXISTS one_active_mutation_task;

  CREATE TABLE tasks_v14 (
    id TEXT PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    revision_id TEXT NOT NULL REFERENCES revisions(id),
    kind TEXT NOT NULL CHECK (kind IN ('resolve_conflict', 'review_fix', 'issue_work')),
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Queued', 'NeedsAttention', 'Running', 'Publishing', 'Completed', 'Failed', 'Superseded')),
    reason TEXT,
    worker_id TEXT,
    evidence TEXT,
    command_id TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_expires_at TEXT,
    updated_at TEXT NOT NULL,
    progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
    progress_label TEXT NOT NULL DEFAULT 'Starting',
    CHECK (
      (state_tag = 'Running' AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL AND command_id IS NULL)
      OR (state_tag = 'Publishing' AND worker_id IS NULL AND lease_expires_at IS NULL AND command_id IS NOT NULL)
      OR (state_tag NOT IN ('Running', 'Publishing') AND worker_id IS NULL AND lease_expires_at IS NULL AND command_id IS NULL)
    ),
    CHECK (state_tag != 'Completed' OR evidence IS NOT NULL),
    CHECK (state_tag NOT IN ('NeedsAttention', 'Failed', 'Superseded') OR reason IS NOT NULL)
  );

  INSERT INTO tasks_v14 SELECT * FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_v14 RENAME TO tasks;

  ALTER TABLE publication_commands ADD COLUMN pull_request_title TEXT;
  ALTER TABLE publication_commands ADD COLUMN pull_request_body TEXT;

  CREATE INDEX tasks_state_tag ON tasks(state_tag);
  CREATE UNIQUE INDEX one_active_mutation_task
    ON tasks(subject_id, kind)
    WHERE state_tag IN ('Queued', 'NeedsAttention', 'Running', 'Publishing');

  PRAGMA user_version = 14;
`

const issueTriageCommentMigration = `
  CREATE TABLE issue_triage_comment_commands (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES worker_tasks(id),
    task_fence INTEGER NOT NULL,
    revision_id TEXT NOT NULL REFERENCES revisions(id),
    expected_updated_at TEXT NOT NULL,
    body TEXT NOT NULL,
    body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Pending', 'Running', 'Published', 'Superseded')),
    outcome_unknown INTEGER NOT NULL DEFAULT 0 CHECK (outcome_unknown IN (0, 1)),
    reason TEXT,
    github_comment_id INTEGER,
    github_url TEXT,
    worker_id TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (task_id, task_fence, body_sha256),
    CHECK (
      (state_tag = 'Running' AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state_tag != 'Running' AND worker_id IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (
      (state_tag = 'Published' AND github_comment_id IS NOT NULL AND github_url IS NOT NULL)
      OR state_tag != 'Published'
    )
  );

  CREATE INDEX issue_triage_comment_commands_state
    ON issue_triage_comment_commands(state_tag, updated_at);
  PRAGMA user_version = 15;
`

const agentControlMigration = `
  CREATE TABLE agent_control (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Running', 'Paused')),
    updated_at TEXT NOT NULL
  );
  INSERT INTO agent_control (singleton, state_tag, updated_at)
  VALUES (1, 'Running', '1970-01-01T00:00:00.000Z');
  PRAGMA user_version = 16;
`

const selectionModeMigration = `
  ALTER TABLE agent_control ADD COLUMN selection_mode TEXT NOT NULL DEFAULT 'auto'
    CHECK (selection_mode IN ('auto', 'manual'));
  PRAGMA user_version = 28;
`

/**
 * One durable decision to never act on an Item.
 *
 * Keyed by subject, not by revision, so a new head commit does not undo it.
 * The cascade clears the row if the Item itself is ever removed.
 */
const itemDismissalMigration = `
  CREATE TABLE item_dismissals (
    subject_id INTEGER PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
    dismissed_at TEXT NOT NULL
  );
  PRAGMA user_version = 29;
`

/**
 * Quarantines a repository the controller has never been trusted to write to.
 *
 * Discovery decides what the controller can see. Nothing decided what it could
 * write to, so widening `allowed_owners` by one organization put four new
 * repositories in reach and ninety eight automated comments went out under
 * Harlan's own account before anyone saw a dashboard.
 *
 * Repositories already enabled when this ran keep their writes, because they
 * were already acting. Every repository discovered afterwards has to be turned
 * on once, by a person.
 */
const repositoryWriteQuarantineMigration = `
  ALTER TABLE repositories ADD COLUMN writes_enabled INTEGER NOT NULL DEFAULT 0 CHECK (writes_enabled IN (0, 1));
  UPDATE repositories SET writes_enabled = 1 WHERE enabled = 1;
  PRAGMA user_version = 30;
`

const repositoryPauseMigration = `
  ALTER TABLE repositories ADD COLUMN paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1));
  PRAGMA user_version = 17;
`

/**
 * One durable Agent selection, so a switch survives a restart.
 *
 * No row means the service follows the Agent provider its configuration names.
 */
const agentSelectionMigration = `
  CREATE TABLE agent_selection (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    provider TEXT NOT NULL CHECK (provider IN ('codex', 'opencode')),
    model TEXT,
    reasoning_effort TEXT,
    updated_at TEXT NOT NULL
  );
  PRAGMA user_version = 25;
`

const reviewFixStatusMigration = `
  CREATE TABLE review_status_commands_v18 (
    id TEXT PRIMARY KEY,
    task_kind TEXT NOT NULL CHECK (task_kind IN ('adversarial_review', 'review_fix')),
    task_id TEXT NOT NULL,
    task_fence INTEGER NOT NULL,
    revision_id TEXT NOT NULL REFERENCES revisions(id),
    expected_head_sha TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('snapshot', 'review', 'repair', 'terminal')),
    body TEXT NOT NULL,
    body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Pending', 'Running', 'Published', 'Superseded')),
    outcome_unknown INTEGER NOT NULL DEFAULT 0 CHECK (outcome_unknown IN (0, 1)),
    reason TEXT,
    github_comment_id INTEGER,
    github_url TEXT,
    worker_id TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (task_kind, task_id, task_fence, phase, body_sha256),
    CHECK (
      (task_kind = 'adversarial_review' AND phase IN ('snapshot', 'review', 'terminal'))
      OR (task_kind = 'review_fix' AND phase = 'repair')
    ),
    CHECK (
      (state_tag = 'Running' AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state_tag != 'Running' AND worker_id IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (
      (state_tag = 'Published' AND github_comment_id IS NOT NULL AND github_url IS NOT NULL)
      OR state_tag != 'Published'
    )
  );

  INSERT INTO review_status_commands_v18 (
    id, task_kind, task_id, task_fence, revision_id, expected_head_sha, phase,
    body, body_sha256, state_tag, outcome_unknown, reason, github_comment_id,
    github_url, worker_id, fence, lease_expires_at, created_at, updated_at
  )
  SELECT
    id, 'adversarial_review', task_id, task_fence, revision_id, expected_head_sha,
    phase, body, body_sha256, state_tag, outcome_unknown, reason,
    github_comment_id, github_url, worker_id, fence, lease_expires_at,
    created_at, updated_at
  FROM review_status_commands;

  DROP TABLE review_status_commands;
  ALTER TABLE review_status_commands_v18 RENAME TO review_status_commands;
  CREATE INDEX review_status_commands_state ON review_status_commands(state_tag, updated_at);
  PRAGMA user_version = 18;
`

const baselineRepairMigration = `
  DROP INDEX IF EXISTS tasks_state_tag;
  DROP INDEX IF EXISTS one_active_mutation_task;

  CREATE TABLE tasks_v19 (
    id TEXT PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    revision_id TEXT NOT NULL REFERENCES revisions(id),
    kind TEXT NOT NULL CHECK (kind IN ('resolve_conflict', 'review_fix', 'baseline_repair', 'issue_work')),
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Queued', 'NeedsAttention', 'Running', 'Publishing', 'Completed', 'Failed', 'Superseded')),
    reason TEXT,
    worker_id TEXT,
    evidence TEXT,
    command_id TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_expires_at TEXT,
    updated_at TEXT NOT NULL,
    progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
    progress_label TEXT NOT NULL DEFAULT 'Starting',
    CHECK (
      (state_tag = 'Running' AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL AND command_id IS NULL)
      OR (state_tag = 'Publishing' AND worker_id IS NULL AND lease_expires_at IS NULL AND command_id IS NOT NULL)
      OR (state_tag NOT IN ('Running', 'Publishing') AND worker_id IS NULL AND lease_expires_at IS NULL AND command_id IS NULL)
    ),
    CHECK (state_tag != 'Completed' OR evidence IS NOT NULL),
    CHECK (state_tag NOT IN ('NeedsAttention', 'Failed', 'Superseded') OR reason IS NOT NULL)
  );

  INSERT INTO tasks_v19 SELECT * FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_v19 RENAME TO tasks;

  CREATE TABLE worker_sessions_v19 (
    id INTEGER PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    role TEXT NOT NULL CHECK (role IN ('conflict_resolution', 'review_fix', 'baseline_repair')),
    provider TEXT NOT NULL CHECK (provider IN ('codex')),
    session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (subject_id, role, provider)
  );

  INSERT INTO worker_sessions_v19 SELECT * FROM worker_sessions;
  DROP TABLE worker_sessions;
  ALTER TABLE worker_sessions_v19 RENAME TO worker_sessions;

  INSERT OR IGNORE INTO review_rerun_requests (id, task_id, source, requested_by, requested_at)
  SELECT tasks.id || ':combined-review', worker_tasks.id, 'dashboard', 'controller-migration', tasks.updated_at
  FROM tasks
  JOIN worker_tasks ON worker_tasks.subject_id = tasks.subject_id
    AND worker_tasks.revision_id = tasks.revision_id
    AND worker_tasks.kind = 'adversarial_review'
  WHERE tasks.kind = 'review_fix'
    AND tasks.state_tag IN ('Queued', 'NeedsAttention', 'Running', 'Failed')
    AND NOT EXISTS (SELECT 1 FROM task_cancellations WHERE task_id = tasks.id)
    AND NOT EXISTS (SELECT 1 FROM task_cancellations WHERE task_id = worker_tasks.id);

  INSERT INTO worker_task_transitions (task_id, from_tag, to_tag, reason, fence, created_at)
  SELECT DISTINCT worker_tasks.id, worker_tasks.state_tag, 'Queued',
    'Review and repair now run in one agent turn.', worker_tasks.fence, tasks.updated_at
  FROM tasks
  JOIN worker_tasks ON worker_tasks.subject_id = tasks.subject_id
    AND worker_tasks.revision_id = tasks.revision_id
    AND worker_tasks.kind = 'adversarial_review'
  WHERE tasks.kind = 'review_fix'
    AND tasks.state_tag IN ('Queued', 'NeedsAttention', 'Running', 'Failed')
    AND worker_tasks.state_tag != 'Queued'
    AND NOT EXISTS (SELECT 1 FROM task_cancellations WHERE task_id = tasks.id)
    AND NOT EXISTS (SELECT 1 FROM task_cancellations WHERE task_id = worker_tasks.id);

  UPDATE worker_tasks
  SET state_tag = 'Queued', reason = NULL, worker_id = NULL, evidence = NULL,
    lease_expires_at = NULL, attempts = 0, updated_at = (
      SELECT MAX(tasks.updated_at) FROM tasks
      WHERE tasks.subject_id = worker_tasks.subject_id
        AND tasks.revision_id = worker_tasks.revision_id
        AND tasks.kind = 'review_fix'
    )
  WHERE kind = 'adversarial_review'
    AND EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.subject_id = worker_tasks.subject_id
        AND tasks.revision_id = worker_tasks.revision_id
        AND tasks.kind = 'review_fix'
        AND tasks.state_tag IN ('Queued', 'NeedsAttention', 'Running', 'Failed')
        AND NOT EXISTS (SELECT 1 FROM task_cancellations WHERE task_id = tasks.id)
    )
    AND NOT EXISTS (SELECT 1 FROM task_cancellations WHERE task_id = worker_tasks.id);

  UPDATE review_status_commands
  SET state_tag = 'Superseded', reason = 'Review and repair now run in one agent turn.',
    worker_id = NULL, lease_expires_at = NULL, updated_at = (
      SELECT tasks.updated_at FROM tasks WHERE tasks.id = review_status_commands.task_id
    )
  WHERE task_kind = 'review_fix'
    AND state_tag IN ('Pending', 'Running')
    AND EXISTS (
      SELECT 1 FROM tasks
      WHERE tasks.id = review_status_commands.task_id
        AND tasks.state_tag IN ('Queued', 'NeedsAttention', 'Running', 'Failed')
    );

  INSERT INTO task_transitions (task_id, from_tag, to_tag, reason, fence, created_at)
  SELECT id, state_tag, 'Superseded', 'Review and repair now run in one agent turn.', fence, updated_at
  FROM tasks
  WHERE kind = 'review_fix' AND state_tag IN ('Queued', 'NeedsAttention', 'Running', 'Failed');

  UPDATE tasks
  SET state_tag = 'Superseded', reason = 'Review and repair now run in one agent turn.',
    worker_id = NULL, command_id = NULL, lease_expires_at = NULL
  WHERE kind = 'review_fix' AND state_tag IN ('Queued', 'NeedsAttention', 'Running', 'Failed');

  CREATE INDEX tasks_state_tag ON tasks(state_tag);
  CREATE UNIQUE INDEX one_active_mutation_task
    ON tasks(subject_id, kind)
    WHERE state_tag IN ('Queued', 'NeedsAttention', 'Running', 'Publishing');

  PRAGMA user_version = 19;
`

const repeatablePublicationMigration = `
  DROP INDEX IF EXISTS publication_commands_state_tag;

  CREATE TABLE publication_commands_v20 (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Pending', 'Running', 'Published', 'Failed', 'Superseded')),
    commit_sha TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    expected_head_sha TEXT NOT NULL,
    head_ref TEXT NOT NULL,
    artifact_ref TEXT NOT NULL,
    patch_digest TEXT NOT NULL,
    changed_files INTEGER NOT NULL CHECK (changed_files >= 0),
    outcome_unknown INTEGER NOT NULL DEFAULT 0 CHECK (outcome_unknown IN (0, 1)),
    reason TEXT,
    worker_id TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_expires_at TEXT,
    published_at TEXT,
    updated_at TEXT NOT NULL,
    pull_request_title TEXT,
    pull_request_body TEXT,
    CHECK (
      (state_tag = 'Running' AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state_tag != 'Running' AND worker_id IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (state_tag NOT IN ('Failed', 'Superseded') OR reason IS NOT NULL),
    CHECK (state_tag != 'Published' OR published_at IS NOT NULL)
  );

  INSERT INTO publication_commands_v20 SELECT * FROM publication_commands;
  DROP TABLE publication_commands;
  ALTER TABLE publication_commands_v20 RENAME TO publication_commands;
  CREATE INDEX publication_commands_state_tag ON publication_commands(state_tag);
  CREATE UNIQUE INDEX one_live_publication_command_per_task
    ON publication_commands(task_id)
    WHERE state_tag IN ('Pending', 'Running', 'Published');
  PRAGMA user_version = 20;
`

const agentProviderMigration = `
  CREATE TABLE worker_sessions_v21 (
    id INTEGER PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    role TEXT NOT NULL CHECK (role IN ('conflict_resolution', 'review_fix', 'baseline_repair')),
    provider TEXT NOT NULL CHECK (provider IN ('codex', 'opencode')),
    session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (subject_id, role, provider)
  );

  INSERT INTO worker_sessions_v21 SELECT * FROM worker_sessions;
  DROP TABLE worker_sessions;
  ALTER TABLE worker_sessions_v21 RENAME TO worker_sessions;

  CREATE TABLE subject_worker_sessions_v21 (
    id INTEGER PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    role TEXT NOT NULL CHECK (role IN ('adversarial_review', 'issue_triage')),
    provider TEXT NOT NULL CHECK (provider IN ('codex', 'opencode')),
    scope_digest TEXT NOT NULL CHECK (length(scope_digest) = 64),
    session_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (subject_id, role, provider, scope_digest)
  );

  INSERT INTO subject_worker_sessions_v21 SELECT * FROM subject_worker_sessions;
  DROP TABLE subject_worker_sessions;
  ALTER TABLE subject_worker_sessions_v21 RENAME TO subject_worker_sessions;

  DROP INDEX IF EXISTS attempts_subject_completed;

  CREATE TABLE attempts_v21 (
    id TEXT PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    revision_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind = 'adversarial_review'),
    provider TEXT NOT NULL CHECK (provider IN ('codex', 'opencode', 'claude')),
    session_id TEXT NOT NULL,
    model TEXT NOT NULL,
    agent_version TEXT NOT NULL,
    skill_digest TEXT NOT NULL CHECK (length(skill_digest) = 64),
    head_sha TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    gates TEXT NOT NULL CHECK (json_valid(gates)),
    outcome_tag TEXT NOT NULL CHECK (outcome_tag IN ('Ready', 'Waiting', 'Blocked')),
    confidence INTEGER,
    findings TEXT NOT NULL CHECK (json_valid(findings)),
    content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
    FOREIGN KEY (revision_id, subject_id) REFERENCES revisions(id, subject_id),
    CHECK (completed_at >= started_at),
    CHECK (
      (outcome_tag = 'Ready' AND confidence BETWEEN 0 AND 100)
      OR (outcome_tag != 'Ready' AND confidence IS NULL)
    )
  );

  INSERT INTO attempts_v21 SELECT * FROM attempts;
  DROP TABLE attempts;
  ALTER TABLE attempts_v21 RENAME TO attempts;
  CREATE INDEX attempts_subject_completed ON attempts(subject_id, completed_at DESC);

  PRAGMA user_version = 21;
`

/**
 * Adds the Incident log and Task recovery budget.
 *
 * `recovery_attempts` counts how often the controller has requeued a Task that
 * already reached Failed. `attempts` cannot carry that count because recovery
 * resets it, so without a separate column a repository GitHub keeps rejecting
 * would requeue its Task forever.
 *
 * The Ready-needs-confidence CHECK is dropped in the same step. A review whose
 * every gate passed is a complete result, and refusing to store it because the
 * agent left one optional integer out threw the whole turn away.
 */
const incidentMigration = `
  CREATE TABLE incidents (
    id TEXT PRIMARY KEY,
    scope_tag TEXT NOT NULL CHECK (scope_tag IN ('Service', 'Repository', 'Task')),
    repository TEXT,
    task_id TEXT,
    subject_number INTEGER,
    kind TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('warning', 'error')),
    operation TEXT NOT NULL,
    message TEXT NOT NULL,
    recovery TEXT NOT NULL CHECK (json_valid(recovery)),
    occurrences INTEGER NOT NULL DEFAULT 1,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    resolved_at TEXT,
    CHECK (scope_tag != 'Repository' OR repository IS NOT NULL),
    CHECK (scope_tag != 'Task' OR (task_id IS NOT NULL AND repository IS NOT NULL))
  );

  CREATE INDEX incidents_open ON incidents(resolved_at, last_seen_at DESC);
  CREATE INDEX incidents_scope ON incidents(scope_tag, repository, task_id);

  ALTER TABLE worker_tasks ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0;

  DROP INDEX IF EXISTS attempts_subject_completed;

  CREATE TABLE attempts_v22 (
    id TEXT PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    revision_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind = 'adversarial_review'),
    provider TEXT NOT NULL CHECK (provider IN ('codex', 'opencode', 'claude')),
    session_id TEXT NOT NULL,
    model TEXT NOT NULL,
    agent_version TEXT NOT NULL,
    skill_digest TEXT NOT NULL CHECK (length(skill_digest) = 64),
    head_sha TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    gates TEXT NOT NULL CHECK (json_valid(gates)),
    outcome_tag TEXT NOT NULL CHECK (outcome_tag IN ('Ready', 'Waiting', 'Blocked')),
    confidence INTEGER,
    findings TEXT NOT NULL CHECK (json_valid(findings)),
    content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
    FOREIGN KEY (revision_id, subject_id) REFERENCES revisions(id, subject_id),
    CHECK (completed_at >= started_at),
    CHECK (confidence IS NULL OR (outcome_tag = 'Ready' AND confidence BETWEEN 0 AND 100))
  );

  INSERT INTO attempts_v22 SELECT * FROM attempts;
  DROP TABLE attempts;
  ALTER TABLE attempts_v22 RENAME TO attempts;
  CREATE INDEX attempts_subject_completed ON attempts(subject_id, completed_at DESC);

  PRAGMA user_version = 22;
`

/**
 * Adopts GitHub's words for two stored states.
 *
 * `Waiting` becomes `Pending`, which is what GitHub calls a check that has not
 * concluded and a review that has not been submitted. `NeedsAttention` becomes
 * `ActionRequired`, which is GitHub's own check conclusion for work that cannot
 * continue without a person.
 *
 * Stored gate evidence carries the tag inside its JSON, so the text is rewritten
 * with it. A rewritten row's `content_digest` no longer matches a recomputation
 * of its gates, which only affects duplicate detection for an identical Review
 * run ID, and every Review run ID is unique.
 */
/**
 * Rebuilds one table with a stored word replaced everywhere it appears.
 *
 * The replacement has to reach the CHECK constraint as well as the rows, and
 * SQLite cannot alter a constraint in place. Copying the live `sqlite_master`
 * definition and editing that keeps every other constraint exactly as it was,
 * which hand-writing the new definition does not.
 */
function renameStoredValue(
  database: DatabaseSync,
  table: string,
  columns: string[],
  from: string,
  to: string,
): void {
  const definition = database.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table) as { sql: string } | undefined
  if (definition === undefined)
    throw new Error(`Cannot rebuild missing table: ${table}.`)
  const indexes = (database.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`,
  ).all(table) as unknown as Array<{ sql: string }>).map(row => row.sql)

  const temporary = `${table}_rename`
  const rebuilt = definition.sql
    .replace(new RegExp(`CREATE TABLE\\s+"?${table}"?`), `CREATE TABLE ${temporary}`)
    .replaceAll(`'${from}'`, `'${to}'`)
  database.exec(rebuilt)

  // The new CHECK already rejects the old word, so the copy has to translate as
  // it goes. Copying first and updating afterwards fails on the very first row.
  const renamed = new Set(columns)
  const names = (database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>)
    .map(column => column.name)
  const selected = names
    .map(name => renamed.has(name) ? `CASE ${name} WHEN '${from}' THEN '${to}' ELSE ${name} END` : name)
    .join(', ')
  database.exec(`INSERT INTO ${temporary} (${names.join(', ')}) SELECT ${selected} FROM ${table}`)
  database.exec(`DROP TABLE ${table}`)
  database.exec(`ALTER TABLE ${temporary} RENAME TO ${table}`)
  indexes.forEach(sql => database.exec(sql))
}

/**
 * Adopts GitHub's words for two stored states.
 *
 * `Waiting` becomes `Pending`, which is what GitHub calls a check that has not
 * concluded and a review that has not been submitted. `NeedsAttention` becomes
 * `ActionRequired`, GitHub's own check conclusion for work that cannot continue
 * without a person.
 *
 * Stored gate evidence carries the tag inside its JSON, so that text is
 * rewritten too. A rewritten row's `content_digest` no longer matches a
 * recomputation of its gates, which only affects duplicate detection for one
 * identical Review run ID, and every Review run ID is unique.
 */
function applyGitHubStateVocabularyMigration(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = OFF')
  database.exec('BEGIN IMMEDIATE')
  try {
    renameStoredValue(database, 'attempts', ['outcome_tag'], 'Waiting', 'Pending')
    database.exec(`UPDATE attempts SET gates = replace(gates, '"_tag":"Waiting"', '"_tag":"Pending"')`)
    // These literals name what version 22 stored. A rename sweep must never
    // rewrite them, or the migration quietly becomes a no-op.
    const storedBefore = 'NeedsAttention'
    renameStoredValue(database, 'tasks', ['state_tag'], storedBefore, 'ActionRequired')
    renameStoredValue(database, 'worker_tasks', ['state_tag'], storedBefore, 'ActionRequired')
    for (const table of ['task_transitions', 'worker_task_transitions']) {
      for (const column of ['from_tag', 'to_tag'])
        database.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run('ActionRequired', storedBefore)
    }
    database.exec('PRAGMA user_version = 23')
    database.exec('COMMIT')
  }
  catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
  finally {
    database.exec('PRAGMA foreign_keys = ON')
  }
}

/**
 * Renames the review Attempt table to Review run.
 *
 * `attempts` named two different things: this table, and the retry counter
 * column on every Task. One word on two axes made `attempts.attempts` a
 * readable expression and a nonsense one. Review run is also GitHub's shape,
 * after `check run`.
 */
const reviewRunMigration = `
  ALTER TABLE attempts RENAME TO review_runs;
  ALTER TABLE review_publications RENAME COLUMN attempt_id TO review_run_id;
  DROP INDEX IF EXISTS attempts_subject_completed;
  DROP INDEX IF EXISTS review_publications_attempt_created;
  CREATE INDEX review_runs_subject_completed ON review_runs(subject_id, completed_at DESC);
  CREATE INDEX review_publications_run_created ON review_publications(review_run_id, created_at);

  PRAGMA user_version = 24;
`

/**
 * Records the base branch on every Publication.
 *
 * A new pull request used to be opened against the repository default branch,
 * which was the only base the controller could express. A stacked pull request
 * names another pull request's head branch instead, so the base has to travel
 * with the Publication. Every existing row targeted the default branch, so they
 * are backfilled from their repository.
 */
const stackedPullRequestMigration = `
  DROP INDEX IF EXISTS publication_commands_state_tag;
  DROP INDEX IF EXISTS one_live_publication_command_per_task;

  CREATE TABLE publication_commands_v26 (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Pending', 'Running', 'Published', 'Failed', 'Superseded')),
    commit_sha TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    base_ref TEXT NOT NULL CHECK (base_ref != ''),
    expected_head_sha TEXT NOT NULL,
    head_ref TEXT NOT NULL,
    artifact_ref TEXT NOT NULL,
    patch_digest TEXT NOT NULL,
    changed_files INTEGER NOT NULL CHECK (changed_files >= 0),
    outcome_unknown INTEGER NOT NULL DEFAULT 0 CHECK (outcome_unknown IN (0, 1)),
    reason TEXT,
    worker_id TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_expires_at TEXT,
    published_at TEXT,
    updated_at TEXT NOT NULL,
    pull_request_title TEXT,
    pull_request_body TEXT,
    -- A pull request cannot merge into itself, so a stack can never name its own head.
    CHECK (base_ref != head_ref),
    CHECK (
      (state_tag = 'Running' AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state_tag != 'Running' AND worker_id IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (state_tag NOT IN ('Failed', 'Superseded') OR reason IS NOT NULL),
    CHECK (state_tag != 'Published' OR published_at IS NOT NULL)
  );

  INSERT INTO publication_commands_v26 (
    id, task_id, state_tag, commit_sha, base_sha, base_ref, expected_head_sha, head_ref,
    artifact_ref, patch_digest, changed_files, outcome_unknown, reason, worker_id, fence,
    attempts, max_attempts, lease_expires_at, published_at, updated_at,
    pull_request_title, pull_request_body
  )
  SELECT
    publication_commands.id, publication_commands.task_id, publication_commands.state_tag,
    publication_commands.commit_sha, publication_commands.base_sha,
    COALESCE(json_extract(repositories.policy_json, '$.defaultBranch'), 'main'),
    publication_commands.expected_head_sha, publication_commands.head_ref,
    publication_commands.artifact_ref, publication_commands.patch_digest,
    publication_commands.changed_files, publication_commands.outcome_unknown,
    publication_commands.reason, publication_commands.worker_id, publication_commands.fence,
    publication_commands.attempts, publication_commands.max_attempts,
    publication_commands.lease_expires_at, publication_commands.published_at,
    publication_commands.updated_at, publication_commands.pull_request_title,
    publication_commands.pull_request_body
  FROM publication_commands
  JOIN tasks ON tasks.id = publication_commands.task_id
  JOIN subjects ON subjects.id = tasks.subject_id
  JOIN repositories ON repositories.id = subjects.repository_id;

  DROP TABLE publication_commands;
  ALTER TABLE publication_commands_v26 RENAME TO publication_commands;
  CREATE INDEX publication_commands_state_tag ON publication_commands(state_tag);
  CREATE UNIQUE INDEX one_live_publication_command_per_task
    ON publication_commands(task_id)
    WHERE state_tag IN ('Pending', 'Running', 'Published');

  PRAGMA user_version = 26;
`

function canonicalPayload(subject: GitHubItem): string {
  const { approvalLabels: _approvalLabels, ...payload } = subject
  // Labels are mutable GitHub metadata, so they never belong to the stored Revision.
  delete (payload as Partial<GitHubPullRequestItem>).autoMerge
  return JSON.stringify(payload)
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function inferredClosureObservationId(subject: Pick<GitHubItem, 'repository' | 'kind' | 'number'>, observedAt: string): string {
  return digest(`poll-closure:${subject.repository}:${subject.kind}:${subject.number}:${observedAt}`)
}

function issueTriageState(evidence: string | null): IssueTriageState | undefined {
  if (evidence === null)
    return undefined
  const value = JSON.parse(evidence) as { _tag?: unknown }
  return isIssueTriageState(value._tag) ? value._tag : undefined
}

const freshIssueTriageReason = 'Fresh triage is required before approved issue work can continue.'

function revisionIdFor(subject: GitHubItem): string {
  const { updatedAt: _activityAt, ...revision } = subject
  delete (revision as Partial<GitHubItem>).approvalLabels
  if (revision.kind === 'pull_request') {
    delete (revision as Partial<GitHubPullRequestItem>).autoMerge
    delete (revision as Partial<GitHubPullRequestItem>).maintainerCanModify
    delete (revision as Partial<GitHubPullRequestItem>).priorAutomatedReview
  }
  return digest(JSON.stringify(revision))
}

const reviewGateNames = ['merge', 'review', 'ci'] as const

function derivedReviewOutcome(gates: ReviewGates): ReviewOutcome['_tag'] {
  const states = reviewGateNames.map(name => gates[name]._tag)
  if (states.includes('Failed'))
    return 'Blocked'
  if (states.includes('Pending'))
    return 'Pending'
  return 'Ready'
}

function reviewOutcome(input: RecordReviewRunInput): ReviewOutcome | { _tag: 'Rejected', reason: RecordReviewRunRejection } {
  const tag = derivedReviewOutcome(input.gates)
  const invalidEvidence = [
    { label: 'skill', sha256: input.skillDigest },
    ...reviewGateNames.flatMap(name => input.gates[name].evidence),
  ].find(evidence => !/^[a-f\d]{64}$/.test(evidence.sha256))
  if (invalidEvidence !== undefined)
    return { _tag: 'Rejected', reason: { _tag: 'InvalidEvidenceDigest', label: invalidEvidence.label } }
  if (input.findings.some(finding => finding._tag === 'Open') && tag !== 'Blocked')
    return { _tag: 'Rejected', reason: { _tag: 'OpenFindingRequiresBlocked' } }
  if (input.confidence !== undefined && (!Number.isInteger(input.confidence) || input.confidence < 0 || input.confidence > 100))
    return { _tag: 'Rejected', reason: { _tag: 'InvalidConfidence' } }
  // Confidence belongs to the immutable Agent report, not a moving controller
  // outcome. Historical reports can omit it; current reports always name it.
  return input.confidence === undefined ? { _tag: tag } : { _tag: tag, confidence: input.confidence }
}

function publicationResultFromRow(row: ReviewPublicationRow): ReviewPublicationResult {
  if (row.result_tag === 'Published') {
    if (row.github_comment_id === null || row.github_url === null || row.reason !== null)
      throw new Error(`Review publication ${row.id} has invalid published state.`)
    return { _tag: 'Published', githubCommentId: row.github_comment_id, url: row.github_url }
  }
  if (row.reason === null || row.github_comment_id !== null || row.github_url !== null)
    throw new Error(`Review publication ${row.id} has invalid failed state.`)
  return { _tag: 'Failed', reason: row.reason }
}

function reviewPublicationFromRow(row: ReviewPublicationRow): ReviewPublication {
  return {
    id: row.id,
    reviewRunId: row.review_run_id,
    body: row.body,
    bodySha256: row.body_sha256,
    at: row.created_at,
    result: publicationResultFromRow(row),
  }
}

function agentTokenUsageFromJson(value: string): AgentTokenUsage {
  const usage = JSON.parse(value) as Record<string, unknown>
  if (usage._tag === 'Unavailable')
    return { _tag: 'Unavailable' }
  const counts = [usage.input, usage.cachedInput, usage.cacheWrite, usage.output, usage.reasoning]
  if (usage._tag !== 'Available' || counts.some(count => typeof count !== 'number' || !Number.isInteger(count) || count < 0))
    throw new Error('A Review run has invalid token usage.')
  return {
    _tag: 'Available',
    input: usage.input as number,
    cachedInput: usage.cachedInput as number,
    cacheWrite: usage.cacheWrite as number,
    output: usage.output as number,
    reasoning: usage.reasoning as number,
  }
}

function reviewRunFromRow(row: ReviewRunRow, publications: ReviewPublication[]): ReviewRun {
  const outcome: ReviewOutcome = row.confidence === null
    ? { _tag: row.outcome_tag }
    : { _tag: row.outcome_tag, confidence: row.confidence }
  return {
    id: row.id,
    repository: row.repository,
    pullRequestNumber: row.github_number,
    revisionId: row.revision_id,
    headSha: row.head_sha,
    provider: row.provider,
    sessionId: row.session_id,
    model: row.model,
    agentVersion: row.agent_version,
    skillDigest: row.skill_digest,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    usage: agentTokenUsageFromJson(row.usage),
    gates: JSON.parse(row.gates) as ReviewGates,
    outcome,
    findings: JSON.parse(row.findings) as ReviewFinding[],
    feedback: row.feedback_tag === null || row.feedback_updated_at === null
      ? null
      : row.feedback_tag === 'Useful'
        ? { _tag: 'Useful', reason: row.feedback_reason, updatedAt: row.feedback_updated_at }
        : { _tag: row.feedback_tag, reason: row.feedback_reason ?? '', updatedAt: row.feedback_updated_at },
    publications,
  }
}

function reviewAgentFromRow(row: DashboardReviewRunRow, publications: ReviewPublication[]): Extract<DashboardAgent, { _tag: 'ReviewAgent' }> {
  return {
    _tag: 'ReviewAgent',
    role: 'adversarial_review',
    repositoryUrl: `https://github.com/${row.repository}`,
    title: row.title,
    author: row.author,
    subjectUrl: row.subject_url,
    commitUrl: `https://github.com/${row.head_repository}/commit/${row.head_sha}`,
    pullRequestStatus: { _tag: 'Unknown' },
    updatedAt: row.completed_at,
    ...reviewRunFromRow(row, publications),
  }
}

function taskStateFromRow(row: TaskRow): TaskState {
  switch (row.state_tag) {
    case 'Queued':
      return { _tag: 'Queued' }
    case 'ActionRequired':
      if (row.reason === null)
        throw new Error(`Task ${row.id} has no attention reason.`)
      return { _tag: 'ActionRequired', reason: row.reason }
    case 'Running':
      if (row.worker_id === null || row.lease_expires_at === null)
        throw new Error(`Task ${row.id} has an invalid running state.`)
      return { _tag: 'Running', workerId: row.worker_id, fence: row.fence, leaseExpiresAt: row.lease_expires_at }
    case 'Publishing':
      if (row.command_id === null)
        throw new Error(`Task ${row.id} has no publication command.`)
      return { _tag: 'Publishing', commandId: row.command_id }
    case 'Completed':
      if (row.evidence === null)
        throw new Error(`Task ${row.id} has no completion evidence.`)
      return { _tag: 'Completed', evidence: row.evidence }
    case 'Failed':
      if (row.reason === null)
        throw new Error(`Task ${row.id} has no failure reason.`)
      return { _tag: 'Failed', reason: row.reason }
    case 'Superseded':
      if (row.reason === null)
        throw new Error(`Task ${row.id} has no supersession reason.`)
      return { _tag: 'Superseded', reason: row.reason }
  }
}

function githubSubjectFromRow(row: SubjectRow): GitHubItem {
  const base = {
    repository: row.repository,
    number: row.github_number,
    state: row.state,
    title: row.title,
    author: row.author,
    url: row.url,
    createdAt: row.github_created_at,
    updatedAt: row.github_updated_at,
  }

  if (row.kind === 'issue') {
    return {
      ...base,
      kind: 'issue',
      approvalLabels: [],
      contentDigest: row.content_digest ?? row.revision_id,
      routineFiled: false,
      routineTracking: false,
    }
  }

  if (row.draft === null || row.base_sha === null || row.head_sha === null || row.head_repository === null || row.head_ref === null || row.merge_state === null)
    throw new Error(`Pull request ${row.repository}#${row.github_number} has incomplete state.`)

  return {
    ...base,
    kind: 'pull_request',
    approvalLabels: [],
    autoMerge: false,
    mergedAt: row.merged_at,
    draft: row.draft === 1,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    headRepository: row.head_repository,
    headRef: row.head_ref,
    mergeState: row.merge_state,
    purpose: row.purpose_tag === 'BaselineRepair' && row.purpose_base_sha_prefix !== undefined && row.purpose_base_sha_prefix !== null
      ? { _tag: 'BaselineRepair', baseShaPrefix: row.purpose_base_sha_prefix }
      : { _tag: 'Change' },
    priorAutomatedReview: { _tag: 'None' },
  }
}

function selectionMode(database: DatabaseSync): SelectionMode {
  const row = database.prepare('SELECT selection_mode FROM agent_control WHERE singleton = 1').get() as { selection_mode: SelectionMode }
  return row.selection_mode
}

/**
 * Manual Selection mode requires Approval for every pull request, whoever
 * opened it. Auto requires it only from an author who cannot write here.
 */
function requiresPullRequestApproval(database: DatabaseSync, mapping: RepositoryMapping, author: string): boolean {
  return mapping.pullRequestReview
    && (selectionMode(database) === 'manual' || requiresIssueApproval(mapping, author))
}

function requiresIssueApproval(mapping: RepositoryMapping, author: string): boolean {
  return !mapping.writablePullRequestAuthors.some(candidate => candidate.toLowerCase() === author.toLowerCase())
}

function canWritePullRequestHead(mapping: RepositoryMapping, subject: GitHubPullRequestItem): boolean {
  return mapping.ownership === 'owned'
    && subject.headRepository.toLowerCase() === mapping.github.toLowerCase()
    && mapping.writablePullRequestAuthors.some(author => author.toLowerCase() === subject.author.toLowerCase())
    && mapping.writablePullRequestHeadPrefixes.some(prefix => subject.headRef.startsWith(prefix))
    && subject.headRef !== mapping.defaultBranch
}

function pullRequestApprovalState(database: DatabaseSync, input: {
  mapping: RepositoryMapping
  author: string
  reviewApprovedAt: string | null
}): PullRequestApprovalState {
  const reviewRequired = requiresPullRequestApproval(database, input.mapping, input.author)
  if (reviewRequired && input.reviewApprovedAt === null)
    return { _tag: 'ReviewRequired' }
  return reviewRequired
    ? { _tag: 'ReviewApproved', approvedAt: input.reviewApprovedAt as string }
    : { _tag: 'NotRequired' }
}

function subjectFromRow(database: DatabaseSync, row: DashboardSubjectRow): ItemSummary {
  const subject = githubSubjectFromRow(row)
  const dismissed = row.dismissed === 1
  if (subject.kind === 'issue')
    return { ...subject, revisionId: row.revision_id, observedAt: row.observed_at, dismissed }
  return {
    ...subject,
    revisionId: row.revision_id,
    observedAt: row.observed_at,
    dismissed,
    approval: pullRequestApprovalState(database, {
      mapping: JSON.parse(row.policy_json) as RepositoryMapping,
      author: row.author,
      reviewApprovedAt: row.review_approved_at,
    }),
  }
}

function taskFromRow(row: TaskRow): DashboardTask {
  const base = {
    id: row.id,
    repository: row.repository,
    revisionId: row.revision_id,
    state: taskStateFromRow(row),
    updatedAt: row.updated_at,
    recoveryAttempts: row.recovery_attempts,
    progress: { percent: row.progress_percent, label: row.progress_label },
  }
  if (row.kind === 'issue_triage' || row.kind === 'issue_work')
    return { ...base, kind: row.kind, issueNumber: row.github_number } satisfies IssueTriageTask | IssueWorkTask
  return { ...base, kind: row.kind, pullRequestNumber: row.github_number } satisfies ConflictResolutionTask | ReviewFixTask | BaselineRepairTask | AdversarialReviewTask
}

function activeAgentFromRow(row: ActiveAgentRow, provider: AgentProviderName): Extract<DashboardAgent, { _tag: 'ActiveAgent' }> {
  const taskState = taskStateFromRow(row)
  if (taskState._tag !== 'Running' && taskState._tag !== 'Publishing')
    throw new Error(`Task ${row.id} is not active.`)
  const head = row.head_sha === null || row.head_repository === null
    ? {}
    : {
        headSha: row.head_sha,
        commitUrl: `https://github.com/${row.head_repository}/commit/${row.head_sha}`,
      }
  return {
    _tag: 'ActiveAgent',
    id: row.id,
    provider,
    role: row.kind === 'resolve_conflict' ? 'conflict_resolution' : row.kind,
    session: row.session_id === null ? { _tag: 'Starting' } : { _tag: 'Connected', id: row.session_id },
    repository: row.repository,
    repositoryUrl: `https://github.com/${row.repository}`,
    subjectKind: row.subject_kind,
    itemNumber: row.github_number,
    title: row.title,
    author: row.author,
    subjectUrl: row.subject_url,
    ...head,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    progress: { percent: row.progress_percent, label: row.progress_label },
    // Activity is ephemeral runtime state, so the app layer attaches it, not the journal.
    activity: [],
    state: taskState._tag === 'Running'
      ? { _tag: 'Working', workerId: taskState.workerId, fence: taskState.fence, leaseExpiresAt: taskState.leaseExpiresAt }
      : { _tag: 'Publishing', commandId: taskState.commandId },
  }
}

function queuePriority(entry: UnpositionedQueueEntry): number {
  switch (entry.state._tag) {
    case 'Active': return 0
    case 'ActionRequired': return 10
    case 'AwaitingApproval': return 20
    case 'Queued': return 30
    case 'Pending': return 60
  }
}

function failedQueueState(reason: string, recoveryAttempts?: number): QueueState {
  const failure = classifyFailure({ message: reason })
  // A Task the controller can still requeue is Pending. An exhausted non-provider
  // failure is never requeued, so it needs a person and reads ActionRequired.
  const recoverable = failure._tag === 'Transient'
    && ((recoveryAttempts ?? 0) < MAXIMUM_RECOVERY_ATTEMPTS || failure.kind === 'agent_provider')
  return recoverable
    ? { _tag: 'Pending', reason: `${reason} The controller will retry.` }
    : { _tag: 'ActionRequired', reason }
}

function isProviderCircuitPause(reason: string): boolean {
  return reason.includes('The Agent provider circuit is open.')
    || reason.includes('Another Agent Task owns the provider health canary.')
}

function reviewDesiredOutcomeFromBody(body: string): ReviewDesiredOutcome | null {
  if (body.includes('### 🤖 READY'))
    return 'READY'
  if (body.includes('### 🤖 BLOCKED'))
    return 'BLOCKED'
  if (body.includes('### 🤖 WAITING'))
    return 'WAITING'
  if (body.includes('### 🤖 REVIEW SKIPPED'))
    return 'SKIPPED'
  if (body.includes('### 🤖 PENDING'))
    return 'PENDING'
  return null
}

function dashboardQueue(
  items: ItemSummary[],
  tasks: DashboardTask[],
  reviewAgents: Array<Extract<DashboardAgent, { _tag: 'ReviewAgent' }>>,
  mappings: Map<string, RepositoryMapping>,
  rejectedIssueWorkResults: Map<string, number>,
  openPullRequestsByRepository: Map<string, number>,
  currentSelectionMode: SelectionMode,
  reviewResolutions: Map<string, ReviewResolution>,
  desiredReviewOutcomes: Map<string, ReviewDesiredOutcome>,
): QueueEntry[] {
  const currentTasks = new Map<string, DashboardTask>()
  tasks.forEach((task) => {
    const itemNumber = task.kind === 'issue_triage' || task.kind === 'issue_work' ? task.issueNumber : task.pullRequestNumber
    const key = `${task.repository}:${itemNumber}:${task.revisionId}:${task.kind}`
    if (!currentTasks.has(key))
      currentTasks.set(key, task)
  })
  const currentReviews = new Map<string, Extract<DashboardAgent, { _tag: 'ReviewAgent' }>>()
  reviewAgents.forEach((agent) => {
    const key = `${agent.repository}:${agent.pullRequestNumber}:${agent.revisionId}`
    if (!currentReviews.has(key))
      currentReviews.set(key, agent)
  })

  const entries = items.flatMap((subject): UnpositionedQueueEntry[] => {
    const mapping = mappings.get(subject.repository)
    if (mapping === undefined)
      return []
    const base = {
      revisionId: subject.revisionId,
      repository: subject.repository,
      repositoryUrl: `https://github.com/${subject.repository}`,
      number: subject.number,
      title: subject.title,
      author: subject.author,
      subjectUrl: subject.url,
      createdAt: subject.createdAt,
      updatedAt: subject.observedAt,
    }
    if (subject.kind === 'issue') {
      const work = currentTasks.get(`${subject.repository}:${subject.number}:${subject.revisionId}:issue_work`)
      if (work?.kind === 'issue_work') {
        switch (work.state._tag) {
          case 'Running':
          case 'Publishing': return [{ ...base, kind: 'issue', state: { _tag: 'Active', work: 'issue_work' } }]
          case 'Queued': {
            const limit = mapping.maxOpenPullRequests
            const openPullRequests = openPullRequestsByRepository.get(subject.repository) ?? 0
            if (currentSelectionMode === 'auto' && limit !== null && openPullRequests >= limit) {
              const pullRequest = limit === 1 ? 'pull request' : 'pull requests'
              return [{
                ...base,
                kind: 'issue',
                state: {
                  _tag: 'Pending',
                  reason: `${subject.repository} reached its limit of ${limit} open automated ${pullRequest}. Merge or close one to start Issue work.`,
                },
              }]
            }
            return [{ ...base, kind: 'issue', state: { _tag: 'Queued', work: 'issue_work' } }]
          }
          case 'ActionRequired': {
            const rejectedResults = rejectedIssueWorkResults.get(work.id)
            const reason = rejectedResults === undefined
              ? work.state.reason
              : `Issue work stopped after ${rejectedResults} invalid pull request titles or descriptions. Update the issue to start fresh Issue triage.`
            return [{ ...base, kind: 'issue', state: { _tag: 'ActionRequired', reason } }]
          }
          case 'Failed': return [{ ...base, kind: 'issue', state: failedQueueState(work.state.reason, work.recoveryAttempts) }]
          case 'Completed': return [{ ...base, kind: 'issue', state: { _tag: 'Pending', reason: 'Waiting for GitHub to report the pull request.' } }]
          case 'Superseded': break
        }
      }
      const task = currentTasks.get(`${subject.repository}:${subject.number}:${subject.revisionId}:issue_triage`)
      if (task?.kind !== 'issue_triage')
        return []
      switch (task.state._tag) {
        case 'Running': return [{ ...base, kind: 'issue', state: { _tag: 'Active', work: 'issue_triage' } }]
        case 'Queued': return [{ ...base, kind: 'issue', state: { _tag: 'Queued', work: 'issue_triage' } }]
        case 'ActionRequired': return [{ ...base, kind: 'issue', state: { _tag: 'ActionRequired', reason: task.state.reason } }]
        case 'Failed': return [{ ...base, kind: 'issue', state: failedQueueState(task.state.reason, task.recoveryAttempts) }]
        case 'Completed': {
          const triage = JSON.parse(task.state.evidence) as { _tag?: unknown, nextAction?: unknown }
          if (triage._tag === 'READY_TO_IMPLEMENT' && canWorkIssues(mapping))
            return [{ ...base, kind: 'issue', state: { _tag: 'AwaitingApproval', kind: 'issue_work' } }]
          if (triage._tag === 'NEEDS_INFO')
            return [{ ...base, kind: 'issue', state: { _tag: 'ActionRequired', reason: typeof triage.nextAction === 'string' ? triage.nextAction : 'The issue needs more information.' } }]
          return []
        }
        case 'Superseded': return []
        case 'Publishing': throw new Error('Issue triage cannot enter publication state.')
      }
      return []
    }

    const pullRequest = {
      ...base,
      kind: 'pull_request' as const,
      headSha: subject.headSha,
      commitUrl: `https://github.com/${subject.headRepository}/commit/${subject.headSha}`,
    }
    const key = `${subject.repository}:${subject.number}:${subject.revisionId}`
    const task = currentTasks.get(`${key}:resolve_conflict`)
    if (task?.kind === 'resolve_conflict') {
      switch (task.state._tag) {
        case 'Running':
        case 'Publishing': return [{ ...pullRequest, state: { _tag: 'Active', work: 'conflict_resolution' } }]
        case 'ActionRequired': return [{ ...pullRequest, state: { _tag: 'ActionRequired', reason: task.state.reason } }]
        case 'Failed': return [{ ...pullRequest, state: failedQueueState(task.state.reason, task.recoveryAttempts) }]
        case 'Queued': return [{ ...pullRequest, state: { _tag: 'Queued', work: 'conflict_resolution' } }]
        case 'Completed': return [{ ...pullRequest, state: { _tag: 'Pending', reason: 'Waiting for GitHub to report the updated head.' } }]
        case 'Superseded': break
      }
    }
    const baseline = currentTasks.get(`${key}:baseline_repair`)
    if (baseline?.kind === 'baseline_repair') {
      switch (baseline.state._tag) {
        case 'Running':
        case 'Publishing': return [{ ...pullRequest, state: { _tag: 'Active', work: 'baseline_repair' } }]
        case 'Queued': return [{ ...pullRequest, state: { _tag: 'Queued', work: 'baseline_repair' } }]
        case 'ActionRequired': return [{ ...pullRequest, state: { _tag: 'ActionRequired', reason: baseline.state.reason } }]
        case 'Failed': return [{ ...pullRequest, state: failedQueueState(baseline.state.reason, baseline.recoveryAttempts) }]
        case 'Completed': return [{ ...pullRequest, state: { _tag: 'Pending', reason: 'Waiting for GitHub to report the Baseline repair pull request.' } }]
        case 'Superseded': break
      }
    }
    if (subject.draft)
      return [{ ...pullRequest, state: { _tag: 'Pending', reason: 'Draft pull request.' } }]
    if (subject.mergeState === 'conflicting') {
      const reason = mapping.ownership === 'maintained'
        ? 'Conflict resolution is off for maintained repositories. Resolve the merge conflicts on GitHub.'
        : 'Conflict resolution is off for this repository. Enable it or resolve the merge conflicts on GitHub.'
      return [{ ...pullRequest, state: { _tag: 'ActionRequired', reason } }]
    }
    if (subject.mergeState === 'unknown')
      return [{ ...pullRequest, state: { _tag: 'Pending', reason: 'Waiting for mergeability.' } }]
    if (subject.approval._tag === 'ReviewRequired')
      return [{ ...pullRequest, state: { _tag: 'AwaitingApproval', kind: 'review' } }]

    const reviewTask = currentTasks.get(`${key}:adversarial_review`)
    const fixTask = currentTasks.get(`${key}:review_fix`)
    if (fixTask?.kind === 'review_fix') {
      switch (fixTask.state._tag) {
        case 'Running':
        case 'Publishing': return [{ ...pullRequest, state: { _tag: 'Active', work: 'review_fix' } }]
        case 'Queued': return [{ ...pullRequest, state: { _tag: 'Queued', work: 'review_fix' } }]
        case 'ActionRequired': return [{ ...pullRequest, state: { _tag: 'ActionRequired', reason: fixTask.state.reason } }]
        case 'Failed': return [{ ...pullRequest, state: failedQueueState(fixTask.state.reason, fixTask.recoveryAttempts) }]
        case 'Completed': return [{ ...pullRequest, state: { _tag: 'Pending', reason: 'Waiting for GitHub to report the repaired head commit.' } }]
        case 'Superseded': break
      }
    }

    const review = currentReviews.get(key)
    if (
      reviewTask?.kind === 'adversarial_review'
      && (review === undefined || (reviewTask.updatedAt > review.completedAt && reviewTask.progress.percent < 90))
    ) {
      if (reviewTask.state._tag === 'Running')
        return [{ ...pullRequest, state: { _tag: 'Active', work: 'adversarial_review' } }]
      if (reviewTask.state._tag === 'Queued')
        return [{ ...pullRequest, state: { _tag: 'Queued', work: 'adversarial_review' } }]
    }

    const desiredOutcome = desiredReviewOutcomes.get(key)
    if (desiredOutcome === 'READY' || desiredOutcome === 'EXISTING' || desiredOutcome === 'SKIPPED')
      return []
    if (desiredOutcome === 'PENDING' || desiredOutcome === 'WAITING')
      return [{ ...pullRequest, state: { _tag: 'Pending', reason: desiredOutcome === 'WAITING' ? 'Waiting for Baseline repair.' : 'Review gates are waiting.' } }]

    const resolution = reviewResolutions.get(key)
    if (resolution?._tag === 'ExistingReview' || resolution?._tag === 'ReviewSkipped')
      return []
    if (resolution?._tag === 'WaitingForBaselineRepair')
      return [{ ...pullRequest, state: { _tag: 'Pending', reason: 'Waiting for Baseline repair.' } }]
    if (resolution?._tag === 'UnknownNeedsReconciliation')
      return [{ ...pullRequest, state: { _tag: 'ActionRequired', reason: resolution.reason } }]

    if (review?.outcome._tag === 'Ready')
      return []
    if (desiredOutcome === 'BLOCKED' || review?.outcome._tag === 'Blocked') {
      const findings = (review?.findings ?? []).filter(candidate => candidate._tag === 'Open')
      const finding = findings[0]
      const count = findings.length
      const prefix = count === 1
        ? 'Automated review found 1 open review issue.'
        : `Automated review found ${count} open review issues.`
      return [{
        ...pullRequest,
        state: {
          _tag: 'ActionRequired',
          reason: finding?._tag === 'Open'
            ? `${prefix}${count > 1 ? ' First:' : ''} ${finding.summary} Next: ${finding.nextAction}`
            : 'Automated review is BLOCKED. Open GitHub for details.',
        },
      }]
    }
    if (review?.outcome._tag === 'Pending')
      return [{ ...pullRequest, state: { _tag: 'Pending', reason: 'Review gates are waiting.' } }]
    if (reviewTask?.kind !== 'adversarial_review')
      return []
    switch (reviewTask.state._tag) {
      case 'Running':
      case 'Queued': throw new Error('Active review Tasks were handled before historical review results.')
      case 'ActionRequired': return [{ ...pullRequest, state: { _tag: 'ActionRequired', reason: reviewTask.state.reason } }]
      case 'Failed': return [{ ...pullRequest, state: failedQueueState(reviewTask.state.reason, reviewTask.recoveryAttempts) }]
      case 'Completed': return [{ ...pullRequest, state: { _tag: 'Pending', reason: 'The review result is being recorded.' } }]
      case 'Superseded': return []
      case 'Publishing': throw new Error('Adversarial review cannot enter publication state.')
    }
    return []
  })

  return entries
    .sort((left, right) => queuePriority(left) - queuePriority(right) || left.createdAt.localeCompare(right.createdAt))
    .map((entry, index) => ({ ...entry, position: index + 1 }))
}

interface WorkflowEventInput {
  stream: WorkflowEventStream
  event: string
  entityId: string
  repository?: string | null
  itemNumber?: number | null
  revisionId?: string | null
  taskId?: string | null
  from: string | null
  to: string
  reason?: string | null
  attempt?: number
  fence?: number
  usage?: AgentTokenUsage | null
  durationMilliseconds?: number | null
  at: string
}

interface WorkflowScope {
  repository: string | null
  item_number: number | null
  revision_id: string | null
  task_id: string | null
  attempts: number
}

interface ProviderCircuitRow {
  id: string
  provider: AgentProviderName
  credential: string
  model: string
  failure_class: ProviderFailureClass
  state_tag: 'Closed' | 'Open' | 'HalfOpen'
  failures: number
  retry_at: string | null
  canary_worker_id: string | null
  canary_fence: number
  canary_lease_expires_at: string | null
  last_detail: string
  updated_at: string
}

function providerCircuitFromRow(row: ProviderCircuitRow): ProviderCircuit {
  const state = row.state_tag === 'Open'
    ? { _tag: 'Open' as const, retryAt: row.retry_at ?? row.updated_at }
    : row.state_tag === 'HalfOpen'
      ? {
          _tag: 'HalfOpen' as const,
          workerId: row.canary_worker_id ?? '',
          fence: row.canary_fence,
          leaseExpiresAt: row.canary_lease_expires_at ?? row.updated_at,
        }
      : { _tag: 'Closed' as const }
  return {
    id: row.id,
    provider: row.provider,
    credential: row.credential,
    model: row.model,
    failureClass: row.failure_class,
    failures: row.failures,
    state,
    lastDetail: row.last_detail,
    updatedAt: row.updated_at,
  }
}

function recordProviderCircuitEvent(database: DatabaseSync, row: ProviderCircuitRow, event: string, from: string | null, to: string, at: string, reason?: string): void {
  recordWorkflowEvent(database, {
    stream: 'provider_circuit',
    event,
    entityId: row.id,
    taskId: row.canary_worker_id,
    from,
    to,
    ...(reason === undefined ? {} : { reason }),
    attempt: row.failures,
    fence: row.canary_fence,
    at,
  })
}

function telemetryReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined)
    return null
  return truncateOutput(redactSecrets(reason)).replace(/\s+/g, ' ').trim()
}

function recordWorkflowEvent(database: DatabaseSync, input: WorkflowEventInput): void {
  const previous = database.prepare(`
    SELECT occurred_at FROM workflow_events
    WHERE stream = ? AND entity_id = ?
    ORDER BY occurred_at DESC, id DESC LIMIT 1
  `).get(input.stream, input.entityId) as { occurred_at: string } | undefined
  const elapsed = previous === undefined ? null : Date.parse(input.at) - Date.parse(previous.occurred_at)
  const measuredDuration = elapsed === null || !Number.isFinite(elapsed) ? null : Math.max(0, elapsed)
  const duration = input.durationMilliseconds === undefined ? measuredDuration : input.durationMilliseconds
  database.prepare(`
    INSERT INTO workflow_events (
      stream, event, entity_id, repository, item_number, revision_id, task_id,
      from_state, to_state, reason, attempt, fence, duration_ms, usage, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.stream,
    input.event,
    input.entityId,
    input.repository ?? null,
    input.itemNumber ?? null,
    input.revisionId ?? null,
    input.taskId ?? null,
    input.from,
    input.to,
    telemetryReason(input.reason),
    input.attempt ?? 0,
    input.fence ?? 0,
    duration,
    input.usage === undefined || input.usage === null ? null : JSON.stringify(input.usage),
    input.at,
  )
}

function workflowTransitionEvent(from: string | null, to: string): string {
  if (from === null)
    return 'Opened'
  if (to === 'Running')
    return 'Claimed'
  if ((to === 'Queued' || to === 'Pending') && from === 'Running')
    return 'Retrying'
  return to
}

function taskWorkflowScope(database: DatabaseSync, table: 'tasks' | 'worker_tasks', taskId: string): WorkflowScope {
  return database.prepare(`
    SELECT repositories.github AS repository, subjects.github_number AS item_number,
      ${table}.revision_id, ${table}.id AS task_id,
      ${table}.attempts AS attempts
    FROM ${table}
    JOIN subjects ON subjects.id = ${table}.subject_id
    JOIN repositories ON repositories.id = subjects.repository_id
    WHERE ${table}.id = ?
  `).get(taskId) as unknown as WorkflowScope
}

function publicationWorkflowScope(database: DatabaseSync, commandId: string): WorkflowScope {
  return database.prepare(`
    SELECT COALESCE(item_repositories.github, routines.repository) AS repository,
      subjects.github_number AS item_number, tasks.revision_id,
      publication_commands.task_id, publication_commands.attempts
    FROM publication_commands
    LEFT JOIN tasks ON tasks.id = publication_commands.task_id
    LEFT JOIN subjects ON subjects.id = tasks.subject_id
    LEFT JOIN repositories AS item_repositories ON item_repositories.id = subjects.repository_id
    LEFT JOIN routine_runs ON routine_runs.id = publication_commands.routine_run_id
    LEFT JOIN routines ON routines.id = routine_runs.routine_id
    WHERE publication_commands.id = ?
  `).get(commandId) as unknown as WorkflowScope
}

function issueTriageStatusWorkflowScope(database: DatabaseSync, commandId: string): WorkflowScope {
  return database.prepare(`
    SELECT repositories.github AS repository, subjects.github_number AS item_number,
      issue_triage_comment_commands.revision_id, issue_triage_comment_commands.task_id,
      issue_triage_comment_commands.fence AS attempts
    FROM issue_triage_comment_commands
    JOIN worker_tasks ON worker_tasks.id = issue_triage_comment_commands.task_id
    JOIN subjects ON subjects.id = worker_tasks.subject_id
    JOIN repositories ON repositories.id = subjects.repository_id
    WHERE issue_triage_comment_commands.id = ?
  `).get(commandId) as unknown as WorkflowScope
}

function recordIssueTriageStatusEvent(database: DatabaseSync, input: {
  commandId: string
  event: string
  from: string | null
  to: string
  at: string
  reason?: string | null
  fence?: number
}): void {
  const scope = issueTriageStatusWorkflowScope(database, input.commandId)
  recordWorkflowEvent(database, {
    stream: 'issue_triage_status',
    event: input.event,
    entityId: input.commandId,
    repository: scope.repository,
    itemNumber: scope.item_number,
    revisionId: scope.revision_id,
    taskId: scope.task_id,
    from: input.from,
    to: input.to,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    attempt: input.fence ?? scope.attempts,
    fence: input.fence ?? scope.attempts,
    at: input.at,
  })
}

function reviewStatusWorkflowScope(database: DatabaseSync, commandId: string): WorkflowScope {
  return database.prepare(`
    SELECT repositories.github AS repository, subjects.github_number AS item_number,
      review_status_commands.revision_id, review_status_commands.task_id,
      review_status_commands.fence AS attempts
    FROM review_status_commands
    LEFT JOIN worker_tasks
      ON review_status_commands.task_kind = 'adversarial_review'
      AND worker_tasks.id = review_status_commands.task_id
    LEFT JOIN tasks
      ON review_status_commands.task_kind = 'review_fix'
      AND tasks.id = review_status_commands.task_id
    JOIN subjects ON subjects.id = COALESCE(worker_tasks.subject_id, tasks.subject_id)
    JOIN repositories ON repositories.id = subjects.repository_id
    WHERE review_status_commands.id = ?
  `).get(commandId) as unknown as WorkflowScope
}

function recordReviewStatusEvent(database: DatabaseSync, input: {
  commandId: string
  event: string
  from: string | null
  to: string
  at: string
  reason?: string | null
  fence?: number
}): void {
  const scope = reviewStatusWorkflowScope(database, input.commandId)
  recordWorkflowEvent(database, {
    stream: 'review_status',
    event: input.event,
    entityId: input.commandId,
    repository: scope.repository,
    itemNumber: scope.item_number,
    revisionId: scope.revision_id,
    taskId: scope.task_id,
    from: input.from,
    to: input.to,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    attempt: input.fence ?? scope.attempts,
    fence: input.fence ?? scope.attempts,
    at: input.at,
  })
}

function supersedeUnauthorizedReviewStatuses(database: DatabaseSync, at: string): void {
  const reason = 'Repository policy no longer permits this automated review.'
  const commands = database.prepare(`
    SELECT review_status_commands.id, review_status_commands.fence
    FROM review_status_commands
    LEFT JOIN worker_tasks
      ON review_status_commands.task_kind = 'adversarial_review'
      AND worker_tasks.id = review_status_commands.task_id
    LEFT JOIN tasks
      ON review_status_commands.task_kind = 'review_fix'
      AND tasks.id = review_status_commands.task_id
    JOIN subjects ON subjects.id = COALESCE(worker_tasks.subject_id, tasks.subject_id)
    JOIN repositories ON repositories.id = subjects.repository_id
    WHERE review_status_commands.state_tag = 'Pending'
      AND (
        repositories.enabled = 0
        OR json_extract(repositories.policy_json, '$.pullRequestReview') != 1
      )
  `).all() as unknown as Array<{ id: string, fence: number }>
  const supersede = database.prepare(`
    UPDATE review_status_commands
    SET state_tag = 'Superseded', reason = ?, worker_id = NULL,
      lease_expires_at = NULL, updated_at = ?
    WHERE id = ? AND state_tag = 'Pending' AND fence = ?
  `)
  commands.forEach((command) => {
    if (supersede.run(reason, at, command.id, command.fence).changes !== 1)
      return
    recordReviewStatusEvent(database, {
      commandId: command.id,
      event: 'PolicySuperseded',
      from: 'Pending',
      to: 'Superseded',
      reason,
      fence: command.fence,
      at,
    })
  })
}

function routineWorkflowScope(database: DatabaseSync, runId: string): WorkflowScope {
  return database.prepare(`
    SELECT routines.repository, NULL AS item_number, NULL AS revision_id,
      routine_runs.id AS task_id, routine_runs.attempts
    FROM routine_runs
    JOIN routines ON routines.id = routine_runs.routine_id
    WHERE routine_runs.id = ?
  `).get(runId) as unknown as WorkflowScope
}

function recordRoutineRunEvent(database: DatabaseSync, input: {
  runId: string
  event: string
  from: string | null
  to: string
  at: string
  reason?: string | null
  fence?: number
  usage?: AgentTokenUsage | null
}): void {
  const scope = routineWorkflowScope(database, input.runId)
  recordWorkflowEvent(database, {
    stream: 'routine_run',
    event: input.event,
    entityId: input.runId,
    repository: scope.repository,
    taskId: input.runId,
    from: input.from,
    to: input.to,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    attempt: scope.attempts,
    fence: input.fence ?? 0,
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    at: input.at,
  })
}

function durableCommandScope(
  database: DatabaseSync,
  stream: 'candidate_issue' | 'routine_report',
  commandId: string,
): WorkflowScope {
  if (stream === 'candidate_issue') {
    return database.prepare(`
      SELECT repository, github_issue_number AS item_number, NULL AS revision_id,
        candidate_id AS task_id, attempts
      FROM candidate_issue_commands WHERE id = ?
    `).get(commandId) as unknown as WorkflowScope
  }
  return database.prepare(`
    SELECT routine_report_commands.repository,
      routines.tracking_issue_number AS item_number, NULL AS revision_id,
      routine_report_commands.run_id AS task_id, routine_report_commands.attempts
    FROM routine_report_commands
    LEFT JOIN routines ON routines.id = routine_report_commands.routine_id
    WHERE routine_report_commands.id = ?
  `).get(commandId) as unknown as WorkflowScope
}

function recordDurableCommandEvent(database: DatabaseSync, input: {
  stream: 'candidate_issue' | 'routine_report'
  commandId: string
  event: string
  from: string | null
  to: string
  at: string
  reason?: string | null
  fence?: number
}): void {
  const scope = durableCommandScope(database, input.stream, input.commandId)
  recordWorkflowEvent(database, {
    stream: input.stream,
    event: input.event,
    entityId: input.commandId,
    repository: scope.repository,
    itemNumber: scope.item_number,
    taskId: scope.task_id,
    from: input.from,
    to: input.to,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    attempt: scope.attempts,
    fence: input.fence ?? 0,
    at: input.at,
  })
}

function recordTransition(database: DatabaseSync, input: {
  taskId: string
  from: TaskRow['state_tag'] | null
  to: TaskRow['state_tag']
  reason: string | null
  fence: number
  usage?: AgentTokenUsage | null
  at: string
}): void {
  database.prepare(`
    INSERT INTO task_transitions (task_id, from_tag, to_tag, reason, fence, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(input.taskId, input.from, input.to, input.reason, input.fence, input.at)
  const scope = taskWorkflowScope(database, 'tasks', input.taskId)
  recordWorkflowEvent(database, {
    stream: 'task',
    event: workflowTransitionEvent(input.from, input.to),
    entityId: input.taskId,
    repository: scope.repository,
    itemNumber: scope.item_number,
    revisionId: scope.revision_id,
    taskId: input.taskId,
    from: input.from,
    to: input.to,
    reason: input.reason,
    attempt: scope.attempts,
    fence: input.fence,
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    at: input.at,
  })
}

function recordWorkerTransition(database: DatabaseSync, input: {
  taskId: string
  from: 'Queued' | 'ActionRequired' | 'Running' | 'Completed' | 'Failed' | 'Superseded' | null
  to: 'Queued' | 'ActionRequired' | 'Running' | 'Completed' | 'Failed' | 'Superseded'
  reason: string | null
  fence: number
  usage?: AgentTokenUsage | null
  at: string
}): void {
  database.prepare(`
    INSERT INTO worker_task_transitions (task_id, from_tag, to_tag, reason, fence, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(input.taskId, input.from, input.to, input.reason, input.fence, input.at)
  const scope = taskWorkflowScope(database, 'worker_tasks', input.taskId)
  recordWorkflowEvent(database, {
    stream: 'worker_task',
    event: workflowTransitionEvent(input.from, input.to),
    entityId: input.taskId,
    repository: scope.repository,
    itemNumber: scope.item_number,
    revisionId: scope.revision_id,
    taskId: input.taskId,
    from: input.from,
    to: input.to,
    reason: input.reason,
    attempt: scope.attempts,
    fence: input.fence,
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    at: input.at,
  })
}

function recordPublicationEvent(database: DatabaseSync, input: {
  commandId: string
  from: 'Pending' | 'Running' | null
  to: 'Pending' | 'Running' | 'Published' | 'Failed' | 'Superseded'
  reason: string | null
  fence: number
  at: string
}): void {
  database.prepare(`
    INSERT INTO publication_events (command_id, from_tag, to_tag, reason, fence, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(input.commandId, input.from, input.to, input.reason, input.fence, input.at)
  const scope = publicationWorkflowScope(database, input.commandId)
  recordWorkflowEvent(database, {
    stream: 'publication',
    event: workflowTransitionEvent(input.from, input.to),
    entityId: input.commandId,
    repository: scope.repository,
    itemNumber: scope.item_number,
    revisionId: scope.revision_id,
    taskId: scope.task_id,
    from: input.from,
    to: input.to,
    reason: input.reason,
    attempt: scope.attempts,
    fence: input.fence,
    at: input.at,
  })
}

/**
 * Which Tasks a repository still lets the controller publish.
 *
 * Staging a publication, claiming it, and renewing its lease all ask this same
 * question. They drifted apart once: Baseline repair learned to run on a
 * repository Harlan maintains, and this clause kept demanding an owned one, so
 * every repair did its whole agent turn and was refused at staging. One
 * definition, three uses.
 *
 * Expects `tasks`, `subjects` and `repositories` to be in scope.
 */
const PUBLICATION_AUTHORITY_SQL = `
  (
    (tasks.kind = 'resolve_conflict' AND json_extract(repositories.policy_json, '$.conflictResolution') = 1)
    OR (
      tasks.kind = 'review_fix'
      AND json_extract(repositories.policy_json, '$.pullRequestReview') = 1
      AND EXISTS (
        SELECT 1 FROM pull_request_approvals
        WHERE pull_request_approvals.subject_id = subjects.id
          AND pull_request_approvals.revision_id = tasks.revision_id
          AND pull_request_approvals.kind = 'fixes'
      )
    )
    OR (
      tasks.kind = 'baseline_repair'
      AND repositories.ownership != 'external'
      AND json_extract(repositories.policy_json, '$.pullRequestReview') = 1
    )
    OR (tasks.kind = 'issue_work' AND json_extract(repositories.policy_json, '$.issueWork') = 1)
  )
`

function supersedeTasks(
  database: DatabaseSync,
  subjectId: number,
  at: string,
  reason: string,
  exceptRevisionId?: string,
  kind: 'resolve_conflict' | 'review_fix' | 'baseline_repair' | 'issue_work' = 'resolve_conflict',
): void {
  const rows = database.prepare(`
    SELECT id, state_tag, fence FROM tasks
    WHERE subject_id = ?
      AND kind = ?
      AND state_tag IN ('Queued', 'ActionRequired', 'Running', 'Publishing')
      AND (? IS NULL OR revision_id != ?)
  `).all(subjectId, kind, exceptRevisionId ?? null, exceptRevisionId ?? null) as unknown as Array<{ id: string, state_tag: TaskRow['state_tag'], fence: number }>

  const update = database.prepare(`
    UPDATE tasks
    SET state_tag = 'Superseded', reason = ?, worker_id = NULL, command_id = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE id = ? AND state_tag = ?
  `)
  rows.forEach((row) => {
    const result = update.run(reason, at, row.id, row.state_tag)
    if (result.changes === 1) {
      database.prepare(`
        UPDATE publication_commands
        SET state_tag = 'Superseded', reason = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE task_id = ? AND state_tag IN ('Pending', 'Running')
      `).run(reason, at, row.id)
      if (kind === 'review_fix') {
        database.prepare(`
          UPDATE review_status_commands
          SET state_tag = 'Superseded', reason = ?, worker_id = NULL,
            lease_expires_at = NULL, updated_at = ?
          WHERE task_kind = 'review_fix' AND task_id = ?
            AND state_tag IN ('Pending', 'Running')
        `).run(reason, at, row.id)
      }
      recordTransition(database, { taskId: row.id, from: row.state_tag, to: 'Superseded', reason, fence: row.fence, at })
      resolveTaskIncidents(database, row.id, at)
    }
  })
}

function planConflictResolution(
  database: DatabaseSync,
  subject: GitHubItem,
  subjectId: number,
  revisionId: string,
  observedAt: string,
  mapping: RepositoryMapping,
  reviewApproved: boolean,
): void {
  const eligible = subject.kind === 'pull_request'
    && subject.state === 'open'
    && !subject.draft
    && subject.mergeState === 'conflicting'
    && mapping.enabled
    && mapping.conflictResolution

  if (!eligible) {
    supersedeTasks(database, subjectId, observedAt, 'The pull request no longer needs conflict resolution.')
    return
  }

  supersedeTasks(database, subjectId, observedAt, 'A newer pull request head commit replaced this task.', revisionId)
  const existing = database.prepare(`
    SELECT id, state_tag, reason, fence, recovery_attempts,
      EXISTS (SELECT 1 FROM task_cancellations WHERE task_id = tasks.id) AS cancelled
    FROM tasks
    WHERE subject_id = ? AND kind = 'resolve_conflict' AND revision_id = ?
  `).get(subjectId, revisionId) as { id: string, state_tag: TaskRow['state_tag'], reason: string | null, fence: number, recovery_attempts: number, cancelled: number } | undefined
  // Recovery used to match two exact reasons collected from past incidents, so
  // every new transient failure left the conflict dead until someone added its
  // wording. The failure taxonomy decides instead: a transient failure can
  // succeed unchanged, and a permanent one still waits for a person.
  // Spending recovery budget is what stops a repeating transient failure from
  // spinning. One conflict task started twenty one agent turns on the same
  // unreadable worktree listing, because this path requeued it free of charge.
  // A pull request that conflicts again is not a failure and stays unbudgeted.
  const recoverableFailure = existing?.state_tag === 'Failed'
    && existing.reason !== null
    && existing.recovery_attempts < MAXIMUM_RECOVERY_ATTEMPTS
    && isTransientFailure({ message: existing.reason })
  if ((existing?.state_tag === 'Superseded' && existing.cancelled === 0) || recoverableFailure) {
    database.prepare(`
      UPDATE tasks
      SET state_tag = 'Queued', reason = NULL, attempts = 0, worker_id = NULL,
        command_id = NULL, lease_expires_at = NULL, updated_at = ?,
        recovery_attempts = recovery_attempts + ?
      WHERE id = ? AND state_tag = ?
    `).run(observedAt, recoverableFailure ? 1 : 0, existing.id, existing.state_tag)
    recordTransition(database, {
      taskId: existing.id,
      from: existing.state_tag,
      to: 'Queued',
      reason: recoverableFailure
        ? 'The previous conflict resolution failed for a transient reason.'
        : 'GitHub reports merge conflicts again.',
      fence: existing.fence,
      at: observedAt,
    })
    return
  }

  const canWriteHead = canWritePullRequestHead(mapping, subject)
  const canRepairHead = canRepairPullRequestHead(mapping, subject) && reviewApproved
  const ready = canWriteHead || canRepairHead
  if (existing?.state_tag === 'ActionRequired' && existing.cancelled === 0 && ready) {
    database.prepare(`
      UPDATE tasks
      SET state_tag = 'Queued', reason = NULL, attempts = 0, worker_id = NULL,
        command_id = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND state_tag = 'ActionRequired'
    `).run(observedAt, existing.id)
    recordTransition(database, {
      taskId: existing.id,
      from: 'ActionRequired',
      to: 'Queued',
      reason: 'The pull request head branch is now approved for conflict resolution.',
      fence: existing.fence,
      at: observedAt,
    })
    return
  }
  if (existing !== undefined)
    return

  const state: TaskState = ready
    ? { _tag: 'Queued' }
    : { _tag: 'ActionRequired', reason: 'The controller cannot write this pull request branch.' }
  const taskId = digest(`${mapping.github}:pull_request:${subject.number}:${revisionId}:resolve_conflict`)
  const reason = state._tag === 'ActionRequired' ? state.reason : null

  database.prepare(`
    INSERT INTO tasks (id, subject_id, revision_id, kind, state_tag, reason, updated_at)
    VALUES (?, ?, ?, 'resolve_conflict', ?, ?, ?)
  `).run(taskId, subjectId, revisionId, state._tag, reason, observedAt)
  recordTransition(database, { taskId, from: null, to: state._tag, reason, fence: 0, at: observedAt })
}

/**
 * What the controller may do with the exact findings one Review recorded.
 */
type ReviewFixPlan
  = | { _tag: 'Planned', taskId: string, rounds: { number: number, limit: number } }
    | { _tag: 'Refused', reason: string }

function openReviewFindings(database: DatabaseSync, subjectId: number, revisionId: string): Array<Extract<ReviewFinding, { _tag: 'Open' }>> {
  const row = database.prepare(`
    SELECT findings FROM review_runs
    WHERE subject_id = ? AND revision_id = ?
    ORDER BY completed_at DESC, id DESC
    LIMIT 1
  `).get(subjectId, revisionId) as { findings: string } | undefined
  return row === undefined
    ? []
    : (JSON.parse(row.findings) as ReviewFinding[]).filter((finding): finding is Extract<ReviewFinding, { _tag: 'Open' }> => finding._tag === 'Open')
}

/**
 * The chain of controller Repairs that produced the current head SHA, oldest first.
 *
 * Each published Repair commit names the Revision it repaired. That Revision's
 * head may itself be a Repair commit. The walk stops at the first head no
 * Repair published, which is a contributor commit, so a contributor push
 * always starts a fresh count.
 */
function reviewFixRounds(database: DatabaseSync, subjectId: number, headSha: string): RepairRound[] {
  const repairedBy = database.prepare(`
    SELECT tasks.id AS task_id, tasks.revision_id, publication_commands.commit_sha,
      json_extract(revisions.payload, '$.headSha') AS repaired_head_sha,
      repair_reports.summary, repair_reports.checks
    FROM publication_commands
    JOIN tasks ON tasks.id = publication_commands.task_id
    JOIN revisions ON revisions.id = tasks.revision_id
    LEFT JOIN repair_reports ON repair_reports.task_id = tasks.id
    WHERE tasks.subject_id = ? AND tasks.kind = 'review_fix'
      AND publication_commands.state_tag = 'Published'
      AND publication_commands.commit_sha = ?
    ORDER BY publication_commands.published_at DESC, publication_commands.id DESC
    LIMIT 1
  `)
  const rounds: RepairRound[] = []
  const seen = new Set<string>()
  let commitSha = headSha
  while (!seen.has(commitSha)) {
    seen.add(commitSha)
    const row = repairedBy.get(subjectId, commitSha) as {
      task_id: string
      revision_id: string
      commit_sha: string
      repaired_head_sha: string | null
      summary: string | null
      checks: string | null
    } | undefined
    if (row === undefined || row.repaired_head_sha === null)
      break
    rounds.unshift({
      number: 0,
      revisionId: row.revision_id,
      commitSha: row.commit_sha,
      summary: row.summary,
      checks: row.checks === null ? [] : JSON.parse(row.checks) as string[],
      findings: openReviewFindings(database, subjectId, row.revision_id).map(finding => finding.summary),
    })
    commitSha = row.repaired_head_sha
  }
  return rounds.map((round, index) => ({ ...round, number: index + 1 }))
}

function requeueReviewFix(
  database: DatabaseSync,
  existing: { id: string, state_tag: TaskRow['state_tag'], fence: number },
  reason: string,
  observedAt: string,
  rounds: { number: number, limit: number },
): ReviewFixPlan {
  database.prepare(`
    UPDATE tasks
    SET state_tag = 'Queued', reason = NULL, evidence = NULL, attempts = 0,
      worker_id = NULL, command_id = NULL, lease_expires_at = NULL,
      progress_percent = 0, progress_label = 'Starting', updated_at = ?
    WHERE id = ? AND state_tag = ?
  `).run(observedAt, existing.id, existing.state_tag)
  recordTransition(database, {
    taskId: existing.id,
    from: existing.state_tag,
    to: 'Queued',
    reason,
    fence: existing.fence,
    at: observedAt,
  })
  return { _tag: 'Planned', taskId: existing.id, rounds }
}

/**
 * Plans a fresh Repair Agent from one Review's exact open findings.
 */
function planReviewFix(
  database: DatabaseSync,
  subject: GitHubPullRequestItem,
  subjectId: number,
  revisionId: string,
  observedAt: string,
  mapping: RepositoryMapping,
): ReviewFixPlan {
  const refuse = (reason: string): ReviewFixPlan => {
    supersedeTasks(database, subjectId, observedAt, 'The pull request no longer has an approved repair.', undefined, 'review_fix')
    return { _tag: 'Refused', reason }
  }
  if (!mapping.enabled || !mapping.pullRequestReview)
    return refuse(REVIEW_REPAIR_REFUSALS.policy)
  if (subject.state !== 'open')
    return refuse(REVIEW_REPAIR_REFUSALS.closed)
  if (subject.draft)
    return refuse(REVIEW_REPAIR_REFUSALS.draft)
  if (subject.mergeState !== 'clean')
    return refuse(REVIEW_REPAIR_REFUSALS.conflict)
  if (!canRepairPullRequestHead(mapping, subject))
    return refuse(REVIEW_REPAIR_REFUSALS.branch)
  const reviewAuthorized = !requiresPullRequestApproval(database, mapping, subject.author) || database.prepare(`
    SELECT 1 FROM pull_request_approvals
    WHERE subject_id = ? AND revision_id = ? AND kind = 'review'
  `).get(subjectId, revisionId) !== undefined
  if (!reviewAuthorized)
    return refuse(REVIEW_REPAIR_REFUSALS.approval)
  const openFindings = openReviewFindings(database, subjectId, revisionId)
  const dismissal = openFindings.find(finding => finding.resolution === 'Dismissal')
  if (dismissal !== undefined)
    return refuse(`Review recommends Dismissal: ${cleanLine(dismissal.summary)}`)
  if (openFindings.length === 0)
    return refuse('The Review recorded no open finding to repair.')
  const round = planRepairRound(reviewFixRounds(database, subjectId, subject.headSha))
  if (round._tag === 'Exhausted')
    return refuse(round.reason)
  const rounds = { number: round.number, limit: REPAIR_ROUND_LIMIT }

  database.prepare(`
    INSERT OR IGNORE INTO pull_request_approvals (subject_id, revision_id, kind, approved_at)
    VALUES (?, ?, 'fixes', ?)
  `).run(subjectId, revisionId, observedAt)
  supersedeTasks(database, subjectId, observedAt, 'A newer pull request head commit replaced this repair.', revisionId, 'review_fix')

  const existing = database.prepare(`
    SELECT id, state_tag, fence,
      EXISTS (SELECT 1 FROM task_cancellations WHERE task_id = tasks.id) AS cancelled
    FROM tasks
    WHERE subject_id = ? AND kind = 'review_fix' AND revision_id = ?
  `).get(subjectId, revisionId) as { id: string, state_tag: TaskRow['state_tag'], fence: number, cancelled: number } | undefined
  if (existing === undefined) {
    const taskId = digest(`${mapping.github}:pull_request:${subject.number}:${revisionId}:review_fix`)
    database.prepare(`
      INSERT INTO tasks (id, subject_id, revision_id, kind, state_tag, reason, updated_at)
      VALUES (?, ?, ?, 'review_fix', 'Queued', NULL, ?)
    `).run(taskId, subjectId, revisionId, observedAt)
    recordTransition(database, { taskId, from: null, to: 'Queued', reason: null, fence: 0, at: observedAt })
    return { _tag: 'Planned', taskId, rounds }
  }
  if (existing.cancelled === 1)
    return { _tag: 'Refused', reason: REVIEW_REPAIR_REFUSALS.cancelled }
  if (existing.state_tag === 'Queued')
    return { _tag: 'Planned', taskId: existing.id, rounds }
  // A newer Review recorded exact findings for this same head commit.
  if (existing.state_tag === 'Superseded')
    return requeueReviewFix(database, existing, 'The exact pull request head commit is active again.', observedAt, rounds)
  if (existing.state_tag === 'Failed' || existing.state_tag === 'ActionRequired')
    return requeueReviewFix(database, existing, 'The review made a newer repair for this head commit.', observedAt, rounds)
  if (existing.state_tag === 'Completed')
    return { _tag: 'Refused', reason: REVIEW_REPAIR_REFUSALS.published }
  return { _tag: 'Refused', reason: REVIEW_REPAIR_REFUSALS.owned }
}

function supersedeWorkerTasks(
  database: DatabaseSync,
  subjectId: number,
  kind: 'adversarial_review' | 'issue_triage',
  at: string,
  reason: string,
  exceptRevisionId?: string,
): void {
  const rows = database.prepare(`
    SELECT id, state_tag, fence FROM worker_tasks
    WHERE subject_id = ? AND kind = ?
      AND state_tag IN ('Queued', 'ActionRequired', 'Running', 'Failed')
      AND (? IS NULL OR revision_id != ?)
  `).all(subjectId, kind, exceptRevisionId ?? null, exceptRevisionId ?? null) as unknown as Array<{
    id: string
    state_tag: 'Queued' | 'ActionRequired' | 'Running' | 'Failed'
    fence: number
  }>
  rows.forEach((row) => {
    const update = database.prepare(`
      UPDATE worker_tasks
      SET state_tag = 'Superseded', reason = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND state_tag = ?
    `).run(reason, at, row.id, row.state_tag)
    if (update.changes === 1) {
      recordWorkerTransition(database, { taskId: row.id, from: row.state_tag, to: 'Superseded', reason, fence: row.fence, at })
      resolveTaskIncidents(database, row.id, at)
    }
  })
}

function cancelStoredTask(database: DatabaseSync, taskId: string, at: string, reason: string): CancelTaskResult {
  if (database.prepare('SELECT 1 FROM task_cancellations WHERE task_id = ?').get(taskId) !== undefined)
    return { _tag: 'AlreadyCancelled' }

  const conflict = database.prepare('SELECT id, state_tag, fence FROM tasks WHERE id = ?').get(taskId) as {
    id: string
    state_tag: TaskRow['state_tag']
    fence: number
  } | undefined
  if (conflict !== undefined) {
    if (conflict.state_tag === 'Completed' || conflict.state_tag === 'Superseded')
      return { _tag: 'Rejected', reason: { _tag: 'TaskFinished' } }
    const publications = database.prepare(`
      SELECT id, state_tag, fence FROM publication_commands
      WHERE task_id = ? AND state_tag IN ('Pending', 'Running')
    `).all(taskId) as unknown as Array<{ id: string, state_tag: 'Pending' | 'Running', fence: number }>
    database.prepare(`
      UPDATE publication_commands
      SET state_tag = 'Superseded', reason = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE task_id = ? AND state_tag IN ('Pending', 'Running')
    `).run(reason, at, taskId)
    publications.forEach(command => recordPublicationEvent(database, {
      commandId: command.id,
      from: command.state_tag,
      to: 'Superseded',
      reason,
      fence: command.fence,
      at,
    }))
    database.prepare(`
      UPDATE review_status_commands
      SET state_tag = 'Superseded', reason = ?, worker_id = NULL,
        lease_expires_at = NULL, updated_at = ?
      WHERE task_kind = 'review_fix' AND task_id = ?
        AND state_tag IN ('Pending', 'Running')
    `).run(reason, at, taskId)
    database.prepare(`
      UPDATE tasks
      SET state_tag = 'Superseded', reason = ?, worker_id = NULL, command_id = NULL,
        lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND state_tag = ?
    `).run(reason, at, taskId, conflict.state_tag)
    recordTransition(database, { taskId, from: conflict.state_tag, to: 'Superseded', reason, fence: conflict.fence, at })
  }
  else {
    const worker = database.prepare('SELECT id, state_tag, fence FROM worker_tasks WHERE id = ?').get(taskId) as {
      id: string
      state_tag: Exclude<TaskRow['state_tag'], 'Publishing'>
      fence: number
    } | undefined
    if (worker === undefined)
      return { _tag: 'Rejected', reason: { _tag: 'TaskNotFound' } }
    if (worker.state_tag === 'Completed' || worker.state_tag === 'Superseded')
      return { _tag: 'Rejected', reason: { _tag: 'TaskFinished' } }
    database.prepare(`
      UPDATE review_status_commands
      SET state_tag = 'Superseded', reason = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE task_kind = 'adversarial_review' AND task_id = ?
        AND state_tag IN ('Pending', 'Running')
    `).run(reason, at, taskId)
    database.prepare(`
      UPDATE issue_triage_comment_commands
      SET state_tag = 'Superseded', reason = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE task_id = ? AND state_tag IN ('Pending', 'Running')
    `).run(reason, at, taskId)
    database.prepare(`
      UPDATE worker_tasks
      SET state_tag = 'Superseded', reason = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE id = ? AND state_tag = ?
    `).run(reason, at, taskId, worker.state_tag)
    recordWorkerTransition(database, { taskId, from: worker.state_tag, to: 'Superseded', reason, fence: worker.fence, at })
  }

  database.prepare('INSERT INTO task_cancellations (task_id, cancelled_at, reason) VALUES (?, ?, ?)')
    .run(taskId, at, reason)
  return { _tag: 'Cancelled' }
}

function cancelSubjectTasks(database: DatabaseSync, subjectId: number, at: string, reason: string): void {
  const taskIds = database.prepare(`
    SELECT id FROM tasks
    WHERE subject_id = ? AND state_tag IN ('Queued', 'ActionRequired', 'Running', 'Publishing', 'Failed')
    UNION ALL
    SELECT id FROM worker_tasks
    WHERE subject_id = ? AND state_tag IN ('Queued', 'ActionRequired', 'Running', 'Failed')
  `).all(subjectId, subjectId) as unknown as Array<{ id: string }>
  taskIds.forEach(task => cancelStoredTask(database, task.id, at, reason))
}

function planAdversarialReview(
  database: DatabaseSync,
  subject: GitHubItem,
  subjectId: number,
  revisionId: string,
  observedAt: string,
  mapping: RepositoryMapping,
  reviewApproved: boolean,
  manualReviewRequested: boolean,
): void {
  const approvalRequired = subject.kind === 'pull_request' && requiresPullRequestApproval(database, mapping, subject.author)
  const rerunRequested = database.prepare(`
    SELECT 1 FROM review_rerun_requests
    JOIN worker_tasks ON worker_tasks.id = review_rerun_requests.task_id
    WHERE worker_tasks.subject_id = ? AND worker_tasks.revision_id = ?
      AND worker_tasks.kind = 'adversarial_review'
    LIMIT 1
  `).get(subjectId, revisionId) !== undefined
  const localAttempt = database.prepare(`
    SELECT
      EXISTS (SELECT 1 FROM review_runs WHERE subject_id = ?) AS any_attempt,
      EXISTS (SELECT 1 FROM review_runs WHERE subject_id = ? AND revision_id = ?) AS revision_attempt,
      (SELECT review_runs.id FROM review_runs
        JOIN review_evidence_scopes ON review_evidence_scopes.review_run_id = review_runs.id
        WHERE review_runs.subject_id = ? AND review_runs.head_sha = ?
          AND review_runs.kind = 'adversarial_review'
          AND review_evidence_scopes.policy_digest = ?
        ORDER BY review_runs.completed_at DESC, review_runs.id DESC LIMIT 1) AS head_review_run_id
  `).get(
    subjectId,
    subjectId,
    revisionId,
    subjectId,
    subject.kind === 'pull_request' ? subject.headSha : '',
    digest(JSON.stringify(mapping)),
  ) as {
    any_attempt: number
    revision_attempt: number
    head_review_run_id: string | null
  }
  const priorComplete = subject.kind === 'pull_request'
    && subject.priorAutomatedReview._tag === 'Found'
    && subject.priorAutomatedReview.state === 'complete'
  const alreadyReviewed = subject.kind === 'pull_request'
    && (localAttempt.head_review_run_id !== null || (priorComplete && localAttempt.any_attempt === 0))
    && !rerunRequested
    && !(manualReviewRequested && localAttempt.revision_attempt === 0)
  const reviewable = subject.kind === 'pull_request'
    && subject.state === 'open'
    && !subject.draft
    && mapping.enabled
    && mapping.pullRequestReview
    && !alreadyReviewed
    && (!approvalRequired || reviewApproved)

  // GitHub computes mergeability lazily, so a poll seconds after a push reads
  // unknown on a pull request that is otherwise ready. That is not yet, not
  // never: superseding here turns a transient GitHub state into a stopped
  // review that only a human rerun can restart. Leave the tasks alone and let
  // the next observation decide.
  if (reviewable && subject.mergeState === 'unknown')
    return

  const eligible = reviewable && subject.mergeState === 'clean'

  if (alreadyReviewed && subject.kind === 'pull_request' && subject.priorAutomatedReview._tag === 'Found') {
    const stored = database.prepare(`
      INSERT INTO review_resolutions (
        subject_id, revision_id, task_id, task_fence, resolution_tag,
        review_run_id, baseline_task_id, github_url, reason, created_at
      ) VALUES (?, ?, NULL, 0, 'ExistingReview', NULL, NULL, ?, NULL, ?)
      ON CONFLICT(subject_id, revision_id) DO UPDATE SET
        task_id = NULL, task_fence = 0, resolution_tag = 'ExistingReview',
        review_run_id = NULL, baseline_task_id = NULL, github_url = excluded.github_url,
        reason = NULL, created_at = excluded.created_at
      WHERE review_resolutions.resolution_tag = 'UnknownNeedsReconciliation'
    `).run(subjectId, revisionId, subject.priorAutomatedReview.url, observedAt)
    if (stored.changes === 1) {
      recordWorkflowEvent(database, {
        stream: 'review_resolution',
        event: 'Recorded',
        entityId: `${subjectId}:${revisionId}`,
        repository: mapping.github,
        itemNumber: subject.number,
        revisionId,
        from: null,
        to: 'ExistingReview',
        at: observedAt,
      })
    }
  }
  else if (alreadyReviewed && localAttempt.head_review_run_id !== null) {
    const stored = database.prepare(`
      INSERT INTO review_resolutions (
        subject_id, revision_id, task_id, task_fence, resolution_tag,
        review_run_id, baseline_task_id, github_url, reason, created_at
      ) VALUES (?, ?, NULL, 0, 'Reviewed', ?, NULL, NULL, NULL, ?)
      ON CONFLICT(subject_id, revision_id) DO NOTHING
    `).run(subjectId, revisionId, localAttempt.head_review_run_id, observedAt)
    if (stored.changes === 1) {
      recordWorkflowEvent(database, {
        stream: 'review_resolution',
        event: 'Reused',
        entityId: `${subjectId}:${revisionId}`,
        repository: mapping.github,
        itemNumber: subject.number,
        revisionId,
        from: null,
        to: 'Reviewed',
        at: observedAt,
      })
    }
  }

  if (!eligible) {
    supersedeWorkerTasks(
      database,
      subjectId,
      'adversarial_review',
      observedAt,
      alreadyReviewed
        ? 'The current head commit already has an automated review.'
        : 'The pull request is not ready for review.',
    )
    return
  }

  supersedeWorkerTasks(database, subjectId, 'adversarial_review', observedAt, 'A newer pull request head commit replaced this review.', revisionId)
  const existing = database.prepare(`
    SELECT id, state_tag, reason, fence, recovery_attempts FROM worker_tasks
    WHERE subject_id = ? AND kind = 'adversarial_review' AND revision_id = ?
  `).get(subjectId, revisionId) as { id: string, state_tag: TaskRow['state_tag'], reason: string | null, fence: number, recovery_attempts: number } | undefined
  // The failure taxonomy decides, never a list of exact wordings. The list this
  // replaces was collected from past incidents, so rewording any one of those
  // messages silently left a recoverable review dead until someone noticed.
  const recoverableFailure = existing?.state_tag === 'Failed'
    && existing.reason !== null
    && existing.recovery_attempts < MAXIMUM_RECOVERY_ATTEMPTS
    && isTransientFailure({ message: existing.reason })
  if (recoverableFailure) {
    database.prepare(`
      UPDATE worker_tasks
      SET state_tag = 'Queued', reason = NULL, attempts = 0, worker_id = NULL,
        lease_expires_at = NULL, updated_at = ?, recovery_attempts = recovery_attempts + 1
      WHERE id = ? AND state_tag = 'Failed'
    `).run(observedAt, existing.id)
    recordWorkerTransition(database, { taskId: existing.id, from: 'Failed', to: 'Queued', reason: 'Retrying a recoverable review failure.', fence: existing.fence, at: observedAt })
    return
  }
  if (existing?.state_tag === 'Completed' && manualReviewRequested && localAttempt.revision_attempt === 0) {
    database.prepare(`
      UPDATE worker_tasks
      SET state_tag = 'Queued', reason = NULL, evidence = NULL, attempts = 0,
        worker_id = NULL, lease_expires_at = NULL, progress_percent = 0,
        progress_label = 'Starting', updated_at = ?
      WHERE id = ? AND state_tag = 'Completed'
    `).run(observedAt, existing.id)
    recordWorkerTransition(database, {
      taskId: existing.id,
      from: 'Completed',
      to: 'Queued',
      reason: 'The manual Review label overrode pull request triage.',
      fence: existing.fence,
      at: observedAt,
    })
    return
  }
  if (existing?.state_tag === 'Completed' && localAttempt.revision_attempt === 1 && localAttempt.head_review_run_id === null) {
    database.prepare(`
      UPDATE worker_tasks
      SET state_tag = 'Queued', reason = NULL, evidence = NULL, attempts = 0,
        worker_id = NULL, lease_expires_at = NULL, progress_percent = 0,
        progress_label = 'Starting', updated_at = ?
      WHERE id = ? AND state_tag = 'Completed'
    `).run(observedAt, existing.id)
    database.prepare('DELETE FROM review_resolutions WHERE subject_id = ? AND revision_id = ?')
      .run(subjectId, revisionId)
    recordWorkerTransition(database, {
      taskId: existing.id,
      from: 'Completed',
      to: 'Queued',
      reason: 'Trusted Review policy changed.',
      fence: existing.fence,
      at: observedAt,
    })
    return
  }
  const completedBaseline = subject.kind === 'pull_request' && existing?.state_tag === 'Completed' && localAttempt.revision_attempt === 0
    ? database.prepare(`
        SELECT tasks.id, tasks.fence
        FROM tasks
        WHERE tasks.subject_id = ? AND tasks.revision_id = ?
          AND tasks.kind = 'baseline_repair' AND tasks.state_tag = 'Completed'
          AND NOT EXISTS (
            SELECT 1
            FROM subjects AS repair_subjects
            JOIN repositories AS repair_repositories ON repair_repositories.id = repair_subjects.repository_id
            JOIN revisions AS repair_revisions ON repair_revisions.id = repair_subjects.current_revision_id
            WHERE repair_repositories.github = ? AND repair_subjects.kind = 'pull_request'
              AND json_extract(repair_revisions.payload, '$.state') = 'open'
              AND json_extract(repair_revisions.payload, '$.purpose._tag') = 'BaselineRepair'
              AND lower(substr(?, 1, length(json_extract(repair_revisions.payload, '$.purpose.baseShaPrefix'))))
                = lower(json_extract(repair_revisions.payload, '$.purpose.baseShaPrefix'))
          )
        LIMIT 1
      `).get(subjectId, revisionId, mapping.github, subject.baseSha) as { id: string, fence: number } | undefined
    : undefined
  if (completedBaseline !== undefined && existing !== undefined) {
    const reason = 'GitHub reports no open Baseline repair for this base commit.'
    database.prepare(`
      UPDATE tasks SET state_tag = 'Superseded', reason = ?, evidence = NULL, updated_at = ?
      WHERE id = ? AND state_tag = 'Completed'
    `).run(reason, observedAt, completedBaseline.id)
    recordTransition(database, { taskId: completedBaseline.id, from: 'Completed', to: 'Superseded', reason, fence: completedBaseline.fence, at: observedAt })
    database.prepare(`
      UPDATE worker_tasks
      SET state_tag = 'Queued', reason = NULL, evidence = NULL, attempts = 0,
        worker_id = NULL, lease_expires_at = NULL, progress_percent = 0,
        progress_label = 'Starting', updated_at = ?
      WHERE id = ? AND state_tag = 'Completed'
    `).run(observedAt, existing.id)
    recordWorkerTransition(database, { taskId: existing.id, from: 'Completed', to: 'Queued', reason: 'Recovering from current GitHub state.', fence: existing.fence, at: observedAt })
    return
  }
  if (existing !== undefined)
    return

  const taskId = digest(`${mapping.github}:pull_request:${subject.number}:${revisionId}:adversarial_review`)
  database.prepare(`
    INSERT INTO worker_tasks (id, subject_id, revision_id, kind, state_tag, updated_at)
    VALUES (?, ?, ?, 'adversarial_review', 'Queued', ?)
  `).run(taskId, subjectId, revisionId, observedAt)
  recordWorkerTransition(database, { taskId, from: null, to: 'Queued', reason: null, fence: 0, at: observedAt })
}

function planIssueTriage(
  database: DatabaseSync,
  subject: GitHubItem,
  subjectId: number,
  revisionId: string,
  observedAt: string,
  mapping: RepositoryMapping,
): void {
  const routineTrackingIssue = subject.kind === 'issue' && (
    subject.routineTracking === true
    || database.prepare(`
      SELECT 1 FROM routines WHERE repository = ? AND tracking_issue_number = ?
    `).get(subject.repository, subject.number) !== undefined
  )
  const eligible = subject.kind === 'issue'
    && subject.state === 'open'
    && !routineTrackingIssue
    && canWorkIssues(mapping)
  if (!eligible) {
    supersedeWorkerTasks(database, subjectId, 'issue_triage', observedAt, 'The issue no longer needs triage.')
    supersedeTasks(database, subjectId, observedAt, 'The issue no longer authorizes work.', undefined, 'issue_work')
    return
  }

  supersedeWorkerTasks(database, subjectId, 'issue_triage', observedAt, 'Updated issue state replaced this triage.', revisionId)
  supersedeTasks(database, subjectId, observedAt, 'Updated issue state replaced this work.', revisionId, 'issue_work')
  const existing = database.prepare(`
    SELECT id, state_tag, evidence FROM worker_tasks
    WHERE subject_id = ? AND kind = 'issue_triage' AND revision_id = ?
  `).get(subjectId, revisionId) as { id: string, state_tag: TaskRow['state_tag'], evidence: string | null } | undefined
  if (existing !== undefined) {
    if (
      existing.state_tag === 'Completed'
      && existing.evidence !== null
      && issueTriageState(existing.evidence) === 'READY_TO_IMPLEMENT'
      && subject.kind === 'issue'
      && canWorkIssues(mapping)
      && !requiresIssueApproval(mapping, subject.author)
    ) {
      queueIssueWork(database, subjectId, revisionId, subject, mapping, observedAt)
    }
    return
  }

  const taskId = digest(`${mapping.github}:issue:${subject.number}:${revisionId}:issue_triage`)
  database.prepare(`
    INSERT INTO worker_tasks (id, subject_id, revision_id, kind, state_tag, updated_at)
    VALUES (?, ?, ?, 'issue_triage', 'Queued', ?)
  `).run(taskId, subjectId, revisionId, observedAt)
  recordWorkerTransition(database, { taskId, from: null, to: 'Queued', reason: null, fence: 0, at: observedAt })
}

function queueIssueWork(
  database: DatabaseSync,
  subjectId: number,
  revisionId: string,
  issue: Extract<GitHubItem, { kind: 'issue' }>,
  mapping: RepositoryMapping,
  at: string,
): { inserted: boolean, taskId: string } {
  const taskId = digest(`${mapping.github}:issue:${issue.number}:${revisionId}:issue_work`)
  let inserted = database.prepare(`
    INSERT OR IGNORE INTO tasks (id, subject_id, revision_id, kind, state_tag, updated_at)
    VALUES (?, ?, ?, 'issue_work', 'Queued', ?)
  `).run(taskId, subjectId, revisionId, at).changes === 1
  let resumed = false
  if (!inserted) {
    const existing = database.prepare(`
      SELECT state_tag, reason, fence FROM tasks WHERE id = ? AND kind = 'issue_work'
    `).get(taskId) as { state_tag: TaskRow['state_tag'], reason: string | null, fence: number } | undefined
    if (existing?.state_tag === 'Superseded' && existing.reason === freshIssueTriageReason) {
      inserted = database.prepare(`
        UPDATE tasks
        SET state_tag = 'Queued', reason = NULL, evidence = NULL, attempts = 0,
          worker_id = NULL, command_id = NULL, lease_expires_at = NULL,
          progress_percent = 0, progress_label = 'Starting', updated_at = ?
        WHERE id = ? AND state_tag = 'Superseded' AND reason = ?
      `).run(at, taskId, freshIssueTriageReason).changes === 1
      if (inserted) {
        resumed = true
        recordTransition(database, {
          taskId,
          from: 'Superseded',
          to: 'Queued',
          reason: 'Fresh issue triage was approved.',
          fence: existing.fence,
          at,
        })
      }
    }
  }
  if (inserted && !resumed)
    recordTransition(database, { taskId, from: null, to: 'Queued', reason: null, fence: 0, at })
  return { inserted, taskId }
}

/**
 * Stores whether the Agent selection is pinned or follows the configuration.
 *
 * Version 25 required a provider, so a pinned selection could never go back to
 * the configuration file. The tag makes both states storable, and the CHECK
 * keeps a provider and the tag from disagreeing.
 */
const followsConfigurationSelectionMigration = `
  CREATE TABLE agent_selection_v27 (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    tag TEXT NOT NULL CHECK (tag IN ('FollowsConfiguration', 'Pinned')),
    provider TEXT CHECK (provider IN ('codex', 'opencode')),
    model TEXT,
    reasoning_effort TEXT,
    updated_at TEXT NOT NULL,
    CHECK ((tag = 'Pinned') = (provider IS NOT NULL))
  );

  INSERT INTO agent_selection_v27 (singleton, tag, provider, model, reasoning_effort, updated_at)
  SELECT singleton, 'Pinned', provider, model, reasoning_effort, updated_at FROM agent_selection;

  DROP TABLE agent_selection;
  ALTER TABLE agent_selection_v27 RENAME TO agent_selection;
  PRAGMA user_version = 27;
`

const reviewUsageMigration = `
  ALTER TABLE review_runs ADD COLUMN usage TEXT NOT NULL DEFAULT '{"_tag":"Unavailable"}' CHECK (json_valid(usage));

  DROP INDEX IF EXISTS review_status_commands_state;
  CREATE TABLE review_status_commands_v31 (
    id TEXT PRIMARY KEY,
    task_kind TEXT NOT NULL CHECK (task_kind IN ('adversarial_review', 'review_fix')),
    task_id TEXT NOT NULL,
    task_fence INTEGER NOT NULL,
    revision_id TEXT NOT NULL REFERENCES revisions(id),
    expected_head_sha TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('snapshot', 'review', 'repair', 'terminal')),
    body TEXT NOT NULL,
    body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Pending', 'Running', 'Published', 'Superseded')),
    outcome_unknown INTEGER NOT NULL DEFAULT 0 CHECK (outcome_unknown IN (0, 1)),
    reason TEXT,
    github_comment_id INTEGER,
    github_url TEXT,
    worker_id TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (task_kind, task_id, task_fence, phase, body_sha256),
    CHECK (
      (task_kind = 'adversarial_review' AND phase IN ('snapshot', 'review', 'terminal'))
      OR (task_kind = 'review_fix' AND phase IN ('repair', 'terminal'))
    ),
    CHECK (
      (state_tag = 'Running' AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state_tag != 'Running' AND worker_id IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (
      (state_tag = 'Published' AND github_comment_id IS NOT NULL AND github_url IS NOT NULL)
      OR state_tag != 'Published'
    )
  );
  INSERT INTO review_status_commands_v31 SELECT * FROM review_status_commands;
  DROP TABLE review_status_commands;
  ALTER TABLE review_status_commands_v31 RENAME TO review_status_commands;
  CREATE INDEX review_status_commands_state ON review_status_commands(state_tag, updated_at);
  PRAGMA user_version = 31;
`

/**
 * Adds the queued phase to the canonical review comment.
 *
 * A Task can wait hours behind other Tasks. The comment it already owns went on
 * claiming a review was under way the whole time, so a person read progress
 * where there was none. The comment now states the Queue position instead, and
 * that publication needs a phase of its own to be recorded under.
 *
 * The Approval prompt is recorded for the same reason. It asks a person to add
 * a label, and it went on asking after they added it, because no Task existed
 * yet to own that comment and nothing else ever came back to correct it.
 */
const queuedReviewStatusMigration = `
  DROP INDEX IF EXISTS review_status_commands_state;
  CREATE TABLE review_status_commands_v32 (
    id TEXT PRIMARY KEY,
    task_kind TEXT NOT NULL CHECK (task_kind IN ('adversarial_review', 'review_fix')),
    task_id TEXT NOT NULL,
    task_fence INTEGER NOT NULL,
    revision_id TEXT NOT NULL REFERENCES revisions(id),
    expected_head_sha TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('snapshot', 'review', 'repair', 'terminal', 'queued')),
    body TEXT NOT NULL,
    body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Pending', 'Running', 'Published', 'Superseded')),
    outcome_unknown INTEGER NOT NULL DEFAULT 0 CHECK (outcome_unknown IN (0, 1)),
    reason TEXT,
    github_comment_id INTEGER,
    github_url TEXT,
    worker_id TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (task_kind, task_id, task_fence, phase, body_sha256),
    CHECK (
      (task_kind = 'adversarial_review' AND phase IN ('snapshot', 'review', 'terminal', 'queued'))
      OR (task_kind = 'review_fix' AND phase IN ('repair', 'terminal', 'queued'))
    ),
    CHECK (
      (state_tag = 'Running' AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state_tag != 'Running' AND worker_id IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (
      (state_tag = 'Published' AND github_comment_id IS NOT NULL AND github_url IS NOT NULL)
      OR state_tag != 'Published'
    )
  );
  INSERT INTO review_status_commands_v32 SELECT * FROM review_status_commands;
  DROP TABLE review_status_commands;
  ALTER TABLE review_status_commands_v32 RENAME TO review_status_commands;
  CREATE INDEX review_status_commands_state ON review_status_commands(state_tag, updated_at);

  DROP TABLE IF EXISTS approval_prompt_comments;
  CREATE TABLE approval_prompt_comments (
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    revision_id TEXT NOT NULL REFERENCES revisions(id),
    github_comment_id INTEGER NOT NULL,
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (subject_id, revision_id)
  );
  PRAGMA user_version = 32;
`

/**
 * Gives mutation Tasks one fresh recovery after removing the unconditional
 * Workflow permission from ordinary branch writes.
 *
 * The old token request exhausted these Tasks before an Agent could inspect
 * their patch. A real missing permission can still spend this one new bounded
 * recovery and return to Action required.
 */
const narrowPublicationPermissionMigration = `
  UPDATE incidents
  SET resolved_at = last_seen_at
  WHERE resolved_at IS NULL
    AND scope_tag = 'Task'
    AND task_id IN (
      SELECT id FROM tasks
      WHERE state_tag = 'Failed'
        AND reason LIKE '%permissions requested are not granted to this installation%'
    );

  UPDATE tasks
  SET recovery_attempts = 0
  WHERE state_tag = 'Failed'
    AND reason LIKE '%permissions requested are not granted to this installation%';

  PRAGMA user_version = 33;
`

const repairDisputeRerunMigration = `
  ALTER TABLE review_rerun_requests RENAME TO review_rerun_requests_v33;
  CREATE TABLE review_rerun_requests (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES worker_tasks(id),
    source TEXT NOT NULL CHECK (source IN ('dashboard', 'github_comment', 'repair_dispute')),
    requested_by TEXT NOT NULL,
    requested_at TEXT NOT NULL
  );
  INSERT INTO review_rerun_requests (id, task_id, source, requested_by, requested_at)
    SELECT id, task_id, source, requested_by, requested_at FROM review_rerun_requests_v33;
  DROP TABLE review_rerun_requests_v33;
  CREATE INDEX review_rerun_requests_task ON review_rerun_requests(task_id, requested_at);
  PRAGMA user_version = 34;
`

/**
 * Gives Tasks exhausted by one poisoned provider session a fresh recovery.
 *
 * Retries now start a fresh Agent session after the first claim. These old
 * Tasks exhausted their recovery budget before that boundary existed.
 */
const freshProviderSessionMigration = `
  UPDATE incidents
  SET resolved_at = last_seen_at
  WHERE resolved_at IS NULL
    AND ((scope_tag = 'Task' AND task_id IN (
        SELECT id FROM worker_tasks
        WHERE state_tag = 'Failed'
          AND reason = 'The opencode session stopped sending output.'
        UNION ALL
        SELECT id FROM tasks
        WHERE state_tag = 'Failed'
          AND reason = 'The opencode session stopped sending output.'
      ))
      OR (scope_tag = 'Service'
        AND kind = 'agent_provider'
        AND message = 'The opencode session stopped sending output.'));

  UPDATE worker_tasks
  SET recovery_attempts = 0
  WHERE state_tag = 'Failed'
    AND reason = 'The opencode session stopped sending output.';

  UPDATE tasks
  SET recovery_attempts = 0
  WHERE state_tag = 'Failed'
    AND reason = 'The opencode session stopped sending output.';

  PRAGMA user_version = 35;
`

/** Adds the GitHub-derived purpose to pull request Revisions. */
const pullRequestPurposeMigration = `
  UPDATE revisions
  SET payload = json_set(payload, '$.purpose', json('{"_tag":"Change"}'))
  WHERE json_extract(payload, '$.kind') = 'pull_request'
    AND json_type(payload, '$.purpose') IS NULL;

  PRAGMA user_version = 36;
`

/**
 * Adds automatic Agent selection and the provider preference order it walks.
 *
 * Version 27 stored a pinned provider or nothing. Automatic selection stores
 * neither: it stores the order to walk, and reads capacity at every turn. The
 * two CHECKs keep a tag and its own column from disagreeing, so no row can say
 * automatic while naming a single pinned provider.
 */
const automaticAgentSelectionMigration = `
  CREATE TABLE agent_selection_v37 (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    tag TEXT NOT NULL CHECK (tag IN ('FollowsConfiguration', 'Pinned', 'Automatic')),
    provider TEXT CHECK (provider IN ('codex', 'opencode')),
    model TEXT,
    reasoning_effort TEXT,
    provider_order TEXT CHECK (provider_order IS NULL OR json_valid(provider_order)),
    updated_at TEXT NOT NULL,
    CHECK ((tag = 'Pinned') = (provider IS NOT NULL)),
    CHECK ((tag = 'Automatic') = (provider_order IS NOT NULL))
  );

  INSERT INTO agent_selection_v37 (singleton, tag, provider, model, reasoning_effort, provider_order, updated_at)
  SELECT singleton, tag, provider, model, reasoning_effort, NULL, updated_at FROM agent_selection;

  DROP TABLE agent_selection;
  ALTER TABLE agent_selection_v37 RENAME TO agent_selection;
  PRAGMA user_version = 37;
`

/**
 * Adds Routines, their runs, and the Candidate ledger.
 *
 * A Routine answers a clock, so it has no Item and no Revision. `worker_tasks`
 * requires both, which is why these are their own tables rather than another
 * Task kind hung off a synthetic Item.
 *
 * Two unique constraints carry the design:
 *
 * `routine_runs (routine_id, scheduled_for)` makes a backlog unrepresentable.
 * A machine asleep for two days can only ever insert one run per cron instant,
 * so waking up runs a Routine once instead of ninety-six times.
 *
 * `candidates (routine_id, fingerprint)` makes a repeated proposal
 * unrepresentable. A Candidate Harlan rejected cannot be inserted a second
 * time, so the rejection memory is a constraint and not a query someone has to
 * remember to write.
 */
const routineMigration = `
  CREATE TABLE routines (
    id TEXT PRIMARY KEY,
    repository TEXT NOT NULL,
    name TEXT NOT NULL,
    crons TEXT NOT NULL CHECK (json_valid(crons)),
    time_zone TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('report', 'propose')),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    spec_sha TEXT NOT NULL,
    last_run_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE (repository, name)
  );

  CREATE TABLE routine_runs (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    scheduled_for TEXT NOT NULL,
    spec_sha TEXT NOT NULL,
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Queued', 'Running', 'Completed', 'Failed', 'Skipped', 'ActionRequired', 'Superseded')),
    reason TEXT,
    evidence TEXT,
    worker_id TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (routine_id, scheduled_for),
    CHECK (
      (state_tag = 'Running' AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state_tag != 'Running' AND worker_id IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (state_tag != 'Completed' OR evidence IS NOT NULL),
    CHECK (state_tag NOT IN ('Failed', 'Skipped', 'ActionRequired', 'Superseded') OR reason IS NOT NULL)
  );

  CREATE INDEX routine_runs_state ON routine_runs(state_tag, updated_at);

  CREATE TABLE candidates (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES routine_runs(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    target TEXT NOT NULL,
    claim TEXT NOT NULL,
    verification TEXT NOT NULL,
    estimated_changed_files INTEGER NOT NULL,
    result_tag TEXT NOT NULL CHECK (result_tag IN ('Proposed', 'Merged', 'Rejected', 'Superseded')),
    reason TEXT,
    pull_request INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (routine_id, fingerprint),
    CHECK (result_tag NOT IN ('Rejected', 'Superseded') OR reason IS NOT NULL),
    CHECK (result_tag != 'Merged' OR pull_request IS NOT NULL)
  );

  CREATE INDEX candidates_routine ON candidates(routine_id, result_tag);

  PRAGMA user_version = 38;
`

/**
 * Lets a Publication command belong to a Routine run as well as a Task.
 *
 * Publication was bound to `tasks(id)`, and `tasks.subject_id` is NOT NULL, so
 * a Routine run could never own one. A Routine answers a clock and has no
 * Item, which is the third place that assumption has surfaced after agent
 * sessions and progress.
 *
 * Both owners keep a real foreign key rather than sharing one column behind a
 * discriminator string. The CHECK then makes "exactly one owner" a constraint,
 * so a command owned by both or by neither cannot be written at all.
 */
const polymorphicPublicationMigration = `
  DROP INDEX IF EXISTS publication_commands_state_tag;
  DROP INDEX IF EXISTS one_live_publication_command_per_task;

  CREATE TABLE publication_commands_v39 (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES tasks(id),
    routine_run_id TEXT REFERENCES routine_runs(id),
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Pending', 'Running', 'Published', 'Failed', 'Superseded')),
    commit_sha TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    base_ref TEXT NOT NULL CHECK (base_ref != ''),
    expected_head_sha TEXT NOT NULL,
    head_ref TEXT NOT NULL,
    artifact_ref TEXT NOT NULL,
    patch_digest TEXT NOT NULL,
    changed_files INTEGER NOT NULL CHECK (changed_files >= 0),
    outcome_unknown INTEGER NOT NULL DEFAULT 0 CHECK (outcome_unknown IN (0, 1)),
    reason TEXT,
    worker_id TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_expires_at TEXT,
    published_at TEXT,
    updated_at TEXT NOT NULL,
    pull_request_title TEXT,
    pull_request_body TEXT,
    -- Exactly one owner. Never both, never neither.
    CHECK ((task_id IS NULL) != (routine_run_id IS NULL)),
    -- A pull request cannot merge into itself, so a stack can never name its own head.
    CHECK (base_ref != head_ref),
    CHECK (
      (state_tag = 'Running' AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state_tag != 'Running' AND worker_id IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (state_tag NOT IN ('Failed', 'Superseded') OR reason IS NOT NULL),
    CHECK (state_tag != 'Published' OR published_at IS NOT NULL)
  );

  INSERT INTO publication_commands_v39 (
    id, task_id, routine_run_id, state_tag, commit_sha, base_sha, base_ref, expected_head_sha,
    head_ref, artifact_ref, patch_digest, changed_files, outcome_unknown, reason, worker_id,
    fence, attempts, max_attempts, lease_expires_at, published_at, updated_at,
    pull_request_title, pull_request_body
  )
  SELECT
    id, task_id, NULL, state_tag, commit_sha, base_sha, base_ref, expected_head_sha,
    head_ref, artifact_ref, patch_digest, changed_files, outcome_unknown, reason, worker_id,
    fence, attempts, max_attempts, lease_expires_at, published_at, updated_at,
    pull_request_title, pull_request_body
  FROM publication_commands;

  DROP TABLE publication_commands;
  ALTER TABLE publication_commands_v39 RENAME TO publication_commands;

  CREATE INDEX publication_commands_state_tag ON publication_commands(state_tag);
  CREATE UNIQUE INDEX one_live_publication_command_per_task
    ON publication_commands(task_id)
    WHERE task_id IS NOT NULL AND state_tag IN ('Pending', 'Running', 'Published');
  CREATE UNIQUE INDEX one_live_publication_command_per_routine_run
    ON publication_commands(routine_run_id)
    WHERE routine_run_id IS NOT NULL AND state_tag IN ('Pending', 'Running', 'Published');

  PRAGMA user_version = 39;
`

/**
 * Adds the command that files one issue for one Candidate.
 *
 * A Routine proposes work by opening an issue, so the pipeline that already
 * turns an issue into a reviewed pull request does the rest. That is why this
 * is a small command table and not a second publication stack.
 *
 * One command per Candidate, enforced by the unique key. A Candidate is already
 * unique per Routine, so a retry can never file the same proposal twice.
 */
const candidateIssueMigration = `
  CREATE TABLE candidate_issue_commands (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    repository TEXT NOT NULL,
    routine_name TEXT NOT NULL,
    title TEXT NOT NULL CHECK (title != ''),
    body TEXT NOT NULL CHECK (body != ''),
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Pending', 'Running', 'Published', 'Failed')),
    reason TEXT,
    github_issue_number INTEGER,
    github_url TEXT,
    worker_id TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (candidate_id),
    CHECK (
      (state_tag = 'Running' AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state_tag != 'Running' AND worker_id IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (state_tag != 'Failed' OR reason IS NOT NULL),
    CHECK (state_tag != 'Published' OR (github_issue_number IS NOT NULL AND github_url IS NOT NULL))
  );

  CREATE INDEX candidate_issue_commands_state ON candidate_issue_commands(state_tag, updated_at);

  PRAGMA user_version = 40;
`

/**
 * Lets a Review run keep the agent's confidence score whatever the gates say.
 *
 * The score answers how sure the agent was about the change it read. The
 * outcome answers whether every gate passed. Storing one only when the other
 * said Ready threw the score away for a Review that waited on CI, and the CI
 * re-gate then had nothing to publish once the base branch turned green.
 */
const reviewConfidenceMigration = `
  DROP INDEX IF EXISTS review_runs_subject_completed;

  CREATE TABLE review_runs_v41 (
    id TEXT PRIMARY KEY,
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    revision_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind = 'adversarial_review'),
    provider TEXT NOT NULL CHECK (provider IN ('codex', 'opencode', 'claude')),
    session_id TEXT NOT NULL,
    model TEXT NOT NULL,
    agent_version TEXT NOT NULL,
    skill_digest TEXT NOT NULL CHECK (length(skill_digest) = 64),
    head_sha TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    gates TEXT NOT NULL CHECK (json_valid(gates)),
    outcome_tag TEXT NOT NULL CHECK (outcome_tag IN ('Ready', 'Pending', 'Blocked')),
    confidence INTEGER,
    findings TEXT NOT NULL CHECK (json_valid(findings)),
    content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
    usage TEXT NOT NULL DEFAULT '{"_tag":"Unavailable"}' CHECK (json_valid(usage)),
    FOREIGN KEY (revision_id, subject_id) REFERENCES revisions(id, subject_id),
    CHECK (completed_at >= started_at),
    CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100)
  );

  -- Named columns only: a later rewind replays this migration against a
  -- journal that already carries columns version 41 never saw.
  INSERT INTO review_runs_v41 (
    id, subject_id, revision_id, kind, provider, session_id, model, agent_version,
    skill_digest, head_sha, started_at, completed_at, gates, outcome_tag,
    confidence, findings, content_digest, usage
  ) SELECT
    id, subject_id, revision_id, kind, provider, session_id, model, agent_version,
    skill_digest, head_sha, started_at, completed_at, gates, outcome_tag,
    confidence, findings, content_digest, usage
  FROM review_runs;
  DROP TABLE review_runs;
  ALTER TABLE review_runs_v41 RENAME TO review_runs;
  CREATE INDEX review_runs_subject_completed ON review_runs(subject_id, completed_at DESC);

  PRAGMA user_version = 41;
`

/**
 * Names the run one controller-gate refresh restates.
 *
 * The sweep used to insert its settled answer as an unrelated row, which
 * counted one agent turn twice on the dashboard and in usage. Linking the
 * settlement to the run it supersedes keeps every later read counting once.
 */
const reviewSettlementMigration = `
  ALTER TABLE review_runs ADD COLUMN supersedes_review_run_id TEXT NULL REFERENCES review_runs(id);

  PRAGMA user_version = 42;
`

/**
 * Adds the run log: one tracking issue per Routine, one comment per run.
 *
 * A Routine that found nothing, or that was skipped, writes no Candidate and so
 * left no trace at all. A quiet morning read exactly like a broken one. The
 * tracking issue is where every run says what it did, including the runs that
 * did nothing.
 *
 * The issue number lives on the Routine because the issue outlives every run.
 */
const routineRunLogMigration = `
  ALTER TABLE routines ADD COLUMN tracking_issue_number INTEGER;

  CREATE TABLE routine_report_commands (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES routine_runs(id) ON DELETE CASCADE,
    repository TEXT NOT NULL,
    routine_name TEXT NOT NULL,
    body TEXT NOT NULL CHECK (body != ''),
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Pending', 'Running', 'Published', 'Failed')),
    reason TEXT,
    github_comment_id INTEGER,
    worker_id TEXT,
    fence INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    lease_expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- One report per run. A retry can never say the same morning twice.
    UNIQUE (run_id),
    CHECK (
      (state_tag = 'Running' AND worker_id IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (state_tag != 'Running' AND worker_id IS NULL AND lease_expires_at IS NULL)
    ),
    CHECK (state_tag != 'Failed' OR reason IS NOT NULL),
    CHECK (state_tag != 'Published' OR github_comment_id IS NOT NULL)
  );

  CREATE INDEX routine_report_commands_state ON routine_report_commands(state_tag, updated_at);

  PRAGMA user_version = 43;
`

/** Gives Routine runs the same durable phase record as every Item-bound Agent task. */
const routineProgressMigration = `
  ALTER TABLE routine_runs ADD COLUMN progress_percent INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100);
  ALTER TABLE routine_runs ADD COLUMN progress_label TEXT NOT NULL DEFAULT 'Starting';

  PRAGMA user_version = 44;
`

/** Stores the one Pull request triage decision that was previously ephemeral. */
const statsMigration = `
  CREATE TABLE IF NOT EXISTS pull_request_triage_runs (
    task_id TEXT PRIMARY KEY REFERENCES worker_tasks(id),
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    revision_id TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    outcome_tag TEXT NOT NULL CHECK (outcome_tag IN ('ReviewRequired', 'ReviewSkipped', 'ReviewRequiredAfterFailure')),
    reason TEXT NOT NULL CHECK (reason != ''),
    content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
    UNIQUE (subject_id, revision_id),
    FOREIGN KEY (revision_id, subject_id) REFERENCES revisions(id, subject_id),
    CHECK (completed_at >= started_at)
  );

  CREATE INDEX IF NOT EXISTS pull_request_triage_runs_completed ON pull_request_triage_runs(completed_at);
  CREATE TABLE IF NOT EXISTS stats_coverage (
    kind TEXT PRIMARY KEY CHECK (kind = 'pull_request_triage'),
    started_at TEXT NOT NULL
  );
  INSERT OR IGNORE INTO stats_coverage (kind, started_at)
  VALUES ('pull_request_triage', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

  CREATE INDEX IF NOT EXISTS review_runs_completed ON review_runs(completed_at);
  CREATE INDEX IF NOT EXISTS publication_commands_published ON publication_commands(published_at) WHERE state_tag = 'Published';
  CREATE INDEX IF NOT EXISTS task_transitions_created ON task_transitions(created_at);
  CREATE INDEX IF NOT EXISTS worker_task_transitions_created ON worker_task_transitions(created_at);
  CREATE INDEX IF NOT EXISTS routine_runs_updated ON routine_runs(updated_at);

  PRAGMA user_version = 45;
`

/** Stores one replaceable human judgment for one immutable Review run. */
const agentFeedbackMigration = `
  CREATE TABLE agent_feedback (
    review_run_id TEXT PRIMARY KEY REFERENCES review_runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('Useful', 'Noisy', 'Wrong')),
    reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (kind = 'Useful' OR (reason IS NOT NULL AND trim(reason) != ''))
  );

  CREATE INDEX agent_feedback_updated ON agent_feedback(updated_at DESC);
  PRAGMA user_version = 46;
`

/** Stores a restart independently from manual Pause, so the service owns completion. */
const restartRequestMigration = `
  CREATE TABLE restart_requests (
    id TEXT PRIMARY KEY,
    source_tag TEXT NOT NULL CHECK (source_tag IN ('dashboard', 'tray', 'helper')),
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Requested', 'Restarting', 'Completed', 'ActionRequired')),
    requested_at TEXT NOT NULL,
    restarting_at TEXT,
    completed_at TEXT,
    action_required_at TEXT,
    reason TEXT,
    process_id TEXT,
    CHECK (
      (state_tag = 'Requested'
        AND restarting_at IS NULL AND completed_at IS NULL
        AND action_required_at IS NULL AND reason IS NULL AND process_id IS NULL)
      OR (state_tag = 'Restarting'
        AND restarting_at IS NOT NULL AND completed_at IS NULL
        AND action_required_at IS NULL AND reason IS NULL AND process_id IS NOT NULL)
      OR (state_tag = 'Completed'
        AND restarting_at IS NOT NULL AND completed_at IS NOT NULL
        AND action_required_at IS NULL AND reason IS NULL AND process_id IS NOT NULL)
      OR (state_tag = 'ActionRequired'
        AND restarting_at IS NULL AND completed_at IS NULL
        AND action_required_at IS NOT NULL AND reason IS NOT NULL AND process_id IS NULL)
    )
  );

  CREATE UNIQUE INDEX restart_requests_active
  ON restart_requests ((1))
  WHERE state_tag IN ('Requested', 'Restarting');

  PRAGMA user_version = 47;
`

/** Separates final pull request cleanup from the Task that last owned its comment. */
const reviewClosureMigration = `
  CREATE TABLE review_closure_resolutions (
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    revision_id TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    disposition_tag TEXT NOT NULL CHECK (disposition_tag IN ('Merged', 'Closed')),
    result_tag TEXT NOT NULL CHECK (result_tag IN ('Published', 'CommentGone', 'Superseded')),
    body TEXT,
    github_comment_id INTEGER,
    github_url TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (subject_id, revision_id),
    FOREIGN KEY (revision_id, subject_id) REFERENCES revisions(id, subject_id),
    CHECK (
      (result_tag = 'Published' AND body IS NOT NULL AND github_comment_id IS NOT NULL AND github_url IS NOT NULL)
      OR (result_tag != 'Published' AND body IS NULL AND github_comment_id IS NULL AND github_url IS NULL)
    )
  );

  CREATE INDEX review_closure_resolutions_created ON review_closure_resolutions(created_at);
  PRAGMA user_version = 48;
`

/** Proves GitHub, rather than an omitted open-list row, supplied a closure. */
const verifiedPullRequestClosureMigration = `
  CREATE TABLE pull_request_closure_verifications (
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    revision_id TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    disposition_tag TEXT NOT NULL CHECK (disposition_tag IN ('Merged', 'Closed')),
    verified_at TEXT NOT NULL,
    PRIMARY KEY (subject_id, revision_id),
    FOREIGN KEY (revision_id, subject_id) REFERENCES revisions(id, subject_id)
  );

  CREATE INDEX pull_request_closure_verifications_verified
    ON pull_request_closure_verifications(verified_at);
  PRAGMA user_version = 49;
`

/**
 * Drops the expected updated at column from issue triage comments.
 *
 * The column compared GitHub's `updatedAt` at publish time, but the Running
 * label the service itself writes bumps `updatedAt` on every claim. A comment
 * staged under one label state could never publish under the next, so it
 * waited forever. The Revision identity already answers whether the issue
 * changed, and it excludes `updatedAt` on purpose.
 */
const issueTriageCommentContentMigration = `
  ALTER TABLE issue_triage_comment_commands DROP COLUMN expected_updated_at;
  PRAGMA user_version = 50;
`

/** Adds one queryable event stream and keeps Routine Agent usage. */
const workflowTelemetryMigration = `
  ALTER TABLE routine_runs
    ADD COLUMN usage TEXT NOT NULL DEFAULT '{"_tag":"Unavailable"}' CHECK (json_valid(usage));

  CREATE TABLE workflow_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream TEXT NOT NULL CHECK (stream IN (
      'task', 'worker_task', 'publication', 'review_run', 'review_status',
      'routine_run', 'candidate_issue', 'routine_report', 'provider_circuit'
    )),
    event TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    repository TEXT,
    item_number INTEGER,
    revision_id TEXT,
    task_id TEXT,
    from_state TEXT,
    to_state TEXT NOT NULL,
    reason TEXT,
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    fence INTEGER NOT NULL DEFAULT 0 CHECK (fence >= 0),
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    usage TEXT CHECK (usage IS NULL OR json_valid(usage)),
    occurred_at TEXT NOT NULL
  );

  CREATE INDEX workflow_events_stream_time
    ON workflow_events(stream, occurred_at DESC, id DESC);
  CREATE INDEX workflow_events_entity
    ON workflow_events(stream, entity_id, occurred_at, id);

  PRAGMA user_version = 51;
`

/** Persists Agent provider health independently from Task retry budgets. */
const providerCircuitMigration = `
  CREATE TABLE provider_circuits (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('codex', 'opencode')),
    credential TEXT NOT NULL,
    model TEXT NOT NULL,
    failure_class TEXT NOT NULL CHECK (failure_class IN (
      'network', 'overloaded', 'stalled', 'process_exit', 'authentication', 'unknown'
    )),
    state_tag TEXT NOT NULL CHECK (state_tag IN ('Closed', 'Open', 'HalfOpen')),
    failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
    retry_at TEXT,
    canary_worker_id TEXT,
    canary_fence INTEGER NOT NULL DEFAULT 0 CHECK (canary_fence >= 0),
    canary_lease_expires_at TEXT,
    last_detail TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (provider, credential, model, failure_class),
    CHECK (
      (state_tag = 'Open' AND retry_at IS NOT NULL
        AND canary_worker_id IS NULL AND canary_lease_expires_at IS NULL)
      OR (state_tag = 'HalfOpen' AND retry_at IS NULL
        AND canary_worker_id IS NOT NULL AND canary_lease_expires_at IS NOT NULL)
      OR (state_tag = 'Closed' AND retry_at IS NULL
        AND canary_worker_id IS NULL AND canary_lease_expires_at IS NULL)
    )
  );

  CREATE INDEX provider_circuits_availability
    ON provider_circuits(provider, credential, state_tag, retry_at);

  PRAGMA user_version = 52;
`

/** Makes successful Review completion explicit and detaches its terminal Publication. */
const reviewResolutionMigration = `
  ALTER TABLE review_status_commands ADD COLUMN review_run_id TEXT REFERENCES review_runs(id);
  ALTER TABLE review_status_commands ADD COLUMN desired_outcome TEXT
    CHECK (desired_outcome IN ('READY', 'PENDING', 'BLOCKED', 'WAITING', 'EXISTING', 'SKIPPED'));

  UPDATE review_status_commands
  SET desired_outcome = CASE
    WHEN body LIKE '%### 🤖 READY%' THEN 'READY'
    WHEN body LIKE '%### 🤖 BLOCKED%' THEN 'BLOCKED'
    WHEN body LIKE '%### 🤖 WAITING%' THEN 'WAITING'
    WHEN body LIKE '%### 🤖 REVIEW SKIPPED%' THEN 'SKIPPED'
    WHEN body LIKE '%### 🤖 PENDING%' THEN 'PENDING'
    ELSE NULL
  END
  WHERE phase = 'terminal';

  CREATE TABLE review_resolutions (
    subject_id INTEGER NOT NULL REFERENCES subjects(id),
    revision_id TEXT NOT NULL,
    task_id TEXT REFERENCES worker_tasks(id),
    task_fence INTEGER NOT NULL CHECK (task_fence >= 0),
    resolution_tag TEXT NOT NULL CHECK (resolution_tag IN (
      'Reviewed', 'ReviewSkipped', 'WaitingForBaselineRepair',
      'ExistingReview', 'UnknownNeedsReconciliation'
    )),
    review_run_id TEXT REFERENCES review_runs(id),
    baseline_task_id TEXT REFERENCES tasks(id),
    github_url TEXT,
    reason TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (subject_id, revision_id),
    FOREIGN KEY (revision_id, subject_id) REFERENCES revisions(id, subject_id),
    CHECK ((task_id IS NULL AND task_fence = 0) OR (task_id IS NOT NULL AND task_fence > 0)),
    CHECK (
      (resolution_tag = 'Reviewed' AND review_run_id IS NOT NULL
        AND baseline_task_id IS NULL AND github_url IS NULL AND reason IS NULL)
      OR (resolution_tag = 'WaitingForBaselineRepair' AND review_run_id IS NULL
        AND baseline_task_id IS NOT NULL AND github_url IS NULL AND reason IS NULL)
      OR (resolution_tag = 'ExistingReview' AND review_run_id IS NULL
        AND baseline_task_id IS NULL AND github_url IS NOT NULL AND reason IS NULL)
      OR (resolution_tag IN ('ReviewSkipped', 'UnknownNeedsReconciliation') AND review_run_id IS NULL
        AND baseline_task_id IS NULL AND github_url IS NULL AND reason IS NOT NULL)
    )
  );

  INSERT INTO review_resolutions (
    subject_id, revision_id, task_id, task_fence, resolution_tag,
    review_run_id, baseline_task_id, github_url, reason, created_at
  )
  SELECT worker_tasks.subject_id, worker_tasks.revision_id, worker_tasks.id, worker_tasks.fence,
    CASE WHEN review_runs.id IS NOT NULL THEN 'Reviewed' ELSE 'UnknownNeedsReconciliation' END,
    review_runs.id, NULL, NULL,
    CASE WHEN review_runs.id IS NULL THEN 'Legacy Review evidence needs reconciliation.' ELSE NULL END,
    worker_tasks.updated_at
  FROM worker_tasks
  LEFT JOIN review_runs ON review_runs.id = worker_tasks.evidence
  WHERE worker_tasks.kind = 'adversarial_review' AND worker_tasks.state_tag = 'Completed';

  ALTER TABLE workflow_events RENAME TO workflow_events_v52;
  CREATE TABLE workflow_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream TEXT NOT NULL CHECK (stream IN (
      'task', 'worker_task', 'publication', 'review_run', 'review_resolution', 'review_status',
      'routine_run', 'candidate_issue', 'routine_report', 'provider_circuit'
    )),
    event TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    repository TEXT,
    item_number INTEGER,
    revision_id TEXT,
    task_id TEXT,
    from_state TEXT,
    to_state TEXT NOT NULL,
    reason TEXT,
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    fence INTEGER NOT NULL DEFAULT 0 CHECK (fence >= 0),
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    usage TEXT CHECK (usage IS NULL OR json_valid(usage)),
    occurred_at TEXT NOT NULL
  );
  INSERT INTO workflow_events SELECT * FROM workflow_events_v52;
  DROP TABLE workflow_events_v52;
  CREATE INDEX workflow_events_stream_time
    ON workflow_events(stream, occurred_at DESC, id DESC);
  CREATE INDEX workflow_events_entity
    ON workflow_events(stream, entity_id, occurred_at, id);

  PRAGMA user_version = 53;
`

/** Binds Review reuse to the trusted repository policy that produced it. */
const reviewEvidenceScopeMigration = `
  CREATE TABLE review_evidence_scopes (
    review_run_id TEXT PRIMARY KEY REFERENCES review_runs(id) ON DELETE CASCADE,
    policy_digest TEXT NOT NULL CHECK (length(policy_digest) = 64),
    created_at TEXT NOT NULL
  );
  INSERT INTO review_evidence_scopes (review_run_id, policy_digest, created_at)
  SELECT id, '0000000000000000000000000000000000000000000000000000000000000000', completed_at
  FROM review_runs;
  PRAGMA user_version = 54;
`

/** Pins Routine authority to each Run and retires definitions without deleting history. */
const routineAuthorityMigration = `
  ALTER TABLE routines ADD COLUMN retired_at TEXT;
  ALTER TABLE routine_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'report' CHECK (mode IN ('report', 'propose'));
  CREATE INDEX routines_active ON routines(repository, retired_at, enabled);
  PRAGMA user_version = 55;
`

/** Keeps moving controller gates separate from immutable Agent time and usage. */
const reviewGateProjectionMigration = `
  CREATE TABLE review_gate_projections (
    review_run_id TEXT PRIMARY KEY REFERENCES review_runs(id) ON DELETE CASCADE,
    gates TEXT NOT NULL CHECK (json_valid(gates)),
    outcome_tag TEXT NOT NULL CHECK (outcome_tag IN ('Ready', 'Pending', 'Blocked')),
    confidence INTEGER CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100),
    updated_at TEXT NOT NULL
  );
  INSERT INTO review_gate_projections (review_run_id, gates, outcome_tag, confidence, updated_at)
  SELECT id, gates, outcome_tag, confidence, completed_at FROM review_runs;

  ALTER TABLE workflow_events RENAME TO workflow_events_v55;
  CREATE TABLE workflow_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stream TEXT NOT NULL CHECK (stream IN (
      'task', 'worker_task', 'publication', 'review_run', 'review_gate',
      'review_resolution', 'review_status', 'issue_triage_status', 'routine_run',
      'candidate_issue', 'routine_report', 'provider_circuit'
    )),
    event TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    repository TEXT,
    item_number INTEGER,
    revision_id TEXT,
    task_id TEXT,
    from_state TEXT,
    to_state TEXT NOT NULL,
    reason TEXT,
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    fence INTEGER NOT NULL DEFAULT 0 CHECK (fence >= 0),
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    usage TEXT CHECK (usage IS NULL OR json_valid(usage)),
    occurred_at TEXT NOT NULL
  );
  INSERT INTO workflow_events SELECT * FROM workflow_events_v55;
  DROP TABLE workflow_events_v55;
  CREATE INDEX workflow_events_stream_time
    ON workflow_events(stream, occurred_at DESC, id DESC);
  CREATE INDEX workflow_events_entity
    ON workflow_events(stream, entity_id, occurred_at, id);

  PRAGMA user_version = 56;
`

/** Clears Publication Incidents that existed before they belonged to a repository. */
const repositoryScopedReviewStatusIncidentMigration = `
  UPDATE incidents
  SET resolved_at = last_seen_at
  WHERE resolved_at IS NULL
    AND scope_tag = 'Service'
    AND operation = 'review_status_publication';

  PRAGMA user_version = 57;
`

/** Distinguishes a plain restart from one that prepares a pinned service commit. */
const restartOperationMigration = `
  ALTER TABLE restart_requests
  ADD COLUMN operation_tag TEXT NOT NULL DEFAULT 'Restart'
    CHECK (operation_tag IN ('Restart', 'Update'));

  ALTER TABLE restart_requests
  ADD COLUMN target_commit TEXT
    CHECK (target_commit IS NULL OR (length(target_commit) = 40 AND target_commit NOT GLOB '*[^0-9a-f]*'));

  PRAGMA user_version = 58;
`

/** Clears Incidents created when write quarantine was treated as a failure. */
const writeQuarantineIncidentMigration = `
  UPDATE incidents
  SET resolved_at = last_seen_at
  WHERE resolved_at IS NULL
    AND kind = 'policy'
    AND message LIKE '%The controller has never been trusted to write to %. Enable writes for it first.';

  PRAGMA user_version = 59;
`

/** Stores what each Repair Agent reported, so a later Repair round can read it. */
const repairReportMigration = `
  CREATE TABLE repair_reports (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    summary TEXT NOT NULL,
    checks TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );

  PRAGMA user_version = 60;
`

function applyMigration(database: DatabaseSync, migration: string): void {
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(migration)
    database.exec('COMMIT')
  }
  catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function applyForeignKeyMigration(database: DatabaseSync, migration: string): void {
  database.exec('PRAGMA foreign_keys = OFF')
  try {
    applyMigration(database, migration)
  }
  finally {
    database.exec('PRAGMA foreign_keys = ON')
  }
}

function installSchema(database: DatabaseSync): void {
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
  let version = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  const existing = database.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).get() as { count: number }
  if (version === 0) {
    if (existing.count > 0)
      throw new Error('Unsupported database schema version: 0.')
    applyMigration(database, initialMigration)
    version = 1
  }
  if (version === 1) {
    applyMigration(database, reviewJournalMigration)
    version = 2
  }
  if (version === 2) {
    applyForeignKeyMigration(database, publicationJournalMigration)
    version = 4
  }
  if (version === 4) {
    applyMigration(database, pullRequestApprovalMigration)
    version = 5
  }
  if (version === 5) {
    applyMigration(database, workerTaskMigration)
    version = 6
  }
  if (version === 6) {
    applyMigration(database, reviewStatusMigration)
    version = 7
  }
  if (version === 7) {
    applyMigration(database, agentProgressMigration)
    version = 8
  }
  if (version === 8) {
    applyMigration(database, automatedReviewMigration)
    version = 9
  }
  if (version === 9) {
    applyForeignKeyMigration(database, contentEquivalentPublicationMigration)
    version = 10
  }
  if (version === 10) {
    applyMigration(database, taskCancellationMigration)
    version = 11
  }
  if (version === 11) {
    applyMigration(database, reviewRerunMigration)
    version = 12
  }
  if (version === 12) {
    applyForeignKeyMigration(database, reviewFixMigration)
    version = 13
  }
  if (version === 13) {
    applyForeignKeyMigration(database, issueWorkMigration)
    version = 14
  }
  if (version === 14) {
    applyMigration(database, issueTriageCommentMigration)
    version = 15
  }
  if (version === 15) {
    applyMigration(database, agentControlMigration)
    version = 16
  }
  if (version === 16) {
    applyMigration(database, repositoryPauseMigration)
    version = 17
  }
  if (version === 17) {
    applyForeignKeyMigration(database, reviewFixStatusMigration)
    version = 18
  }
  if (version === 18) {
    applyForeignKeyMigration(database, baselineRepairMigration)
    version = 19
  }
  if (version === 19) {
    applyForeignKeyMigration(database, repeatablePublicationMigration)
    version = 20
  }
  if (version === 20) {
    applyForeignKeyMigration(database, agentProviderMigration)
    version = 21
  }
  if (version === 21) {
    applyForeignKeyMigration(database, incidentMigration)
    version = 22
  }
  if (version === 22) {
    applyGitHubStateVocabularyMigration(database)
    version = 23
  }
  if (version === 23) {
    applyForeignKeyMigration(database, reviewRunMigration)
    version = 24
  }
  if (version === 24) {
    applyMigration(database, agentSelectionMigration)
    version = 25
  }
  if (version === 25) {
    applyForeignKeyMigration(database, stackedPullRequestMigration)
    version = 26
  }
  if (version === 26) {
    applyMigration(database, followsConfigurationSelectionMigration)
    version = 27
  }
  if (version === 27) {
    applyMigration(database, selectionModeMigration)
    version = 28
  }
  if (version === 28) {
    applyMigration(database, itemDismissalMigration)
    version = 29
  }
  if (version === 29) {
    applyMigration(database, repositoryWriteQuarantineMigration)
    version = 30
  }
  if (version === 30) {
    applyForeignKeyMigration(database, reviewUsageMigration)
    version = 31
  }
  if (version === 31) {
    applyForeignKeyMigration(database, queuedReviewStatusMigration)
    version = 32
  }
  if (version === 32) {
    applyMigration(database, narrowPublicationPermissionMigration)
    version = 33
  }
  if (version === 33) {
    applyMigration(database, repairDisputeRerunMigration)
    version = 34
  }
  if (version === 34) {
    applyMigration(database, freshProviderSessionMigration)
    version = 35
  }
  if (version === 35) {
    applyMigration(database, pullRequestPurposeMigration)
    version = 36
  }
  if (version === 36) {
    applyMigration(database, automaticAgentSelectionMigration)
    version = 37
  }
  if (version === 37) {
    applyMigration(database, routineMigration)
    version = 38
  }
  if (version === 38) {
    applyForeignKeyMigration(database, polymorphicPublicationMigration)
    version = 39
  }
  if (version === 39) {
    applyMigration(database, candidateIssueMigration)
    version = 40
  }
  if (version === 40) {
    applyForeignKeyMigration(database, reviewConfidenceMigration)
    version = 41
  }
  if (version === 41) {
    applyMigration(database, reviewSettlementMigration)
    version = 42
  }
  if (version === 42) {
    applyMigration(database, routineRunLogMigration)
    version = 43
  }
  if (version === 43) {
    applyMigration(database, routineProgressMigration)
    version = 44
  }
  if (version === 44) {
    applyMigration(database, statsMigration)
    version = 45
  }
  if (version === 45) {
    applyMigration(database, agentFeedbackMigration)
    version = 46
  }
  if (version === 46) {
    applyMigration(database, restartRequestMigration)
    version = 47
  }
  if (version === 47) {
    applyMigration(database, reviewClosureMigration)
    version = 48
  }
  if (version === 48) {
    applyMigration(database, verifiedPullRequestClosureMigration)
    version = 49
  }
  if (version === 49) {
    applyMigration(database, issueTriageCommentContentMigration)
    version = 50
  }
  if (version === 50) {
    applyMigration(database, workflowTelemetryMigration)
    version = 51
  }
  if (version === 51) {
    applyMigration(database, providerCircuitMigration)
    version = 52
  }
  if (version === 52) {
    applyForeignKeyMigration(database, reviewResolutionMigration)
    version = 53
  }
  if (version === 53) {
    applyMigration(database, reviewEvidenceScopeMigration)
    version = 54
  }
  if (version === 54) {
    applyMigration(database, routineAuthorityMigration)
    version = 55
  }
  if (version === 55) {
    applyForeignKeyMigration(database, reviewGateProjectionMigration)
    version = 56
  }
  if (version === 56) {
    applyMigration(database, repositoryScopedReviewStatusIncidentMigration)
    version = 57
  }
  if (version === 57) {
    applyMigration(database, restartOperationMigration)
    version = 58
  }
  if (version === 58) {
    applyMigration(database, writeQuarantineIncidentMigration)
    version = 59
  }
  if (version === 59) {
    applyMigration(database, repairReportMigration)
    return
  }
  if (version === 60)
    return
  throw new Error(`Unsupported database schema version: ${version}.`)
}

function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') {
    const directory = dirname(path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (lstatSync(directory).isSymbolicLink())
      throw new Error('Database directory must not be a symbolic link.')
    chmodSync(directory, 0o700)
    try {
      if (lstatSync(path).isSymbolicLink())
        throw new Error('Database path must not be a symbolic link.')
    }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
        throw error
    }
  }

  const database = new DatabaseSync(path)
  if (path !== ':memory:')
    chmodSync(path, 0o600)
  installSchema(database)
  return database
}

function taskRows(database: DatabaseSync): TaskRow[] {
  const rows = (table: 'tasks' | 'worker_tasks', current: boolean): TaskRow[] => database.prepare(`
    SELECT
      ${table}.id,
      ${table}.kind,
      repositories.github AS repository,
      subjects.github_number,
      ${table}.revision_id,
      ${table}.state_tag,
      ${table}.reason,
      ${table}.worker_id,
      ${table}.evidence,
      ${table === 'tasks' ? 'tasks.command_id' : 'NULL'} AS command_id,
      ${table}.fence,
      ${table}.lease_expires_at,
      ${table}.updated_at,
      ${table}.recovery_attempts,
      ${table}.progress_percent,
      ${table}.progress_label
    FROM ${table}
    JOIN subjects ON subjects.id = ${table}.subject_id
    JOIN repositories ON repositories.id = subjects.repository_id
    ${current
      ? `JOIN revisions ON revisions.id = subjects.current_revision_id
         WHERE ${table}.revision_id = subjects.current_revision_id
           AND repositories.enabled = 1
           AND json_extract(revisions.payload, '$.state') = 'open'`
      : ''}
    ORDER BY ${table}.updated_at DESC
    ${current ? '' : 'LIMIT 100'}
  `).all() as unknown as TaskRow[]
  const current = [...rows('tasks', true), ...rows('worker_tasks', true)]
  const currentIds = new Set(current.map(row => row.id))
  const historyLimit = Math.max(0, 100 - current.length)
  const history = [...rows('tasks', false), ...rows('worker_tasks', false)]
    .filter(row => !currentIds.has(row.id))
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id))
    .slice(0, historyLimit)
  const tableOrder = (row: TaskRow): number => row.kind === 'adversarial_review' || row.kind === 'issue_triage' ? 1 : 0
  return [...current, ...history]
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at)
      || tableOrder(left) - tableOrder(right)
      || left.id.localeCompare(right.id))
}

function activeAgentRows(database: DatabaseSync, provider: AgentProviderName): ActiveAgentRow[] {
  const conflicts = database.prepare(`
    SELECT
      tasks.id,
      tasks.kind,
      repositories.github AS repository,
      subjects.github_number,
      tasks.revision_id,
      tasks.state_tag,
      tasks.reason,
      tasks.worker_id,
      tasks.evidence,
      tasks.command_id,
      tasks.fence,
      tasks.lease_expires_at,
      tasks.updated_at,
      subjects.kind AS subject_kind,
      json_extract(revisions.payload, '$.title') AS title,
      json_extract(revisions.payload, '$.author') AS author,
      json_extract(revisions.payload, '$.url') AS subject_url,
      json_extract(revisions.payload, '$.headSha') AS head_sha,
      json_extract(revisions.payload, '$.headRepository') AS head_repository,
      COALESCE(worker_sessions.session_id, (
        SELECT sessions.session_id FROM subject_worker_sessions AS sessions
        WHERE sessions.subject_id = subjects.id AND sessions.role = 'issue_triage'
          AND sessions.provider = ?
        ORDER BY sessions.updated_at DESC, sessions.id DESC
        LIMIT 1
      )) AS session_id,
      tasks.progress_percent,
      tasks.progress_label,
      COALESCE((
        SELECT MAX(task_transitions.created_at)
        FROM task_transitions
        WHERE task_transitions.task_id = tasks.id AND task_transitions.to_tag = 'Running'
      ), tasks.updated_at) AS started_at
    FROM tasks
    JOIN subjects ON subjects.id = tasks.subject_id
    JOIN repositories ON repositories.id = subjects.repository_id
    JOIN revisions ON revisions.id = tasks.revision_id
    LEFT JOIN worker_sessions ON worker_sessions.subject_id = subjects.id
      AND worker_sessions.role = CASE tasks.kind
        WHEN 'resolve_conflict' THEN 'conflict_resolution'
        WHEN 'review_fix' THEN 'review_fix'
        WHEN 'baseline_repair' THEN 'baseline_repair'
      END
      AND worker_sessions.provider = ?
    WHERE tasks.state_tag IN ('Running', 'Publishing')
    ORDER BY CASE tasks.state_tag WHEN 'Running' THEN 0 ELSE 1 END, tasks.updated_at
  `).all(provider, provider) as unknown as ActiveAgentRow[]
  const workers = database.prepare(`
    SELECT
      worker_tasks.id,
      worker_tasks.kind,
      repositories.github AS repository,
      subjects.github_number,
      worker_tasks.revision_id,
      worker_tasks.state_tag,
      worker_tasks.reason,
      worker_tasks.worker_id,
      worker_tasks.evidence,
      NULL AS command_id,
      worker_tasks.fence,
      worker_tasks.lease_expires_at,
      worker_tasks.updated_at,
      subjects.kind AS subject_kind,
      json_extract(revisions.payload, '$.title') AS title,
      json_extract(revisions.payload, '$.author') AS author,
      json_extract(revisions.payload, '$.url') AS subject_url,
      json_extract(revisions.payload, '$.headSha') AS head_sha,
      json_extract(revisions.payload, '$.headRepository') AS head_repository,
      subject_worker_sessions.session_id,
      worker_tasks.progress_percent,
      worker_tasks.progress_label,
      COALESCE((
        SELECT MAX(worker_task_transitions.created_at)
        FROM worker_task_transitions
        WHERE worker_task_transitions.task_id = worker_tasks.id AND worker_task_transitions.to_tag = 'Running'
      ), worker_tasks.updated_at) AS started_at
    FROM worker_tasks
    JOIN subjects ON subjects.id = worker_tasks.subject_id
    JOIN repositories ON repositories.id = subjects.repository_id
    JOIN revisions ON revisions.id = worker_tasks.revision_id
    LEFT JOIN subject_worker_sessions ON subject_worker_sessions.id = (
      SELECT sessions.id FROM subject_worker_sessions AS sessions
      WHERE sessions.subject_id = subjects.id AND sessions.role = worker_tasks.kind
        AND sessions.provider = ?
      ORDER BY sessions.updated_at DESC, sessions.id DESC
      LIMIT 1
    )
    WHERE worker_tasks.state_tag = 'Running'
    ORDER BY worker_tasks.updated_at
  `).all(provider) as unknown as ActiveAgentRow[]
  return [...conflicts, ...workers].sort((left, right) =>
    left.started_at.localeCompare(right.started_at) || left.id.localeCompare(right.id),
  )
}

function dashboardReviewAgents(database: DatabaseSync): Array<Extract<DashboardAgent, { _tag: 'ReviewAgent' }>> {
  const reviewRuns = database.prepare(`
    SELECT
      review_runs.id,
      repositories.github AS repository,
      subjects.github_number,
      review_runs.revision_id,
      review_runs.head_sha,
      review_runs.provider,
      review_runs.session_id,
      review_runs.model,
      review_runs.agent_version,
      review_runs.skill_digest,
      review_runs.started_at,
      review_runs.completed_at,
      review_runs.usage,
      COALESCE(review_gate_projections.gates, review_runs.gates) AS gates,
      COALESCE(review_gate_projections.outcome_tag, review_runs.outcome_tag) AS outcome_tag,
      COALESCE(review_gate_projections.confidence, review_runs.confidence) AS confidence,
      review_runs.findings,
      agent_feedback.kind AS feedback_tag,
      agent_feedback.reason AS feedback_reason,
      agent_feedback.updated_at AS feedback_updated_at,
      json_extract(revisions.payload, '$.title') AS title,
      json_extract(revisions.payload, '$.author') AS author,
      json_extract(revisions.payload, '$.url') AS subject_url,
      json_extract(revisions.payload, '$.headRepository') AS head_repository
    FROM review_runs
    JOIN subjects ON subjects.id = review_runs.subject_id
    JOIN repositories ON repositories.id = subjects.repository_id
    JOIN revisions ON revisions.id = review_runs.revision_id AND revisions.subject_id = subjects.id
    LEFT JOIN review_gate_projections ON review_gate_projections.review_run_id = review_runs.id
    LEFT JOIN agent_feedback ON agent_feedback.review_run_id = review_runs.id
    WHERE review_runs.kind = 'adversarial_review'
      AND NOT EXISTS (
        SELECT 1 FROM review_runs AS settled
        WHERE settled.supersedes_review_run_id = review_runs.id
      )
      AND (
        (
          subjects.current_revision_id = review_runs.revision_id
          AND json_extract(revisions.payload, '$.state') = 'open'
        )
        OR review_runs.id IN (
          SELECT recent.id
          FROM review_runs AS recent
          WHERE recent.kind = 'adversarial_review'
            AND NOT EXISTS (
              SELECT 1 FROM review_runs AS settled
              WHERE settled.supersedes_review_run_id = recent.id
            )
          ORDER BY recent.completed_at DESC, recent.id
          LIMIT 30
        )
      )
    ORDER BY review_runs.completed_at DESC, review_runs.id
  `).all() as unknown as DashboardReviewRunRow[]
  const publications = reviewRuns.length === 0
    ? []
    : database.prepare(`
        SELECT
          review_publications.id,
          review_publications.review_run_id,
          review_publications.body,
          review_publications.body_sha256,
          review_publications.created_at,
          review_publications.result_tag,
          review_publications.github_comment_id,
          review_publications.github_url,
          review_publications.reason
        FROM review_publications
        WHERE review_publications.review_run_id IN (${reviewRuns.map(() => '?').join(', ')})
        ORDER BY review_publications.created_at, review_publications.id
      `).all(...reviewRuns.map(run => run.id)) as unknown as ReviewPublicationRow[]
  const publicationsByRun = Map.groupBy(publications.map(reviewPublicationFromRow), publication => publication.reviewRunId)
  return reviewRuns.map(row => reviewAgentFromRow(row, publicationsByRun.get(row.id) ?? []))
}

export function openJournalStore(
  path: string,
  mutationsEnabled = false,
  profile: AgentProfile = CODEX_AGENT_PROFILE,
  /** Issue work stops when open pull requests reach this limit. Matches the configuration default. */
  maxOpenPullRequests = 8,
  serviceUpdate: () => ServiceUpdateStatus = () => ({ _tag: 'Checking', deployedCommit: '' }),
): JournalStore {
  const database = openDatabase(path)
  const configuredSelection = providerAgentSelection(profile.provider)
  const repositoryWriteAuthoritySql = mutationsEnabled ? 'AND repositories.writes_enabled = 1' : ''

  const getAgentSelection = (): AgentSelection => {
    const row = database.prepare('SELECT tag, provider, model, reasoning_effort, provider_order FROM agent_selection WHERE singleton = 1').get() as {
      tag: string
      provider: string | null
      model: string | null
      reasoning_effort: string | null
      provider_order: string | null
    } | undefined
    if (row === undefined || row.tag === 'FollowsConfiguration')
      return { _tag: 'FollowsConfiguration' }
    if (row.tag === 'Automatic') {
      const parsedOrder = parseAgentSelection({
        _tag: 'Automatic',
        order: row.provider_order === null ? undefined : JSON.parse(row.provider_order),
      })
      return parsedOrder._tag === 'Ok' ? parsedOrder.value : { _tag: 'FollowsConfiguration' }
    }
    const parsed = parseAgentSelection({ _tag: 'Pinned', provider: row.provider, model: row.model, reasoningEffort: row.reasoning_effort })
    // A build that drops a model leaves a stored selection nothing can answer.
    // The configuration is the safe answer, and the dashboard shows what it names.
    return parsed._tag === 'Ok' ? parsed.value : { _tag: 'FollowsConfiguration' }
  }

  /** The Agent provider, model, and reasoning effort in force right now. */
  const activeSelection = (): PinnedAgentSelection => resolveAgentSelection(getAgentSelection(), configuredSelection)

  const selectAgent = (selection: AgentSelection, at: string): AgentSelection => {
    const pinned = selection._tag === 'Pinned' ? selection : null
    const order = selection._tag === 'Automatic' ? JSON.stringify(selection.order) : null
    database.prepare(`
      INSERT INTO agent_selection (singleton, tag, provider, model, reasoning_effort, provider_order, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (singleton) DO UPDATE SET
        tag = excluded.tag,
        provider = excluded.provider,
        model = excluded.model,
        reasoning_effort = excluded.reasoning_effort,
        provider_order = excluded.provider_order,
        updated_at = excluded.updated_at
    `).run(selection._tag, pinned?.provider ?? null, pinned?.model ?? null, pinned?.reasoningEffort ?? null, order, at)
    return getAgentSelection()
  }

  /** Sessions belong to the provider that created them, so every read is scoped. */
  const provider = (): AgentProviderName => activeSelection().provider

  const syncRepositories = (repositories: RepositoryMapping[], at: string): void => {
    const statement = database.prepare(`
      INSERT INTO repositories (github, policy_json, policy_digest, enabled, ownership)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (github) DO UPDATE SET
        policy_json = excluded.policy_json,
        policy_digest = excluded.policy_digest,
        enabled = excluded.enabled,
        ownership = excluded.ownership
    `)
    database.exec('BEGIN IMMEDIATE')
    try {
      database.prepare('UPDATE repositories SET enabled = 0').run()
      repositories.forEach((mapping) => {
        const policy = JSON.stringify(mapping)
        statement.run(mapping.github, policy, digest(policy), mapping.enabled ? 1 : 0, mapping.ownership)
      })
      const unauthorized = database.prepare(`
        SELECT tasks.id, tasks.kind, tasks.state_tag, tasks.fence, tasks.subject_id
        FROM tasks
        JOIN subjects ON subjects.id = tasks.subject_id
        JOIN repositories ON repositories.id = subjects.repository_id
        WHERE tasks.state_tag IN ('Queued', 'ActionRequired', 'Running', 'Publishing')
          AND (
            repositories.enabled = 0
            OR (tasks.kind = 'resolve_conflict' AND json_extract(repositories.policy_json, '$.conflictResolution') != 1)
            OR (tasks.kind = 'review_fix' AND json_extract(repositories.policy_json, '$.pullRequestReview') != 1)
            OR (tasks.kind = 'baseline_repair' AND json_extract(repositories.policy_json, '$.pullRequestReview') != 1)
            OR (tasks.kind = 'issue_work' AND json_extract(repositories.policy_json, '$.issueWork') != 1)
          )
      `).all() as unknown as Array<{ id: string, kind: 'resolve_conflict' | 'review_fix' | 'baseline_repair' | 'issue_work', state_tag: TaskRow['state_tag'], fence: number, subject_id: number }>
      unauthorized.forEach(row => supersedeTasks(database, row.subject_id, at, 'Repository policy no longer permits this change.', undefined, row.kind))
      const unauthorizedWorkers = database.prepare(`
        SELECT worker_tasks.subject_id, worker_tasks.kind
        FROM worker_tasks
        JOIN repositories ON repositories.id = (
          SELECT subjects.repository_id FROM subjects WHERE subjects.id = worker_tasks.subject_id
        )
        WHERE worker_tasks.state_tag IN ('Queued', 'ActionRequired', 'Running')
          AND (
            repositories.enabled = 0
            OR (worker_tasks.kind = 'adversarial_review' AND json_extract(repositories.policy_json, '$.pullRequestReview') != 1)
            OR (worker_tasks.kind = 'issue_triage' AND json_extract(repositories.policy_json, '$.issueWork') != 1)
          )
      `).all() as unknown as Array<{ subject_id: number, kind: 'adversarial_review' | 'issue_triage' }>
      unauthorizedWorkers.forEach(row => supersedeWorkerTasks(
        database,
        row.subject_id,
        row.kind,
        at,
        'Repository policy no longer permits this Worker.',
      ))
      supersedeUnauthorizedReviewStatuses(database, at)
      database.prepare(`
        UPDATE incidents SET resolved_at = ?
        WHERE resolved_at IS NULL AND scope_tag = 'Repository' AND repository IN (
          SELECT github FROM repositories WHERE enabled = 0
        )
      `).run(at)
      database.exec('COMMIT')
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const cancelTask: JournalStore['cancelTask'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = cancelStoredTask(database, input.taskId, input.at, 'Cancelled from the dashboard.')
      database.exec('COMMIT')
      return result
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const requestReviewRerun: JournalStore['requestReviewRerun'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const duplicate = database.prepare(`
        SELECT task_id FROM review_rerun_requests WHERE id = ?
      `).get(input.requestId) as { task_id: string } | undefined
      if (duplicate !== undefined) {
        database.exec('COMMIT')
        return { _tag: 'Duplicate', taskId: duplicate.task_id }
      }

      const row = database.prepare(`
        SELECT
          subjects.id AS subject_id,
          subjects.current_revision_id,
          revisions.payload,
          repositories.policy_json,
          worker_tasks.id AS task_id,
          worker_tasks.state_tag,
          worker_tasks.fence
        FROM subjects
        JOIN repositories ON repositories.id = subjects.repository_id
        JOIN revisions ON revisions.id = subjects.current_revision_id
        LEFT JOIN worker_tasks ON worker_tasks.subject_id = subjects.id
          AND worker_tasks.revision_id = subjects.current_revision_id
          AND worker_tasks.kind = 'adversarial_review'
        WHERE repositories.github = ? AND repositories.enabled = 1
          AND subjects.github_number = ? AND subjects.kind = 'pull_request'
      `).get(input.repository, input.pullRequestNumber) as {
        subject_id: number
        current_revision_id: string
        payload: string
        policy_json: string
        task_id: string | null
        state_tag: Exclude<TaskRow['state_tag'], 'Publishing'> | null
        fence: number | null
      } | undefined
      if (row === undefined) {
        database.exec('COMMIT')
        return { _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }
      }
      if (row.current_revision_id !== input.revisionId) {
        database.exec('COMMIT')
        return { _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }
      }
      // A Repair dispute mints its request id from reviewer-coined finding
      // identities, so wording drift evades the exact-digest duplicate check.
      // Cap disputes at one fresh Review per subject and revision.
      if (input.source === 'repair_dispute') {
        const priorDispute = database.prepare(`
          SELECT 1
          FROM review_rerun_requests
          JOIN worker_tasks ON worker_tasks.id = review_rerun_requests.task_id
          WHERE review_rerun_requests.source = 'repair_dispute'
            AND worker_tasks.subject_id = ?
            AND worker_tasks.revision_id = ?
          LIMIT 1
        `).get(row.subject_id, input.revisionId) !== undefined
        if (priorDispute) {
          database.exec('COMMIT')
          return { _tag: 'Rejected', reason: { _tag: 'DisputeCapReached' } }
        }
      }

      const pullRequest = JSON.parse(row.payload) as GitHubPullRequestItem
      const mapping = JSON.parse(row.policy_json) as RepositoryMapping
      if (
        input.source === 'github_comment'
        && !mapping.writablePullRequestAuthors.some(author => author.toLowerCase() === input.requestedBy.toLowerCase())
      ) {
        database.exec('COMMIT')
        return { _tag: 'Rejected', reason: { _tag: 'AuthorNotAllowed' } }
      }
      const reviewApproved = !requiresPullRequestApproval(database, mapping, pullRequest.author)
        || database.prepare(`
          SELECT 1 FROM pull_request_approvals
          WHERE subject_id = ? AND revision_id = ? AND kind = 'review'
        `).get(row.subject_id, input.revisionId) !== undefined
      if (
        pullRequest.state !== 'open'
        || pullRequest.draft
        || pullRequest.mergeState !== 'clean'
        || !mapping.pullRequestReview
        || !reviewApproved
      ) {
        database.exec('COMMIT')
        return { _tag: 'Rejected', reason: { _tag: 'ReviewNotReady' } }
      }

      const taskId = row.task_id ?? digest(`${mapping.github}:pull_request:${pullRequest.number}:${input.revisionId}:adversarial_review`)
      if (row.task_id === null) {
        database.prepare(`
          INSERT INTO worker_tasks (id, subject_id, revision_id, kind, state_tag, updated_at)
          VALUES (?, ?, ?, 'adversarial_review', 'Queued', ?)
        `).run(taskId, row.subject_id, input.revisionId, input.at)
        recordWorkerTransition(database, { taskId, from: null, to: 'Queued', reason: 'Review rerun requested.', fence: 0, at: input.at })
      }
      else if (row.state_tag !== 'Queued' && row.state_tag !== 'Running') {
        database.prepare(`
          UPDATE worker_tasks
          SET state_tag = 'Queued', reason = NULL, evidence = NULL, attempts = 0,
            worker_id = NULL, lease_expires_at = NULL, progress_percent = 0,
            progress_label = 'Starting', updated_at = ?
          WHERE id = ?
        `).run(input.at, taskId)
        database.prepare('DELETE FROM task_cancellations WHERE task_id = ?').run(taskId)
        recordWorkerTransition(database, {
          taskId,
          from: row.state_tag,
          to: 'Queued',
          reason: 'Review rerun requested.',
          fence: row.fence ?? 0,
          at: input.at,
        })
      }

      database.prepare(`
        INSERT INTO review_rerun_requests (id, task_id, source, requested_by, requested_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.requestId, taskId, input.source, input.requestedBy, input.at)
      database.exec('COMMIT')
      return row.state_tag === 'Queued' || row.state_tag === 'Running'
        ? { _tag: 'AlreadyQueued', taskId }
        : { _tag: 'Queued', taskId }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const writeObservation = (
    input: Parameters<JournalStore['recordObservation']>[0],
    exactPullRequest: boolean,
  ): RecordObservationResult => {
    const payload = canonicalPayload(input.subject)
    const revisionId = revisionIdFor(input.subject)
    database.exec('BEGIN IMMEDIATE')
    try {
      const external = database.prepare('SELECT revision_id FROM observations WHERE external_id = ?').get(input.externalId) as { revision_id: string } | undefined
      if (external !== undefined && external.revision_id !== revisionId) {
        database.exec('COMMIT')
        return { _tag: 'Conflict', existingRevisionId: external.revision_id, receivedRevisionId: revisionId }
      }

      const repository = database.prepare(`
        SELECT id, policy_json FROM repositories WHERE github = ? AND enabled = 1
      `).get(input.subject.repository) as { id: number, policy_json: string } | undefined
      if (repository === undefined)
        throw new Error(`Enabled repository mapping is not stored: ${input.subject.repository}.`)

      database.prepare(`
        INSERT OR IGNORE INTO subjects (repository_id, github_number, kind)
        VALUES (?, ?, ?)
      `).run(repository.id, input.subject.number, input.subject.kind)
      const subject = database.prepare(`
        SELECT subjects.id, subjects.current_revision_id, revisions.payload AS current_payload,
          revisions.source AS current_source
        FROM subjects
        LEFT JOIN revisions ON revisions.id = subjects.current_revision_id
        WHERE subjects.repository_id = ? AND subjects.github_number = ? AND subjects.kind = ?
      `).get(repository.id, input.subject.number, input.subject.kind) as {
        id: number
        current_revision_id: string | null
        current_payload: string | null
        current_source: 'poll' | 'webhook' | null
      }
      const mapping = JSON.parse(repository.policy_json) as RepositoryMapping
      const dismissed = (): boolean =>
        database.prepare('SELECT 1 FROM item_dismissals WHERE subject_id = ?').get(subject.id) !== undefined
      const planCurrentWork = (): void => {
        // A Dismissal outranks every planner. Nothing is queued, whatever changed.
        if (dismissed()) {
          cancelSubjectTasks(database, subject.id, input.observedAt, 'The item is dismissed.')
          return
        }
        if (input.subject.state === 'closed') {
          cancelSubjectTasks(
            database,
            subject.id,
            input.observedAt,
            input.subject.kind === 'pull_request' ? 'The pull request closed.' : 'The issue closed.',
          )
          return
        }
        if (input.subject.kind === 'pull_request') {
          // Every mutation Task is claimable only on the subject's current
          // Revision, so one left on an older Revision can never run again. It
          // still holds the one active Task slot for its kind, which blocked
          // the next Repair. Two sat Queued for a fortnight before this.
          supersedeTasks(
            database,
            subject.id,
            input.observedAt,
            'A newer pull request Revision replaced this Repair.',
            revisionId,
            'review_fix',
          )
          supersedeTasks(
            database,
            subject.id,
            input.observedAt,
            'A newer pull request Revision replaced this Baseline repair.',
            revisionId,
            'baseline_repair',
          )
          supersedeTasks(
            database,
            subject.id,
            input.observedAt,
            'A newer pull request Revision replaced this conflict resolution.',
            revisionId,
            'resolve_conflict',
          )
        }
        if (input.subject.kind === 'pull_request' && requiresPullRequestApproval(database, mapping, input.subject.author)) {
          const approvedRepair = database.prepare(`
            SELECT 1
            FROM publication_commands
            JOIN tasks ON tasks.id = publication_commands.task_id
            WHERE tasks.subject_id = ? AND tasks.kind = 'review_fix'
              AND publication_commands.state_tag = 'Published'
              AND publication_commands.commit_sha = ?
              AND EXISTS (
                SELECT 1 FROM pull_request_approvals
                WHERE pull_request_approvals.subject_id = tasks.subject_id
                  AND pull_request_approvals.revision_id = tasks.revision_id
                  AND pull_request_approvals.kind = 'review'
              )
            LIMIT 1
          `).get(subject.id, input.subject.headSha)
          if (approvedRepair !== undefined) {
            database.prepare(`
              INSERT OR IGNORE INTO pull_request_approvals (subject_id, revision_id, kind, approved_at)
              VALUES (?, ?, 'review', ?), (?, ?, 'fixes', ?)
            `).run(subject.id, revisionId, input.observedAt, subject.id, revisionId, input.observedAt)
          }
        }
        const reviewApproved = database.prepare(`
          SELECT 1 FROM pull_request_approvals
          WHERE subject_id = ? AND revision_id = ? AND kind = 'review'
        `).get(subject.id, revisionId) !== undefined
        planConflictResolution(database, input.subject, subject.id, revisionId, input.observedAt, mapping, reviewApproved)
        planAdversarialReview(
          database,
          input.subject,
          subject.id,
          revisionId,
          input.observedAt,
          mapping,
          reviewApproved,
          input.subject.kind === 'pull_request' && input.subject.approvalLabels.includes('review'),
        )
        planIssueTriage(database, input.subject, subject.id, revisionId, input.observedAt, mapping)
      }
      const isStaleAgainstCurrent = (current: GitHubItem, currentRevisionId: string): boolean => {
        const older = input.subject.updatedAt < current.updatedAt
        const weakerAtSameVersion = input.subject.updatedAt === current.updatedAt
          && input.source === 'webhook'
          && subject.current_source === 'poll'
        if (!older && !weakerAtSameVersion)
          return false
        if (
          !exactPullRequest
          || input.subject.kind !== 'pull_request'
          || current.kind !== 'pull_request'
          || current.state !== 'closed'
          || subject.current_source !== 'poll'
          || input.subject.headSha !== current.headSha
          || input.subject.baseSha !== current.baseSha
        ) {
          return true
        }
        const inferredClosure = database.prepare(`
          SELECT 1 FROM observations
          WHERE subject_id = ? AND revision_id = ? AND external_id = ?
        `).get(subject.id, currentRevisionId, inferredClosureObservationId(current, current.updatedAt)) !== undefined
        if (!inferredClosure)
          return true
        return database.prepare(`
          SELECT 1 FROM pull_request_closure_verifications
          WHERE subject_id = ? AND revision_id = ?
        `).get(subject.id, currentRevisionId) !== undefined
      }

      if (external !== undefined) {
        if (subject.current_payload !== null && subject.current_revision_id !== null) {
          const current = JSON.parse(subject.current_payload) as GitHubItem
          if (isStaleAgainstCurrent(current, subject.current_revision_id)) {
            database.exec('COMMIT')
            return { _tag: 'Stale', revisionId, currentRevisionId: subject.current_revision_id }
          }
        }
        database.prepare('UPDATE revisions SET observed_at = ?, source = ?, payload = ? WHERE id = ?')
          .run(input.observedAt, input.source, payload, revisionId)
        database.prepare('UPDATE subjects SET current_revision_id = ? WHERE id = ?').run(revisionId, subject.id)
        planCurrentWork()
        database.exec('COMMIT')
        return { _tag: 'Duplicate', revisionId }
      }

      const revisionExists = database.prepare('SELECT 1 FROM revisions WHERE id = ?').get(revisionId) !== undefined
      database.prepare(`
        INSERT OR IGNORE INTO revisions (id, subject_id, observed_at, source, payload)
        VALUES (?, ?, ?, ?, ?)
      `).run(revisionId, subject.id, input.observedAt, input.source, payload)
      database.prepare(`
        INSERT INTO observations (external_id, subject_id, revision_id, observed_at, source)
        VALUES (?, ?, ?, ?, ?)
      `).run(input.externalId, subject.id, revisionId, input.observedAt, input.source)

      if (subject.current_payload !== null && subject.current_revision_id !== null) {
        const current = JSON.parse(subject.current_payload) as GitHubItem
        if (isStaleAgainstCurrent(current, subject.current_revision_id)) {
          database.exec('COMMIT')
          return { _tag: 'Stale', revisionId, currentRevisionId: subject.current_revision_id }
        }
      }

      if (revisionExists) {
        database.prepare(`
          UPDATE revisions SET observed_at = ?, source = ?, payload = ? WHERE id = ?
        `).run(input.observedAt, input.source, payload, revisionId)
      }

      database.prepare('UPDATE subjects SET current_revision_id = ? WHERE id = ?').run(revisionId, subject.id)
      planCurrentWork()

      database.exec('COMMIT')
      return revisionExists ? { _tag: 'Duplicate', revisionId } : { _tag: 'Inserted', revisionId }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const recordObservation: JournalStore['recordObservation'] = input => writeObservation(input, false)

  const recordExactPullRequestObservation: JournalStore['recordExactPullRequestObservation'] = input => writeObservation({
    ...input,
    source: 'poll',
  }, true)

  const storedApprovalState = (input: {
    subjectId: number
    revisionId: string
    mapping: RepositoryMapping
    author: string
  }): PullRequestApprovalState => {
    const approvals = database.prepare(`
      SELECT MAX(CASE WHEN kind = 'review' THEN approved_at END) AS review_approved_at
      FROM pull_request_approvals
      WHERE subject_id = ? AND revision_id = ?
    `).get(input.subjectId, input.revisionId) as { review_approved_at: string | null }
    return pullRequestApprovalState(database, {
      mapping: input.mapping,
      author: input.author,
      reviewApprovedAt: approvals.review_approved_at,
    })
  }

  const approvePullRequest: JournalStore['approvePullRequest'] = (input) => {
    const row = database.prepare(`
      SELECT subjects.id AS subject_id, subjects.current_revision_id, revisions.payload, repositories.policy_json
      FROM subjects
      JOIN repositories ON repositories.id = subjects.repository_id
      LEFT JOIN revisions ON revisions.id = subjects.current_revision_id
      WHERE repositories.github = ? AND subjects.github_number = ? AND subjects.kind = 'pull_request'
    `).get(input.repository, input.pullRequestNumber) as {
      subject_id: number
      current_revision_id: string | null
      payload: string | null
      policy_json: string
    } | undefined
    if (row === undefined || row.payload === null)
      return { _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }
    if (row.current_revision_id !== input.revisionId)
      return { _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }

    const pullRequest = JSON.parse(row.payload) as GitHubItem
    if (pullRequest.kind !== 'pull_request' || pullRequest.state !== 'open')
      return { _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }
    const mapping = JSON.parse(row.policy_json) as RepositoryMapping
    if (input.kind === 'review' && !requiresPullRequestApproval(database, mapping, pullRequest.author))
      return { _tag: 'Rejected', reason: { _tag: 'ApprovalNotRequired' } }

    database.exec('BEGIN IMMEDIATE')
    try {
      const inserted = database.prepare(`
        INSERT OR IGNORE INTO pull_request_approvals (subject_id, revision_id, kind, approved_at)
        VALUES (?, ?, ?, ?)
      `).run(row.subject_id, input.revisionId, input.kind, input.at)
      const approval = storedApprovalState({
        subjectId: row.subject_id,
        revisionId: input.revisionId,
        mapping,
        author: pullRequest.author,
      })
      planAdversarialReview(database, pullRequest, row.subject_id, input.revisionId, input.at, mapping, true, true)
      database.exec('COMMIT')
      return { _tag: inserted.changes === 1 ? 'Approved' : 'Duplicate', approval }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const approveIssueWork: JournalStore['approveIssueWork'] = (input) => {
    const row = database.prepare(`
      SELECT subjects.id AS subject_id, subjects.current_revision_id, revisions.payload,
        repositories.policy_json, worker_tasks.evidence AS triage_evidence
      FROM subjects
      JOIN repositories ON repositories.id = subjects.repository_id
      LEFT JOIN revisions ON revisions.id = subjects.current_revision_id
      LEFT JOIN worker_tasks ON worker_tasks.subject_id = subjects.id
        AND worker_tasks.revision_id = subjects.current_revision_id
        AND worker_tasks.kind = 'issue_triage' AND worker_tasks.state_tag = 'Completed'
      WHERE repositories.github = ? AND subjects.github_number = ? AND subjects.kind = 'issue'
    `).get(input.repository, input.issueNumber) as {
      subject_id: number
      current_revision_id: string | null
      payload: string | null
      policy_json: string
      triage_evidence: string | null
    } | undefined
    if (row === undefined || row.payload === null)
      return { _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }
    if (row.current_revision_id !== input.revisionId)
      return { _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }

    const issue = JSON.parse(row.payload) as GitHubItem
    if (issue.kind !== 'issue' || issue.state !== 'open')
      return { _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }
    const mapping = JSON.parse(row.policy_json) as RepositoryMapping
    if (!canWorkIssues(mapping))
      return { _tag: 'Rejected', reason: { _tag: 'NotAuthorized' } }
    if (!requiresIssueApproval(mapping, issue.author))
      return { _tag: 'Rejected', reason: { _tag: 'ApprovalNotRequired' } }
    if (issueTriageState(row.triage_evidence) !== 'READY_TO_IMPLEMENT')
      return { _tag: 'Rejected', reason: { _tag: 'TriageRequired' } }

    database.exec('BEGIN IMMEDIATE')
    try {
      const queued = queueIssueWork(database, row.subject_id, input.revisionId, issue, mapping, input.at)
      database.exec('COMMIT')
      return { _tag: queued.inserted ? 'Approved' : 'Duplicate', taskId: queued.taskId }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const isIssueWorkApprovalReady: JournalStore['isIssueWorkApprovalReady'] = (repository, issueNumber, revisionId) => {
    const row = database.prepare(`
      SELECT subjects.current_revision_id, revisions.payload, repositories.policy_json,
        worker_tasks.evidence AS triage_evidence,
        EXISTS (
          SELECT 1 FROM tasks
          WHERE tasks.subject_id = subjects.id
            AND tasks.revision_id = subjects.current_revision_id
            AND tasks.kind = 'issue_work'
            AND tasks.state_tag != 'Superseded'
        ) AS work_exists
      FROM subjects
      JOIN repositories ON repositories.id = subjects.repository_id
      LEFT JOIN revisions ON revisions.id = subjects.current_revision_id
      LEFT JOIN worker_tasks ON worker_tasks.subject_id = subjects.id
        AND worker_tasks.revision_id = subjects.current_revision_id
        AND worker_tasks.kind = 'issue_triage' AND worker_tasks.state_tag = 'Completed'
      WHERE repositories.github = ? AND subjects.github_number = ? AND subjects.kind = 'issue'
    `).get(repository, issueNumber) as {
      current_revision_id: string | null
      payload: string | null
      policy_json: string
      triage_evidence: string | null
      work_exists: number
    } | undefined
    if (row === undefined || row.current_revision_id !== revisionId || row.payload === null || row.triage_evidence === null || row.work_exists === 1)
      return false
    const issue = JSON.parse(row.payload) as GitHubItem
    const mapping = JSON.parse(row.policy_json) as RepositoryMapping
    return issue.kind === 'issue'
      && issue.state === 'open'
      && canWorkIssues(mapping)
      && requiresIssueApproval(mapping, issue.author)
      && issueTriageState(row.triage_evidence) === 'READY_TO_IMPLEMENT'
  }

  const hasPullRequestApproval: JournalStore['hasPullRequestApproval'] = (repository, pullRequestNumber, revisionId, kind) => database.prepare(`
    SELECT 1
    FROM pull_request_approvals
    JOIN subjects ON subjects.id = pull_request_approvals.subject_id
    JOIN repositories ON repositories.id = subjects.repository_id
    JOIN revisions ON revisions.id = subjects.current_revision_id
    WHERE repositories.github = ? AND subjects.kind = 'pull_request'
      AND subjects.github_number = ? AND subjects.current_revision_id = ?
      AND pull_request_approvals.revision_id = ? AND pull_request_approvals.kind = ?
      AND json_extract(revisions.payload, '$.state') = 'open'
  `).get(repository, pullRequestNumber, revisionId, revisionId, kind) !== undefined

  const listOpenItemNumbers = (github: string, kind: GitHubItem['kind']): number[] => (database.prepare(`
    SELECT subjects.github_number
    FROM subjects
    JOIN repositories ON repositories.id = subjects.repository_id
    JOIN revisions ON revisions.id = subjects.current_revision_id
    WHERE repositories.github = ?
      AND subjects.kind = ?
      AND json_extract(revisions.payload, '$.state') = 'open'
    ORDER BY subjects.github_number
  `).all(github, kind) as unknown as Array<{ github_number: number }>).map(row => row.github_number)

  const listOpenIssueNumbers: JournalStore['listOpenIssueNumbers'] = github => listOpenItemNumbers(github, 'issue')
  const listOpenPullRequestNumbers: JournalStore['listOpenPullRequestNumbers'] = github => listOpenItemNumbers(github, 'pull_request')

  const listUnverifiedClosedPullRequestNumbers: JournalStore['listUnverifiedClosedPullRequestNumbers'] = (github, limit = 5) => {
    const safeLimit = Math.max(0, Math.min(20, Math.trunc(limit)))
    return (database.prepare(`
      SELECT subjects.github_number
      FROM subjects
      JOIN repositories ON repositories.id = subjects.repository_id
      JOIN revisions ON revisions.id = subjects.current_revision_id
      WHERE repositories.github = ?
        AND subjects.kind = 'pull_request'
        AND json_extract(revisions.payload, '$.state') = 'closed'
        AND NOT EXISTS (
          SELECT 1 FROM pull_request_closure_verifications AS verification
          WHERE verification.subject_id = subjects.id AND verification.revision_id = revisions.id
        )
        AND (
          EXISTS (
            SELECT 1 FROM review_status_commands AS status
            JOIN revisions AS status_revision ON status_revision.id = status.revision_id
            WHERE status_revision.subject_id = subjects.id AND status.state_tag = 'Published'
          )
          OR EXISTS (
            SELECT 1 FROM review_publications AS publication
            JOIN review_runs ON review_runs.id = publication.review_run_id
            WHERE review_runs.subject_id = subjects.id AND publication.result_tag = 'Published'
          )
        )
        AND (
          EXISTS (
            SELECT 1 FROM worker_tasks
            WHERE worker_tasks.subject_id = subjects.id AND worker_tasks.kind = 'adversarial_review'
              AND worker_tasks.state_tag IN ('Completed', 'Failed', 'ActionRequired', 'Superseded')
          )
          OR EXISTS (
            SELECT 1 FROM tasks
            WHERE tasks.subject_id = subjects.id AND tasks.kind = 'review_fix'
              AND tasks.state_tag IN ('Completed', 'Failed', 'ActionRequired', 'Superseded')
          )
        )
      ORDER BY revisions.observed_at DESC, subjects.github_number DESC
      LIMIT ?
    `).all(github, safeLimit) as unknown as Array<{ github_number: number }>).map(row => row.github_number)
  }

  const closeMissingItems: JournalStore['closeMissingItems'] = (github, seen, observedAt) => {
    const seenKeys = new Set(seen.map(subject => `${subject.kind}:${subject.number}`))
    const rows = database.prepare(`
      SELECT
        repositories.github AS repository,
        repositories.policy_json,
        subjects.id AS subject_id,
        subjects.github_number,
        subjects.kind,
        json_extract(revisions.payload, '$.state') AS state,
        json_extract(revisions.payload, '$.title') AS title,
        json_extract(revisions.payload, '$.author') AS author,
        json_extract(revisions.payload, '$.url') AS url,
        json_extract(revisions.payload, '$.createdAt') AS github_created_at,
        json_extract(revisions.payload, '$.updatedAt') AS github_updated_at,
        json_extract(revisions.payload, '$.contentDigest') AS content_digest,
        json_extract(revisions.payload, '$.draft') AS draft,
        json_extract(revisions.payload, '$.baseSha') AS base_sha,
        json_extract(revisions.payload, '$.headSha') AS head_sha,
        json_extract(revisions.payload, '$.headRepository') AS head_repository,
        json_extract(revisions.payload, '$.headRef') AS head_ref,
        json_extract(revisions.payload, '$.mergeState') AS merge_state,
        json_extract(revisions.payload, '$.mergedAt') AS merged_at,
        json_extract(revisions.payload, '$.purpose._tag') AS purpose_tag,
        json_extract(revisions.payload, '$.purpose.baseShaPrefix') AS purpose_base_sha_prefix,
        revisions.id AS revision_id,
        revisions.observed_at
      FROM subjects
      JOIN repositories ON repositories.id = subjects.repository_id
      JOIN revisions ON revisions.id = subjects.current_revision_id
      WHERE repositories.github = ? AND json_extract(revisions.payload, '$.state') = 'open'
    `).all(github) as unknown as SubjectRow[]
    const missing = rows.filter(row => !seenKeys.has(`${row.kind}:${row.github_number}`))
    missing.forEach((row) => {
      const current = githubSubjectFromRow(row)
      const subject: GitHubItem = current.kind === 'issue'
        ? {
            kind: 'issue',
            approvalLabels: [],
            contentDigest: current.contentDigest,
            routineFiled: false,
            routineTracking: false,
            repository: current.repository,
            number: current.number,
            state: 'closed',
            title: current.title,
            author: current.author,
            url: current.url,
            createdAt: current.createdAt,
            updatedAt: observedAt,
          }
        : {
            kind: 'pull_request',
            approvalLabels: [],
            autoMerge: false,
            repository: current.repository,
            number: current.number,
            state: 'closed',
            mergedAt: current.mergedAt,
            title: current.title,
            author: current.author,
            url: current.url,
            createdAt: current.createdAt,
            updatedAt: observedAt,
            draft: current.draft,
            baseSha: current.baseSha,
            headSha: current.headSha,
            headRepository: current.headRepository,
            headRef: current.headRef,
            mergeState: 'unknown',
            purpose: current.purpose,
            priorAutomatedReview: { _tag: 'None' },
          }
      recordObservation({
        externalId: inferredClosureObservationId(subject, observedAt),
        observedAt,
        source: 'poll',
        subject,
      })
    })
    return missing.length
  }

  const recordIncident: JournalStore['recordIncident'] = input => upsertIncident(database, input)

  const resolveIncidents: JournalStore['resolveIncidents'] = (scope, at, operation, exceptMessages = []) => {
    const operationClause = operation === undefined ? '' : ' AND operation = ?'
    const operationArgs = operation === undefined ? [] : [operation]
    const exceptClause = exceptMessages.length === 0 ? '' : ` AND message NOT IN (${exceptMessages.map(() => '?').join(', ')})`
    const filterArgs = [...operationArgs, ...exceptMessages]
    const changes = scope._tag === 'Service'
      ? database.prepare(`
        UPDATE incidents SET resolved_at = ? WHERE resolved_at IS NULL AND scope_tag = 'Service'${operationClause}${exceptClause}
      `).run(at, ...filterArgs).changes
      : scope._tag === 'Repository'
        ? database.prepare(`
          UPDATE incidents SET resolved_at = ?
          WHERE resolved_at IS NULL AND scope_tag = 'Repository' AND repository = ?${operationClause}${exceptClause}
        `).run(at, scope.repository, ...filterArgs).changes
        : database.prepare(`
          UPDATE incidents SET resolved_at = ?
          WHERE resolved_at IS NULL AND scope_tag = 'Task' AND task_id = ?${operationClause}${exceptClause}
        `).run(at, scope.taskId, ...filterArgs).changes
    return Number(changes)
  }

  const listIncidents: JournalStore['listIncidents'] = () => {
    const rows = database.prepare(`
      SELECT * FROM incidents WHERE resolved_at IS NULL
      ORDER BY last_seen_at DESC LIMIT 50
    `).all() as unknown as IncidentRow[]
    return rows.map(incidentFromRow)
  }

  const recordPollAttempt = (github: string, at: string): void => {
    database.prepare('UPDATE repositories SET last_attempt_at = ? WHERE github = ?').run(at, github)
  }

  const recordPollSuccess = (github: string, at: string): void => {
    const recovering = database.prepare(
      'SELECT last_error FROM repositories WHERE github = ? AND last_error IS NOT NULL',
    ).get(github) !== undefined
    database.prepare(`
      UPDATE repositories SET last_attempt_at = ?, last_success_at = ?, last_error = NULL WHERE github = ?
    `).run(at, at, github)
    resolveIncidents({ _tag: 'Repository', repository: github }, at)
    // Edge triggered, on the poll that recovers. A long GitHub outage spends the
    // whole recovery budget of every Task it touches, and those Tasks would then
    // stay dead after GitHub came back. Checking `last_error` first keeps this
    // from firing on every healthy poll, which would retry a genuinely broken
    // Task forever.
    if (recovering)
      restoreRecoveryBudget(database, github, at)
  }

  const resolveStaleTaskIncidents: JournalStore['resolveStaleTaskIncidents'] = (at) => {
    // An Incident belongs to the current failure of work that can still run.
    // Startup repairs journals written before that invariant was enforced.
    const stale = (table: 'tasks' | 'worker_tasks') => `
      UPDATE incidents SET resolved_at = ?
      WHERE resolved_at IS NULL AND scope_tag = 'Task' AND task_id IN (
        SELECT ${table}.id FROM ${table}
        JOIN subjects ON subjects.id = ${table}.subject_id
        WHERE (${table}.state_tag IN ('Completed', 'Superseded')
          OR ${table}.revision_id != subjects.current_revision_id
          OR (${table}.state_tag = 'Failed' AND incidents.message != ${table}.reason)
          OR incidents.kind = 'agent_provider')
      )
    `
    const resolved = (['tasks', 'worker_tasks'] as const)
      .reduce((total, table) => total + Number(database.prepare(stale(table)).run(at).changes), 0)

    // Provider failures now share one Service-scoped Incident per message. It
    // belongs to the Task that raised it, so once no current Failed Task still
    // carries that reason the Incident is stale and must not linger after the
    // work that caused it is superseded or closed.
    const serviceProviderResolved = Number(database.prepare(`
      UPDATE incidents SET resolved_at = ?
      WHERE resolved_at IS NULL AND scope_tag = 'Service' AND kind = 'agent_provider'
        AND NOT EXISTS (
          SELECT 1 FROM tasks t
          JOIN subjects s ON s.id = t.subject_id
          JOIN repositories r ON r.id = s.repository_id
          WHERE t.state_tag = 'Failed'
            AND t.revision_id = s.current_revision_id
            AND r.enabled = 1
            AND t.reason = incidents.message
        )
        AND NOT EXISTS (
          SELECT 1 FROM worker_tasks wt
          JOIN subjects ws ON ws.id = wt.subject_id
          JOIN repositories wr ON wr.id = ws.repository_id
          WHERE wt.state_tag = 'Failed'
            AND wt.revision_id = ws.current_revision_id
            AND wr.enabled = 1
            AND wt.reason = incidents.message
        )
    `).run(at).changes)

    for (const table of ['tasks', 'worker_tasks'] as const) {
      const missing = database.prepare(`
        SELECT ${table}.id, ${table}.reason
        FROM ${table}
        JOIN subjects ON subjects.id = ${table}.subject_id
        JOIN repositories ON repositories.id = subjects.repository_id
        WHERE ${table}.state_tag = 'Failed'
          AND ${table}.reason IS NOT NULL
          AND ${table}.revision_id = subjects.current_revision_id
          AND repositories.enabled = 1
          AND NOT EXISTS (
            SELECT 1 FROM incidents
            WHERE incidents.resolved_at IS NULL
              AND incidents.message = ${table}.reason
              AND ((incidents.scope_tag = 'Task' AND incidents.task_id = ${table}.id)
                OR (incidents.scope_tag = 'Service' AND incidents.kind = 'agent_provider'))
          )
      `).all() as unknown as Array<{ id: string, reason: string }>
      for (const task of missing)
        recordTaskIncident(database, task.id, task.reason, at)
    }
    return resolved + serviceProviderResolved
  }

  const restoreOutageRecoveryBudget: JournalStore['restoreOutageRecoveryBudget'] = (at) => {
    // Only repositories GitHub is answering right now. A repository still
    // failing has said nothing that would justify giving its budget back.
    const healthy = database.prepare(`
      SELECT github FROM repositories WHERE enabled = 1 AND last_error IS NULL AND last_success_at IS NOT NULL
    `).all() as unknown as Array<{ github: string }>
    return healthy.reduce((total, row) => total + restoreRecoveryBudget(database, row.github, at), 0)
  }

  const recordPollFailure = (github: string, at: string, message: string, status?: number): void => {
    database.prepare('UPDATE repositories SET last_attempt_at = ?, last_error = ? WHERE github = ?').run(at, message, github)
    const failure = classifyFailure({ message, status })
    recordIncident({
      scope: { _tag: 'Repository', repository: github },
      kind: failure.kind,
      severity: failure._tag === 'Transient' ? 'warning' : 'error',
      operation: 'poll',
      message,
      recovery: failure._tag === 'Transient' ? { _tag: 'Retrying', attempt: 0, nextAttemptAt: at } : { _tag: 'ActionRequired' },
      at,
    })
  }

  const recordPullRequestTriageRun: JournalStore['recordPullRequestTriageRun'] = (input) => {
    const revision = database.prepare(`
      SELECT worker_tasks.subject_id, revisions.payload
      FROM worker_tasks
      JOIN subjects ON subjects.id = worker_tasks.subject_id
      JOIN repositories ON repositories.id = subjects.repository_id
      JOIN revisions ON revisions.id = worker_tasks.revision_id
      WHERE worker_tasks.id = ? AND worker_tasks.kind = 'adversarial_review'
        AND repositories.github = ? AND subjects.github_number = ?
        AND worker_tasks.revision_id = ? AND revisions.id = ?
    `).get(
      input.taskId,
      input.repository,
      input.pullRequestNumber,
      input.revisionId,
      input.revisionId,
    ) as { subject_id: number, payload: string } | undefined
    const subject = revision === undefined ? undefined : JSON.parse(revision.payload) as GitHubItem
    if (revision === undefined || subject?.kind !== 'pull_request' || subject.headSha !== input.headSha)
      return { _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }

    const contentDigest = digest(JSON.stringify(input))
    database.exec('BEGIN IMMEDIATE')
    try {
      const existing = database.prepare(`
        SELECT head_sha, outcome_tag FROM pull_request_triage_runs
        WHERE task_id = ? OR (subject_id = ? AND revision_id = ?)
      `).get(input.taskId, revision.subject_id, input.revisionId) as {
        head_sha: string
        outcome_tag: 'ReviewRequired' | 'ReviewSkipped' | 'ReviewRequiredAfterFailure'
      } | undefined
      if (existing !== undefined) {
        database.exec('COMMIT')
        // The reason is Agent-authored prose, so a retry rewords it. Only the
        // head commit and the outcome tag define the decision; the first
        // stored reason stays authoritative for stats.
        const sameDecision = existing.head_sha === input.headSha
          && existing.outcome_tag === input.outcome._tag
        return sameDecision ? { _tag: 'Duplicate' } : { _tag: 'Conflict' }
      }
      database.prepare(`
        INSERT INTO pull_request_triage_runs (
          task_id, subject_id, revision_id, head_sha, started_at, completed_at,
          outcome_tag, reason, content_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.taskId,
        revision.subject_id,
        input.revisionId,
        input.headSha,
        input.startedAt,
        input.completedAt,
        input.outcome._tag,
        input.outcome.reason,
        contentDigest,
      )
      database.prepare(`
        UPDATE stats_coverage SET started_at = MIN(started_at, ?)
        WHERE kind = 'pull_request_triage'
      `).run(input.startedAt)
      database.exec('COMMIT')
      return { _tag: 'Inserted' }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const recordReviewRun: JournalStore['recordReviewRun'] = (input) => {
    const outcome = reviewOutcome(input)
    if (outcome._tag === 'Rejected')
      return outcome

    const revision = database.prepare(`
      SELECT subjects.id AS subject_id, revisions.payload, repositories.policy_json,
        (
          SELECT worker_tasks.id
          FROM worker_tasks
          WHERE worker_tasks.subject_id = subjects.id
            AND worker_tasks.revision_id = revisions.id
            AND worker_tasks.kind = 'adversarial_review'
          ORDER BY
            CASE worker_tasks.state_tag
              WHEN 'Running' THEN 0
              WHEN 'Queued' THEN 1
              ELSE 2
            END,
            worker_tasks.updated_at DESC
          LIMIT 1
        ) AS review_task_id,
        EXISTS (
          SELECT 1 FROM pull_request_approvals
          WHERE subject_id = subjects.id AND revision_id = revisions.id AND kind = 'review'
        ) AS review_approved
      FROM revisions
      JOIN subjects ON subjects.id = revisions.subject_id
      JOIN repositories ON repositories.id = subjects.repository_id
      WHERE repositories.github = ? AND subjects.github_number = ?
        AND subjects.kind = 'pull_request' AND revisions.id = ?
        AND subjects.current_revision_id = revisions.id
    `).get(input.repository, input.pullRequestNumber, input.revisionId) as {
      subject_id: number
      payload: string
      policy_json: string
      review_task_id: string | null
      review_approved: number
    } | undefined
    const pullRequest = revision === undefined ? undefined : JSON.parse(revision.payload) as GitHubItem
    if (revision === undefined || pullRequest?.kind !== 'pull_request' || pullRequest.headSha !== input.headSha)
      return { _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }
    const mapping = JSON.parse(revision.policy_json) as RepositoryMapping
    if (requiresPullRequestApproval(database, mapping, pullRequest.author) && revision.review_approved !== 1)
      return { _tag: 'Rejected', reason: { _tag: 'ReviewApprovalRequired' } }

    const runUsage: AgentTokenUsage = input.usage ?? { _tag: 'Unavailable' }
    const policyDigest = input.policyDigest ?? digest(revision.policy_json)
    const gates = JSON.stringify(input.gates)
    const findings = JSON.stringify(input.findings)
    const usage = JSON.stringify(runUsage)
    const contentDigest = digest(JSON.stringify({
      repository: input.repository,
      pullRequestNumber: input.pullRequestNumber,
      revisionId: input.revisionId,
      headSha: input.headSha,
      provider: input.provider,
      sessionId: input.sessionId,
      model: input.model,
      agentVersion: input.agentVersion,
      skillDigest: input.skillDigest,
      policyDigest,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      usage: runUsage,
      gates: input.gates,
      outcome,
      findings: input.findings,
    }))

    database.exec('BEGIN IMMEDIATE')
    try {
      const existing = database.prepare('SELECT content_digest FROM review_runs WHERE id = ?').get(input.id) as { content_digest: string } | undefined
      if (existing !== undefined) {
        database.exec('COMMIT')
        return existing.content_digest === contentDigest
          ? { _tag: 'Duplicate', reviewRunId: input.id }
          : { _tag: 'Conflict', reviewRunId: input.id }
      }
      database.prepare(`
        INSERT INTO review_runs (
          id, subject_id, revision_id, kind, provider, session_id, model, agent_version,
          skill_digest, head_sha, started_at, completed_at, gates, outcome_tag,
          confidence, findings, content_digest, usage
        ) VALUES (?, ?, ?, 'adversarial_review', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        revision.subject_id,
        input.revisionId,
        input.provider,
        input.sessionId,
        input.model,
        input.agentVersion,
        input.skillDigest,
        input.headSha,
        input.startedAt,
        input.completedAt,
        gates,
        outcome._tag,
        input.confidence ?? null,
        findings,
        contentDigest,
        usage,
      )
      database.prepare(`
        INSERT INTO review_evidence_scopes (review_run_id, policy_digest, created_at)
        VALUES (?, ?, ?)
      `).run(input.id, policyDigest, input.completedAt)
      database.prepare(`
        INSERT INTO review_gate_projections (
          review_run_id, gates, outcome_tag, confidence, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(input.id, gates, outcome._tag, input.confidence ?? null, input.completedAt)
      recordWorkflowEvent(database, {
        stream: 'review_run',
        event: 'Completed',
        entityId: input.id,
        repository: input.repository,
        itemNumber: input.pullRequestNumber,
        revisionId: input.revisionId,
        taskId: revision.review_task_id,
        from: 'Running',
        to: 'Completed',
        usage: runUsage,
        durationMilliseconds: Math.max(0, Date.parse(input.completedAt) - Date.parse(input.startedAt)),
        at: input.completedAt,
      })
      const repairableFinding = input.findings.some(finding => finding._tag === 'Open' && finding.resolution !== 'Dismissal')
      if (!repairableFinding) {
        supersedeTasks(
          database,
          revision.subject_id,
          input.completedAt,
          'A fresh Review found no repairable finding.',
          undefined,
          'review_fix',
        )
      }
      database.exec('COMMIT')
      return { _tag: 'Inserted', reviewRunId: input.id }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const supersedeReviewRun: JournalStore['supersedeReviewRun'] = (input) => {
    const outcome = reviewOutcome(input)
    if (outcome._tag === 'Rejected')
      return outcome

    const revision = database.prepare(`
      SELECT subjects.id AS subject_id, revisions.payload, repositories.policy_json,
        EXISTS (
          SELECT 1 FROM pull_request_approvals
          WHERE subject_id = subjects.id AND revision_id = revisions.id AND kind = 'review'
        ) AS review_approved
      FROM revisions
      JOIN subjects ON subjects.id = revisions.subject_id
      JOIN repositories ON repositories.id = subjects.repository_id
      WHERE repositories.github = ? AND subjects.github_number = ?
        AND subjects.kind = 'pull_request' AND revisions.id = ?
        AND subjects.current_revision_id = revisions.id
    `).get(input.repository, input.pullRequestNumber, input.revisionId) as {
      subject_id: number
      payload: string
      policy_json: string
      review_approved: number
    } | undefined
    const pullRequest = revision === undefined ? undefined : JSON.parse(revision.payload) as GitHubItem
    if (revision === undefined || pullRequest?.kind !== 'pull_request' || pullRequest.headSha !== input.headSha)
      return { _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }
    const mapping = JSON.parse(revision.policy_json) as RepositoryMapping
    if (requiresPullRequestApproval(database, mapping, pullRequest.author) && revision.review_approved !== 1)
      return { _tag: 'Rejected', reason: { _tag: 'ReviewApprovalRequired' } }

    const runUsage: AgentTokenUsage = input.usage ?? { _tag: 'Unavailable' }
    const policyDigest = input.policyDigest ?? digest(revision.policy_json)
    const gates = JSON.stringify(input.gates)
    const findings = JSON.stringify(input.findings)
    const usage = JSON.stringify(runUsage)
    const contentDigest = digest(JSON.stringify({
      supersedesReviewRunId: input.supersedesReviewRunId,
      repository: input.repository,
      pullRequestNumber: input.pullRequestNumber,
      revisionId: input.revisionId,
      headSha: input.headSha,
      provider: input.provider,
      sessionId: input.sessionId,
      model: input.model,
      agentVersion: input.agentVersion,
      skillDigest: input.skillDigest,
      policyDigest,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      usage: runUsage,
      gates: input.gates,
      outcome,
      findings: input.findings,
      publication: input.publication,
    }))

    database.exec('BEGIN IMMEDIATE')
    try {
      const existing = database.prepare('SELECT content_digest FROM review_runs WHERE id = ?').get(input.id) as { content_digest: string } | undefined
      if (existing !== undefined) {
        database.exec('COMMIT')
        return existing.content_digest === contentDigest
          ? { _tag: 'Duplicate', reviewRunId: input.id }
          : { _tag: 'Conflict', reviewRunId: input.id }
      }
      // Only a run nothing else settles yet can gain a settlement. The parent
      // may itself be a settlement, because CI and mergeability can move more
      // than once without a new head commit.
      const parent = database.prepare(`
        SELECT 1 FROM review_runs
        WHERE id = ? AND subject_id = ? AND revision_id = ? AND head_sha = ?
          AND NOT EXISTS (
            SELECT 1 FROM review_runs AS settled
            WHERE settled.supersedes_review_run_id = review_runs.id
          )
      `).get(
        input.supersedesReviewRunId,
        revision.subject_id,
        input.revisionId,
        input.headSha,
      )
      if (parent === undefined) {
        const orphaned = database.prepare('SELECT 1 FROM review_runs WHERE id = ?').get(input.supersedesReviewRunId)
        database.exec('COMMIT')
        return orphaned === undefined
          ? { _tag: 'Rejected', reason: { _tag: 'RunNotFound' } }
          : { _tag: 'Rejected', reason: { _tag: 'AlreadySuperseded' } }
      }
      database.prepare(`
        INSERT INTO review_runs (
          id, subject_id, revision_id, kind, provider, session_id, model, agent_version,
          skill_digest, head_sha, started_at, completed_at, gates, outcome_tag,
          confidence, findings, content_digest, usage, supersedes_review_run_id
        ) VALUES (?, ?, ?, 'adversarial_review', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        revision.subject_id,
        input.revisionId,
        input.provider,
        input.sessionId,
        input.model,
        input.agentVersion,
        input.skillDigest,
        input.headSha,
        input.startedAt,
        input.completedAt,
        gates,
        outcome._tag,
        input.confidence ?? null,
        findings,
        contentDigest,
        usage,
        input.supersedesReviewRunId,
      )
      database.prepare(`
        INSERT INTO review_evidence_scopes (review_run_id, policy_digest, created_at)
        VALUES (?, ?, ?)
      `).run(input.id, policyDigest, input.completedAt)
      database.prepare(`
        INSERT INTO review_gate_projections (
          review_run_id, gates, outcome_tag, confidence, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(input.id, gates, outcome._tag, input.confidence ?? null, input.completedAt)
      database.prepare(`
        INSERT INTO review_publications (
          id, review_run_id, body, body_sha256, created_at, result_tag,
          github_comment_id, github_url, reason, content_digest
        ) VALUES (?, ?, ?, ?, ?, 'Published', ?, ?, NULL, ?)
      `).run(
        input.publication.id,
        input.id,
        input.publication.body,
        digest(input.publication.body),
        input.publication.at,
        input.publication.result.githubCommentId,
        input.publication.result.url,
        digest(JSON.stringify({
          reviewRunId: input.id,
          body: input.publication.body,
          at: input.publication.at,
          result: input.publication.result,
        })),
      )
      const repairableFinding = input.findings.some(finding => finding._tag === 'Open' && finding.resolution !== 'Dismissal')
      if (!repairableFinding) {
        supersedeTasks(
          database,
          revision.subject_id,
          input.completedAt,
          'A fresh Review found no repairable finding.',
          undefined,
          'review_fix',
        )
      }
      database.exec('COMMIT')
      return { _tag: 'Inserted', reviewRunId: input.id }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const recordReviewPublication: JournalStore['recordReviewPublication'] = (input) => {
    const bodySha256 = digest(input.body)
    const contentDigest = digest(JSON.stringify({
      reviewRunId: input.reviewRunId,
      body: input.body,
      at: input.at,
      result: input.result,
    }))

    database.exec('BEGIN IMMEDIATE')
    try {
      const attempt = database.prepare('SELECT 1 FROM review_runs WHERE id = ?').get(input.reviewRunId)
      if (attempt === undefined) {
        database.exec('COMMIT')
        return { _tag: 'Rejected', reason: { _tag: 'AttemptNotFound' } }
      }
      const existing = database.prepare('SELECT content_digest FROM review_publications WHERE id = ?').get(input.id) as { content_digest: string } | undefined
      if (existing !== undefined) {
        database.exec('COMMIT')
        return existing.content_digest === contentDigest
          ? { _tag: 'Duplicate', publicationId: input.id }
          : { _tag: 'Conflict', publicationId: input.id }
      }
      const resultFields = input.result._tag === 'Published'
        ? { githubCommentId: input.result.githubCommentId, url: input.result.url, reason: null }
        : { githubCommentId: null, url: null, reason: input.result.reason }
      database.prepare(`
        INSERT INTO review_publications (
          id, review_run_id, body, body_sha256, created_at, result_tag,
          github_comment_id, github_url, reason, content_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.reviewRunId,
        input.body,
        bodySha256,
        input.at,
        input.result._tag,
        resultFields.githubCommentId,
        resultFields.url,
        resultFields.reason,
        contentDigest,
      )
      database.exec('COMMIT')
      return { _tag: 'Inserted', publicationId: input.id }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const countOpenPullRequests: JournalStore['countOpenPullRequests'] = () => {
    const row = database.prepare(`
      SELECT COUNT(*) AS total
      FROM subjects
      JOIN repositories ON repositories.id = subjects.repository_id
      JOIN revisions ON revisions.id = subjects.current_revision_id
      WHERE subjects.kind = 'pull_request'
        AND repositories.enabled = 1
        AND json_extract(revisions.payload, '$.state') = 'open'
        AND json_extract(revisions.payload, '$.controllerOwned') = 1
    `).get() as { total: number }
    return row.total
  }

  const recordAgentFeedback: JournalStore['recordAgentFeedback'] = (input) => {
    const exists = database.prepare('SELECT 1 FROM review_runs WHERE id = ?').get(input.reviewRunId)
    if (exists === undefined)
      return { _tag: 'Rejected', reason: { _tag: 'ReviewRunNotFound' } }
    database.prepare(`
      INSERT INTO agent_feedback (review_run_id, kind, reason, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (review_run_id) DO UPDATE SET
        kind = excluded.kind,
        reason = excluded.reason,
        updated_at = excluded.updated_at
    `).run(input.reviewRunId, input.feedback._tag, input.feedback.reason, input.at, input.at)
    return { _tag: 'Recorded', feedback: { ...input.feedback, updatedAt: input.at } }
  }

  const listAgentFeedback: JournalStore['listAgentFeedback'] = (limit = 10) => {
    const safeLimit = Math.max(0, Math.min(100, Math.trunc(limit)))
    const rows = database.prepare(`
      SELECT
        review_runs.id,
        repositories.github AS repository,
        subjects.github_number,
        review_runs.head_sha,
        review_runs.started_at,
        review_runs.completed_at,
        review_runs.usage,
        review_runs.outcome_tag,
        review_runs.confidence,
        review_runs.findings,
        agent_feedback.kind AS feedback_tag,
        agent_feedback.reason AS feedback_reason,
        agent_feedback.updated_at AS feedback_updated_at,
        (
          SELECT COUNT(*) FROM review_runs AS repeated
          WHERE repeated.subject_id = review_runs.subject_id
            AND repeated.head_sha = review_runs.head_sha
            AND repeated.kind = 'adversarial_review'
            AND repeated.supersedes_review_run_id IS NULL
        ) AS review_runs_for_head
      FROM agent_feedback
      JOIN review_runs ON review_runs.id = agent_feedback.review_run_id
      JOIN subjects ON subjects.id = review_runs.subject_id
      JOIN repositories ON repositories.id = subjects.repository_id
      ORDER BY agent_feedback.updated_at DESC, review_runs.id
      LIMIT ?
    `).all(safeLimit) as unknown as Array<{
      id: string
      repository: string
      github_number: number
      head_sha: string
      started_at: string
      completed_at: string
      usage: string
      outcome_tag: ReviewOutcome['_tag']
      confidence: number | null
      findings: string
      feedback_tag: AgentFeedback['_tag']
      feedback_reason: string | null
      feedback_updated_at: string
      review_runs_for_head: number
    }>
    return rows.map((row): AgentFeedbackSignal => ({
      reviewRunId: row.id,
      repository: row.repository,
      pullRequestNumber: row.github_number,
      headSha: row.head_sha,
      completedAt: row.completed_at,
      durationMs: Date.parse(row.completed_at) - Date.parse(row.started_at),
      reviewRunsForHead: row.review_runs_for_head,
      usage: agentTokenUsageFromJson(row.usage),
      outcome: row.confidence === null ? { _tag: row.outcome_tag } : { _tag: row.outcome_tag, confidence: row.confidence },
      findings: JSON.parse(row.findings) as ReviewFinding[],
      feedback: row.feedback_tag === 'Useful'
        ? { _tag: 'Useful', reason: row.feedback_reason, updatedAt: row.feedback_updated_at }
        : { _tag: row.feedback_tag, reason: row.feedback_reason ?? '', updatedAt: row.feedback_updated_at },
    }))
  }

  const listReviewRuns: JournalStore['listReviewRuns'] = (repository, pullRequestNumber) => {
    const reviewRuns = database.prepare(`
      SELECT
        review_runs.id,
        repositories.github AS repository,
        subjects.github_number,
        review_runs.revision_id,
        review_runs.head_sha,
        review_runs.provider,
        review_runs.session_id,
        review_runs.model,
        review_runs.agent_version,
        review_runs.skill_digest,
        review_runs.started_at,
        review_runs.completed_at,
        review_runs.usage,
        COALESCE(review_gate_projections.gates, review_runs.gates) AS gates,
        COALESCE(review_gate_projections.outcome_tag, review_runs.outcome_tag) AS outcome_tag,
        COALESCE(review_gate_projections.confidence, review_runs.confidence) AS confidence,
        review_runs.findings,
        agent_feedback.kind AS feedback_tag,
        agent_feedback.reason AS feedback_reason,
        agent_feedback.updated_at AS feedback_updated_at
      FROM review_runs
      JOIN subjects ON subjects.id = review_runs.subject_id
      JOIN repositories ON repositories.id = subjects.repository_id
      LEFT JOIN review_gate_projections ON review_gate_projections.review_run_id = review_runs.id
      LEFT JOIN agent_feedback ON agent_feedback.review_run_id = review_runs.id
      WHERE repositories.github = ? AND subjects.github_number = ?
        AND subjects.kind = 'pull_request' AND review_runs.kind = 'adversarial_review'
        AND NOT EXISTS (
          SELECT 1 FROM review_runs AS settled
          WHERE settled.supersedes_review_run_id = review_runs.id
        )
      ORDER BY review_runs.completed_at DESC, review_runs.id
      LIMIT 100
    `).all(repository, pullRequestNumber) as unknown as ReviewRunRow[]
    const publications = database.prepare(`
      SELECT
        review_publications.id,
        review_publications.review_run_id,
        review_publications.body,
        review_publications.body_sha256,
        review_publications.created_at,
        review_publications.result_tag,
        review_publications.github_comment_id,
        review_publications.github_url,
        review_publications.reason
      FROM review_publications
      JOIN review_runs ON review_runs.id = review_publications.review_run_id
      JOIN subjects ON subjects.id = review_runs.subject_id
      JOIN repositories ON repositories.id = subjects.repository_id
      WHERE repositories.github = ? AND subjects.github_number = ?
        AND subjects.kind = 'pull_request'
      ORDER BY review_publications.created_at, review_publications.id
    `).all(repository, pullRequestNumber) as unknown as ReviewPublicationRow[]
    const publicationsByRun = Map.groupBy(publications.map(reviewPublicationFromRow), publication => publication.reviewRunId)
    return reviewRuns.map(row => reviewRunFromRow(row, publicationsByRun.get(row.id) ?? []))
  }

  const getReviewFixFindings: JournalStore['getReviewFixFindings'] = (repository, pullRequestNumber, revisionId) => {
    const row = database.prepare(`
      SELECT review_runs.findings
      FROM review_runs
      JOIN subjects ON subjects.id = review_runs.subject_id
      JOIN repositories ON repositories.id = subjects.repository_id
      WHERE repositories.github = ? AND subjects.github_number = ?
        AND subjects.kind = 'pull_request' AND review_runs.revision_id = ?
        AND review_runs.kind = 'adversarial_review'
      ORDER BY review_runs.completed_at DESC, review_runs.id DESC
      LIMIT 1
    `).get(repository, pullRequestNumber, revisionId) as { findings: string } | undefined
    return row === undefined
      ? []
      : (JSON.parse(row.findings) as ReviewFinding[]).filter(finding => finding._tag === 'Open' && finding.resolution !== 'Dismissal')
  }

  const getRepairedHeadFindings: JournalStore['getRepairedHeadFindings'] = (repository, pullRequestNumber, commitSha) => {
    const repaired = database.prepare(`
      SELECT tasks.revision_id AS revision_id
      FROM publication_commands
      JOIN tasks ON tasks.id = publication_commands.task_id
      JOIN subjects ON subjects.id = tasks.subject_id
      JOIN repositories ON repositories.id = subjects.repository_id
      WHERE repositories.github = ? AND subjects.github_number = ? AND subjects.kind = 'pull_request'
        AND tasks.kind = 'review_fix'
        AND publication_commands.state_tag = 'Published'
        AND publication_commands.commit_sha = ?
      ORDER BY publication_commands.published_at DESC, publication_commands.id DESC
      LIMIT 1
    `).get(repository, pullRequestNumber, commitSha) as { revision_id: string } | undefined
    return repaired === undefined ? [] : getReviewFixFindings(repository, pullRequestNumber, repaired.revision_id)
  }

  const recoverExpiredTasks = (now: string): void => {
    const expired = database.prepare(`
      SELECT id, state_tag, fence FROM tasks
      WHERE state_tag = 'Running' AND lease_expires_at <= ?
    `).all(now) as unknown as Array<{ id: string, state_tag: 'Running', fence: number }>
    expired.forEach((row) => {
      database.prepare(`
        UPDATE tasks SET state_tag = 'Queued', reason = NULL, worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND fence = ?
      `).run(now, row.id, row.fence)
      recordTransition(database, {
        taskId: row.id,
        from: 'Running',
        to: 'Queued',
        reason: 'Worker lease expired.',
        fence: row.fence,
        at: now,
      })
    })
  }

  const claimMutationTask = (
    kind: 'resolve_conflict' | 'review_fix' | 'baseline_repair' | 'issue_work',
    workerId: string,
    now: string,
    leaseMilliseconds: number,
    exactTaskId?: string,
  ): ClaimedConflictResolutionTask | ClaimedReviewFixTask | ClaimedBaselineRepairTask | ClaimedIssueWorkTask | null => {
    database.exec('BEGIN IMMEDIATE')
    try {
      recoverExpiredTasks(now)
      const row = database.prepare(`
        SELECT
          tasks.id,
          tasks.kind,
          repositories.github AS repository,
          subjects.id AS subject_id,
          subjects.github_number,
          tasks.revision_id,
          tasks.state_tag,
          tasks.reason,
          tasks.worker_id,
          tasks.evidence,
          tasks.command_id,
          tasks.fence,
          tasks.lease_expires_at,
          tasks.updated_at,
          repositories.policy_json,
          revisions.payload AS subject_payload
        FROM tasks
        JOIN subjects ON subjects.id = tasks.subject_id
        JOIN repositories ON repositories.id = subjects.repository_id
        JOIN revisions ON revisions.id = tasks.revision_id
        WHERE tasks.kind = ? AND tasks.state_tag = 'Queued'
          AND (? IS NULL OR tasks.id = ?)
          AND tasks.revision_id = subjects.current_revision_id
          AND repositories.enabled = 1
          ${repositoryWriteAuthoritySql}
          AND repositories.paused = 0
          AND (
            (tasks.kind = 'resolve_conflict' AND json_extract(repositories.policy_json, '$.conflictResolution') = 1)
            OR (tasks.kind = 'review_fix' AND json_extract(repositories.policy_json, '$.pullRequestReview') = 1)
            OR (tasks.kind = 'baseline_repair' AND json_extract(repositories.policy_json, '$.pullRequestReview') = 1)
            OR (tasks.kind = 'issue_work' AND json_extract(repositories.policy_json, '$.issueWork') = 1)
          )
          -- Approval is a live condition of the claim, not something checked
          -- after one is picked. A repair whose Approval went away used to be
          -- selected anyway, throw, roll back, and be selected again on the very
          -- next pass. One repair spent a day doing that. It becomes claimable
          -- again by itself if Harlan approves this same head commit again.
          AND (
            tasks.kind != 'review_fix'
            OR EXISTS (
              SELECT 1 FROM pull_request_approvals
              WHERE pull_request_approvals.subject_id = subjects.id
                AND pull_request_approvals.revision_id = tasks.revision_id
                AND pull_request_approvals.kind = 'fixes'
            )
          )
          -- Repair waits until the terminal Review status reaches GitHub.
          AND (
            tasks.kind != 'review_fix'
            OR NOT EXISTS (
              SELECT 1 FROM review_status_commands
              WHERE review_status_commands.revision_id = tasks.revision_id
                AND review_status_commands.phase = 'terminal'
                AND review_status_commands.state_tag IN ('Pending', 'Running')
            )
          )
          -- The throttle asks how much automated work already waits on Harlan,
          -- so it counts only pull requests the controller opened. Counting
          -- everybody's held every issue Task queued for a day behind thirty
          -- open pull requests the controller could never close.
          AND (
            tasks.kind != 'issue_work'
            OR (SELECT selection_mode FROM agent_control WHERE singleton = 1) = 'manual'
            OR (
              (
                SELECT COUNT(*)
                FROM subjects AS open_subjects
                JOIN repositories AS open_repositories ON open_repositories.id = open_subjects.repository_id
                JOIN revisions AS open_revisions ON open_revisions.id = open_subjects.current_revision_id
                WHERE open_subjects.kind = 'pull_request'
                  AND open_repositories.enabled = 1
                  AND json_extract(open_revisions.payload, '$.state') = 'open'
                  AND json_extract(open_revisions.payload, '$.controllerOwned') = 1
              ) < ?
              AND (
                json_extract(repositories.policy_json, '$.maxOpenPullRequests') IS NULL
                OR (
                  SELECT COUNT(*)
                  FROM subjects AS repository_subjects
                  JOIN revisions AS repository_revisions ON repository_revisions.id = repository_subjects.current_revision_id
                  WHERE repository_subjects.repository_id = subjects.repository_id
                    AND repository_subjects.kind = 'pull_request'
                    AND json_extract(repository_revisions.payload, '$.state') = 'open'
                    AND json_extract(repository_revisions.payload, '$.controllerOwned') = 1
                ) < json_extract(repositories.policy_json, '$.maxOpenPullRequests')
              )
            )
          )
        ORDER BY tasks.updated_at, tasks.id
        LIMIT 1
      `).get(kind, exactTaskId ?? null, exactTaskId ?? null, maxOpenPullRequests) as ClaimRow | undefined
      if (row === undefined) {
        database.exec('COMMIT')
        return null
      }

      const subject = JSON.parse(row.subject_payload) as GitHubItem
      if (kind === 'issue_work' && subject.kind !== 'issue')
        throw new Error(`Issue work Task ${row.id} does not reference an issue.`)
      if (kind !== 'issue_work' && subject.kind !== 'pull_request')
        throw new Error(`Pull request Task ${row.id} does not reference a pull request.`)
      const repositoryMapping = JSON.parse(row.policy_json) as RepositoryMapping
      // The query above cannot return an unapproved repair. This stays as the
      // second half of the boundary that decides who may write a contributor's
      // branch, and it declines the claim rather than throwing, so a broken
      // guard above can never spin the claim path again.
      if (kind === 'review_fix') {
        const approved = database.prepare(`
          SELECT 1 FROM pull_request_approvals
          WHERE subject_id = ? AND revision_id = ? AND kind = 'fixes'
        `).get(row.subject_id, row.revision_id)
        if (approved === undefined) {
          database.exec('COMMIT')
          return null
        }
      }
      const fence = row.fence + 1
      const leaseExpiresAt = new Date(new Date(now).getTime() + leaseMilliseconds).toISOString()
      const update = database.prepare(`
        UPDATE tasks
        SET state_tag = 'Running', reason = NULL, worker_id = ?, fence = ?, attempts = attempts + 1,
          lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND state_tag = 'Queued' AND fence = ?
      `).run(workerId, fence, leaseExpiresAt, now, row.id, row.fence)
      if (update.changes !== 1)
        throw new Error(`Task claim lost for ${row.id}.`)
      recordTransition(database, { taskId: row.id, from: 'Queued', to: 'Running', reason: null, fence, at: now })
      database.exec('COMMIT')

      const taskBase = {
        id: row.id,
        repository: row.repository,
        revisionId: row.revision_id,
        updatedAt: now,
        state: { _tag: 'Running' as const, workerId, fence, leaseExpiresAt },
        repositoryMapping,
      }
      if (kind === 'issue_work' && subject.kind === 'issue')
        return { ...taskBase, kind, issueNumber: row.github_number, issue: subject }
      if (subject.kind !== 'pull_request')
        throw new Error(`Pull request Task ${row.id} crossed the issue claim boundary.`)
      const task = { ...taskBase, kind, pullRequestNumber: row.github_number, pullRequest: subject }
      if (kind === 'review_fix') {
        const prior = reviewFixRounds(database, row.subject_id, subject.headSha)
        return { ...task, kind, rounds: { number: prior.length + 1, limit: REPAIR_ROUND_LIMIT, prior } }
      }
      if (kind === 'resolve_conflict')
        return { ...task, kind }
      if (kind === 'baseline_repair')
        return { ...task, kind }
      throw new Error(`Issue work Task ${row.id} crossed the pull request claim boundary.`)
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const claimNextConflictTask: JournalStore['claimNextConflictTask'] = (workerId, now, leaseMilliseconds) => {
    const task = claimMutationTask('resolve_conflict', workerId, now, leaseMilliseconds)
    if (task === null || task.kind === 'resolve_conflict')
      return task
    throw new Error('Repair Task crossed the conflict resolution claim boundary.')
  }

  const claimNextReviewFixTask: JournalStore['claimNextReviewFixTask'] = (workerId, now, leaseMilliseconds) => {
    const task = claimMutationTask('review_fix', workerId, now, leaseMilliseconds)
    if (task === null || task.kind === 'review_fix')
      return task
    throw new Error('Conflict resolution Task crossed the repair claim boundary.')
  }

  const claimNextBaselineRepairTask: JournalStore['claimNextBaselineRepairTask'] = (workerId, now, leaseMilliseconds) => {
    const task = claimMutationTask('baseline_repair', workerId, now, leaseMilliseconds)
    if (task === null || task.kind === 'baseline_repair')
      return task
    throw new Error('Pull request Task crossed the Baseline repair claim boundary.')
  }

  const queueReviewFixTaskForReview: JournalStore['queueReviewFixTaskForReview'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const row = database.prepare(`
        SELECT worker_tasks.subject_id, worker_tasks.revision_id, revisions.payload,
          repositories.policy_json, repositories.github, subjects.github_number
        FROM worker_tasks
        JOIN subjects ON subjects.id = worker_tasks.subject_id
        JOIN revisions ON revisions.id = worker_tasks.revision_id
        JOIN repositories ON repositories.id = subjects.repository_id
        WHERE worker_tasks.id = ? AND worker_tasks.kind = 'adversarial_review'
          AND worker_tasks.state_tag = 'Running' AND worker_tasks.worker_id = ?
          AND worker_tasks.fence = ? AND worker_tasks.lease_expires_at > ?
          AND worker_tasks.revision_id = subjects.current_revision_id
          AND repositories.enabled = 1
      `).get(input.taskId, input.workerId, input.fence, input.at) as {
        subject_id: number
        revision_id: string
        payload: string
        policy_json: string
        github: string
        github_number: number
      } | undefined
      if (row === undefined) {
        database.exec('COMMIT')
        return { _tag: 'ActionRequired', reason: 'The Review Task changed before Repair was queued.' }
      }
      const subject = JSON.parse(row.payload) as GitHubItem
      if (subject.kind !== 'pull_request')
        throw new Error(`Review Task ${input.taskId} does not reference a pull request.`)
      const mapping = JSON.parse(row.policy_json) as RepositoryMapping
      const plan = planReviewFix(database, subject, row.subject_id, row.revision_id, input.at, mapping)
      database.exec('COMMIT')
      return plan._tag === 'Planned'
        ? { _tag: 'Queued', taskId: plan.taskId, rounds: plan.rounds }
        : { _tag: 'ActionRequired', reason: plan.reason }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const recordRepairReport: JournalStore['recordRepairReport'] = (input) => {
    const owned = database.prepare(`
      SELECT 1 FROM tasks
      WHERE id = ? AND kind = 'review_fix' AND state_tag = 'Running'
        AND worker_id = ? AND fence = ? AND lease_expires_at > ?
    `).get(input.taskId, input.workerId, input.fence, input.at) !== undefined
    if (!owned)
      return false
    database.prepare(`
      INSERT INTO repair_reports (task_id, summary, checks, recorded_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (task_id) DO UPDATE SET summary = excluded.summary, checks = excluded.checks, recorded_at = excluded.recorded_at
    `).run(input.taskId, input.summary, JSON.stringify(input.checks), input.at)
    return true
  }

  const retireBaselineRepairForReview: JournalStore['retireBaselineRepairForReview'] = (input) => {
    const row = database.prepare(`
      SELECT worker_tasks.subject_id
      FROM worker_tasks
      WHERE worker_tasks.id = ? AND worker_tasks.kind = 'adversarial_review'
        AND worker_tasks.state_tag = 'Running' AND worker_tasks.worker_id = ?
        AND worker_tasks.fence = ? AND worker_tasks.lease_expires_at > ?
    `).get(input.taskId, input.workerId, input.fence, input.at) as { subject_id: number } | undefined
    if (row === undefined)
      return 0
    // Only Failed repairs. A Queued or Running one still belongs to whichever
    // base commit is red right now.
    const dead = database.prepare(`
      SELECT id, fence FROM tasks
      WHERE subject_id = ? AND kind = 'baseline_repair' AND state_tag = 'Failed'
    `).all(row.subject_id) as unknown as Array<{ id: string, fence: number }>
    const update = database.prepare(`
      UPDATE tasks SET state_tag = 'Superseded', reason = ?, updated_at = ?
      WHERE id = ? AND state_tag = 'Failed'
    `)
    const reason = 'The default branch no longer fails at this base commit.'
    return dead.reduce((total, task) => {
      if (update.run(reason, input.at, task.id).changes !== 1)
        return total
      recordTransition(database, { taskId: task.id, from: 'Failed', to: 'Superseded', reason, fence: task.fence, at: input.at })
      return total + 1
    }, 0)
  }

  const queueBaselineRepairForReview: JournalStore['queueBaselineRepairForReview'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const row = database.prepare(`
        SELECT worker_tasks.subject_id, worker_tasks.revision_id, revisions.payload,
          repositories.policy_json, repositories.github
        FROM worker_tasks
        JOIN subjects ON subjects.id = worker_tasks.subject_id
        JOIN revisions ON revisions.id = worker_tasks.revision_id
        JOIN repositories ON repositories.id = subjects.repository_id
        WHERE worker_tasks.id = ? AND worker_tasks.kind = 'adversarial_review'
          AND worker_tasks.state_tag = 'Running' AND worker_tasks.worker_id = ?
          AND worker_tasks.fence = ? AND worker_tasks.lease_expires_at > ?
          AND repositories.enabled = 1
      `).get(input.taskId, input.workerId, input.fence, input.at) as {
        subject_id: number
        revision_id: string
        payload: string
        policy_json: string
        github: string
      } | undefined
      if (row === undefined) {
        database.exec('COMMIT')
        return { _tag: 'Rejected', reason: 'The active review no longer authorizes Baseline repair.' }
      }
      const subject = JSON.parse(row.payload) as GitHubItem
      const mapping = JSON.parse(row.policy_json) as RepositoryMapping
      if (subject.kind !== 'pull_request' || subject.baseSha !== input.baseSha) {
        database.exec('COMMIT')
        return { _tag: 'Rejected', reason: 'The base commit changed before Baseline repair was queued.' }
      }
      // A pull request based on another pull request's head is a stack, and its
      // red base CI belongs to the parent. Baseline repair fetches the default
      // branch tip and requires it to equal the base commit, so a stack could
      // never finish one.
      if (subject.baseRef !== mapping.defaultBranch) {
        database.exec('COMMIT')
        return { _tag: 'NotAuthorized', reason: 'This pull request is stacked on another pull request, not on the default branch.' }
      }
      // Baseline repair opens a pull request against the default branch. Harlan
      // may do that on every repository he owns or maintains. Only a repository
      // he merely watches refuses it, and that refusal must not stop the review.
      if (!canRepairBaseline(mapping)) {
        database.exec('COMMIT')
        return { _tag: 'NotAuthorized', reason: 'Repository policy does not authorize Baseline repair for this base commit.' }
      }
      const taskId = digest(`${row.github}:baseline:${input.baseSha}`)
      const existing = database.prepare('SELECT state_tag, fence FROM tasks WHERE id = ?').get(taskId) as
        { state_tag: TaskRow['state_tag'], fence: number } | undefined
      const openRepair = database.prepare(`
        SELECT subjects.github_number, json_extract(revisions.payload, '$.url') AS url
        FROM subjects
        JOIN repositories ON repositories.id = subjects.repository_id
        JOIN revisions ON revisions.id = subjects.current_revision_id
        WHERE repositories.github = ? AND subjects.kind = 'pull_request'
          AND json_extract(revisions.payload, '$.state') = 'open'
          AND json_extract(revisions.payload, '$.purpose._tag') = 'BaselineRepair'
          AND lower(substr(?, 1, length(json_extract(revisions.payload, '$.purpose.baseShaPrefix'))))
            = lower(json_extract(revisions.payload, '$.purpose.baseShaPrefix'))
        LIMIT 1
      `).get(row.github, input.baseSha) as { github_number: number, url: string } | undefined
      if (openRepair !== undefined) {
        const evidence = `GitHub reports Baseline repair pull request #${openRepair.github_number}: ${openRepair.url}`
        if (existing === undefined) {
          database.prepare(`
            INSERT INTO tasks (id, subject_id, revision_id, kind, state_tag, evidence, updated_at)
            VALUES (?, ?, ?, 'baseline_repair', 'Completed', ?, ?)
          `).run(taskId, row.subject_id, row.revision_id, evidence, input.at)
          recordTransition(database, { taskId, from: null, to: 'Completed', reason: 'Recovered from GitHub.', fence: 0, at: input.at })
        }
        else if (existing.state_tag === 'Queued' || existing.state_tag === 'ActionRequired' || existing.state_tag === 'Failed' || existing.state_tag === 'Superseded') {
          database.prepare(`
            UPDATE tasks
            SET state_tag = 'Completed', reason = NULL, evidence = ?, worker_id = NULL,
              command_id = NULL, lease_expires_at = NULL, updated_at = ?
            WHERE id = ? AND state_tag = ?
          `).run(evidence, input.at, taskId, existing.state_tag)
          recordTransition(database, { taskId, from: existing.state_tag, to: 'Completed', reason: 'Recovered from GitHub.', fence: existing.fence, at: input.at })
        }
        database.exec('COMMIT')
        return { _tag: 'Existing', taskId }
      }
      if (existing !== undefined && existing.state_tag !== 'Failed' && existing.state_tag !== 'Superseded') {
        database.exec('COMMIT')
        return { _tag: 'Existing', taskId }
      }
      supersedeTasks(database, row.subject_id, input.at, 'A newer base commit replaced this Baseline repair.', row.revision_id, 'baseline_repair')
      if (existing !== undefined) {
        // A dead Baseline repair leaves every review of this base commit waiting forever.
        const fence = existing.fence + 1
        const requeued = database.prepare(`
          UPDATE tasks
          SET state_tag = 'Queued', reason = NULL, worker_id = NULL, command_id = NULL,
            lease_expires_at = NULL, attempts = 0, fence = ?, updated_at = ?
          WHERE id = ? AND state_tag = ?
        `).run(fence, input.at, taskId, existing.state_tag)
        if (requeued.changes !== 1) {
          database.exec('COMMIT')
          return { _tag: 'Existing', taskId }
        }
        recordTransition(database, { taskId, from: existing.state_tag, to: 'Queued', reason: 'The previous Baseline repair did not finish.', fence, at: input.at })
        database.exec('COMMIT')
        return { _tag: 'Queued', taskId }
      }
      database.prepare(`
        INSERT INTO tasks (id, subject_id, revision_id, kind, state_tag, updated_at)
        VALUES (?, ?, ?, 'baseline_repair', 'Queued', ?)
      `).run(taskId, row.subject_id, row.revision_id, input.at)
      recordTransition(database, { taskId, from: null, to: 'Queued', reason: null, fence: 0, at: input.at })
      database.exec('COMMIT')
      return { _tag: 'Queued', taskId }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const claimNextIssueWorkTask: JournalStore['claimNextIssueWorkTask'] = (workerId, now, leaseMilliseconds) => {
    const task = claimMutationTask('issue_work', workerId, now, leaseMilliseconds)
    if (task === null || task.kind === 'issue_work')
      return task
    throw new Error('Pull request Task crossed the issue work claim boundary.')
  }

  const recoverExpiredWorkerTasks = (now: string): void => {
    const expired = database.prepare(`
      SELECT id, fence FROM worker_tasks
      WHERE state_tag = 'Running' AND lease_expires_at <= ?
    `).all(now) as unknown as Array<{ id: string, fence: number }>
    expired.forEach((row) => {
      const update = database.prepare(`
        UPDATE worker_tasks
        SET state_tag = 'Queued', reason = NULL, worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND fence = ?
      `).run(now, row.id, row.fence)
      if (update.changes === 1)
        recordWorkerTransition(database, { taskId: row.id, from: 'Running', to: 'Queued', reason: 'Worker lease expired.', fence: row.fence, at: now })
    })
  }

  const claimWorkerTask = (
    kind: 'adversarial_review' | 'issue_triage',
    workerId: string,
    now: string,
    leaseMilliseconds: number,
  ): ClaimedAdversarialReviewTask | ClaimedIssueTriageTask | null => {
    database.exec('BEGIN IMMEDIATE')
    try {
      recoverExpiredWorkerTasks(now)
      const row = database.prepare(`
        SELECT
          worker_tasks.id,
          worker_tasks.kind,
          repositories.github AS repository,
          subjects.github_number,
          worker_tasks.revision_id,
          worker_tasks.state_tag,
          worker_tasks.reason,
          worker_tasks.worker_id,
          worker_tasks.evidence,
          NULL AS command_id,
          worker_tasks.fence,
          worker_tasks.lease_expires_at,
          worker_tasks.updated_at,
          repositories.policy_json,
          revisions.payload AS subject_payload,
          EXISTS (
            SELECT 1 FROM review_rerun_requests
            WHERE review_rerun_requests.task_id = worker_tasks.id
          ) OR (
            worker_tasks.kind = 'adversarial_review'
            AND EXISTS (SELECT 1 FROM review_runs WHERE review_runs.subject_id = worker_tasks.subject_id)
            AND NOT EXISTS (
              SELECT 1 FROM review_runs
              WHERE review_runs.subject_id = worker_tasks.subject_id
                AND review_runs.revision_id = worker_tasks.revision_id
            )
          ) AS rerun_requested
        FROM worker_tasks
        JOIN subjects ON subjects.id = worker_tasks.subject_id
        JOIN repositories ON repositories.id = subjects.repository_id
        JOIN revisions ON revisions.id = worker_tasks.revision_id
        WHERE worker_tasks.kind = ? AND worker_tasks.state_tag = 'Queued'
          AND worker_tasks.revision_id = subjects.current_revision_id
          AND repositories.enabled = 1
          ${repositoryWriteAuthoritySql}
          AND repositories.paused = 0
          AND (
            (worker_tasks.kind = 'adversarial_review' AND json_extract(repositories.policy_json, '$.pullRequestReview') = 1)
            OR (worker_tasks.kind = 'issue_triage' AND json_extract(repositories.policy_json, '$.issueWork') = 1)
          )
        ORDER BY worker_tasks.updated_at, worker_tasks.id
        LIMIT 1
      `).get(kind) as (ClaimRow & { rerun_requested: number }) | undefined
      if (row === undefined) {
        database.exec('COMMIT')
        return null
      }

      const subject = JSON.parse(row.subject_payload) as GitHubItem
      const repositoryMapping = JSON.parse(row.policy_json) as RepositoryMapping
      if (kind === 'adversarial_review' && subject.kind !== 'pull_request')
        throw new Error(`Review Task ${row.id} does not reference a pull request.`)
      if (kind === 'issue_triage' && subject.kind !== 'issue')
        throw new Error(`Issue triage Task ${row.id} does not reference an issue.`)
      if (subject.kind === 'pull_request' && requiresPullRequestApproval(database, repositoryMapping, subject.author)) {
        const approved = database.prepare(`
          SELECT 1 FROM pull_request_approvals
          JOIN subjects ON subjects.id = pull_request_approvals.subject_id
          WHERE pull_request_approvals.revision_id = ? AND pull_request_approvals.kind = 'review'
            AND subjects.current_revision_id = pull_request_approvals.revision_id
        `).get(row.revision_id)
        if (approved === undefined)
          throw new Error(`Review Task ${row.id} lost Approval for its pull request head commit.`)
      }

      const fence = row.fence + 1
      const leaseExpiresAt = new Date(new Date(now).getTime() + leaseMilliseconds).toISOString()
      const update = database.prepare(`
        UPDATE worker_tasks
        SET state_tag = 'Running', reason = NULL, worker_id = ?, fence = ?, attempts = attempts + 1,
          lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND state_tag = 'Queued' AND fence = ?
      `).run(workerId, fence, leaseExpiresAt, now, row.id, row.fence)
      if (update.changes !== 1)
        throw new Error(`Worker Task claim lost for ${row.id}.`)
      recordWorkerTransition(database, { taskId: row.id, from: 'Queued', to: 'Running', reason: null, fence, at: now })
      database.exec('COMMIT')

      const state = { _tag: 'Running' as const, workerId, fence, leaseExpiresAt }
      if (subject.kind === 'issue') {
        return {
          id: row.id,
          kind: 'issue_triage',
          repository: row.repository,
          issueNumber: row.github_number,
          revisionId: row.revision_id,
          state,
          updatedAt: now,
          repositoryMapping,
          issue: subject,
        }
      }
      return {
        id: row.id,
        kind: 'adversarial_review',
        repository: row.repository,
        pullRequestNumber: row.github_number,
        revisionId: row.revision_id,
        state,
        updatedAt: now,
        repositoryMapping,
        pullRequest: subject,
        rerun: row.rerun_requested === 1 ? { _tag: 'Requested' } : { _tag: 'NotRequested' },
      }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const claimNextAdversarialReviewTask: JournalStore['claimNextAdversarialReviewTask'] = (workerId, now, leaseMilliseconds) => {
    const task = claimWorkerTask('adversarial_review', workerId, now, leaseMilliseconds)
    if (task === null || task.kind === 'adversarial_review')
      return task
    throw new Error('Issue triage Task crossed the review claim boundary.')
  }

  const claimNextIssueTriageTask: JournalStore['claimNextIssueTriageTask'] = (workerId, now, leaseMilliseconds) => {
    const task = claimWorkerTask('issue_triage', workerId, now, leaseMilliseconds)
    if (task === null || task.kind === 'issue_triage')
      return task
    throw new Error('Review Task crossed the issue triage claim boundary.')
  }

  const heartbeatWorkerTask: JournalStore['heartbeatWorkerTask'] = (input) => {
    const leaseExpiresAt = new Date(new Date(input.at).getTime() + input.leaseMilliseconds).toISOString()
    return database.prepare(`
      UPDATE worker_tasks SET lease_expires_at = ?
      WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
        AND lease_expires_at > ?
    `).run(leaseExpiresAt, input.taskId, input.workerId, input.fence, input.at).changes === 1
  }

  const completeReviewTask: JournalStore['completeReviewTask'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const task = database.prepare(`
        SELECT worker_tasks.subject_id, worker_tasks.revision_id,
          repositories.github AS repository, subjects.github_number
        FROM worker_tasks
        JOIN subjects ON subjects.id = worker_tasks.subject_id
        JOIN repositories ON repositories.id = subjects.repository_id
        WHERE worker_tasks.id = ? AND worker_tasks.kind = 'adversarial_review'
          AND worker_tasks.state_tag = 'Running' AND worker_tasks.worker_id = ?
          AND worker_tasks.fence = ? AND worker_tasks.lease_expires_at > ?
          AND worker_tasks.revision_id = subjects.current_revision_id
      `).get(input.taskId, input.workerId, input.fence, input.at) as {
        subject_id: number
        revision_id: string
        repository: string
        github_number: number
      } | undefined
      if (task === undefined) {
        database.exec('COMMIT')
        return false
      }

      const fields = (() => {
        switch (input.resolution._tag) {
          case 'Reviewed': {
            const run = database.prepare(`
              SELECT 1 FROM review_runs
              WHERE id = ? AND subject_id = ? AND revision_id = ?
            `).get(input.resolution.reviewRunId, task.subject_id, task.revision_id)
            if (run === undefined)
              throw new Error('The Review resolution references a different Review run.')
            return { reviewRunId: input.resolution.reviewRunId, baselineTaskId: null, githubUrl: null, reason: null }
          }
          case 'WaitingForBaselineRepair': {
            const baseline = database.prepare(`
              SELECT 1 FROM tasks
              WHERE id = ? AND subject_id = ? AND revision_id = ? AND kind = 'baseline_repair'
            `).get(input.resolution.taskId, task.subject_id, task.revision_id)
            if (baseline === undefined)
              throw new Error('The Review resolution references a different Baseline repair Task.')
            return { reviewRunId: null, baselineTaskId: input.resolution.taskId, githubUrl: null, reason: null }
          }
          case 'ExistingReview':
            return { reviewRunId: null, baselineTaskId: null, githubUrl: input.resolution.url, reason: null }
          case 'ReviewSkipped':
          case 'UnknownNeedsReconciliation':
            return { reviewRunId: null, baselineTaskId: null, githubUrl: null, reason: input.resolution.reason }
        }
      })()

      const completed = database.prepare(`
        UPDATE worker_tasks
        SET state_tag = 'Completed', evidence = ?, reason = NULL, worker_id = NULL,
          lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
          AND lease_expires_at > ?
      `).run(input.evidence, input.at, input.taskId, input.workerId, input.fence, input.at).changes === 1
      if (!completed)
        throw new Error('The Review Task completion lost its fenced lease.')

      database.prepare(`
        INSERT INTO review_resolutions (
          subject_id, revision_id, task_id, task_fence, resolution_tag,
          review_run_id, baseline_task_id, github_url, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(subject_id, revision_id) DO UPDATE SET
          task_id = excluded.task_id,
          task_fence = excluded.task_fence,
          resolution_tag = excluded.resolution_tag,
          review_run_id = excluded.review_run_id,
          baseline_task_id = excluded.baseline_task_id,
          github_url = excluded.github_url,
          reason = excluded.reason,
          created_at = excluded.created_at
        WHERE excluded.task_fence >= review_resolutions.task_fence
      `).run(
        task.subject_id,
        task.revision_id,
        input.taskId,
        input.fence,
        input.resolution._tag,
        fields.reviewRunId,
        fields.baselineTaskId,
        fields.githubUrl,
        fields.reason,
        input.at,
      )
      recordWorkerTransition(database, { taskId: input.taskId, from: 'Running', to: 'Completed', reason: null, fence: input.fence, at: input.at })
      recordWorkflowEvent(database, {
        stream: 'review_resolution',
        event: 'Recorded',
        entityId: `${task.subject_id}:${task.revision_id}`,
        repository: task.repository,
        itemNumber: task.github_number,
        revisionId: task.revision_id,
        taskId: input.taskId,
        from: null,
        to: input.resolution._tag,
        fence: input.fence,
        at: input.at,
      })
      resolveTaskIncidents(database, input.taskId, input.at)
      database.exec('COMMIT')
      return true
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const completeWorkerTask: JournalStore['completeWorkerTask'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = database.prepare(`
        UPDATE worker_tasks
        SET state_tag = 'Completed', evidence = ?, reason = NULL, worker_id = NULL,
          lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
          AND lease_expires_at > ?
          AND revision_id = (SELECT current_revision_id FROM subjects WHERE subjects.id = worker_tasks.subject_id)
      `).run(input.evidence, input.at, input.taskId, input.workerId, input.fence, input.at)
      if (result.changes === 1) {
        recordWorkerTransition(database, {
          taskId: input.taskId,
          from: 'Running',
          to: 'Completed',
          reason: null,
          fence: input.fence,
          ...(input.usage === undefined ? {} : { usage: input.usage }),
          at: input.at,
        })
        resolveTaskIncidents(database, input.taskId, input.at)
        const row = database.prepare(`
          SELECT worker_tasks.subject_id, worker_tasks.revision_id, revisions.payload, repositories.policy_json
          FROM worker_tasks
          JOIN subjects ON subjects.id = worker_tasks.subject_id
          JOIN revisions ON revisions.id = worker_tasks.revision_id
          JOIN repositories ON repositories.id = subjects.repository_id
          WHERE worker_tasks.id = ? AND worker_tasks.kind = 'issue_triage'
        `).get(input.taskId) as {
          subject_id: number
          revision_id: string
          payload: string
          policy_json: string
        } | undefined
        if (row !== undefined) {
          const subject = JSON.parse(row.payload) as GitHubItem
          const mapping = JSON.parse(row.policy_json) as RepositoryMapping
          if (
            subject.kind === 'issue'
            && canWorkIssues(mapping)
            && !requiresIssueApproval(mapping, subject.author)
            && issueTriageState(input.evidence) === 'READY_TO_IMPLEMENT'
          ) {
            queueIssueWork(database, row.subject_id, row.revision_id, subject, mapping, input.at)
          }
        }
      }
      database.exec('COMMIT')
      return result.changes === 1
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const failWorkerTask: JournalStore['failWorkerTask'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const row = database.prepare(`
        SELECT worker_tasks.attempts, worker_tasks.max_attempts, repositories.writes_enabled
        FROM worker_tasks
        JOIN subjects ON subjects.id = worker_tasks.subject_id
        JOIN repositories ON repositories.id = subjects.repository_id
        WHERE worker_tasks.id = ? AND worker_tasks.state_tag = 'Running'
          AND worker_tasks.worker_id = ? AND worker_tasks.fence = ?
          AND worker_tasks.lease_expires_at > ?
      `).get(input.taskId, input.workerId, input.fence, input.at) as { attempts: number, max_attempts: number, writes_enabled: number } | undefined
      if (row === undefined) {
        database.exec('COMMIT')
        return 'Rejected'
      }
      // A reason no retry can satisfy must not spend the attempt budget. Every
      // attempt is one whole agent turn that reads the same policy, and fails
      // the same way, seven minutes later.
      const providerPaused = isProviderCircuitPause(input.reason)
      const writesDisabled = mutationsEnabled && row.writes_enabled === 0
      const retry = writesDisabled || providerPaused || (row.attempts < row.max_attempts && mayRetryFailure({ message: input.reason }))
      const nextTag = retry ? 'Queued' : 'Failed'
      database.prepare(`
        UPDATE worker_tasks
        SET state_tag = ?, reason = ?, attempts = CASE WHEN ? THEN MAX(0, attempts - 1) ELSE attempts END,
          worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
          AND lease_expires_at > ?
      `).run(nextTag, retry ? null : input.reason, writesDisabled || providerPaused ? 1 : 0, input.at, input.taskId, input.workerId, input.fence, input.at)
      recordWorkerTransition(database, { taskId: input.taskId, from: 'Running', to: nextTag, reason: input.reason, fence: input.fence, at: input.at })
      if (writesDisabled)
        resolveTaskIncidents(database, input.taskId, input.at)
      else if (!retry)
        recordTaskIncident(database, input.taskId, input.reason, input.at)
      database.exec('COMMIT')
      return retry ? 'Retrying' : 'Failed'
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const retryRecoverableWorkerFailures: JournalStore['retryRecoverableWorkerFailures'] = (at) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      // Every Failed Task on the current revision is a candidate. What it says
      // decides whether it retries, not a list of failures someone saw before.
      const rows = (database.prepare(`
        SELECT worker_tasks.id, worker_tasks.fence, worker_tasks.reason,
          worker_tasks.recovery_attempts, worker_tasks.updated_at,
          repositories.github AS repository, subjects.github_number
        FROM worker_tasks
        JOIN subjects ON subjects.id = worker_tasks.subject_id
        JOIN repositories ON repositories.id = subjects.repository_id
        WHERE worker_tasks.state_tag = 'Failed'
          AND worker_tasks.revision_id = subjects.current_revision_id
          AND repositories.enabled = 1
          AND (
            (worker_tasks.kind = 'adversarial_review' AND json_extract(repositories.policy_json, '$.pullRequestReview') = 1)
            OR (worker_tasks.kind = 'issue_triage' AND json_extract(repositories.policy_json, '$.issueWork') = 1)
          )
      `).all() as unknown as RecoveryCandidateRow[]).filter(row => isRecoverable(row, at))
      const taskRows = (database.prepare(`
        SELECT tasks.id, tasks.fence, tasks.reason, tasks.recovery_attempts, tasks.updated_at,
          repositories.github AS repository, subjects.github_number
        FROM tasks
        JOIN subjects ON subjects.id = tasks.subject_id
        JOIN repositories ON repositories.id = subjects.repository_id
        WHERE tasks.state_tag = 'Failed'
          AND tasks.revision_id = subjects.current_revision_id
          AND repositories.enabled = 1
          -- Approved issue work whose scope moved needs fresh triage before it
          -- runs again, which the issue scope pass below arranges. A plain
          -- requeue here would skip that and work against the old approval.
          AND NOT (tasks.kind = 'issue_work' AND tasks.reason = 'The issue changed before work started.')
      `).all() as unknown as RecoveryCandidateRow[]).filter(row => isRecoverable(row, at))
      const issueScopeRows = database.prepare(`
        SELECT tasks.id AS task_id, tasks.fence AS task_fence,
          worker_tasks.id AS triage_id, worker_tasks.fence AS triage_fence
        FROM tasks
        JOIN subjects ON subjects.id = tasks.subject_id
        JOIN repositories ON repositories.id = subjects.repository_id
        JOIN worker_tasks ON worker_tasks.subject_id = tasks.subject_id
          AND worker_tasks.revision_id = tasks.revision_id
          AND worker_tasks.kind = 'issue_triage'
        WHERE tasks.kind = 'issue_work'
          AND tasks.state_tag = 'Failed'
          AND tasks.reason = 'The issue changed before work started.'
          AND tasks.revision_id = subjects.current_revision_id
          AND worker_tasks.state_tag = 'Completed'
          AND repositories.enabled = 1
          AND repositories.ownership = 'owned'
          AND json_extract(repositories.policy_json, '$.issueWork') = 1
      `).all() as unknown as Array<{
        task_id: string
        task_fence: number
        triage_id: string
        triage_fence: number
      }>
      const retry = database.prepare(`
        UPDATE worker_tasks
        SET state_tag = 'Queued', reason = NULL, attempts = 0, worker_id = NULL,
          recovery_attempts = recovery_attempts + 1,
          lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Failed'
      `)
      const retryTask = database.prepare(`
        UPDATE tasks
        SET state_tag = 'Queued', reason = NULL, attempts = 0, worker_id = NULL,
          recovery_attempts = recovery_attempts + 1,
          lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Failed'
      `)
      const awaitFreshTriage = database.prepare(`
        UPDATE tasks
        SET state_tag = 'Superseded', reason = ?,
          worker_id = NULL, lease_expires_at = NULL, progress_percent = 0,
          progress_label = 'Starting', updated_at = ?
        WHERE id = ? AND kind = 'issue_work' AND state_tag = 'Failed'
      `)
      const retryTriage = database.prepare(`
        UPDATE worker_tasks
        SET state_tag = 'Queued', reason = NULL, evidence = NULL, attempts = 0,
          worker_id = NULL, lease_expires_at = NULL, progress_percent = 0,
          progress_label = 'Starting', updated_at = ?
        WHERE id = ? AND kind = 'issue_triage' AND state_tag = 'Completed'
      `)
      let retried = 0
      rows.forEach((row) => {
        if (retry.run(at, row.id).changes !== 1)
          return
        retried += 1
        recordWorkerTransition(database, {
          taskId: row.id,
          from: 'Failed',
          to: 'Queued',
          reason: 'A recoverable controller failure was repaired.',
          fence: row.fence,
          at,
        })
      })
      taskRows.forEach((row) => {
        if (retryTask.run(at, row.id).changes !== 1)
          return
        retried += 1
        recordTransition(database, {
          taskId: row.id,
          from: 'Failed',
          to: 'Queued',
          reason: 'A recoverable controller failure was repaired.',
          fence: row.fence,
          at,
        })
      })
      issueScopeRows.forEach((row) => {
        if (awaitFreshTriage.run(freshIssueTriageReason, at, row.task_id).changes !== 1)
          return
        if (retryTriage.run(at, row.triage_id).changes !== 1)
          throw new Error('Approved issue work was superseded without queuing fresh triage.')
        retried += 1
        recordTransition(database, {
          taskId: row.task_id,
          from: 'Failed',
          to: 'Superseded',
          reason: freshIssueTriageReason,
          fence: row.task_fence,
          at,
        })
        recordWorkerTransition(database, {
          taskId: row.triage_id,
          from: 'Completed',
          to: 'Queued',
          reason: 'The approved issue work requires fresh triage.',
          fence: row.triage_fence,
          at,
        })
      })
      database.exec('COMMIT')
      return retried
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const recoverInterruptedAgentTasks: JournalStore['recoverInterruptedAgentTasks'] = (at) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const conflictRows = database.prepare(`
        SELECT id, fence, state_tag FROM tasks
        WHERE state_tag = 'Running'
          OR (state_tag = 'Failed' AND reason LIKE '%operation was aborted%')
      `).all() as unknown as Array<{ id: string, fence: number, state_tag: 'Running' | 'Failed' }>
      const workerRows = database.prepare(`
        SELECT id, fence, state_tag FROM worker_tasks
        WHERE state_tag = 'Running'
          OR (state_tag = 'Failed' AND reason LIKE '%operation was aborted%')
      `).all() as unknown as Array<{ id: string, fence: number, state_tag: 'Running' | 'Failed' }>
      const routineRows = database.prepare(`
        SELECT id, fence FROM routine_runs WHERE state_tag = 'Running'
      `).all() as unknown as Array<{ id: string, fence: number }>
      const terminalReviewStatusRows = database.prepare(`
        SELECT id, fence FROM review_status_commands
        WHERE state_tag = 'Running' AND phase = 'terminal'
      `).all() as unknown as Array<{ id: string, fence: number }>
      const transientReviewStatusRows = database.prepare(`
        SELECT id, fence FROM review_status_commands
        WHERE state_tag = 'Running' AND phase != 'terminal'
      `).all() as unknown as Array<{ id: string, fence: number }>
      const issueTriageStatusRows = database.prepare(`
        SELECT id, fence FROM issue_triage_comment_commands WHERE state_tag = 'Running'
      `).all() as unknown as Array<{ id: string, fence: number }>
      const recoverConflict = database.prepare(`
        UPDATE tasks
        SET state_tag = 'Queued', reason = NULL, attempts = 0, worker_id = NULL,
          lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = ?
      `)
      const recoverWorker = database.prepare(`
        UPDATE worker_tasks
        SET state_tag = 'Queued', reason = NULL, attempts = 0, worker_id = NULL,
          lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = ?
      `)
      const recoverRoutine = database.prepare(`
        UPDATE routine_runs
        SET state_tag = 'Queued', reason = NULL, attempts = MAX(0, attempts - 1),
          worker_id = NULL, lease_expires_at = NULL, progress_percent = 0,
          progress_label = 'Starting', updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND fence = ?
      `)
      let recovered = 0
      conflictRows.forEach((row) => {
        if (recoverConflict.run(at, row.id, row.state_tag).changes !== 1)
          return
        recovered += 1
        recordTransition(database, { taskId: row.id, from: row.state_tag, to: 'Queued', reason: 'The service restarted.', fence: row.fence, at })
      })
      workerRows.forEach((row) => {
        if (recoverWorker.run(at, row.id, row.state_tag).changes !== 1)
          return
        recovered += 1
        recordWorkerTransition(database, { taskId: row.id, from: row.state_tag, to: 'Queued', reason: 'The service restarted.', fence: row.fence, at })
      })
      routineRows.forEach((row) => {
        if (recoverRoutine.run(at, row.id, row.fence).changes !== 1)
          return
        recovered += 1
        recordRoutineRunEvent(database, {
          runId: row.id,
          event: 'RestartRecovered',
          from: 'Running',
          to: 'Queued',
          reason: 'The service restarted.',
          fence: row.fence,
          at,
        })
      })
      database.prepare(`
        UPDATE review_status_commands
        SET state_tag = 'Pending', outcome_unknown = 1,
          reason = 'The service restarted during terminal Publication.',
          worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE state_tag = 'Running' AND phase = 'terminal'
      `).run(at)
      terminalReviewStatusRows.forEach(row => recordReviewStatusEvent(database, {
        commandId: row.id,
        event: 'RestartRecovered',
        from: 'Running',
        to: 'Pending',
        reason: 'The service restarted during terminal Publication.',
        fence: row.fence,
        at,
      }))
      database.prepare(`
        UPDATE review_status_commands
        SET state_tag = 'Superseded', reason = 'The service restarted.',
          worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE state_tag = 'Running' AND phase != 'terminal'
      `).run(at)
      transientReviewStatusRows.forEach(row => recordReviewStatusEvent(database, {
        commandId: row.id,
        event: 'RestartSuperseded',
        from: 'Running',
        to: 'Superseded',
        reason: 'The service restarted.',
        fence: row.fence,
        at,
      }))
      database.prepare(`
        UPDATE issue_triage_comment_commands
        SET state_tag = 'Superseded', reason = 'The service restarted.',
          worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE state_tag = 'Running'
      `).run(at)
      issueTriageStatusRows.forEach(row => recordIssueTriageStatusEvent(database, {
        commandId: row.id,
        event: 'RestartSuperseded',
        from: 'Running',
        to: 'Superseded',
        reason: 'The service restarted.',
        fence: row.fence,
        at,
      }))
      database.exec('COMMIT')
      return recovered
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const stageIssueTriageComment: JournalStore['stageIssueTriageComment'] = (input) => {
    const bodySha256 = digest(input.body)
    const commandId = digest(`${input.taskId}:${input.fence}:${bodySha256}`)
    database.exec('BEGIN IMMEDIATE')
    try {
      const authorized = database.prepare(`
        SELECT 1
        FROM worker_tasks
        JOIN subjects ON subjects.id = worker_tasks.subject_id
        JOIN repositories ON repositories.id = subjects.repository_id
        JOIN revisions ON revisions.id = worker_tasks.revision_id
        WHERE worker_tasks.id = ? AND worker_tasks.kind = 'issue_triage'
          AND worker_tasks.state_tag = 'Running' AND worker_tasks.worker_id = ?
          AND worker_tasks.fence = ? AND worker_tasks.lease_expires_at > ?
          AND worker_tasks.revision_id = ? AND subjects.current_revision_id = ?
          AND repositories.enabled = 1
          ${repositoryWriteAuthoritySql}
          AND json_extract(repositories.policy_json, '$.issueWork') = 1
      `).get(
        input.taskId,
        input.workerId,
        input.fence,
        input.at,
        input.revisionId,
        input.revisionId,
      )
      if (authorized === undefined) {
        database.exec('COMMIT')
        return { _tag: 'Rejected', reason: 'The Task lease or repository policy no longer authorizes this issue triage comment.' }
      }

      const existing = database.prepare(`
        SELECT id, body FROM issue_triage_comment_commands WHERE id = ?
      `).get(commandId) as { id: string, body: string } | undefined
      if (existing !== undefined) {
        database.exec('COMMIT')
        return existing.body === input.body
          ? { _tag: 'Duplicate', commandId }
          : { _tag: 'Rejected', reason: 'The issue triage comment identifier has different content.' }
      }
      database.prepare(`
        INSERT INTO issue_triage_comment_commands (
          id, task_id, task_fence, revision_id, body, body_sha256,
          state_tag, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'Pending', ?, ?)
      `).run(
        commandId,
        input.taskId,
        input.fence,
        input.revisionId,
        input.body,
        bodySha256,
        input.at,
        input.at,
      )
      recordIssueTriageStatusEvent(database, {
        commandId,
        event: 'Staged',
        from: null,
        to: 'Pending',
        at: input.at,
      })
      database.exec('COMMIT')
      return { _tag: 'Staged', commandId }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const claimIssueTriageComment: JournalStore['claimIssueTriageComment'] = (commandId, workerId, now, leaseMilliseconds) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const recovered = database.prepare(`
        UPDATE issue_triage_comment_commands
        SET state_tag = 'Pending', outcome_unknown = 1, reason = 'Comment lease expired.',
          worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND lease_expires_at <= ?
      `).run(now, commandId, now)
      if (recovered.changes === 1) {
        recordIssueTriageStatusEvent(database, {
          commandId,
          event: 'LeaseRecovered',
          from: 'Running',
          to: 'Pending',
          reason: 'Comment lease expired.',
          at: now,
        })
      }
      const row = database.prepare(`
        SELECT
          issue_triage_comment_commands.id,
          issue_triage_comment_commands.task_id,
          repositories.github AS repository,
          subjects.github_number,
          issue_triage_comment_commands.revision_id,
          issue_triage_comment_commands.body,
          issue_triage_comment_commands.outcome_unknown,
          COALESCE(issue_triage_comment_commands.github_comment_id, (
            SELECT previous.github_comment_id
            FROM issue_triage_comment_commands AS previous
            JOIN worker_tasks AS previous_task ON previous_task.id = previous.task_id
            WHERE previous_task.subject_id = worker_tasks.subject_id
              AND previous.state_tag = 'Published'
            ORDER BY previous.updated_at DESC, previous.id DESC
            LIMIT 1
          )) AS github_comment_id,
          issue_triage_comment_commands.fence,
          repositories.policy_json
        FROM issue_triage_comment_commands
        JOIN worker_tasks ON worker_tasks.id = issue_triage_comment_commands.task_id
        JOIN subjects ON subjects.id = worker_tasks.subject_id
        JOIN repositories ON repositories.id = subjects.repository_id
        WHERE issue_triage_comment_commands.id = ? AND issue_triage_comment_commands.state_tag = 'Pending'
          AND worker_tasks.kind = 'issue_triage' AND worker_tasks.state_tag = 'Running'
          AND worker_tasks.fence = issue_triage_comment_commands.task_fence
          AND worker_tasks.lease_expires_at > ?
          AND worker_tasks.revision_id = subjects.current_revision_id
          AND issue_triage_comment_commands.revision_id = subjects.current_revision_id
          AND repositories.enabled = 1
          ${repositoryWriteAuthoritySql}
          AND json_extract(repositories.policy_json, '$.issueWork') = 1
      `).get(commandId, now) as {
            id: string
            task_id: string
            repository: string
            github_number: number
            revision_id: string
            body: string
            outcome_unknown: number
            github_comment_id: number | null
            fence: number
            policy_json: string
          } | undefined
      if (row === undefined) {
        database.exec('COMMIT')
        return null
      }
      const fence = row.fence + 1
      const leaseExpiresAt = new Date(new Date(now).getTime() + leaseMilliseconds).toISOString()
      const update = database.prepare(`
        UPDATE issue_triage_comment_commands
        SET state_tag = 'Running', worker_id = ?, fence = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND state_tag = 'Pending' AND fence = ?
      `).run(workerId, fence, leaseExpiresAt, now, row.id, row.fence)
      if (update.changes !== 1)
        throw new Error(`Issue triage comment claim lost for ${row.id}.`)
      recordIssueTriageStatusEvent(database, {
        commandId: row.id,
        event: 'Claimed',
        from: 'Pending',
        to: 'Running',
        fence,
        at: now,
      })
      database.exec('COMMIT')
      return {
        id: row.id,
        taskId: row.task_id,
        repository: row.repository,
        issueNumber: row.github_number,
        revisionId: row.revision_id,
        body: row.body,
        outcomeUnknown: row.outcome_unknown === 1,
        commentId: row.github_comment_id,
        workerId,
        fence,
        leaseExpiresAt,
        repositoryMapping: JSON.parse(row.policy_json) as RepositoryMapping,
      }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const completeIssueTriageComment: JournalStore['completeIssueTriageComment'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const changed = database.prepare(`
        UPDATE issue_triage_comment_commands
        SET state_tag = 'Published', github_comment_id = ?, github_url = ?, reason = NULL,
          outcome_unknown = 0, worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        -- No clock here on purpose. GitHub has already accepted this write, and a
        -- record refused because a lease ran out cannot un-send it: the outcome is
        -- lost and the next attempt sends it again. The worker and the fence prove
        -- this is the attempt that was authorized, because every re-claim raises the
        -- fence. One triage comment posted twelve minutes after a two minute lease,
        -- and the deadlock that followed took a completed triage to Failed.
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
          AND revision_id = (
            SELECT subjects.current_revision_id
            FROM worker_tasks JOIN subjects ON subjects.id = worker_tasks.subject_id
            WHERE worker_tasks.id = issue_triage_comment_commands.task_id
          )
          AND EXISTS (
            SELECT 1 FROM worker_tasks
            WHERE worker_tasks.id = issue_triage_comment_commands.task_id
              AND worker_tasks.kind = 'issue_triage'
              AND worker_tasks.state_tag = 'Running'
              AND worker_tasks.fence = issue_triage_comment_commands.task_fence
          )
      `).run(input.commentId, input.url, input.at, input.commandId, input.workerId, input.fence).changes === 1
      if (changed) {
        recordIssueTriageStatusEvent(database, {
          commandId: input.commandId,
          event: 'Published',
          from: 'Running',
          to: 'Published',
          fence: input.fence,
          at: input.at,
        })
      }
      database.exec('COMMIT')
      return changed
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const deferIssueTriageComment: JournalStore['deferIssueTriageComment'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const changed = database.prepare(`
        UPDATE issue_triage_comment_commands
        SET state_tag = 'Pending', outcome_unknown = 1, reason = ?, worker_id = NULL,
          lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
          AND lease_expires_at > ?
      `).run(input.reason, input.at, input.commandId, input.workerId, input.fence, input.at).changes === 1
      if (changed) {
        recordIssueTriageStatusEvent(database, {
          commandId: input.commandId,
          event: 'Deferred',
          from: 'Running',
          to: 'Pending',
          reason: input.reason,
          fence: input.fence,
          at: input.at,
        })
      }
      database.exec('COMMIT')
      return changed
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const stageReviewStatus: JournalStore['stageReviewStatus'] = (input) => {
    const bodySha256 = digest(input.body)
    const desiredOutcome = input.desiredOutcome ?? reviewDesiredOutcomeFromBody(input.body)
    const commandId = digest(`${input.taskKind}:${input.taskId}:${input.fence}:${input.phase}:${input.reviewRunId ?? ''}:${desiredOutcome ?? ''}:${bodySha256}`)
    database.exec('BEGIN IMMEDIATE')
    try {
      const taskTable = input.taskKind === 'adversarial_review' ? 'worker_tasks' : 'tasks'
      const authorized = database.prepare(`
        SELECT 1
        FROM ${taskTable}
        JOIN subjects ON subjects.id = ${taskTable}.subject_id
        JOIN repositories ON repositories.id = subjects.repository_id
        JOIN revisions ON revisions.id = ${taskTable}.revision_id
        WHERE ${taskTable}.id = ? AND ${taskTable}.kind = ?
          AND ${taskTable}.state_tag = 'Running' AND ${taskTable}.worker_id = ?
          AND ${taskTable}.fence = ? AND ${taskTable}.lease_expires_at > ?
          AND ${taskTable}.revision_id = ? AND subjects.current_revision_id = ?
          AND json_extract(revisions.payload, '$.headSha') = ?
          AND repositories.enabled = 1
          ${repositoryWriteAuthoritySql}
          AND json_extract(repositories.policy_json, '$.pullRequestReview') = 1
      `).get(
        input.taskId,
        input.taskKind,
        input.workerId,
        input.fence,
        input.at,
        input.revisionId,
        input.revisionId,
        input.expectedHeadSha,
      )
      if (authorized === undefined) {
        database.exec('COMMIT')
        return { _tag: 'Rejected', reason: 'The Task lease or repository policy no longer authorizes this review status.' }
      }
      if (input.phase === 'terminal' && desiredOutcome === null) {
        database.exec('COMMIT')
        return { _tag: 'Rejected', reason: 'A terminal review status needs an explicit outcome.' }
      }
      if (input.reviewRunId !== undefined) {
        const reviewRun = database.prepare(`
          SELECT 1 FROM review_runs
          JOIN ${taskTable} ON ${taskTable}.subject_id = review_runs.subject_id
            AND ${taskTable}.revision_id = review_runs.revision_id
          WHERE review_runs.id = ? AND ${taskTable}.id = ?
        `).get(input.reviewRunId, input.taskId)
        if (reviewRun === undefined) {
          database.exec('COMMIT')
          return { _tag: 'Rejected', reason: 'The Review run does not belong to this Review Task.' }
        }
      }

      const existing = database.prepare(`
        SELECT id, body FROM review_status_commands WHERE id = ?
      `).get(commandId) as { id: string, body: string } | undefined
      if (existing !== undefined) {
        database.exec('COMMIT')
        return existing.body === input.body
          ? { _tag: 'Duplicate', commandId }
          : { _tag: 'Rejected', reason: 'The review status command identifier has different content.' }
      }
      database.prepare(`
        INSERT INTO review_status_commands (
          id, task_kind, task_id, task_fence, revision_id, expected_head_sha, phase, body, body_sha256,
          review_run_id, desired_outcome, state_tag, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?)
      `).run(
        commandId,
        input.taskKind,
        input.taskId,
        input.fence,
        input.revisionId,
        input.expectedHeadSha,
        input.phase,
        input.body,
        bodySha256,
        input.reviewRunId ?? null,
        desiredOutcome,
        input.at,
        input.at,
      )
      recordReviewStatusEvent(database, {
        commandId,
        event: 'Staged',
        from: null,
        to: 'Pending',
        at: input.at,
      })
      database.exec('COMMIT')
      return { _tag: 'Staged', commandId }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const stageReviewGateStatus: JournalStore['stageReviewGateStatus'] = (input) => {
    const outcome = derivedReviewOutcome(input.gates)
    const desiredOutcome = outcome === 'Ready' ? 'READY' : outcome === 'Pending' ? 'PENDING' : 'BLOCKED'
    if (desiredOutcome !== input.desiredOutcome)
      return { _tag: 'Rejected', reason: 'The Review gate projection and desired outcome disagree.' }

    const gates = JSON.stringify(input.gates)
    const bodySha256 = digest(input.body)
    database.exec('BEGIN IMMEDIATE')
    try {
      const row = database.prepare(`
        SELECT review_runs.subject_id, review_runs.revision_id, review_runs.head_sha,
          projection.gates AS prior_gates, projection.outcome_tag AS prior_outcome,
          worker_tasks.id AS task_id, worker_tasks.fence AS task_fence
        FROM review_runs
        JOIN review_gate_projections AS projection ON projection.review_run_id = review_runs.id
        JOIN subjects ON subjects.id = review_runs.subject_id
        JOIN repositories ON repositories.id = subjects.repository_id
        JOIN revisions ON revisions.id = subjects.current_revision_id
        JOIN worker_tasks ON worker_tasks.id = (
          SELECT candidate.id
          FROM worker_tasks AS candidate
          LEFT JOIN review_resolutions AS resolution
            ON resolution.task_id = candidate.id AND resolution.review_run_id = review_runs.id
          WHERE candidate.subject_id = review_runs.subject_id
            AND candidate.revision_id = review_runs.revision_id
            AND candidate.kind = 'adversarial_review'
          ORDER BY
            (resolution.review_run_id IS NOT NULL) DESC,
            (candidate.evidence = review_runs.id) DESC,
            candidate.updated_at DESC,
            candidate.id DESC
          LIMIT 1
        )
        WHERE review_runs.id = ?
          AND repositories.github = ? AND subjects.github_number = ?
          AND subjects.kind = 'pull_request'
          AND review_runs.revision_id = ? AND subjects.current_revision_id = ?
          AND review_runs.head_sha = ?
          AND json_extract(revisions.payload, '$.state') = 'open'
          AND json_extract(revisions.payload, '$.headSha') = ?
          AND repositories.enabled = 1
          AND repositories.paused = 0
          AND json_extract(repositories.policy_json, '$.pullRequestReview') = 1
      `).get(
        input.reviewRunId,
        input.repository,
        input.pullRequestNumber,
        input.revisionId,
        input.revisionId,
        input.expectedHeadSha,
        input.expectedHeadSha,
      ) as {
        subject_id: number
        revision_id: string
        head_sha: string
        prior_gates: string
        prior_outcome: ReviewOutcome['_tag']
        task_id: string
        task_fence: number
      } | undefined
      if (row === undefined) {
        database.exec('COMMIT')
        return { _tag: 'Rejected', reason: 'The Review run, current head, or repository policy no longer authorizes this gate projection.' }
      }

      const projectionChanged = row.prior_gates !== gates || row.prior_outcome !== outcome
      if (projectionChanged) {
        database.prepare(`
          UPDATE review_gate_projections
          SET gates = ?, outcome_tag = ?, updated_at = ?
          WHERE review_run_id = ?
        `).run(gates, outcome, input.at, input.reviewRunId)
        recordWorkflowEvent(database, {
          stream: 'review_gate',
          event: 'Projected',
          entityId: input.reviewRunId,
          repository: input.repository,
          itemNumber: input.pullRequestNumber,
          revisionId: input.revisionId,
          taskId: row.task_id,
          from: row.prior_outcome,
          to: outcome,
          at: input.at,
        })
      }

      const commandId = digest([
        'review_gate',
        row.task_id,
        String(row.task_fence),
        input.reviewRunId,
        desiredOutcome,
        bodySha256,
        input.reconciliationId ?? '',
      ].join(':'))
      const existing = database.prepare(`
        SELECT id, state_tag, fence FROM review_status_commands
        WHERE task_kind = 'adversarial_review'
          AND task_id = ? AND task_fence = ?
          AND phase = 'terminal' AND body_sha256 = ?
      `).get(row.task_id, row.task_fence, bodySha256) as {
        id: string
        state_tag: 'Pending' | 'Running' | 'Published' | 'Superseded'
        fence: number
      } | undefined
      if (existing !== undefined && (existing.state_tag === 'Pending' || existing.state_tag === 'Running')) {
        database.exec('COMMIT')
        return { _tag: 'Duplicate', commandId: existing.id }
      }
      if (existing !== undefined) {
        // The identical body already went through Publication, so this restage
        // means GitHub lost the comment. Requeue the same command, keeping its
        // comment id, so the publisher repairs the existing comment.
        const reason = existing.state_tag === 'Published'
          ? 'The published gate comment needs repair.'
          : 'The superseded gate status was requeued for Publication.'
        database.prepare(`
          UPDATE review_status_commands
          SET state_tag = 'Pending', outcome_unknown = 1, reason = ?, worker_id = NULL,
            lease_expires_at = NULL, revision_id = ?, expected_head_sha = ?, updated_at = ?
          WHERE id = ? AND state_tag = ? AND fence = ?
        `).run(reason, input.revisionId, input.expectedHeadSha, input.at, existing.id, existing.state_tag, existing.fence)
        recordReviewStatusEvent(database, {
          commandId: existing.id,
          event: 'DriftReconciliationStaged',
          from: existing.state_tag,
          to: 'Pending',
          reason,
          fence: existing.fence,
          at: input.at,
        })
        database.exec('COMMIT')
        return { _tag: 'Staged', commandId: existing.id }
      }
      database.prepare(`
        INSERT INTO review_status_commands (
          id, task_kind, task_id, task_fence, revision_id, expected_head_sha, phase,
          body, body_sha256, review_run_id, desired_outcome, state_tag, created_at, updated_at
        ) VALUES (?, 'adversarial_review', ?, ?, ?, ?, 'terminal', ?, ?, ?, ?, 'Pending', ?, ?)
      `).run(
        commandId,
        row.task_id,
        row.task_fence,
        input.revisionId,
        input.expectedHeadSha,
        input.body,
        bodySha256,
        input.reviewRunId,
        desiredOutcome,
        input.at,
        input.at,
      )
      recordReviewStatusEvent(database, {
        commandId,
        event: input.reconciliationId === undefined ? 'Staged' : 'ReconciliationStaged',
        from: null,
        to: 'Pending',
        at: input.at,
      })
      database.exec('COMMIT')
      return { _tag: 'Staged', commandId }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const claimReviewStatus: JournalStore['claimReviewStatus'] = (commandId, workerId, now, leaseMilliseconds) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const recovered = database.prepare(`
        UPDATE review_status_commands
        SET state_tag = 'Pending', outcome_unknown = 1, reason = 'Publication lease expired.',
          worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND lease_expires_at <= ?
      `).run(now, commandId, now)
      if (recovered.changes === 1) {
        recordReviewStatusEvent(database, {
          commandId,
          event: 'LeaseRecovered',
          from: 'Running',
          to: 'Pending',
          reason: 'Publication lease expired.',
          at: now,
        })
      }
      const row = database.prepare(`
        SELECT
          review_status_commands.id,
          review_status_commands.task_kind,
          review_status_commands.task_id,
          repositories.github AS repository,
          subjects.github_number,
          review_status_commands.revision_id,
          review_status_commands.expected_head_sha,
          review_status_commands.phase,
          review_status_commands.body,
          review_status_commands.review_run_id,
          review_status_commands.desired_outcome,
          review_status_commands.outcome_unknown,
          COALESCE(review_status_commands.github_comment_id, (
            SELECT previous.github_comment_id
            FROM review_status_commands AS previous
            WHERE previous.task_kind = review_status_commands.task_kind
              AND previous.task_id = review_status_commands.task_id
              AND previous.state_tag = 'Published'
            ORDER BY previous.updated_at DESC, previous.id DESC
            LIMIT 1
          )) AS github_comment_id,
          review_status_commands.fence,
          repositories.policy_json
        FROM review_status_commands
        LEFT JOIN worker_tasks
          ON review_status_commands.task_kind = 'adversarial_review'
          AND worker_tasks.id = review_status_commands.task_id
        LEFT JOIN tasks
          ON review_status_commands.task_kind = 'review_fix'
          AND tasks.id = review_status_commands.task_id
        JOIN subjects ON subjects.id = COALESCE(worker_tasks.subject_id, tasks.subject_id)
        JOIN repositories ON repositories.id = subjects.repository_id
        WHERE review_status_commands.id = ? AND review_status_commands.state_tag = 'Pending'
          AND (
            (
              review_status_commands.phase = 'terminal'
              AND (
                (review_status_commands.task_kind = 'adversarial_review' AND worker_tasks.kind = 'adversarial_review')
                OR (review_status_commands.task_kind = 'review_fix' AND tasks.kind = 'review_fix')
              )
            )
            OR
            (
              review_status_commands.task_kind = 'adversarial_review'
              AND worker_tasks.kind = 'adversarial_review'
              AND worker_tasks.state_tag = 'Running'
              AND worker_tasks.fence = review_status_commands.task_fence
              AND worker_tasks.lease_expires_at > ?
            )
            OR (
              review_status_commands.task_kind = 'review_fix'
              AND tasks.kind = 'review_fix'
              AND tasks.state_tag = 'Running'
              AND tasks.fence = review_status_commands.task_fence
              AND tasks.lease_expires_at > ?
            )
          )
          AND COALESCE(worker_tasks.revision_id, tasks.revision_id) = subjects.current_revision_id
          AND review_status_commands.revision_id = subjects.current_revision_id
          AND repositories.enabled = 1
          ${repositoryWriteAuthoritySql}
          AND json_extract(repositories.policy_json, '$.pullRequestReview') = 1
      `).get(commandId, now, now) as {
            id: string
            task_kind: 'adversarial_review' | 'review_fix'
            task_id: string
            repository: string
            github_number: number
            revision_id: string
            expected_head_sha: string
            phase: 'snapshot' | 'review' | 'repair' | 'terminal'
            body: string
            review_run_id: string | null
            desired_outcome: ReviewDesiredOutcome | null
            outcome_unknown: number
            github_comment_id: number | null
            fence: number
            policy_json: string
          } | undefined
      if (row === undefined) {
        database.exec('COMMIT')
        return null
      }
      const fence = row.fence + 1
      const leaseExpiresAt = new Date(new Date(now).getTime() + leaseMilliseconds).toISOString()
      const update = database.prepare(`
        UPDATE review_status_commands
        SET state_tag = 'Running', worker_id = ?, fence = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND state_tag = 'Pending' AND fence = ?
      `).run(workerId, fence, leaseExpiresAt, now, row.id, row.fence)
      if (update.changes !== 1)
        throw new Error(`Review status claim lost for ${row.id}.`)
      recordReviewStatusEvent(database, {
        commandId: row.id,
        event: 'Claimed',
        from: 'Pending',
        to: 'Running',
        fence,
        at: now,
      })
      database.exec('COMMIT')
      const taskPhase: ReviewStatusTaskPhase = row.task_kind === 'review_fix'
        ? { taskKind: 'review_fix', phase: row.phase as 'repair' | 'terminal' }
        : { taskKind: 'adversarial_review', phase: row.phase as 'snapshot' | 'review' | 'terminal' }
      return {
        id: row.id,
        taskId: row.task_id,
        repository: row.repository,
        pullRequestNumber: row.github_number,
        revisionId: row.revision_id,
        expectedHeadSha: row.expected_head_sha,
        ...taskPhase,
        body: row.body,
        reviewRunId: row.review_run_id,
        desiredOutcome: row.desired_outcome,
        outcomeUnknown: row.outcome_unknown === 1,
        commentId: row.github_comment_id,
        workerId,
        fence,
        leaseExpiresAt,
        repositoryMapping: JSON.parse(row.policy_json) as RepositoryMapping,
      }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const claimNextTerminalReviewStatus: JournalStore['claimNextTerminalReviewStatus'] = (workerId, now, leaseMilliseconds) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      supersedeUnauthorizedReviewStatuses(database, now)
      const stale = database.prepare(`
        SELECT review_status_commands.id, review_status_commands.fence
        FROM review_status_commands
        LEFT JOIN worker_tasks
          ON review_status_commands.task_kind = 'adversarial_review'
          AND worker_tasks.id = review_status_commands.task_id
        LEFT JOIN tasks
          ON review_status_commands.task_kind = 'review_fix'
          AND tasks.id = review_status_commands.task_id
        JOIN subjects ON subjects.id = COALESCE(worker_tasks.subject_id, tasks.subject_id)
        WHERE review_status_commands.state_tag = 'Pending'
          AND review_status_commands.phase = 'terminal'
          AND (
            review_status_commands.revision_id != subjects.current_revision_id
            OR COALESCE(worker_tasks.revision_id, tasks.revision_id) != subjects.current_revision_id
          )
      `).all() as unknown as Array<{ id: string, fence: number }>
      const supersede = database.prepare(`
        UPDATE review_status_commands
        SET state_tag = 'Superseded', reason = 'The pull request changed before terminal Publication.',
          worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Pending' AND phase = 'terminal' AND fence = ?
      `)
      stale.forEach((command) => {
        if (supersede.run(now, command.id, command.fence).changes !== 1)
          return
        recordReviewStatusEvent(database, {
          commandId: command.id,
          event: 'Superseded',
          from: 'Pending',
          to: 'Superseded',
          reason: 'The pull request changed before terminal Publication.',
          fence: command.fence,
          at: now,
        })
      })
      database.exec('COMMIT')
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    const row = database.prepare(`
      SELECT review_status_commands.id
      FROM review_status_commands
      LEFT JOIN worker_tasks
        ON review_status_commands.task_kind = 'adversarial_review'
        AND worker_tasks.id = review_status_commands.task_id
      LEFT JOIN tasks
        ON review_status_commands.task_kind = 'review_fix'
        AND tasks.id = review_status_commands.task_id
      JOIN subjects ON subjects.id = COALESCE(worker_tasks.subject_id, tasks.subject_id)
      JOIN repositories ON repositories.id = subjects.repository_id
      WHERE review_status_commands.state_tag = 'Pending'
        AND review_status_commands.phase = 'terminal'
        AND review_status_commands.revision_id = subjects.current_revision_id
        AND COALESCE(worker_tasks.revision_id, tasks.revision_id) = subjects.current_revision_id
        AND COALESCE(worker_tasks.state_tag, tasks.state_tag) != 'Running'
        AND repositories.enabled = 1
        ${repositoryWriteAuthoritySql}
        AND json_extract(repositories.policy_json, '$.pullRequestReview') = 1
      ORDER BY review_status_commands.updated_at, review_status_commands.id
      LIMIT 1
    `).get() as { id: string } | undefined
    return row === undefined
      ? null
      : claimReviewStatus(row.id, workerId, now, leaseMilliseconds)
  }

  const completeReviewStatus: JournalStore['completeReviewStatus'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const changed = database.prepare(`
        UPDATE review_status_commands
        SET state_tag = 'Published', github_comment_id = ?, github_url = ?, reason = NULL,
          outcome_unknown = 0, worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        -- No clock here on purpose. GitHub has already accepted this write, and a
        -- record refused because a lease ran out cannot un-send it. The worker
        -- and fence prove this is the authorized attempt.
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
          AND (
            (
              review_status_commands.phase = 'terminal'
              AND (
                EXISTS (
                  SELECT 1
                  FROM worker_tasks
                  JOIN subjects ON subjects.id = worker_tasks.subject_id
                  WHERE review_status_commands.task_kind = 'adversarial_review'
                    AND worker_tasks.id = review_status_commands.task_id
                    AND worker_tasks.kind = 'adversarial_review'
                    AND worker_tasks.revision_id = subjects.current_revision_id
                    AND review_status_commands.revision_id = subjects.current_revision_id
                )
                OR EXISTS (
                  SELECT 1
                  FROM tasks
                  JOIN subjects ON subjects.id = tasks.subject_id
                  WHERE review_status_commands.task_kind = 'review_fix'
                    AND tasks.id = review_status_commands.task_id
                    AND tasks.kind = 'review_fix'
                    AND tasks.revision_id = subjects.current_revision_id
                    AND review_status_commands.revision_id = subjects.current_revision_id
                )
              )
            )
            OR EXISTS (
              SELECT 1
              FROM worker_tasks
              JOIN subjects ON subjects.id = worker_tasks.subject_id
              WHERE review_status_commands.task_kind = 'adversarial_review'
                AND worker_tasks.id = review_status_commands.task_id
                AND worker_tasks.kind = 'adversarial_review'
                AND worker_tasks.state_tag = 'Running'
                AND worker_tasks.fence = review_status_commands.task_fence
                AND worker_tasks.revision_id = subjects.current_revision_id
                AND review_status_commands.revision_id = subjects.current_revision_id
            )
            OR EXISTS (
              SELECT 1
              FROM tasks
              JOIN subjects ON subjects.id = tasks.subject_id
              WHERE review_status_commands.task_kind = 'review_fix'
                AND tasks.id = review_status_commands.task_id
                AND tasks.kind = 'review_fix'
                AND tasks.state_tag = 'Running'
                AND tasks.fence = review_status_commands.task_fence
                AND tasks.revision_id = subjects.current_revision_id
                AND review_status_commands.revision_id = subjects.current_revision_id
            )
          )
      `).run(input.commentId, input.url, input.at, input.commandId, input.workerId, input.fence).changes === 1
      if (changed) {
        const command = database.prepare(`
          SELECT review_run_id, body FROM review_status_commands WHERE id = ?
        `).get(input.commandId) as { review_run_id: string | null, body: string }
        if (command.review_run_id !== null) {
          const publicationResult = { _tag: 'Published' as const, githubCommentId: input.commentId, url: input.url }
          // A drift repair republishes the same command id, so the row already
          // exists and must move to the replacement comment. Keeping the stale
          // comment id here would requeue the command on every sweep pass and
          // create a duplicate gate comment each time.
          database.prepare(`
            INSERT INTO review_publications (
              id, review_run_id, body, body_sha256, created_at, result_tag,
              github_comment_id, github_url, reason, content_digest
            ) VALUES (?, ?, ?, ?, ?, 'Published', ?, ?, NULL, ?)
            ON CONFLICT (id) DO UPDATE SET
              created_at = excluded.created_at,
              github_comment_id = excluded.github_comment_id,
              github_url = excluded.github_url,
              content_digest = excluded.content_digest
          `).run(
            input.commandId,
            command.review_run_id,
            command.body,
            digest(command.body),
            input.at,
            input.commentId,
            input.url,
            digest(JSON.stringify({
              reviewRunId: command.review_run_id,
              body: command.body,
              at: input.at,
              result: publicationResult,
            })),
          )
        }
        recordReviewStatusEvent(database, {
          commandId: input.commandId,
          event: 'Published',
          from: 'Running',
          to: 'Published',
          fence: input.fence,
          at: input.at,
        })
      }
      database.exec('COMMIT')
      return changed
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const recordReviewStatusReceipt: JournalStore['recordReviewStatusReceipt'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const changed = input.sink === 'comment'
        ? database.prepare(`
            UPDATE review_status_commands
            SET github_comment_id = ?, github_url = ?, outcome_unknown = 0, updated_at = ?
            WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
          `).run(input.commentId ?? null, input.url ?? null, input.at, input.commandId, input.workerId, input.fence).changes === 1
        : database.prepare(`
            UPDATE review_status_commands SET updated_at = ?
            WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
          `).run(input.at, input.commandId, input.workerId, input.fence).changes === 1
      if (changed) {
        recordReviewStatusEvent(database, {
          commandId: input.commandId,
          event: input.sink === 'comment' ? 'CommentConfirmed' : 'OutcomeLabelConfirmed',
          from: 'Running',
          to: 'Running',
          fence: input.fence,
          at: input.at,
        })
      }
      database.exec('COMMIT')
      return changed
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const deferReviewStatus: JournalStore['deferReviewStatus'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const changed = database.prepare(`
        UPDATE review_status_commands
        SET state_tag = 'Pending', outcome_unknown = 1, reason = ?, worker_id = NULL,
          lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
      `).run(input.reason, input.at, input.commandId, input.workerId, input.fence).changes === 1
      if (changed) {
        recordReviewStatusEvent(database, {
          commandId: input.commandId,
          event: 'Deferred',
          from: 'Running',
          to: 'Pending',
          reason: input.reason,
          fence: input.fence,
          at: input.at,
        })
      }
      database.exec('COMMIT')
      return changed
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const heartbeatTask: JournalStore['heartbeatTask'] = (input) => {
    const leaseExpiresAt = new Date(new Date(input.at).getTime() + input.leaseMilliseconds).toISOString()
    return database.prepare(`
      UPDATE tasks SET lease_expires_at = ?
      WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
        AND lease_expires_at > ?
    `).run(leaseExpiresAt, input.taskId, input.workerId, input.fence, input.at).changes === 1
  }

  const completeTask: JournalStore['completeTask'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = database.prepare(`
        UPDATE tasks
        SET state_tag = 'Completed', evidence = ?, reason = NULL, worker_id = NULL,
          lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
          AND lease_expires_at > ?
          AND revision_id = (SELECT current_revision_id FROM subjects WHERE subjects.id = tasks.subject_id)
      `).run(input.evidence, input.at, input.taskId, input.workerId, input.fence, input.at)
      if (result.changes === 1) {
        recordTransition(database, { taskId: input.taskId, from: 'Running', to: 'Completed', reason: null, fence: input.fence, at: input.at })
        resolveTaskIncidents(database, input.taskId, input.at)
      }
      database.exec('COMMIT')
      return result.changes === 1
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const supersedeTask: JournalStore['supersedeTask'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = database.prepare(`
        UPDATE tasks
        SET state_tag = 'Superseded', reason = ?, evidence = NULL, worker_id = NULL,
          command_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
          AND lease_expires_at > ?
          AND revision_id = (SELECT current_revision_id FROM subjects WHERE subjects.id = tasks.subject_id)
      `).run(input.reason, input.at, input.taskId, input.workerId, input.fence, input.at)
      if (result.changes === 1) {
        recordTransition(database, {
          taskId: input.taskId,
          from: 'Running',
          to: 'Superseded',
          reason: input.reason,
          fence: input.fence,
          ...(input.usage === undefined ? {} : { usage: input.usage }),
          at: input.at,
        })
        resolveTaskIncidents(database, input.taskId, input.at)
      }
      database.exec('COMMIT')
      return result.changes === 1
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const needsAttentionTask: JournalStore['needsAttentionTask'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const result = database.prepare(`
        UPDATE tasks
        SET state_tag = 'ActionRequired', reason = ?, evidence = ?, worker_id = NULL,
          lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
          AND lease_expires_at > ?
          AND revision_id = (SELECT current_revision_id FROM subjects WHERE subjects.id = tasks.subject_id)
      `).run(input.reason, input.evidence, input.at, input.taskId, input.workerId, input.fence, input.at)
      if (result.changes === 1) {
        recordTransition(database, {
          taskId: input.taskId,
          from: 'Running',
          to: 'ActionRequired',
          reason: input.reason,
          fence: input.fence,
          ...(input.usage === undefined ? {} : { usage: input.usage }),
          at: input.at,
        })
      }
      database.exec('COMMIT')
      return result.changes === 1
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const failTask: JournalStore['failTask'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const row = database.prepare(`
        SELECT tasks.attempts, tasks.max_attempts, repositories.writes_enabled
        FROM tasks
        JOIN subjects ON subjects.id = tasks.subject_id
        JOIN repositories ON repositories.id = subjects.repository_id
        WHERE tasks.id = ? AND tasks.state_tag = 'Running'
          AND tasks.worker_id = ? AND tasks.fence = ?
          AND tasks.lease_expires_at > ?
      `).get(input.taskId, input.workerId, input.fence, input.at) as { attempts: number, max_attempts: number, writes_enabled: number } | undefined
      if (row === undefined) {
        database.exec('COMMIT')
        return 'Rejected'
      }
      // An agent Task pays for a retry with a whole agent turn, so a reason no
      // retry can satisfy ends the Task now and names an Incident instead.
      const providerPaused = isProviderCircuitPause(input.reason)
      const writesDisabled = mutationsEnabled && row.writes_enabled === 0
      const retry = writesDisabled || providerPaused || (row.attempts < row.max_attempts && mayRetryFailure({ message: input.reason }))
      const nextTag = retry ? 'Queued' : 'Failed'
      database.prepare(`
        UPDATE tasks SET state_tag = ?, reason = ?,
          attempts = CASE WHEN ? THEN MAX(0, attempts - 1) ELSE attempts END,
          worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
          AND lease_expires_at > ?
      `).run(nextTag, retry ? null : input.reason, writesDisabled || providerPaused ? 1 : 0, input.at, input.taskId, input.workerId, input.fence, input.at)
      recordTransition(database, {
        taskId: input.taskId,
        from: 'Running',
        to: nextTag,
        reason: input.reason,
        fence: input.fence,
        at: input.at,
      })
      // Conflict resolution, repair, Baseline repair, and issue work all fail
      // through here. Without this they never reached the System pane, so half
      // the Task kinds could die silently.
      if (writesDisabled)
        resolveTaskIncidents(database, input.taskId, input.at)
      else if (!retry)
        recordTaskIncident(database, input.taskId, input.reason, input.at)
      database.exec('COMMIT')
      return retry ? 'Retrying' : 'Failed'
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const stagePublication: JournalStore['stagePublication'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const existing = database.prepare(`
        SELECT id, commit_sha, base_sha, base_ref, expected_head_sha, head_ref, artifact_ref, patch_digest,
          changed_files, pull_request_title, pull_request_body
        FROM publication_commands
        WHERE task_id = ? AND state_tag IN ('Pending', 'Running', 'Published')
      `).get(input.taskId) as {
        id: string
        commit_sha: string
        base_sha: string
        base_ref: string
        expected_head_sha: string
        head_ref: string
        artifact_ref: string
        patch_digest: string
        changed_files: number
        pull_request_title: string | null
        pull_request_body: string | null
      } | undefined
      if (existing !== undefined) {
        const publication = input.publication
        const duplicate = existing.commit_sha === publication.commitSha
          && existing.base_sha === publication.baseSha
          && existing.base_ref === publication.baseRef
          && existing.expected_head_sha === publication.expectedHeadSha
          && existing.head_ref === publication.headRef
          && existing.artifact_ref === publication.artifactRef
          && existing.patch_digest === publication.patchDigest
          && existing.changed_files === publication.changedFiles
          && existing.pull_request_title === (publication._tag === 'OpenPullRequest' ? publication.pullRequestTitle : null)
          && existing.pull_request_body === (publication._tag === 'OpenPullRequest' ? publication.pullRequestBody : null)
        database.exec('COMMIT')
        return duplicate
          ? { _tag: 'Duplicate', commandId: existing.id }
          : { _tag: 'Rejected', reason: 'The task already has a different publication command.' }
      }

      const task = database.prepare(`
        SELECT revisions.payload, tasks.kind
        FROM tasks
        JOIN subjects ON subjects.id = tasks.subject_id
        JOIN revisions ON revisions.id = tasks.revision_id
        JOIN repositories ON repositories.id = subjects.repository_id
        WHERE tasks.id = ? AND tasks.state_tag = 'Running'
          AND tasks.worker_id = ? AND tasks.fence = ?
          AND tasks.lease_expires_at > ?
          AND tasks.revision_id = subjects.current_revision_id
          AND repositories.enabled = 1
          ${repositoryWriteAuthoritySql}
          AND ${PUBLICATION_AUTHORITY_SQL}
      `).get(input.taskId, input.workerId, input.fence, input.at) as { payload: string, kind: AgentTask['kind'] } | undefined
      if (task === undefined) {
        database.exec('COMMIT')
        return { _tag: 'Rejected', reason: 'The task fence or repository policy no longer authorizes publication.' }
      }
      const subject = JSON.parse(task.payload) as GitHubItem
      const publication = input.publication
      const matches = publication._tag === 'UpdatePullRequest'
        ? task.kind === publication.taskKind
        && subject.kind === 'pull_request'
        && subject.headSha === publication.expectedHeadSha
        && subject.headRef === publication.headRef
        && (publication.headRepository === undefined || subject.headRepository === publication.headRepository)
        : (task.kind === 'issue_work' && subject.kind === 'issue')
          || (
            task.kind === 'baseline_repair'
            && publication.taskKind === 'baseline_repair'
            && subject.kind === 'pull_request'
            && subject.baseSha === publication.expectedHeadSha
          )
      if (!matches) {
        database.exec('COMMIT')
        return { _tag: 'Rejected', reason: 'The publication does not match the current GitHub state.' }
      }

      const commandId = digest(JSON.stringify({
        taskId: input.taskId,
        publication,
      }))
      database.prepare(`
        INSERT INTO publication_commands (
          id, task_id, state_tag, commit_sha, base_sha, base_ref, expected_head_sha, head_ref,
          artifact_ref, patch_digest, changed_files, pull_request_title, pull_request_body, updated_at
        ) VALUES (?, ?, 'Pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        commandId,
        input.taskId,
        publication.commitSha,
        publication.baseSha,
        publication.baseRef,
        publication.expectedHeadSha,
        publication.headRef,
        publication.artifactRef,
        publication.patchDigest,
        publication.changedFiles,
        publication._tag === 'OpenPullRequest' ? publication.pullRequestTitle : null,
        publication._tag === 'OpenPullRequest' ? publication.pullRequestBody : null,
        input.at,
      )
      recordPublicationEvent(database, {
        commandId,
        from: null,
        to: 'Pending',
        reason: null,
        fence: 0,
        at: input.at,
      })
      const update = database.prepare(`
        UPDATE tasks
        SET state_tag = 'Publishing', worker_id = NULL, lease_expires_at = NULL,
          command_id = ?, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
      `).run(commandId, input.at, input.taskId, input.workerId, input.fence)
      if (update.changes !== 1)
        throw new Error(`Publication staging lost the task fence for ${input.taskId}.`)
      recordTransition(database, {
        taskId: input.taskId,
        from: 'Running',
        to: 'Publishing',
        reason: null,
        fence: input.fence,
        ...(input.usage === undefined ? {} : { usage: input.usage }),
        at: input.at,
      })
      database.exec('COMMIT')
      return { _tag: 'Staged', commandId }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const recoverExpiredPublications = (now: string): void => {
    const expired = database.prepare(`
      SELECT id, fence FROM publication_commands
      WHERE state_tag = 'Running' AND lease_expires_at <= ?
    `).all(now) as unknown as Array<{ id: string, fence: number }>
    expired.forEach((command) => {
      const reason = 'Publication lease expired. Remote state requires reconciliation.'
      const update = database.prepare(`
        UPDATE publication_commands
        SET state_tag = 'Pending', outcome_unknown = 1, reason = ?, worker_id = NULL,
          lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND fence = ?
      `).run(reason, now, command.id, command.fence)
      if (update.changes === 1) {
        recordPublicationEvent(database, {
          commandId: command.id,
          from: 'Running',
          to: 'Pending',
          reason,
          fence: command.fence,
          at: now,
        })
      }
    })
  }

  const claimNextPublication: JournalStore['claimNextPublication'] = (workerId, now, leaseMilliseconds) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      recoverExpiredPublications(now)
      const row = database.prepare(`
        SELECT
          publication_commands.id,
          publication_commands.task_id,
          tasks.kind AS task_kind,
          repositories.github AS repository,
          subjects.github_number,
          publication_commands.commit_sha,
          publication_commands.base_sha,
          publication_commands.base_ref,
          publication_commands.expected_head_sha,
          publication_commands.head_ref,
          publication_commands.artifact_ref,
          publication_commands.patch_digest,
          publication_commands.changed_files,
          publication_commands.outcome_unknown,
          publication_commands.pull_request_title,
          publication_commands.pull_request_body,
          json_extract(revisions.payload, '$.headRepository') AS head_repository,
          publication_commands.worker_id,
          publication_commands.fence,
          publication_commands.lease_expires_at,
          repositories.policy_json
        FROM publication_commands
        JOIN tasks ON tasks.id = publication_commands.task_id
        JOIN subjects ON subjects.id = tasks.subject_id
        JOIN repositories ON repositories.id = subjects.repository_id
        JOIN revisions ON revisions.id = tasks.revision_id
        WHERE publication_commands.state_tag = 'Pending'
          AND tasks.state_tag = 'Publishing'
          AND tasks.command_id = publication_commands.id
          AND tasks.revision_id = subjects.current_revision_id
          AND repositories.enabled = 1
          ${repositoryWriteAuthoritySql}
          AND ${PUBLICATION_AUTHORITY_SQL}
        ORDER BY publication_commands.updated_at, publication_commands.id
        LIMIT 1
      `).get() as PublicationRow | undefined
      if (row === undefined) {
        database.exec('COMMIT')
        return null
      }

      const fence = row.fence + 1
      const leaseExpiresAt = new Date(new Date(now).getTime() + leaseMilliseconds).toISOString()
      const update = database.prepare(`
        UPDATE publication_commands
        SET state_tag = 'Running', worker_id = ?, fence = ?, attempts = attempts + 1,
          lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND state_tag = 'Pending' AND fence = ?
      `).run(workerId, fence, leaseExpiresAt, now, row.id, row.fence)
      if (update.changes !== 1)
        throw new Error(`Publication claim lost for ${row.id}.`)
      recordPublicationEvent(database, {
        commandId: row.id,
        from: 'Pending',
        to: 'Running',
        reason: null,
        fence,
        at: now,
      })
      database.exec('COMMIT')
      const common = {
        id: row.id,
        taskId: row.task_id,
        repository: row.repository,
        commitSha: row.commit_sha,
        baseSha: row.base_sha,
        baseRef: row.base_ref,
        expectedHeadSha: row.expected_head_sha,
        headRef: row.head_ref,
        artifactRef: row.artifact_ref,
        patchDigest: row.patch_digest,
        changedFiles: row.changed_files,
        outcomeUnknown: row.outcome_unknown === 1,
        workerId,
        fence,
        leaseExpiresAt,
        repositoryMapping: JSON.parse(row.policy_json) as RepositoryMapping,
      }
      if (row.task_kind === 'issue_work' || row.task_kind === 'baseline_repair') {
        if (row.pull_request_title === null || row.pull_request_body === null)
          throw new Error(`Pull request Publication ${row.id} has no pull request content.`)
        return row.task_kind === 'issue_work'
          ? {
              ...common,
              _tag: 'OpenPullRequest',
              taskKind: row.task_kind,
              issueNumber: row.github_number,
              pullRequestTitle: row.pull_request_title,
              pullRequestBody: row.pull_request_body,
            }
          : {
              ...common,
              _tag: 'OpenPullRequest',
              taskKind: row.task_kind,
              pullRequestNumber: row.github_number,
              pullRequestTitle: row.pull_request_title,
              pullRequestBody: row.pull_request_body,
            }
      }
      return {
        ...common,
        _tag: 'UpdatePullRequest',
        taskKind: row.task_kind,
        pullRequestNumber: row.github_number,
        headRepository: row.head_repository,
      }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const authorizePublication: JournalStore['authorizePublication'] = input => database.prepare(`
    SELECT 1
    FROM publication_commands
    JOIN tasks ON tasks.id = publication_commands.task_id
    JOIN subjects ON subjects.id = tasks.subject_id
    JOIN repositories ON repositories.id = subjects.repository_id
    WHERE publication_commands.id = ? AND publication_commands.state_tag = 'Running'
      AND publication_commands.worker_id = ? AND publication_commands.fence = ?
      AND publication_commands.lease_expires_at > ?
      AND tasks.state_tag = 'Publishing' AND tasks.command_id = publication_commands.id
      AND tasks.revision_id = subjects.current_revision_id
      AND repositories.enabled = 1
      ${repositoryWriteAuthoritySql}
      AND ${PUBLICATION_AUTHORITY_SQL}
  `).get(input.commandId, input.workerId, input.fence, input.at) !== undefined

  const heartbeatPublication: JournalStore['heartbeatPublication'] = (input) => {
    const leaseExpiresAt = new Date(new Date(input.at).getTime() + input.leaseMilliseconds).toISOString()
    return database.prepare(`
      UPDATE publication_commands SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
        AND lease_expires_at > ?
    `).run(leaseExpiresAt, input.at, input.commandId, input.workerId, input.fence, input.at).changes === 1
  }

  const completePublication: JournalStore['completePublication'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const command = database.prepare(`
        UPDATE publication_commands
        SET state_tag = 'Published', worker_id = NULL, lease_expires_at = NULL,
          published_at = ?, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
          AND task_id IN (
            SELECT tasks.id FROM tasks
            JOIN subjects ON subjects.id = tasks.subject_id
            WHERE tasks.state_tag = 'Publishing' AND tasks.command_id = publication_commands.id
              AND tasks.revision_id = subjects.current_revision_id
          )
      `).run(input.at, input.at, input.commandId, input.workerId, input.fence)
      if (command.changes !== 1) {
        database.exec('COMMIT')
        return false
      }
      const task = database.prepare(`
        SELECT publication_commands.task_id, tasks.fence AS task_fence
        FROM publication_commands
        JOIN tasks ON tasks.id = publication_commands.task_id
        WHERE publication_commands.id = ?
      `).get(input.commandId) as { task_id: string, task_fence: number }
      database.prepare(`
        UPDATE tasks
        SET state_tag = 'Completed', evidence = ?, command_id = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Publishing' AND command_id = ?
      `).run(input.evidence, input.at, task.task_id, input.commandId)
      recordPublicationEvent(database, {
        commandId: input.commandId,
        from: 'Running',
        to: 'Published',
        reason: null,
        fence: input.fence,
        at: input.at,
      })
      recordTransition(database, {
        taskId: task.task_id,
        from: 'Publishing',
        to: 'Completed',
        reason: null,
        fence: task.task_fence,
        at: input.at,
      })
      database.exec('COMMIT')
      return true
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const supersedePublication: JournalStore['supersedePublication'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const command = database.prepare(`
        UPDATE publication_commands
        SET state_tag = 'Superseded', reason = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
          AND lease_expires_at > ?
      `).run(input.reason, input.at, input.commandId, input.workerId, input.fence, input.at)
      if (command.changes !== 1) {
        database.exec('COMMIT')
        return false
      }
      const task = database.prepare(`
        SELECT publication_commands.task_id, tasks.fence AS task_fence
        FROM publication_commands
        JOIN tasks ON tasks.id = publication_commands.task_id
        WHERE publication_commands.id = ?
      `).get(input.commandId) as { task_id: string, task_fence: number }
      database.prepare(`
        UPDATE tasks
        SET state_tag = 'Superseded', reason = ?, command_id = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Publishing' AND command_id = ?
      `).run(input.reason, input.at, task.task_id, input.commandId)
      recordPublicationEvent(database, {
        commandId: input.commandId,
        from: 'Running',
        to: 'Superseded',
        reason: input.reason,
        fence: input.fence,
        at: input.at,
      })
      recordTransition(database, {
        taskId: task.task_id,
        from: 'Publishing',
        to: 'Superseded',
        reason: input.reason,
        fence: task.task_fence,
        at: input.at,
      })
      database.exec('COMMIT')
      return true
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const deferPublication: JournalStore['deferPublication'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const update = database.prepare(`
        UPDATE publication_commands
        SET state_tag = 'Pending', outcome_unknown = 1, reason = ?, worker_id = NULL,
          lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
          AND lease_expires_at > ?
      `).run(input.reason, input.at, input.commandId, input.workerId, input.fence, input.at)
      if (update.changes === 1) {
        recordPublicationEvent(database, {
          commandId: input.commandId,
          from: 'Running',
          to: 'Pending',
          reason: input.reason,
          fence: input.fence,
          at: input.at,
        })
      }
      database.exec('COMMIT')
      return update.changes === 1
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const failPublication: JournalStore['failPublication'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const row = database.prepare(`
        SELECT publication_commands.task_id, publication_commands.attempts,
          publication_commands.max_attempts, tasks.fence AS task_fence,
          repositories.writes_enabled
        FROM publication_commands
        JOIN tasks ON tasks.id = publication_commands.task_id
        JOIN subjects ON subjects.id = tasks.subject_id
        JOIN repositories ON repositories.id = subjects.repository_id
        WHERE publication_commands.id = ? AND publication_commands.state_tag = 'Running'
          AND publication_commands.worker_id = ? AND publication_commands.fence = ?
          AND publication_commands.lease_expires_at > ?
      `).get(input.commandId, input.workerId, input.fence, input.at) as { task_id: string, attempts: number, max_attempts: number, task_fence: number, writes_enabled: number } | undefined
      if (row === undefined) {
        database.exec('COMMIT')
        return 'Rejected'
      }
      const writesDisabled = mutationsEnabled && row.writes_enabled === 0
      const retry = writesDisabled || row.attempts < row.max_attempts
      database.prepare(`
        UPDATE publication_commands
        SET state_tag = ?, reason = ?,
          attempts = CASE WHEN ? THEN MAX(0, attempts - 1) ELSE attempts END,
          worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
          AND lease_expires_at > ?
      `).run(retry ? 'Pending' : 'Failed', writesDisabled ? null : input.reason, writesDisabled ? 1 : 0, input.at, input.commandId, input.workerId, input.fence, input.at)
      recordPublicationEvent(database, {
        commandId: input.commandId,
        from: 'Running',
        to: retry ? 'Pending' : 'Failed',
        reason: input.reason,
        fence: input.fence,
        at: input.at,
      })
      if (writesDisabled) {
        resolveTaskIncidents(database, row.task_id, input.at)
      }
      else if (!retry) {
        const task = database.prepare(`
          UPDATE tasks
          SET state_tag = 'Failed', reason = ?, command_id = NULL, updated_at = ?
          WHERE id = ? AND state_tag = 'Publishing' AND command_id = ?
        `).run(input.reason, input.at, row.task_id, input.commandId)
        if (task.changes === 1) {
          recordTransition(database, {
            taskId: row.task_id,
            from: 'Publishing',
            to: 'Failed',
            reason: input.reason,
            fence: row.task_fence,
            at: input.at,
          })
          recordTaskIncident(database, row.task_id, input.reason, input.at)
        }
      }
      database.exec('COMMIT')
      return retry ? 'Retrying' : 'Failed'
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const getAgentControl = (): StoredAgentControl => {
    const row = database.prepare('SELECT state_tag, updated_at FROM agent_control WHERE singleton = 1').get() as {
      state_tag: 'Running' | 'Paused'
      updated_at: string
    }
    return row.state_tag === 'Running' ? { _tag: 'Running' } : { _tag: 'Paused', pausedAt: row.updated_at }
  }

  const restartRequestFromRow = (row: RestartRequestRow): RestartRequest => {
    const operation: RestartOperation = row.operation_tag === 'Restart'
      ? { _tag: 'Restart' }
      : row.target_commit !== null
        ? { _tag: 'Update', targetCommit: row.target_commit }
        : (() => { throw new Error('An Update request needs its target commit.') })()
    const base = { id: row.id, source: row.source_tag, operation, requestedAt: row.requested_at }
    switch (row.state_tag) {
      case 'Requested':
        return { _tag: 'Requested', ...base }
      case 'Restarting':
        if (row.restarting_at === null)
          throw new Error('A Restarting request needs its restart time.')
        return { _tag: 'Restarting', ...base, restartingAt: row.restarting_at }
      case 'Completed':
        if (row.restarting_at === null || row.completed_at === null)
          throw new Error('A Completed Restart request needs restart and completion times.')
        return { _tag: 'Completed', ...base, restartingAt: row.restarting_at, completedAt: row.completed_at }
      case 'ActionRequired':
        if (row.action_required_at === null || row.reason === null)
          throw new Error('An Action required Restart request needs its time and reason.')
        return { _tag: 'ActionRequired', ...base, actionRequiredAt: row.action_required_at, reason: row.reason }
    }
  }

  const restartRequestById = (id: string): RestartRequest | null => {
    const row = database.prepare(`
      SELECT id, source_tag, operation_tag, target_commit, state_tag, requested_at, restarting_at, completed_at, action_required_at, reason
      FROM restart_requests WHERE id = ?
    `).get(id) as RestartRequestRow | undefined
    return row === undefined ? null : restartRequestFromRow(row)
  }

  const getRestartRequest = (): RestartRequest | null => {
    const row = database.prepare(`
      SELECT id, source_tag, operation_tag, target_commit, state_tag, requested_at, restarting_at, completed_at, action_required_at, reason
      FROM restart_requests ORDER BY rowid DESC LIMIT 1
    `).get() as RestartRequestRow | undefined
    return row === undefined ? null : restartRequestFromRow(row)
  }

  const activeRestartRequest = (): RestartRequest | null => {
    const row = database.prepare(`
      SELECT id, source_tag, operation_tag, target_commit, state_tag, requested_at, restarting_at, completed_at, action_required_at, reason
      FROM restart_requests WHERE state_tag IN ('Requested', 'Restarting') LIMIT 1
    `).get() as RestartRequestRow | undefined
    return row === undefined ? null : restartRequestFromRow(row)
  }

  const requestRestart: JournalStore['requestRestart'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const active = activeRestartRequest()
      if (active !== null) {
        database.exec('COMMIT')
        return active
      }
      database.prepare(`
        INSERT INTO restart_requests (id, source_tag, operation_tag, target_commit, state_tag, requested_at)
        VALUES (?, ?, ?, ?, 'Requested', ?)
      `).run(
        input.id,
        input.source,
        input.operation._tag,
        input.operation._tag === 'Update' ? input.operation.targetCommit : null,
        input.at,
      )
      const created = restartRequestById(input.id)
      if (created === null)
        throw new Error('The Restart request was not stored.')
      database.exec('COMMIT')
      return created
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const beginRestart: JournalStore['beginRestart'] = (input) => {
    const result = database.prepare(`
      UPDATE restart_requests
      SET state_tag = 'Restarting', restarting_at = ?, process_id = ?
      WHERE id = ? AND state_tag = 'Requested'
    `).run(input.at, input.processId, input.id)
    return result.changes === 0 ? null : restartRequestById(input.id)
  }

  const completeRestart: JournalStore['completeRestart'] = (at) => {
    const restarting = activeRestartRequest()
    if (restarting?._tag !== 'Restarting')
      return null
    database.prepare(`
      UPDATE restart_requests SET state_tag = 'Completed', completed_at = ?
      WHERE id = ? AND state_tag = 'Restarting'
    `).run(at, restarting.id)
    return restartRequestById(restarting.id)
  }

  const requireRestartAction: JournalStore['requireRestartAction'] = (input) => {
    const result = database.prepare(`
      UPDATE restart_requests
      SET state_tag = 'ActionRequired', action_required_at = ?, reason = ?
      WHERE id = ? AND state_tag = 'Requested'
    `).run(input.at, input.reason, input.id)
    return result.changes === 0 ? null : restartRequestById(input.id)
  }

  /**
   * A Dismissal is a decision about the Item, not about one head commit.
   *
   * Cancelling live work is part of dismissing: leaving an agent running on an
   * Item that is never going to be acted on spends the budget it saves.
   */
  const dismissItem: JournalStore['dismissItem'] = (input) => {
    const row = database.prepare(`
      SELECT subjects.id AS subject_id
      FROM subjects
      JOIN repositories ON repositories.id = subjects.repository_id
      WHERE repositories.github = ? AND subjects.github_number = ?
    `).get(input.repository, input.itemNumber) as { subject_id: number } | undefined
    if (row === undefined)
      return { _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }

    database.exec('BEGIN IMMEDIATE')
    try {
      const inserted = database.prepare(`
        INSERT OR IGNORE INTO item_dismissals (subject_id, dismissed_at) VALUES (?, ?)
      `).run(row.subject_id, input.at)
      cancelSubjectTasks(database, row.subject_id, input.at, 'The item is dismissed.')
      database.exec('COMMIT')
      return { _tag: inserted.changes === 1 ? 'Dismissed' : 'Duplicate' }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Restoring queues nothing by itself.
   *
   * The next observation replans the Item from its current state, which is the
   * one path that decides what it needs. Queueing here would guess.
   */
  const restoreItem: JournalStore['restoreItem'] = (input) => {
    const row = database.prepare(`
      SELECT subjects.id AS subject_id
      FROM subjects
      JOIN repositories ON repositories.id = subjects.repository_id
      WHERE repositories.github = ? AND subjects.github_number = ?
    `).get(input.repository, input.itemNumber) as { subject_id: number } | undefined
    if (row === undefined)
      return { _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }
    const removed = database.prepare('DELETE FROM item_dismissals WHERE subject_id = ?').run(row.subject_id)
    return { _tag: removed.changes === 1 ? 'Restored' : 'Duplicate' }
  }

  const getSelectionMode = (): SelectionMode => selectionMode(database)

  /**
   * Switching to Manual leaves running work alone. Queued reviews without
   * Approval are superseded on the next observation, as Pause does.
   */
  const setSelectionMode = (mode: SelectionMode): SelectionMode => {
    database.prepare('UPDATE agent_control SET selection_mode = ? WHERE singleton = 1').run(mode)
    return getSelectionMode()
  }

  const pauseAgents = (at: string): StoredAgentControl => {
    database.prepare(`
      UPDATE agent_control SET state_tag = 'Paused', updated_at = ?
      WHERE singleton = 1 AND state_tag = 'Running'
    `).run(at)
    return getAgentControl()
  }

  /**
   * Pausing one repository stops new claims for it. In-flight work finishes and
   * publishes, matching how the global pause behaves.
   */
  const setRepositoryPaused = (github: string, paused: boolean): boolean => {
    const result = database.prepare(`
      UPDATE repositories SET paused = ? WHERE github = ?
    `).run(paused ? 1 : 0, github)
    return result.changes > 0
  }

  /**
   * The last gate before any GitHub write leaves the process.
   *
   * A repository the controller has never been trusted to write to answers
   * false, whatever discovery, policy, or an agent believes. An unknown
   * repository answers false too, because a write to something the journal
   * cannot name is the case this exists to stop.
   */
  const mayWriteRepository = (github: string): boolean => {
    const row = database.prepare(`
      SELECT writes_enabled FROM repositories WHERE github = ?
    `).get(github) as { writes_enabled: number } | undefined
    return row?.writes_enabled === 1
  }

  const setRepositoryWritesEnabled = (github: string, writesEnabled: boolean): boolean => {
    const result = database.prepare(`
      UPDATE repositories SET writes_enabled = ? WHERE github = ?
    `).run(writesEnabled ? 1 : 0, github)
    return result.changes > 0
  }

  const resumeAgents = (at: string): StoredAgentControl => {
    database.prepare(`
      UPDATE agent_control SET state_tag = 'Running', updated_at = ?
      WHERE singleton = 1 AND state_tag = 'Paused'
    `).run(at)
    return getAgentControl()
  }

  const isSafeToRestart: JournalStore['isSafeToRestart'] = (at = '') => {
    const row = database.prepare(`
      SELECT (
        EXISTS (
          SELECT 1 FROM tasks
          WHERE state_tag = 'Publishing'
            OR (state_tag = 'Running' AND (lease_expires_at IS NULL OR lease_expires_at > ?))
        )
        OR EXISTS (
          SELECT 1 FROM worker_tasks
          WHERE state_tag = 'Running' AND (lease_expires_at IS NULL OR lease_expires_at > ?)
        )
        OR EXISTS (
          SELECT 1 FROM routine_runs
          WHERE state_tag = 'Running' AND (lease_expires_at IS NULL OR lease_expires_at > ?)
        )
        OR EXISTS (
          SELECT 1 FROM publication_commands
          WHERE state_tag = 'Pending'
            OR (state_tag = 'Running' AND (lease_expires_at IS NULL OR lease_expires_at > ?))
        )
        OR EXISTS (
          SELECT 1 FROM review_status_commands
          WHERE (state_tag = 'Running' AND (lease_expires_at IS NULL OR lease_expires_at > ?))
            OR (state_tag = 'Pending' AND phase = 'terminal')
        )
        OR EXISTS (
          SELECT 1 FROM issue_triage_comment_commands
          WHERE state_tag = 'Running' AND (lease_expires_at IS NULL OR lease_expires_at > ?)
        )
        OR EXISTS (
          SELECT 1 FROM candidate_issue_commands
          WHERE state_tag = 'Running' AND (lease_expires_at IS NULL OR lease_expires_at > ?)
        )
        OR EXISTS (
          SELECT 1 FROM routine_report_commands
          WHERE state_tag = 'Running' AND (lease_expires_at IS NULL OR lease_expires_at > ?)
        )
      ) AS busy
    `).get(at, at, at, at, at, at, at, at) as { busy: number }
    return row.busy === 0
  }

  const prepareForRestart: JournalStore['prepareForRestart'] = (at) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const terminalRows = database.prepare(`
        SELECT id, fence FROM review_status_commands
        WHERE state_tag = 'Running' AND phase = 'terminal' AND lease_expires_at <= ?
      `).all(at) as unknown as Array<{ id: string, fence: number }>
      const progressRows = database.prepare(`
        SELECT id, fence FROM review_status_commands
        WHERE state_tag = 'Running' AND phase != 'terminal' AND lease_expires_at <= ?
      `).all(at) as unknown as Array<{ id: string, fence: number }>
      database.prepare(`
        UPDATE review_status_commands
        SET state_tag = 'Pending', outcome_unknown = 1,
          reason = 'The automated review did not finish before the Restart request.',
          worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE state_tag = 'Running' AND phase = 'terminal' AND lease_expires_at <= ?
      `).run(at, at)
      terminalRows.forEach(row => recordReviewStatusEvent(database, {
        commandId: row.id,
        event: 'LeaseRecovered',
        from: 'Running',
        to: 'Pending',
        reason: 'The automated review did not finish before the Restart request.',
        fence: row.fence,
        at,
      }))
      database.prepare(`
        UPDATE review_status_commands
        SET state_tag = 'Superseded',
          reason = 'The automated review did not finish before the Restart request.',
          worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE state_tag = 'Running' AND phase != 'terminal' AND lease_expires_at <= ?
      `).run(at, at)
      progressRows.forEach(row => recordReviewStatusEvent(database, {
        commandId: row.id,
        event: 'RestartSuperseded',
        from: 'Running',
        to: 'Superseded',
        reason: 'The automated review did not finish before the Restart request.',
        fence: row.fence,
        at,
      }))
      database.exec('COMMIT')
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    return isSafeToRestart(at)
  }

  const listWorkflowEvents: JournalStore['listWorkflowEvents'] = (input = {}) => {
    const limit = Math.max(1, Math.min(1_000, input.limit ?? 200))
    const rows = input.stream === undefined
      ? database.prepare(`
          SELECT * FROM workflow_events
          ORDER BY occurred_at DESC, id DESC LIMIT ?
        `).all(limit)
      : database.prepare(`
          SELECT * FROM workflow_events WHERE stream = ?
          ORDER BY occurred_at DESC, id DESC LIMIT ?
        `).all(input.stream, limit)
    return (rows as unknown as Array<{
      id: number
      stream: WorkflowEventStream
      event: string
      entity_id: string
      repository: string | null
      item_number: number | null
      revision_id: string | null
      task_id: string | null
      from_state: string | null
      to_state: string
      reason: string | null
      attempt: number
      fence: number
      duration_ms: number | null
      usage: string | null
      occurred_at: string
    }>).map(row => ({
      id: row.id,
      stream: row.stream,
      event: row.event,
      entityId: row.entity_id,
      repository: row.repository,
      itemNumber: row.item_number,
      revisionId: row.revision_id,
      taskId: row.task_id,
      from: row.from_state,
      to: row.to_state,
      reason: row.reason,
      attempt: row.attempt,
      fence: row.fence,
      durationMilliseconds: row.duration_ms,
      usage: row.usage === null ? null : JSON.parse(row.usage) as AgentTokenUsage,
      occurredAt: row.occurred_at,
    }))
  }

  const providerFailureThreshold = 3
  const providerCircuitCooldownMilliseconds = 5 * 60_000

  const listProviderCircuits: JournalStore['listProviderCircuits'] = () =>
    (database.prepare(`
      SELECT * FROM provider_circuits
      ORDER BY updated_at DESC, id
    `).all() as unknown as ProviderCircuitRow[]).map(providerCircuitFromRow)

  const providerCanStart: JournalStore['providerCanStart'] = (input) => {
    const modelClause = input.model === undefined ? '' : 'AND model = ?'
    const parameters = input.model === undefined
      ? [input.provider, input.credential]
      : [input.provider, input.credential, input.model]
    const rows = database.prepare(`
      SELECT * FROM provider_circuits
      WHERE provider = ? AND credential = ? ${modelClause}
    `).all(...parameters) as unknown as ProviderCircuitRow[]
    return !rows.some(row =>
      (row.state_tag === 'Open' && Date.parse(row.retry_at ?? input.at) > Date.parse(input.at))
      || (row.state_tag === 'HalfOpen' && Date.parse(row.canary_lease_expires_at ?? input.at) > Date.parse(input.at)),
    )
  }

  const reserveProviderStart: JournalStore['reserveProviderStart'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const readRows = (): ProviderCircuitRow[] => database.prepare(`
        SELECT * FROM provider_circuits
        WHERE provider = ? AND credential = ? AND model = ?
        ORDER BY updated_at, id
      `).all(input.provider, input.credential, input.model) as unknown as ProviderCircuitRow[]

      for (const row of readRows()) {
        if (row.state_tag !== 'HalfOpen' || Date.parse(row.canary_lease_expires_at ?? input.at) > Date.parse(input.at))
          continue
        const retryAt = input.at
        const changed = database.prepare(`
          UPDATE provider_circuits
          SET state_tag = 'Open', retry_at = ?, canary_worker_id = NULL,
            canary_lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND state_tag = 'HalfOpen' AND canary_fence = ?
            AND canary_lease_expires_at <= ?
        `).run(retryAt, input.at, row.id, row.canary_fence, input.at).changes === 1
        if (changed) {
          const recovered = database.prepare('SELECT * FROM provider_circuits WHERE id = ?')
            .get(row.id) as unknown as ProviderCircuitRow
          recordProviderCircuitEvent(database, recovered, 'CanaryLeaseRecovered', 'HalfOpen', 'Open', input.at, 'The provider canary lease expired.')
        }
      }

      const rows = readRows()
      const activeCanary = rows.find(row => row.state_tag === 'HalfOpen')
      if (activeCanary !== undefined) {
        database.exec('COMMIT')
        return {
          _tag: 'Paused',
          retryAt: activeCanary.canary_lease_expires_at ?? input.at,
          reason: 'Another Agent Task owns the provider health canary.',
        }
      }
      const blocked = rows
        .filter(row => row.state_tag === 'Open' && Date.parse(row.retry_at ?? input.at) > Date.parse(input.at))
        .sort((left, right) => (right.retry_at ?? '').localeCompare(left.retry_at ?? ''))[0]
      if (blocked !== undefined) {
        database.exec('COMMIT')
        return {
          _tag: 'Paused',
          retryAt: blocked.retry_at ?? input.at,
          reason: 'The Agent provider circuit is open.',
        }
      }
      const eligible = rows.find(row => row.state_tag === 'Open')
      if (eligible === undefined) {
        database.exec('COMMIT')
        return { _tag: 'Allowed', canary: null }
      }
      const fence = eligible.canary_fence + 1
      const leaseExpiresAt = new Date(Date.parse(input.at) + input.leaseMilliseconds).toISOString()
      const claimed = database.prepare(`
        UPDATE provider_circuits
        SET state_tag = 'HalfOpen', retry_at = NULL, canary_worker_id = ?,
          canary_fence = ?, canary_lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND state_tag = 'Open' AND retry_at <= ? AND canary_fence = ?
      `).run(input.workerId, fence, leaseExpiresAt, input.at, eligible.id, input.at, eligible.canary_fence).changes === 1
      if (!claimed)
        throw new Error(`Provider canary claim lost for ${eligible.id}.`)
      const claimedRow = database.prepare('SELECT * FROM provider_circuits WHERE id = ?')
        .get(eligible.id) as unknown as ProviderCircuitRow
      recordProviderCircuitEvent(database, claimedRow, 'CanaryClaimed', 'Open', 'HalfOpen', input.at)
      database.exec('COMMIT')
      return {
        _tag: 'Allowed',
        canary: { circuitId: eligible.id, workerId: input.workerId, fence },
      }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const recordProviderFailure: JournalStore['recordProviderFailure'] = (input) => {
    const id = input.canaryCircuitId ?? digest(`${input.provider}:${input.credential}:${input.model}:${input.failureClass}`)
    const detail = `The Agent provider reported a ${input.failureClass.replace('_', ' ')} failure.`
    database.exec('BEGIN IMMEDIATE')
    try {
      const existing = database.prepare('SELECT * FROM provider_circuits WHERE id = ?')
        .get(id) as unknown as ProviderCircuitRow | undefined
      if (existing === undefined) {
        if (input.canaryCircuitId !== undefined)
          throw new Error(`Provider canary circuit ${input.canaryCircuitId} no longer exists.`)
        database.prepare(`
          INSERT INTO provider_circuits (
            id, provider, credential, model, failure_class, state_tag, failures,
            retry_at, canary_worker_id, canary_fence, canary_lease_expires_at,
            last_detail, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'Closed', 1, NULL, NULL, 0, NULL, ?, ?)
        `).run(id, input.provider, input.credential, input.model, input.failureClass, detail, input.at)
        const inserted = database.prepare('SELECT * FROM provider_circuits WHERE id = ?')
          .get(id) as unknown as ProviderCircuitRow
        recordProviderCircuitEvent(database, inserted, 'FailureObserved', null, 'Closed', input.at, detail)
        database.exec('COMMIT')
        return providerCircuitFromRow(inserted)
      }

      const failures = existing.failures + 1
      const canaryFailed = existing.state_tag === 'HalfOpen'
        && existing.canary_worker_id === input.workerId
        && existing.canary_fence === input.canaryFence
      const shouldOpen = canaryFailed || (existing.state_tag === 'Closed' && failures >= providerFailureThreshold)
      const retryAt = shouldOpen
        ? new Date(Date.parse(input.at) + providerCircuitCooldownMilliseconds).toISOString()
        : existing.retry_at
      database.prepare(`
        UPDATE provider_circuits
        SET state_tag = ?, failures = ?, retry_at = ?,
          canary_worker_id = CASE WHEN ? = 'Open' THEN NULL ELSE canary_worker_id END,
          canary_lease_expires_at = CASE WHEN ? = 'Open' THEN NULL ELSE canary_lease_expires_at END,
          last_detail = ?, updated_at = ?
        WHERE id = ?
      `).run(
        shouldOpen ? 'Open' : existing.state_tag,
        failures,
        retryAt,
        shouldOpen ? 'Open' : existing.state_tag,
        shouldOpen ? 'Open' : existing.state_tag,
        detail,
        input.at,
        id,
      )
      const updated = database.prepare('SELECT * FROM provider_circuits WHERE id = ?')
        .get(id) as unknown as ProviderCircuitRow
      recordProviderCircuitEvent(
        database,
        updated,
        shouldOpen ? 'Opened' : 'FailureObserved',
        existing.state_tag,
        updated.state_tag,
        input.at,
        detail,
      )
      database.exec('COMMIT')
      return providerCircuitFromRow(updated)
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const recordProviderSuccess: JournalStore['recordProviderSuccess'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const rows = database.prepare(`
        SELECT * FROM provider_circuits
        WHERE provider = ? AND credential = ? AND model = ?
          ${input.canaryCircuitId === undefined ? '' : 'AND id = ?'}
      `).all(
        input.provider,
        input.credential,
        input.model,
        ...(input.canaryCircuitId === undefined ? [] : [input.canaryCircuitId]),
      ) as unknown as ProviderCircuitRow[]
      const ownsCanary = rows.some(row => row.state_tag === 'HalfOpen'
        && row.canary_worker_id === input.workerId
        && row.canary_fence === input.canaryFence)
      let changed = 0
      for (const row of rows) {
        const mayClose = input.canaryCircuitId === undefined
          ? row.state_tag === 'Closed'
          : ownsCanary && row.id === input.canaryCircuitId
        if (!mayClose || (row.state_tag === 'Closed' && row.failures === 0))
          continue
        const updated = database.prepare(`
          UPDATE provider_circuits
          SET state_tag = 'Closed', failures = 0, retry_at = NULL,
            canary_worker_id = NULL, canary_lease_expires_at = NULL, updated_at = ?
          WHERE id = ?
        `).run(input.at, row.id).changes === 1
        if (!updated)
          continue
        changed += 1
        const closed = database.prepare('SELECT * FROM provider_circuits WHERE id = ?')
          .get(row.id) as unknown as ProviderCircuitRow
        recordProviderCircuitEvent(database, closed, 'Closed', row.state_tag, 'Closed', input.at)
      }
      database.exec('COMMIT')
      return changed
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const getStats: JournalStore['getStats'] = (range, generatedAt) => {
    const from = Date.parse(range.from)
    const to = Date.parse(range.to)
    const queryFrom = new Date(from - (to - from)).toISOString()
    const facts: StatsFact[] = []

    const triageRows = database.prepare(`
      SELECT started_at, completed_at, outcome_tag
      FROM pull_request_triage_runs
      WHERE completed_at >= ? AND completed_at < ?
    `).all(queryFrom, range.to) as unknown as Array<{
      started_at: string
      completed_at: string
      outcome_tag: 'ReviewRequired' | 'ReviewSkipped' | 'ReviewRequiredAfterFailure'
    }>
    facts.push(...triageRows.map(row => ({
      _tag: 'PullRequestTriage' as const,
      at: row.completed_at,
      startedAt: row.started_at,
      outcome: row.outcome_tag,
    })))

    const reviewRows = database.prepare(`
      SELECT review_runs.started_at, review_runs.completed_at,
        COALESCE(review_gate_projections.outcome_tag, review_runs.outcome_tag) AS outcome_tag,
        review_runs.findings
      FROM review_runs
      LEFT JOIN review_gate_projections ON review_gate_projections.review_run_id = review_runs.id
      WHERE completed_at >= ? AND completed_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM review_runs AS settlement
          WHERE settlement.supersedes_review_run_id = review_runs.id
        )
    `).all(queryFrom, range.to) as unknown as Array<{
      started_at: string
      completed_at: string
      outcome_tag: 'Ready' | 'Pending' | 'Blocked'
      findings: string
    }>
    facts.push(...reviewRows.map((row) => {
      const findings = JSON.parse(row.findings) as ReviewFinding[]
      return {
        _tag: 'Review' as const,
        at: row.completed_at,
        startedAt: row.started_at,
        outcome: row.outcome_tag,
        findings: findings.filter(finding => finding._tag === 'Open').length,
      }
    }))

    const taskRows = database.prepare(`
      SELECT
        tasks.kind,
        terminal.to_tag,
        terminal.created_at,
        (
          SELECT MAX(started.created_at) FROM task_transitions AS started
          WHERE started.task_id = tasks.id AND started.to_tag = 'Running'
            AND started.created_at <= terminal.created_at
        ) AS started_at
      FROM task_transitions AS terminal
      JOIN tasks ON tasks.id = terminal.task_id
      WHERE terminal.to_tag IN ('Completed', 'ActionRequired', 'Failed', 'Superseded')
        AND terminal.created_at >= ? AND terminal.created_at < ?
      UNION ALL
      SELECT
        worker_tasks.kind,
        terminal.to_tag,
        terminal.created_at,
        (
          SELECT MAX(started.created_at) FROM worker_task_transitions AS started
          WHERE started.task_id = worker_tasks.id AND started.to_tag = 'Running'
            AND started.created_at <= terminal.created_at
        ) AS started_at
      FROM worker_task_transitions AS terminal
      JOIN worker_tasks ON worker_tasks.id = terminal.task_id
      WHERE worker_tasks.kind = 'issue_triage'
        AND terminal.to_tag IN ('Completed', 'ActionRequired', 'Failed', 'Superseded')
        AND terminal.created_at >= ? AND terminal.created_at < ?
    `).all(queryFrom, range.to, queryFrom, range.to) as unknown as Array<{
      kind: 'resolve_conflict' | 'review_fix' | 'baseline_repair' | 'issue_triage' | 'issue_work'
      to_tag: 'Completed' | 'ActionRequired' | 'Failed' | 'Superseded'
      created_at: string
      started_at: string | null
    }>
    const taskWork = (kind: typeof taskRows[number]['kind']): StatsTaskKind => kind === 'resolve_conflict' ? 'conflict_resolution' : kind
    facts.push(...taskRows.map(row => ({
      _tag: 'Task' as const,
      at: row.created_at,
      startedAt: row.started_at,
      work: taskWork(row.kind),
      outcome: row.to_tag,
    })))

    const publicationRows = database.prepare(`
      SELECT
        tasks.kind,
        repositories.github AS repository,
        subjects.github_number,
        publication_commands.changed_files,
        publication_commands.published_at
      FROM publication_commands
      JOIN tasks ON tasks.id = publication_commands.task_id
      JOIN subjects ON subjects.id = tasks.subject_id
      JOIN repositories ON repositories.id = subjects.repository_id
      WHERE publication_commands.state_tag = 'Published'
        AND publication_commands.published_at >= ? AND publication_commands.published_at < ?
    `).all(queryFrom, range.to) as unknown as Array<{
      kind: 'resolve_conflict' | 'review_fix' | 'baseline_repair' | 'issue_work'
      repository: string
      github_number: number
      changed_files: number
      published_at: string
    }>
    facts.push(...publicationRows.map(row => ({
      _tag: 'Publication' as const,
      at: row.published_at,
      repository: row.repository,
      itemNumber: row.github_number,
      work: row.kind === 'resolve_conflict' ? 'conflict_resolution' as const : row.kind,
      changedFiles: row.changed_files,
    })))

    const routineRows = database.prepare(`
      SELECT
        routine_runs.state_tag,
        routine_runs.updated_at,
        COUNT(candidates.id) AS candidates
      FROM routine_runs
      LEFT JOIN candidates ON candidates.run_id = routine_runs.id
      WHERE routine_runs.state_tag IN ('Completed', 'ActionRequired', 'Failed', 'Skipped', 'Superseded')
        AND routine_runs.updated_at >= ? AND routine_runs.updated_at < ?
      GROUP BY routine_runs.id
    `).all(queryFrom, range.to) as unknown as Array<{
      state_tag: 'Completed' | 'ActionRequired' | 'Failed' | 'Skipped' | 'Superseded'
      updated_at: string
      candidates: number
    }>
    facts.push(...routineRows.map(row => ({
      _tag: 'Routine' as const,
      at: row.updated_at,
      startedAt: null,
      outcome: row.state_tag,
      candidates: row.candidates,
    })))

    const coverage = database.prepare(`
      SELECT started_at FROM stats_coverage WHERE kind = 'pull_request_triage'
    `).get() as { started_at: string }
    return buildStats({
      facts,
      generatedAt,
      range,
      triageCoverageStartedAt: coverage.started_at,
    })
  }

  const getDashboardSnapshot = (generatedAt: string): DashboardSnapshot => {
    const repositoryRows = database.prepare(`
      SELECT
        repositories.github,
        repositories.enabled,
        repositories.writes_enabled,
        repositories.ownership,
        repositories.last_attempt_at,
        repositories.last_success_at,
        repositories.last_error,
        repositories.paused,
        COUNT(subjects.id) FILTER (
          WHERE json_extract(revisions.payload, '$.state') = 'open'
        ) AS subject_count
      FROM repositories
      LEFT JOIN subjects ON subjects.repository_id = repositories.id
      LEFT JOIN revisions ON revisions.id = subjects.current_revision_id
      WHERE repositories.enabled = 1
      GROUP BY repositories.id
      ORDER BY repositories.github
    `).all() as unknown as RepositoryRow[]
    const subjectRows = database.prepare(`
      SELECT
        repositories.github AS repository,
        repositories.policy_json,
        subjects.github_number,
        subjects.kind,
        json_extract(revisions.payload, '$.state') AS state,
        json_extract(revisions.payload, '$.title') AS title,
        json_extract(revisions.payload, '$.author') AS author,
        json_extract(revisions.payload, '$.url') AS url,
        json_extract(revisions.payload, '$.createdAt') AS github_created_at,
        json_extract(revisions.payload, '$.updatedAt') AS github_updated_at,
        json_extract(revisions.payload, '$.contentDigest') AS content_digest,
        json_extract(revisions.payload, '$.draft') AS draft,
        json_extract(revisions.payload, '$.baseSha') AS base_sha,
        json_extract(revisions.payload, '$.headSha') AS head_sha,
        json_extract(revisions.payload, '$.headRepository') AS head_repository,
        json_extract(revisions.payload, '$.headRef') AS head_ref,
        json_extract(revisions.payload, '$.mergeState') AS merge_state,
        json_extract(revisions.payload, '$.mergedAt') AS merged_at,
        revisions.id AS revision_id,
        revisions.observed_at,
        (
          SELECT approved_at FROM pull_request_approvals
          WHERE subject_id = subjects.id AND revision_id = revisions.id AND kind = 'review'
        ) AS review_approved_at,
        EXISTS (SELECT 1 FROM item_dismissals WHERE subject_id = subjects.id) AS dismissed
      FROM subjects
      JOIN repositories ON repositories.id = subjects.repository_id
      JOIN revisions ON revisions.id = subjects.current_revision_id
      WHERE repositories.enabled = 1 AND json_extract(revisions.payload, '$.state') = 'open'
      ORDER BY revisions.observed_at DESC
      LIMIT 100
    `).all() as unknown as DashboardSubjectRow[]
    const repositories: RepositoryStatus[] = repositoryRows.map(row => ({
      github: row.github,
      enabled: row.enabled === 1,
      writesEnabled: row.writes_enabled === 1,
      ownership: row.ownership,
      lastAttemptAt: row.last_attempt_at,
      lastSuccessAt: row.last_success_at,
      lastError: row.last_error,
      paused: row.paused === 1,
      subjectCount: row.subject_count,
    }))
    const incidents = listIncidents()
    const status = repositories.some(repository => repository.lastError !== null) || incidents.length > 0
      ? 'degraded'
      : repositories.some(repository => repository.lastSuccessAt === null) ? 'starting' : 'ready'
    const items = subjectRows.map(row => subjectFromRow(database, row))
    const tasks = taskRows(database).map(taskFromRow)
    const routines = listRoutines()
    const latestRoutineRuns = (database.prepare(`
      SELECT routine_runs.*, routines.repository AS repository, routines.name AS name
      FROM routine_runs
      JOIN routines ON routines.id = routine_runs.routine_id
      ORDER BY routine_runs.scheduled_for DESC
      LIMIT 50
    `).all() as unknown as RoutineRunRow[]).map(readRoutineRun)
    const routineIds = [...new Set([
      ...routines.map(routine => routine.id),
      ...latestRoutineRuns.map(run => run.routineId),
    ])]
    const candidatesByRoutine = new Map(routineIds.map(routineId => [routineId, listCandidates(routineId)]))
    // One report command per run, so the dashboard can tell a published run
    // from one still waiting on GitHub writes.
    const reportStateRows = latestRoutineRuns.length === 0
      ? []
      : database.prepare(`
          SELECT run_id, state_tag FROM routine_report_commands
          WHERE run_id IN (${latestRoutineRuns.map(() => '?').join(', ')})
        `).all(...latestRoutineRuns.map(run => run.id)) as unknown as Array<{ run_id: string, state_tag: RoutineReportCommandState }>
    const reportStatesByRun = new Map(reportStateRows.map(row => [row.run_id, row.state_tag]))
    const routineRuns = latestRoutineRuns
      .map(run => ({
        ...run,
        candidates: (candidatesByRoutine.get(run.routineId) ?? []).filter(candidate => candidate.runId === run.id),
        activity: [],
        reportState: reportStatesByRun.get(run.id) ?? null,
      }))
    const rejectedIssueWorkResults = new Map((database.prepare(`
      SELECT task_transitions.task_id, COUNT(*) AS occurrences
      FROM task_transitions
      JOIN tasks ON tasks.id = task_transitions.task_id
      WHERE tasks.kind = 'issue_work'
        AND (
          task_transitions.reason LIKE 'The agent returned pull request metadata that does not follow the PR skill%'
          OR task_transitions.reason LIKE 'The Agent returned invalid pull request text%'
        )
      GROUP BY task_transitions.task_id
      HAVING COUNT(*) > 1
    `).all() as unknown as Array<{ task_id: string, occurrences: number }>).map(row => [row.task_id, row.occurrences]))
    const reviewAgents = dashboardReviewAgents(database)
    const currentProvider = provider()
    const activeAgents = activeAgentRows(database, currentProvider).map(row => activeAgentFromRow(row, currentProvider))
    const agents: DashboardAgent[] = [
      ...activeAgents,
      ...reviewAgents,
    ]
    const mappings = new Map(subjectRows.map(row => [row.repository, JSON.parse(row.policy_json) as RepositoryMapping]))
    // Asks the Revision payload the same question the claim gate asks, so the
    // reason the dashboard shows for a held issue matches the reason the
    // scheduler acted on. The subject projection has no controller-owned
    // column, and a second rule here would drift from the gate.
    const openPullRequestsByRepository = new Map((database.prepare(`
      SELECT repositories.github AS repository, COUNT(*) AS total
      FROM subjects
      JOIN repositories ON repositories.id = subjects.repository_id
      JOIN revisions ON revisions.id = subjects.current_revision_id
      WHERE subjects.kind = 'pull_request'
        AND json_extract(revisions.payload, '$.state') = 'open'
        AND json_extract(revisions.payload, '$.controllerOwned') = 1
      GROUP BY repositories.github
    `).all() as unknown as Array<{ repository: string, total: number }>)
      .map(row => [row.repository, row.total] as const))
    const currentSelectionMode = selectionMode(database)
    const reviewResolutionRows = database.prepare(`
      SELECT repositories.github AS repository, subjects.github_number, review_resolutions.revision_id,
        review_resolutions.resolution_tag, review_resolutions.review_run_id,
        review_resolutions.baseline_task_id, review_resolutions.github_url, review_resolutions.reason
      FROM review_resolutions
      JOIN subjects ON subjects.id = review_resolutions.subject_id
        AND subjects.current_revision_id = review_resolutions.revision_id
      JOIN repositories ON repositories.id = subjects.repository_id
      WHERE subjects.kind = 'pull_request'
    `).all() as unknown as Array<{
      repository: string
      github_number: number
      revision_id: string
      resolution_tag: ReviewResolution['_tag']
      review_run_id: string | null
      baseline_task_id: string | null
      github_url: string | null
      reason: string | null
    }>
    const reviewResolutions = new Map(reviewResolutionRows.map((row): [string, ReviewResolution] => {
      const key = `${row.repository}:${row.github_number}:${row.revision_id}`
      switch (row.resolution_tag) {
        case 'Reviewed': return [key, { _tag: 'Reviewed', reviewRunId: row.review_run_id ?? '' }]
        case 'WaitingForBaselineRepair': return [key, { _tag: 'WaitingForBaselineRepair', taskId: row.baseline_task_id ?? '' }]
        case 'ExistingReview': return [key, { _tag: 'ExistingReview', url: row.github_url ?? '' }]
        case 'ReviewSkipped': return [key, { _tag: 'ReviewSkipped', reason: row.reason ?? 'Review skipped.' }]
        case 'UnknownNeedsReconciliation': return [key, { _tag: 'UnknownNeedsReconciliation', reason: row.reason ?? 'Review result needs reconciliation.' }]
      }
      throw new Error(`Unknown Review resolution: ${row.resolution_tag}`)
    }))
    const desiredReviewOutcomes = new Map((database.prepare(`
      SELECT repositories.github AS repository, subjects.github_number,
        review_status_commands.revision_id, review_status_commands.desired_outcome
      FROM review_status_commands
      JOIN worker_tasks ON review_status_commands.task_kind = 'adversarial_review'
        AND worker_tasks.id = review_status_commands.task_id
      JOIN subjects ON subjects.id = worker_tasks.subject_id
        AND subjects.current_revision_id = review_status_commands.revision_id
      JOIN repositories ON repositories.id = subjects.repository_id
      WHERE review_status_commands.phase = 'terminal'
        AND review_status_commands.state_tag IN ('Pending', 'Running', 'Published')
        AND review_status_commands.desired_outcome IS NOT NULL
        AND review_status_commands.id = (
          SELECT current.id FROM review_status_commands AS current
          WHERE current.task_kind = 'adversarial_review'
            AND current.task_id = review_status_commands.task_id
            AND current.phase = 'terminal'
            AND current.state_tag IN ('Pending', 'Running', 'Published')
          ORDER BY current.updated_at DESC, current.id DESC LIMIT 1
        )
    `).all() as unknown as Array<{
      repository: string
      github_number: number
      revision_id: string
      desired_outcome: ReviewDesiredOutcome
    }>).map(row => [`${row.repository}:${row.github_number}:${row.revision_id}`, row.desired_outcome]))

    const storedAgentControl = getAgentControl()
    const agentControl = storedAgentControl._tag === 'Running'
      ? storedAgentControl
      : { ...storedAgentControl, safeToRestart: isSafeToRestart() }
    const restartRequest = getRestartRequest()

    return {
      generatedAt,
      status,
      mutationsEnabled,
      agentControl,
      restartRequest,
      serviceUpdate: serviceUpdate(),
      selectionMode: currentSelectionMode,
      openPullRequests: countOpenPullRequests(),
      maxOpenPullRequests,
      agentProfile: resolveAgentProfile(activeSelection(), profile.maximumActiveAgents),
      agentSelection: getAgentSelection(),
      agentStart: !mutationsEnabled
        ? { _tag: 'WritesDisabled' }
        : agentControl._tag === 'Paused'
          ? { _tag: 'Paused' }
          : restartRequest?._tag === 'Requested' || restartRequest?._tag === 'Restarting'
            ? { _tag: 'RestartRequested' }
            : { _tag: 'Available' },
      agentProviderOrder: AGENT_PROVIDER_NAMES,
      agentModels: AGENT_MODELS,
      reasoningEfforts: REASONING_EFFORTS,
      providerCapacities: [],
      providerCircuits: listProviderCircuits(),
      agents,
      incidents,
      queue: dashboardQueue(
        items.filter(item => !item.dismissed),
        tasks,
        reviewAgents,
        mappings,
        rejectedIssueWorkResults,
        openPullRequestsByRepository,
        currentSelectionMode,
        reviewResolutions,
        desiredReviewOutcomes,
      ),
      repositories,
      items,
      tasks,
      routines,
      routineRuns,
    }
  }

  const listActiveTaskLeases: JournalStore['listActiveTaskLeases'] = () => database.prepare(`
    SELECT id AS taskId, fence FROM tasks WHERE state_tag NOT IN ('Completed', 'Failed', 'Superseded')
    UNION ALL
    SELECT id AS taskId, fence FROM worker_tasks WHERE state_tag NOT IN ('Completed', 'Failed', 'Superseded')
    UNION ALL
    SELECT id AS taskId, fence FROM routine_runs WHERE state_tag IN ('Queued', 'Running')
  `).all() as unknown as AgentWorktreeLease[]

  const listRunningTaskItems: JournalStore['listRunningTaskItems'] = () => database.prepare(`
    SELECT repositories.github AS repository, subjects.github_number AS itemNumber
    FROM tasks
    JOIN subjects ON subjects.id = tasks.subject_id
    JOIN repositories ON repositories.id = subjects.repository_id
    WHERE tasks.state_tag IN ('Running', 'Publishing')
    UNION
    SELECT repositories.github AS repository, subjects.github_number AS itemNumber
    FROM worker_tasks
    JOIN subjects ON subjects.id = worker_tasks.subject_id
    JOIN repositories ON repositories.id = subjects.repository_id
    WHERE worker_tasks.state_tag = 'Running'
  `).all() as unknown as Array<{ repository: string, itemNumber: number }>

  const recordApprovalPromptComment: JournalStore['recordApprovalPromptComment'] = (input) => {
    const subject = database.prepare(`
      SELECT subjects.id
      FROM subjects
      JOIN repositories ON repositories.id = subjects.repository_id
      WHERE repositories.github = ? AND subjects.github_number = ? AND subjects.kind = 'pull_request'
        AND subjects.current_revision_id = ?
    `).get(input.repository, input.pullRequestNumber, input.revisionId) as { id: number } | undefined
    if (subject === undefined)
      return false
    database.prepare(`
      INSERT INTO approval_prompt_comments (subject_id, revision_id, github_comment_id, body, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (subject_id, revision_id) DO UPDATE SET
        github_comment_id = excluded.github_comment_id,
        body = excluded.body,
        updated_at = excluded.updated_at
    `).run(subject.id, input.revisionId, input.commentId, input.body, input.at)
    return true
  }

  const listQueuedReviewStatuses: JournalStore['listQueuedReviewStatuses'] = () => (database.prepare(`
    -- Every queued Task that owns a canonical comment, paused repositories
    -- included. A paused repository queues work and writes no code, so its
    -- comment still has to say why nothing is happening.
    WITH candidates AS (
      SELECT
        worker_tasks.id AS task_id,
        'adversarial_review' AS task_kind,
        worker_tasks.subject_id,
        worker_tasks.revision_id,
        worker_tasks.updated_at,
        repositories.paused
      FROM worker_tasks
      JOIN subjects ON subjects.id = worker_tasks.subject_id
      JOIN repositories ON repositories.id = subjects.repository_id
      WHERE worker_tasks.kind = 'adversarial_review' AND worker_tasks.state_tag = 'Queued'
        AND worker_tasks.revision_id = subjects.current_revision_id
        AND repositories.enabled = 1
        ${repositoryWriteAuthoritySql}
        AND json_extract(repositories.policy_json, '$.pullRequestReview') = 1
      UNION ALL
      SELECT
        tasks.id AS task_id,
        'review_fix' AS task_kind,
        tasks.subject_id,
        tasks.revision_id,
        tasks.updated_at,
        repositories.paused
      FROM tasks
      JOIN subjects ON subjects.id = tasks.subject_id
      JOIN repositories ON repositories.id = subjects.repository_id
      WHERE tasks.kind = 'review_fix' AND tasks.state_tag = 'Queued'
        AND tasks.revision_id = subjects.current_revision_id
        AND repositories.enabled = 1
        ${repositoryWriteAuthoritySql}
        AND json_extract(repositories.policy_json, '$.pullRequestReview') = 1
        AND EXISTS (
          SELECT 1 FROM pull_request_approvals
          WHERE pull_request_approvals.subject_id = subjects.id
            AND pull_request_approvals.revision_id = tasks.revision_id
            AND pull_request_approvals.kind = 'fixes'
        )
    ),
    -- The Queue an agent actually draws from. A paused Task waits outside it,
    -- so it takes no position and moves nobody else along.
    claimable AS (SELECT * FROM candidates WHERE paused = 0)
    SELECT
      candidates.task_id,
      candidates.task_kind,
      repositories.github AS repository,
      subjects.github_number,
      candidates.revision_id,
      json_extract(revisions.payload, '$.headSha') AS head_sha,
      candidates.paused,
      -- A Repair queues behind the Review that found its work, on the same
      -- Revision, so that Review's verdict still describes this head.
      EXISTS (
        SELECT 1 FROM review_runs
        WHERE review_runs.subject_id = candidates.subject_id
          AND review_runs.revision_id = candidates.revision_id
      ) AS answered,
      (
        SELECT COUNT(*) + 1 FROM claimable AS ahead
        WHERE candidates.paused = 0
          AND ahead.task_kind = candidates.task_kind
          AND (
            ahead.updated_at < candidates.updated_at
            OR (ahead.updated_at = candidates.updated_at AND ahead.task_id < candidates.task_id)
          )
      ) AS position,
      (
        SELECT COUNT(*) FROM claimable AS peer
        WHERE candidates.paused = 0 AND peer.task_kind = candidates.task_kind
      ) AS total,
      COALESCE(published.github_comment_id, prompt.github_comment_id) AS github_comment_id,
      COALESCE(published.body, prompt.body) AS published_body,
      -- The newest Review that answered an earlier head of this pull request.
      prior_run.head_sha AS prior_head_sha,
      prior_run.outcome_tag AS prior_outcome,
      prior_run.finding_count AS prior_findings,
      -- A head the controller pushed itself. It is the difference between
      -- waiting on somebody's new commit and waiting on our own Repair.
      EXISTS (
        SELECT 1 FROM publication_commands
        JOIN tasks AS repair ON repair.id = publication_commands.task_id
        WHERE repair.subject_id = candidates.subject_id
          AND repair.kind = 'review_fix'
          AND publication_commands.state_tag = 'Published'
          AND publication_commands.commit_sha = json_extract(revisions.payload, '$.headSha')
      ) AS head_from_repair
    FROM candidates
    JOIN subjects ON subjects.id = candidates.subject_id
    JOIN repositories ON repositories.id = subjects.repository_id
    JOIN revisions ON revisions.id = candidates.revision_id
    -- The Approval prompt is the canonical comment until a Task publishes one.
    LEFT JOIN approval_prompt_comments AS prompt
      ON prompt.subject_id = candidates.subject_id AND prompt.revision_id = candidates.revision_id
    LEFT JOIN (
      SELECT subject_id, revision_id, head_sha, outcome_tag,
        json_array_length(findings) AS finding_count, completed_at,
        ROW_NUMBER() OVER (PARTITION BY subject_id ORDER BY completed_at DESC, id DESC) AS run_rank
      FROM review_runs
    ) AS prior_run
      ON prior_run.subject_id = candidates.subject_id
      AND prior_run.run_rank = 1
      AND prior_run.revision_id != candidates.revision_id
    LEFT JOIN review_status_commands AS published ON published.id = COALESCE(
      (
        SELECT candidate.id FROM review_status_commands AS candidate
        WHERE candidate.task_kind = candidates.task_kind AND candidate.task_id = candidates.task_id
          AND candidate.state_tag = 'Published'
        ORDER BY candidate.updated_at DESC, candidate.id DESC
        LIMIT 1
      ),
      -- A Task that has published nothing of its own inherits the canonical
      -- comment the pull request already carries. One comment serves the whole
      -- pull request and outlives every Revision, so this finds both the
      -- Review comment a Repair queues behind and the Repair comment a Review
      -- queues behind once the Repair push becomes the next head.
      (
        SELECT candidate.id FROM review_status_commands AS candidate
        JOIN revisions AS candidate_revision ON candidate_revision.id = candidate.revision_id
        WHERE candidate.state_tag = 'Published'
          AND candidate_revision.subject_id = candidates.subject_id
        ORDER BY candidate.updated_at DESC, candidate.id DESC
        LIMIT 1
      )
    )
    WHERE json_extract(revisions.payload, '$.state') = 'open'
      AND COALESCE(published.github_comment_id, prompt.github_comment_id) IS NOT NULL
      -- A terminal comment is a complete statement, so the Queue leaves it for
      -- the Review that replaces it. A nonterminal comment claims work is
      -- under way, which is false the moment its Task ends, whichever head it
      -- named. That comment is the one the Queue position corrects.
      AND (published.id IS NULL OR published.phase != 'terminal')
      -- A final status for this exact head is a complete statement. Writing a
      -- Queue position over it would delete the review a person still needs.
      AND NOT EXISTS (
        SELECT 1 FROM review_status_commands AS final
        WHERE final.phase = 'terminal' AND final.state_tag = 'Published'
          AND final.revision_id = candidates.revision_id
          AND final.expected_head_sha = json_extract(revisions.payload, '$.headSha')
      )
      -- A pending terminal status owns the comment until Publication finishes.
      AND NOT EXISTS (
        SELECT 1 FROM review_status_commands AS finalizing
        WHERE finalizing.phase = 'terminal'
          AND finalizing.state_tag IN ('Pending', 'Running')
          AND finalizing.revision_id = candidates.revision_id
          AND finalizing.expected_head_sha = json_extract(revisions.payload, '$.headSha')
      )
  `).all() as unknown as QueuedReviewStatusRow[]).map(row => ({
    taskId: row.task_id,
    taskKind: row.task_kind,
    repository: row.repository,
    pullRequestNumber: row.github_number,
    revisionId: row.revision_id,
    headSha: row.head_sha,
    queue: row.paused === 1 || row.position === null || row.total === null
      ? { _tag: 'Paused' as const }
      : { _tag: 'Waiting' as const, position: row.position, total: row.total },
    verdict: row.answered === 1 ? { _tag: 'Answered' as const } : { _tag: 'Unanswered' as const },
    history: row.prior_head_sha === null || row.prior_outcome === null
      ? { _tag: 'FirstReview' as const }
      : {
          _tag: row.head_from_repair === 1 ? 'AfterRepair' as const : 'AfterPush' as const,
          priorHeadSha: row.prior_head_sha,
          priorOutcome: row.prior_outcome,
          findings: row.prior_findings ?? 0,
        },
    commentId: row.github_comment_id,
    publishedBody: row.published_body,
  }))

  const recordQueuedReviewStatus: JournalStore['recordQueuedReviewStatus'] = (input) => {
    const bodySha256 = digest(input.body)
    const taskTable = input.taskKind === 'adversarial_review' ? 'worker_tasks' : 'tasks'
    database.exec('BEGIN IMMEDIATE')
    try {
      const authorized = database.prepare(`
        SELECT ${taskTable}.fence
        FROM ${taskTable}
        JOIN subjects ON subjects.id = ${taskTable}.subject_id
        WHERE ${taskTable}.id = ? AND ${taskTable}.kind = ?
          AND ${taskTable}.state_tag = 'Queued'
          AND ${taskTable}.revision_id = ? AND subjects.current_revision_id = ?
      `).get(input.taskId, input.taskKind, input.revisionId, input.revisionId) as { fence: number } | undefined
      if (authorized === undefined) {
        database.exec('COMMIT')
        return false
      }
      const commandId = digest(`${input.taskKind}:${input.taskId}:${authorized.fence}:queued:${bodySha256}`)
      // A position can return to a number this comment already held, because a
      // Task ahead of it can leave the Queue and another can join behind it.
      // Rewriting the row keeps the newest publication the newest row, so the
      // next pass compares against what GitHub actually shows.
      database.prepare(`
        INSERT INTO review_status_commands (
          id, task_kind, task_id, task_fence, revision_id, expected_head_sha, phase, body, body_sha256,
          state_tag, github_comment_id, github_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, 'Published', ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          github_comment_id = excluded.github_comment_id,
          github_url = excluded.github_url,
          updated_at = excluded.updated_at
      `).run(
        commandId,
        input.taskKind,
        input.taskId,
        authorized.fence,
        input.revisionId,
        input.expectedHeadSha,
        input.body,
        bodySha256,
        input.commentId,
        input.url,
        input.at,
        input.at,
      )
      database.exec('COMMIT')
      return true
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  /** Every published clean Review whose merge or CI gate can still move. */
  const listReviewGateRefreshes: JournalStore['listReviewGateRefreshes'] = () => (database.prepare(`
    WITH ranked AS (
      SELECT review_runs.*,
        ROW_NUMBER() OVER (PARTITION BY review_runs.subject_id ORDER BY review_runs.completed_at DESC, review_runs.id DESC) AS run_rank
      FROM review_runs
      WHERE review_runs.revision_id = (
          SELECT subjects.current_revision_id FROM subjects WHERE subjects.id = review_runs.subject_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM review_runs AS settled
          WHERE settled.supersedes_review_run_id = review_runs.id
        )
    )
    SELECT
      ranked.id AS review_run_id,
      repositories.github AS repository,
      subjects.github_number,
      ranked.revision_id,
      ranked.head_sha,
      ranked.provider,
      ranked.session_id,
      ranked.model,
      ranked.agent_version,
      ranked.skill_digest,
      ranked.started_at,
      ranked.completed_at,
      ranked.usage,
      COALESCE(projection.gates, ranked.gates) AS gates,
      ranked.findings,
      COALESCE(projection.confidence, ranked.confidence) AS confidence,
      published.github_comment_id,
      published.body AS published_body
    FROM ranked
    JOIN subjects ON subjects.id = ranked.subject_id
    JOIN repositories ON repositories.id = subjects.repository_id
    JOIN revisions AS current_revisions ON current_revisions.id = subjects.current_revision_id
    LEFT JOIN review_gate_projections AS projection ON projection.review_run_id = ranked.id
    JOIN review_publications AS published ON published.id = (
      SELECT candidate.id FROM review_publications AS candidate
      WHERE candidate.review_run_id = ranked.id
      ORDER BY candidate.created_at DESC, candidate.id DESC
      LIMIT 1
    )
    WHERE ranked.run_rank = 1
      AND json_extract(ranked.gates, '$.review._tag') = 'Passed'
      AND published.result_tag = 'Published'
      AND repositories.enabled = 1
      ${repositoryWriteAuthoritySql}
      AND repositories.paused = 0
      AND json_extract(repositories.policy_json, '$.pullRequestReview') = 1
      AND ranked.revision_id = subjects.current_revision_id
      AND json_extract(current_revisions.payload, '$.state') = 'open'
      AND json_extract(current_revisions.payload, '$.headSha') = ranked.head_sha
      AND NOT EXISTS (
        SELECT 1 FROM worker_tasks AS live
        WHERE live.subject_id = ranked.subject_id AND live.kind = 'adversarial_review'
          AND live.state_tag IN ('Queued', 'ActionRequired', 'Running')
      )
      AND NOT EXISTS (
        SELECT 1 FROM tasks AS repair
        WHERE repair.subject_id = ranked.subject_id AND repair.kind = 'review_fix'
          AND repair.state_tag IN ('Queued', 'ActionRequired', 'Running', 'Publishing')
      )
    ORDER BY repositories.github, subjects.github_number
  `).all() as unknown as ReviewGateRefreshRow[]).map(row => ({
    reviewRunId: row.review_run_id,
    repository: row.repository,
    pullRequestNumber: row.github_number,
    revisionId: row.revision_id,
    headSha: row.head_sha,
    provider: row.provider,
    sessionId: row.session_id,
    model: row.model,
    agentVersion: row.agent_version,
    skillDigest: row.skill_digest,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    usage: agentTokenUsageFromJson(row.usage),
    gates: JSON.parse(row.gates) as ReviewGates,
    findings: JSON.parse(row.findings) as ReviewFinding[],
    confidence: row.confidence ?? undefined,
    commentId: row.github_comment_id,
    publishedBody: row.published_body,
  }))

  const listStoppedReviews: JournalStore['listStoppedReviews'] = () => (database.prepare(`
    WITH stopped_candidates AS (
      SELECT worker_tasks.id, worker_tasks.subject_id, worker_tasks.revision_id,
        worker_tasks.kind AS task_kind, worker_tasks.state_tag, worker_tasks.reason,
        worker_tasks.updated_at, revisions.observed_at AS revision_observed_at
      FROM worker_tasks
      JOIN revisions ON revisions.id = worker_tasks.revision_id
      WHERE worker_tasks.kind = 'adversarial_review'
      UNION ALL
      SELECT tasks.id, tasks.subject_id, tasks.revision_id, tasks.kind AS task_kind,
        tasks.state_tag, tasks.reason, tasks.updated_at,
        revisions.observed_at AS revision_observed_at
      FROM tasks
      JOIN revisions ON revisions.id = tasks.revision_id
      WHERE tasks.kind = 'review_fix'
    ), stopped AS (
      SELECT stopped_candidates.*,
        ROW_NUMBER() OVER (
          PARTITION BY stopped_candidates.subject_id
          ORDER BY stopped_candidates.revision_observed_at DESC,
            CASE stopped_candidates.task_kind WHEN 'review_fix' THEN 1 ELSE 0 END DESC,
            stopped_candidates.updated_at DESC,
            stopped_candidates.id DESC
        ) AS task_rank
      FROM stopped_candidates
      WHERE stopped_candidates.state_tag IN ('Completed', 'Failed', 'ActionRequired', 'Superseded')
    ), canonical_publications AS (
      SELECT
        'status:' || status.id AS publication_id,
        status_revision.subject_id,
        status.revision_id,
        status.expected_head_sha,
        status.phase,
        status.body,
        status.github_comment_id,
        status.updated_at AS published_at,
        0 AS source_rank
      FROM review_status_commands AS status
      JOIN revisions AS status_revision ON status_revision.id = status.revision_id
      WHERE status.state_tag = 'Published'
      UNION ALL
      SELECT
        'review:' || publication.id AS publication_id,
        review_runs.subject_id,
        review_runs.revision_id,
        review_runs.head_sha AS expected_head_sha,
        'terminal' AS phase,
        publication.body,
        publication.github_comment_id,
        publication.created_at AS published_at,
        1 AS source_rank
      FROM review_publications AS publication
      JOIN review_runs ON review_runs.id = publication.review_run_id
      WHERE publication.result_tag = 'Published'
    ), published AS (
      SELECT canonical_publications.*,
        ROW_NUMBER() OVER (
          PARTITION BY canonical_publications.subject_id
          ORDER BY canonical_publications.published_at DESC,
            canonical_publications.source_rank DESC,
            canonical_publications.publication_id DESC
        ) AS publication_rank
      FROM canonical_publications
    )
    SELECT
      stopped.id AS task_id,
      stopped.task_kind,
      repositories.github AS repository,
      subjects.github_number,
      stopped.revision_id,
      json_extract(task_revisions.payload, '$.headSha') AS head_sha,
      current_revisions.id AS closure_revision_id,
      json_extract(current_revisions.payload, '$.headSha') AS current_head_sha,
      json_extract(current_revisions.payload, '$.baseSha') AS current_base_sha,
      COALESCE(stopped.reason, 'The automated review stopped.') AS reason,
      json_extract(current_revisions.payload, '$.state') AS current_state,
      json_extract(current_revisions.payload, '$.mergedAt') AS current_merged_at,
      CASE
        WHEN json_extract(current_revisions.payload, '$.state') = 'closed' THEN published.github_comment_id
        ELSE owned.github_comment_id
      END AS github_comment_id,
      CASE
        WHEN json_extract(current_revisions.payload, '$.state') = 'closed' THEN published.body
        ELSE owned.body
      END AS published_body,
      COALESCE((
        SELECT review_runs.findings FROM review_runs
        WHERE review_runs.subject_id = stopped.subject_id
          AND review_runs.revision_id = stopped.revision_id
        ORDER BY review_runs.completed_at DESC, review_runs.id DESC
        LIMIT 1
      ), '[]') AS findings
    FROM stopped
    JOIN subjects ON subjects.id = stopped.subject_id
    JOIN repositories ON repositories.id = subjects.repository_id
    JOIN revisions AS task_revisions ON task_revisions.id = stopped.revision_id
    JOIN revisions AS current_revisions ON current_revisions.id = subjects.current_revision_id
    JOIN published ON published.subject_id = stopped.subject_id AND published.publication_rank = 1
    LEFT JOIN review_status_commands AS owned ON owned.id = COALESCE(
      (
        SELECT candidate.id FROM review_status_commands AS candidate
        WHERE candidate.task_kind = stopped.task_kind AND candidate.task_id = stopped.id
          AND candidate.state_tag = 'Published'
        ORDER BY candidate.updated_at DESC, candidate.id DESC
        LIMIT 1
      ),
      -- A Repair that stops before publishing progress inherits the canonical
      -- status of its sibling Review for the same Revision.
      (
        SELECT candidate.id FROM review_status_commands AS candidate
        JOIN worker_tasks AS sibling ON sibling.id = candidate.task_id
        WHERE stopped.task_kind = 'review_fix'
          AND candidate.task_kind = 'adversarial_review'
          AND candidate.state_tag = 'Published'
          AND sibling.subject_id = stopped.subject_id
          AND candidate.revision_id = stopped.revision_id
        ORDER BY candidate.updated_at DESC, candidate.id DESC
        LIMIT 1
      )
    )
    LEFT JOIN review_closure_resolutions AS closure
      ON closure.subject_id = subjects.id AND closure.revision_id = current_revisions.id
    LEFT JOIN pull_request_closure_verifications AS verification
      ON verification.subject_id = subjects.id AND verification.revision_id = current_revisions.id
    WHERE stopped.task_rank = 1
      AND (
        (
          json_extract(current_revisions.payload, '$.state') = 'open'
          AND owned.phase != 'terminal'
          AND owned.expected_head_sha = json_extract(task_revisions.payload, '$.headSha')
          AND json_extract(current_revisions.payload, '$.headSha') = json_extract(task_revisions.payload, '$.headSha')
        )
        OR (
          json_extract(current_revisions.payload, '$.state') = 'closed'
          AND verification.revision_id IS NOT NULL
          AND closure.revision_id IS NULL
        )
      )
      AND repositories.enabled = 1
      ${repositoryWriteAuthoritySql}
      AND json_extract(repositories.policy_json, '$.pullRequestReview') = 1
      -- Repair owns the canonical comment after Review hands work to it.
      AND NOT (
        stopped.task_kind = 'adversarial_review'
        AND EXISTS (
          SELECT 1 FROM tasks AS repair
          WHERE repair.subject_id = stopped.subject_id
            AND repair.revision_id = stopped.revision_id
            AND repair.kind = 'review_fix'
        )
      )
      -- A live review posts its own comment, so leave the pull request to it.
      AND NOT EXISTS (
        SELECT 1 FROM worker_tasks AS live
        WHERE live.subject_id = stopped.subject_id AND live.kind = 'adversarial_review'
          AND live.state_tag IN ('Queued', 'Running')
      )
  `).all() as unknown as StoppedReviewRow[]).map(row => ({
    taskId: row.task_id,
    taskKind: row.task_kind,
    repository: row.repository,
    pullRequestNumber: row.github_number,
    revisionId: row.revision_id,
    headSha: row.head_sha,
    closureRevisionId: row.closure_revision_id,
    currentHeadSha: row.current_head_sha,
    currentBaseSha: row.current_base_sha,
    reason: row.reason,
    disposition: row.current_state !== 'closed'
      ? { _tag: 'Stopped' as const }
      : row.current_merged_at === null
        ? { _tag: 'Closed' as const }
        : { _tag: 'Merged' as const },
    commentId: row.github_comment_id,
    publishedBody: row.published_body,
    findings: JSON.parse(row.findings) as ReviewFinding[],
  }))

  const isQueuedReviewStatus: JournalStore['isQueuedReviewStatus'] = (input) => {
    const taskTable = input.taskKind === 'adversarial_review' ? 'worker_tasks' : 'tasks'
    return database.prepare(`
      SELECT 1 FROM ${taskTable}
      WHERE id = ? AND kind = ? AND state_tag = 'Queued'
    `).get(input.taskId, input.taskKind) !== undefined
  }

  const recordDeletedReviewComment: JournalStore['recordDeletedReviewComment'] = input => database.prepare(`
    UPDATE review_status_commands
    SET state_tag = 'Superseded', reason = ?, updated_at = ?
    WHERE state_tag = 'Published' AND github_comment_id = ?
  `).run(input.reason, input.at, input.commentId).changes > 0

  const recordStoppedReviewStatus: JournalStore['recordStoppedReviewStatus'] = (input) => {
    const bodySha256 = digest(input.body)
    const commandId = digest(`${input.taskKind}:${input.taskId}:stopped:${bodySha256}`)
    const taskTable = input.taskKind === 'adversarial_review' ? 'worker_tasks' : 'tasks'
    database.exec('BEGIN IMMEDIATE')
    try {
      const authorized = database.prepare(`
        SELECT ${taskTable}.fence
        FROM ${taskTable}
        JOIN subjects ON subjects.id = ${taskTable}.subject_id
        JOIN revisions AS task_revision ON task_revision.id = ${taskTable}.revision_id
        JOIN revisions AS current_revision ON current_revision.id = subjects.current_revision_id
        WHERE ${taskTable}.id = ? AND ${taskTable}.kind = ?
          AND ${taskTable}.state_tag IN ('Completed', 'Failed', 'ActionRequired', 'Superseded')
          AND ${taskTable}.revision_id = ?
          AND json_extract(task_revision.payload, '$.headSha') = ?
          AND (
            json_extract(current_revision.payload, '$.headSha') = ?
            OR json_extract(current_revision.payload, '$.state') = 'closed'
          )
      `).get(
        input.taskId,
        input.taskKind,
        input.revisionId,
        input.expectedHeadSha,
        input.expectedHeadSha,
      ) as { fence: number } | undefined
      if (authorized === undefined) {
        database.exec('COMMIT')
        return false
      }
      database.prepare(`
        INSERT INTO review_status_commands (
          id, task_kind, task_id, task_fence, revision_id, expected_head_sha, phase, body, body_sha256,
          state_tag, github_comment_id, github_url, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'terminal', ?, ?, 'Published', ?, ?, ?, ?)
        ON CONFLICT (id) DO NOTHING
      `).run(
        commandId,
        input.taskKind,
        input.taskId,
        authorized.fence,
        input.revisionId,
        input.expectedHeadSha,
        input.body,
        bodySha256,
        input.commentId,
        input.url,
        input.at,
        input.at,
      )
      database.exec('COMMIT')
      return true
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const recordVerifiedPullRequestClosure: JournalStore['recordVerifiedPullRequestClosure'] = (input) => {
    const row = database.prepare(`
      SELECT subjects.id AS subject_id, revisions.payload
      FROM subjects
      JOIN repositories ON repositories.id = subjects.repository_id
      JOIN revisions ON revisions.id = subjects.current_revision_id
      WHERE repositories.github = ? AND subjects.kind = 'pull_request'
        AND subjects.github_number = ? AND subjects.current_revision_id = ?
    `).get(input.repository, input.pullRequestNumber, input.revisionId) as {
      subject_id: number
      payload: string
    } | undefined
    const pullRequest = row === undefined ? undefined : JSON.parse(row.payload) as GitHubItem
    if (
      row === undefined
      || pullRequest?.kind !== 'pull_request'
      || pullRequest.state !== 'closed'
      || pullRequest.headSha !== input.headSha
      || pullRequest.baseSha !== input.baseSha
      || (pullRequest.mergedAt === null ? 'Closed' : 'Merged') !== input.disposition._tag
    ) {
      return false
    }
    database.prepare(`
      INSERT INTO pull_request_closure_verifications (
        subject_id, revision_id, head_sha, base_sha, disposition_tag, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (subject_id, revision_id) DO UPDATE SET verified_at = excluded.verified_at
    `).run(
      row.subject_id,
      input.revisionId,
      input.headSha,
      input.baseSha,
      input.disposition._tag,
      input.at,
    )
    return true
  }

  const recordReviewClosure: JournalStore['recordReviewClosure'] = (input) => {
    const row = database.prepare(`
      SELECT subjects.id AS subject_id, revisions.payload
      FROM subjects
      JOIN repositories ON repositories.id = subjects.repository_id
      JOIN revisions ON revisions.id = subjects.current_revision_id
      JOIN pull_request_closure_verifications AS verification
        ON verification.subject_id = subjects.id AND verification.revision_id = revisions.id
        AND verification.head_sha = ? AND verification.base_sha = ?
        AND verification.disposition_tag = ?
      WHERE repositories.github = ? AND subjects.kind = 'pull_request'
        AND subjects.github_number = ? AND subjects.current_revision_id = ?
    `).get(
      input.headSha,
      input.baseSha,
      input.disposition._tag,
      input.repository,
      input.pullRequestNumber,
      input.revisionId,
    ) as {
      subject_id: number
      payload: string
    } | undefined
    const pullRequest = row === undefined ? undefined : JSON.parse(row.payload) as GitHubItem
    if (
      row === undefined
      || pullRequest?.kind !== 'pull_request'
      || pullRequest.state !== 'closed'
      || pullRequest.headSha !== input.headSha
      || pullRequest.baseSha !== input.baseSha
      || (pullRequest.mergedAt === null ? 'Closed' : 'Merged') !== input.disposition._tag
    ) {
      return false
    }
    const published = input.result._tag === 'Published'
      ? { body: input.result.body, commentId: input.result.commentId, url: input.result.url }
      : { body: null, commentId: null, url: null }
    const inserted = database.prepare(`
      INSERT OR IGNORE INTO review_closure_resolutions (
        subject_id, revision_id, head_sha, base_sha, disposition_tag, result_tag,
        body, github_comment_id, github_url, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.subject_id,
      input.revisionId,
      input.headSha,
      input.baseSha,
      input.disposition._tag,
      input.result._tag,
      published.body,
      published.commentId,
      published.url,
      input.at,
    )
    if (inserted.changes === 1)
      return true
    const existing = database.prepare(`
      SELECT head_sha, base_sha, disposition_tag, result_tag, body, github_comment_id, github_url
      FROM review_closure_resolutions
      WHERE subject_id = ? AND revision_id = ?
    `).get(row.subject_id, input.revisionId) as {
      head_sha: string
      base_sha: string
      disposition_tag: ReviewClosureDisposition['_tag']
      result_tag: ReviewClosureResult['_tag']
      body: string | null
      github_comment_id: number | null
      github_url: string | null
    }
    return existing.head_sha === input.headSha
      && existing.base_sha === input.baseSha
      && existing.disposition_tag === input.disposition._tag
      && existing.result_tag === input.result._tag
      && existing.body === published.body
      && existing.github_comment_id === published.commentId
      && existing.github_url === published.url
  }

  const listOpenAgentPullRequests: JournalStore['listOpenAgentPullRequests'] = repository => (database.prepare(`
    SELECT
      subjects.github_number AS pull_request_number,
      json_extract(revisions.payload, '$.headRef') AS head_ref,
      json_extract(revisions.payload, '$.headSha') AS head_sha,
      json_extract(revisions.payload, '$.baseRef') AS base_ref,
      tasks.kind AS task_kind
    FROM subjects
    JOIN repositories ON repositories.id = subjects.repository_id
    JOIN revisions ON revisions.id = subjects.current_revision_id
    JOIN publication_commands ON publication_commands.head_ref = json_extract(revisions.payload, '$.headRef')
    JOIN tasks ON tasks.id = publication_commands.task_id
    JOIN subjects AS publication_subjects ON publication_subjects.id = tasks.subject_id
    WHERE repositories.github = ?
      AND publication_subjects.repository_id = repositories.id
      AND subjects.kind = 'pull_request'
      AND json_extract(revisions.payload, '$.state') = 'open'
      AND json_extract(revisions.payload, '$.draft') = 0
      AND lower(json_extract(revisions.payload, '$.headRepository')) = lower(repositories.github)
      AND json_extract(revisions.payload, '$.baseRef') IS NOT NULL
      AND publication_commands.state_tag = 'Published'
      AND tasks.kind IN ('baseline_repair', 'issue_work')
    GROUP BY subjects.id
    ORDER BY subjects.github_number DESC
  `).all(repository) as unknown as Array<{
    pull_request_number: number
    head_ref: string
    head_sha: string
    base_ref: string
    task_kind: 'baseline_repair' | 'issue_work'
  }>).map(row => ({
    pullRequestNumber: row.pull_request_number,
    headRef: row.head_ref,
    headSha: row.head_sha,
    baseRef: row.base_ref,
    taskKind: row.task_kind,
  }))

  const getWorkerSession: JournalStore['getWorkerSession'] = (repository, itemNumber, role, scopeDigest) => {
    const publicationRole = role === 'conflict_resolution' || role === 'review_fix' || role === 'baseline_repair'
    const table = publicationRole ? 'worker_sessions' : 'subject_worker_sessions'
    const scoped = !publicationRole && scopeDigest !== undefined
    const scopeClause = scoped ? 'AND sessions.scope_digest = ?' : ''
    const parameters = scoped
      ? [repository, itemNumber, role, provider(), scopeDigest]
      : [repository, itemNumber, role, provider()]
    const row = database.prepare(`
      SELECT sessions.session_id
      FROM ${table} AS sessions
      JOIN subjects ON subjects.id = sessions.subject_id
      JOIN repositories ON repositories.id = subjects.repository_id
      WHERE repositories.github = ? AND subjects.github_number = ?
        AND sessions.role = ? AND sessions.provider = ? ${scopeClause}
      ORDER BY sessions.updated_at DESC, sessions.id DESC
      LIMIT 1
    `).get(...parameters) as { session_id: string } | undefined
    return row?.session_id ?? null
  }

  const saveWorkerSession: JournalStore['saveWorkerSession'] = (repository, itemNumber, role, sessionId, at, scopeDigest) => {
    const subjectKind = role === 'issue_triage' ? 'issue' : 'pull_request'
    const subject = database.prepare(`
      SELECT subjects.id
      FROM subjects
      JOIN repositories ON repositories.id = subjects.repository_id
      WHERE repositories.github = ? AND subjects.github_number = ? AND subjects.kind = ?
    `).get(repository, itemNumber, subjectKind) as { id: number } | undefined
    if (subject === undefined)
      throw new Error(`${subjectKind === 'issue' ? 'Issue' : 'Pull request'} is not stored: ${repository}#${itemNumber}.`)

    const publicationRole = role === 'conflict_resolution' || role === 'review_fix' || role === 'baseline_repair'
    const table = publicationRole ? 'worker_sessions' : 'subject_worker_sessions'
    if (publicationRole) {
      database.prepare(`
        INSERT INTO ${table} (subject_id, role, provider, session_id, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (subject_id, role, provider) DO UPDATE SET
          session_id = excluded.session_id,
          updated_at = excluded.updated_at
      `).run(subject.id, role, provider(), sessionId, at)
      return
    }
    database.prepare(`
      INSERT INTO ${table} (subject_id, role, provider, scope_digest, session_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (subject_id, role, provider, scope_digest) DO UPDATE SET
        session_id = excluded.session_id,
        updated_at = excluded.updated_at
    `).run(subject.id, role, provider(), scopeDigest ?? '0'.repeat(64), sessionId, at)
  }

  const updateAgentProgress: JournalStore['updateAgentProgress'] = (input) => {
    if (!Number.isInteger(input.progress.percent) || input.progress.percent < 0 || input.progress.percent > 100)
      return false
    const table = input.taskKind === 'adversarial_review' || input.taskKind === 'issue_triage' ? 'worker_tasks' : 'tasks'
    return database.prepare(`
      UPDATE ${table}
      SET progress_percent = ?, progress_label = ?, updated_at = ?
      WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
    `).run(input.progress.percent, input.progress.label, input.at, input.taskId, input.workerId, input.fence).changes === 1
  }

  interface RoutineRow {
    id: string
    repository: string
    name: string
    crons: string
    time_zone: string
    mode: string
    enabled: number
    spec_sha: string
    last_run_at: string | null
    tracking_issue_number: number | null
    retired_at: string | null
    updated_at: string
  }

  const readRoutine = (row: RoutineRow): Routine => ({
    id: row.id,
    repository: row.repository,
    name: row.name as Routine['name'],
    crons: JSON.parse(row.crons) as string[],
    timeZone: row.time_zone,
    mode: row.mode as Routine['mode'],
    enabled: row.enabled === 1,
    specSha: row.spec_sha,
    lastRunAt: row.last_run_at,
    trackingIssueNumber: row.tracking_issue_number,
    updatedAt: row.updated_at,
  })

  /** Reconciles active definitions while preserving every historical Run. */
  const syncRoutines: JournalStore['syncRoutines'] = (input) => {
    const upsert = database.prepare(`
      INSERT INTO routines (id, repository, name, crons, time_zone, mode, enabled, spec_sha, last_run_at, retired_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
      ON CONFLICT (repository, name) DO UPDATE SET
        last_run_at = CASE
          WHEN routines.crons != excluded.crons
            OR routines.time_zone != excluded.time_zone
            OR routines.enabled != excluded.enabled
            OR routines.retired_at IS NOT NULL
          THEN excluded.updated_at
          ELSE routines.last_run_at
        END,
        crons = excluded.crons,
        time_zone = excluded.time_zone,
        mode = excluded.mode,
        enabled = excluded.enabled,
        spec_sha = excluded.spec_sha,
        retired_at = NULL,
        updated_at = excluded.updated_at
    `)
    database.exec('BEGIN IMMEDIATE')
    try {
      const declared = input.entries.map(entry => `${input.repository}:${entry.name}`)
      const placeholders = declared.map(() => '?').join(', ')
      input.entries.forEach((entry) => {
        upsert.run(
          `${input.repository}:${entry.name}`,
          input.repository,
          entry.name,
          JSON.stringify(entry.crons),
          entry.timeZone,
          entry.mode,
          entry.enabled ? 1 : 0,
          input.specSha,
          input.at,
        )
      })
      database.prepare(`
        UPDATE routines
        SET enabled = 0, retired_at = ?, last_run_at = ?, updated_at = ?
        WHERE repository = ?
          ${declared.length === 0 ? '' : `AND id NOT IN (${placeholders})`}
          AND retired_at IS NULL
      `).run(input.at, input.at, input.at, input.repository, ...declared)

      const superseded = database.prepare(`
        SELECT routine_runs.id, routine_runs.fence
        FROM routine_runs
        JOIN routines ON routines.id = routine_runs.routine_id
        WHERE routine_runs.state_tag = 'Queued'
          AND routines.repository = ?
          AND (routines.enabled = 0 OR routines.retired_at IS NOT NULL)
      `).all(input.repository) as unknown as Array<{ id: string, fence: number }>
      superseded.forEach((run) => {
        database.prepare(`
          UPDATE routine_runs
          SET state_tag = 'Superseded', reason = 'The Routine definition is disabled or retired.', updated_at = ?
          WHERE id = ? AND state_tag = 'Queued'
        `).run(input.at, run.id)
        recordRoutineRunEvent(database, {
          runId: run.id,
          event: 'Superseded',
          from: 'Queued',
          to: 'Superseded',
          reason: 'The Routine definition is disabled or retired.',
          fence: run.fence,
          at: input.at,
        })
      })
      database.exec('COMMIT')
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    return listRoutines(input.repository)
  }

  const listRoutines: JournalStore['listRoutines'] = (repository) => {
    const rows = repository === undefined
      ? database.prepare('SELECT * FROM routines WHERE retired_at IS NULL ORDER BY repository, name').all() as unknown as RoutineRow[]
      : database.prepare('SELECT * FROM routines WHERE repository = ? AND retired_at IS NULL ORDER BY name').all(repository) as unknown as RoutineRow[]
    return rows.map(readRoutine)
  }

  interface RoutineRunRow {
    id: string
    routine_id: string
    repository: string
    name: string
    scheduled_for: string
    spec_sha: string
    mode: string
    state_tag: string
    reason: string | null
    evidence: string | null
    worker_id: string | null
    lease_expires_at: string | null
    fence: number
    attempts: number
    progress_percent: number
    progress_label: string
    usage: string
    created_at: string
    updated_at: string
  }

  const readRoutineRunState = (row: RoutineRunRow): RoutineRunState => {
    switch (row.state_tag) {
      case 'Running':
        return { _tag: 'Running', workerId: row.worker_id ?? '', leaseExpiresAt: row.lease_expires_at ?? '' }
      case 'Completed':
        return { _tag: 'Completed', evidence: row.evidence ?? '' }
      case 'Failed':
        return { _tag: 'Failed', reason: row.reason ?? '' }
      case 'Skipped':
        return { _tag: 'Skipped', reason: row.reason ?? '' }
      case 'ActionRequired':
        return { _tag: 'ActionRequired', reason: row.reason ?? '' }
      case 'Superseded':
        return { _tag: 'Superseded', reason: row.reason ?? '' }
      default:
        return { _tag: 'Queued' }
    }
  }

  const readRoutineRun = (row: RoutineRunRow): RoutineRun => ({
    id: row.id,
    routineId: row.routine_id,
    repository: row.repository,
    name: row.name as Routine['name'],
    scheduledFor: row.scheduled_for,
    specSha: row.spec_sha,
    mode: row.mode as RoutineRun['mode'],
    state: readRoutineRunState(row),
    fence: row.fence,
    attempts: row.attempts,
    progress: { percent: row.progress_percent, label: row.progress_label },
    usage: JSON.parse(row.usage) as AgentTokenUsage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })

  const readRunById = (id: string): RoutineRun | null => {
    const row = database.prepare(`
      SELECT routine_runs.*, routines.repository AS repository, routines.name AS name
      FROM routine_runs
      JOIN routines ON routines.id = routine_runs.routine_id
      WHERE routine_runs.id = ?
    `).get(id) as unknown as RoutineRunRow | undefined
    return row === undefined ? null : readRoutineRun(row)
  }

  /**
   * Opens one run for one exact cron instant.
   *
   * The unique constraint on `(routine_id, scheduled_for)` decides this, not a
   * read followed by a write. Two ticks racing the same instant produce one
   * run, and a machine waking after two days asleep produces one run and never
   * a backlog of them.
   */
  const insertRoutineRun = (input: {
    routineId: string
    scheduledFor: string
    specSha: string
    at: string
    state: 'Queued' | 'Skipped'
    reason: string | null
  }): RoutineRun | null => {
    const id = `${input.routineId}:${input.scheduledFor}`
    database.exec('BEGIN IMMEDIATE')
    try {
      const authority = database.prepare(`
        SELECT spec_sha, mode FROM routines WHERE id = ? AND retired_at IS NULL
      `).get(input.routineId) as { spec_sha: string, mode: string } | undefined
      if (authority === undefined || authority.spec_sha !== input.specSha) {
        database.exec('COMMIT')
        return null
      }
      const inserted = database.prepare(`
        INSERT INTO routine_runs (id, routine_id, scheduled_for, spec_sha, mode, state_tag, reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (routine_id, scheduled_for) DO NOTHING
      `).run(id, input.routineId, input.scheduledFor, authority.spec_sha, authority.mode, input.state, input.reason, input.at, input.at).changes === 1
      if (!inserted) {
        database.exec('COMMIT')
        return null
      }
      // The clock only moves forward, so the last run is the newest instant that
      // produced one. A skipped instant counts, or the next tick tries it again.
      database.prepare('UPDATE routines SET last_run_at = ?, updated_at = ? WHERE id = ?')
        .run(input.scheduledFor, input.at, input.routineId)
      recordRoutineRunEvent(database, {
        runId: id,
        event: input.state === 'Skipped' ? 'Skipped' : 'Opened',
        from: null,
        to: input.state,
        reason: input.reason,
        at: input.at,
      })
      database.exec('COMMIT')
      return readRunById(id)
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const openRoutineRun: JournalStore['openRoutineRun'] = input =>
    insertRoutineRun({ ...input, state: 'Queued', reason: null })

  const skipRoutineRun: JournalStore['skipRoutineRun'] = input =>
    insertRoutineRun({ ...input, state: 'Skipped', reason: input.reason })

  const listRoutineRuns: JournalStore['listRoutineRuns'] = (routineId, limit = 50) => {
    const rows = database.prepare(`
      SELECT routine_runs.*, routines.repository AS repository, routines.name AS name
      FROM routine_runs
      JOIN routines ON routines.id = routine_runs.routine_id
      WHERE routine_runs.routine_id = ?
      ORDER BY routine_runs.scheduled_for DESC
      LIMIT ?
    `).all(routineId, limit) as unknown as RoutineRunRow[]
    return rows.map(readRoutineRun)
  }

  interface CandidateRow {
    id: string
    routine_id: string
    run_id: string
    fingerprint: string
    target: string
    claim: string
    verification: string
    estimated_changed_files: number
    result_tag: string
    reason: string | null
    pull_request: number | null
    created_at: string
    updated_at: string
  }

  const readCandidateResult = (row: CandidateRow): CandidateResult => {
    switch (row.result_tag) {
      case 'Merged':
        return { _tag: 'Merged', pullRequest: row.pull_request ?? 0 }
      case 'Rejected':
        return { _tag: 'Rejected', reason: row.reason ?? '' }
      case 'Superseded':
        return { _tag: 'Superseded', reason: row.reason ?? '' }
      default:
        return { _tag: 'Proposed', pullRequest: row.pull_request }
    }
  }

  const readCandidate = (row: CandidateRow): Candidate => ({
    id: row.id,
    routineId: row.routine_id,
    runId: row.run_id,
    fingerprint: row.fingerprint,
    target: row.target,
    claim: row.claim,
    verification: row.verification,
    estimatedChangedFiles: row.estimated_changed_files,
    result: readCandidateResult(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })

  /**
   * Records the Candidates one run found, keeping only the ones never seen.
   *
   * The unique constraint on `(routine_id, fingerprint)` carries the rejection
   * memory. A Candidate Harlan rejected cannot be written again, so a Routine
   * cannot propose the same change every morning. Answering with only the
   * inserted rows tells the caller exactly what is new.
   */
  const recordCandidates: JournalStore['recordCandidates'] = (input) => {
    const statement = database.prepare(`
      INSERT INTO candidates (
        id, routine_id, run_id, fingerprint, target, claim, verification,
        estimated_changed_files, result_tag, pull_request, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Proposed', NULL, ?, ?)
      ON CONFLICT (routine_id, fingerprint) DO NOTHING
    `)
    const fresh: string[] = []
    database.exec('BEGIN IMMEDIATE')
    try {
      input.candidates.forEach((candidate) => {
        const id = `${input.runId}:${candidate.fingerprint}`
        const inserted = statement.run(
          id,
          input.routineId,
          input.runId,
          candidate.fingerprint,
          candidate.target,
          candidate.claim,
          candidate.verification,
          candidate.estimatedChangedFiles,
          input.at,
          input.at,
        ).changes === 1
        if (inserted)
          fresh.push(id)
      })
      database.exec('COMMIT')
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    if (fresh.length === 0)
      return []
    const rows = database.prepare(
      `SELECT * FROM candidates WHERE id IN (${fresh.map(() => '?').join(', ')}) ORDER BY created_at`,
    ).all(...fresh) as unknown as CandidateRow[]
    return rows.map(readCandidate)
  }

  const listCandidates: JournalStore['listCandidates'] = routineId =>
    (database.prepare('SELECT * FROM candidates WHERE routine_id = ? ORDER BY created_at').all(routineId) as unknown as CandidateRow[])
      .map(readCandidate)

  const getRoutineIssueSource: JournalStore['getRoutineIssueSource'] = (repository, issueNumber) => {
    const row = database.prepare(`
      SELECT candidate_issue_commands.routine_name, candidates.target
      FROM candidate_issue_commands
      JOIN candidates ON candidates.id = candidate_issue_commands.candidate_id
      WHERE candidate_issue_commands.repository = ?
        AND candidate_issue_commands.github_issue_number = ?
        AND candidate_issue_commands.state_tag = 'Published'
      LIMIT 1
    `).get(repository, issueNumber) as { routine_name: RoutineIssueSource['routineName'], target: string } | undefined
    return row === undefined ? null : { routineName: row.routine_name, target: row.target }
  }

  /**
   * Returns a Running Routine run whose lease expired to the queue.
   *
   * A crash leaves a run Running with nobody holding it. Without this the run
   * would sit leased to a dead process until its instant passed for good, and
   * the unique constraint on the instant means no replacement could open.
   */
  const recoverExpiredRoutineRuns = (now: string): void => {
    const expired = database.prepare(`
      SELECT id, fence FROM routine_runs
      WHERE state_tag = 'Running' AND lease_expires_at <= ?
    `).all(now) as unknown as Array<{ id: string, fence: number }>
    expired.forEach((run) => {
      const changed = database.prepare(`
        UPDATE routine_runs
        SET state_tag = 'Queued', worker_id = NULL, lease_expires_at = NULL,
          fence = fence + 1, progress_percent = 0, progress_label = 'Starting', updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND fence = ? AND lease_expires_at <= ?
      `).run(now, run.id, run.fence, now).changes === 1
      if (changed) {
        recordRoutineRunEvent(database, {
          runId: run.id,
          event: 'LeaseRecovered',
          from: 'Running',
          to: 'Queued',
          reason: 'Routine lease expired.',
          fence: run.fence + 1,
          at: now,
        })
      }
    })
  }

  const claimNextRoutineRun: JournalStore['claimNextRoutineRun'] = (workerId, now, leaseMilliseconds) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      recoverExpiredRoutineRuns(now)
      const row = database.prepare(`
        SELECT
          routine_runs.id,
          routine_runs.routine_id,
          routine_runs.scheduled_for,
          routine_runs.spec_sha,
          routine_runs.mode,
          routine_runs.fence,
          routine_runs.attempts,
          routines.repository,
          routines.name,
          repositories.policy_json
        FROM routine_runs
        JOIN routines ON routines.id = routine_runs.routine_id
        JOIN repositories ON repositories.github = routines.repository
        WHERE routine_runs.state_tag = 'Queued'
          AND routines.enabled = 1
          AND routines.retired_at IS NULL
          AND repositories.enabled = 1
        ORDER BY routine_runs.scheduled_for
        LIMIT 1
      `).get() as unknown as {
        id: string
        routine_id: string
        scheduled_for: string
        spec_sha: string
        fence: number
        attempts: number
        repository: string
        name: string
        mode: string
        policy_json: string
      } | undefined
      if (row === undefined) {
        database.exec('COMMIT')
        return null
      }

      const fence = row.fence + 1
      const leaseExpiresAt = new Date(new Date(now).getTime() + leaseMilliseconds).toISOString()
      const claimed = database.prepare(`
        UPDATE routine_runs
        SET state_tag = 'Running', worker_id = ?, lease_expires_at = ?, fence = ?,
          attempts = attempts + 1, progress_percent = 10, progress_label = 'Routine loaded', updated_at = ?
        WHERE id = ? AND state_tag = 'Queued' AND fence = ?
      `).run(workerId, leaseExpiresAt, fence, now, row.id, row.fence).changes === 1
      if (!claimed) {
        database.exec('COMMIT')
        return null
      }
      recordRoutineRunEvent(database, {
        runId: row.id,
        event: 'Claimed',
        from: 'Queued',
        to: 'Running',
        fence,
        at: now,
      })
      database.exec('COMMIT')
      return {
        id: row.id,
        routineId: row.routine_id,
        repository: row.repository,
        repositoryMapping: JSON.parse(row.policy_json) as RepositoryMapping,
        name: row.name as ClaimedRoutineRun['name'],
        mode: row.mode as ClaimedRoutineRun['mode'],
        scheduledFor: row.scheduled_for,
        specSha: row.spec_sha,
        attempts: row.attempts + 1,
        state: { _tag: 'Running', fence, workerId, leaseExpiresAt },
      }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const heartbeatRoutineRun: JournalStore['heartbeatRoutineRun'] = (input) => {
    const leaseExpiresAt = new Date(new Date(input.at).getTime() + input.leaseMilliseconds).toISOString()
    return database.prepare(`
      UPDATE routine_runs SET lease_expires_at = ?
      WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
        AND lease_expires_at > ?
    `).run(leaseExpiresAt, input.taskId, input.workerId, input.fence, input.at).changes === 1
  }

  const updateRoutineRunProgress: JournalStore['updateRoutineRunProgress'] = (input) => {
    if (!Number.isInteger(input.progress.percent) || input.progress.percent < 0 || input.progress.percent > 100)
      return false
    return database.prepare(`
      UPDATE routine_runs
      SET progress_percent = ?, progress_label = ?, updated_at = ?
      WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
    `).run(input.progress.percent, input.progress.label, input.at, input.taskId, input.workerId, input.fence).changes === 1
  }

  const completeRoutineRun: JournalStore['completeRoutineRun'] = (input) => {
    const usage = input.usage ?? { _tag: 'Unavailable' as const }
    database.exec('BEGIN IMMEDIATE')
    try {
      const changed = database.prepare(`
        UPDATE routine_runs
        SET state_tag = 'Completed', evidence = ?, reason = NULL, worker_id = NULL,
          lease_expires_at = NULL, usage = ?, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
          AND lease_expires_at > ?
      `).run(input.evidence, JSON.stringify(usage), input.at, input.taskId, input.workerId, input.fence, input.at).changes === 1
      if (changed) {
        recordRoutineRunEvent(database, {
          runId: input.taskId,
          event: 'Completed',
          from: 'Running',
          to: 'Completed',
          fence: input.fence,
          usage,
          at: input.at,
        })
      }
      database.exec('COMMIT')
      return changed
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Records one failed Routine run, retrying it until its attempts run out.
   *
   * A retry returns the run to the queue at the same instant. The unique
   * constraint on that instant still holds, so retrying can never fan one
   * missed morning out into several runs.
   */
  const failRoutineRun: JournalStore['failRoutineRun'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const row = database.prepare('SELECT attempts, max_attempts FROM routine_runs WHERE id = ?')
        .get(input.taskId) as unknown as { attempts: number, max_attempts: number } | undefined
      if (row === undefined) {
        database.exec('COMMIT')
        return 'Rejected'
      }
      const retrying = row.attempts < row.max_attempts
      const to = retrying ? 'Queued' : 'Failed'
      const changed = database.prepare(`
        UPDATE routine_runs
        SET state_tag = ?, reason = ?, worker_id = NULL, lease_expires_at = NULL,
          progress_percent = CASE WHEN ? = 'Queued' THEN 0 ELSE progress_percent END,
          progress_label = CASE WHEN ? = 'Queued' THEN 'Starting' ELSE progress_label END,
          updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
      `).run(to, input.reason, to, to, input.at, input.taskId, input.workerId, input.fence).changes === 1
      if (changed) {
        recordRoutineRunEvent(database, {
          runId: input.taskId,
          event: retrying ? 'Retrying' : 'Failed',
          from: 'Running',
          to,
          reason: input.reason,
          fence: input.fence,
          at: input.at,
        })
      }
      database.exec('COMMIT')
      if (!changed)
        return 'Rejected'
      return retrying ? 'Retrying' : 'Failed'
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const stageCandidateIssues: JournalStore['stageCandidateIssues'] = (input) => {
    const statement = database.prepare(`
      INSERT INTO candidate_issue_commands (
        id, candidate_id, repository, routine_name, title, body, state_tag, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'Pending', ?, ?)
      ON CONFLICT (candidate_id) DO NOTHING
    `)
    let staged = 0
    database.exec('BEGIN IMMEDIATE')
    try {
      input.commands.forEach((command) => {
        const inserted = statement.run(
          command.id,
          command.candidateId,
          command.repository,
          command.routineName,
          command.title,
          command.body,
          input.at,
          input.at,
        ).changes === 1
        staged += Number(inserted)
        if (inserted) {
          recordDurableCommandEvent(database, {
            stream: 'candidate_issue',
            commandId: command.id,
            event: 'Staged',
            from: null,
            to: 'Pending',
            at: input.at,
          })
        }
      })
      database.exec('COMMIT')
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    return staged
  }

  const claimNextCandidateIssue: JournalStore['claimNextCandidateIssue'] = (workerId, now, leaseMilliseconds) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const expired = database.prepare(`
        SELECT id, fence FROM candidate_issue_commands
        WHERE state_tag = 'Running' AND lease_expires_at <= ?
      `).all(now) as unknown as Array<{ id: string, fence: number }>
      expired.forEach((command) => {
        const recovered = database.prepare(`
          UPDATE candidate_issue_commands
          SET state_tag = 'Pending', worker_id = NULL, lease_expires_at = NULL,
            fence = fence + 1, updated_at = ?
          WHERE id = ? AND state_tag = 'Running' AND fence = ? AND lease_expires_at <= ?
        `).run(now, command.id, command.fence, now).changes === 1
        if (recovered) {
          recordDurableCommandEvent(database, {
            stream: 'candidate_issue',
            commandId: command.id,
            event: 'LeaseRecovered',
            from: 'Running',
            to: 'Pending',
            reason: 'Candidate issue lease expired.',
            fence: command.fence + 1,
            at: now,
          })
        }
      })
      /* Legacy bulk recovery is kept empty by the fenced loop above. */
      database.prepare(`
        UPDATE candidate_issue_commands
        SET state_tag = 'Pending', worker_id = NULL, lease_expires_at = NULL,
          fence = fence + 1, updated_at = ?
        WHERE state_tag = 'Running' AND lease_expires_at <= ?
      `).run(now, now)

      const row = database.prepare(`
        SELECT
          candidate_issue_commands.id,
          candidate_issue_commands.candidate_id,
          candidate_issue_commands.repository,
          candidate_issue_commands.routine_name,
          candidate_issue_commands.title,
          candidate_issue_commands.body,
          candidate_issue_commands.reason,
          candidates.fingerprint,
          candidate_issue_commands.fence,
          repositories.policy_json
        FROM candidate_issue_commands
        JOIN candidates ON candidates.id = candidate_issue_commands.candidate_id
        JOIN repositories ON repositories.github = candidate_issue_commands.repository
        WHERE candidate_issue_commands.state_tag = 'Pending'
          AND repositories.enabled = 1
          AND repositories.writes_enabled = 1
        ORDER BY candidate_issue_commands.updated_at, candidate_issue_commands.id
        LIMIT 1
      `).get() as unknown as {
        id: string
        candidate_id: string
        repository: string
        routine_name: string
        title: string
        body: string
        reason: string | null
        fingerprint: string
        fence: number
        policy_json: string
      } | undefined
      if (row === undefined) {
        database.exec('COMMIT')
        return null
      }

      const fence = row.fence + 1
      const leaseExpiresAt = new Date(new Date(now).getTime() + leaseMilliseconds).toISOString()
      const claimed = database.prepare(`
        UPDATE candidate_issue_commands
        SET state_tag = 'Running', worker_id = ?, lease_expires_at = ?, fence = ?,
          attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND state_tag = 'Pending' AND fence = ?
      `).run(workerId, leaseExpiresAt, fence, now, row.id, row.fence).changes === 1
      if (claimed) {
        recordDurableCommandEvent(database, {
          stream: 'candidate_issue',
          commandId: row.id,
          event: 'Claimed',
          from: 'Pending',
          to: 'Running',
          fence,
          at: now,
        })
      }
      database.exec('COMMIT')
      if (!claimed)
        return null
      return {
        id: row.id,
        candidateId: row.candidate_id,
        repository: row.repository,
        routineName: row.routine_name as ClaimedCandidateIssueCommand['routineName'],
        repositoryMapping: JSON.parse(row.policy_json) as RepositoryMapping,
        title: row.title,
        body: row.body,
        fingerprint: row.fingerprint,
        reason: row.reason,
        fence,
        workerId,
      }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  /** Records the filed issue, and points the Candidate at it. */
  const completeCandidateIssue: JournalStore['completeCandidateIssue'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const changed = database.prepare(`
        UPDATE candidate_issue_commands
        SET state_tag = 'Published', github_issue_number = ?, github_url = ?, reason = NULL,
          worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
      `).run(input.issueNumber, input.url, input.at, input.commandId, input.workerId, input.fence).changes === 1
      if (changed) {
        recordDurableCommandEvent(database, {
          stream: 'candidate_issue',
          commandId: input.commandId,
          event: 'Published',
          from: 'Running',
          to: 'Published',
          fence: input.fence,
          at: input.at,
        })
      }
      database.exec('COMMIT')
      return changed
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Records one refused filing, and leaves the command recoverable.
   *
   * A refusal is GitHub answering, not the proposal dying. Every attempt is
   * one create whose answer may change, so the command returns to Pending
   * with its reason kept, and the next pass tries again. Failed stays
   * reserved for dead letters a person has to act on.
   */
  const failCandidateIssue: JournalStore['failCandidateIssue'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const row = database.prepare(`
        SELECT attempts, max_attempts FROM candidate_issue_commands
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
      `).get(input.commandId, input.workerId, input.fence) as { attempts: number, max_attempts: number } | undefined
      if (row === undefined) {
        database.exec('COMMIT')
        return 'Unchanged'
      }
      // This command returned to Pending whatever GitHub answered, and nothing
      // read the attempts the claim had already counted. A repository with
      // issues switched off was asked to file the same proposal 282 times. A
      // refusal no retry can change stops here, and so does a spent budget.
      const terminal = !mayRetryFailure({ message: input.reason, status: input.status })
        || row.attempts >= row.max_attempts
      const state = terminal ? 'Failed' : 'Pending'
      database.prepare(`
        UPDATE candidate_issue_commands
        SET state_tag = ?, reason = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
      `).run(state, input.reason, input.at, input.commandId, input.workerId, input.fence)
      recordDurableCommandEvent(database, {
        stream: 'candidate_issue',
        commandId: input.commandId,
        event: terminal ? 'Failed' : 'Deferred',
        from: 'Running',
        to: state,
        reason: input.reason,
        fence: input.fence,
        at: input.at,
      })
      database.exec('COMMIT')
      return terminal ? 'Failed' : 'Deferred'
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const stageRoutineReport: JournalStore['stageRoutineReport'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const inserted = database.prepare(`
        INSERT INTO routine_report_commands (
          id, routine_id, run_id, repository, routine_name, body, state_tag, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 'Pending', ?, ?)
        ON CONFLICT (run_id) DO NOTHING
      `).run(
        input.command.id,
        input.command.routineId,
        input.command.runId,
        input.command.repository,
        input.command.routineName,
        input.command.body,
        input.at,
        input.at,
      ).changes === 1
      if (inserted) {
        recordDurableCommandEvent(database, {
          stream: 'routine_report',
          commandId: input.command.id,
          event: 'Staged',
          from: null,
          to: 'Pending',
          at: input.at,
        })
      }
      database.exec('COMMIT')
      return inserted
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const claimNextRoutineReport: JournalStore['claimNextRoutineReport'] = (workerId, now, leaseMilliseconds, excludedCommandIds = []) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const expired = database.prepare(`
        SELECT id, fence FROM routine_report_commands
        WHERE state_tag = 'Running' AND lease_expires_at <= ?
      `).all(now) as unknown as Array<{ id: string, fence: number }>
      expired.forEach((command) => {
        const recovered = database.prepare(`
          UPDATE routine_report_commands
          SET state_tag = 'Pending', worker_id = NULL, lease_expires_at = NULL,
            fence = fence + 1, updated_at = ?
          WHERE id = ? AND state_tag = 'Running' AND fence = ? AND lease_expires_at <= ?
        `).run(now, command.id, command.fence, now).changes === 1
        if (recovered) {
          recordDurableCommandEvent(database, {
            stream: 'routine_report',
            commandId: command.id,
            event: 'LeaseRecovered',
            from: 'Running',
            to: 'Pending',
            reason: 'Routine report lease expired.',
            fence: command.fence + 1,
            at: now,
          })
        }
      })

      const exclusion = excludedCommandIds.length === 0
        ? ''
        : `AND routine_report_commands.id NOT IN (${excludedCommandIds.map(() => '?').join(', ')})`
      const row = database.prepare(`
        SELECT
          routine_report_commands.id,
          routine_report_commands.routine_id,
          routine_report_commands.run_id,
          routine_report_commands.repository,
          routine_report_commands.routine_name,
          routine_report_commands.body,
          routine_report_commands.fence,
          routines.tracking_issue_number,
          repositories.policy_json
        FROM routine_report_commands
        JOIN routines ON routines.id = routine_report_commands.routine_id
        JOIN repositories ON repositories.github = routine_report_commands.repository
        WHERE routine_report_commands.state_tag = 'Pending'
          AND repositories.enabled = 1
          AND repositories.writes_enabled = 1
          ${exclusion}
        ORDER BY routine_report_commands.created_at, routine_report_commands.id
        LIMIT 1
      `).get(...excludedCommandIds) as unknown as {
            id: string
            routine_id: string
            run_id: string
            repository: string
            routine_name: string
            body: string
            fence: number
            tracking_issue_number: number | null
            policy_json: string
          } | undefined
      if (row === undefined) {
        database.exec('COMMIT')
        return null
      }

      const fence = row.fence + 1
      const leaseExpiresAt = new Date(new Date(now).getTime() + leaseMilliseconds).toISOString()
      const claimed = database.prepare(`
        UPDATE routine_report_commands
        SET state_tag = 'Running', worker_id = ?, lease_expires_at = ?, fence = ?,
          attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND state_tag = 'Pending' AND fence = ?
      `).run(workerId, leaseExpiresAt, fence, now, row.id, row.fence).changes === 1
      if (claimed) {
        recordDurableCommandEvent(database, {
          stream: 'routine_report',
          commandId: row.id,
          event: 'Claimed',
          from: 'Pending',
          to: 'Running',
          fence,
          at: now,
        })
      }
      const candidates = (database.prepare('SELECT * FROM candidates WHERE run_id = ? ORDER BY created_at').all(row.run_id) as unknown as CandidateRow[])
        .map(readCandidate)
      database.exec('COMMIT')
      if (!claimed)
        return null
      return {
        id: row.id,
        routineId: row.routine_id,
        runId: row.run_id,
        repository: row.repository,
        routineName: row.routine_name as ClaimedRoutineReportCommand['routineName'],
        repositoryMapping: JSON.parse(row.policy_json) as RepositoryMapping,
        body: row.body,
        trackingIssueNumber: row.tracking_issue_number,
        candidates,
        fence,
        workerId,
      }
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Records the published report, and the issue every later run reports to.
   *
   * The issue number is written here rather than when the issue is created, so
   * a run that opened the issue and then failed to comment leaves no Routine
   * pointing at an issue with nothing in it.
   */
  const completeRoutineReport: JournalStore['completeRoutineReport'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const changed = database.prepare(`
        UPDATE routine_report_commands
        SET state_tag = 'Published', github_comment_id = ?, reason = NULL,
          worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
      `).run(input.commentId, input.at, input.commandId, input.workerId, input.fence).changes === 1
      if (changed) {
        database.prepare(`
          UPDATE routines SET tracking_issue_number = ?, updated_at = ?
          WHERE id = (SELECT routine_id FROM routine_report_commands WHERE id = ?)
        `).run(input.trackingIssueNumber, input.at, input.commandId)
        recordDurableCommandEvent(database, {
          stream: 'routine_report',
          commandId: input.commandId,
          event: 'Published',
          from: 'Running',
          to: 'Published',
          fence: input.fence,
          at: input.at,
        })
      }
      database.exec('COMMIT')
      return changed
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const recordRoutineReportReceipt: JournalStore['recordRoutineReportReceipt'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const changed = database.prepare(`
        UPDATE routine_report_commands SET updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
      `).run(input.at, input.commandId, input.workerId, input.fence).changes === 1
      if (changed) {
        recordDurableCommandEvent(database, {
          stream: 'routine_report',
          commandId: input.commandId,
          event: input.sink === 'tracking_issue' ? 'TrackingIssueConfirmed' : 'RunCommentConfirmed',
          from: 'Running',
          to: 'Running',
          fence: input.fence,
          at: input.at,
        })
      }
      database.exec('COMMIT')
      return changed
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  const failRoutineReport: JournalStore['failRoutineReport'] = (input) => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const row = database.prepare('SELECT attempts, max_attempts FROM routine_report_commands WHERE id = ?')
        .get(input.commandId) as unknown as { attempts: number, max_attempts: number } | undefined
      if (row === undefined) {
        database.exec('COMMIT')
        return false
      }
      const retrying = row.attempts < row.max_attempts
      const to = retrying ? 'Pending' : 'Failed'
      const changed = database.prepare(`
        UPDATE routine_report_commands
        SET state_tag = ?, reason = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND worker_id = ? AND fence = ?
      `).run(to, input.reason, input.at, input.commandId, input.workerId, input.fence).changes === 1
      if (changed) {
        recordDurableCommandEvent(database, {
          stream: 'routine_report',
          commandId: input.commandId,
          event: retrying ? 'Deferred' : 'Failed',
          from: 'Running',
          to,
          reason: input.reason,
          fence: input.fence,
          at: input.at,
        })
      }
      database.exec('COMMIT')
      return changed
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  return {
    approveIssueWork,
    syncRoutines,
    listRoutines,
    openRoutineRun,
    skipRoutineRun,
    getRoutineRun: readRunById,
    getRoutineIssueSource,
    listRoutineRuns,
    recordCandidates,
    listCandidates,
    stageCandidateIssues,
    claimNextCandidateIssue,
    completeCandidateIssue,
    failCandidateIssue,
    stageRoutineReport,
    claimNextRoutineReport,
    completeRoutineReport,
    recordRoutineReportReceipt,
    failRoutineReport,
    claimNextRoutineRun,
    heartbeatRoutineRun,
    updateRoutineRunProgress,
    completeRoutineRun,
    failRoutineRun,
    isIssueWorkApprovalReady,
    listOpenIssueNumbers,
    listOpenPullRequestNumbers,
    listUnverifiedClosedPullRequestNumbers,
    recordExactPullRequestObservation,
    recordVerifiedPullRequestClosure,
    listOpenAgentPullRequests,
    listActiveTaskLeases,
    listRunningTaskItems,
    listQueuedReviewStatuses,
    recordApprovalPromptComment,
    listReviewGateRefreshes,
    listStoppedReviews,
    recordQueuedReviewStatus,
    isQueuedReviewStatus,
    recordDeletedReviewComment,
    recordStoppedReviewStatus,
    recordReviewClosure,
    approvePullRequest,
    authorizePublication,
    cancelTask,
    recordPullRequestTriageRun,
    claimNextAdversarialReviewTask,
    claimNextBaselineRepairTask,
    claimNextConflictTask,
    claimNextIssueTriageTask,
    claimNextIssueWorkTask,
    claimNextReviewFixTask,
    queueReviewFixTaskForReview,
    recordRepairReport,
    queueBaselineRepairForReview,
    retireBaselineRepairForReview,
    claimNextPublication,
    claimIssueTriageComment,
    claimReviewStatus,
    claimNextTerminalReviewStatus,
    close: () => database.close(),
    closeMissingItems,
    completeTask,
    supersedeTask,
    completeReviewTask,
    completeWorkerTask,
    completeIssueTriageComment,
    completePublication,
    completeReviewStatus,
    recordReviewStatusReceipt,
    deferPublication,
    deferIssueTriageComment,
    deferReviewStatus,
    failPublication,
    failTask,
    failWorkerTask,
    getAgentControl,
    getAgentSelection,
    getDashboardSnapshot,
    getStats,
    listWorkflowEvents,
    providerCanStart,
    reserveProviderStart,
    recordProviderFailure,
    recordProviderSuccess,
    listProviderCircuits,
    getWorkerSession,
    heartbeatPublication,
    hasPullRequestApproval,
    heartbeatTask,
    heartbeatWorkerTask,
    countOpenPullRequests,
    getReviewFixFindings,
    getRepairedHeadFindings,
    listAgentFeedback,
    listReviewRuns,
    recordAgentFeedback,
    needsAttentionTask,
    requestRestart,
    getRestartRequest,
    beginRestart,
    completeRestart,
    requireRestartAction,
    prepareForRestart,
    isSafeToRestart,
    dismissItem,
    restoreItem,
    getSelectionMode,
    setSelectionMode,
    pauseAgents,
    setRepositoryPaused,
    mayWriteRepository,
    setRepositoryWritesEnabled,
    recordObservation,
    recordIncident,
    resolveIncidents,
    listIncidents,
    recordPollAttempt,
    recordPollFailure,
    recordPollSuccess,
    recordReviewRun,
    supersedeReviewRun,
    recordReviewPublication,
    requestReviewRerun,
    resumeAgents,
    selectAgent,
    recoverInterruptedAgentTasks,
    retryRecoverableWorkerFailures,
    restoreOutageRecoveryBudget,
    resolveStaleTaskIncidents,
    saveWorkerSession,
    stagePublication,
    stageIssueTriageComment,
    stageReviewStatus,
    stageReviewGateStatus,
    supersedePublication,
    syncRepositories,
    updateAgentProgress,
  }
}
