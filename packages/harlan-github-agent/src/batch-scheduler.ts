import type { AgentPermitPool } from './agent-permit-pool.ts'
import type { BatchWorker } from './batch-worker.ts'
import type { JournalStore } from './store.ts'

export interface BatchScheduler {
  runNow: () => Promise<void>
  start: () => void
  stop: () => Promise<void>
}

export interface BatchSchedulerOptions {
  canClaim: () => boolean
  intervalMilliseconds: number
  leaseMilliseconds: number
  now: () => Date
  onError: (error: unknown) => void
  /** One permit covers the whole Batch. Its units run as sub agents under that permit. */
  permits: AgentPermitPool
  store: Pick<JournalStore, 'claimNextBatch' | 'completeBatch' | 'failBatch' | 'heartbeatBatch'>
  worker: BatchWorker
  workerId: string
}

/**
 * Claims one Batch at a time and runs it under one Agent permit.
 *
 * A Batch holds its own lease, like a Routine run, because it owns no Item.
 * The heartbeat here keeps the Batch alive; each unit's Task keeps its own
 * lease inside the worker.
 */
export function createBatchScheduler(options: BatchSchedulerOptions): BatchScheduler {
  let stopped = true
  let timer: NodeJS.Timeout | undefined
  let controller: AbortController | undefined
  let active: Promise<void> = Promise.resolve()

  async function execute(): Promise<void> {
    if (!options.canClaim())
      return
    const permit = options.permits.tryAcquire()
    if (permit === null)
      return
    try {
      const batch = options.store.claimNextBatch(options.workerId, options.now().toISOString(), options.leaseMilliseconds)
      if (batch === null)
        return
      controller = new AbortController()
      const executionController = controller
      const heartbeat = setInterval(() => {
        const renewed = options.store.heartbeatBatch({
          batchId: batch.id,
          workerId: options.workerId,
          fence: batch.state.fence,
          at: options.now().toISOString(),
          leaseMilliseconds: options.leaseMilliseconds,
        })
        if (!renewed)
          executionController.abort()
      }, Math.min(5_000, Math.max(1_000, Math.floor(options.leaseMilliseconds / 3))))
      heartbeat.unref()
      const result = await options.worker.run(batch, executionController.signal)
        .catch((error: unknown) => {
          if (!executionController.signal.aborted)
            options.onError(error)
          return { _tag: 'Err' as const, error: error instanceof Error ? error.message : 'The Batch failed unexpectedly.' }
        })
        .finally(() => clearInterval(heartbeat))
      if (executionController.signal.aborted)
        return
      const fenced = { batchId: batch.id, workerId: options.workerId, fence: batch.state.fence, at: options.now().toISOString() }
      if (result._tag === 'Ok')
        options.store.completeBatch(fenced)
      else
        options.store.failBatch({ ...fenced, reason: result.error })
    }
    finally {
      permit.release()
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

  return {
    runNow,
    start() {
      if (!stopped)
        return
      stopped = false
      void runNow().finally(schedule)
    },
    async stop() {
      stopped = true
      if (timer !== undefined)
        clearTimeout(timer)
      controller?.abort()
      await active
    },
  }
}
