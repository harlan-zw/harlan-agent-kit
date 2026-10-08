import type { SessionHost } from '../../../src/session-protocol.ts'
import type { AgentActivityItem, DashboardSnapshot } from '../../../src/types.ts'

export interface AgentLog {
  id: string
  kind: 'Task' | 'Routine'
  repository: string
  title: string
  host: SessionHost | null
  startedAt: string
  phase: string
  activity: AgentActivityItem[]
}

export type AgentLogSelection
  = | { _tag: 'Unselected' }
    | { _tag: 'Loading' }
    | { _tag: 'Unavailable', id: string }
    | { _tag: 'Live', log: AgentLog }
    | { _tag: 'Retained', log: AgentLog }

/** Runtime assignments own the host. A native conversation ID cannot identify it. */
export function agentLogs(snapshot: DashboardSnapshot): AgentLog[] {
  const assignments = new Map(snapshot.hostTasks?.map(task => [task.taskId, task.host]))
  const logs: AgentLog[] = []
  for (const agent of snapshot.agents) {
    if (agent._tag !== 'ActiveAgent')
      continue
    logs.push({ id: agent.id, kind: 'Task', repository: agent.repository, title: `${agent.repository}#${agent.itemNumber}: ${agent.title}`, host: assignments.get(agent.id) ?? null, startedAt: agent.startedAt, phase: agent.progress.label, activity: agent.activity })
  }
  for (const run of snapshot.routineRuns) {
    if (run.state._tag !== 'Running')
      continue
    logs.push({ id: run.id, kind: 'Routine', repository: run.repository, title: `${run.repository}: ${run.name}`, host: assignments.get(run.id) ?? null, startedAt: run.createdAt, phase: run.progress.label, activity: run.activity })
  }
  return logs.sort((left, right) => right.startedAt.localeCompare(left.startedAt) || left.id.localeCompare(right.id))
}

/** Preserve only the selected view. Ended activity never becomes a new Agent session. */
export function selectAgentLog(snapshot: DashboardSnapshot, id?: string, previous?: AgentLogSelection): AgentLogSelection {
  if (id === undefined)
    return { _tag: 'Unselected' }
  if (snapshot.generatedAt === '')
    return { _tag: 'Loading' }
  const log = agentLogs(snapshot).find(log => log.id === id)
  if (log !== undefined)
    return { _tag: 'Live', log }
  if ((previous?._tag === 'Live' || previous?._tag === 'Retained') && previous.log.id === id)
    return { _tag: 'Retained', log: previous.log }
  return { _tag: 'Unavailable', id }
}
