import type { StatsDay, StatsSnapshot, StatsWork } from '../../../src/stats.ts'
import { createError, defineEventHandler, getQuery } from 'h3'
import { parseStatsRange } from '../../../src/stats.ts'
import { assertDevMock } from '../utils/mock.ts'

/**
 * A dev-only stand-in for `/api/stats`. Values are seeded by date, so a range
 * renders the same numbers on every load, and nothing exists before the
 * service "started" on 1 June 2026, so an old range shows the empty state.
 */
const serviceStart = Date.UTC(2026, 5, 1)
const triageRecordingStart = '2026-07-20T00:00:00.000Z'
const day = 86_400_000

function seeded(key: string): () => number {
  let hash = 2_166_136_261
  for (const character of key) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16_777_619) >>> 0
  }
  return () => {
    hash = (Math.imul(hash, 1_664_525) + 1_013_904_223) >>> 0
    return hash / 4_294_967_296
  }
}

function dayAt(instant: number): StatsDay {
  const date = new Date(instant).toISOString().slice(0, 10)
  if (instant < serviceStart)
    return { date, fixCommits: 0, conflictResolutions: 0, openedPullRequests: 0, reviewFindings: 0 }
  const random = seeded(date)
  const weekend = [0, 6].includes(new Date(instant).getUTCDay())
  const scale = weekend ? 0.3 : 1
  return {
    date,
    fixCommits: Math.floor(random() * 4 * scale),
    conflictResolutions: random() < 0.2 * scale ? 1 : 0,
    openedPullRequests: Math.floor(random() * 2.4 * scale),
    reviewFindings: Math.floor(random() * 6 * scale),
  }
}

function daysBetween(from: number, to: number): StatsDay[] {
  const days: StatsDay[] = []
  for (let instant = from; instant < to; instant += day)
    days.push(dayAt(instant))
  return days
}

function sum(days: StatsDay[], key: Exclude<keyof StatsDay, 'date'>): number {
  return days.reduce((total, entry) => total + entry[key], 0)
}

function work(days: StatsDay[]): StatsWork[] {
  const active = days.filter(entry => entry.fixCommits + entry.reviewFindings > 0).length
  const fixCommits = sum(days, 'fixCommits')
  const findings = sum(days, 'reviewFindings')
  const conflicts = sum(days, 'conflictResolutions')
  const opened = sum(days, 'openedPullRequests')
  if (active === 0)
    return []
  const reviews = active + Math.floor(findings / 3)
  return [
    { _tag: 'PullRequestTriage', runs: reviews + 4, reviewRequired: reviews, reviewSkipped: 3, reviewRequiredAfterFailure: 1, medianDurationMs: 42_000 },
    { _tag: 'Review', runs: reviews, ready: Math.floor(reviews * 0.6), pending: Math.floor(reviews * 0.25), blocked: reviews - Math.floor(reviews * 0.6) - Math.floor(reviews * 0.25), findings, medianDurationMs: 8 * 60_000 },
    { _tag: 'Task', work: 'review_fix', runs: fixCommits, completed: fixCommits - 1, actionRequired: 1, failed: 0, superseded: 0, publishedCommits: fixCommits, changedFiles: fixCommits * 3, medianDurationMs: 11 * 60_000 },
    { _tag: 'Task', work: 'conflict_resolution', runs: conflicts, completed: conflicts, actionRequired: 0, failed: 0, superseded: 0, publishedCommits: conflicts, changedFiles: conflicts * 2, medianDurationMs: conflicts === 0 ? null : 5 * 60_000 },
    { _tag: 'Task', work: 'issue_work', runs: opened + 1, completed: opened, actionRequired: 0, failed: 1, superseded: 0, publishedCommits: opened, changedFiles: opened * 5, medianDurationMs: 27 * 60_000 },
    { _tag: 'Routine', runs: Math.max(1, Math.floor(days.length / 7)), completed: Math.max(1, Math.floor(days.length / 7)), actionRequired: 0, failed: 0, skipped: 0, superseded: 0, candidates: 6, medianDurationMs: 3 * 60_000 },
  ]
}

export default defineEventHandler((event): StatsSnapshot => {
  assertDevMock(event)
  const query = getQuery(event)
  const range = parseStatsRange({
    from: typeof query.from === 'string' ? query.from : undefined,
    to: typeof query.to === 'string' ? query.to : undefined,
    timeZone: typeof query.time_zone === 'string' ? query.time_zone : undefined,
  })
  if (range._tag === 'Err')
    throw createError({ statusCode: 400, statusMessage: `Stats range rejected: ${range.error._tag}.` })
  const from = Date.parse(range.value.from)
  const to = Date.parse(range.value.to)
  const days = daysBetween(from, to)
  const previousDays = daysBetween(from - (to - from), from)
  const comparison = (key: Exclude<keyof StatsDay, 'date'>) => ({ value: sum(days, key), previous: sum(previousDays, key) })
  const changed = (entries: StatsDay[]) => entries.filter(entry => entry.fixCommits + entry.conflictResolutions > 0).length
  return {
    generatedAt: new Date().toISOString(),
    range: range.value,
    previousRange: { from: new Date(from - (to - from)).toISOString(), to: range.value.from },
    coverage: {
      pullRequestTriage: from < Date.parse(triageRecordingStart) && to > serviceStart
        ? { _tag: 'Partial', startedAt: triageRecordingStart }
        : { _tag: 'Complete' },
    },
    summary: {
      changedPullRequests: { value: changed(days), previous: changed(previousDays) },
      conflictResolutions: comparison('conflictResolutions'),
      fixCommits: comparison('fixCommits'),
      openedPullRequests: comparison('openedPullRequests'),
      reviewFindings: comparison('reviewFindings'),
    },
    days,
    work: work(days),
  }
})
