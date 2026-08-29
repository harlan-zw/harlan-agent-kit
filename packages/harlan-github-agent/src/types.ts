import type { AgentProviderName, AgentTokenUsage } from './agent-provider.ts'
import type { AutoMergePolicy } from './auto-merge.ts'
import type { PullRequestPurpose } from './baseline-repair-state.ts'
import type { PriorAutomatedReview } from './review-comment.ts'

export type RepositoryOwnership = 'owned' | 'maintained' | 'external'

export type TakeOwnershipConfig
  = | { _tag: 'Disabled' }
    | {
      _tag: 'Enabled'
      productionUrl: string
      requiredWorkflows: string[]
      smokePaths: string[]
    }

export type RepositoryAuthentication = 'app' | 'user'

export interface RepositoryMapping {
  github: string
  checkout: string
  enabled: boolean
  /**
   * `app` uses the GitHub App installation. `user` uses Harlan's own token, for
   * a repository he maintains in an organization that cannot install the App.
   */
  authentication: RepositoryAuthentication
  ownership: RepositoryOwnership
  defaultBranch: string
  writablePullRequestAuthors: string[]
  writablePullRequestHeadPrefixes: string[]
  issueWork: boolean
  /** New issue work stops when this repository reaches the limit. */
  maxOpenPullRequests: number | null
  pullRequestReview: boolean
  conflictResolution: boolean
  takeOwnership: TakeOwnershipConfig
}

export interface ExternalRepositoryWatch {
  github: string
  issues: 'all' | number[]
}

export type WebhookConfig
  = | { _tag: 'Disabled' }
    | { _tag: 'Enabled', host: string, port: number, secretPath: string }

/**
 * What may start work on this machine.
 *
 * `github` covers everything a GitHub observation starts: review, repair,
 * conflicts, issue triage, and issue work. `routine` covers everything a clock
 * starts.
 *
 * Two machines running disjoint triggers need no lock and no protocol, because
 * no Task is ever visible to both. That is what lets an always-on machine run
 * the scheduled work while the desktop keeps the interactive work.
 */
export type ServiceTrigger = 'github' | 'routine'

export interface AgentConfig {
  agent: {
    provider: AgentProviderName
    /**
     * The share of each Agent provider's published window unattended work never
     * spends, per provider.
     *
     * Overnight Routines and unattended reviews can drain a subscription week
     * before the workday starts. This keeps the last share for Harlan's own
     * terminal, which the service cannot see and must not compete with.
     */
    reservePercent: Record<AgentProviderName, number>
    /** Agent providers automatic selection walks, in preference order. */
    order: readonly AgentProviderName[]
  }
  github: {
    appId: number
    privateKeyPath: string
    allowedOwners: string[]
  }
  server: {
    host: string
    port: number
    allowedOrigin: string
  }
  /** Which triggers this machine answers. Defaults to every trigger. */
  triggers: readonly ServiceTrigger[]
  /**
   * The GitHub webhook listener.
   *
   * It runs on its own port carrying one route, so exposing it through a tunnel
   * cannot reach the control API on the dashboard port.
   */
  webhook: WebhookConfig
  storage: {
    path: string
  }
  trustedCheckoutRoots: string[]
  mutationsEnabled: boolean
  autoMerge: AutoMergePolicy
  /** New issue work stops when open pull requests reach this limit. */
  maxOpenPullRequests: number
  pollIntervalSeconds: number
  issueCutoff: string
  externalRepositories: ExternalRepositoryWatch[]
  repositories: RepositoryMapping[]
}

export interface ValidatedRepositoryMapping extends RepositoryMapping {
  checkout: string
}

export interface ValidatedAgentConfig extends Omit<AgentConfig, 'repositories' | 'trustedCheckoutRoots'> {
  trustedCheckoutRoots: string[]
  repositories: ValidatedRepositoryMapping[]
}

export type ItemKind = 'issue' | 'pull_request'

interface GitHubItemBase {
  repository: string
  number: number
  state: 'open' | 'closed'
  title: string
  author: string
  url: string
  createdAt: string
  updatedAt: string
}

export interface GitHubIssueItem extends GitHubItemBase {
  kind: 'issue'
  approvalLabels: PullRequestApprovalKind[]
  /**
   * True when a Routine filed this issue as one Candidate's proposal.
   *
   * An allowlist that lists only human authors would otherwise drop the issue
   * again before triage ever read it, because the agent filed it.
   */
  routineFiled: boolean
  /** True when this is a Routine run log, including one filed by another controller. */
  routineTracking: boolean
}

export interface GitHubPullRequestItem extends GitHubItemBase {
  kind: 'pull_request'
  approvalLabels: PullRequestApprovalKind[]
  /** True when the Auto merge label lets the controller merge this pull request. */
  autoMerge: boolean
  mergedAt: string | null
  draft: boolean
  baseSha: string
  /**
   * The branch this pull request merges into.
   *
   * A pull request based on another pull request's head is a stack. Baseline
   * repair only ever applies to the default branch, so it needs to tell the
   * two apart. Absent on Revisions observed before the controller recorded it.
   */
  baseRef?: string
  headSha: string
  headRepository: string
  headRef: string
  maintainerCanModify?: boolean
  mergeState: 'clean' | 'conflicting' | 'unknown'
  /** Why this pull request exists, derived from marked GitHub state. */
  purpose: PullRequestPurpose
  priorAutomatedReview: PriorAutomatedReview
}

export type GitHubItem = GitHubIssueItem | GitHubPullRequestItem

export type PullRequestStatus
  = | { _tag: 'Unknown' }
    | { _tag: 'Open' }
    | { _tag: 'Closed' }
    | { _tag: 'Merged', mergedAt: string }

export type PullRequestApprovalKind = 'review'

export type PullRequestApprovalState
  = | { _tag: 'NotRequired' }
    | { _tag: 'ReviewRequired' }
    | { _tag: 'ReviewApproved', approvedAt: string }

export type PullRequestApprovalRejection
  = | { _tag: 'ItemNotFound' }
    | { _tag: 'RevisionMismatch' }
    | { _tag: 'ApprovalNotRequired' }

export type PullRequestApprovalResult
  = | { _tag: 'Approved', approval: PullRequestApprovalState }
    | { _tag: 'Duplicate', approval: PullRequestApprovalState }
    | { _tag: 'Rejected', reason: PullRequestApprovalRejection }

export type IssueWorkApprovalResult
  = | { _tag: 'Approved', taskId: string }
    | { _tag: 'Duplicate', taskId: string }
    | { _tag: 'Rejected', reason: { _tag: 'ItemNotFound' | 'RevisionMismatch' | 'ApprovalNotRequired' | 'TriageRequired' | 'NotAuthorized' } }

export type ReviewRerunSource = 'dashboard' | 'github_comment' | 'repair_dispute'

export type ReviewRerunRejection
  = | { _tag: 'ItemNotFound' }
    | { _tag: 'RevisionMismatch' }
    | { _tag: 'AuthorNotAllowed' }
    | { _tag: 'ReviewNotReady' }
    | { _tag: 'DisputeCapReached' }

export type ReviewRerunResult
  = | { _tag: 'Queued', taskId: string }
    | { _tag: 'AlreadyQueued', taskId: string }
    | { _tag: 'Duplicate', taskId: string }
    | { _tag: 'Rejected', reason: ReviewRerunRejection }

interface ItemSummaryBase {
  revisionId: string
  observedAt: string
  /** True while a Dismissal keeps every planner off this Item. */
  dismissed: boolean
}

/** Outcome of dismissing or restoring one Item. */
export type ItemDismissalResult
  = | { _tag: 'Dismissed' }
    | { _tag: 'Restored' }
    | { _tag: 'Duplicate' }
    | { _tag: 'Rejected', reason: { _tag: 'ItemNotFound' } }

export type ItemSummary
  = | GitHubIssueItem & ItemSummaryBase
    | GitHubPullRequestItem & ItemSummaryBase & { approval: PullRequestApprovalState }

export interface ReviewEvidence {
  label: string
  sha256: string
}

export type ReviewGateState
  = | { _tag: 'Passed', evidence: ReviewEvidence[] }
    | { _tag: 'Pending', reason: string, evidence: ReviewEvidence[] }
    | { _tag: 'Failed', reason: string, evidence: ReviewEvidence[] }

export interface ReviewGates {
  merge: ReviewGateState
  review: ReviewGateState
  ci: ReviewGateState
}

export type ReviewFinding
  = | { _tag: 'Fixed', summary: string }
    | {
      _tag: 'Open'
      summary: string
      nextAction: string
      /** Current Reviews choose Repair or recommend a person Dismiss the Item. */
      resolution?: 'Repair' | 'Dismissal'
      /**
       * Exact repair input added by current Review Agents.
       *
       * Optional because the journal can contain Review runs written before
       * structured repair handoff existed.
       */
      details?: {
        fingerprint: string
        /** Raw identity behind the fingerprint, so a later Review reuses it instead of coining new wording. */
        identity?: string
        location: { path: string, line: number | null }
        proof: string
        regressionTest: string | null
      }
    }

export type ReviewOutcome
  = | { _tag: 'Ready', confidence?: number | undefined }
    | { _tag: 'Pending', confidence?: number | undefined }
    | { _tag: 'Blocked', confidence?: number | undefined }

/** How a Review outcome is spelled where a person reads it, in the canonical comment heading and on the pull request label. */
export type ReviewOutcomeName = Uppercase<ReviewOutcome['_tag']>

export type ReviewPublicationResult
  = | { _tag: 'Published', githubCommentId: number, url: string }
    | { _tag: 'Failed', reason: string }

export interface ReviewPublication {
  id: string
  reviewRunId: string
  body: string
  bodySha256: string
  at: string
  result: ReviewPublicationResult
}

/** One explicit human judgment about one Review run. */
export type AgentFeedback
  = | { _tag: 'Useful', reason: string | null, updatedAt: string }
    | { _tag: 'Noisy', reason: string, updatedAt: string }
    | { _tag: 'Wrong', reason: string, updatedAt: string }

export type AgentFeedbackInput
  = | { _tag: 'Useful', reason: string | null }
    | { _tag: 'Noisy', reason: string }
    | { _tag: 'Wrong', reason: string }

/** One Agent feedback signal with the Review evidence needed to improve a skill. */
export interface AgentFeedbackSignal {
  reviewRunId: string
  repository: string
  pullRequestNumber: number
  headSha: string
  completedAt: string
  durationMs: number
  reviewRunsForHead: number
  usage: AgentTokenUsage
  outcome: ReviewOutcome
  findings: ReviewFinding[]
  feedback: AgentFeedback
}

export type RecordAgentFeedbackResult
  = | { _tag: 'Recorded', feedback: AgentFeedback }
    | { _tag: 'Rejected', reason: { _tag: 'ReviewRunNotFound' } }

export interface ReviewRun {
  id: string
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
  outcome: ReviewOutcome
  findings: ReviewFinding[]
  feedback: AgentFeedback | null
  publications: ReviewPublication[]
}

export interface RecordReviewRunInput extends Omit<ReviewRun, 'feedback' | 'outcome' | 'publications' | 'usage'> {
  confidence?: number
  /** Omitted callers are stored explicitly as unavailable. */
  usage?: AgentTokenUsage
}

export interface RecordReviewPublicationInput {
  id: string
  reviewRunId: string
  body: string
  at: string
  result: ReviewPublicationResult
}

export type RecordReviewRunRejection
  = | { _tag: 'InvalidConfidence' }
    | { _tag: 'InvalidEvidenceDigest', label: string }
    | { _tag: 'OpenFindingRequiresBlocked' }
    | { _tag: 'ReviewApprovalRequired' }
    | { _tag: 'RevisionMismatch' }

export type RecordReviewRunResult
  = | { _tag: 'Inserted', reviewRunId: string }
    | { _tag: 'Duplicate', reviewRunId: string }
    | { _tag: 'Conflict', reviewRunId: string }
    | { _tag: 'Rejected', reason: RecordReviewRunRejection }

/** One published controller-gate refresh for an existing Agent report. */
export interface SupersedeReviewRunInput extends RecordReviewRunInput {
  /** The Review run whose moving controller gates were refreshed. */
  supersedesReviewRunId: string
  /** The matching GitHub comment write, stored in the same transaction. */
  publication: Omit<RecordReviewPublicationInput, 'reviewRunId' | 'result'> & {
    result: Extract<ReviewPublicationResult, { _tag: 'Published' }>
  }
}

export type SupersedeReviewRunRejection
  = | { _tag: 'InvalidConfidence' }
    | { _tag: 'InvalidEvidenceDigest', label: string }
    | { _tag: 'OpenFindingRequiresBlocked' }
    | { _tag: 'ReviewApprovalRequired' }
    | { _tag: 'RevisionMismatch' }
    | { _tag: 'RunNotFound' }
    | { _tag: 'AlreadySuperseded' }

export type SupersedeReviewRunResult
  = | { _tag: 'Inserted', reviewRunId: string }
    | { _tag: 'Duplicate', reviewRunId: string }
    | { _tag: 'Conflict', reviewRunId: string }
    | { _tag: 'Rejected', reason: SupersedeReviewRunRejection }

export type RecordReviewPublicationResult
  = | { _tag: 'Inserted', publicationId: string }
    | { _tag: 'Duplicate', publicationId: string }
    | { _tag: 'Conflict', publicationId: string }
    | { _tag: 'Rejected', reason: { _tag: 'AttemptNotFound' } }

export type TaskState
  = | { _tag: 'Queued' }
    | { _tag: 'ActionRequired', reason: string }
    | { _tag: 'Running', workerId: string, fence: number, leaseExpiresAt: string }
    | { _tag: 'Publishing', commandId: string }
    | { _tag: 'Completed', evidence: string }
    | { _tag: 'Failed', reason: string }
    | { _tag: 'Superseded', reason: string }

export interface ConflictResolutionTask {
  id: string
  kind: 'resolve_conflict'
  repository: string
  pullRequestNumber: number
  revisionId: string
  state: TaskState
  updatedAt: string
  recoveryAttempts?: number
}

export interface ClaimedConflictResolutionTask extends ConflictResolutionTask {
  state: Extract<TaskState, { _tag: 'Running' }>
  repositoryMapping: RepositoryMapping
  pullRequest: GitHubPullRequestItem
}

export interface ReviewFixTask {
  id: string
  kind: 'review_fix'
  repository: string
  pullRequestNumber: number
  revisionId: string
  state: TaskState
  updatedAt: string
  recoveryAttempts?: number
}

export interface ClaimedReviewFixTask extends ReviewFixTask {
  state: Extract<TaskState, { _tag: 'Running' }>
  repositoryMapping: RepositoryMapping
  pullRequest: GitHubPullRequestItem
}

/**
 * What a review may do with the repair it already made.
 *
 * The claim used to answer with a Task or `null`, and `null` meant both "a
 * lease holder moved first" and "policy refuses this repair". The first is
 * worth another agent turn. The second never is, so the tag, and not the
 * wording of a reason, decides whether the review runs again.
 */
export type ReviewFixQueueResult
  = | { _tag: 'Queued', taskId: string }
    | { _tag: 'ActionRequired', reason: string }

export interface BaselineRepairTask {
  id: string
  kind: 'baseline_repair'
  repository: string
  pullRequestNumber: number
  revisionId: string
  state: TaskState
  updatedAt: string
  recoveryAttempts?: number
}

export interface ClaimedBaselineRepairTask extends BaselineRepairTask {
  state: Extract<TaskState, { _tag: 'Running' }>
  repositoryMapping: RepositoryMapping
  pullRequest: GitHubPullRequestItem
}

export interface AdversarialReviewTask {
  id: string
  kind: 'adversarial_review'
  repository: string
  pullRequestNumber: number
  revisionId: string
  state: TaskState
  updatedAt: string
  recoveryAttempts?: number
}

export interface ClaimedAdversarialReviewTask extends AdversarialReviewTask {
  state: Extract<TaskState, { _tag: 'Running' }>
  repositoryMapping: RepositoryMapping
  pullRequest: GitHubPullRequestItem
  rerun: { _tag: 'NotRequested' } | { _tag: 'Requested' }
}

export interface IssueTriageTask {
  id: string
  kind: 'issue_triage'
  repository: string
  issueNumber: number
  revisionId: string
  state: TaskState
  updatedAt: string
  recoveryAttempts?: number
}

export interface ClaimedIssueTriageTask extends IssueTriageTask {
  state: Extract<TaskState, { _tag: 'Running' }>
  repositoryMapping: RepositoryMapping
  issue: GitHubIssueItem
}

export interface IssueWorkTask {
  id: string
  kind: 'issue_work'
  repository: string
  issueNumber: number
  revisionId: string
  state: TaskState
  updatedAt: string
  recoveryAttempts?: number
}

export interface ClaimedIssueWorkTask extends IssueWorkTask {
  state: Extract<TaskState, { _tag: 'Running' }>
  repositoryMapping: RepositoryMapping
  issue: GitHubIssueItem
}

export type AgentTask = ConflictResolutionTask | ReviewFixTask | BaselineRepairTask | AdversarialReviewTask | IssueTriageTask | IssueWorkTask
export type ClaimedAgentTask = ClaimedConflictResolutionTask | ClaimedReviewFixTask | ClaimedBaselineRepairTask | ClaimedAdversarialReviewTask | ClaimedIssueTriageTask | ClaimedIssueWorkTask
/** A Task as shown by the dashboard, including its last durable phase. */
export type DashboardTask = AgentTask & { progress: AgentProgress }
export type AgentRole = 'conflict_resolution' | 'review_fix' | 'baseline_repair' | 'adversarial_review' | 'pull_request_triage' | 'issue_triage' | 'issue_work' | 'routine_scan' | 'routine_fix'

/**
 * Every Routine the service knows how to run.
 *
 * A repository spec selects from this list and never extends it, so a pull
 * request can change a schedule and can never name new work.
 */
export type RoutineName = 'sentry-checkin' | 'pr-triage' | 'agent-feedback'

/**
 * What a Routine run does with what it finds.
 *
 * `report` writes to the tracking issue and opens nothing. `propose` opens one
 * pull request per Candidate. An unproven Routine earns `propose` by holding
 * its Candidate precision in `report` first.
 */
export type RoutineMode = 'report' | 'propose'

/** One Routine entry exactly as a repository spec declares it. */
export interface RoutineSpecEntry {
  name: RoutineName
  /** Every cron expression this Routine answers, in its own time zone. */
  crons: readonly string[]
  timeZone: string
  mode: RoutineMode
  enabled: boolean
}

/** One repository's whole Routine spec, parsed at the boundary. */
export interface RoutineSpec {
  routines: readonly RoutineSpecEntry[]
}

/**
 * One Routine bound to one Repository mapping.
 *
 * A Routine is not an Item. It answers a clock, so it has no issue, no pull
 * request, and no Revision to hang from.
 */
/** One request for the controller to file the issue a Candidate proposes. */
export interface CandidateIssueCommand {
  id: string
  candidateId: string
  repository: string
  routineName: RoutineName
  title: string
  body: string
}

/** Trusted Routine provenance for one issue the controller filed. */
export interface RoutineIssueSource {
  routineName: RoutineName
  target: string
}

/** One leased Candidate issue command, ready for the controller to file. */
export interface ClaimedCandidateIssueCommand extends CandidateIssueCommand {
  repositoryMapping: RepositoryMapping
  /** The Candidate's identity, used to find an issue a lost write already filed. */
  fingerprint: string
  /** Why the last attempt to file this command failed, or null when it never has. */
  reason: string | null
  fence: number
  workerId: string
}

/** One request to write what a Routine run did to its tracking issue. */
export interface RoutineReportCommand {
  id: string
  routineId: string
  runId: string
  repository: string
  routineName: RoutineName
  body: string
}

/** One leased report, with the tracking issue it belongs to when one exists. */
export interface ClaimedRoutineReportCommand extends RoutineReportCommand {
  repositoryMapping: RepositoryMapping
  trackingIssueNumber: number | null
  candidates: Candidate[]
  fence: number
  workerId: string
}

export interface Routine {
  id: string
  repository: string
  name: RoutineName
  crons: readonly string[]
  timeZone: string
  mode: RoutineMode
  enabled: boolean
  /** The default branch commit the spec was read from. */
  specSha: string
  lastRunAt: string | null
  /** The issue every run of this Routine reports to, once one exists. */
  trackingIssueNumber: number | null
  updatedAt: string
}

/**
 * What one Routine run is doing.
 *
 * `Skipped` is its own state. A run that fell outside the catch-up window is
 * recorded rather than forgotten, so a check-in that did not happen reads
 * differently from one that found nothing.
 */
export type RoutineRunState
  = | { _tag: 'Queued' }
    | { _tag: 'Running', workerId: string, leaseExpiresAt: string }
    | { _tag: 'Completed', evidence: string }
    | { _tag: 'Failed', reason: string }
    | { _tag: 'Skipped', reason: string }
    | { _tag: 'ActionRequired', reason: string }
    | { _tag: 'Superseded', reason: string }

export interface RoutineRun {
  id: string
  routineId: string
  repository: string
  name: RoutineName
  /** The exact cron instant this run answers. One run per instant, ever. */
  scheduledFor: string
  specSha: string
  state: RoutineRunState
  fence: number
  attempts: number
  progress: AgentProgress
  createdAt: string
  updatedAt: string
}

/** One Routine run as sent to the dashboard, with its results and live activity attached. */
export interface DashboardRoutineRun extends RoutineRun {
  candidates: Candidate[]
  activity: AgentActivityItem[]
  /** State of this run's tracking-issue report command, or null when none was staged. */
  reportState: RoutineReportCommandState | null
}

/** The lifecycle of one Routine run's tracking-issue report. */
export type RoutineReportCommandState = 'Pending' | 'Running' | 'Published' | 'Failed'

/**
 * What happened to one Candidate.
 *
 * A `Rejected` Candidate keeps its reason so the next scan can be told not to
 * propose it again. A Routine that repeats a rejected change every day costs
 * more trust than a wrong fix.
 */
export type CandidateResult
  = | { _tag: 'Proposed', pullRequest: number | null }
    | { _tag: 'Merged', pullRequest: number }
    | { _tag: 'Rejected', reason: string }
    | { _tag: 'Superseded', reason: string }

/**
 * One Routine run a worker has leased.
 *
 * The shape matches every other claimed task, so one worktree helper and one
 * scheduler answer Routines without a second code path.
 */
export interface ClaimedRoutineRun {
  id: string
  routineId: string
  repository: string
  repositoryMapping: RepositoryMapping
  name: RoutineName
  mode: RoutineMode
  scheduledFor: string
  specSha: string
  attempts: number
  state: {
    _tag: 'Running'
    fence: number
    workerId: string
    leaseExpiresAt: string
  }
}

/** One proposed change a Routine run found, before any edit. */
export interface Candidate {
  id: string
  routineId: string
  runId: string
  /** Stable across runs. Never derived from a line number. */
  fingerprint: string
  target: string
  claim: string
  verification: string
  estimatedChangedFiles: number
  result: CandidateResult
  createdAt: string
  updatedAt: string
}

interface ReviewStatusCommandBase {
  id: string
  taskId: string
  repository: string
  pullRequestNumber: number
  revisionId: string
  expectedHeadSha: string
  body: string
  outcomeUnknown: boolean
  commentId: number | null
}

export type ReviewStatusTaskPhase
  = | { taskKind: 'adversarial_review', phase: 'snapshot' | 'review' | 'terminal' }
    | { taskKind: 'review_fix', phase: 'repair' | 'terminal' }

export type ReviewStatusCommand = ReviewStatusCommandBase & ReviewStatusTaskPhase

export type ClaimedReviewStatusCommand = ReviewStatusCommand & {
  workerId: string
  fence: number
  leaseExpiresAt: string
  repositoryMapping: RepositoryMapping
}

export interface IssueTriageCommentCommand {
  id: string
  taskId: string
  repository: string
  issueNumber: number
  revisionId: string
  expectedUpdatedAt: string
  body: string
  outcomeUnknown: boolean
  commentId: number | null
}

export interface ClaimedIssueTriageCommentCommand extends IssueTriageCommentCommand {
  workerId: string
  fence: number
  leaseExpiresAt: string
  repositoryMapping: RepositoryMapping
}

/**
 * What one minted credential is allowed to do.
 *
 * There is one write level for Item work on purpose. GitHub serves comments and
 * labels for issues and for pull requests through the same Issues API, so a
 * token that covers one kind and not the other fails half of those calls. One
 * level means no caller can pick the wrong one.
 */
export type GitHubRepositoryAccess = 'read' | 'checks_read' | 'contents_write' | 'item_write' | 'workflows_write'

export interface GitHubRepositoryToken {
  token: string
  expiresAt: string
}

/**
 * Where a new pull request will be based.
 *
 * `Stacked` is GitHub's stack: the base branch is another open pull request's
 * head branch. The service only ever stacks on a branch it opened itself.
 */
export type PullRequestBase
  = | { _tag: 'DefaultBranch', ref: string }
    | { _tag: 'Stacked', ref: string, pullRequestNumber: number, headSha: string }

/** One open pull request this service opened, which a new pull request may stack on. */
export interface OpenAgentPullRequest {
  pullRequestNumber: number
  headRef: string
  headSha: string
  baseRef: string
  taskKind: 'baseline_repair' | 'issue_work'
}

interface PublicationCommandBase {
  id: string
  taskId: string
  repository: string
  commitSha: string
  baseSha: string
  /** The branch this publication merges into. A stack names another pull request's head branch. */
  baseRef: string
  expectedHeadSha: string
  headRef: string
  artifactRef: string
  patchDigest: string
  changedFiles: number
  outcomeUnknown: boolean
}

export type PublicationCommand
  = | PublicationCommandBase & {
    _tag: 'UpdatePullRequest'
    taskKind: 'resolve_conflict' | 'review_fix'
    pullRequestNumber: number
    headRepository?: string
  }
  | PublicationCommandBase & {
    _tag: 'OpenPullRequest'
    taskKind: 'issue_work'
    issueNumber: number
    pullRequestTitle: string
    pullRequestBody: string
  }
  | PublicationCommandBase & {
    _tag: 'OpenPullRequest'
    taskKind: 'baseline_repair'
    pullRequestNumber: number
    pullRequestTitle: string
    pullRequestBody: string
  }

export type PreparedPublication = PublicationCommand extends infer Command
  ? Command extends PublicationCommand ? Omit<Command, 'id' | 'taskId' | 'repository' | 'outcomeUnknown'> : never
  : never

export type MutationWorkerOutcome
  = | { _tag: 'Publish', publication: PreparedPublication }
    | { _tag: 'ActionRequired', reason: string, evidence: string }
    /**
     * The world fixed the problem this Task existed for.
     *
     * Retrying cannot help and nobody needs to act, so the Task completes
     * instead of failing. A failure here used to sit in the dashboard forever.
     */
    | { _tag: 'Superseded', reason: string }

export type ClaimedPublicationCommand = PublicationCommand & {
  workerId: string
  fence: number
  leaseExpiresAt: string
  repositoryMapping: RepositoryMapping
}

export interface RepositoryStatus {
  github: string
  enabled: boolean
  /** Whether the controller may write to this repository. */
  writesEnabled: boolean
  ownership: RepositoryOwnership
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  /** Paused repositories keep polling and stay visible, but start no new agents. */
  paused: boolean
  subjectCount: number
}

export type AgentSession
  = | { _tag: 'Starting' }
    | { _tag: 'Connected', id: string }

export type ActiveAgentState
  = | { _tag: 'Working', workerId: string, fence: number, leaseExpiresAt: string }
    | { _tag: 'Publishing', commandId: string }

export interface AgentProgress {
  /** Internal phase rank for monotonic updates and next-step selection. Never show it as completion. */
  percent: number
  label: string
  /**
   * When this phase started, so a reader can tell a slow agent from a dead one.
   *
   * Progress only ever moves forward, so a long phase reports nothing after its
   * first line and the comment freezes. A frozen comment and a wedged agent
   * looked identical on the pull request. Absent before the phase is known.
   */
  since?: string
}

/**
 * One line of what a running agent is doing. Held in process only, so it is
 * always empty for agents that are not currently running.
 */
export type AgentActivityItem
  = | { _tag: 'Command', at: string, command: string, output: string, exitCode: number | null }
    | { _tag: 'FileChange', at: string, changes: Array<{ path: string, kind: 'add' | 'delete' | 'update' }> }
    | { _tag: 'Progress', at: string, percent: number, text: string }
    | { _tag: 'Reasoning', at: string, text: string }

export interface ActiveAgent {
  _tag: 'ActiveAgent'
  id: string
  provider: AgentProviderName
  role: AgentRole
  session: AgentSession
  repository: string
  repositoryUrl: string
  subjectKind: ItemKind
  itemNumber: number
  title: string
  /** GitHub login that opened the item, so the dashboard can show who it is for. */
  author: string
  subjectUrl: string
  headSha?: string
  commitUrl?: string
  startedAt: string
  updatedAt: string
  progress: AgentProgress
  activity: AgentActivityItem[]
  state: ActiveAgentState
}

export interface ReviewAgent extends ReviewRun {
  _tag: 'ReviewAgent'
  role: 'adversarial_review'
  repositoryUrl: string
  title: string
  author: string
  subjectUrl: string
  commitUrl: string
  pullRequestStatus: PullRequestStatus
  updatedAt: string
}

export type DashboardAgent = ActiveAgent | ReviewAgent

export type CodexAgentModel = 'gpt-5.6-sol' | 'gpt-5.6-terra' | 'gpt-5.6-luna'
/**
 * Models opencode can answer with.
 *
 * `zai-coding-plan/` runs on the GLM Coding Plan, which publishes a real quota
 * and is the route the service prefers. `opencode-go/` is metered per token.
 * The `opencode/` models are the free tier, and they keep answering after
 * everything above has reached its limit.
 */
export type OpencodeAgentModel
  = 'zai-coding-plan/glm-4.7'
    | 'zai-coding-plan/glm-5-turbo'
    | 'zai-coding-plan/glm-5.2'
    | 'zai-coding-plan/glm-5.2-highspeed'
    | 'zai-coding-plan/glm-5.3'
    | 'zai-coding-plan/glm-5.3-flash'
    | 'zai-coding-plan/glm-5.3-highspeed'
    | 'opencode/big-pickle'
    | 'opencode/deepseek-v4-flash-free'
    | 'opencode/hy3-free'
    | 'opencode/laguna-s-2.1-free'
    | 'opencode/mimo-v2.5-free'
    | 'opencode/nemotron-3-ultra-free'
    | 'opencode/nemotron-3.5-lightning-free'
    | 'opencode-go/deepseek-v4-flash'
    | 'opencode-go/deepseek-v4-pro'
    | 'opencode-go/glm-5.1'
    | 'opencode-go/glm-5.2'
    | 'opencode-go/glm-5.3'
    | 'opencode-go/glm-5.3-flash'
    | 'opencode-go/gpt-5.6-luna'
    | 'opencode-go/grok-4.5'
    | 'opencode-go/hy3'
    | 'opencode-go/kimi-k2.6'
    | 'opencode-go/kimi-k2.7-code'
    | 'opencode-go/kimi-k3'
    | 'opencode-go/mimo-v2.5'
    | 'opencode-go/mimo-v2.5-pro'
    | 'opencode-go/minimax-m2.7'
    | 'opencode-go/minimax-m3'
    | 'opencode-go/qwen3.6-plus'
    | 'opencode-go/qwen3.7-max'
    | 'opencode-go/qwen3.7-plus'
export type AgentModel = CodexAgentModel | OpencodeAgentModel
export type CodexReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface RoleProfile {
  model: AgentModel
  /** Omitted by models that expose no reasoning variants. */
  reasoningEffort?: CodexReasoningEffort
}

export interface AgentProfile {
  provider: AgentProviderName
  authentication: 'chatgpt' | 'opencode-go'
  maximumActiveAgents: number
  roles: Record<AgentRole, RoleProfile>
}

/**
 * One Agent provider, model, and reasoning effort an Agent selection pins.
 *
 * A null model or reasoning effort keeps what the provider's own profile gives
 * each Agent role. A non-null model always belongs to `provider`, because
 * `parseAgentSelection` is the only way to build one from input.
 */
export interface PinnedAgentSelection {
  provider: AgentProviderName
  model: AgentModel | null
  reasoningEffort: CodexReasoningEffort | null
}

/**
 * What one Agent provider's weekly subscription window has left.
 *
 * `Unpublished` and `Unavailable` are different answers. A provider may publish
 * no limit. A provider that normally publishes one can fail to answer.
 */
export type ProviderCapacity
  = | { _tag: 'Unpublished' }
    | { _tag: 'Unavailable', reason: string }
    | { _tag: 'Available', usedPercent: number, resetsAt: string }

/** One Agent provider's live limit and configured Reserve for the dashboard. */
export interface ProviderCapacityStatus {
  provider: AgentProviderName
  capacity: ProviderCapacity
  reservePercent: number
}

/** The one reason the scheduler can or cannot start another Agent Task. */
export type AgentStartState
  = | { _tag: 'Available' }
    | { _tag: 'Paused' }
    | { _tag: 'RestartRequested' }
    | { _tag: 'WritesDisabled' }
    | { _tag: 'ReserveReached' }
    | { _tag: 'CapacityUnavailable' }

/**
 * The Agent providers automatic selection walks, in preference order.
 *
 * The first provider with capacity above the reserve answers the next turn.
 * When none has capacity the service stops claiming new agent Tasks, rather
 * than starting work it cannot pay for.
 */
export interface AutomaticAgentSelection {
  order: readonly AgentProviderName[]
}

/**
 * One durable Agent selection.
 *
 * `FollowsConfiguration` is a value, so returning to the configuration file is
 * one switch. Absence of a choice is never absence of a row.
 */
export type AgentSelection
  = | { _tag: 'FollowsConfiguration' }
    | ({ _tag: 'Pinned' } & PinnedAgentSelection)
    | ({ _tag: 'Automatic' } & AutomaticAgentSelection)

export type QueueState
  = | { _tag: 'Active', work: AgentRole }
    | { _tag: 'ActionRequired', reason: string }
    | { _tag: 'AwaitingApproval', kind: PullRequestApprovalKind | 'issue_work' }
    | { _tag: 'Queued', work: AgentRole }
    | { _tag: 'Pending', reason: string }

interface QueueEntryBase {
  position: number
  revisionId: string
  repository: string
  repositoryUrl: string
  number: number
  title: string
  author: string
  subjectUrl: string
  createdAt: string
  updatedAt: string
  state: QueueState
}

export interface IssueQueueEntry extends QueueEntryBase {
  kind: 'issue'
}

export interface PullRequestQueueEntry extends QueueEntryBase {
  kind: 'pull_request'
  headSha: string
  commitUrl: string
}

export type QueueEntry = IssueQueueEntry | PullRequestQueueEntry

/** Where an Incident happened, which decides what clears it. */
export type IncidentScope
  = | { _tag: 'Service' }
    | { _tag: 'Repository', repository: string }
    | { _tag: 'Task', taskId: string, repository: string, itemNumber: number | null }

/**
 * What one Incident is about.
 *
 * Every kind except `runner_lost` comes from `classifyFailure`, which reads a
 * failure message. `runner_lost` comes from GitHub's own job steps instead, so
 * it is raised where the checks snapshot is built.
 */
export type IncidentKind
  = | 'github_unavailable'
    | 'github_access'
    | 'rate_limit'
    | 'network'
    | 'agent_provider'
    | 'controller'
    | 'subject_changed'
    | 'agent_result'
    | 'context_budget'
    | 'policy'
    | 'installation_access'
    /**
     * A runner stopped while its jobs were running.
     *
     * GitHub reports the job as failed, and no step reports failure. The change
     * under review is not broken, so its check runs read as PENDING.
     */
    | 'runner_lost'
    | 'unknown'

/** What the controller will do about an Incident without being asked. */
export type IncidentRecovery
  = | { _tag: 'Retrying', attempt: number, nextAttemptAt: string }
    | { _tag: 'Exhausted' }
    | { _tag: 'ActionRequired' }

/**
 * One named failure a person can read.
 *
 * Repeated identical failures raise `occurrences` on one Incident rather than
 * filling the pane, so a degraded hour reads as one entry and not six hundred.
 */
export interface Incident {
  id: string
  scope: IncidentScope
  kind: IncidentKind
  severity: 'warning' | 'error'
  message: string
  /** What the controller was doing, for example `poll` or `adversarial_review`. */
  operation: string
  recovery: IncidentRecovery
  occurrences: number
  firstSeenAt: string
  lastSeenAt: string
}

export interface DashboardSnapshot {
  generatedAt: string
  status: 'starting' | 'ready' | 'degraded'
  mutationsEnabled: boolean
  agentControl: AgentControl
  restartRequest: RestartRequest | null
  selectionMode: SelectionMode
  /** Open pull requests across every enabled repository. */
  openPullRequests: number
  /** Issue work stops when open pull requests reach this limit. */
  maxOpenPullRequests: number
  agentProfile: AgentProfile
  agentSelection: AgentSelection
  agentStart: AgentStartState
  /** Provider preference from configuration, used when a person selects Automatic. */
  agentProviderOrder: readonly AgentProviderName[]
  agentModels: Record<AgentProviderName, readonly AgentModel[]>
  reasoningEfforts: readonly CodexReasoningEffort[]
  providerCapacities: ProviderCapacityStatus[]
  agents: DashboardAgent[]
  incidents: Incident[]
  queue: QueueEntry[]
  repositories: RepositoryStatus[]
  items: ItemSummary[]
  tasks: DashboardTask[]
  routines: Routine[]
  routineRuns: DashboardRoutineRun[]
}

export type StoredAgentControl
  = | { _tag: 'Running' }
    | { _tag: 'Paused', pausedAt: string }

/**
 * Whether the service picks pull requests to act on by itself, or waits for
 * Harlan to select each one.
 */
export type SelectionMode = 'auto' | 'manual'

export type AgentControl
  = | { _tag: 'Running' }
    | { _tag: 'Paused', pausedAt: string, safeToRestart: boolean }

export type RestartRequestSource = 'dashboard' | 'tray' | 'helper'

interface RestartRequestBase {
  id: string
  source: RestartRequestSource
  requestedAt: string
}

export type RestartRequest
  = | RestartRequestBase & { _tag: 'Requested' }
    | RestartRequestBase & { _tag: 'Restarting', restartingAt: string }
    | RestartRequestBase & { _tag: 'Completed', restartingAt: string, completedAt: string }
    | RestartRequestBase & { _tag: 'ActionRequired', actionRequiredAt: string, reason: string }
