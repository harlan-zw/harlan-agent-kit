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
    /** `retired` names the Routines this repository declared until the spec went. */
    | { _tag: 'Absent', retired: string[] }
    | { _tag: 'Refused', reason: string }
    | { _tag: 'Unread', reason: string }

export interface RoutineSyncDependencies {
  github: Pick<GitHubSource, 'readRoutineSpec'>
  now: () => Date
  signal?: AbortSignal
  store: Pick<JournalStore, 'getRoutineRun' | 'listCandidates' | 'listRoutines' | 'stageCandidateIssues' | 'syncRoutines'>
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
    // A spec nobody can read retires every Routine it declared. That is right
    // when somebody deleted the file, and it is wrong to do it quietly: a
    // release that moves the spec path reads as Absent everywhere at once, and
    // the whole fleet's schedule went with no log and no Incident. Name what
    // this call retired so the caller can report it.
    const retired = dependencies.store.listRoutines(repository.github).map(routine => routine.name)
    dependencies.store.syncRoutines({
      repository: repository.github,
      specSha: source.value.specSha,
      entries: [],
      at,
    })
    return { _tag: 'Absent', retired }
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

/** The Routine names one repository declares, grouped for a report. */
export interface RepositoryRoutines {
  repository: string
  names: string[]
}

/** The mapped repositories that may run Routines: enabled ones only, by lowercase name. */
function mappedRepositories(repositories: readonly Pick<RepositoryMapping, 'github' | 'enabled'>[]): Set<string> {
  return new Set(repositories.filter(repository => repository.enabled).map(repository => repository.github.toLowerCase()))
}

function groupByRepository(routines: readonly Routine[]): RepositoryRoutines[] {
  const groups = new Map<string, string[]>()
  routines.forEach(routine => groups.set(routine.repository, [...(groups.get(routine.repository) ?? []), routine.name]))
  return [...groups].map(([repository, names]) => ({ repository, names }))
}

export interface RoutineMappingDependencies {
  now: () => Date
  /** The Repository mappings this start built. */
  repositories: readonly Pick<RepositoryMapping, 'github' | 'enabled'>[]
  /** Repositories discovery could not settle this start. Their absence from the mapping proves nothing. */
  unresolved: readonly string[]
  store: Pick<JournalStore, 'listRoutines' | 'retireRoutines'>
}

export interface RoutineMappingOutcome {
  /** Routines retired, with their Queued runs superseded, because their repository left the mapping. */
  retired: RepositoryRoutines[]
  /** Routines of an unmapped repository kept, because discovery could not settle it. */
  deferred: RepositoryRoutines[]
}

/**
 * Retires the Routines of every repository with no enabled Repository mapping.
 *
 * A renamed or removed repository leaves its Routines behind. The planner
 * refuses them, but a Queued run already open waits forever, and nothing else
 * ever settles the definition. A repository discovery could not settle is kept:
 * one failed GitHub read must not delete a schedule the repository still has.
 */
export function retireUnmappedRoutines(dependencies: RoutineMappingDependencies): RoutineMappingOutcome {
  const mapped = mappedRepositories(dependencies.repositories)
  const unresolved = new Set(dependencies.unresolved.map(repository => repository.toLowerCase()))
  const unmapped = dependencies.store.listRoutines().filter(routine => !mapped.has(routine.repository.toLowerCase()))
  const deferred = unmapped.filter(routine => unresolved.has(routine.repository.toLowerCase()))
  const at = dependencies.now().toISOString()
  const retired = groupByRepository(unmapped.filter(routine => !unresolved.has(routine.repository.toLowerCase())))
    .map(({ repository }) => ({
      repository,
      names: dependencies.store.retireRoutines({
        repository,
        reason: 'The repository has no enabled Repository mapping.',
        at,
      }),
    }))
  return { retired, deferred: groupByRepository(deferred) }
}

export interface RoutinePlanDependencies {
  catchUpMinutes?: number
  now: () => Date
  /** The current Repository mappings. A Routine of any other repository opens no run. */
  repositories: readonly Pick<RepositoryMapping, 'github' | 'enabled'>[]
  store: Pick<JournalStore, 'listRoutines' | 'openRoutineRun' | 'skipRoutineRun' | 'stageRoutineReport'>
}

export interface RoutinePlan {
  opened: RoutineRun[]
  skipped: RoutineRun[]
  /** Routines that owe nothing because no enabled mapping names their repository. */
  unmapped: RepositoryRoutines[]
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
 *
 * A Routine whose repository has no enabled mapping opens nothing, and the
 * plan names it. No Worker claims such a run, so opening one queued a run a day
 * that nothing ever settled, with no trace but an info log.
 */
export function planRoutineRuns(dependencies: RoutinePlanDependencies): RoutinePlan {
  const now = dependencies.now()
  const mapped = mappedRepositories(dependencies.repositories)
  const opened: RoutineRun[] = []
  const skipped: RoutineRun[] = []
  const unmapped: Routine[] = []

  for (const routine of dependencies.store.listRoutines()) {
    if (!routine.enabled)
      continue
    if (!mapped.has(routine.repository.toLowerCase())) {
      unmapped.push(routine)
      continue
    }
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

  return { opened, skipped, unmapped: groupByRepository(unmapped) }
}
