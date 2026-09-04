import type {
  ActiveAgent,
  AgentProfile,
  AgentRole,
  AgentStartState,
  AgentTask,
  DashboardRoutineRun,
  DashboardSnapshot,
  DashboardTask,
  Incident,
  IncidentKind,
  ProviderCapacityStatus,
  ProviderCircuit,
  QueueEntry,
  RepositoryStatus,
  ReviewAgent,
  ReviewGateState,
  Routine,
  RoutineRun,
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

export interface ScheduledRoutineRecord {
  routine: Routine
  latestRun: DashboardRoutineRun | undefined
}

export interface RoutineRunPresentation {
  label: string
  tone: StatusTone | 'neutral'
  detail?: string
}

/** Pairs each declared Routine with the newest run the snapshot retained. */
export function scheduledRoutineRecords(routines: readonly Routine[], runs: readonly DashboardRoutineRun[]): ScheduledRoutineRecord[] {
  const newest = new Map<string, DashboardRoutineRun>()
  runs.forEach((run) => {
    const current = newest.get(run.routineId)
    if (current === undefined || run.scheduledFor > current.scheduledFor)
      newest.set(run.routineId, run)
  })
  return routines.map(routine => ({ routine, latestRun: newest.get(routine.id) }))
}

/** Gives one Routine run a label, semantic tone, and durable outcome detail. */
export function routineRunPresentation(run: RoutineRun | undefined): RoutineRunPresentation {
  if (run === undefined)
    return { label: 'Never run', tone: 'neutral' }
  switch (run.state._tag) {
    case 'Queued': return { label: 'Queued', tone: 'neutral' }
    case 'Running': return { label: 'Running', tone: 'primary', detail: run.progress.label }
    case 'Completed': return { label: 'Completed', tone: 'success', detail: run.state.evidence }
    case 'Failed': return { label: 'Failed', tone: 'error', detail: run.state.reason }
    case 'Skipped': return { label: 'Skipped', tone: 'neutral', detail: run.state.reason }
    case 'ActionRequired': return { label: 'Action required', tone: 'warning', detail: run.state.reason }
    case 'Superseded': return { label: 'Superseded', tone: 'neutral', detail: run.state.reason }
  }
}

export function routineTrackingUrl(routine: Routine): string | undefined {
  return routine.trackingIssueNumber === null
    ? undefined
    : `https://github.com/${routine.repository}/issues/${routine.trackingIssueNumber}`
}

/**
 * Whether a finished Routine run still owes its tracking-issue report.
 *
 * The report command, not the writes flag alone, says what happened: a run
 * whose report already published must not read as pending, whatever the
 * repository writes do now.
 */
export function routineReportPending(latestRun: RoutineRun, writesEnabled: boolean, reportPublished: boolean): boolean {
  if (reportPublished || writesEnabled)
    return false
  return latestRun.state._tag === 'Completed' || latestRun.state._tag === 'Skipped'
}

/**
 * What the Watching page may offer in the Writes cell for one repository.
 *
 * External watches have no row in the repositories table, so an enable action
 * for them could only ever answer 404. They render no control at all.
 */
export type RepositoryWritesControl
  = | { _tag: 'External' }
    | { _tag: 'Adjustable', writesEnabled: boolean }

export function repositoryWritesControl(repository: RepositoryStatus): RepositoryWritesControl {
  return repository.ownership === 'external'
    ? { _tag: 'External' }
    : { _tag: 'Adjustable', writesEnabled: repository.writesEnabled }
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
  if (snapshot.providerCircuits.some(circuit => circuit.state._tag !== 'Closed'))
    return { label: 'Agent provider paused', tone: 'warning' }
  const start = agentStartState(snapshot)
  if (start._tag === 'CapacityUnavailable')
    return { label: 'Retrying', tone: 'warning' }
  if (start._tag === 'ReserveReached')
    return { label: 'Reserve reached', tone: 'warning' }
  if (snapshot.providerCapacities.some(entry => entry.capacity._tag === 'Unavailable'))
    return { label: 'Agent provider unavailable', tone: 'warning' }
  return { label: 'Healthy', tone: 'success' }
}

export function activeProviderCircuits(circuits: ProviderCircuit[]): ProviderCircuit[] {
  return circuits.filter(circuit => circuit.state._tag !== 'Closed')
}

/** One label per Agent role. The Record makes a missing role a type error, not a fallthrough. */
const workLabels: Record<AgentRole, string> = {
  adversarial_review: 'Review',
  pull_request_triage: 'Pull request triage',
  review_fix: 'Repair',
  conflict_resolution: 'Conflict resolution',
  baseline_repair: 'Baseline repair',
  issue_triage: 'Issue triage',
  issue_work: 'Issue work',
  batch_plan: 'Batch planning',
  routine_scan: 'Routine scan',
  routine_fix: 'Routine fix',
}

export const agentRoleLabels: Array<[AgentRole, string]> = Object.entries(workLabels) as Array<[AgentRole, string]>

export function workLabel(work: AgentRole): string {
  return workLabels[work]
}

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

function latestAgentReportAt(agent: ActiveAgent): string {
  const latestActivity = agent.activity[agent.activity.length - 1]
  if (latestActivity === undefined)
    return agent.updatedAt

  return new Date(latestActivity.at).getTime() > new Date(agent.updatedAt).getTime()
    ? latestActivity.at
    : agent.updatedAt
}

export function isProgressStalled(agent: ActiveAgent, now: Date): boolean {
  return secondsSince(latestAgentReportAt(agent), now) > stalledProgressSeconds
}

export function stalledLabel(agent: ActiveAgent, now: Date): string {
  return `No progress for ${Math.floor(secondsSince(latestAgentReportAt(agent), now) / 60)}m`
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

export function activeAgentProgress(agent: ActiveAgent): string {
  if (agent.state._tag === 'Publishing')
    return 'Fix verified. Waiting to push the commit.'
  return agent.progress.label
}

export interface AgentActivityPresentation {
  at: string
  text: string
  tone: 'muted' | 'error'
}

function conciseActivityText(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length <= 72 ? text : `${text.slice(0, 71).trimEnd()}…`
}

/** Describes the newest structured event without pretending to know completion. */
export function activeAgentActivity(agent: ActiveAgent): AgentActivityPresentation | undefined {
  const activity = agent.activity[agent.activity.length - 1]
  if (activity === undefined)
    return undefined

  if (activity._tag === 'Command') {
    const command = conciseActivityText(activity.command) || 'command'
    if (activity.exitCode === null)
      return { at: activity.at, text: `Running ${command}`, tone: 'muted' }
    if (activity.exitCode === 0)
      return { at: activity.at, text: `Ran ${command}`, tone: 'muted' }
    return { at: activity.at, text: `Command failed: ${command}`, tone: 'error' }
  }

  if (activity._tag === 'FileChange') {
    const paths = activity.changes.map(change => change.path)
    const text = paths.length === 1 ? `Edited ${paths[0]}` : `Edited ${paths.length} files`
    return { at: activity.at, text: conciseActivityText(text), tone: 'muted' }
  }

  /* Percent never shows. The board reports phase and elapsed, not a progress number. */
  if (activity._tag === 'Progress') {
    return {
      at: activity.at,
      text: conciseActivityText(activity.text) || 'Working',
      tone: 'muted',
    }
  }

  return {
    at: activity.at,
    text: conciseActivityText(activity.text) || 'Planning the next step',
    tone: 'muted',
  }
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

function queueContextOf(snapshot: DashboardSnapshot): QueueContext {
  return {
    agentStart: agentStartState(snapshot),
    openPullRequests: snapshot.openPullRequests,
    maxOpenPullRequests: snapshot.maxOpenPullRequests,
    selectionMode: snapshot.selectionMode,
  }
}

/** Why queued work cannot start right now, in one sentence. Absent while it can. */
function startBlockedLine(snapshot: DashboardSnapshot): string | undefined {
  switch (agentStartState(snapshot)._tag) {
    case 'Available': return undefined
    case 'Paused': return 'Paused. Nothing starts until you select Resume.'
    case 'RestartRequested': return 'A Restart request is finishing active work.'
    case 'WritesDisabled': return 'GitHub writes are off, so no agent will start.'
    case 'ReserveReached': return 'Every automatic Agent provider reached its Reserve.'
    case 'CapacityUnavailable': return 'Agent provider limits could not load. The controller will retry.'
  }
}

function throttledLine(snapshot: DashboardSnapshot): string {
  return `Issue work stops above ${snapshot.maxOpenPullRequests} open pull requests, and ${snapshot.openPullRequests} are open.`
}

export type BoardColumn = 'needsYou' | 'upNext' | 'running' | 'done'

/**
 * What an empty column says, and whether it carries a control.
 *
 * `Paused` is the one cause the reader can clear from the board, so it is the
 * one variant that renders a Resume button beside the line.
 */
export type ColumnEmptyReason
  = | { _tag: 'Plain', text: string }
    | { _tag: 'Paused', text: string }

export function columnEmptyReason(column: BoardColumn, snapshot: DashboardSnapshot): ColumnEmptyReason {
  switch (column) {
    case 'needsYou': return { _tag: 'Plain', text: 'Nothing needs you.' }
    case 'running': return { _tag: 'Plain', text: 'No agent is running.' }
    case 'done': return { _tag: 'Plain', text: 'Nothing has finished yet.' }
    case 'upNext': {
      const start = agentStartState(snapshot)
      if (start._tag === 'Paused')
        return { _tag: 'Paused', text: 'Paused. Nothing will start.' }
      const blocked = startBlockedLine(snapshot)
      if (blocked !== undefined)
        return { _tag: 'Plain', text: blocked }
      if (snapshot.selectionMode === 'manual' && decisionEntries(snapshot.queue).length > 0)
        return { _tag: 'Plain', text: 'Manual selection. Approve a pull request to queue it.' }
      return { _tag: 'Plain', text: 'Nothing queued.' }
    }
  }
}

export interface CardStateLine {
  text: string
  tone: 'muted' | 'warning' | 'error'
}

/**
 * The one state line on a Queue card: why it needs you, why it waits, or what
 * it is about to do. Present tense, one sentence, names the reason.
 */
export function cardStateLine(entry: QueueEntry, snapshot: DashboardSnapshot, now: Date): CardStateLine {
  switch (entry.state._tag) {
    case 'AwaitingApproval':
      if (entry.state.kind === 'issue_work')
        return { text: 'Outside contributor. Approval starts Issue work.', tone: 'warning' }
      return snapshot.selectionMode === 'manual'
        ? { text: 'Manual selection. Approval starts Review.', tone: 'warning' }
        : { text: 'Outside contributor. Approval starts Review.', tone: 'warning' }
    case 'ActionRequired':
      return { text: entry.state.reason, tone: 'error' }
    case 'Pending':
      return { text: entry.state.reason, tone: 'muted' }
    case 'Queued': {
      if (isIssueWorkThrottled(entry, queueContextOf(snapshot)))
        return { text: throttledLine(snapshot), tone: 'muted' }
      const blocked = startBlockedLine(snapshot)
      if (blocked !== undefined)
        return { text: blocked, tone: 'muted' }
      return { text: 'Starts when an agent is free.', tone: 'muted' }
    }
    case 'Active': {
      const seconds = Math.floor(secondsSince(entry.updatedAt, now))
      if (seconds > stalledProgressSeconds)
        return { text: `Starting for ${Math.floor(seconds / 60)}m with nothing reported.`, tone: 'warning' }
      return { text: 'Starting.', tone: 'muted' }
    }
  }
}

/**
 * The phase text beside a Running card's chip, or nothing when the phase only
 * repeats the chip. "Repair" next to a Repair chip says nothing twice.
 */
export function runningPhaseLine(agent: ActiveAgent): string | undefined {
  const text = activeAgentProgress(agent)
  const normalized = text.trim().toLowerCase()
  if (normalized.length === 0 || normalized === workChip(agent.role).label.toLowerCase() || normalized === workLabel(agent.role).toLowerCase())
    return undefined
  return text
}

/** The one primary action a Needs you card can carry. Absent when the card only reports. */
export function approvalActionLabel(entry: QueueEntry): 'Review and repair' | 'Approve' | undefined {
  if (entry.state._tag !== 'AwaitingApproval')
    return undefined
  return entry.state.kind === 'issue_work' ? 'Approve' : 'Review and repair'
}

/** Consequence first, in one sentence, as the Dismiss modal states it. */
export function dismissConsequence(kind: 'issue' | 'pull_request'): string {
  return kind === 'issue'
    ? 'This issue will never run again, and any running work on it stops now.'
    : 'This pull request will never run again, and any running work on it stops now.'
}

export function cancelConsequence(work: AgentRole | undefined): string {
  return work === undefined ? 'This task stops now.' : `${workLabel(work)} stops now.`
}

/** What follows the start the state line already named, which the button label alone cannot say. */
export function approvalConsequence(entry: QueueEntry): string {
  if (entry.state._tag !== 'AwaitingApproval')
    return ''
  return entry.state.kind === 'issue_work'
    ? 'The agent implements the change, then the controller opens a draft pull request.'
    : 'The controller may then push verified repair commits to this branch.'
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

const reviewGateNames = ['merge', 'review', 'ci'] as const

function reviewGateLabel(gate: typeof reviewGateNames[number]): string {
  return gate === 'ci' ? 'CI' : `${gate.charAt(0).toUpperCase()}${gate.slice(1)}`
}

function sentence(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`
}

/** Explains a Review outcome without making Review findings read as agent failure. */
export function reviewOutcomeDetail(agent: ReviewAgent): string {
  if (agent.outcome._tag === 'Ready')
    return 'No issues found.'

  const openFindings = agent.findings.filter(finding => finding._tag === 'Open')
  if (openFindings.length > 0) {
    const count = `${openFindings.length} issue${openFindings.length === 1 ? '' : 's'} found.`
    if (openFindings.some(finding => finding.resolution === 'Dismissal'))
      return `${count} Dismissal recommended.`
    return count
  }

  const unsettledName = reviewGateNames.find(name => agent.gates[name]._tag !== 'Passed')
  if (unsettledName === undefined)
    return 'The Review outcome has no recorded explanation.'
  const gate = agent.gates[unsettledName]
  if (gate._tag === 'Passed')
    return 'The Review outcome has no recorded explanation.'
  return `${reviewGateLabel(unsettledName)} Review gate ${gate._tag.toLowerCase()}. ${sentence(gate.reason)}`
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
  subject_changed: 'Head commit moved',
  unknown: 'Unclassified',
}

/**
 * `subject_changed` means the GitHub state moved under the work. The GLOSSARY
 * never names an Item, so the label says which state: an issue changed, or a
 * pull request's head commit moved. The operation is the only hint of which.
 */
export function incidentKindLabel(incident: Incident): string {
  if (incident.kind === 'subject_changed' && /issue/i.test(incident.operation))
    return 'Issue changed'
  return incidentKindLabels[incident.kind] ?? incident.kind
}

export function incidentTone(incident: Incident): StatusTone {
  return incident.severity === 'error' ? 'error' : 'warning'
}

/** Says what the controller will do next, so the pane answers "do I act on this?". */
export function incidentRecoveryLabel(incident: Incident): string {
  if (incident.recovery._tag === 'Retrying')
    return incident.recovery.attempt > 0 ? `Retrying · retry ${incident.recovery.attempt}` : 'Retrying'
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
  if (task.state._tag === 'Completed')
    return task.state.evidence
  if (task.state._tag === 'Failed' || task.state._tag === 'Superseded')
    return task.state.reason
  return undefined
}

export type HistoryCategory = 'ready' | 'issues' | 'pending' | 'failed' | 'superseded'

export function taskHistoryCategory(task: AgentTask): HistoryCategory {
  if (task.state._tag === 'Completed')
    return 'ready'
  if (task.state._tag === 'Failed')
    return 'failed'
  if (task.state._tag === 'Superseded')
    return 'superseded'
  return 'pending'
}

/** The last durable phase helps explain where a terminal Task stopped. */
export function taskProgressDetail(task: DashboardTask): string | undefined {
  if (task.progress.percent === 0 || task.progress.label === 'Starting')
    return undefined
  return `Last phase: ${task.progress.label}`
}

export type HistoryRecord
  = | { _tag: 'Review', key: string, at: string, agent: ReviewAgent }
    | { _tag: 'Task', key: string, at: string, task: DashboardTask }
    | { _tag: 'Routine', key: string, at: string, run: DashboardRoutineRun }

export function historyCategory(record: HistoryRecord): HistoryCategory {
  if (record._tag === 'Task')
    return taskHistoryCategory(record.task)
  if (record._tag === 'Routine') {
    if (record.run.state._tag === 'Completed')
      return 'ready'
    if (record.run.state._tag === 'Failed')
      return 'failed'
    if (record.run.state._tag === 'Superseded')
      return 'superseded'
    return 'pending'
  }
  if (record.agent.outcome._tag === 'Ready')
    return 'ready'
  return record.agent.outcome._tag === 'Blocked' ? 'issues' : 'pending'
}

export function historyOutcomeDetail(record: HistoryRecord): string | undefined {
  if (record._tag === 'Review')
    return reviewOutcomeDetail(record.agent)
  if (record._tag === 'Routine')
    return routineRunPresentation(record.run).detail
  if (record.task.state._tag === 'Completed')
    return 'Completed successfully.'
  return taskStateDetail(record.task)
}

/**
 * Everything that already finished, newest first. Reviews carry their own evidence.
 * Terminal tasks cover the work that produces no review, which would otherwise
 * finish and vanish without ever being recorded on screen.
 */
export function buildHistory(reviewAgents: ReviewAgent[], tasks: DashboardTask[], routineRuns: DashboardRoutineRun[] = []): HistoryRecord[] {
  const reviewed = new Set(reviewAgents.map(agent => `${agent.repository}#${agent.pullRequestNumber}@${agent.revisionId}`))
  const reviews = reviewAgents.map((agent): HistoryRecord => ({ _tag: 'Review', key: agent.id, at: agent.completedAt, agent }))
  const settled = tasks
    .filter(task => terminalTaskStates.has(task.state._tag))
    .filter(task => !(task.kind === 'adversarial_review' && reviewed.has(`${task.repository}#${taskNumber(task)}@${task.revisionId}`)))
    .map((task): HistoryRecord => ({ _tag: 'Task', key: task.id, at: task.updatedAt, task }))
  const routines = routineRuns
    .filter(run => run.state._tag !== 'Queued' && run.state._tag !== 'Running')
    .map((run): HistoryRecord => ({ _tag: 'Routine', key: run.id, at: run.updatedAt, run }))
  return [...reviews, ...settled, ...routines].sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime())
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
  adversarial_review: { label: 'Review', icon: 'i-octicon-code-review-16' },
  pull_request_triage: { label: 'Pull request triage', icon: 'i-octicon-checklist-16' },
  review_fix: { label: 'Repair', icon: 'i-octicon-tools-16' },
  conflict_resolution: { label: 'Conflict resolution', icon: 'i-octicon-git-merge-16' },
  baseline_repair: { label: 'Baseline', icon: 'i-octicon-pulse-16' },
  issue_triage: { label: 'Triage', icon: 'i-octicon-inbox-16' },
  issue_work: { label: 'Issue work', icon: 'i-octicon-code-16' },
  batch_plan: { label: 'Batch planning', icon: 'i-octicon-stack-16' },
  routine_scan: { label: 'Routine scan', icon: 'i-octicon-telescope-16' },
  routine_fix: { label: 'Routine fix', icon: 'i-octicon-workflow-16' },
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

/**
 * One card on the board. The variant is the column, decided once from state,
 * so an entry can never render in two places or in none.
 */
export type BoardCard
  = | { _tag: 'NeedsYou', key: string, entry: QueueEntry }
    | { _tag: 'Queued', key: string, entry: QueueEntry }
    | { _tag: 'Waiting', key: string, entry: QueueEntry }
    | { _tag: 'Running', key: string, agent: ActiveAgent }
    | { _tag: 'Starting', key: string, entry: QueueEntry }
    | { _tag: 'Done', key: string, record: HistoryRecord }

export interface BoardColumns {
  needsYou: BoardCard[]
  queued: BoardCard[]
  waiting: BoardCard[]
  running: BoardCard[]
  done: BoardCard[]
  /** Everything finished, including the records past the Done cut. */
  doneTotal: number
}

/** Done holds eight. The ninth is a link to History. */
export const doneOnBoard = 8

function entryKey(entry: QueueEntry): string {
  return `${entry.repository}#${entry.number}:${entry.state._tag}`
}

/** The work a card is for, or undefined for a condition that names none. */
export function boardCardWork(card: BoardCard): AgentRole | undefined {
  switch (card._tag) {
    case 'Running': return card.agent.role
    case 'Done': return card.record._tag === 'Review'
      ? 'adversarial_review'
      : card.record._tag === 'Task' ? taskWork(card.record.task) : 'routine_scan'
    default: return queueWork(card.entry)
  }
}

function finishedRecords(snapshot: DashboardSnapshot): HistoryRecord[] {
  const reviews = snapshot.agents.filter((agent): agent is ReviewAgent => agent._tag === 'ReviewAgent')
  return buildHistory(reviews, snapshot.tasks).filter(record => historyCategory(record) !== 'superseded')
}

/**
 * Every card, placed. Throttled issue work waits, because a free agent cannot
 * start it. Active work with no agent session yet lands in Running as Starting.
 */
export function boardColumns(snapshot: DashboardSnapshot, filter: AgentRole | 'all' = 'all'): BoardColumns {
  const context = queueContextOf(snapshot)
  const activeAgents = snapshot.agents.filter((agent): agent is ActiveAgent => agent._tag === 'ActiveAgent')
  const keep = (card: BoardCard): boolean => filter === 'all' || boardCardWork(card) === filter
  const queued = queuedEntries(snapshot.queue)
  const finished = finishedRecords(snapshot)
  const done = finished.map((record): BoardCard => ({ _tag: 'Done', key: record.key, record })).filter(keep)
  return {
    needsYou: decisionEntries(snapshot.queue).map((entry): BoardCard => ({ _tag: 'NeedsYou', key: entryKey(entry), entry })).filter(keep),
    queued: queued
      .filter(entry => !isIssueWorkThrottled(entry, context))
      .map((entry): BoardCard => ({ _tag: 'Queued', key: entryKey(entry), entry }))
      .filter(keep),
    waiting: [
      ...queued.filter(entry => isIssueWorkThrottled(entry, context)),
      ...waitingEntries(snapshot.queue),
    ].map((entry): BoardCard => ({ _tag: 'Waiting', key: entryKey(entry), entry })).filter(keep),
    running: [
      ...activeAgents.map((agent): BoardCard => ({ _tag: 'Running', key: agent.id, agent })),
      ...activeEntries(snapshot.queue, activeAgents).map((entry): BoardCard => ({ _tag: 'Starting', key: entryKey(entry), entry })),
    ].filter(keep),
    done: done.slice(0, doneOnBoard),
    doneTotal: done.length,
  }
}

/** The kinds of work on the board right now, in chip order. The filter hides until two exist. */
export function presentWorkKinds(columns: BoardColumns): Array<[AgentRole, WorkChip]> {
  const present = new Set<AgentRole>()
  const collect = (cards: BoardCard[]): void => cards.forEach((card) => {
    const work = boardCardWork(card)
    if (work !== undefined)
      present.add(work)
  })
  collect(columns.needsYou)
  collect(columns.queued)
  collect(columns.waiting)
  collect(columns.running)
  collect(columns.done)
  return workChipEntries.filter(([role]) => present.has(role))
}

export type CardAction = 'open' | 'rerun' | 'cancel' | 'dismiss'

export interface CardActionContext {
  /** The controller would accept a review run now. */
  canRunReview: boolean
  /** A live Task exists for this card, which is what Cancel acts on. */
  hasTask: boolean
}

/**
 * What the overflow menu offers, in menu order. Dismiss is always last.
 * Done cards only open, because their record is history and not an Item to act on.
 */
export function cardActions(card: BoardCard, context: CardActionContext): CardAction[] {
  if (card._tag === 'Done')
    return ['open']
  const actions: CardAction[] = ['open']
  if (card._tag !== 'Running' && context.canRunReview)
    actions.push('rerun')
  if (context.hasTask)
    actions.push('cancel')
  actions.push('dismiss')
  return actions
}

export interface CardIdentity {
  author: string
  title: string
  url: string
  repository: string
  kind: 'issue' | 'pull_request'
  number: number
}

/**
 * Who opened it and what it is, for any card.
 *
 * A finished Task record carries no title or author of its own, so it borrows
 * them from the open Item when the snapshot still holds one. Absent otherwise,
 * and the card falls back to a bare repository and number.
 */
export function boardCardIdentity(card: BoardCard, snapshot: DashboardSnapshot): CardIdentity | undefined {
  if (card._tag === 'Running') {
    const { agent } = card
    return { author: agent.author, title: agent.title, url: agent.subjectUrl, repository: agent.repository, kind: agent.subjectKind, number: agent.itemNumber }
  }
  if (card._tag !== 'Done') {
    const { entry } = card
    return { author: entry.author, title: entry.title, url: entry.subjectUrl, repository: entry.repository, kind: entry.kind, number: entry.number }
  }
  if (card.record._tag === 'Review') {
    const { agent } = card.record
    return { author: agent.author, title: agent.title, url: agent.subjectUrl, repository: agent.repository, kind: 'pull_request', number: agent.pullRequestNumber }
  }
  if (card.record._tag === 'Routine')
    return undefined
  const { task } = card.record
  const number = taskNumber(task)
  const item = snapshot.items.find(candidate => candidate.repository === task.repository && candidate.number === number)
  if (item === undefined)
    return undefined
  return { author: item.author, title: item.title, url: item.url, repository: task.repository, kind: item.kind, number }
}

export interface CardBadge {
  label: string
  tone: 'success' | 'warning' | 'error' | 'neutral'
  confidence?: number | undefined
  uppercase: boolean
}

/** The one state or outcome badge a card carries in its slideover, and on its face when Done. */
export function boardCardBadge(card: BoardCard): CardBadge {
  switch (card._tag) {
    case 'NeedsYou': return card.entry.state._tag === 'ActionRequired'
      ? { label: 'Action required', tone: 'error', uppercase: false }
      : { label: 'Approval required', tone: 'warning', uppercase: false }
    case 'Queued': return { label: 'Queued', tone: 'neutral', uppercase: false }
    case 'Waiting': return { label: 'Waiting', tone: 'neutral', uppercase: false }
    case 'Running': return { label: 'Running', tone: 'success', uppercase: false }
    case 'Starting': return { label: 'Starting', tone: 'neutral', uppercase: false }
    case 'Done':
      if (card.record._tag === 'Review') {
        const { agent } = card.record
        return {
          label: agent.outcome._tag.toUpperCase(),
          tone: reviewOutcomeTone(agent),
          confidence: agent.outcome._tag === 'Ready' ? agent.outcome.confidence : undefined,
          uppercase: true,
        }
      }
      if (card.record._tag === 'Routine') {
        const presentation = routineRunPresentation(card.record.run)
        return { label: presentation.label, tone: presentation.tone === 'primary' ? 'neutral' : presentation.tone, uppercase: false }
      }
      return { label: card.record.task.state._tag, tone: taskStateTone(card.record.task), uppercase: false }
  }
}
