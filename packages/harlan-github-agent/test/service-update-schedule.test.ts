import type { RestartRequest, ServiceUpdateStatus } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { scheduledUpdateTarget } from '../src/service-update-schedule.ts'

const schedule = { minuteOfDay: 3 * 60, timeZone: 'Australia/Melbourne' }
const latestCommit = 'b'.repeat(40)
const available: ServiceUpdateStatus = { _tag: 'Available', deployedCommit: 'a'.repeat(40), latestCommit, checkedAt: '2026-10-20T16:00:00.000Z' }

function scheduledRequest(requestedAt: string, tag: 'Completed' | 'ActionRequired' = 'ActionRequired'): RestartRequest {
  const base = { id: 'scheduled', source: 'schedule' as const, operation: { _tag: 'Update' as const, targetCommit: latestCommit, preparation: 'Ready' as const }, requestedAt }
  return tag === 'Completed'
    ? { ...base, _tag: 'Completed', restartingAt: requestedAt, completedAt: requestedAt }
    : { ...base, _tag: 'ActionRequired', actionRequiredAt: requestedAt, reason: 'The update could not be prepared.' }
}

describe('scheduled service update', () => {
  // 03:05 on 21 Oct in Melbourne (AEDT, UTC+11).
  const morning = new Date('2026-10-20T16:05:00.000Z')

  it('installs an available update in the hour after the scheduled time', () => {
    expect(scheduledUpdateTarget({ now: morning, schedule, status: available, latestRequest: null })).toBe(latestCommit)
  })

  it.each([
    ['before the scheduled time', '2026-10-20T15:59:00.000Z'],
    ['after the window closes', '2026-10-20T17:00:00.000Z'],
    ['at noon', '2026-10-21T01:00:00.000Z'],
  ])('waits %s', (_label, at) => {
    expect(scheduledUpdateTarget({ now: new Date(at), schedule, status: available, latestRequest: null })).toBeNull()
  })

  it.each(['Current', 'Checking', 'Unavailable'] as const)('waits while the update status is %s', (tag) => {
    const status: ServiceUpdateStatus = tag === 'Current'
      ? { _tag: 'Current', deployedCommit: latestCommit, latestCommit, checkedAt: available.checkedAt }
      : tag === 'Checking'
        ? { _tag: 'Checking', deployedCommit: latestCommit }
        : { _tag: 'Unavailable', deployedCommit: latestCommit, checkedAt: available.checkedAt, reason: 'Retry later.' }
    expect(scheduledUpdateTarget({ now: morning, schedule, status, latestRequest: null })).toBeNull()
  })

  it('tries once a day after a scheduled update fails', () => {
    const failed = scheduledRequest('2026-10-20T16:01:00.000Z')
    expect(scheduledUpdateTarget({ now: morning, schedule, status: available, latestRequest: failed })).toBeNull()
    expect(scheduledUpdateTarget({ now: new Date('2026-10-21T16:05:00.000Z'), schedule, status: available, latestRequest: failed })).toBe(latestCommit)
  })

  it('waits while another request owns the restart', () => {
    const active: RestartRequest = { id: 'manual', source: 'dashboard', operation: { _tag: 'Restart' }, requestedAt: '2026-10-20T16:01:00.000Z', _tag: 'Requested' }
    expect(scheduledUpdateTarget({ now: morning, schedule, status: available, latestRequest: active })).toBeNull()
  })

  it('installs after an earlier manual request on the same day', () => {
    const manual: RestartRequest = { ...scheduledRequest('2026-10-20T16:01:00.000Z', 'Completed'), source: 'dashboard' }
    expect(scheduledUpdateTarget({ now: morning, schedule, status: available, latestRequest: manual })).toBe(latestCommit)
  })

  it('reads the day on the schedule clock, not in UTC', () => {
    // 03:30 on 21 Oct in Melbourne is still 20 Oct in UTC, so yesterday's
    // scheduled request at 03:01 local time must not block today's.
    const yesterday = scheduledRequest('2026-10-19T16:01:00.000Z')
    expect(scheduledUpdateTarget({ now: new Date('2026-10-20T16:30:00.000Z'), schedule, status: available, latestRequest: yesterday })).toBe(latestCommit)
  })
})
