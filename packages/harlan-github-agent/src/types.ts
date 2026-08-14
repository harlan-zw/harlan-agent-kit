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

export interface RepositoryMapping {
  github: string
  checkout: string
  enabled: boolean
  ownership: RepositoryOwnership
  defaultBranch: string
  writablePullRequestAuthors: string[]
  writablePullRequestHeadPrefixes: string[]
  issueWork: boolean
  pullRequestReview: boolean
  pullRequestConformance: boolean
  conflictResolution: boolean
  takeOwnership: TakeOwnershipConfig
}

export interface ExternalRepositoryWatch {
  github: string
  issues: 'all' | number[]
}

export interface AgentConfig {
  github: {
    appId: number
    privateKeyPath: string
    allowedOwners: string[]
  }
  server: {
    host: string
    port: number
    allowedHost: string
  }
  storage: {
    path: string
  }
  trustedCheckoutRoots: string[]
  mutationsEnabled: boolean
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

export type SubjectKind = 'issue' | 'pull_request'

interface GitHubSubjectBase {
  repository: string
  number: number
  state: 'open' | 'closed'
  title: string
  author: string
  url: string
  createdAt: string
  updatedAt: string
}

export interface GitHubIssueSubject extends GitHubSubjectBase {
  kind: 'issue'
  approvalLabels: PullRequestApprovalKind[]
}

export interface GitHubPullRequestSubject extends GitHubSubjectBase {
  kind: 'pull_request'
  approvalLabels: PullRequestApprovalKind[]
  mergedAt: string | null
  draft: boolean
  baseSha: string
  headSha: string
  headRepository: string
  headRef: string
  maintainerCanModify?: boolean
  mergeState: 'clean' | 'conflicting' | 'unknown'
  priorAutomatedReview: PriorAutomatedReview
}

export type GitHubSubject = GitHubIssueSubject | GitHubPullRequestSubject

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
  = | { _tag: 'SubjectNotFound' }
    | { _tag: 'RevisionMismatch' }
    | { _tag: 'ApprovalNotRequired' }

export type PullRequestApprovalResult
  = | { _tag: 'Approved', approval: PullRequestApprovalState }
    | { _tag: 'Duplicate', approval: PullRequestApprovalState }
    | { _tag: 'Rejected', reason: PullRequestApprovalRejection }

export type IssueWorkApprovalResult
  = | { _tag: 'Approved', taskId: string }
    | { _tag: 'Duplicate', taskId: string }
    | { _tag: 'Rejected', reason: { _tag: 'SubjectNotFound' | 'RevisionMismatch' | 'ApprovalNotRequired' | 'TriageRequired' | 'NotAuthorized' } }

export type ReviewRerunSource = 'dashboard' | 'github_comment'

export type ReviewRerunRejection
  = | { _tag: 'SubjectNotFound' }
    | { _tag: 'RevisionMismatch' }
    | { _tag: 'AuthorNotAllowed' }
    | { _tag: 'ReviewNotReady' }

export type ReviewRerunResult
  = | { _tag: 'Queued', taskId: string }
    | { _tag: 'AlreadyQueued', taskId: string }
    | { _tag: 'Duplicate', taskId: string }
    | { _tag: 'Rejected', reason: ReviewRerunRejection }

interface SubjectSummaryBase {
  revisionId: string
  observedAt: string
}

export type SubjectSummary
  = | GitHubIssueSubject & SubjectSummaryBase
    | GitHubPullRequestSubject & SubjectSummaryBase & { approval: PullRequestApprovalState }

export interface ReviewEvidence {
  label: string
  sha256: string
}

export type ReviewGateState
  = | { _tag: 'Passed', evidence: ReviewEvidence[] }
    | { _tag: 'Waiting', reason: string, evidence: ReviewEvidence[] }
    | { _tag: 'Failed', reason: string, evidence: ReviewEvidence[] }

export interface ReviewGates {
  head: ReviewGateState
  merge: ReviewGateState
  metadata: ReviewGateState
  review: ReviewGateState
  verification: ReviewGateState
  ci: ReviewGateState
}

export type ReviewFinding
  = | { _tag: 'Fixed', summary: string }
    | { _tag: 'Open', summary: string, nextAction: string }

export type ReviewOutcome
  = | { _tag: 'Ready', confidence: number }
    | { _tag: 'Waiting' }
    | { _tag: 'Blocked' }

export type ReviewPublicationResult
  = | { _tag: 'Published', githubCommentId: number, url: string }
    | { _tag: 'Failed', reason: string }

export interface ReviewPublication {
  id: string
  attemptId: string
  body: string
  bodySha256: string
  at: string
  result: ReviewPublicationResult
}

export interface ReviewAttempt {
  id: string
  repository: string
  pullRequestNumber: number
  revisionId: string
  headSha: string
  provider: 'codex' | 'claude'
  sessionId: string
  model: string
  agentVersion: string
  skillDigest: string
  startedAt: string
  completedAt: string
  gates: ReviewGates
  outcome: ReviewOutcome
  findings: ReviewFinding[]
  publications: ReviewPublication[]
}

export interface RecordReviewAttemptInput extends Omit<ReviewAttempt, 'outcome' | 'publications'> {
  confidence?: number
}

export interface RecordReviewPublicationInput {
  id: string
  attemptId: string
  body: string
  at: string
  result: ReviewPublicationResult
}

export type RecordReviewAttemptRejection
  = | { _tag: 'ConfidenceRequiresReady' }
    | { _tag: 'ReadyRequiresConfidence' }
    | { _tag: 'InvalidConfidence' }
    | { _tag: 'InvalidEvidenceDigest', label: string }
    | { _tag: 'OpenFindingRequiresBlocked' }
    | { _tag: 'ReviewApprovalRequired' }
    | { _tag: 'RevisionMismatch' }

export type RecordReviewAttemptResult
  = | { _tag: 'Inserted', attemptId: string }
    | { _tag: 'Duplicate', attemptId: string }
    | { _tag: 'Conflict', attemptId: string }
    | { _tag: 'Rejected', reason: RecordReviewAttemptRejection }

export type RecordReviewPublicationResult
  = | { _tag: 'Inserted', publicationId: string }
    | { _tag: 'Duplicate', publicationId: string }
    | { _tag: 'Conflict', publicationId: string }
    | { _tag: 'Rejected', reason: { _tag: 'AttemptNotFound' } }

export type TaskState
  = | { _tag: 'Queued' }
    | { _tag: 'NeedsAttention', reason: string }
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
}

export interface ClaimedConflictResolutionTask extends ConflictResolutionTask {
  state: Extract<TaskState, { _tag: 'Running' }>
  repositoryMapping: RepositoryMapping
  pullRequest: GitHubPullRequestSubject
}

export interface ReviewFixTask {
  id: string
  kind: 'review_fix'
  repository: string
  pullRequestNumber: number
  revisionId: string
  state: TaskState
  updatedAt: string
}

export interface ClaimedReviewFixTask extends ReviewFixTask {
  state: Extract<TaskState, { _tag: 'Running' }>
  repositoryMapping: RepositoryMapping
  pullRequest: GitHubPullRequestSubject
  findings: Array<Extract<ReviewFinding, { _tag: 'Open' }>>
}

export interface BaselineRepairTask {
  id: string
  kind: 'baseline_repair'
  repository: string
  pullRequestNumber: number
  revisionId: string
  state: TaskState
  updatedAt: string
}

export interface ClaimedBaselineRepairTask extends BaselineRepairTask {
  state: Extract<TaskState, { _tag: 'Running' }>
  repositoryMapping: RepositoryMapping
  pullRequest: GitHubPullRequestSubject
}

export interface AdversarialReviewTask {
  id: string
  kind: 'adversarial_review'
  repository: string
  pullRequestNumber: number
  revisionId: string
  state: TaskState
  updatedAt: string
}

export interface ClaimedAdversarialReviewTask extends AdversarialReviewTask {
  state: Extract<TaskState, { _tag: 'Running' }>
  repositoryMapping: RepositoryMapping
  pullRequest: GitHubPullRequestSubject
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
}

export interface ClaimedIssueTriageTask extends IssueTriageTask {
  state: Extract<TaskState, { _tag: 'Running' }>
  repositoryMapping: RepositoryMapping
  issue: GitHubIssueSubject
}

export interface IssueWorkTask {
  id: string
  kind: 'issue_work'
  repository: string
  issueNumber: number
  revisionId: string
  state: TaskState
  updatedAt: string
}

export interface ClaimedIssueWorkTask extends IssueWorkTask {
  state: Extract<TaskState, { _tag: 'Running' }>
  repositoryMapping: RepositoryMapping
  issue: GitHubIssueSubject
}

export type AgentTask = ConflictResolutionTask | ReviewFixTask | BaselineRepairTask | AdversarialReviewTask | IssueTriageTask | IssueWorkTask
export type ClaimedAgentTask = ClaimedConflictResolutionTask | ClaimedReviewFixTask | ClaimedBaselineRepairTask | ClaimedAdversarialReviewTask | ClaimedIssueTriageTask | ClaimedIssueWorkTask
export type WorkerRole = 'conflict_resolution' | 'review_fix' | 'baseline_repair' | 'adversarial_review' | 'issue_triage' | 'issue_work'

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
    | { taskKind: 'review_fix', phase: 'repair' }

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

export type GitHubRepositoryAccess = 'read' | 'checks_read' | 'contents_write' | 'issues_write' | 'pull_requests_write'

export interface GitHubRepositoryToken {
  token: string
  expiresAt: string
}

interface PublicationCommandBase {
  id: string
  taskId: string
  repository: string
  commitSha: string
  baseSha: string
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
    | { _tag: 'NeedsAttention', reason: string, evidence: string }

export type ClaimedPublicationCommand = PublicationCommand & {
  workerId: string
  fence: number
  leaseExpiresAt: string
  repositoryMapping: RepositoryMapping
}

export interface RepositoryStatus {
  github: string
  enabled: boolean
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
  percent: number
  label: string
}

/**
 * One line of what a running agent is doing. Held in process only, so it is
 * always empty for agents that are not currently running.
 */
export type AgentActivityItem
  = | { _tag: 'Command', at: string, command: string, output: string, exitCode: number | null }
    | { _tag: 'FileChange', at: string, changes: Array<{ path: string, kind: 'add' | 'delete' | 'update' }> }
    | { _tag: 'Reasoning', at: string, text: string }

export interface ActiveAgent {
  _tag: 'ActiveAgent'
  id: string
  provider: 'codex'
  role: WorkerRole
  session: AgentSession
  repository: string
  repositoryUrl: string
  subjectKind: SubjectKind
  subjectNumber: number
  title: string
  subjectUrl: string
  headSha?: string
  commitUrl?: string
  startedAt: string
  updatedAt: string
  progress: AgentProgress
  activity: AgentActivityItem[]
  state: ActiveAgentState
}

export interface ReviewAgent extends ReviewAttempt {
  _tag: 'ReviewAgent'
  role: 'adversarial_review'
  repositoryUrl: string
  title: string
  subjectUrl: string
  commitUrl: string
  pullRequestStatus: PullRequestStatus
  updatedAt: string
}

export type DashboardAgent = ActiveAgent | ReviewAgent

export type CodexWorkerModel = 'gpt-5.6-sol' | 'gpt-5.6-terra' | 'gpt-5.6-luna'
export type CodexReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface CodexRoleProfile {
  model: CodexWorkerModel
  reasoningEffort: CodexReasoningEffort
}

export interface CodexWorkerProfile {
  provider: 'codex'
  authentication: 'chatgpt'
  maximumActiveAgents: 3
  roles: Record<WorkerRole, CodexRoleProfile>
}

export type QueueState
  = | { _tag: 'Active', work: WorkerRole }
    | { _tag: 'NeedsAttention', reason: string }
    | { _tag: 'AwaitingApproval', kind: PullRequestApprovalKind | 'issue_work' }
    | { _tag: 'Queued', work: WorkerRole }
    | { _tag: 'Waiting', reason: string }

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

export interface DashboardSnapshot {
  generatedAt: string
  status: 'starting' | 'ready' | 'degraded'
  mutationsEnabled: boolean
  agentControl: AgentControl
  workerProfile: CodexWorkerProfile
  agents: DashboardAgent[]
  queue: QueueEntry[]
  repositories: RepositoryStatus[]
  subjects: SubjectSummary[]
  tasks: AgentTask[]
}

export type StoredAgentControl
  = | { _tag: 'Running' }
    | { _tag: 'Paused', pausedAt: string }

export type AgentControl
  = | { _tag: 'Running' }
    | { _tag: 'Paused', pausedAt: string, safeToRestart: boolean }
