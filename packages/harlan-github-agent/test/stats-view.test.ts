import type { StatsSnapshot, StatsWork } from '../src/stats.ts'
import { describe, expect, it } from 'vitest'
import { activeStatsPreset, barWidth, comparisonText, coverageText, dayTotal, hasStatsResults, historyQuery, labelFits, medianText, outcomeRows, outcomeScale, statsDateRange, statsRequestRange, workResultText, workRole } from '../dashboard/app/utils/stats.ts'

describe('stats date controls', () => {
  it('builds an inclusive 30 day preset', () => {
    expect(statsDateRange(30, new Date(2026, 7, 28, 9))).toEqual({
      from: '2026-07-30',
      to: '2026-08-28',
    })
  })

  it('names the preset the inputs match and none otherwise', () => {
    const now = new Date(2026, 7, 28, 9)
    expect(activeStatsPreset({ from: '2026-08-22', to: '2026-08-28' }, now)).toBe(7)
    expect(activeStatsPreset({ from: '2026-08-22', to: '2026-08-27' }, now)).toBeUndefined()
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

describe('stats bars', () => {
  it('scales from a zero baseline to the series maximum', () => {
    expect(barWidth(0, 10)).toBe('0%')
    expect(barWidth(5, 10)).toBe('50%')
    expect(barWidth(10, 10)).toBe('100%')
    expect(barWidth(1, 3)).toBe('33.3%')
  })

  it('draws nothing when the series has no maximum', () => {
    expect(barWidth(4, 0)).toBe('0%')
  })

  it('shows a value label only when its glyphs fit the column', () => {
    expect(labelFits(7, 9)).toBe(true)
    expect(labelFits(12, 9)).toBe(false)
    expect(labelFits(12, 17)).toBe(true)
  })

  it('scales every Outcomes row to the one largest value across both periods', () => {
    const rows = outcomeRows({
      changedPullRequests: { value: 20, previous: 12 },
      fixCommits: { value: 34, previous: 21 },
      conflictResolutions: { value: 4, previous: 5 },
      openedPullRequests: { value: 3, previous: 1 },
      reviewFindings: { value: 58, previous: 68 },
    })
    const scale = outcomeScale(rows)
    expect(scale).toBe(68)
    expect(barWidth(4, scale)).toBe('5.9%')
    expect(barWidth(34, scale)).toBe('50%')
    expect(outcomeScale([])).toBe(0)
  })

  it('totals a day from its four outcomes', () => {
    expect(dayTotal({ date: '2026-08-01', fixCommits: 2, conflictResolutions: 1, openedPullRequests: 0, reviewFindings: 3 })).toBe(6)
  })

  it('lists the five outcomes with their comparison sentence', () => {
    const summary: StatsSnapshot['summary'] = {
      changedPullRequests: { value: 3, previous: 1 },
      conflictResolutions: { value: 0, previous: 0 },
      fixCommits: { value: 4, previous: 6 },
      openedPullRequests: { value: 1, previous: 1 },
      reviewFindings: { value: 9, previous: 2 },
    }
    expect(outcomeRows(summary).map(row => [row.label, row.text])).toEqual([
      ['Pull requests changed', '2 more than the previous period'],
      ['Repair commits', '2 fewer than the previous period'],
      ['Conflicts resolved', 'Same as the previous period'],
      ['Pull requests opened', 'Same as the previous period'],
      ['Review issues found', '7 more than the previous period'],
    ])
  })
})

describe('stats work rows', () => {
  const review: StatsWork = { _tag: 'Review', runs: 4, ready: 2, pending: 1, blocked: 1, findings: 5, medianDurationMs: 480_000 }
  const task: StatsWork = { _tag: 'Task', work: 'issue_work', runs: 3, completed: 2, actionRequired: 0, failed: 1, superseded: 0, publishedCommits: 2, changedFiles: 0, medianDurationMs: null }

  it('carries the board work kind for each row', () => {
    expect(workRole(review)).toBe('adversarial_review')
    expect(workRole(task)).toBe('issue_work')
    expect(workRole({ _tag: 'Routine', runs: 1, completed: 1, actionRequired: 0, failed: 0, skipped: 0, superseded: 0, candidates: 0, medianDurationMs: null })).toBe('routine_scan')
  })

  it('writes results as one sentence and hides zero optional counts', () => {
    expect(workResultText(review)).toBe('2 READY, 1 PENDING, 1 BLOCKED')

    expect(workResultText(task)).toBe('2 completed, 0 needed you, 1 failed, 2 commits pushed')
  })

  it('formats the median in the unit that fits', () => {
    expect(medianText(null)).toBe('No time yet')
    expect(medianText(4_200)).toBe('4s')
    expect(medianText(480_000)).toBe('8m')
    expect(medianText(5_400_000)).toBe('1.5h')
  })

  it('links Evidence to History with the same range and work kind', () => {
    expect(historyQuery(review, { from: '2026-08-01', to: '2026-08-30' })).toEqual({ from: '2026-08-01', to: '2026-08-30', work: 'adversarial_review' })
  })

  it('names partial coverage in one line and stays silent when complete', () => {
    expect(coverageText({ _tag: 'Partial', startedAt: '2026-07-20T00:00:00.000Z' })).toBe('Pull request triage counts start on Jul 20.')
    expect(coverageText({ _tag: 'Complete' })).toBeUndefined()
  })

  it('treats a range with no outcomes and no runs as empty', () => {
    const empty: StatsSnapshot = {
      generatedAt: '2026-08-30T00:00:00.000Z',
      range: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z', timeZone: 'UTC' },
      previousRange: { from: '2026-07-02T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' },
      coverage: { pullRequestTriage: { _tag: 'Complete' } },
      summary: {
        changedPullRequests: { value: 0, previous: 2 },
        conflictResolutions: { value: 0, previous: 0 },
        fixCommits: { value: 0, previous: 0 },
        openedPullRequests: { value: 0, previous: 0 },
        reviewFindings: { value: 0, previous: 0 },
      },
      days: [],
      work: [],
    }
    expect(hasStatsResults(empty)).toBe(false)
    expect(hasStatsResults({ ...empty, work: [task] })).toBe(true)
  })
})
