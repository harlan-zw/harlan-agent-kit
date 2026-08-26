import type { AgentProviderName, AgentTokenUsage } from './agent-provider.ts'
import type { AutoMergePolicy } from './auto-merge.ts'
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
  agent: {
    provider: AgentProviderName
  }
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
  autoMerge: AutoMergePolicy
  /** New issue work stops above this many open pull requests waiting on Harlan. */
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
  head: ReviewGateState
  merge: ReviewGateState
  metadata: ReviewGateState
  review: ReviewGateState
  verification: ReviewGateState
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
  /** `confidence` is absent when the agent passed every gate but named no score. */
  = | { _tag: 'Ready', confidence?: number | undefined }
    | { _tag: 'Pending' }
    | { _tag: 'Blocked' }

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
  publications: ReviewPublication[]
}

export interface RecordReviewRunInput extends Omit<ReviewRun, 'outcome' | 'publications' | 'usage'> {
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
  = | { _tag: 'ConfidenceRequiresReady' }
    | { _tag: 'InvalidConfidence' }
    | { _tag: 'InvalidEvidenceDigest', label: string }
    | { _tag: 'OpenFindingRequiresBlocked' }
    | { _tag: 'ReviewApprovalRequired' }
    | { _tag: 'RevisionMismatch' }

export type RecordReviewRunResult
  = | { _tag: 'Inserted', reviewRunId: string }
    | { _tag: 'Duplicate', reviewRunId: string }
    | { _tag: 'Conflict', reviewRunId: string }
    | { _tag: 'Rejected', reason: RecordReviewRunRejection }

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
}

export interface ClaimedIssueWorkTask extends IssueWorkTask {
  state: Extract<TaskState, { _tag: 'Running' }>
  repositoryMapping: RepositoryMapping
  issue: GitHubIssueItem
}

export type AgentTask = ConflictResolutionTask | ReviewFixTask | BaselineRepairTask | AdversarialReviewTask | IssueTriageTask | IssueWorkTask
export type ClaimedAgentTask = ClaimedConflictResolutionTask | ClaimedReviewFixTask | ClaimedBaselineRepairTask | ClaimedAdversarialReviewTask | ClaimedIssueTriageTask | ClaimedIssueWorkTask
export type AgentRole = 'conflict_resolution' | 'review_fix' | 'baseline_repair' | 'adversarial_review' | 'issue_triage' | 'issue_work'

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
    | { _tag: 'Obsolete', evidence: string }

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
 * The `opencode/` models are the free tier. They keep answering after the
 * metered `opencode-go/` subscription reaches its weekly limit.
 */
export type OpencodeAgentModel
  = 'opencode/big-pickle'
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
    | 'opencode-go/ox-alpha-free'
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
 * One durable Agent selection.
 *
 * `FollowsConfiguration` is a value, so returning to the configuration file is
 * one switch. Absence of a choice is never absence of a row.
 */
export type AgentSelection
  = | { _tag: 'FollowsConfiguration' }
    | ({ _tag: 'Pinned' } & PinnedAgentSelection)

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
  selectionMode: SelectionMode
  /** Open pull requests across every enabled repository. */
  openPullRequests: number
  /** Issue work stops above this many open pull requests. */
  maxOpenPullRequests: number
  agentProfile: AgentProfile
  agentSelection: AgentSelection
  agents: DashboardAgent[]
  incidents: Incident[]
  queue: QueueEntry[]
  repositories: RepositoryStatus[]
  items: ItemSummary[]
  tasks: AgentTask[]
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
