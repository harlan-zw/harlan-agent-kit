import type { Result } from './result.ts'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { err, ok } from './result.ts'

export interface CombinedServiceState {
  routines: number
  routineRuns: number
  candidates: number
  routineReports: number
  routinePublications: number
  incidents: number
}

export type CombineServiceStateError
  = | { _tag: 'OutputExists', path: string }
    | { _tag: 'PathConflict', path: string }
    | { _tag: 'SourceUnavailable', source: 'GitHub' | 'Routine', path: string }
    | { _tag: 'SourceInvalid', source: 'GitHub' | 'Routine', reason: string }
    | { _tag: 'SchemaMismatch', githubVersion: number, routineVersion: number }
    | { _tag: 'SourceRunning', source: 'GitHub' | 'Routine' }
    | { _tag: 'SourceBusy', source: 'GitHub' | 'Routine' }
    | { _tag: 'RepositoryMissing', repository: string }
    | { _tag: 'StateConflict', reason: string }
    | { _tag: 'OutputPublicationFailed', path: string, reason: string }

export interface CombineServiceStateInput {
  githubPath: string
  routinePath: string
  outputPath: string
  dryRun?: boolean
}

type SourceName = 'GitHub' | 'Routine'
type CombineOperation
  = | { _tag: 'ReadSource', source: SourceName }
    | { _tag: 'PublishOutput' }

function quoted(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function count(database: DatabaseSync, table: string, where = ''): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${quoted(table)} ${where}`).get() as { count: number }
  return row.count
}

function sourceCheck(database: DatabaseSync, source: SourceName): CombineServiceStateError | null {
  const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined
  if (integrity?.integrity_check !== 'ok')
    return { _tag: 'SourceInvalid', source, reason: integrity?.integrity_check ?? 'The integrity check returned no result.' }

  const foreignKeyFailure = database.prepare('PRAGMA foreign_key_check').get()
  if (foreignKeyFailure !== undefined)
    return { _tag: 'SourceInvalid', source, reason: 'A stored relationship is invalid.' }

  const control = database.prepare('SELECT state_tag FROM agent_control WHERE singleton = 1').get() as { state_tag: string } | undefined
  if (control?.state_tag !== 'Paused')
    return { _tag: 'SourceRunning', source }

  const busy = database.prepare(`
    SELECT (
      EXISTS (SELECT 1 FROM tasks WHERE state_tag IN ('Running', 'Publishing'))
      OR EXISTS (SELECT 1 FROM worker_tasks WHERE state_tag = 'Running')
      OR EXISTS (SELECT 1 FROM routine_runs WHERE state_tag = 'Running')
      OR EXISTS (SELECT 1 FROM publication_commands WHERE state_tag IN ('Pending', 'Running'))
      OR EXISTS (SELECT 1 FROM review_status_commands WHERE state_tag = 'Running')
      OR EXISTS (SELECT 1 FROM issue_triage_comment_commands WHERE state_tag = 'Running')
      OR EXISTS (SELECT 1 FROM candidate_issue_commands WHERE state_tag = 'Running')
      OR EXISTS (SELECT 1 FROM routine_report_commands WHERE state_tag = 'Running')
    ) AS busy
  `).get() as { busy: number }
  return busy.busy === 0 ? null : { _tag: 'SourceBusy', source }
}

function tableColumns(database: DatabaseSync, schema: 'main' | 'routine_state', table: string): string[] {
  const rows = database.prepare(`PRAGMA ${schema}.table_info(${quoted(table)})`).all() as unknown as Array<{ name: string }>
  return rows.map(row => row.name)
}

function copyTable(database: DatabaseSync, table: string, excluded: ReadonlySet<string> = new Set()): void {
  const destinationColumns = tableColumns(database, 'main', table).filter(column => !excluded.has(column))
  const sourceColumns = tableColumns(database, 'routine_state', table).filter(column => !excluded.has(column))
  if (destinationColumns.join('\0') !== sourceColumns.join('\0'))
    throw new Error(`${table} has different columns in the two sources.`)
  const columns = destinationColumns.map(quoted).join(', ')
  database.exec(`INSERT INTO ${quoted(table)} (${columns}) SELECT ${columns} FROM routine_state.${quoted(table)}`)
}

function mergeRoutineState(database: DatabaseSync): CombinedServiceState {
  database.exec('BEGIN IMMEDIATE')
  try {
    database.exec(`
      DELETE FROM publication_events
      WHERE command_id IN (SELECT id FROM publication_commands WHERE routine_run_id IS NOT NULL);
      DELETE FROM publication_commands WHERE routine_run_id IS NOT NULL;
      DELETE FROM routines;
    `)
    for (const table of ['routines', 'routine_runs', 'candidates', 'candidate_issue_commands', 'routine_report_commands'])
      copyTable(database, table)
    database.exec(`
      INSERT INTO publication_commands
      SELECT * FROM routine_state.publication_commands
      WHERE routine_run_id IS NOT NULL;
    `)
    const publicationEventColumns = tableColumns(database, 'main', 'publication_events')
      .filter(column => column !== 'id')
      .map(quoted)
      .join(', ')
    database.exec(`
      INSERT INTO publication_events (${publicationEventColumns})
      SELECT ${publicationEventColumns}
      FROM routine_state.publication_events
      WHERE command_id IN (
        SELECT id FROM routine_state.publication_commands WHERE routine_run_id IS NOT NULL
      );
    `)
    database.exec(`
      INSERT INTO incidents
      SELECT * FROM routine_state.incidents
      WHERE true
      ON CONFLICT(id) DO UPDATE SET
        occurrences = max(incidents.occurrences, excluded.occurrences),
        first_seen_at = min(incidents.first_seen_at, excluded.first_seen_at),
        last_seen_at = max(incidents.last_seen_at, excluded.last_seen_at),
        severity = CASE WHEN incidents.severity = 'error' OR excluded.severity = 'error' THEN 'error' ELSE 'warning' END,
        recovery = CASE WHEN excluded.last_seen_at > incidents.last_seen_at THEN excluded.recovery ELSE incidents.recovery END,
        resolved_at = CASE
          WHEN incidents.resolved_at IS NULL AND excluded.resolved_at IS NULL THEN NULL
          WHEN incidents.resolved_at IS NULL THEN
            CASE WHEN incidents.last_seen_at > excluded.resolved_at THEN NULL ELSE excluded.resolved_at END
          WHEN excluded.resolved_at IS NULL THEN
            CASE WHEN excluded.last_seen_at > incidents.resolved_at THEN NULL ELSE incidents.resolved_at END
          ELSE max(incidents.resolved_at, excluded.resolved_at)
        END;
    `)
    const foreignKeyFailure = database.prepare('PRAGMA foreign_key_check').get()
    if (foreignKeyFailure !== undefined)
      throw new Error('The combined state has an invalid stored relationship.')
    const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined
    if (integrity?.integrity_check !== 'ok')
      throw new Error(integrity?.integrity_check ?? 'The combined state failed its integrity check.')
    const result = {
      routines: count(database, 'routines'),
      routineRuns: count(database, 'routine_runs'),
      candidates: count(database, 'candidates'),
      routineReports: count(database, 'routine_report_commands'),
      routinePublications: count(database, 'publication_commands', 'WHERE routine_run_id IS NOT NULL'),
      incidents: count(database, 'incidents'),
    }
    database.exec('COMMIT')
    return result
  }
  catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

async function snapshot(source: DatabaseSync, path: string): Promise<void> {
  await backup(source, path)
}

/**
 * Builds one service file from the desktop GitHub state and Hogwild Routine state.
 *
 * Both inputs stay unchanged. The caller receives a new file only after every
 * safety check and the final SQLite checks pass.
 */
export async function combineServiceState(
  input: CombineServiceStateInput,
): Promise<Result<CombinedServiceState, CombineServiceStateError>> {
  const githubPath = resolve(input.githubPath)
  const routinePath = resolve(input.routinePath)
  const outputPath = resolve(input.outputPath)
  if (existsSync(outputPath))
    return err({ _tag: 'OutputExists', path: outputPath })
  if (new Set([githubPath, routinePath, outputPath]).size !== 3)
    return err({ _tag: 'PathConflict', path: outputPath })

  for (const [source, path] of [['GitHub', githubPath], ['Routine', routinePath]] as const) {
    if (!existsSync(path) || !lstatSync(path).isFile())
      return err({ _tag: 'SourceUnavailable', source, path })
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  const temporaryDirectory = mkdtempSync(join(dirname(outputPath), '.harlan-github-agent-state-'))
  const githubSnapshot = join(temporaryDirectory, 'github.sqlite')
  const routineSnapshot = join(temporaryDirectory, 'routine.sqlite')
  const combinedPath = join(temporaryDirectory, 'combined.sqlite')
  let githubSource: DatabaseSync | null = null
  let routineSource: DatabaseSync | null = null
  let combined: DatabaseSync | null = null
  let operation: CombineOperation = { _tag: 'ReadSource', source: 'GitHub' }
  try {
    operation = { _tag: 'ReadSource', source: 'GitHub' }
    githubSource = new DatabaseSync(githubPath, { readOnly: true })
    await snapshot(githubSource, githubSnapshot)
    githubSource.close()
    githubSource = null

    operation = { _tag: 'ReadSource', source: 'Routine' }
    routineSource = new DatabaseSync(routinePath, { readOnly: true })
    await snapshot(routineSource, routineSnapshot)
    routineSource.close()
    routineSource = null

    operation = { _tag: 'ReadSource', source: 'GitHub' }
    githubSource = new DatabaseSync(githubSnapshot, { readOnly: true })
    const githubVersion = (githubSource.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    const githubError = sourceCheck(githubSource, 'GitHub')
    const githubRepositories = new Set(
      (githubSource.prepare('SELECT github FROM repositories').all() as unknown as Array<{ github: string }>)
        .map(row => row.github),
    )
    githubSource.close()
    githubSource = null

    operation = { _tag: 'ReadSource', source: 'Routine' }
    routineSource = new DatabaseSync(routineSnapshot, { readOnly: true })
    const routineVersion = (routineSource.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    const routineError = sourceCheck(routineSource, 'Routine')
    const missing = (routineSource.prepare('SELECT DISTINCT repository FROM routines ORDER BY repository').all() as unknown as Array<{ repository: string }>)
      .find(row => !githubRepositories.has(row.repository))
    routineSource.close()
    routineSource = null

    if (githubVersion !== routineVersion)
      return err({ _tag: 'SchemaMismatch', githubVersion, routineVersion })
    if (githubError !== null)
      return err(githubError)
    if (routineError !== null)
      return err(routineError)
    if (missing !== undefined)
      return err({ _tag: 'RepositoryMissing', repository: missing.repository })

    operation = { _tag: 'PublishOutput' }
    const githubForBackup = new DatabaseSync(githubSnapshot, { readOnly: true })
    try {
      await snapshot(githubForBackup, combinedPath)
    }
    finally {
      githubForBackup.close()
    }
    combined = new DatabaseSync(combinedPath)
    combined.exec('PRAGMA foreign_keys = ON')
    combined.prepare('ATTACH DATABASE ? AS routine_state').run(routineSnapshot)
    let result: CombinedServiceState
    try {
      result = mergeRoutineState(combined)
    }
    catch (error) {
      return err({ _tag: 'StateConflict', reason: error instanceof Error ? error.message : String(error) })
    }
    finally {
      combined.exec('DETACH DATABASE routine_state')
      combined.close()
      combined = null
    }

    if (input.dryRun === true)
      return ok(result)
    chmodSync(combinedPath, lstatSync(githubPath).mode)
    try {
      linkSync(combinedPath, outputPath)
    }
    catch (error) {
      if (existsSync(outputPath))
        return err({ _tag: 'OutputExists', path: outputPath })
      throw error
    }
    return ok(result)
  }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return operation._tag === 'ReadSource'
      ? err({ _tag: 'SourceInvalid', source: operation.source, reason })
      : err({ _tag: 'OutputPublicationFailed', path: outputPath, reason })
  }
  finally {
    combined?.close()
    githubSource?.close()
    routineSource?.close()
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}
