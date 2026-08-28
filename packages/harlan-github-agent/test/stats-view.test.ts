import { describe, expect, it } from 'vitest'
import { comparisonText, statsDateRange, statsRequestRange } from '../dashboard/app/utils/stats.ts'

describe('stats date controls', () => {
  it('builds an inclusive 30 day preset', () => {
    expect(statsDateRange(30, new Date(2026, 7, 28, 9))).toEqual({
      from: '2026-07-30',
      to: '2026-08-28',
    })
  })

  it('turns inclusive local dates into exclusive request instants', () => {
    expect(statsRequestRange({ from: '2026-08-01', to: '2026-08-03' }, 'UTC')).toEqual({
      _tag: 'Valid',
      range: {
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-04T00:00:00.000Z',
        timeZone: 'UTC',
      },
    })
  })

  it('rejects an empty range before loading', () => {
    expect(statsRequestRange({ from: '2026-08-03', to: '2026-08-02' }, 'UTC')).toEqual({
      _tag: 'Invalid',
      message: 'The end date must follow the start date.',
    })
  })

  it('describes the previous period without percentages', () => {
    expect(comparisonText({ value: 7, previous: 4 })).toBe('3 more than the previous period')
    expect(comparisonText({ value: 2, previous: 5 })).toBe('3 fewer than the previous period')
    expect(comparisonText({ value: 0, previous: 0 })).toBe('Same as the previous period')
  })
})
