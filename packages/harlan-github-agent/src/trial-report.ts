import type { JournalStore } from './store.ts'
import type { ReadyPullRequest, ReviewGateName, TrialIssueRoute, TrialRange, TrialRetroCandidate, TrialReviewedHead, TrialReviewedMerge, TrialRoutineRun } from './trial-store.ts'
import type { ReadyWait, Trial, TrialMeasure, TrialMiss } from './trials.ts'
import type { ReviewOutcome, Routine } from './types.ts'
import { TRIALS } from './trials.ts'

const dayMilliseconds = 24 * 60 * 60 * 1000
const weekMilliseconds = 7 * dayMilliseconds
const reportTimeZone = 'Australia/Melbourne'

type MeasuredTrial = Extract<Trial, { _tag: 'Measured' }>

export type TrialState
  = | { _tag: 'NotStarted', reason: string }
    | { _tag: 'Running', startedAt: string, endsAt: string, week: number, weeks: number }
    | { _tag: 'Ended', startedAt: string, endedAt: string }

/**
 * How one keep or kill rule reads this week.
 *
 * A rule that only Harlan can settle stays `OwnerCheck`, so the report
 * can never call it met.
 */
export type RuleReading
  = | { _tag: 'Met', detail: string }
    | { _tag: 'NotMet', detail: string }
    | { _tag: 'OwnerCheck', detail: string }
    | { _tag: 'NotYetMeasurable', detail: string }

/** A trial verdict recommends; Harlan decides. It is separate from a Payback verdict. */
export interface TrialSuggestion {
  /** `Revise` ends a measurement trial that missed its keep rule. Such a trial is never killed. */
  verdict: 'Keep' | 'Kill' | 'Continue' | 'Revise'
  reason: string
}

export interface TrialWindow extends TrialRange {
  days: number
}

export interface CheckinGroupTotals {
  sites: number
  runs: number
  agentRuns: number
  unchangedRuns: number
  failedRuns: number
  issuesRequested: number
  inputTokens: number
  issuesPerSiteWeek: number | null
  agentRunsPerSiteWeek: number | null
}

export interface CheckinWindow {
  window: TrialWindow
  whenChanged: CheckinGroupTotals
  everyRun: CheckinGroupTotals
}

type CheckinSchedule = 'WhenChanged' | 'EveryRun'

export interface CheckinScheduleMismatch {
  repository: string
  expected: CheckinSchedule
  actual: CheckinSchedule | 'NotScheduled'
}

export interface DiscussionWindow {
  window: TrialWindow
  classifiedIssues: number
  discussionIssues: number
  skipsTriageIssues: number
  skipsTriageShare: number | null
}

export interface DiscussionIssue {
  issue: string
  url: string
  confidence: number
  needsCodebaseReview: number
  skipsTriage: boolean
}

export interface PathRuleWindow {
  window: TrialWindow
  reviewedHeads: number
  flaggedHeads: number
  flaggedShare: number | null
  flaggedEndedBlocked: number
}

export interface BlockedFlaggedHead {
  pullRequest: string
  url: string
  headSha: string
  fileCount: number | null
  failedGates: ReviewGateName[]
}

export interface RetroWeek {
  week: number
  window: TrialWindow
  candidates: number
  /** Candidates the controller filed an issue for. */
  issues: number
  /** Candidates whose pull request merged within the allowed days. */
  mergedInTime: number
  /** Unmerged Candidates whose allowed days have not passed. */
  open: number
}

/** Reviewed merges of one origin, and how many a revert reached in time. */
export interface ReviewRevertRow {
  /** Service: a service publication opened the pull request. Person: anyone else did. */
  openedBy: 'Service' | 'Person'
  merged: number
  ready: number
  /** Reverted within the trial's revert days. */
  reverted: number
  readyReverted: number
  /** READY merges that were reverted in time or whose revert days have passed. */
  readyJudged: number
}

/** One reviewed merge a later merge reverted in time. Titles are left out, because a repository can be private. */
export interface RevertedMerge {
  pullRequest: string
  url: string
  outcome: ReviewOutcome['_tag']
  revertedBy: number
}

export interface RetroToDate {
  window: TrialWindow
  candidates: number
  issues: number
  mergedInTime: number
  /** Candidates that merged in time or whose allowed days have passed. */
  judged: number
  mergedShare: number | null
  open: number
}

export type TrialMetrics
  = | {
    _tag: 'CheckinWhenChanged'
    lastSevenDays: CheckinWindow
    toDate: CheckinWindow
    beforeTrial: CheckinWindow
    /** `daily-checkin` repositories in neither group. */
    otherRepositories: string[]
    scheduleMismatches: CheckinScheduleMismatch[]
  }
  | {
    _tag: 'DiscussionRouteShadow'
    lastSevenDays: DiscussionWindow
    toDate: DiscussionWindow
    /** DISCUSSION issues of the last 7 days, those that stay out of Issue triage first. Titles are left out, because a repository can be private and the run log is public. */
    issues: DiscussionIssue[]
    omittedIssues: number
    unreadableReadings: number
  }
  | {
    _tag: 'PathRuleShadow'
    lastSevenDays: PathRuleWindow
    toDate: PathRuleWindow
    blockedHeads: BlockedFlaggedHead[]
    omittedHeads: number
  }
  | {
    _tag: 'ReadyWait'
    overdueDays: number
    /** The reading at this report's instant. */
    current: ReadyWait
    baseline: ReadyWait & { measuredAt: string }
  }
  | {
    _tag: 'RetroFollowThrough'
    /** Days a Candidate has to reach a merged pull request. */
    mergeDays: number
    weeks: RetroWeek[]
    toDate: RetroToDate
  }
  | {
    _tag: 'ReviewReverts'
    revertDays: number
    /** The service row first, then the person row. */
    rows: ReviewRevertRow[]
    reverted: RevertedMerge[]
  }

export type TrialReading
  = | { _tag: 'Parked', id: string, title: string, reason: string, markdown: string }
    | {
      _tag: 'Measured'
      id: string
      title: string
      metric: string
      keepRule: string
      killRule: string
      before: string
      state: TrialState
      /** Null until the trial starts. */
      metrics: TrialMetrics | null
      keep: RuleReading[]
      kill: RuleReading[]
      suggestion: TrialSuggestion
      markdown: string
    }

export interface TrialReportEvidence {
  observedAt: string
  trials: TrialReading[]
}

export type TrialReportSource = Pick<JournalStore, 'listRoutines' | 'listTrialRoutineRuns' | 'listTrialIssueRoutes' | 'listTrialReviewedHeads' | 'firstTrialEventAt' | 'listReadyPullRequests' | 'listTrialRetroCandidates' | 'listTrialReviewedMerges'>

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString()
}

function window(from: number, to: number): TrialWindow {
  return { from: iso(from), to: iso(to), days: Math.max(0, to - from) / dayMilliseconds }
}

function share(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole
}

function perSiteWeek(count: number, sites: number, days: number): number | null {
  return sites === 0 || days === 0 ? null : count / sites / (days / 7)
}

function number(value: number | null): string {
  return value === null ? 'n/a' : String(Math.round(value * 10) / 10)
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`
}

function plural(count: number, singular: string, many = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : many}`
}

function localDate(instant: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: reportTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant))
}

/** Where a trial stands at one instant. Null `startedAt` means its first event has not happened. */
export function trialState(trial: Pick<MeasuredTrial, 'weeks'>, startedAt: string | null, now: Date, notStarted: string): TrialState {
  if (startedAt === null)
    return { _tag: 'NotStarted', reason: notStarted }
  const start = Date.parse(startedAt)
  const end = start + trial.weeks * weekMilliseconds
  if (now.getTime() < start)
    return { _tag: 'NotStarted', reason: `It starts ${localDate(iso(start))}.` }
  if (now.getTime() >= end)
    return { _tag: 'Ended', startedAt: iso(start), endedAt: iso(end) }
  return { _tag: 'Running', startedAt: iso(start), endsAt: iso(end), week: Math.floor((now.getTime() - start) / weekMilliseconds) + 1, weeks: trial.weeks }
}

/** One run's own words: whether it spent no Agent turn, and how many issues it requested. */
export function readCheckinEvidence(evidence: string): { unchanged: boolean, issuesRequested: number } {
  const parts = evidence.split(' | ')
  const requested = /^(\d+) issues requested$/.exec(parts.at(-1) ?? '')
  return {
    unchanged: parts.some(part => part.startsWith('unchanged since run ')),
    issuesRequested: requested === null ? 0 : Number(requested[1]),
  }
}

function checkinTotals(runs: readonly TrialRoutineRun[], repositories: ReadonlySet<string>, scheduled: ReadonlySet<string>, span: TrialWindow): CheckinGroupTotals {
  const inGroup = runs.filter(run => repositories.has(run.repository) && Date.parse(run.scheduledFor) >= Date.parse(span.from) && Date.parse(run.scheduledFor) < Date.parse(span.to))
  let agentRuns = 0
  let unchangedRuns = 0
  let failedRuns = 0
  let issuesRequested = 0
  let inputTokens = 0
  const active = new Set([...repositories].filter(repository => scheduled.has(repository)))
  for (const run of inGroup) {
    if (run.state === 'Failed' || run.state === 'ActionRequired') {
      failedRuns += 1
      active.add(run.repository)
      continue
    }
    if (run.state !== 'Completed' || run.evidence === null)
      continue
    active.add(run.repository)
    const read = readCheckinEvidence(run.evidence)
    if (read.unchanged)
      unchangedRuns += 1
    else
      agentRuns += 1
    issuesRequested += read.issuesRequested
    inputTokens += run.inputTokens ?? 0
  }
  return {
    sites: active.size,
    runs: agentRuns + unchangedRuns + failedRuns,
    agentRuns,
    unchangedRuns,
    failedRuns,
    issuesRequested,
    inputTokens,
    issuesPerSiteWeek: perSiteWeek(issuesRequested, active.size, span.days),
    agentRunsPerSiteWeek: perSiteWeek(agentRuns, active.size, span.days),
  }
}

/** Reads the `daily-checkin` trial from its runs and the schedules on record. Pure. */
export function readCheckinTrial(input: {
  measure: Extract<TrialMeasure, { _tag: 'CheckinWhenChanged' }>
  runs: readonly TrialRoutineRun[]
  schedules: ReadonlyArray<Pick<Routine, 'repository' | 'when'>>
  windows: { lastSevenDays: TrialWindow, toDate: TrialWindow, beforeTrial: TrialWindow }
}): { metrics: Extract<TrialMetrics, { _tag: 'CheckinWhenChanged' }>, keep: RuleReading[], kill: RuleReading[] } {
  const whenChanged = new Set(input.measure.whenChangedRepositories)
  const everyRun = new Set(input.measure.everyRunRepositories)
  const scheduled = new Set(input.schedules.map(schedule => schedule.repository))
  const windowed = (span: TrialWindow): CheckinWindow => ({
    window: span,
    whenChanged: checkinTotals(input.runs, whenChanged, scheduled, span),
    everyRun: checkinTotals(input.runs, everyRun, scheduled, span),
  })
  const toDate = windowed(input.windows.toDate)
  const scheduleOf = (repository: string): CheckinScheduleMismatch['actual'] => {
    const schedule = input.schedules.find(candidate => candidate.repository === repository)
    return schedule === undefined ? 'NotScheduled' : schedule.when === 'changed' ? 'WhenChanged' : 'EveryRun'
  }
  const scheduleMismatches = [
    ...input.measure.whenChangedRepositories.map(repository => ({ repository, expected: 'WhenChanged' as const, actual: scheduleOf(repository) })),
    ...input.measure.everyRunRepositories.map(repository => ({ repository, expected: 'EveryRun' as const, actual: scheduleOf(repository) })),
  ].filter(entry => entry.actual !== entry.expected)
  const otherRepositories = [...new Set([...scheduled, ...input.runs.map(run => run.repository)])]
    .filter(repository => !whenChanged.has(repository) && !everyRun.has(repository))
    .sort()

  const changed = toDate.whenChanged
  const every = toDate.everyRun
  const keep: RuleReading[] = changed.runs === 0 || every.runs === 0
    ? [
        { _tag: 'NotYetMeasurable', detail: 'One group of sites has no settled run yet.' },
        { _tag: 'NotYetMeasurable', detail: 'One group of sites has no settled run yet.' },
      ]
    : [
        (changed.issuesPerSiteWeek ?? 0) >= (every.issuesPerSiteWeek ?? 0)
          ? { _tag: 'Met', detail: `${number(changed.issuesPerSiteWeek)} against ${number(every.issuesPerSiteWeek)} issues requested per site per week.` }
          : { _tag: 'NotMet', detail: `${number(changed.issuesPerSiteWeek)} against ${number(every.issuesPerSiteWeek)} issues requested per site per week.` },
        every.agentRunsPerSiteWeek === null || every.agentRunsPerSiteWeek === 0
          ? { _tag: 'NotYetMeasurable', detail: 'Sites that run every time spent no Agent run yet.' }
          : {
              _tag: (changed.agentRunsPerSiteWeek ?? 0) <= every.agentRunsPerSiteWeek * 0.5 ? 'Met' : 'NotMet',
              detail: `${number(changed.agentRunsPerSiteWeek)} against ${number(every.agentRunsPerSiteWeek)} Agent runs per site per week, ${percent(1 - (changed.agentRunsPerSiteWeek ?? 0) / every.agentRunsPerSiteWeek)} fewer.`,
            },
      ]
  const kill: RuleReading[] = [changed.unchangedRuns === 0
    ? { _tag: 'NotMet', detail: 'No unchanged run yet, so no check-in was held back.' }
    : { _tag: 'OwnerCheck', detail: `Check the ${plural(changed.unchangedRuns, 'unchanged run')} for a production problem the check-in missed.` }]
  return {
    metrics: {
      _tag: 'CheckinWhenChanged',
      lastSevenDays: windowed(input.windows.lastSevenDays),
      toDate,
      beforeTrial: windowed(input.windows.beforeTrial),
      otherRepositories,
      scheduleMismatches,
    },
    keep,
    kill,
  }
}

function latestPerIssue(readings: readonly TrialIssueRoute[], span: TrialWindow): TrialIssueRoute[] {
  const latest = new Map<string, TrialIssueRoute>()
  for (const reading of readings) {
    const at = Date.parse(reading.occurredAt)
    if (at < Date.parse(span.from) || at >= Date.parse(span.to))
      continue
    const key = `${reading.repository}#${reading.issueNumber}`
    const known = latest.get(key)
    if (known === undefined || Date.parse(known.occurredAt) <= at)
      latest.set(key, reading)
  }
  return [...latest.values()]
}

function discussionWindow(readings: readonly TrialIssueRoute[], span: TrialWindow): DiscussionWindow {
  const issues = latestPerIssue(readings, span)
  const skipsTriageIssues = issues.filter(reading => reading.skipsTriage).length
  return {
    window: span,
    classifiedIssues: issues.length,
    discussionIssues: issues.filter(reading => reading.route === 'DISCUSSION').length,
    skipsTriageIssues,
    skipsTriageShare: share(skipsTriageIssues, issues.length),
  }
}

/** Reads the Discussion route trial from its shadow readings. Pure. */
export function readDiscussionTrial(input: {
  measure: Extract<TrialMeasure, { _tag: 'DiscussionRouteShadow' }>
  readings: readonly TrialIssueRoute[]
  unreadable: number
  windows: { lastSevenDays: TrialWindow, toDate: TrialWindow }
}): { metrics: Extract<TrialMetrics, { _tag: 'DiscussionRouteShadow' }>, keep: RuleReading[], kill: RuleReading[] } {
  const { measure } = input
  const toDate = discussionWindow(input.readings, input.windows.toDate)
  const routed = latestPerIssue(input.readings, input.windows.lastSevenDays)
    .filter(reading => reading.route === 'DISCUSSION')
    .sort((left, right) => Number(right.skipsTriage) - Number(left.skipsTriage) || right.confidence - left.confidence)
  const issues = routed.slice(0, measure.listLimit).map(reading => ({
    issue: `${reading.repository}#${reading.issueNumber}`,
    url: `https://github.com/${reading.repository}/issues/${reading.issueNumber}`,
    confidence: reading.confidence,
    needsCodebaseReview: reading.needsCodebaseReview,
    skipsTriage: reading.skipsTriage,
  }))
  const confident = latestPerIssue(input.readings, input.windows.toDate)
    .filter(reading => reading.route === 'DISCUSSION' && reading.confidence >= measure.killConfidence)
    .length
  const keep: RuleReading[] = [
    routed.length === 0
      ? { _tag: 'NotYetMeasurable', detail: 'No issue was routed DISCUSSION in the last 7 days.' }
      : { _tag: 'OwnerCheck', detail: `Label ${routed.length > measure.labelSample ? `the first ${measure.labelSample} listed issues` : `the ${plural(routed.length, 'listed issue')}`}. Keep needs at least 95% to be real discussions.` },
    toDate.skipsTriageShare === null
      ? { _tag: 'NotYetMeasurable', detail: 'No issue was classified yet.' }
      : {
          _tag: toDate.skipsTriageShare >= measure.minimumTriageShare ? 'Met' : 'NotMet',
          detail: `In shadow mode, ${percent(toDate.skipsTriageShare)} of classified issues would stay out of Issue triage. Live mode must confirm it.`,
        },
  ]
  const kill: RuleReading[] = [confident === 0
    ? { _tag: 'NotMet', detail: `No issue was routed DISCUSSION at ${measure.killConfidence} or above.` }
    : { _tag: 'OwnerCheck', detail: `Label the ${plural(confident, 'issue')} routed DISCUSSION at ${measure.killConfidence} or above. One real defect kills the trial.` }]
  return {
    metrics: {
      _tag: 'DiscussionRouteShadow',
      lastSevenDays: discussionWindow(input.readings, input.windows.lastSevenDays),
      toDate,
      issues,
      omittedIssues: routed.length - issues.length,
      unreadableReadings: input.unreadable,
    },
    keep,
    kill,
  }
}

function pathRuleWindow(heads: readonly TrialReviewedHead[], span: TrialWindow): PathRuleWindow {
  const flagged = heads.filter(head => head.flagged)
  return {
    window: span,
    reviewedHeads: heads.length,
    flaggedHeads: flagged.length,
    flaggedShare: share(flagged.length, heads.length),
    flaggedEndedBlocked: flagged.filter(head => head.outcome === 'Blocked').length,
  }
}

/** Reads the path rule trial from the heads Review ran on. Pure. */
export function readPathRuleTrial(input: {
  measure: Extract<TrialMeasure, { _tag: 'PathRuleShadow' }>
  lastSevenDays: { window: TrialWindow, heads: readonly TrialReviewedHead[] }
  toDate: { window: TrialWindow, heads: readonly TrialReviewedHead[] }
}): { metrics: Extract<TrialMetrics, { _tag: 'PathRuleShadow' }>, keep: RuleReading[], kill: RuleReading[] } {
  const toDate = pathRuleWindow(input.toDate.heads, input.toDate.window)
  const blocked = input.toDate.heads.filter(head => head.flagged && head.outcome === 'Blocked')
  const blockedHeads = blocked.slice(0, input.measure.listLimit).map(head => ({
    pullRequest: `${head.repository}#${head.pullRequestNumber}`,
    url: `https://github.com/${head.repository}/pull/${head.pullRequestNumber}`,
    headSha: head.headSha.slice(0, 12),
    fileCount: head.fileCount,
    failedGates: head.failedGates,
  }))
  const keep: RuleReading[] = toDate.reviewedHeads === 0
    ? [
        { _tag: 'NotYetMeasurable', detail: 'Review has not finished on any head yet.' },
        { _tag: 'NotYetMeasurable', detail: 'Review has not finished on any head yet.' },
      ]
    : [
        toDate.flaggedEndedBlocked === 0
          ? { _tag: 'Met', detail: `No flagged head ended Blocked, of ${toDate.flaggedHeads} flagged.` }
          : { _tag: 'NotMet', detail: `${toDate.flaggedEndedBlocked} of ${toDate.flaggedHeads} flagged heads ended Blocked.` },
        {
          _tag: (toDate.flaggedShare ?? 0) >= input.measure.minimumFlaggedShare ? 'Met' : 'NotMet',
          detail: `${percent(toDate.flaggedShare)} of ${toDate.reviewedHeads} reviewed heads qualify.`,
        },
      ]
  const kill: RuleReading[] = [blocked.length === 0
    ? { _tag: 'NotMet', detail: 'No flagged head ended Blocked.' }
    : { _tag: 'OwnerCheck', detail: `Read the ${plural(blocked.length, 'flagged head')} that ended Blocked. A real defect kills the trial.` }]
  return {
    metrics: { _tag: 'PathRuleShadow', lastSevenDays: pathRuleWindow(input.lastSevenDays.heads, input.lastSevenDays.window), toDate, blockedHeads, omittedHeads: blocked.length - blockedHeads.length },
    keep,
    kill,
  }
}

/** READY pull requests at one instant, and those READY longer than `overdueDays`. Pure. */
export function readyWait(pullRequests: readonly ReadyPullRequest[], now: Date, overdueDays: number): ReadyWait {
  const ages = pullRequests.map(pullRequest => (now.getTime() - Date.parse(pullRequest.readyAt)) / dayMilliseconds)
  const overdue = ages.filter(age => age > overdueDays)
  return { ready: ages.length, overdue: overdue.length, oldestDays: overdue.length === 0 ? null : Math.floor(Math.max(...overdue)) }
}

/** Reads the `ready-digest` trial: the overdue READY pull requests it exists to clear, against the first run. Pure. */
export function readReadyWaitTrial(input: {
  measure: Extract<TrialMeasure, { _tag: 'ReadyWait' }>
  pullRequests: readonly ReadyPullRequest[]
  now: Date
  /** The trial week this reading falls in. */
  week: number
}): { metrics: Extract<TrialMetrics, { _tag: 'ReadyWait' }>, keep: RuleReading[], kill: RuleReading[] } {
  const { measure } = input
  const current = readyWait(input.pullRequests, input.now, measure.overdueDays)
  const before = measure.baseline.overdue
  const oldest = current.oldestDays === null ? '' : ` The oldest has waited ${plural(current.oldestDays, 'day')}.`
  const keep: RuleReading[] = [before === 0
    ? { _tag: 'NotYetMeasurable', detail: `No pull request had waited more than ${measure.overdueDays} days at the first run, so no fall can be measured.` }
    : {
        _tag: current.overdue <= before * (1 - measure.minimumDrop) ? 'Met' : 'NotMet',
        detail: `${plural(current.overdue, 'pull request')} READY with passing CI for over ${measure.overdueDays} days, against ${before} at the first run: ${current.overdue <= before ? `${percent(1 - current.overdue / before)} fewer` : `${percent(current.overdue / before - 1)} more`}. Keep needs ${percent(measure.minimumDrop)} fewer.${oldest}`,
      }]
  const kill: RuleReading[] = [input.week < measure.readCheckWeek
    ? { _tag: 'NotYetMeasurable', detail: `From week ${measure.readCheckWeek}, Harlan says whether he still reads the ready digest.` }
    : { _tag: 'OwnerCheck', detail: `Do you still read the \`ready-digest\` comment each Monday? If you stopped by week ${measure.readCheckWeek}, the trial ends.` }]
  return { metrics: { _tag: 'ReadyWait', overdueDays: measure.overdueDays, current, baseline: measure.baseline }, keep, kill }
}

/** Reads the `agent-retro` follow-through trial from its Candidates. Pure. */
export function readRetroTrial(input: {
  measure: Extract<TrialMeasure, { _tag: 'RetroFollowThrough' }>
  candidates: readonly TrialRetroCandidate[]
  now: Date
  toDate: TrialWindow
}): { metrics: Extract<TrialMetrics, { _tag: 'RetroFollowThrough' }>, keep: RuleReading[], kill: RuleReading[] } {
  const { measure } = input
  const allowed = measure.mergeDays * dayMilliseconds
  const now = input.now.getTime()
  const read = input.candidates.map((candidate) => {
    const created = Date.parse(candidate.createdAt)
    const merged = candidate.mergedAt === null ? null : Date.parse(candidate.mergedAt)
    const mergedInTime = merged !== null && merged <= now && merged - created <= allowed
    return { created, issue: candidate.issueNumber !== null, mergedInTime, judged: mergedInTime || created + allowed <= now }
  })
  const count = (from: number, to: number) => {
    const inside = read.filter(candidate => candidate.created >= from && candidate.created < to)
    return {
      candidates: inside.length,
      issues: inside.filter(candidate => candidate.issue).length,
      mergedInTime: inside.filter(candidate => candidate.mergedInTime).length,
      judged: inside.filter(candidate => candidate.judged).length,
      open: inside.filter(candidate => !candidate.judged).length,
    }
  }
  const start = Date.parse(input.toDate.from)
  const end = Date.parse(input.toDate.to)
  const weeks: RetroWeek[] = Array.from({ length: Math.ceil((end - start) / weekMilliseconds) }, (_, index) => {
    const span = window(start + index * weekMilliseconds, Math.min(end, start + (index + 1) * weekMilliseconds))
    const counts = count(Date.parse(span.from), Date.parse(span.to))
    return { week: index + 1, window: span, candidates: counts.candidates, issues: counts.issues, mergedInTime: counts.mergedInTime, open: counts.open }
  })
  const totals = count(start, end)
  const toDate: RetroToDate = { window: input.toDate, ...totals, mergedShare: share(totals.mergedInTime, totals.judged) }
  const judged = `${totals.mergedInTime} of ${plural(totals.judged, 'judged Candidate')} merged a pull request within ${measure.mergeDays} days.`
  const keep: RuleReading[] = [toDate.mergedShare === null
    ? { _tag: 'NotYetMeasurable', detail: totals.candidates === 0 ? 'No `agent-retro` Candidate since the trial started.' : `No Candidate has had ${measure.mergeDays} days yet.` }
    : toDate.mergedShare >= measure.minimumMergedShare
      ? { _tag: 'Met', detail: judged }
      : { _tag: 'NotMet', detail: `${judged} Keep needs ${percent(measure.minimumMergedShare)}, so the retro prompt needs work.` }]
  // Measurement only: nothing about this trial can end it.
  return { metrics: { _tag: 'RetroFollowThrough', mergeDays: measure.mergeDays, weeks, toDate }, keep, kill: [] }
}

/**
 * Reads the revert trial from the reviewed merges of the trial so far. Pure.
 *
 * A merge is judged once a revert reached it in time or its revert days have
 * passed, so a recent merge never reads as a clean one.
 */
export function readReviewRevertTrial(input: {
  measure: Extract<TrialMeasure, { _tag: 'ReviewReverts' }>
  merges: readonly TrialReviewedMerge[]
  now: Date
}): { metrics: Extract<TrialMetrics, { _tag: 'ReviewReverts' }>, keep: RuleReading[], kill: RuleReading[] } {
  const { measure } = input
  const allowed = measure.revertDays * dayMilliseconds
  const now = input.now.getTime()
  const read = input.merges.map((merge) => {
    const merged = Date.parse(merge.mergedAt)
    const reverted = merge.revertedAt !== null && Date.parse(merge.revertedAt) - merged <= allowed
    return { merge, ready: merge.outcome === 'Ready', reverted, judged: reverted || merged + allowed <= now }
  })
  const rows: ReviewRevertRow[] = (['Service', 'Person'] as const).map((openedBy) => {
    const mine = read.filter(entry => entry.merge.serviceOpened === (openedBy === 'Service'))
    const ready = mine.filter(entry => entry.ready)
    return {
      openedBy,
      merged: mine.length,
      ready: ready.length,
      reverted: mine.filter(entry => entry.reverted).length,
      readyReverted: ready.filter(entry => entry.reverted).length,
      readyJudged: ready.filter(entry => entry.judged).length,
    }
  })
  const reverted: RevertedMerge[] = read.flatMap(entry => entry.reverted && entry.merge.revertedBy !== null
    ? [{ pullRequest: `${entry.merge.repository}#${entry.merge.pullRequestNumber}`, url: entry.merge.url, outcome: entry.merge.outcome, revertedBy: entry.merge.revertedBy }]
    : [])
  const readyReverted = rows.reduce((sum, row) => sum + row.readyReverted, 0)
  const readyJudged = rows.reduce((sum, row) => sum + row.readyJudged, 0)
  const readyMerged = rows.reduce((sum, row) => sum + row.ready, 0)
  const revertedShare = share(readyReverted, readyJudged)
  const judged = `${readyReverted} of ${plural(readyJudged, 'judged READY merge')} reverted within ${measure.revertDays} days.`
  const keep: RuleReading[] = [revertedShare === null
    ? { _tag: 'NotYetMeasurable', detail: readyMerged === 0 ? 'No READY merge since the trial started.' : `No READY merge has had ${measure.revertDays} days yet.` }
    : revertedShare <= measure.maximumReadyRevertedShare
      ? { _tag: 'Met', detail: judged }
      : { _tag: 'NotMet', detail: `${judged} Keep allows ${percent(measure.maximumReadyRevertedShare)}, so Review needs work.` }]
  // Measurement only: nothing about this trial can end it.
  return { metrics: { _tag: 'ReviewReverts', revertDays: measure.revertDays, rows, reverted }, keep, kill: [] }
}

/** Keep, kill, revise, or continue, from the state and the rule readings. Pure. */
export function suggestVerdict(state: TrialState, keep: readonly RuleReading[], kill: readonly RuleReading[], onMiss: TrialMiss): TrialSuggestion {
  if (state._tag === 'NotStarted')
    return { verdict: 'Continue', reason: 'The trial has not started.' }
  const killed = kill.find(rule => rule._tag === 'Met')
  if (killed !== undefined)
    return { verdict: 'Kill', reason: `The kill rule is met. ${killed.detail}` }
  if (state._tag === 'Running')
    return { verdict: 'Continue', reason: `Week ${state.week} of ${state.weeks}. The trial ends ${localDate(state.endsAt)}.` }
  const missed = keep.find(rule => rule._tag === 'NotMet')
  if (missed !== undefined) {
    return onMiss._tag === 'Kill'
      ? { verdict: 'Kill', reason: `The trial ended and the keep rule is not met. ${missed.detail}` }
      : { verdict: 'Revise', reason: `The trial ended and the keep rule is not met. ${onMiss.what} needs work. ${missed.detail}` }
  }
  const unread = keep.filter(rule => rule._tag !== 'Met')
  if (unread.length > 0)
    return { verdict: 'Continue', reason: `The trial ended. Decide after this: ${unread.map(rule => rule.detail).join(' ')}` }
  // The end date decides on the keep rule. A kill check that needs Harlan stays named, never assumed clear.
  const open = kill.filter(rule => rule._tag !== 'NotMet')
  return {
    verdict: 'Keep',
    reason: open.length === 0
      ? 'The trial ended, the keep rule is met, and nothing triggered the kill rule.'
      : `The trial ended and the keep rule is met. Keep unless this finds a problem: ${open.map(rule => rule.detail).join(' ')}`,
  }
}

const RULE_LABEL: Record<RuleReading['_tag'], string> = {
  Met: 'met',
  NotMet: 'not met',
  OwnerCheck: 'needs Harlan',
  NotYetMeasurable: 'not measurable yet',
}

function stateLine(state: TrialState): string {
  switch (state._tag) {
    case 'NotStarted': return `Not started. ${state.reason}`
    case 'Running': return `Running: week ${state.week} of ${state.weeks}. Started ${localDate(state.startedAt)}, ends ${localDate(state.endsAt)}.`
    case 'Ended': return `Ended ${localDate(state.endedAt)}. Started ${localDate(state.startedAt)}.`
  }
}

function metricLines(metrics: TrialMetrics): string[] {
  switch (metrics._tag) {
    case 'CheckinWhenChanged': {
      const row = (label: string, read: (window: CheckinWindow) => number | null) =>
        `| ${label} | ${[metrics.lastSevenDays, metrics.toDate, metrics.beforeTrial].map(window => number(read(window))).join(' | ')} |`
      const changed = metrics.toDate.whenChanged
      return [
        `| Per site per week | Last 7 days | Trial to date | ${number(metrics.beforeTrial.window.days)} days before |`,
        '| --- | ---: | ---: | ---: |',
        row('Issues requested, `when: changed`', window => window.whenChanged.issuesPerSiteWeek),
        row('Issues requested, every run', window => window.everyRun.issuesPerSiteWeek),
        row('Agent runs, `when: changed`', window => window.whenChanged.agentRunsPerSiteWeek),
        row('Agent runs, every run', window => window.everyRun.agentRunsPerSiteWeek),
        '',
        `Trial to date: ${changed.unchangedRuns} of ${changed.runs} runs at \`when: changed\` sites were unchanged and spent no Agent turn. ${plural(changed.failedRuns + metrics.toDate.everyRun.failedRuns, 'run')} failed.`,
        ...metrics.scheduleMismatches.length === 0
          ? []
          : [`Schedule differs from its group: ${metrics.scheduleMismatches.map(entry => `${entry.repository} (${entry.actual === 'WhenChanged' ? '`when: changed`' : entry.actual === 'EveryRun' ? 'every run' : 'no schedule'})`).join(', ')}.`],
        ...metrics.otherRepositories.length === 0 ? [] : [`In neither group: ${metrics.otherRepositories.join(', ')}.`],
      ]
    }
    case 'DiscussionRouteShadow': {
      const row = (label: string, read: (window: DiscussionWindow) => string) => `| ${label} | ${read(metrics.lastSevenDays)} | ${read(metrics.toDate)} |`
      return [
        '| Issues | Last 7 days | Trial to date |',
        '| --- | ---: | ---: |',
        row('Classified', window => String(window.classifiedIssues)),
        row('Routed DISCUSSION', window => String(window.discussionIssues)),
        row('Would stay out of Issue triage', window => `${window.skipsTriageIssues} (${percent(window.skipsTriageShare)})`),
        ...metrics.issues.length === 0
          ? []
          : [
              '',
              'Label each issue: a discussion, or a defect?',
              ...metrics.issues.map(issue => `- [${issue.issue}](${issue.url}): confidence ${issue.confidence}${issue.skipsTriage ? ', would stay out of Issue triage' : ''}`),
            ],
        ...metrics.omittedIssues === 0 ? [] : [`${plural(metrics.omittedIssues, 'more issue')} not listed.`],
        ...metrics.unreadableReadings === 0 ? [] : [`${plural(metrics.unreadableReadings, 'reading')} could not be read.`],
      ]
    }
    case 'PathRuleShadow': {
      const row = (label: string, read: (window: PathRuleWindow) => string) => `| ${label} | ${read(metrics.lastSevenDays)} | ${read(metrics.toDate)} |`
      return [
        '| Heads | Last 7 days | Trial to date |',
        '| --- | ---: | ---: |',
        row('Reviewed', window => String(window.reviewedHeads)),
        row('Prose-only, flagged', window => `${window.flaggedHeads} (${percent(window.flaggedShare)})`),
        row('Flagged and ended Blocked', window => String(window.flaggedEndedBlocked)),
        ...metrics.blockedHeads.length === 0
          ? []
          : [
              '',
              'Flagged heads that ended Blocked:',
              ...metrics.blockedHeads.map(head => `- [${head.pullRequest}](${head.url}) at ${head.headSha}, ${head.fileCount === null ? 'unknown files' : plural(head.fileCount, 'file')}, failed Review gates: ${head.failedGates.length === 0 ? 'none recorded' : head.failedGates.join(', ')}`),
            ],
        ...metrics.omittedHeads === 0 ? [] : [`${plural(metrics.omittedHeads, 'more head')} not listed.`],
      ]
    }
    case 'ReadyWait': {
      const row = (label: string, read: (wait: ReadyWait) => string) => `| ${label} | ${read(metrics.current)} | ${read(metrics.baseline)} |`
      return [
        `| READY pull requests | Now | First run, ${localDate(metrics.baseline.measuredAt)} |`,
        '| --- | ---: | ---: |',
        row(`READY with passing CI for over ${metrics.overdueDays} days`, wait => String(wait.overdue)),
        row('Oldest of those, days since READY', wait => wait.oldestDays === null ? 'n/a' : String(wait.oldestDays)),
        row('All READY with passing CI', wait => String(wait.ready)),
      ]
    }
    case 'RetroFollowThrough': {
      const total = metrics.toDate
      return [
        `| Week | Candidates | Issues | Merged within ${metrics.mergeDays} days | Still waiting |`,
        '| --- | ---: | ---: | ---: | ---: |',
        ...metrics.weeks.map(week => `| Week ${week.week} | ${week.candidates} | ${week.issues} | ${week.mergedInTime} | ${week.open} |`),
        '',
        `Trial to date: ${total.mergedInTime} of ${plural(total.judged, 'judged Candidate')} merged within ${metrics.mergeDays} days (${percent(total.mergedShare)}). ${plural(total.open, 'Candidate')} still ${total.open === 1 ? 'has' : 'have'} time.`,
      ]
    }
    case 'ReviewReverts': {
      const label = { Service: 'The service', Person: 'A person' } as const
      return [
        `| Opened by | Reviewed merges | READY | Reverted within ${metrics.revertDays} days | READY and reverted | READY and judged |`,
        '| --- | ---: | ---: | ---: | ---: | ---: |',
        ...metrics.rows.map(row => `| ${label[row.openedBy]} | ${row.merged} | ${row.ready} | ${row.reverted} | ${row.readyReverted} | ${row.readyJudged} |`),
        ...metrics.reverted.length === 0
          ? []
          : [
              '',
              'Reverted pull requests:',
              ...metrics.reverted.map(merge => `- [${merge.pullRequest}](${merge.url}), Review outcome ${merge.outcome.toUpperCase()}, reverted by #${merge.revertedBy}`),
            ],
      ]
    }
  }
}

/** The numbers of one trial as Markdown. The Routine copies these lines unchanged. */
export function renderTrialReading(reading: Omit<Extract<TrialReading, { _tag: 'Measured' }>, 'markdown'> | Omit<Extract<TrialReading, { _tag: 'Parked' }>, 'markdown'>): string {
  if (reading._tag === 'Parked')
    return [`### ${reading.title}`, '', reading.reason].join('\n')
  return [
    `### ${reading.title}`,
    '',
    stateLine(reading.state),
    ...reading.metrics === null
      ? []
      : [
          '',
          ...metricLines(reading.metrics),
          '',
          ...reading.keep.map(rule => `- Keep rule: ${RULE_LABEL[rule._tag]}. ${rule.detail}`),
          ...reading.kill.map(rule => `- Kill rule: ${RULE_LABEL[rule._tag]}. ${rule.detail}`),
        ],
    '',
    `**Suggested verdict: ${reading.suggestion.verdict}.** ${reading.suggestion.reason}`,
  ].join('\n')
}

function notMeasurable(detail: string): RuleReading[] {
  return [{ _tag: 'NotYetMeasurable', detail }, { _tag: 'NotYetMeasurable', detail }]
}

function readMeasuredTrial(store: TrialReportSource, trial: MeasuredTrial, now: Date): TrialReading {
  const { measure } = trial
  const startedAt = trial.start._tag === 'On'
    ? iso(Date.parse(trial.start.at))
    : store.firstTrialEventAt({ stream: trial.start.stream, event: trial.start.event })
  const state = trialState(trial, startedAt, now, trial.start._tag === 'FirstEvent'
    ? `No \`${trial.start.event}\` event is recorded yet. The trial starts with the first one.`
    : 'The trial has not started.')
  const base = { _tag: 'Measured' as const, id: trial.id, title: trial.title, metric: trial.metric, keepRule: trial.keepRule, killRule: trial.killRule, before: trial.before, state }

  const finish = (metrics: TrialMetrics | null, keep: RuleReading[], kill: RuleReading[]): TrialReading => {
    const reading = { ...base, metrics, keep, kill, suggestion: suggestVerdict(state, keep, kill, trial.onMiss) }
    return { ...reading, markdown: renderTrialReading(reading) }
  }
  if (state._tag === 'NotStarted' || startedAt === null)
    return finish(null, notMeasurable('The trial has not started.'), [{ _tag: 'NotYetMeasurable', detail: 'The trial has not started.' }])

  const start = Date.parse(startedAt)
  const end = Math.min(now.getTime(), start + trial.weeks * weekMilliseconds)
  const toDate = window(start, end)
  const lastSevenDays = window(Math.max(start, end - weekMilliseconds), end)

  switch (measure._tag) {
    case 'CheckinWhenChanged': {
      const beforeTrial = window(start - measure.priorDays * dayMilliseconds, start)
      const read = readCheckinTrial({
        measure,
        runs: store.listTrialRoutineRuns({ routineName: 'daily-checkin', range: { from: beforeTrial.from, to: toDate.to } }),
        schedules: store.listRoutines().filter(routine => routine.name === 'daily-checkin'),
        windows: { lastSevenDays, toDate, beforeTrial },
      })
      return finish(read.metrics, read.keep, read.kill)
    }
    case 'DiscussionRouteShadow': {
      const routes = store.listTrialIssueRoutes({ event: 'discussion_shadow', range: toDate })
      const read = readDiscussionTrial({ measure, readings: routes.readings, unreadable: routes.unreadable, windows: { lastSevenDays, toDate } })
      return finish(read.metrics, read.keep, read.kill)
    }
    case 'PathRuleShadow': {
      const read = readPathRuleTrial({
        measure,
        lastSevenDays: { window: lastSevenDays, heads: store.listTrialReviewedHeads(lastSevenDays) },
        toDate: { window: toDate, heads: store.listTrialReviewedHeads(toDate) },
      })
      return finish(read.metrics, read.keep, read.kill)
    }
    case 'ReadyWait': {
      // Open pull requests exist only now, so each weekly run reads them at its own instant.
      const read = readReadyWaitTrial({ measure, pullRequests: store.listReadyPullRequests(), now, week: state._tag === 'Running' ? state.week : trial.weeks })
      return finish(read.metrics, read.keep, read.kill)
    }
    case 'RetroFollowThrough': {
      const read = readRetroTrial({ measure, candidates: store.listTrialRetroCandidates(toDate), now, toDate })
      return finish(read.metrics, read.keep, read.kill)
    }
    case 'ReviewReverts': {
      const read = readReviewRevertTrial({ measure, merges: store.listTrialReviewedMerges(toDate), now })
      return finish(read.metrics, read.keep, read.kill)
    }
  }
}

/**
 * Every trial's numbers for the weekly `trial-report` Routine.
 *
 * The controller reads the Journal here, so the scheduled Agent never does.
 */
export function collectTrialReportEvidence(store: TrialReportSource, now: Date, trials: readonly Trial[] = TRIALS): TrialReportEvidence {
  return {
    observedAt: now.toISOString(),
    trials: trials.map((trial) => {
      if (trial._tag === 'Parked') {
        const reading = { _tag: 'Parked' as const, id: trial.id, title: trial.title, reason: trial.reason }
        return { ...reading, markdown: renderTrialReading(reading) }
      }
      return readMeasuredTrial(store, trial, now)
    }),
  }
}
