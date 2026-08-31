import type { CronExpression } from '../src/routine-schedule.ts'
import { describe, expect, it } from 'vitest'
import { dueRoutine, matchesCron, parseCron } from '../src/routine-schedule.ts'

function cron(text: string): CronExpression {
  const parsed = parseCron(text)
  if (parsed._tag === 'Err')
    throw new Error(parsed.error)
  return parsed.value
}

describe('parsing a cron expression', () => {
  it('reads a daily expression', () => {
    const parsed = cron('0 7 * * *')

    expect([...parsed.minutes]).toEqual([0])
    expect([...parsed.hours]).toEqual([7])
    expect(parsed.daysOfMonth.size).toBe(31)
    expect(parsed.months.size).toBe(12)
  })

  it('reads lists, ranges, and steps', () => {
    const parsed = cron('0,30 9-11 * * 1-5')

    expect([...parsed.minutes]).toEqual([0, 30])
    expect([...parsed.hours]).toEqual([9, 10, 11])
    expect([...parsed.daysOfWeek]).toEqual([1, 2, 3, 4, 5])
  })

  it('reads a step across the whole field', () => {
    expect([...cron('*/15 * * * *').minutes]).toEqual([0, 15, 30, 45])
  })

  it('folds Sunday written as 7 onto 0, so a match never checks both', () => {
    expect([...cron('0 7 * * 7').daysOfWeek]).toEqual([0])
  })

  it('refuses an expression that is not five fields', () => {
    expect(parseCron('0 7 * *')).toEqual({
      _tag: 'Err',
      error: 'Write five cron fields: minute, hour, day of month, month, and day of week.',
    })
  })

  it('refuses a value outside its field', () => {
    expect(parseCron('0 25 * * *')).toEqual({ _tag: 'Err', error: 'Write a hour from 0 to 23.' })
  })

  it('refuses a step of zero', () => {
    expect(parseCron('*/0 * * * *')).toEqual({ _tag: 'Err', error: 'Write a whole step above zero for the minute.' })
  })
})

describe('matching an instant in the Routine time zone', () => {
  it('matches the local hour, not the UTC hour', () => {
    // 21:00 UTC is 07:00 the next day in Sydney.
    const at = new Date('2026-08-26T21:00:00.000Z')

    expect(matchesCron(cron('0 7 * * *'), at, 'Australia/Sydney')).toBe(true)
    expect(matchesCron(cron('0 7 * * *'), at, 'UTC')).toBe(false)
  })

  it('matches a weekday in the Routine time zone', () => {
    // Thursday 27 August 2026, 07:00 in Sydney.
    const at = new Date('2026-08-26T21:00:00.000Z')

    expect(matchesCron(cron('0 7 * * 4'), at, 'Australia/Sydney')).toBe(true)
    expect(matchesCron(cron('0 7 * * 1'), at, 'Australia/Sydney')).toBe(false)
  })

  it('matches either day field when both are restricted, as cron does', () => {
    const expression = cron('0 7 1 * 4')
    const thursday = new Date('2026-08-26T21:00:00.000Z')

    expect(expression.restrictsBothDayFields).toBe(true)
    expect(matchesCron(expression, thursday, 'Australia/Sydney')).toBe(true)
  })

  it('matches midnight, which some runtimes report as hour 24', () => {
    expect(matchesCron(cron('0 0 * * *'), new Date('2026-08-27T00:00:00.000Z'), 'UTC')).toBe(true)
  })
})

describe('deciding whether a Routine owes a run', () => {
  const expression = cron('0 7 * * *')
  const timeZone = 'UTC'

  it('owes a run at its instant when it has never run', () => {
    const due = dueRoutine({
      expression,
      lastRunAt: null,
      now: new Date('2026-08-27T07:00:30.000Z'),
      timeZone,
    })

    expect(due).toEqual({ _tag: 'Due', scheduledFor: new Date('2026-08-27T07:00:00.000Z') })
  })

  it('owes nothing when the newest instant already ran, however long ago', () => {
    const due = dueRoutine({
      expression,
      lastRunAt: new Date('2026-08-25T07:00:00.000Z'),
      now: new Date('2026-08-26T06:00:00.000Z'),
      timeZone,
    })

    expect(due).toEqual({ _tag: 'NotDue' })
  })

  it('owes nothing when that instant already ran', () => {
    const due = dueRoutine({
      expression,
      lastRunAt: new Date('2026-08-27T07:00:00.000Z'),
      now: new Date('2026-08-27T09:00:00.000Z'),
      timeZone,
    })

    expect(due).toEqual({ _tag: 'NotDue' })
  })

  it('catches up on a missed instant inside the window', () => {
    const due = dueRoutine({
      expression,
      lastRunAt: new Date('2026-08-26T07:00:00.000Z'),
      now: new Date('2026-08-27T11:00:00.000Z'),
      timeZone,
    })

    expect(due).toEqual({ _tag: 'Due', scheduledFor: new Date('2026-08-27T07:00:00.000Z') })
  })

  it('names a missed instant outside the window instead of running it', () => {
    const due = dueRoutine({
      expression,
      lastRunAt: new Date('2026-08-24T07:00:00.000Z'),
      now: new Date('2026-08-26T06:00:00.000Z'),
      timeZone,
    })

    expect(due).toEqual({
      _tag: 'Missed',
      scheduledFor: new Date('2026-08-25T07:00:00.000Z'),
      reason: 'This run was due more than 6 hours ago, so it was skipped.',
    })
  })

  it('answers one instant after two days asleep, never a backlog', () => {
    const due = dueRoutine({
      expression,
      lastRunAt: new Date('2026-08-24T07:00:00.000Z'),
      now: new Date('2026-08-27T11:00:00.000Z'),
      timeZone,
    })

    expect(due).toEqual({ _tag: 'Due', scheduledFor: new Date('2026-08-27T07:00:00.000Z') })
  })

  it('owes nothing between instants', () => {
    const due = dueRoutine({
      expression,
      lastRunAt: new Date('2026-08-27T07:00:00.000Z'),
      now: new Date('2026-08-27T20:00:00.000Z'),
      timeZone,
    })

    expect(due).toEqual({ _tag: 'NotDue' })
  })

  it('ignores seconds, so an instant that has just arrived still counts', () => {
    const due = dueRoutine({
      expression,
      lastRunAt: null,
      now: new Date('2026-08-27T07:00:59.999Z'),
      timeZone,
    })

    expect(due).toEqual({ _tag: 'Due', scheduledFor: new Date('2026-08-27T07:00:00.000Z') })
  })

  it('honours a shorter catch-up window', () => {
    const due = dueRoutine({
      catchUpMinutes: 60,
      expression,
      lastRunAt: new Date('2026-08-26T07:00:00.000Z'),
      now: new Date('2026-08-27T11:00:00.000Z'),
      timeZone,
    })

    expect(due._tag).toBe('Missed')
  })

  it('finds the newest missed monthly instant', () => {
    const due = dueRoutine({
      expression: cron('0 7 1 * *'),
      lastRunAt: new Date('2026-06-01T07:00:00.000Z'),
      now: new Date('2026-08-10T12:00:00.000Z'),
      timeZone,
    })

    expect(due).toEqual({
      _tag: 'Missed',
      scheduledFor: new Date('2026-08-01T07:00:00.000Z'),
      reason: 'This run was due more than 6 hours ago, so it was skipped.',
    })
  })

  it('does not run a repeated fallback wall-clock instant twice', () => {
    const due = dueRoutine({
      expression: cron('30 2 * * *'),
      lastRunAt: new Date('2026-04-04T15:30:00.000Z'),
      now: new Date('2026-04-04T16:35:00.000Z'),
      timeZone: 'Australia/Sydney',
    })

    expect(due).toEqual({ _tag: 'NotDue' })
  })
})
