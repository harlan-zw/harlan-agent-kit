export interface Poller {
  start: () => void
  stop: () => Promise<void>
  runNow: () => Promise<void>
}

export interface PollerOptions {
  intervalMilliseconds: number
  maxIntervalMilliseconds?: number
  /**
   * How long one pass may take before the poller abandons it.
   *
   * Passes run on one chained promise, so a request that never settles used to
   * stop the poller for the life of the process while it still looked healthy.
   */
  timeoutMilliseconds?: number
  poll: (signal: AbortSignal) => Promise<void>
  random?: () => number
  onError: (error: unknown) => void
}

export function createPoller(options: PollerOptions): Poller {
  let stopped = true
  let timer: NodeJS.Timeout | undefined
  let active: Promise<void> = Promise.resolve()
  let controller: AbortController | undefined
  let consecutiveFailures = 0
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 10 * 60_000

  /**
   * Resolves when the pass finishes or when it runs out of time.
   *
   * The abandoned pass is aborted and left to settle on its own. Waiting for it
   * would reintroduce the wedge this guard exists to prevent.
   */
  const withTimeout = (pass: Promise<void>, abort: () => void): Promise<void> => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      abort()
      reject(new Error(`One poll pass exceeded ${Math.round(timeoutMilliseconds / 1_000)} seconds and was abandoned.`))
    }, timeoutMilliseconds)
    timeout.unref()
    pass.then(resolve, reject).finally(() => clearTimeout(timeout))
  })

  const runNow = (): Promise<void> => {
    const passController = new AbortController()
    controller = passController
    active = active
      .then(() => withTimeout(
        options.poll(passController.signal),
        () => passController.abort(),
      ))
      .then(() => {
        consecutiveFailures = 0
      })
      .catch((error) => {
        consecutiveFailures += 1
        options.onError(error)
      })
    return active
  }

  const schedule = (): void => {
    if (stopped)
      return
    const baseDelay = Math.min(
      options.intervalMilliseconds * 2 ** Math.min(consecutiveFailures, 5),
      options.maxIntervalMilliseconds ?? 15 * 60_000,
    )
    const jitter = Math.floor(baseDelay * 0.2 * (options.random ?? Math.random)())
    timer = setTimeout(() => {
      void runNow().finally(schedule)
    }, baseDelay + jitter)
  }

  const start = (): void => {
    if (!stopped)
      return
    stopped = false
    void runNow().finally(schedule)
  }

  const stop = async (): Promise<void> => {
    stopped = true
    if (timer !== undefined)
      clearTimeout(timer)
    controller?.abort()
    await active
  }

  return { start, stop, runNow }
}
