export interface Poller {
  start: () => void
  stop: () => Promise<void>
  runNow: () => Promise<void>
}

export interface PollerOptions {
  intervalMilliseconds: number
  maxIntervalMilliseconds?: number
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

  const runNow = (): Promise<void> => {
    controller = new AbortController()
    active = active
      .then(() => options.poll(controller?.signal ?? AbortSignal.abort()))
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
