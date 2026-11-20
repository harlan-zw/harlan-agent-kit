import type { AgentRole } from '../../../src/types.ts'
import type { RoutineResult, TimelineHistory, TimelineItemEvent, TimelineOutcome, TimelineRoutineInstant, TimelineRoutineRun, TimelineTaskRecord } from '../../app/utils/timeline.ts'

/**
 * A dev-only stand-in for the Timeline API. It agrees with the dev mock
 * snapshot about the items that are live now, and invents seven days of
 * history around them. Volumes follow Hogwild, measured 2026-11-20: about
 * 14,000 deliveries a day and between 3 and 192 Task starts a day.
 */

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour

function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const repositories = [
  'harlan-zw/nuxt-seo',
  'unjs/unhead',
  'harlan-zw/harlan-agent-kit',
  'nuxt-modules/og-image',
  'harlan-zw/gscdump.com',
  'harlan-zw/nuxtseo.com',
  'harlan-zw/skilld',
  'harlan-zw/request-indexing',
  'harlan-zw/unlighthouse',
  'nuxt-modules/sitemap',
  'nuxt-modules/robots',
  'harlan-zw/mdream',
]

const pullRequestTitles = [
  'fix(sitemap): dedupe i18n alternatives',
  'chore(deps): update minor and patch dependencies',
  'feat(og-image): cache satori fonts per build',
  'fix: hydrate useScript on the server',
  'docs: explain Routine schedules',
  'fix(robots): respect trailing slash config',
  'refactor: split the reconcile pass',
  'perf: stream the sitemap index',
  'fix(schema-org): keep breadcrumb order',
  'feat: add Passkey pairing link',
  'chore: migrate to Nuxt 4.6',
  'fix(unhead): avoid duplicate meta on navigation',
]

const issueTitles = [
  'Sitemap misses localized routes',
  'Satori fails on variable fonts',
  'Robots rules ignore route groups',
  'Crawler stalls on 429 responses',
  'Docs link to a removed composable',
  'Build fails on Windows paths',
]

/** Task starts per day, newest first, from the Hogwild journal for Nov 14 to Nov 20. */
const dailyStarts = [25, 90, 53, 192, 17, 21, 3]

interface RoutineSpec { id: string, repository: string, name: string, hour: number, minute: number, weekday?: number }

const routineSpecs: RoutineSpec[] = [
  { id: 'nuxtseo-daily', repository: 'harlan-zw/nuxtseo.com', name: 'daily-checkin', hour: 6, minute: 0 },
  { id: 'gscdump-daily', repository: 'harlan-zw/gscdump.com', name: 'daily-checkin', hour: 6, minute: 30 },
  { id: 'nuxtseo-vitals', repository: 'harlan-zw/nuxtseo.com', name: 'vitals-review', hour: 9, minute: 30 },
  { id: 'gscdump-d1', repository: 'harlan-zw/gscdump.com', name: 'd1-query-review', hour: 14, minute: 5 },
  { id: 'robots-seo', repository: 'nuxt-modules/robots', name: 'seo-review', hour: 0, minute: 0 },
  { id: 'kit-deps', repository: 'harlan-zw/harlan-agent-kit', name: 'dependency-updates', hour: 10, minute: 0, weekday: 1 },
  { id: 'kit-digest', repository: 'harlan-zw/harlan-agent-kit', name: 'ready-digest', hour: 8, minute: 0, weekday: 1 },
  { id: 'skilld-deps', repository: 'harlan-zw/skilld', name: 'dependency-updates', hour: 10, minute: 30, weekday: 3 },
  { id: 'nuxt-seo-triage', repository: 'harlan-zw/nuxt-seo', name: 'pr-triage', hour: 9, minute: 0 },
  // A daily Routine for most hours, as 111 Routines across 61 repositories give in practice.
  ...['sentry-checkin', 'seo-review', 'vitals-review', 'daily-checkin', 'perf-review', 'd1-query-review'].flatMap((name, index) =>
    [0, 1, 2, 3].map(slot => ({ id: `${name}-${slot}`, repository: repositories[(index * 4 + slot) % repositories.length]!, name, hour: (index * 4 + slot * 6 + 3) % 24, minute: (index * 17 + slot * 13) % 60 }))),
]

/** Every instant of a daily or weekly schedule inside `[from, to)`, in the server's local time. */
function instants(spec: RoutineSpec, from: number, to: number): number[] {
  const result: number[] = []
  const cursor = new Date(from)
  cursor.setHours(spec.hour, spec.minute, 0, 0)
  if (cursor.getTime() < from)
    cursor.setDate(cursor.getDate() + 1)
  while (cursor.getTime() < to) {
    if (spec.weekday === undefined || cursor.getDay() === spec.weekday)
      result.push(cursor.getTime())
    cursor.setDate(cursor.getDate() + 1)
  }
  return result
}

const reviewOutcome = (roll: number): TimelineOutcome => roll < 0.72 ? 'READY' : roll < 0.88 ? 'PENDING' : 'BLOCKED'
const workOutcome = (roll: number): TimelineOutcome => roll < 0.9 ? 'Completed' : 'Failed'

export function mockTimelineHistory(now = Date.now()): TimelineHistory {
  const anchor = Math.floor(now / hour) * hour
  const random = seeded(Math.floor(anchor / day))
  const start = anchor - 7 * day
  const tasks: TimelineTaskRecord[] = []
  let number = 900

  // Generated work, day by day. Each item runs one to three Tasks in sequence.
  dailyStarts.forEach((starts, daysBack) => {
    const dayStart = anchor - (daysBack + 1) * day
    const items = Math.max(1, Math.round(starts / 1.7))
    for (let index = 0; index < items; index++) {
      const at = dayStart + random() * day
      if (at > now - 20 * minute)
        continue
      const repository = repositories[Math.floor(random() ** 1.6 * repositories.length)]!
      const issue = random() < 0.25
      const steps: AgentRole[] = issue
        ? ['issue_triage', ...(random() < 0.4 ? ['issue_work' as const] : [])]
        : random() < 0.2
          ? ['conflict_resolution', 'adversarial_review']
          : random() < 0.3 ? ['adversarial_review', 'review_fix', 'adversarial_review'] : ['adversarial_review']
      number += 1
      const title = issue ? issueTitles[number % issueTitles.length]! : pullRequestTitles[number % pullRequestTitles.length]!
      let cursor = at
      steps.forEach((work, step) => {
        const length = (work === 'adversarial_review' ? 6 : work === 'issue_triage' ? 9 : 18) * minute * (0.6 + random())
        const end = cursor + length
        if (end > now - 5 * minute)
          return
        const last = step === steps.length - 1
        tasks.push({
          id: `mock-${number}-${step}`,
          repository,
          number,
          kind: issue ? 'issue' : 'pull_request',
          title,
          work,
          startedAt: new Date(cursor).toISOString(),
          endedAt: new Date(end).toISOString(),
          outcome: work === 'adversarial_review' ? (last ? reviewOutcome(random()) : 'BLOCKED') : work === 'issue_triage' && random() < 0.2 ? 'Needs info' : workOutcome(random()),
        })
        cursor = end + (2 + random() * 20) * minute
      })
    }
  })

  // The items the dev mock snapshot shows as live now, so rows and history agree.
  const ago = (minutes: number): string => new Date(now - minutes * minute).toISOString()
  const live = (id: string, repository: string, number: number, kind: 'issue' | 'pull_request', title: string, work: AgentRole, startedAgo: number, endedAgo: number, outcome: TimelineOutcome): TimelineTaskRecord =>
    ({ id, repository, number, kind, title, work, startedAt: ago(startedAgo), endedAt: ago(endedAgo), outcome })
  const sitemap = 'fix(sitemap): honour trailing slash on nested routes'
  const robots = 'feat(robots): allow per-route disallow rules'
  const useHead = 'useHead drops meta tags after client navigation'
  tasks.push(
    live('live-412-1', 'harlan-zw/nuxt-seo', 412, 'pull_request', sitemap, 'adversarial_review', 212, 203, 'BLOCKED'),
    live('live-412-2', 'harlan-zw/nuxt-seo', 412, 'pull_request', sitemap, 'review_fix', 196, 171, 'Completed'),
    live('live-412-3', 'harlan-zw/nuxt-seo', 412, 'pull_request', sitemap, 'adversarial_review', 168, 160, 'BLOCKED'),
    live('live-418-1', 'harlan-zw/nuxt-seo', 418, 'pull_request', robots, 'adversarial_review', 124, 116, 'PENDING'),
    live('live-731-1', 'unjs/unhead', 731, 'issue', useHead, 'issue_triage', 166, 155, 'Needs info'),
    live('live-731-2', 'unjs/unhead', 731, 'issue', useHead, 'issue_triage', 27, 16, 'Completed'),
    live('live-399-1', 'harlan-zw/nuxt-seo', 399, 'issue', 'Schema.org breadcrumbs miss the home crumb', 'issue_triage', 286, 271, 'Completed'),
    live('done-405-conflict', 'harlan-zw/nuxt-seo', 405, 'pull_request', 'fix(schema-org): dedupe breadcrumb nodes', 'conflict_resolution', 62, 50, 'Completed'),
    live('done-405-review', 'harlan-zw/nuxt-seo', 405, 'pull_request', 'fix(schema-org): dedupe breadcrumb nodes', 'adversarial_review', 49, 41, 'READY'),
    live('done-702-work', 'unjs/unhead', 702, 'issue', 'useSeoMeta ignores reactive getters', 'issue_work', 171, 140, 'Failed'),
  )
  tasks.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))

  // Work-causing deliveries per item: the GitHub event right before each Task, plus pushes and comments between.
  const itemEvents: TimelineItemEvent[] = tasks.map(task => ({
    repository: task.repository,
    number: task.number,
    at: new Date(Date.parse(task.startedAt) - (0.3 + random() * 0.6) * minute).toISOString(),
    event: task.kind === 'issue' ? (task.work === 'issue_triage' ? 'issues · opened' : 'issue_comment · created') : (task.work === 'review_fix' ? 'issue_comment · created' : 'pull_request · synchronize'),
  }))
  itemEvents.push(
    { repository: 'harlan-zw/nuxt-seo', number: 418, at: ago(8), event: 'pull_request · synchronize' },
    { repository: 'harlan-zw/nuxt-seo', number: 420, at: ago(31), event: 'pull_request · opened' },
    { repository: 'harlan-zw/nuxt-seo', number: 421, at: ago(11), event: 'pull_request · converted_to_draft' },
    { repository: 'harlan-zw/nuxt-seo', number: 412, at: ago(5), event: 'pull_request · synchronize' },
  )

  // Routine runs on their schedule. A run that spent no Agent turn is Unchanged.
  const routineRuns: TimelineRoutineRun[] = []
  const upcoming: TimelineRoutineInstant[] = []
  for (const spec of routineSpecs) {
    for (const at of instants(spec, start, now)) {
      const roll = random()
      const result: RoutineResult = roll < 0.55 ? 'Clear' : roll < 0.8 ? 'Unchanged' : roll < 0.93 ? 'Action required' : roll < 0.97 ? 'Skipped' : 'Blocked'
      const length = result === 'Unchanged' || result === 'Skipped' ? 0 : (6 + random() * 14) * minute
      routineRuns.push({ routineId: spec.id, repository: spec.repository, name: spec.name, scheduledFor: new Date(at).toISOString(), endedAt: length === 0 ? null : new Date(Math.min(at + length, now)).toISOString(), result })
    }
    for (const at of instants(spec, now, now + 2 * day))
      upcoming.push({ routineId: spec.id, repository: spec.repository, name: spec.name, at: new Date(at).toISOString() })
  }

  // Deliveries per minute: a day and night rhythm, the day's load, and check bursts after each Task starts.
  const minutes = Math.floor((now - start) / minute)
  const counts = Array.from<number>({ length: minutes }).fill(0)
  for (let index = 0; index < minutes; index++) {
    const at = start + index * minute
    const daysBack = Math.min(6, Math.floor((anchor - at) / day))
    const load = dailyStarts[Math.max(0, daysBack)]! / 60
    const local = new Date(at).getHours() + new Date(at).getMinutes() / 60
    const rhythm = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(((local - 7) / 24) * Math.PI * 2))
    counts[index] = Math.round(rhythm * (3 + load * 9) * (0.4 + random() * 1.2))
  }
  for (const record of tasks) {
    const first = Math.floor((Date.parse(record.startedAt) - start) / minute)
    for (let offset = 0; offset < 14; offset++) {
      if (first + offset >= 0 && first + offset < minutes)
        counts[first + offset]! += Math.round(22 * Math.exp(-offset / 4) * (0.6 + random() * 0.8))
    }
  }

  return {
    generatedAt: new Date(now).toISOString(),
    deliveries: { start: new Date(start).toISOString(), bucketSeconds: 60, counts },
    tasks,
    itemEvents,
    routineRuns,
    upcoming,
    pauses: [{ from: new Date(anchor - 5 * day + 2 * hour).toISOString(), to: new Date(anchor - 5 * day + 9 * hour).toISOString() }],
  }
}
