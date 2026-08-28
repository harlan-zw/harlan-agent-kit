import type { GitHubSource } from './github.ts'
import type { JournalStore } from './store.ts'
import type { RepositoryMapping, Routine, RoutineRun } from './types.ts'
import { candidateIssueCommands } from './candidate-issue-controller.ts'
import { routineReportCommand } from './routine-report-controller.ts'
import { dueRoutine, parseCron } from './routine-schedule.ts'
import { parseRoutineSpec } from './routine-spec.ts'

/** What syncing one repository's spec decided, for the caller to report. */
export type RoutineSyncOutcome
  = | { _tag: 'Synced', routines: Routine[] }
    | { _tag: 'Absent' }
    | { _tag: 'Refused', reason: string }
    | { _tag: 'Unread', reason: string }

export interface RoutineSyncDependencies {
  github: Pick<GitHubSource, 'readRoutineSpec'>
  now: () => Date
  signal?: AbortSignal
  store: Pick<JournalStore, 'getRoutineRun' | 'listCandidates' | 'stageCandidateIssues' | 'syncRoutines'>
}

/**
 * Reads one repository's Routine spec and stores what it declares.
 *
 * A malformed spec is `Refused` and disables that repository's Routines, and it
 * never stops the service starting. One repository with a typo must not take
 * the rest of the fleet down with it.
 *
 * An unreadable GitHub answer is `Unread`, which is different: the spec may be
 * perfectly good and GitHub is simply degraded. That case leaves the stored
 * Routines alone rather than deleting work the repository still declares.
 */
export async function syncRepositoryRoutines(
  repository: RepositoryMapping,
  dependencies: RoutineSyncDependencies,
): Promise<RoutineSyncOutcome> {
  const source = await dependencies.github.readRoutineSpec(repository, dependencies.signal)
  if (source._tag === 'Err')
    return { _tag: 'Unread', reason: source.error.message }

  const at = dependencies.now().toISOString()
  if (source.value._tag === 'Absent') {
    dependencies.store.syncRoutines({
      repository: repository.github,
      specSha: source.value.specSha,
      entries: [],
      at,
    })
    return { _tag: 'Absent' }
  }

  const spec = parseRoutineSpec(source.value.text)
  if (spec._tag === 'Err') {
    // A refused spec removes this repository's Routines. Keeping the last good
    // one would run a schedule nobody can read in the source any more.
    dependencies.store.syncRoutines({
      repository: repository.github,
      specSha: source.value.specSha,
      entries: [],
      at,
    })
    return { _tag: 'Refused', reason: spec.error }
  }

  // A cron the parser cannot read is refused with the whole spec, so a Routine
  // never sits enabled with a schedule that can never come due.
  for (const entry of spec.value.routines) {
    for (const cron of entry.crons) {
      const parsed = parseCron(cron)
      if (parsed._tag === 'Err') {
        dependencies.store.syncRoutines({
          repository: repository.github,
          specSha: source.value.specSha,
          entries: [],
          at,
        })
        return { _tag: 'Refused', reason: `${entry.name}: ${parsed.error}` }
      }
    }
  }

  const routines = dependencies.store.syncRoutines({
    repository: repository.github,
    specSha: source.value.specSha,
    entries: spec.value.routines,
    at,
  })
  const commands = routines
    .filter(routine => routine.mode === 'propose')
    .flatMap(routine => dependencies.store.listCandidates(routine.id)
      .filter(candidate => candidate.result._tag === 'Proposed')
      .flatMap((candidate) => {
        const run = dependencies.store.getRoutineRun(candidate.runId)
        if (run === null)
          throw new Error(`Candidate ${candidate.id} belongs to a missing Routine run.`)
        return candidateIssueCommands([candidate], {
          repository: routine.repository,
          name: routine.name,
          scheduledFor: run.scheduledFor,
        })
      }))
  dependencies.store.stageCandidateIssues({ commands, at })

  return { _tag: 'Synced', routines }
}

export interface RoutinePlanDependencies {
  catchUpMinutes?: number
  now: () => Date
  store: Pick<JournalStore, 'listRoutines' | 'openRoutineRun' | 'skipRoutineRun' | 'stageRoutineReport'>
}

export interface RoutinePlan {
  opened: RoutineRun[]
  skipped: RoutineRun[]
}

/**
 * Opens a run for every Routine that owes one right now.
 *
 * A Routine with several cron expressions answers the newest instant any of
 * them names. Opening one run per expression would run the same work twice for
 * a Routine that lists both a weekday and a weekend schedule.
 *
 * A disabled Routine is skipped entirely, including its catch-up. Re-enabling
 * one must not fire a run for an instant that passed while it was off.
 */
export function planRoutineRuns(dependencies: RoutinePlanDependencies): RoutinePlan {
  const now = dependencies.now()
  const opened: RoutineRun[] = []
  const skipped: RoutineRun[] = []

  for (const routine of dependencies.store.listRoutines()) {
    if (!routine.enabled)
      continue
    const lastRunAt = routine.lastRunAt === null ? null : new Date(routine.lastRunAt)

    let due: { scheduledFor: Date, missed: string | null } | null = null
    for (const cron of routine.crons) {
      const expression = parseCron(cron)
      if (expression._tag === 'Err')
        continue
      const decision = dueRoutine({
        ...(dependencies.catchUpMinutes === undefined ? {} : { catchUpMinutes: dependencies.catchUpMinutes }),
        expression: expression.value,
        lastRunAt,
        now,
        timeZone: routine.timeZone,
      })
      if (decision._tag === 'NotDue')
        continue
      const candidate = {
        scheduledFor: decision.scheduledFor,
        missed: decision._tag === 'Missed' ? decision.reason : null,
      }
      // The newest instant wins, so two expressions naming the same morning
      // produce one run and not two.
      if (due === null || candidate.scheduledFor.getTime() > due.scheduledFor.getTime())
        due = candidate
    }
    if (due === null)
      continue

    const input = {
      routineId: routine.id,
      scheduledFor: due.scheduledFor.toISOString(),
      specSha: routine.specSha,
      at: now.toISOString(),
    }
    const run = due.missed === null
      ? dependencies.store.openRoutineRun(input)
      : dependencies.store.skipRoutineRun({ ...input, reason: due.missed })
    if (run === null)
      continue
    if (due.missed === null) {
      opened.push(run)
      continue
    }
    // A skipped run reports too. A check-in that did not happen is exactly the
    // thing a person needs told, and it leaves no other trace.
    dependencies.store.stageRoutineReport({
      command: routineReportCommand({
        repository: routine.repository,
        routineId: routine.id,
        routineName: routine.name,
        run: { id: run.id, scheduledFor: run.scheduledFor },
        report: { _tag: 'Skipped', reason: due.missed },
      }),
      at: now.toISOString(),
    })
    skipped.push(run)
  }

  return { opened, skipped }
}
