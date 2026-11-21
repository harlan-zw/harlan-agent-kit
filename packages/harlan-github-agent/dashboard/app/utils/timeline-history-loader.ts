import type { TimelineHistory, TimelineWindow } from '../../../src/timeline.ts'
import { TIMELINE_MAXIMUM_DAYS } from '../../../src/timeline.ts'
import { parseTimelineHistory } from './timeline.ts'

const maximumWindow = TIMELINE_MAXIMUM_DAYS * 86_400_000
const margin = 5 * 60_000

/** Keep polling and viewport reads under one owner, including late failures. */
export function createTimelineHistoryLoader(
  fetchHistory: (query: { from: string, to: string }) => Promise<unknown>,
  publish: (history: TimelineHistory | undefined, error: boolean) => void,
) {
  let revision = 0
  let requested: TimelineWindow | undefined
  let loaded: TimelineWindow | undefined
  const covers = (outer: TimelineWindow | undefined, inner: TimelineWindow): boolean =>
    outer !== undefined && outer.from <= inner.from && outer.to >= inner.to

  function invalidate(window: TimelineWindow): void {
    if (!covers(requested, window)) {
      revision++
      requested = undefined
    }
  }

  async function load(window: TimelineWindow, force = false): Promise<void> {
    if (!Number.isFinite(window.from) || !Number.isFinite(window.to) || window.to <= window.from)
      return
    if (!force && (covers(loaded, window) || covers(requested, window)))
      return
    const current = ++revision
    const bounds = { from: Math.floor(window.from - margin), to: Math.ceil(window.to + margin) }
    requested = bounds
    const chunks: TimelineWindow[] = []
    for (let from = bounds.from; from < bounds.to; from += maximumWindow)
      chunks.push({ from, to: Math.min(from + maximumWindow, bounds.to) })

    await Promise.all(chunks.map(chunk => fetchHistory({
      from: new Date(chunk.from).toISOString(),
      to: new Date(chunk.to).toISOString(),
    }).then((value) => {
      const parsed = parseTimelineHistory(value)
      if (!parsed)
        throw new Error('Invalid Timeline history')
      return parsed
    })))
      .then((parts) => {
        if (current !== revision)
          return
        loaded = bounds
        publish(mergeHistory(parts), false)
      })
      .catch(() => {
        if (current !== revision)
          return
        // Older Services can lack the API. Keep the live snapshot available.
        loaded = undefined
        publish(undefined, true)
      })
      .finally(() => {
        if (current === revision)
          requested = undefined
      })
  }

  function dispose(): void {
    revision++
    requested = undefined
  }

  return { load, invalidate, dispose }
}

function mergeHistory(parts: TimelineHistory[]): TimelineHistory {
  const first = parts[0]!
  const bucketMs = first.deliveries.bucketSeconds * 1000
  const start = Date.parse(first.deliveries.start)
  const counts: number[] = []
  for (const part of parts) {
    const offset = Math.round((Date.parse(part.deliveries.start) - start) / bucketMs)
    part.deliveries.counts.forEach((count, index) => {
      counts[offset + index] = count
    })
  }
  return {
    generatedAt: first.generatedAt,
    deliveries: { ...first.deliveries, counts: Array.from({ length: counts.length }, (_, index) => counts[index] ?? 0) },
    tasks: [...new Map(parts.flatMap(part => part.tasks).map(task => [task.id, task])).values()],
    routineRuns: [...new Map(parts.flatMap(part => part.routineRuns).map(run => [`${run.routineId}:${run.scheduledFor}`, run])).values()],
    upcoming: [...new Map(parts.flatMap(part => part.upcoming).map(instant => [`${instant.routineId}:${instant.at}`, instant])).values()],
    itemEvents: parts.flatMap(part => part.itemEvents),
    pauses: parts.flatMap(part => part.pauses),
  }
}
