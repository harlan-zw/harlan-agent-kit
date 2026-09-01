import type { JournalStore } from './store.ts'
import type { RestartRequest } from './types.ts'

const DEFAULT_INTERVAL_MILLISECONDS = 2_000
const DEFAULT_MAXIMUM_WAIT_MILLISECONDS = 50 * 60_000

type RestartStore = Pick<JournalStore, 'beginRestart' | 'getRestartRequest' | 'prepareForRestart' | 'requireRestartAction'>

export interface RestartController {
  start: () => void
  stop: () => void
  waitForRestart: () => Promise<void>
}

export function restartAllowsTaskClaims(request: RestartRequest | null): boolean {
  return request?._tag !== 'Requested' && request?._tag !== 'Restarting'
}

export function createRestartController(options: {
  store: RestartStore
  processId: string
  now: () => Date
  onActionRequired: (reason: string) => void
  intervalMilliseconds?: number
  maximumWaitMilliseconds?: number
}): RestartController {
  const intervalMilliseconds = options.intervalMilliseconds ?? DEFAULT_INTERVAL_MILLISECONDS
  const maximumWaitMilliseconds = options.maximumWaitMilliseconds ?? DEFAULT_MAXIMUM_WAIT_MILLISECONDS
  let interval: ReturnType<typeof setInterval> | undefined
  let resolveRestart: (() => void) | undefined
  const restart = new Promise<void>((resolve) => {
    resolveRestart = resolve
  })

  const check = (): void => {
    const request = options.store.getRestartRequest()
    if (request?._tag !== 'Requested')
      return

    const at = options.now().toISOString()
    if (Date.parse(at) - Date.parse(request.requestedAt) >= maximumWaitMilliseconds) {
      const minutes = Math.round(maximumWaitMilliseconds / 60_000)
      const reason = `Active work did not finish within ${minutes} minutes.`
      const required = options.store.requireRestartAction({ id: request.id, at, reason })
      if (required !== null)
        options.onActionRequired(reason)
      return
    }

    if (!options.store.prepareForRestart(at))
      return
    const restarting = options.store.beginRestart({ id: request.id, processId: options.processId, at })
    if (restarting?._tag === 'Restarting')
      resolveRestart?.()
  }

  return {
    start: () => {
      if (interval !== undefined)
        return
      check()
      interval = setInterval(check, intervalMilliseconds)
      interval.unref()
    },
    stop: () => {
      if (interval === undefined)
        return
      clearInterval(interval)
      interval = undefined
    },
    waitForRestart: () => restart,
  }
}
