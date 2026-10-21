import type { RestartRequest, ServiceUpdateSchedule, ServiceUpdateStatus } from './types.ts'
import { randomUUID } from 'node:crypto'

const CHECK_INTERVAL_MILLISECONDS = 60_000
/**
 * The scheduled update only starts inside this window after its time. A
 * service that restarts at noon with an update available keeps waiting for the
 * next morning instead of restarting again straight away.
 */
const WINDOW_MINUTES = 60

/** One instant on the schedule's clock: its calendar day and minutes after midnight. */
function localClock(at: Date, timeZone: string): { day: string, minuteOfDay: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at).map(part => [part.type, part.value]))
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute) }
}

/** The commit the schedule installs now, or null when it waits. */
export function scheduledUpdateTarget(input: {
  now: Date
  schedule: ServiceUpdateSchedule
  status: ServiceUpdateStatus
  latestRequest: RestartRequest | null
}): string | null {
  if (input.status._tag !== 'Available')
    return null
  const clock = localClock(input.now, input.schedule.timeZone)
  const elapsed = clock.minuteOfDay - input.schedule.minuteOfDay
  if (elapsed < 0 || elapsed >= WINDOW_MINUTES)
    return null
  // An active request already owns the restart. One attempt per day: a
  // scheduled Update that failed waits for a person instead of retrying every
  // minute of the window.
  const request = input.latestRequest
  if (request !== null && (request._tag === 'Requested' || request._tag === 'Restarting'))
    return null
  if (request !== null && request.source === 'schedule' && localClock(new Date(request.requestedAt), input.schedule.timeZone).day === clock.day)
    return null
  return input.status.latestCommit
}

export interface ServiceUpdateScheduler {
  start: () => void
  stop: () => void
}

/** Requests one Update a day at the scheduled time, through the same Restart request as the dashboard. */
export function createServiceUpdateScheduler(options: {
  schedule: ServiceUpdateSchedule
  now: () => Date
  readStatus: () => ServiceUpdateStatus
  store: {
    getRestartRequest: () => RestartRequest | null
    requestRestart: (input: { id: string, source: 'schedule', operation: { _tag: 'Update', targetCommit: string, preparation: 'Ready' }, at: string }) => RestartRequest
  }
  onRequested: (request: RestartRequest) => void
}): ServiceUpdateScheduler {
  let interval: ReturnType<typeof setInterval> | undefined

  const check = (): void => {
    const now = options.now()
    const targetCommit = scheduledUpdateTarget({
      now,
      schedule: options.schedule,
      status: options.readStatus(),
      latestRequest: options.store.getRestartRequest(),
    })
    if (targetCommit === null)
      return
    options.onRequested(options.store.requestRestart({
      id: randomUUID(),
      source: 'schedule',
      operation: { _tag: 'Update', targetCommit, preparation: 'Ready' },
      at: now.toISOString(),
    }))
  }

  return {
    start: () => {
      if (interval !== undefined)
        return
      interval = setInterval(check, CHECK_INTERVAL_MILLISECONDS)
      interval.unref()
    },
    stop: () => {
      if (interval !== undefined)
        clearInterval(interval)
      interval = undefined
    },
  }
}
