import type { TimelineHistory, TimelineWindow } from '../src/timeline.ts'
import { describe, expect, it, vi } from 'vitest'
import { createTimelineHistoryLoader } from '../dashboard/app/utils/timeline-history-loader.ts'
import { timelineSections } from '../dashboard/app/utils/timeline.ts'
import { parseTimelineWindow } from '../src/timeline.ts'
import { dashboardSnapshot } from './fixtures.ts'

const day = 86_400_000
const now = Date.parse('2026-11-21T12:00:00Z')
const viewport = { from: now - 6 * 3_600_000, to: now + 2 * 3_600_000 }
function history(): TimelineHistory {
  return {
    generatedAt: new Date(now).toISOString(),
    deliveries: { start: new Date(now).toISOString(), bucketSeconds: 60, counts: [] },
    tasks: [],
    routineRuns: [],
    upcoming: [],
    itemEvents: [],
    pauses: [],
  }
}
function deferred() {
  let resolve!: (value: unknown) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('timeline viewport history', () => {
  it('requests the visible interval and draws a finished Task eight days ago', async () => {
    const ended = now - 8 * day
    const fixture = history()
    fixture.tasks.push({
      id: 'eight-days',
      repository: 'harlan-zw/harlan-agent-kit',
      number: 736,
      kind: 'pull_request',
      title: 'Task eight days ago',
      work: 'adversarial_review',
      startedAt: new Date(ended - 3_600_000).toISOString(),
      endedAt: new Date(ended).toISOString(),
      outcome: 'READY',
    })
    let result: TimelineHistory | undefined
    const requests: TimelineWindow[] = []
    const loader = createTimelineHistoryLoader(async (query) => {
      const parsed = parseTimelineWindow(query, now)
      if (parsed._tag === 'Err')
        throw new Error('Invalid request window')
      requests.push(parsed.value)
      return parsed.value.from <= ended && ended < parsed.value.to ? fixture : history()
    }, (value) => { result = value })
    await loader.load(viewport)
    const panned = { from: ended - day, to: ended + day }
    loader.invalidate(panned)
    await loader.load(panned)
    expect(requests.some(window => window.from <= ended && window.to > ended)).toBe(true)
    const sections = timelineSections({ snapshot: dashboardSnapshot(), history: result, now, ...panned })
    expect(sections.flatMap(section => [...section.rows, ...section.folded]).some(row =>
      row._tag === 'Item' && row.item.title === 'Task eight days ago' && row.marks.some(mark => mark._tag === 'Span'),
    )).toBe(true)
  })

  it.each(['success', 'failure'] as const)('discards a stale %s before the next settled viewport read', async (outcome) => {
    const pending = deferred()
    const publish = vi.fn()
    const loader = createTimelineHistoryLoader(() => pending.promise, publish)
    const old = loader.load(viewport)
    loader.invalidate({ from: now - 9 * day, to: now - 7 * day })
    if (outcome === 'success')
      pending.resolve(history())
    else
      pending.reject(new Error('Old request failed'))
    await old
    expect(publish).not.toHaveBeenCalled()
  })

  it('splits wide viewports into API windows and retains Tasks from every window', async () => {
    const publish = vi.fn()
    const requests: TimelineWindow[] = []
    const loader = createTimelineHistoryLoader(async (query) => {
      const parsed = parseTimelineWindow(query, now)
      if (parsed._tag === 'Err')
        throw new Error('Invalid request window')
      requests.push(parsed.value)
      const fixture = history()
      fixture.tasks = [{ id: query.from, repository: 'harlan-zw/harlan-agent-kit', number: 736, kind: 'pull_request', title: 'Task', work: 'adversarial_review', startedAt: query.from, endedAt: query.to, outcome: 'READY' }]
      return fixture
    }, publish)
    await loader.load({ from: now - 65 * day, to: now })
    expect(requests[0]?.from).toBeLessThanOrEqual(now - 65 * day)
    expect(requests.at(-1)?.to).toBeGreaterThanOrEqual(now)
    expect(requests.slice(1).every((window, index) => window.from <= requests[index]!.to)).toBe(true)
    expect(requests.every(window => window.to - window.from <= 30 * day)).toBe(true)
    expect(publish.mock.calls[0]?.[0].tasks.map((task: { id: string }) => task.id)).toEqual(requests.map(window => new Date(window.from).toISOString()))
  })

  it('polls the current viewport while ordinary clock ticks reuse covered history', async () => {
    const fetch = vi.fn(async () => history())
    const loader = createTimelineHistoryLoader(fetch, vi.fn())
    await loader.load(viewport)
    const tick = { from: viewport.from + 1000, to: viewport.to + 1000 }
    loader.invalidate(tick)
    await loader.load(tick)
    expect(fetch).toHaveBeenCalledTimes(1)
    await loader.load(tick, true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
