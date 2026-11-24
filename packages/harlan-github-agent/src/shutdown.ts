/**
 * Names each part of a service stop.
 *
 * The stop runs most parts at once. Without names, a stop that ran past its
 * budget could only say that something was slow.
 */
export interface ShutdownStages {
  run: (name: string, stop: () => void | Promise<void>) => Promise<void>
}

export interface ShutdownStageTiming {
  name: string
  milliseconds: number
}

export type StopOutcome
  = | { _tag: 'Stopped', milliseconds: number, slowest: ShutdownStageTiming | null }
    /** `running` is empty when the stop waited outside every named stage. */
    | { _tag: 'Overran', milliseconds: number, running: ShutdownStageTiming[] }

export interface StopWithinOptions {
  timeoutMilliseconds: number
  now?: () => number
}

/** Runs the stop, and stops waiting when the budget ends. A failed stage rejects. */
export function stopWithin(stop: (stages: ShutdownStages) => Promise<void>, options: StopWithinOptions): Promise<StopOutcome> {
  const now = options.now ?? (() => performance.now())
  const startedAt = now()
  const running = new Map<number, { name: string, startedAt: number }>()
  const finished: ShutdownStageTiming[] = []
  let nextStage = 0
  const stages: ShutdownStages = {
    run: async (name, stopStage) => {
      const id = nextStage++
      const stageStartedAt = now()
      running.set(id, { name, startedAt: stageStartedAt })
      try {
        await stopStage()
      }
      finally {
        running.delete(id)
        finished.push({ name, milliseconds: now() - stageStartedAt })
      }
    },
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const at = now()
      resolve({
        _tag: 'Overran',
        milliseconds: at - startedAt,
        running: [...running.values()].map(stage => ({ name: stage.name, milliseconds: at - stage.startedAt })),
      })
    }, options.timeoutMilliseconds)
    stop(stages).then(() => {
      clearTimeout(timeout)
      const slowest = finished.reduce<ShutdownStageTiming | null>((current, stage) => current === null || stage.milliseconds > current.milliseconds ? stage : current, null)
      resolve({ _tag: 'Stopped', milliseconds: now() - startedAt, slowest })
    }, (error: unknown) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

const seconds = (milliseconds: number): string => `${(milliseconds / 1_000).toFixed(1)} s`

/** One log line for the outcome. An overrun names every stage that was still running. */
export function describeStopOutcome(outcome: StopOutcome): string {
  if (outcome._tag === 'Stopped') {
    return outcome.slowest === null
      ? `Shutdown finished in ${seconds(outcome.milliseconds)}.`
      : `Shutdown finished in ${seconds(outcome.milliseconds)}. Slowest stage: ${outcome.slowest.name} (${seconds(outcome.slowest.milliseconds)}).`
  }
  const running = outcome.running.length === 0
    ? 'No named stage was running.'
    : `Still running: ${outcome.running.map(stage => `${stage.name} (${seconds(stage.milliseconds)})`).join(', ')}.`
  return `Shutdown passed ${Math.round(outcome.milliseconds / 1_000)} seconds. ${running} The next start recovers unfinished work.`
}
