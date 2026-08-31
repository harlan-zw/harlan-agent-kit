import type { AgentPermitPool } from './agent-permit-pool.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { ClaimedBaselineRepairTask, ClaimedConflictResolutionTask, ClaimedIssueWorkTask, ClaimedReviewFixTask, MutationWorkerOutcome } from './types.ts'
import { err } from './result.ts'

export interface TaskScheduler {
  runNow: () => Promise<void>
  settle: (taskId: string) => Promise<boolean>
  start: () => void
  stop: () => Promise<void>
}

type PublicationTask = ClaimedConflictResolutionTask | ClaimedReviewFixTask | ClaimedBaselineRepairTask | ClaimedIssueWorkTask

interface PublicationWorker<Task extends PublicationTask> {
  run: (task: Task, signal: AbortSignal) => Promise<Result<MutationWorkerOutcome, string>>
}

export interface TaskSchedulerOptions<Task extends PublicationTask = ClaimedConflictResolutionTask> {
  canClaim?: () => boolean
  claim?: (workerId: string, now: string, leaseMilliseconds: number) => Task | null
  intervalMilliseconds: number
  leaseMilliseconds: number
  now: () => Date
  onError: (error: unknown) => void
  /**
   * Called once the scheduler owns the lease, before the agent runs.
   *
   * The Running label is written from here, so every Task kind gets it from one
   * place instead of six workers each remembering to.
   */
  onTaskStarted?: (task: Task) => void
  /** Called once the worker stops running a task, whatever the outcome. */
  onTaskSettled?: (taskId: string, task: Task) => void
  permits: AgentPermitPool
  store: Pick<JournalStore, 'claimNextConflictTask' | 'failTask' | 'heartbeatTask' | 'needsAttentionTask' | 'stagePublication' | 'supersedeTask'>
  worker: PublicationWorker<Task>
  workerId: string
}

export function createTaskScheduler<Task extends PublicationTask = ClaimedConflictResolutionTask>(options: TaskSchedulerOptions<Task>): TaskScheduler {
  let stopped = true
  let timer: NodeJS.Timeout | undefined
  let controller: AbortController | undefined
  let activeTaskId: string | undefined
  let active: Promise<void> = Promise.resolve()

  async function execute(): Promise<void> {
    let settled: Task | undefined
    if (options.canClaim?.() === false)
      return
    const permit = options.permits.tryAcquire()
    if (permit === null)
      return
    try {
      const claim = options.claim ?? options.store.claimNextConflictTask
      const task = claim(options.workerId, options.now().toISOString(), options.leaseMilliseconds) as Task | null
      if (task === null)
        return
      settled = task
      controller = new AbortController()
      const executionController = controller
      activeTaskId = task.id
      options.onTaskStarted?.(task)
      const heartbeat = setInterval(() => {
        const renewed = options.store.heartbeatTask({
          taskId: task.id,
          workerId: options.workerId,
          fence: task.state.fence,
          at: options.now().toISOString(),
          leaseMilliseconds: options.leaseMilliseconds,
        })
        if (!renewed)
          executionController.abort()
      }, Math.min(5_000, Math.max(1_000, Math.floor(options.leaseMilliseconds / 3))))
      heartbeat.unref()

      const result = await options.worker.run(task, executionController.signal)
        .catch((error: unknown) => {
          if (!executionController.signal.aborted)
            options.onError(error)
          return err(error instanceof Error ? error.message : 'The agent failed unexpectedly.')
        })
        .finally(() => clearInterval(heartbeat))
      if (executionController.signal.aborted)
        return
      if (result._tag === 'Ok') {
        if (result.value._tag === 'Superseded') {
          options.store.supersedeTask({
            taskId: task.id,
            workerId: options.workerId,
            fence: task.state.fence,
            at: options.now().toISOString(),
            reason: result.value.reason,
            ...(result.value.usage === undefined ? {} : { usage: result.value.usage }),
          })
          return
        }
        if (result.value._tag === 'ActionRequired') {
          options.store.needsAttentionTask({
            taskId: task.id,
            workerId: options.workerId,
            fence: task.state.fence,
            at: options.now().toISOString(),
            reason: result.value.reason,
            evidence: result.value.evidence,
            ...(result.value.usage === undefined ? {} : { usage: result.value.usage }),
          })
          return
        }
        const staged = options.store.stagePublication({
          taskId: task.id,
          workerId: options.workerId,
          fence: task.state.fence,
          at: options.now().toISOString(),
          publication: result.value.publication,
          ...(result.value.usage === undefined ? {} : { usage: result.value.usage }),
        })
        if (staged._tag !== 'Rejected')
          return
        options.store.failTask({
          taskId: task.id,
          workerId: options.workerId,
          fence: task.state.fence,
          at: options.now().toISOString(),
          reason: staged.reason,
        })
        return
      }
      options.store.failTask({
        taskId: task.id,
        workerId: options.workerId,
        fence: task.state.fence,
        at: options.now().toISOString(),
        reason: result.error,
      })
    }
    finally {
      if (settled !== undefined && activeTaskId === settled.id)
        activeTaskId = undefined
      permit.release()
      if (settled !== undefined)
        options.onTaskSettled?.(settled.id, settled)
    }
  }

  function runNow(): Promise<void> {
    active = active.then(execute).catch(options.onError)
    return active
  }

  function schedule(): void {
    if (stopped)
      return
    timer = setTimeout(() => void runNow().finally(schedule), options.intervalMilliseconds)
    timer.unref()
  }

  function start(): void {
    if (!stopped)
      return
    stopped = false
    void runNow().finally(schedule)
  }

  async function settle(taskId: string): Promise<boolean> {
    if (activeTaskId !== taskId)
      return false
    controller?.abort()
    await active
    return true
  }

  async function stop(): Promise<void> {
    stopped = true
    if (timer !== undefined)
      clearTimeout(timer)
    controller?.abort()
    await active
  }

  return { runNow, settle, start, stop }
}
