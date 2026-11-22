import type { AgentTokenUsage } from './agent-provider.ts'
import type { JournalStore } from './store.ts'
import type { ClaimedRoutineRun, PinnedAgentSelection } from './types.ts'
import type { WorkerTaskScheduler, WorkerTaskSchedulerOptions } from './worker-task-scheduler.ts'
import { createAgentPermitPool } from './agent-permit-pool.ts'
import { createWorkerTaskScheduler } from './worker-task-scheduler.ts'

interface ScanResult { evidence: string, usage: AgentTokenUsage }

export interface RoutineTaskSchedulerOptions extends Omit<WorkerTaskSchedulerOptions<ClaimedRoutineRun, ScanResult>, 'claim'> {
  canStartAgent: (selection: PinnedAgentSelection | undefined, at: string) => boolean
  store: Pick<JournalStore, 'claimNextRoutineRun'>
}

export function createRoutineTaskScheduler(options: RoutineTaskSchedulerOptions): WorkerTaskScheduler {
  const agents = createWorkerTaskScheduler({
    ...options,
    claim: (workerId, at, leaseMilliseconds) => options.store.claimNextRoutineRun(workerId, at, leaseMilliseconds, (selection, name) => name !== 'ready-digest' && options.canStartAgent(selection, at)),
  })
  // Controller work keeps the lease lifecycle, without spending an Agent permit.
  const controller = createWorkerTaskScheduler({
    ...options,
    permits: createAgentPermitPool(1),
    claim: (workerId, at, leaseMilliseconds) => options.store.claimNextRoutineRun(workerId, at, leaseMilliseconds, (_selection, name) => name === 'ready-digest'),
  })
  return {
    runNow: async () => { await Promise.all([controller.runNow(), agents.runNow()]) },
    settle: async taskId => (await Promise.all([controller.settle(taskId), agents.settle(taskId)])).some(Boolean),
    start: () => {
      controller.start()
      agents.start()
    },
    stop: async () => { await Promise.all([controller.stop(), agents.stop()]) },
  }
}
