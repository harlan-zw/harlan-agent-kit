import type { AgentPermitPool } from './agent-permit-pool.ts'
import type { Result } from './result.ts'
import type { ClaimedAgentTask } from './types.ts'
import { err } from './result.ts'

export interface ItemAgent<Task extends ClaimedAgentTask> {
  run: (task: Task, signal: AbortSignal) => Promise<Result<{ evidence: string }, string>>
}

export interface WorkerTaskScheduler {
  runNow: () => Promise<void>
  start: () => void
  stop: () => Promise<void>
}

export interface WorkerTaskSchedulerOptions<Task extends ClaimedAgentTask> {
  canClaim?: () => boolean
  claim: (workerId: string, now: string, leaseMilliseconds: number) => Task | null
  complete: (input: { taskId: string, workerId: string, fence: number, at: string, evidence: string }) => boolean
  fail: (input: { taskId: string, workerId: string, fence: number, at: string, reason: string }) => 'Retrying' | 'Failed' | 'Rejected'
  heartbeat: (input: { taskId: string, workerId: string, fence: number, at: string, leaseMilliseconds: number }) => boolean
  intervalMilliseconds: number
  leaseMilliseconds: number
  now: () => Date
  onError: (error: unknown) => void
  /** Called once the worker stops running a task, whatever the outcome. */
  onTaskSettled?: (taskId: string) => void
  permits: AgentPermitPool
  worker: ItemAgent<Task>
  workerId: string
}

export function createWorkerTaskScheduler<Task extends ClaimedAgentTask>(options: WorkerTaskSchedulerOptions<Task>): WorkerTaskScheduler {
  let stopped = true
  let timer: NodeJS.Timeout | undefined
  let controller: AbortController | undefined
  let active: Promise<void> = Promise.resolve()

  async function execute(): Promise<void> {
    let settledTaskId: string | undefined
    if (options.canClaim?.() === false)
      return
    const permit = options.permits.tryAcquire()
    if (permit === null)
      return
    try {
      const task = options.claim(options.workerId, options.now().toISOString(), options.leaseMilliseconds)
      if (task === null)
        return
      settledTaskId = task.id

      controller = new AbortController()
      const executionController = controller
      const heartbeat = setInterval(() => {
        const renewed = options.heartbeat({
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
        const completed = options.complete({
          taskId: task.id,
          workerId: options.workerId,
          fence: task.state.fence,
          at: options.now().toISOString(),
          evidence: result.value.evidence,
        })
        if (completed)
          return
        options.fail({
          taskId: task.id,
          workerId: options.workerId,
          fence: task.state.fence,
          at: options.now().toISOString(),
          reason: 'The Task lease changed before completion.',
        })
        return
      }
      options.fail({
        taskId: task.id,
        workerId: options.workerId,
        fence: task.state.fence,
        at: options.now().toISOString(),
        reason: result.error,
      })
    }
    finally {
      permit.release()
      if (settledTaskId !== undefined)
        options.onTaskSettled?.(settledTaskId)
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

  async function stop(): Promise<void> {
    stopped = true
    if (timer !== undefined)
      clearTimeout(timer)
    controller?.abort()
    await active
  }

  return { runNow, start, stop }
}
