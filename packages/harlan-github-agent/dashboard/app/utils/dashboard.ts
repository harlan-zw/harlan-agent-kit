import type {
  ActiveAgent,
  AgentRole,
  AgentTask,
  Incident,
  IncidentKind,
  QueueEntry,
  RepositoryStatus,
  ReviewAgent,
  ReviewGateState,
} from '../../../src/types.ts'

/** A progress label older than this means the agent may be wedged, not working. */
export const stalledProgressSeconds = 120
/** Past this the snapshot is old enough that acting on it could be wrong. */
export const staleSnapshotSeconds = 90

export type StatusTone = 'error' | 'warning' | 'primary' | 'success'

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
  agentsCanStart: boolean
  agentsPaused: boolean
}

export function queueStateLabel(entry: QueueEntry, context: QueueContext): string {
  switch (entry.state._tag) {
    case 'Active': return 'Active'
    case 'ActionRequired': return 'Action required'
    case 'AwaitingApproval': return entry.state.kind === 'issue_work'
      ? 'Issue approval'
      : 'Review and repair approval'
    case 'Queued': return context.agentsCanStart ? 'Queued' : context.agentsPaused ? 'Agents paused' : 'Agents disabled'
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
    case 'Queued': return context.agentsCanStart
      ? `${workLabel(entry.state.work)} will start when an agent is free.`
      : 'Automatic reviews and fixes are disabled.'
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
  controller: 'Controller',
  github_access: 'GitHub access',
  github_unavailable: 'GitHub unavailable',
  installation_access: 'Installation access',
  network: 'Network',
  policy: 'Repository policy',
  rate_limit: 'Rate limit',
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

/** Anything the engine cannot resolve without Harlan. This zone outranks everything else. */
export function decisionEntries(queue: QueueEntry[]): QueueEntry[] {
  return queue.filter(entry => entry.state._tag === 'AwaitingApproval' || entry.state._tag === 'ActionRequired')
}

/** Queue minus decisions, minus work already visible as a running agent. */
export function upNextEntries(queue: QueueEntry[], activeAgents: ActiveAgent[]): QueueEntry[] {
  const running = new Set(activeAgents.map(agent => `${agent.repository}#${agent.itemNumber}`))
  return queue.filter((entry) => {
    if (entry.state._tag === 'AwaitingApproval' || entry.state._tag === 'ActionRequired')
      return false
    return !(entry.state._tag === 'Active' && running.has(`${entry.repository}#${entry.number}`))
  })
}
