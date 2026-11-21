import type { DatabaseSync } from 'node:sqlite'
import type { CronSchedule } from './routine-schedule.ts'
import type { RoutineRunEnd, RoutineVerdict, TaskEnd, TimelineHistory, TimelineRoutineInstant, TimelineRoutineRun, TimelineTaskRecord, TimelineWindow } from './timeline.ts'
import type { AgentRole } from './types.ts'
import { cronInstants, parseCron } from './routine-schedule.ts'
import { routineResult, timelineOutcome } from './timeline.ts'

/**
 * The Timeline's reads over the journal. Every read is a range over an index,
 * and every list has a hard limit, so a 30 day window never walks the whole
 * journal. Deliveries are not recorded yet, so their lists stay empty.
 */

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour

const maximumTasks = 4_000
const maximumRoutineRuns = 3_000
/** Routine instants reach at most a week ahead, and at most two a day for a week per Routine. */
const upcomingDays = 7
const upcomingPerRoutine = 14

export interface TimelineStore {
  /** The stored history behind the Timeline for one window. */
  getTimelineHistory: (input: TimelineWindow & { now: number }) => TimelineHistory
}

export const timelineSchema = `
  CREATE INDEX IF NOT EXISTS routine_runs_scheduled ON routine_runs(scheduled_for);
  CREATE INDEX IF NOT EXISTS candidates_run ON candidates(run_id);
`

interface TaskEndRow {
  stream: 'task' | 'worker_task'
  id: string
  end_state: TaskEnd
  ended_at: string
  started_at: string | null
  kind: string | null
  subject_id: number | null
  triage_route: string | null
}

interface SubjectRow {
  id: number
  kind: 'issue' | 'pull_request'
  number: number
  repository: string
  title: string | null
}

interface RoutineRunRow {
  routine_id: string
  repository: string
  name: string
  scheduled_for: string
  state_tag: RoutineRunEnd
  evidence: string | null
  updated_at: string
  ended_at: string | null
  verdict: string | null
  proposed_candidates: number
}

interface RoutineRow {
  id: string
  repository: string
  name: string
  crons: string
  time_zone: string
}

const iso = (at: number): string => new Date(at).toISOString()
const work = (kind: string): AgentRole => (kind === 'resolve_conflict' ? 'conflict_resolution' : kind) as AgentRole

export function createTimelineStore(database: DatabaseSync): TimelineStore {
  // Only a run that ended while it ran gets a bar. Work that never started,
  // or was replaced in the Queue, has no span to draw.
  const taskEnds = database.prepare(`
    WITH terminal AS (
      SELECT stream, entity_id, to_state, occurred_at FROM workflow_events
      WHERE stream IN ('task', 'worker_task') AND occurred_at >= ? AND occurred_at < ?
        AND to_state IN ('Completed', 'Failed', 'ActionRequired', 'Superseded')
        AND from_state IN ('Running', 'Publishing')
      ORDER BY occurred_at DESC LIMIT ?
    )
    SELECT
      terminal.stream,
      terminal.entity_id AS id,
      terminal.to_state AS end_state,
      terminal.occurred_at AS ended_at,
      (SELECT MAX(claim.occurred_at) FROM workflow_events AS claim
        WHERE claim.stream = terminal.stream AND claim.entity_id = terminal.entity_id
          AND claim.to_state = 'Running' AND claim.occurred_at <= terminal.occurred_at) AS started_at,
      COALESCE(tasks.kind, worker_tasks.kind) AS kind,
      COALESCE(tasks.subject_id, worker_tasks.subject_id) AS subject_id,
      CASE WHEN worker_tasks.kind = 'issue_triage' THEN (
        SELECT route_tag FROM issue_triage_runs
        WHERE issue_triage_runs.subject_id = worker_tasks.subject_id AND issue_triage_runs.revision_id = worker_tasks.revision_id
      ) END AS triage_route
    FROM terminal
    LEFT JOIN tasks ON terminal.stream = 'task' AND tasks.id = terminal.entity_id
    LEFT JOIN worker_tasks ON terminal.stream = 'worker_task' AND worker_tasks.id = terminal.entity_id
  `)
  // A Review is in the journal twice: its Review Task and its Review run. The
  // Task draws the bar; the run, through its current gate projection, the cap.
  const reviewOutcomes = database.prepare(`
    SELECT event.task_id, COALESCE(projection.outcome_tag, review_runs.outcome_tag) AS outcome
    FROM workflow_events AS event
    JOIN review_runs ON review_runs.id = event.entity_id
    LEFT JOIN review_gate_projections AS projection ON projection.review_run_id = review_runs.id
    WHERE event.stream = 'review_run' AND event.event = 'Completed' AND event.occurred_at >= ? AND event.occurred_at < ?
    ORDER BY event.occurred_at
  `)
  const subjects = database.prepare(`
    SELECT subjects.id, subjects.kind, subjects.github_number AS number, repositories.github AS repository,
      json_extract(revisions.payload, '$.title') AS title
    FROM subjects
    JOIN repositories ON repositories.id = subjects.repository_id
    LEFT JOIN revisions ON revisions.id = subjects.current_revision_id
    WHERE subjects.id IN (SELECT value FROM json_each(?))
  `)
  const routineRuns = database.prepare(`
    SELECT
      routine_runs.routine_id,
      routines.repository,
      routines.name,
      routine_runs.scheduled_for,
      routine_runs.state_tag,
      routine_runs.evidence,
      routine_runs.updated_at,
      (SELECT MAX(event.occurred_at) FROM workflow_events AS event
        WHERE event.stream = 'routine_run' AND event.entity_id = routine_runs.id AND event.to_state = routine_runs.state_tag) AS ended_at,
      (SELECT report.verdict_json FROM routine_report_commands AS report WHERE report.run_id = routine_runs.id) AS verdict,
      (SELECT COUNT(*) FROM candidates WHERE candidates.run_id = routine_runs.id AND candidates.result_tag = 'Proposed') AS proposed_candidates
    FROM routine_runs
    JOIN routines ON routines.id = routine_runs.routine_id
    WHERE routine_runs.scheduled_for >= ? AND routine_runs.scheduled_for < ?
      AND routine_runs.state_tag IN ('Completed', 'Failed', 'Skipped', 'ActionRequired', 'Superseded')
    ORDER BY routine_runs.scheduled_for DESC LIMIT ?
  `)
  const enabledRoutines = database.prepare('SELECT id, repository, name, crons, time_zone FROM routines WHERE enabled = 1 AND retired_at IS NULL ORDER BY id')

  function tasks(window: TimelineWindow): TimelineTaskRecord[] {
    const ends = (taskEnds.all(iso(window.from), iso(window.to), maximumTasks) as unknown as TaskEndRow[])
      .filter(row => row.started_at !== null && row.kind !== null && row.subject_id !== null)
    const outcomes = new Map((reviewOutcomes.all(iso(window.from - hour), iso(window.to)) as Array<{ task_id: string | null, outcome: 'Ready' | 'Pending' | 'Blocked' }>)
      .flatMap(row => row.task_id === null ? [] : [[row.task_id, row.outcome] as const]))
    const items = new Map((subjects.all(JSON.stringify([...new Set(ends.map(row => row.subject_id))])) as unknown as SubjectRow[]).map(row => [row.id, row]))
    return ends.flatMap((row): TimelineTaskRecord[] => {
      const item = items.get(row.subject_id!)
      if (item === undefined)
        return []
      return [{
        id: row.id,
        repository: item.repository,
        number: item.number,
        kind: item.kind,
        title: item.title ?? `#${item.number}`,
        work: work(row.kind!),
        startedAt: row.started_at!,
        endedAt: row.ended_at,
        outcome: timelineOutcome({ end: row.end_state, review: row.kind === 'adversarial_review' ? outcomes.get(row.id) ?? null : null, triageRoute: row.triage_route }),
      }]
    }).sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.endedAt.localeCompare(b.endedAt))
  }

  function routineHistory(window: TimelineWindow): TimelineRoutineRun[] {
    return (routineRuns.all(iso(window.from), iso(window.to), maximumRoutineRuns) as unknown as RoutineRunRow[])
      .map((row): TimelineRoutineRun => {
        const result = routineResult({ end: row.state_tag, evidence: row.evidence, verdict: row.verdict === null ? null : JSON.parse(row.verdict) as RoutineVerdict, proposedCandidates: row.proposed_candidates })
        // A run that spent no Agent turn is an instant, not a span.
        const spent = result !== 'Skipped' && result !== 'Unchanged'
        return { routineId: row.routine_id, repository: row.repository, name: row.name, scheduledFor: row.scheduled_for, endedAt: spent ? row.ended_at ?? row.updated_at : null, result }
      })
      .reverse()
  }

  function upcoming(window: TimelineWindow, now: number): TimelineRoutineInstant[] {
    const from = Math.max(window.from, now)
    const to = Math.min(window.to, now + upcomingDays * day)
    if (to <= from)
      return []
    const routines = enabledRoutines.all() as unknown as RoutineRow[]
    const schedules: Array<CronSchedule & { routine: RoutineRow }> = routines.flatMap(routine => (JSON.parse(routine.crons) as string[]).flatMap((text) => {
      const parsed = parseCron(text)
      // The spec parser already refused a bad expression, so this only skips a row older code wrote.
      return parsed._tag === 'Ok' ? [{ expression: parsed.value, timeZone: routine.time_zone, routine }] : []
    }))
    const instants = cronInstants({ schedules, from, to, limit: upcomingPerRoutine })
    const byRoutine = new Map<string, { routine: RoutineRow, at: Set<number> }>()
    schedules.forEach((schedule, index) => {
      const entry = byRoutine.get(schedule.routine.id) ?? { routine: schedule.routine, at: new Set<number>() }
      instants[index]!.forEach(at => entry.at.add(at.getTime()))
      byRoutine.set(schedule.routine.id, entry)
    })
    return [...byRoutine.values()]
      .flatMap(({ routine, at }) => [...at].sort((a, b) => a - b).slice(0, upcomingPerRoutine).map(instant => ({ routineId: routine.id, repository: routine.repository, name: routine.name, at: instant })))
      .sort((a, b) => a.at - b.at || a.routineId.localeCompare(b.routineId))
      .map(instant => ({ ...instant, at: iso(instant.at) }))
  }

  return {
    getTimelineHistory: ({ from, to, now }) => ({
      generatedAt: iso(now),
      // No delivery is recorded yet. An empty series reads as no records.
      deliveries: { start: iso(Math.floor(from / hour) * hour), bucketSeconds: 60, counts: [] },
      tasks: tasks({ from, to }),
      itemEvents: [],
      routineRuns: routineHistory({ from, to }),
      upcoming: upcoming({ from, to }, now),
      // Pause history is not recorded yet.
      pauses: [],
    }),
  }
}
