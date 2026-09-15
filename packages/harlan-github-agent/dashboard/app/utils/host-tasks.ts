import type { DashboardSnapshot } from '../../../src/types.ts'
import { routineTrackingUrl } from './dashboard.ts'

/** Join live host assignments to Dashboard Items. A session from a past turn cannot assign a host. */
export function hostTasks(snapshot: DashboardSnapshot, host: 'hogwild' | 'desktop') {
  return (snapshot.hostTasks ?? []).filter(turn => turn.host === host).map((turn, index) => {
    const agent = snapshot.agents.find(agent => agent._tag === 'ActiveAgent' && agent.id === turn.taskId)
    if (agent?._tag === 'ActiveAgent') {
      return { id: `${turn.taskId}:${index}`, title: agent.title, detail: `${agent.repository} #${agent.itemNumber}`, url: agent.subjectUrl, progress: agent.progress.label }
    }
    const run = snapshot.routineRuns.find(run => run.id === turn.taskId)
    if (run !== undefined) {
      const routine = snapshot.routines.find(routine => routine.id === run.routineId)
      return { id: `${turn.taskId}:${index}`, title: run.name, detail: run.repository, url: routine === undefined ? null : routineTrackingUrl(routine) ?? null, progress: run.progress.label }
    }
    return { id: `${turn.taskId}:${index}`, title: 'Agent task', detail: '', url: null, progress: 'Running' }
  })
}
