import type {
  ActiveAgent,
  AgentProfile,
  AgentRole,
  AgentStartState,
  AgentTask,
  DashboardSnapshot,
  Incident,
  IncidentKind,
  ProviderCapacityStatus,
  QueueEntry,
  RepositoryStatus,
  ReviewAgent,
  ReviewGateState,
  SelectionMode,
} from '../../../src/types.ts'
import { hasSpendableCapacity } from '../../../src/capacity.ts'

/** A progress label older than this means the agent may be wedged, not working. */
export const stalledProgressSeconds = 120
/** Past this the snapshot is old enough that acting on it could be wrong. */
export const staleSnapshotSeconds = 90

export type StatusTone = 'error' | 'warning' | 'primary' | 'success'

export type AgentProfileState
  = | { _tag: 'Loading' }
    | { _tag: 'Unavailable' }
    | { _tag: 'Available', profile: AgentProfile }

/** A placeholder snapshot must never look like a real Agent provider. */
export function agentProfileState(snapshot: DashboardSnapshot, loading: boolean): AgentProfileState {
  if (snapshot.generatedAt.length > 0)
    return { _tag: 'Available', profile: snapshot.agentProfile }
  return loading ? { _tag: 'Loading' } : { _tag: 'Unavailable' }
}

/** Reads the controller's one reason queued work can or cannot start. */
export function agentStartState(snapshot: DashboardSnapshot): AgentStartState {
  return snapshot.agentStart
}

export interface ProviderCapacityPresentation {
  label: string
  value: string
  detail: string
  tone: StatusTone | 'neutral'
}

/** Human-readable live limit state for the System pane. */
export function providerCapacityPresentation(entry: ProviderCapacityStatus): ProviderCapacityPresentation {
  const label = entry.provider === 'codex' ? 'Weekly Codex limit' : 'opencode'
  if (entry.capacity._tag === 'Unavailable') {
    return { label, value: 'Unavailable', detail: entry.capacity.reason, tone: 'warning' }
  }
  if (entry.capacity._tag === 'Unpublished') {
    return { label, value: 'Limit not published', detail: 'No Reserve applies', tone: 'neutral' }
  }
  const remaining = Math.max(0, Math.round((100 - entry.capacity.usedPercent) * 10) / 10)
  const reserveReached = !hasSpendableCapacity(entry.capacity, entry.reservePercent)
  return {
    label,
    value: `${remaining}% left`,
    detail: `${entry.reservePercent}% Reserve${reserveReached ? ' reached' : ''}`,
    tone: reserveReached ? 'warning' : 'success',
  }
}

/** The highest priority System state visible at one glance. */
export function systemState(snapshot: DashboardSnapshot): { label: string, tone: StatusTone } {
  if (snapshot.incidents.some(incident => incident.recovery._tag !== 'Retrying'))
    return { label: 'Action required', tone: 'error' }
  if (snapshot.incidents.length > 0 || snapshot.status === 'degraded')
    return { label: 'Retrying', tone: 'warning' }
  if (snapshot.status === 'starting')
    return { label: 'Starting', tone: 'warning' }
  const start = agentStartState(snapshot)
  if (start._tag === 'CapacityUnavailable')
    return { label: 'Retrying', tone: 'warning' }
  if (start._tag === 'ReserveReached')
    return { label: 'Reserve reached', tone: 'warning' }
  return { label: 'Healthy', tone: 'success' }
}

export const agentRoleLabels: Array<[AgentRole, string]> = [
  ['adversarial_review', 'Review'],
  ['baseline_repair', 'Baseline repair'],
  ['conflict_resolution', 'Conflict resolution'],
  ['issue_triage', 'Issue triage'],
  ['issue_work', 'Issue work'],
  ['review_fix', 'Repair'],
]

const terminalTaskStates = new Set(['Completed', 'Failed', 'Superseded'])

export function avatarUrl(login: string): string {
  return `https://github.com/${login}.png?size=64`
}

export function statusClass(tone: StatusTone): string {
  return `status-${tone}`
}

export function secondsSince(at: string, now: Date): number {
  return Math.max(0, (now.getTime() - new Date(at).getTime()) / 1_000)
}

export function isProgressStalled(agent: ActiveAgent, now: Date): boolean {
  return secondsSince(agent.updatedAt, now) > stalledProgressSeconds
}

export function stalledLabel(agent: ActiveAgent, now: Date): string {
  return `No progress for ${Math.floor(secondsSince(agent.updatedAt, now) / 60)}m`
}

export function isSnapshotStale(generatedAt: string, now: Date): boolean {
  if (generatedAt.length === 0)
    return false
  return secondsSince(generatedAt, now) > staleSnapshotSeconds
}

export function repositoryState(repository: RepositoryStatus): { label: string, tone: 'error' | 'warning' | 'success' } {
  if (repository.lastError !== null)
    return { label: 'Action required', tone: 'error' }
  if (repository.lastSuccessAt === null)
    return { label: 'Starting', tone: 'warning' }
  return { label: 'Healthy', tone: 'success' }
}

export function activeAgentRole(agent: ActiveAgent): string {
  if (agent.role === 'adversarial_review')
    return 'Adversarial review'
  if (agent.role === 'issue_triage')
    return 'Issue triage'
  if (agent.role === 'review_fix')
    return 'Repair'
  if (agent.role === 'baseline_repair')
    return 'Baseline repair'
  return 'Conflict resolution'
}

export function activeAgentProgress(agent: ActiveAgent): string {
  if (agent.state._tag === 'Publishing')
    return 'Fix verified. Waiting to push the commit.'
  return agent.progress.label
}

export function workLabel(work: AgentRole): string {
  if (work === 'adversarial_review')
    return 'Adversarial review'
  if (work === 'issue_triage')
    return 'Issue triage'
  if (work === 'issue_work')
    return 'Issue work'
  if (work === 'baseline_repair')
    return 'Baseline repair'
  return work === 'review_fix' ? 'Repair' : 'Conflict resolution'
}

/** Whether the engine is currently allowed to start queued work. */
export interface QueueContext {
  agentStart: AgentStartState
  openPullRequests: number
  maxOpenPullRequests: number
  selectionMode: SelectionMode
}

/**
 * True while the open pull request count holds issue work back.
 *
 * The scheduler refuses to claim issue work above the limit, so a free agent
 * changes nothing. Without this the Queue promises a start that cannot happen.
 */
export function isIssueWorkThrottled(entry: QueueEntry, context: QueueContext): boolean {
  // Manual Selection mode makes Harlan the throttle, so the limit does not apply.
  if (context.selectionMode === 'manual')
    return false
  return entry.state._tag === 'Queued'
    && entry.state.work === 'issue_work'
    && context.openPullRequests >= context.maxOpenPullRequests
}

export function queueStateLabel(entry: QueueEntry, context: QueueContext): string {
  switch (entry.state._tag) {
    case 'Active': return 'Active'
    case 'ActionRequired': return 'Action required'
    case 'AwaitingApproval': return entry.state.kind === 'issue_work'
      ? 'Issue approval'
      : 'Review and repair approval'
    case 'Queued':
      if (isIssueWorkThrottled(entry, context))
        return 'Too many open pull requests'
      if (context.agentStart._tag === 'Available')
        return 'Queued'
      if (context.agentStart._tag === 'Paused')
        return 'Agents paused'
      if (context.agentStart._tag === 'ReserveReached')
        return 'Reserve reached'
      return context.agentStart._tag === 'CapacityUnavailable' ? 'Agent provider unavailable' : 'Agents disabled'
    case 'Pending': return 'Pending'
  }
}

export function queueStateTone(entry: QueueEntry): StatusTone | 'neutral' {
  switch (entry.state._tag) {
    case 'Active': return 'success'
    case 'ActionRequired': return 'error'
    case 'AwaitingApproval': return 'warning'
    case 'Queued': return 'primary'
    case 'Pending': return 'neutral'
  }
}

export function queueDetail(entry: QueueEntry, context: QueueContext): string {
  switch (entry.state._tag) {
    case 'Active': return `${workLabel(entry.state.work)} is running.`
    case 'ActionRequired': return entry.state.reason
    case 'AwaitingApproval': return entry.state.kind === 'issue_work'
      ? 'Issue work requires your approval.'
      : 'Review and repairs require your approval.'
    case 'Queued':
      if (isIssueWorkThrottled(entry, context)) {
        return `Issue work stops above ${context.maxOpenPullRequests} open pull requests, and ${context.openPullRequests} are open. Merge or close some to start it.`
      }
      if (context.agentStart._tag === 'Available')
        return `${workLabel(entry.state.work)} will start when an agent is free.`
      if (context.agentStart._tag === 'Paused')
        return 'Pause is on. Select Resume to start this Task.'
      if (context.agentStart._tag === 'ReserveReached')
        return 'Every automatic Agent provider reached its Reserve. Work starts after a limit resets.'
      if (context.agentStart._tag === 'CapacityUnavailable')
        return 'Agent provider limits could not load. The controller will retry.'
      return 'GitHub writes are off. Enable them in the configuration, then restart the service.'
    case 'Pending': return entry.state.reason
  }
}

/** Explains the consequence of approving, which the button label alone cannot. */
export function approvalConsequence(entry: QueueEntry): string {
  if (entry.state._tag !== 'AwaitingApproval')
    return ''
  return entry.state.kind === 'issue_work'
    ? 'Approving starts issue work: the agent implements the change, then the controller opens a draft pull request.'
    : 'Approving starts adversarial review, and lets the controller push verified repair commits to this branch.'
}

export function decisionKey(entry: QueueEntry): string {
  return `${entry.repository}#${entry.number}@${entry.revisionId}:${entry.state._tag}`
}

export function reviewOutcomeLabel(agent: ReviewAgent): string {
  if (agent.outcome._tag !== 'Ready')
    return agent.outcome._tag.toUpperCase()
  // A passing review that named no confidence still reads as READY.
  return agent.outcome.confidence === undefined ? 'READY' : `READY · ${agent.outcome.confidence}/100`
}

const incidentKindLabels: Record<IncidentKind, string> = {
  agent_provider: 'Agent provider',
  agent_result: 'Agent result',
  context_budget: 'Context budget',
  controller: 'Controller',
  github_access: 'GitHub access',
  github_unavailable: 'GitHub unavailable',
  installation_access: 'Installation access',
  network: 'Network',
  policy: 'Repository policy',
  rate_limit: 'Rate limit',
  runner_lost: 'Runner lost',
  subject_changed: 'Item changed',
  unknown: 'Unclassified',
}

export function incidentKindLabel(incident: Incident): string {
  return incidentKindLabels[incident.kind] ?? incident.kind
}

export function incidentTone(incident: Incident): StatusTone {
  return incident.severity === 'error' ? 'error' : 'warning'
}

/** Says what the controller will do next, so the pane answers "do I act on this?". */
export function incidentRecoveryLabel(incident: Incident): string {
  if (incident.recovery._tag === 'Retrying')
    return incident.recovery.attempt > 0 ? `Retrying · attempt ${incident.recovery.attempt}` : 'Retrying'
  return incident.recovery._tag === 'Exhausted' ? 'Retries exhausted' : 'Action required'
}

export function incidentScopeLabel(incident: Incident): string {
  if (incident.scope._tag === 'Service')
    return 'Controller'
  if (incident.scope._tag === 'Repository')
    return incident.scope.repository
  return incident.scope.itemNumber === null
    ? incident.scope.repository
    : `${incident.scope.repository}#${incident.scope.itemNumber}`
}

export function incidentUrl(incident: Incident): string | undefined {
  if (incident.scope._tag === 'Repository')
    return `https://github.com/${incident.scope.repository}`
  if (incident.scope._tag === 'Task' && incident.scope.itemNumber !== null)
    return `https://github.com/${incident.scope.repository}/pull/${incident.scope.itemNumber}`
  return undefined
}

/** Errors first, then whatever happened most recently. */
export function incidentEntries(incidents: Incident[]): Incident[] {
  return [...incidents].sort((left, right) => {
    if (left.severity !== right.severity)
      return left.severity === 'error' ? -1 : 1
    return right.lastSeenAt.localeCompare(left.lastSeenAt)
  })
}

export function reviewOutcomeTone(agent: ReviewAgent): 'error' | 'warning' | 'success' {
  if (agent.outcome._tag === 'Ready')
    return 'success'
  return agent.outcome._tag === 'Blocked' ? 'error' : 'warning'
}

function compactCount(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value).toLowerCase()
}

export function reviewUsageLabel(usage: ReviewAgent['usage']): string {
  if (usage._tag === 'Unavailable')
    return 'Usage unavailable'
  return `${compactCount(usage.input)} input · ${compactCount(usage.cachedInput)} cached · ${compactCount(usage.output)} output · ${compactCount(usage.reasoning)} reasoning · ${compactCount(usage.cacheWrite)} cache write`
}

export function gateTone(gate: ReviewGateState): 'error' | 'warning' | 'success' {
  if (gate._tag === 'Passed')
    return 'success'
  return gate._tag === 'Failed' ? 'error' : 'warning'
}

export function taskNumber(task: AgentTask): number {
  return task.kind === 'issue_triage' || task.kind === 'issue_work' ? task.issueNumber : task.pullRequestNumber
}

export function taskIsIssue(task: AgentTask): boolean {
  return task.kind === 'issue_triage' || task.kind === 'issue_work'
}

export function taskKindLabel(task: AgentTask): string {
  const role: AgentRole = task.kind === 'resolve_conflict' ? 'conflict_resolution' : task.kind
  const match = agentRoleLabels.find(([candidate]) => candidate === role)
  return match === undefined ? task.kind : match[1]
}

export function taskSubjectUrl(task: AgentTask): string {
  return `https://github.com/${task.repository}/${taskIsIssue(task) ? 'issues' : 'pull'}/${taskNumber(task)}`
}

/** Superseded is neither a win nor a failure: the work was replaced, so it stays neutral. */
export function taskStateTone(task: AgentTask): 'success' | 'error' | 'neutral' {
  if (task.state._tag === 'Completed')
    return 'success'
  return task.state._tag === 'Failed' ? 'error' : 'neutral'
}

export function taskStateDetail(task: AgentTask): string | undefined {
  if (task.state._tag === 'Failed' || task.state._tag === 'Superseded')
    return task.state.reason
  return undefined
}

export type HistoryRecord
  = | { _tag: 'Review', key: string, at: string, agent: ReviewAgent }
    | { _tag: 'Task', key: string, at: string, task: AgentTask }

/**
 * Everything that already finished, newest first. Reviews carry their own evidence.
 * Terminal tasks cover the work that produces no review, which would otherwise
 * finish and vanish without ever being recorded on screen.
 */
export function buildHistory(reviewAgents: ReviewAgent[], tasks: AgentTask[]): HistoryRecord[] {
  const reviewed = new Set(reviewAgents.map(agent => `${agent.repository}#${agent.pullRequestNumber}@${agent.revisionId}`))
  const reviews = reviewAgents.map((agent): HistoryRecord => ({ _tag: 'Review', key: agent.id, at: agent.completedAt, agent }))
  const settled = tasks
    .filter(task => terminalTaskStates.has(task.state._tag))
    .filter(task => !(task.kind === 'adversarial_review' && reviewed.has(`${task.repository}#${taskNumber(task)}@${task.revisionId}`)))
    .map((task): HistoryRecord => ({ _tag: 'Task', key: task.id, at: task.updatedAt, task }))
  return [...reviews, ...settled].sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime())
}

/**
 * What a card is for, as an icon and a word.
 *
 * Work kind never uses semantic colour. Amber, red, and emerald mean state on
 * this board, so a second colour axis for work kind would make both unreadable.
 * The icon carries the distinction instead.
 */
export interface WorkChip {
  label: string
  icon: string
}

const workChips: Record<AgentRole, WorkChip> = {
  adversarial_review: { label: 'Review', icon: 'i-lucide-scan-eye' },
  review_fix: { label: 'Repair', icon: 'i-lucide-wrench' },
  conflict_resolution: { label: 'Conflict', icon: 'i-lucide-git-merge' },
  baseline_repair: { label: 'Baseline', icon: 'i-lucide-heart-pulse' },
  issue_triage: { label: 'Triage', icon: 'i-lucide-inbox' },
  issue_work: { label: 'Issue work', icon: 'i-lucide-hammer' },
  routine_scan: { label: 'Routine scan', icon: 'i-lucide-radar' },
  routine_fix: { label: 'Routine fix', icon: 'i-lucide-clock-arrow-up' },
}

export const workChipEntries: Array<[AgentRole, WorkChip]> = Object.entries(workChips) as Array<[AgentRole, WorkChip]>

export function workChip(work: AgentRole): WorkChip {
  return workChips[work]
}

export function taskWork(task: AgentTask): AgentRole {
  return task.kind === 'resolve_conflict' ? 'conflict_resolution' : task.kind
}

/**
 * The work a Queue entry stands for, when the entry names one.
 *
 * `ActionRequired` and `Pending` describe a condition rather than a kind of
 * work, so they have none until a Task exists for them.
 */
export function queueWork(entry: QueueEntry): AgentRole | undefined {
  if (entry.state._tag === 'Active' || entry.state._tag === 'Queued')
    return entry.state.work
  if (entry.state._tag === 'AwaitingApproval')
    return entry.state.kind === 'issue_work' ? 'issue_work' : 'adversarial_review'
  return undefined
}

/** Anything the engine cannot resolve without Harlan. This zone outranks everything else. */
export function decisionEntries(queue: QueueEntry[]): QueueEntry[] {
  return queue.filter(entry => entry.state._tag === 'AwaitingApproval' || entry.state._tag === 'ActionRequired')
}

/** Work an agent will pick up on its own, in engine order. */
export function queuedEntries(queue: QueueEntry[]): QueueEntry[] {
  return queue.filter(entry => entry.state._tag === 'Queued')
}

/**
 * Work that is blocked on something outside the engine.
 *
 * A draft pull request and a pull request waiting on GitHub both sit here. They
 * are not queued, so showing them beside queued work reads as a forecast that
 * never arrives.
 */
export function waitingEntries(queue: QueueEntry[]): QueueEntry[] {
  return queue.filter(entry => entry.state._tag === 'Pending')
}

/**
 * Work the Queue calls Active that has no agent card of its own.
 *
 * Without this the Running column would drop a task that started before its
 * agent session reported, and the board would look emptier than the engine is.
 */
export function activeEntries(queue: QueueEntry[], activeAgents: ActiveAgent[]): QueueEntry[] {
  const running = new Set(activeAgents.map(agent => `${agent.repository}#${agent.itemNumber}`))
  return queue.filter(entry => entry.state._tag === 'Active' && !running.has(`${entry.repository}#${entry.number}`))
}
