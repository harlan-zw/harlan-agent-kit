import type { Result } from './result.ts'
import { err, ok } from './result.ts'

export interface StatsRange {
  from: string
  to: string
  timeZone: string
}

export type StatsRangeError
  = | { _tag: 'MissingFrom' }
    | { _tag: 'MissingTo' }
    | { _tag: 'InvalidFrom' }
    | { _tag: 'InvalidTo' }
    | { _tag: 'InvalidTimeZone' }
    | { _tag: 'EmptyRange' }

export type PullRequestTriageStatsOutcome = 'ReviewRequired' | 'ReviewSkipped' | 'ReviewRequiredAfterFailure'

export interface RecordPullRequestTriageRunInput {
  taskId: string
  repository: string
  pullRequestNumber: number
  revisionId: string
  headSha: string
  startedAt: string
  completedAt: string
  outcome: {
    _tag: PullRequestTriageStatsOutcome
    reason: string
  }
}

export type RecordPullRequestTriageRunResult
  = | { _tag: 'Inserted' }
    | { _tag: 'Duplicate' }
    | { _tag: 'Conflict' }
    | { _tag: 'Rejected', reason: { _tag: 'RevisionMismatch' } }

export type StatsTaskKind = 'review_fix' | 'conflict_resolution' | 'baseline_repair' | 'issue_triage' | 'issue_work'

export type StatsFact
  = | {
    _tag: 'PullRequestTriage'
    at: string
    startedAt: string
    outcome: PullRequestTriageStatsOutcome
  }
  | {
    _tag: 'Review'
    at: string
    startedAt: string
    outcome: 'Ready' | 'Pending' | 'Blocked'
    findings: number
  }
  | {
    _tag: 'Task'
    at: string
    startedAt: string | null
    work: StatsTaskKind
    outcome: 'Completed' | 'ActionRequired' | 'Failed' | 'Superseded'
  }
  | {
    _tag: 'Publication'
    at: string
    repository: string
    itemNumber: number
    work: 'review_fix' | 'conflict_resolution' | 'baseline_repair' | 'issue_work'
    changedFiles: number
  }
  | {
    _tag: 'Routine'
    at: string
    startedAt: string | null
    outcome: 'Completed' | 'ActionRequired' | 'Failed' | 'Skipped' | 'Superseded'
    candidates: number
  }

export interface StatsComparison {
  value: number
  previous: number
}

export interface StatsDay {
  date: string
  fixCommits: number
  conflictResolutions: number
  openedPullRequests: number
  reviewFindings: number
}

export interface PullRequestTriageWorkStats {
  _tag: 'PullRequestTriage'
  runs: number
  reviewRequired: number
  reviewSkipped: number
  reviewRequiredAfterFailure: number
  medianDurationMs: number | null
}

export interface ReviewWorkStats {
  _tag: 'Review'
  runs: number
  ready: number
  pending: number
  blocked: number
  findings: number
  medianDurationMs: number | null
}

export interface TaskWorkStats {
  _tag: 'Task'
  work: StatsTaskKind
  runs: number
  completed: number
  actionRequired: number
  failed: number
  superseded: number
  publishedCommits: number
  changedFiles: number
  medianDurationMs: number | null
}

export interface RoutineWorkStats {
  _tag: 'Routine'
  runs: number
  completed: number
  actionRequired: number
  failed: number
  skipped: number
  superseded: number
  candidates: number
  medianDurationMs: number | null
}

export type StatsWork = PullRequestTriageWorkStats | ReviewWorkStats | TaskWorkStats | RoutineWorkStats

export type StatsCoverage = { _tag: 'Complete' } | { _tag: 'Partial', startedAt: string }

export interface StatsSnapshot {
  generatedAt: string
  range: StatsRange
  previousRange: { from: string, to: string }
  coverage: { pullRequestTriage: StatsCoverage }
  summary: {
    changedPullRequests: StatsComparison
    conflictResolutions: StatsComparison
    fixCommits: StatsComparison
    openedPullRequests: StatsComparison
    reviewFindings: StatsComparison
  }
  days: StatsDay[]
  work: StatsWork[]
}

export function parseStatsRange(input: {
  from?: string | undefined
  to?: string | undefined
  timeZone?: string | undefined
}): Result<StatsRange, StatsRangeError> {
  if (input.from === undefined)
    return err({ _tag: 'MissingFrom' })
  if (input.to === undefined)
    return err({ _tag: 'MissingTo' })
  const from = new Date(input.from)
  if (!Number.isFinite(from.getTime()))
    return err({ _tag: 'InvalidFrom' })
  const to = new Date(input.to)
  if (!Number.isFinite(to.getTime()))
    return err({ _tag: 'InvalidTo' })
  if (from.getTime() >= to.getTime())
    return err({ _tag: 'EmptyRange' })
  const timeZone = input.timeZone ?? 'UTC'
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(from)
  }
  catch {
    return err({ _tag: 'InvalidTimeZone' })
  }
  return ok({ from: from.toISOString(), to: to.toISOString(), timeZone })
}

function median(values: number[]): number | null {
  if (values.length === 0)
    return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
}

function durations(facts: Array<{ at: string, startedAt: string | null }>): number[] {
  return facts.flatMap((fact) => {
    if (fact.startedAt === null)
      return []
    return [Math.max(0, Date.parse(fact.at) - Date.parse(fact.startedAt))]
  })
}

function dateKey(at: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(new Date(at))
  const value = (type: Intl.DateTimeFormatPartTypes): string => parts.find(part => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

function dateLabels(range: StatsRange): string[] {
  const first = dateKey(range.from, range.timeZone)
  const last = dateKey(new Date(Date.parse(range.to) - 1).toISOString(), range.timeZone)
  const firstDay = Date.parse(`${first}T00:00:00.000Z`)
  const lastDay = Date.parse(`${last}T00:00:00.000Z`)
  const labels: string[] = []
  for (let day = firstDay; day <= lastDay; day += 86_400_000)
    labels.push(new Date(day).toISOString().slice(0, 10))
  return labels
}

function comparison(current: number, previous: number): StatsComparison {
  return { value: current, previous }
}

function publications(facts: StatsFact[], work: Extract<StatsFact, { _tag: 'Publication' }>['work']): Array<Extract<StatsFact, { _tag: 'Publication' }>> {
  return facts.filter((fact): fact is Extract<StatsFact, { _tag: 'Publication' }> => fact._tag === 'Publication' && fact.work === work)
}

function summary(facts: StatsFact[]) {
  const fixes = publications(facts, 'review_fix')
  const conflicts = publications(facts, 'conflict_resolution')
  const opened = facts.filter(fact => fact._tag === 'Publication' && (fact.work === 'baseline_repair' || fact.work === 'issue_work'))
  const changed = new Set([...fixes, ...conflicts].map(fact => `${fact.repository}:${fact.itemNumber}`))
  const findings = facts.reduce((total, fact) => total + (fact._tag === 'Review' ? fact.findings : 0), 0)
  return {
    changedPullRequests: changed.size,
    conflictResolutions: conflicts.length,
    fixCommits: fixes.length,
    openedPullRequests: opened.length,
    reviewFindings: findings,
  }
}

const TASK_WORK: StatsTaskKind[] = ['review_fix', 'conflict_resolution', 'baseline_repair', 'issue_triage', 'issue_work']

export function buildStats(input: {
  facts: StatsFact[]
  generatedAt: string
  range: StatsRange
  triageCoverageStartedAt: string
}): StatsSnapshot {
  const from = Date.parse(input.range.from)
  const to = Date.parse(input.range.to)
  const previousFrom = from - (to - from)
  const currentFacts = input.facts.filter(fact => Date.parse(fact.at) >= from && Date.parse(fact.at) < to)
  const previousFacts = input.facts.filter(fact => Date.parse(fact.at) >= previousFrom && Date.parse(fact.at) < from)
  const currentSummary = summary(currentFacts)
  const previousSummary = summary(previousFacts)

  const daysByDate = new Map(dateLabels(input.range).map(date => [date, {
    date,
    conflictResolutions: 0,
    fixCommits: 0,
    openedPullRequests: 0,
    reviewFindings: 0,
  } satisfies StatsDay]))
  currentFacts.forEach((fact) => {
    const day = daysByDate.get(dateKey(fact.at, input.range.timeZone))
    if (day === undefined)
      return
    if (fact._tag === 'Review')
      day.reviewFindings += fact.findings
    if (fact._tag !== 'Publication')
      return
    if (fact.work === 'review_fix')
      day.fixCommits += 1
    if (fact.work === 'conflict_resolution')
      day.conflictResolutions += 1
    if (fact.work === 'baseline_repair' || fact.work === 'issue_work')
      day.openedPullRequests += 1
  })

  const triageFacts = currentFacts.filter((fact): fact is Extract<StatsFact, { _tag: 'PullRequestTriage' }> => fact._tag === 'PullRequestTriage')
  const reviewFacts = currentFacts.filter((fact): fact is Extract<StatsFact, { _tag: 'Review' }> => fact._tag === 'Review')
  const taskWork: TaskWorkStats[] = TASK_WORK.map((work) => {
    const taskFacts = currentFacts.filter((fact): fact is Extract<StatsFact, { _tag: 'Task' }> => fact._tag === 'Task' && fact.work === work)
    const workPublications = publications(currentFacts, work === 'issue_triage' ? 'issue_work' : work)
      .filter(() => work !== 'issue_triage')
    return {
      _tag: 'Task',
      work,
      runs: taskFacts.length,
      completed: taskFacts.filter(fact => fact.outcome === 'Completed').length,
      actionRequired: taskFacts.filter(fact => fact.outcome === 'ActionRequired').length,
      failed: taskFacts.filter(fact => fact.outcome === 'Failed').length,
      superseded: taskFacts.filter(fact => fact.outcome === 'Superseded').length,
      publishedCommits: workPublications.length,
      changedFiles: workPublications.reduce((total, fact) => total + fact.changedFiles, 0),
      medianDurationMs: median(durations(taskFacts)),
    }
  })
  const routineFacts = currentFacts.filter((fact): fact is Extract<StatsFact, { _tag: 'Routine' }> => fact._tag === 'Routine')

  return {
    generatedAt: input.generatedAt,
    range: input.range,
    previousRange: { from: new Date(previousFrom).toISOString(), to: input.range.from },
    coverage: {
      pullRequestTriage: Date.parse(input.triageCoverageStartedAt) <= from
        ? { _tag: 'Complete' }
        : { _tag: 'Partial', startedAt: input.triageCoverageStartedAt },
    },
    summary: {
      changedPullRequests: comparison(currentSummary.changedPullRequests, previousSummary.changedPullRequests),
      conflictResolutions: comparison(currentSummary.conflictResolutions, previousSummary.conflictResolutions),
      fixCommits: comparison(currentSummary.fixCommits, previousSummary.fixCommits),
      openedPullRequests: comparison(currentSummary.openedPullRequests, previousSummary.openedPullRequests),
      reviewFindings: comparison(currentSummary.reviewFindings, previousSummary.reviewFindings),
    },
    days: [...daysByDate.values()],
    work: [
      {
        _tag: 'PullRequestTriage',
        runs: triageFacts.length,
        reviewRequired: triageFacts.filter(fact => fact.outcome === 'ReviewRequired').length,
        reviewSkipped: triageFacts.filter(fact => fact.outcome === 'ReviewSkipped').length,
        reviewRequiredAfterFailure: triageFacts.filter(fact => fact.outcome === 'ReviewRequiredAfterFailure').length,
        medianDurationMs: median(durations(triageFacts)),
      },
      {
        _tag: 'Review',
        runs: reviewFacts.length,
        ready: reviewFacts.filter(fact => fact.outcome === 'Ready').length,
        pending: reviewFacts.filter(fact => fact.outcome === 'Pending').length,
        blocked: reviewFacts.filter(fact => fact.outcome === 'Blocked').length,
        findings: reviewFacts.reduce((total, fact) => total + fact.findings, 0),
        medianDurationMs: median(durations(reviewFacts)),
      },
      ...taskWork,
      {
        _tag: 'Routine',
        runs: routineFacts.length,
        completed: routineFacts.filter(fact => fact.outcome === 'Completed').length,
        actionRequired: routineFacts.filter(fact => fact.outcome === 'ActionRequired').length,
        failed: routineFacts.filter(fact => fact.outcome === 'Failed').length,
        skipped: routineFacts.filter(fact => fact.outcome === 'Skipped').length,
        superseded: routineFacts.filter(fact => fact.outcome === 'Superseded').length,
        candidates: routineFacts.reduce((total, fact) => total + fact.candidates, 0),
        medianDurationMs: median(durations(routineFacts)),
      },
    ],
  }
}
