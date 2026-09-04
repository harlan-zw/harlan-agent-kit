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

export type PublicationTask = ClaimedConflictResolutionTask | ClaimedReviewFixTask | ClaimedBaselineRepairTask | ClaimedIssueWorkTask

export interface PublicationWorker<Task extends PublicationTask> {
  run: (task: Task, signal: AbortSignal) => Promise<Result<MutationWorkerOutcome, string>>
}

export type ClaimedTaskStore = Pick<JournalStore, 'completeTask' | 'failTask' | 'heartbeatTask' | 'needsAttentionTask' | 'stagePublication' | 'supersedeTask'>

export interface ClaimedTaskRunOptions<Task extends PublicationTask> {
  leaseMilliseconds: number
  now: () => Date
  onError: (error: unknown) => void
  /** A parent signal, when the caller's own lease bounds this Task as well. */
  signal?: AbortSignal
  store: ClaimedTaskStore
  worker: PublicationWorker<Task>
  workerId: string
}

/** How one claimed Task ended in the journal, so a caller can act on it without reading the store again. */
export type ClaimedTaskResult
  = | { _tag: 'Aborted' }
    | { _tag: 'Superseded' }
    | { _tag: 'Completed' }
    | { _tag: 'ActionRequired', reason: string }
    | { _tag: 'Publishing' }
    | { _tag: 'Failed', reason: string }

/**
 * Runs one Task the caller already holds a lease on: heartbeats it, runs the
 * worker, and writes the outcome under the fence.
 *
 * The scheduler and a Batch both run Tasks this way. A Batch holds several
 * leases at once under one Agent permit, so the lease handling lives here
 * rather than inside the one-Task-at-a-time scheduler.
 */
export async function runClaimedTask<Task extends PublicationTask>(task: Task, options: ClaimedTaskRunOptions<Task>): Promise<ClaimedTaskResult> {
  const executionController = new AbortController()
  const onParentAbort = (): void => executionController.abort()
  options.signal?.addEventListener('abort', onParentAbort, { once: true })
  if (options.signal?.aborted)
    executionController.abort()
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

  try {
    const result = await options.worker.run(task, executionController.signal)
      .catch((error: unknown) => {
        if (!executionController.signal.aborted)
          options.onError(error)
        return err(error instanceof Error ? error.message : 'The agent failed unexpectedly.')
      })
      .finally(() => clearInterval(heartbeat))
    if (executionController.signal.aborted)
      return { _tag: 'Aborted' }
    const at = options.now().toISOString()
    const fenced = { taskId: task.id, workerId: options.workerId, fence: task.state.fence, at }
    if (result._tag === 'Err') {
      options.store.failTask({ ...fenced, reason: result.error })
      return { _tag: 'Failed', reason: result.error }
    }
    const outcome = result.value
    const usage = outcome.usage === undefined ? {} : { usage: outcome.usage }
    if (outcome._tag === 'Superseded') {
      options.store.supersedeTask({ ...fenced, reason: outcome.reason, ...usage })
      return { _tag: 'Superseded' }
    }
    if (outcome._tag === 'Completed') {
      options.store.completeTask({ ...fenced, evidence: outcome.evidence })
      return { _tag: 'Completed' }
    }
    if (outcome._tag === 'ActionRequired') {
      options.store.needsAttentionTask({ ...fenced, reason: outcome.reason, evidence: outcome.evidence, ...usage })
      return { _tag: 'ActionRequired', reason: outcome.reason }
    }
    const staged = options.store.stagePublication({ ...fenced, publication: outcome.publication, ...usage })
    if (staged._tag !== 'Rejected')
      return { _tag: 'Publishing' }
    options.store.failTask({ ...fenced, reason: staged.reason })
    return { _tag: 'Failed', reason: staged.reason }
  }
  finally {
    options.signal?.removeEventListener('abort', onParentAbort)
  }
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
  store: Pick<JournalStore, 'claimNextConflictTask' | 'completeTask' | 'failTask' | 'heartbeatTask' | 'needsAttentionTask' | 'stagePublication' | 'supersedeTask'>
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
      activeTaskId = task.id
      options.onTaskStarted?.(task)
      await runClaimedTask(task, {
        leaseMilliseconds: options.leaseMilliseconds,
        now: options.now,
        onError: options.onError,
        signal: controller.signal,
        store: options.store,
        worker: options.worker,
        workerId: options.workerId,
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
