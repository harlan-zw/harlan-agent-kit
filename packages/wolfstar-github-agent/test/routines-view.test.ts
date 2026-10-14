import type { DashboardRoutineRun, Routine } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import {
  describeCron,
  filterRoutineRows,
  filterRoutineRuns,
  recentRoutineRuns,
  routineQueueBlocks,
  routineRows,
  routineRunDetail,
  routineSchedule,
} from '../dashboard/app/utils/routines.ts'
import { dashboardSnapshot } from './fixtures.ts'

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'wolfstar-project/example:sentry-checkin',
    repository: 'wolfstar-project/example',
    name: 'sentry-checkin',
    crons: ['0 7 * * *'],
    timeZone: 'UTC',
    mode: 'report',
    enabled: true,
    specSha: 'abc123',
    lastRunAt: '2026-08-27T07:00:00.000Z',
    trackingIssueNumber: 42,
    updatedAt: '2026-08-27T07:00:01.000Z',
    ...overrides,
  }
}

function run(overrides: Partial<DashboardRoutineRun> = {}): DashboardRoutineRun {
  return {
    id: 'run-1',
    routineId: 'wolfstar-project/example:sentry-checkin',
    repository: 'wolfstar-project/example',
    name: 'sentry-checkin',
    scheduledFor: '2026-08-27T07:00:00.000Z',
    specSha: 'abc123',
    mode: 'report',
    state: { _tag: 'Completed', evidence: 'Nothing new.' },
    fence: 1,
    attempts: 1,
    progress: { percent: 100, label: 'Done' },
    usage: { _tag: 'Unavailable' },
    createdAt: '2026-08-27T07:00:00.000Z',
    updatedAt: '2026-08-27T07:04:00.000Z',
    candidates: [],
    activity: [],
    reportState: null,
    report: null,
    ...overrides,
  }
}

describe('describeCron', () => {
  it('says a daily and a weekday schedule as a sentence', () => {
    expect(describeCron('0 7 * * *')).toBe('Daily at 07:00')
    expect(describeCron('30 9 * * 1-5')).toBe('Weekdays at 09:30')
    expect(describeCron('0 6,18 * * 1')).toBe('Monday at 06:00 and 18:00')
  })

  it('keeps an expression it cannot say faithfully', () => {
    expect(describeCron('*/15 * * * *')).toBe('*/15 * * * *')
    expect(describeCron('0 7 1 * *')).toBe('0 7 1 * *')
    expect(describeCron('not a cron')).toBe('not a cron')
  })

  it('joins several expressions and names the zone', () => {
    expect(routineSchedule({ crons: ['0 7 * * *', '0 19 * * 5'], timeZone: 'Australia/Melbourne' })).toBe(
      'Daily at 07:00; Friday at 19:00 Australia/Melbourne',
    )
  })
})

describe('routineRows', () => {
  const now = new Date('2026-08-28T06:00:00.000Z')

  it('filters previous results without hiding a newer queued scan', () => {
    const failure = run({ state: { _tag: 'Failed', reason: 'Usage exhausted.' } })
    const queued = run({ id: 'next', scheduledFor: '2026-08-28T07:00:00.000Z', state: { _tag: 'Queued' } })
    const filters = { repository: 'wolfstar-project/example', routine: 'sentry-checkin', result: 'Failed' }
    expect(
      filterRoutineRows(routineRows([routine()], [failure, queued], now), filters).map((row) => row.routine.id),
    ).toEqual([routine().id])
    expect(filterRoutineRuns([queued, failure], filters).map((run) => run.id)).toEqual([failure.id])
  })

  it('names the exhausted plan while a manual OpenCode Go scan remains eligible', () => {
    const snapshot = dashboardSnapshot()
    snapshot.mutationsEnabled = true
    const queued = run({
      state: { _tag: 'Queued' },
      agentSelection: { provider: 'opencode', model: 'zai-coding-plan/glm-5.3', reasoningEffort: 'high' },
    })
    const go = run({
      id: 'go',
      state: { _tag: 'Queued' },
      agentSelection: { provider: 'opencode', model: 'opencode-go/glm-5.3-flash', reasoningEffort: 'high' },
    })
    snapshot.agentModelCapacities = {
      opencodeGo: { _tag: 'Unpublished' },
      zaiCodingPlan: { _tag: 'Available', usedPercent: 100, resetsAt: '2026-10-14T05:44:29.983Z' },
    }
    expect(routineQueueBlocks(snapshot, [queued, go], now)).toEqual([
      {
        provider: 'opencode',
        model: 'zai-coding-plan/glm-5.3',
        reason: 'Usage limit reached.',
        retryAt: '2026-10-14T05:44:29.983Z',
        count: 1,
      },
    ])
  })

  it('keeps the previous failure when a new scan waits or runs', () => {
    const failure = run({ state: { _tag: 'Failed', reason: 'Weekly/Monthly Limit Exhausted' } })
    const queued = run({ id: 'next', scheduledFor: '2026-08-28T07:00:00.000Z', state: { _tag: 'Queued' } })
    const [row] = routineRows([routine()], [queued, failure], now)
    expect(row).toMatchObject({ latestRun: queued, resultRun: failure, resultLabel: 'Failed', resultTone: 'error' })
  })

  it('sorts soonest first and sends disabled Routines to the end', () => {
    const later = routine({ id: 'b', name: 'daily-checkin', crons: ['0 9 * * *'] })
    const disabled = routine({ id: 'c', name: 'pr-triage', enabled: false })
    const rows = routineRows([disabled, later, routine()], [run()], now)

    expect(rows.map((row) => [row.routine.id, row.next])).toEqual([
      ['wolfstar-project/example:sentry-checkin', '2026-08-28T07:00:00.000Z'],
      ['b', '2026-08-28T09:00:00.000Z'],
      ['c', null],
    ])
  })

  it('carries the latest run outcome and the tracking issue link', () => {
    const [row] = routineRows(
      [routine()],
      [
        run(),
        run({
          id: 'run-2',
          scheduledFor: '2026-08-28T07:00:00.000Z',
          state: { _tag: 'Failed', reason: 'Sentry answered 500.' },
        }),
      ],
      now,
    )

    expect(row!.label).toBe('Failed')
    expect(row!.tone).toBe('error')
    expect(row!.detail).toBe('Sentry answered 500.')
    expect(row!.trackingUrl).toBe('https://github.com/wolfstar-project/example/issues/42')
  })

  it('keeps scan counters in run evidence and removes them from action rows', () => {
    const completed = run({
      state: {
        _tag: 'Completed',
        evidence: 'sentry-checkin on wolfstar-project/example | 0 found | 0 new | 0 issues requested',
      },
      report: { body: 'The deployment needs attention.', verdict: { severity: 'AMBER', coverage: 'complete' } },
    })
    const [row] = routineRows([routine()], [completed], now)

    expect([row!.label, row!.tone, row!.detail]).toEqual(['Action required', 'warning', undefined])
    expect(routineRunDetail(completed)).toBe('0 found · 0 new · 0 issues requested')
  })
})

describe('recentRoutineRuns', () => {
  it('lists the newest scheduled instants first and caps the log', () => {
    const runs = [
      run({ id: 'a', scheduledFor: '2026-08-26T07:00:00.000Z' }),
      run({ id: 'b', scheduledFor: '2026-08-28T07:00:00.000Z' }),
      run({ id: 'c' }),
    ]

    expect(recentRoutineRuns(runs, 2).map((entry) => entry.id)).toEqual(['b', 'c'])
  })
})

describe('routineRunDetail', () => {
  it('drops the name and repository the row already shows and lists the counts', () => {
    const completed = run({
      state: {
        _tag: 'Completed',
        evidence: 'sentry-checkin on wolfstar-project/example | 2 found | 1 new | 0 outside allowed scope',
      },
    })

    expect(routineRunDetail(completed)).toBe('2 found · 1 new · 0 outside allowed scope')
    expect(routineRunDetail(run({ state: { _tag: 'Failed', reason: 'Sentry answered 500.' } }))).toBe(
      'Sentry answered 500.',
    )
    expect(routineRunDetail(run({ state: { _tag: 'Queued' } }))).toBeUndefined()
  })
})

it('shows blocked coverage even when the scan completed successfully', () => {
  const blocked = run({
    name: 'daily-checkin',
    report: { body: 'Deployment identity is unavailable.', verdict: { severity: 'AMBER', coverage: 'incomplete' } },
  })
  const [row] = routineRows([routine({ name: 'daily-checkin' })], [blocked], new Date('2026-08-28T06:00:00.000Z'))
  expect([row!.label, row!.tone]).toEqual(['Blocked', 'warning'])
  expect(row!.detail).toBe('Coverage incomplete.')
})
