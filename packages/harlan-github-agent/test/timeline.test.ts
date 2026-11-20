import type { TimelineHistory, TimelineTaskRecord } from '../dashboard/app/utils/timeline.ts'
import type { QueueEntry } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { deliveryBins, followView, nowFraction, timelineSections, timeTicks, xOf, zoomAt } from '../dashboard/app/utils/timeline.ts'
import { dashboardSnapshot } from './fixtures.ts'

const now = Date.parse('2026-11-20T03:30:00.000Z')
const minute = 60_000
const hour = 60 * minute

function queueEntry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    position: 1,
    kind: 'pull_request',
    revisionId: 'rev-a',
    repository: 'harlan-zw/nuxt-seo',
    repositoryUrl: 'https://github.com/harlan-zw/nuxt-seo',
    number: 412,
    title: 'A pull request',
    author: 'harlan-zw',
    subjectUrl: 'https://github.com/harlan-zw/nuxt-seo/pull/412',
    headSha: 'abc1234',
    commitUrl: 'https://github.com/harlan-zw/nuxt-seo/commit/abc1234',
    createdAt: new Date(now - 3 * hour).toISOString(),
    updatedAt: new Date(now - 48 * minute).toISOString(),
    state: { _tag: 'Queued', work: 'adversarial_review' },
    ...overrides,
  } as QueueEntry
}

function task(overrides: Partial<TimelineTaskRecord> = {}): TimelineTaskRecord {
  return {
    id: 'task-1',
    repository: 'harlan-zw/skilld',
    number: 190,
    kind: 'pull_request',
    title: 'chore(deps): update dependencies',
    work: 'adversarial_review',
    startedAt: new Date(now - 3 * hour).toISOString(),
    endedAt: new Date(now - 3 * hour + 9 * minute).toISOString(),
    outcome: 'READY',
    ...overrides,
  }
}

function history(overrides: Partial<TimelineHistory> = {}): TimelineHistory {
  return {
    generatedAt: new Date(now).toISOString(),
    deliveries: { start: new Date(now - 2 * hour).toISOString(), bucketSeconds: 60, counts: [] },
    tasks: [],
    itemEvents: [],
    routineRuns: [],
    upcoming: [],
    pauses: [],
    ...overrides,
  }
}

describe('timeline view', () => {
  it('rests with now at three quarters of the width', () => {
    const view = followView(now, 1200, 20_000)
    expect(xOf(view, 1200, now)).toBeCloseTo(1200 * nowFraction)
  })

  it('zooms around the time under the pointer', () => {
    const view = followView(now, 1200, 20_000)
    const pointer = 300
    const before = view.end - (1200 - pointer) * view.msPerPx
    const zoomed = zoomAt(view, 1200, pointer, 0.5)
    expect(zoomed.msPerPx).toBe(10_000)
    expect(xOf(zoomed, 1200, before)).toBeCloseTo(pointer)
  })

  it('keeps ruler labels apart and names local midnight', () => {
    const view = { msPerPx: (2 * 24 * hour) / 1200, end: now }
    const ticks = timeTicks(view, 1200)
    const gaps = ticks.slice(1).map((tick, index) => tick.at - ticks[index]!.at)
    expect(Math.min(...gaps) / view.msPerPx).toBeGreaterThanOrEqual(110)
    const midnight = ticks.find(tick => tick.day)
    expect(midnight).toBeDefined()
    expect(new Date(midnight!.at).getHours()).toBe(0)
  })
})

describe('delivery bins', () => {
  it('sums minute buckets into wider bins inside the range', () => {
    const series = { start: '2026-11-20T00:00:00.000Z', bucketSeconds: 60, counts: [1, 2, 3, 4, 5, 6] }
    const start = Date.parse(series.start)
    expect(deliveryBins(series, start, start + 6 * minute, 2 * minute).map(bin => bin.count)).toEqual([3, 7, 11])
    expect(deliveryBins(series, start + 2 * minute, start + 4 * minute, 2 * minute).map(bin => bin.count)).toEqual([7])
  })
})

describe('timeline sections', () => {
  const window = { from: now - 6 * hour, to: now + 2 * hour }

  it('puts a decision in Needs you with a wait mark from its last update', () => {
    const entry = queueEntry({ state: { _tag: 'AwaitingApproval', kind: 'review' } })
    const sections = timelineSections({ snapshot: dashboardSnapshot({ queue: [entry] }), history: history(), now, ...window })
    const needsYou = sections.find(section => section._tag === 'NeedsYou')!
    expect(needsYou.rows).toHaveLength(1)
    expect(needsYou.rows[0]!.marks).toContainEqual({ _tag: 'Wait', since: Date.parse(entry.updatedAt), owner: 'You' })
  })

  it('never repeats an item with a live row in Earlier', () => {
    const entry = queueEntry({ number: 190, repository: 'harlan-zw/skilld', state: { _tag: 'Queued', work: 'adversarial_review' } })
    const sections = timelineSections({ snapshot: dashboardSnapshot({ queue: [entry] }), history: history({ tasks: [task()] }), now, ...window })
    expect(sections.find(section => section._tag === 'Earlier')).toBeUndefined()
    const upNext = sections.find(section => section._tag === 'UpNext')!
    expect(upNext.rows[0]!.marks.map(mark => mark._tag)).toEqual(['Span', 'Queued'])
  })

  it('keeps a Routine due within two hours open while quiet Routines fold', () => {
    const routineRuns = Array.from({ length: 12 }, (_, index) => ({
      routineId: `quiet-${index}`,
      repository: 'harlan-zw/nuxt-seo',
      name: `quiet-${index}`,
      scheduledFor: new Date(now - (index + 1) * 20 * minute).toISOString(),
      endedAt: null,
      result: 'Clear' as const,
    }))
    const upcoming = [{ routineId: 'due', repository: 'harlan-zw/nuxt-robots', name: 'seo-review', at: new Date(now + 20 * minute).toISOString() }]
    const sections = timelineSections({ snapshot: dashboardSnapshot(), history: history({ routineRuns, upcoming }), now, limit: 4, ...window })
    const routines = sections.find(section => section._tag === 'Routines')!
    expect(routines.rows[0]).toMatchObject({ _tag: 'Routine', name: 'seo-review' })
    expect(routines.rows).toHaveLength(3)
    expect(routines.folded).toHaveLength(10)
  })

  it('shows finished items in view, newest first', () => {
    const older = task({ id: 'a', number: 1, endedAt: new Date(now - 4 * hour).toISOString(), startedAt: new Date(now - 5 * hour).toISOString() })
    const newer = task({ id: 'b', number: 2, endedAt: new Date(now - hour).toISOString(), startedAt: new Date(now - 2 * hour).toISOString() })
    const outside = task({ id: 'c', number: 3, endedAt: new Date(now - 30 * hour).toISOString(), startedAt: new Date(now - 31 * hour).toISOString() })
    const sections = timelineSections({ snapshot: dashboardSnapshot(), history: history({ tasks: [older, newer, outside] }), now, ...window })
    const earlier = sections.find(section => section._tag === 'Earlier')!
    expect(earlier.rows.map(row => row._tag === 'Item' && row.item.number)).toEqual([2, 1])
  })
})
