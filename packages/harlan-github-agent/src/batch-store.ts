import type { DatabaseSync } from 'node:sqlite'
import type { Result } from './result.ts'
import type { Batch, BatchDependency, BatchIssue, BatchState, BatchUnit, BatchUnitState, ClaimedBatch, ClaimedIssueWorkTask, PlannedBatchUnit, RepositoryMapping } from './types.ts'
import { createHash } from 'node:crypto'
import { parseStoredIssueTriage } from './issue-triage.ts'
import { err, ok } from './result.ts'

/** How many Ready issues a repository needs before a Batch opens. One issue is plain Issue work. */
export const BATCH_MINIMUM_ISSUES = 2

/** A Batch never reserves more issues than one planning turn can read with care. */
export const BATCH_MAXIMUM_ISSUES = 12

export interface BatchStore {
  /**
   * Opens one Queued Batch per repository that has enough Ready Routine-filed
   * issues waiting and no Batch already open. Reserves their Issue work Tasks in
   * the same transaction, so the plain Issue work scheduler cannot claim them.
   */
  planBatches: (at: string) => Array<{ batchId: string, repository: string, issueNumbers: number[] }>
  claimNextBatch: (workerId: string, now: string, leaseMilliseconds: number) => ClaimedBatch | null
  heartbeatBatch: (input: { batchId: string, workerId: string, fence: number, at: string, leaseMilliseconds: number }) => boolean
  /** Stores the planning turn's units. Issues the plan left out become single units, so nothing reserved is lost. */
  recordBatchPlan: (input: { batchId: string, workerId: string, fence: number, at: string, units: readonly PlannedBatchUnit[] }) => Result<readonly BatchUnit[], string>
  /** Claims one unit's primary Issue work Task under the exact-Task claim path, and marks the unit Running. */
  claimBatchUnitTask: (input: { unitId: string, workerId: string, now: string, leaseMilliseconds: number }) => ClaimedIssueWorkTask | null
  /** Where one unit's pull request stands, read by a unit that stacks on it. */
  getBatchDependency: (unitId: string) => BatchDependency
  settleBatchUnit: (input: { unitId: string, at: string, state: Exclude<BatchUnitState, { _tag: 'Waiting' | 'Running' }> }) => boolean
  /** Completes a Queued Issue work Task whose issue another unit's pull request closes. */
  completeCombinedIssueWork: (input: { taskId: string, at: string, evidence: string }) => boolean
  completeBatch: (input: { batchId: string, workerId: string, fence: number, at: string }) => boolean
  failBatch: (input: { batchId: string, workerId: string, fence: number, at: string, reason: string }) => boolean
  /** Why a reserved Issue work Task waits, keyed by Task id, for the dashboard Queue. */
  batchReservationReasons: () => Map<string, string>
  listBatches: (limit?: number) => Batch[]
}

export interface BatchStoreDependencies {
  claimIssueWorkTask: (workerId: string, now: string, leaseMilliseconds: number, exactTaskId: string) => ClaimedIssueWorkTask | null
  recordTransition: (input: { taskId: string, from: 'Queued', to: 'Completed', reason: string | null, fence: number, at: string }) => void
}

interface BatchRow {
  id: string
  repository: string
  repository_id: number
  policy_json: string
  state_tag: 'Queued' | 'Running' | 'Completed' | 'Failed'
  reason: string | null
  worker_id: string | null
  fence: number
  lease_expires_at: string | null
  plan: string | null
  created_at: string
  updated_at: string
}

interface UnitRow {
  id: string
  batch_id: string
  position: number
  primary_task_id: string
  issue_numbers: string
  depends_on_unit_id: string | null
  rationale: string
  state_tag: BatchUnitState['_tag']
  reason: string | null
  pull_request_number: number | null
  head_ref: string | null
  head_sha: string | null
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function batchState(row: BatchRow): BatchState {
  switch (row.state_tag) {
    case 'Queued': return { _tag: 'Queued' }
    case 'Running': return { _tag: 'Running', workerId: row.worker_id ?? '', fence: row.fence, leaseExpiresAt: row.lease_expires_at ?? '' }
    case 'Completed': return { _tag: 'Completed' }
    case 'Failed': return { _tag: 'Failed', reason: row.reason ?? 'The Batch failed.' }
  }
}

function unitState(row: UnitRow): BatchUnitState {
  switch (row.state_tag) {
    case 'Waiting': return { _tag: 'Waiting' }
    case 'Running': return { _tag: 'Running' }
    case 'Published': return { _tag: 'Published', pullRequestNumber: row.pull_request_number ?? 0, headRef: row.head_ref ?? '', headSha: row.head_sha ?? '' }
    case 'ActionRequired': return { _tag: 'ActionRequired', reason: row.reason ?? 'Action required.' }
    case 'Failed': return { _tag: 'Failed', reason: row.reason ?? 'The unit failed.' }
  }
}

function unit(row: UnitRow): BatchUnit {
  return {
    id: row.id,
    position: row.position,
    primaryTaskId: row.primary_task_id,
    issueNumbers: JSON.parse(row.issue_numbers) as number[],
    dependsOnUnitId: row.depends_on_unit_id,
    rationale: row.rationale,
    state: unitState(row),
  }
}

/**
 * Checks one plan against the issues a Batch reserved.
 *
 * Pure, so a test can hand it a plan and read the exact refusal. Issues the
 * plan never mentions come back as single units at the end, because a planning
 * turn that forgot one must not strand a Ready issue behind the Batch.
 */
export function normalizeBatchPlan(
  units: readonly PlannedBatchUnit[],
  reservedIssues: readonly number[],
): Result<PlannedBatchUnit[], string> {
  const reserved = new Set(reservedIssues)
  const seen = new Set<number>()
  const normalized: PlannedBatchUnit[] = []
  for (const [index, candidate] of units.entries()) {
    const issueNumbers = [...new Set(candidate.issueNumbers)]
    if (issueNumbers.length === 0)
      return err(`Unit ${index} names no issue.`)
    for (const issueNumber of issueNumbers) {
      if (!reserved.has(issueNumber))
        return err(`Unit ${index} names issue #${issueNumber}, which this Batch did not reserve.`)
      if (seen.has(issueNumber))
        return err(`Issue #${issueNumber} appears in two units.`)
      seen.add(issueNumber)
    }
    if (candidate.dependsOn !== null && (!Number.isInteger(candidate.dependsOn) || candidate.dependsOn < 0 || candidate.dependsOn >= index))
      return err(`Unit ${index} stacks on unit ${candidate.dependsOn}, which is not an earlier unit.`)
    normalized.push({ issueNumbers, dependsOn: candidate.dependsOn, rationale: candidate.rationale })
  }
  for (const issueNumber of reservedIssues) {
    if (!seen.has(issueNumber))
      normalized.push({ issueNumbers: [issueNumber], dependsOn: null, rationale: 'The plan did not place this issue, so it runs alone.' })
  }
  return ok(normalized)
}

export function createBatchStore(database: DatabaseSync, dependencies: BatchStoreDependencies): BatchStore {
  const readUnits = (batchId: string): BatchUnit[] => (database.prepare(`
    SELECT * FROM batch_units WHERE batch_id = ? ORDER BY position
  `).all(batchId) as unknown as UnitRow[]).map(unit)

  const readIssues = (batchId: string, repository: string): BatchIssue[] => {
    const rows = database.prepare(`
      SELECT
        batch_tasks.task_id,
        subjects.github_number AS issue_number,
        json_extract(revisions.payload, '$.title') AS title,
        tasks.revision_id,
        (
          SELECT worker_tasks.evidence FROM worker_tasks
          WHERE worker_tasks.subject_id = subjects.id AND worker_tasks.revision_id = tasks.revision_id
            AND worker_tasks.kind = 'issue_triage' AND worker_tasks.state_tag = 'Completed'
          ORDER BY worker_tasks.updated_at DESC LIMIT 1
        ) AS triage_evidence,
        (
          SELECT candidates.target FROM candidate_issue_commands
          JOIN candidates ON candidates.id = candidate_issue_commands.candidate_id
          WHERE candidate_issue_commands.repository = ? AND candidate_issue_commands.github_issue_number = subjects.github_number
            AND candidate_issue_commands.state_tag = 'Published'
          LIMIT 1
        ) AS target
      FROM batch_tasks
      JOIN tasks ON tasks.id = batch_tasks.task_id
      JOIN subjects ON subjects.id = tasks.subject_id
      JOIN revisions ON revisions.id = tasks.revision_id
      WHERE batch_tasks.batch_id = ?
      ORDER BY subjects.github_number
    `).all(repository, batchId) as unknown as Array<{ task_id: string, issue_number: number, title: string, triage_evidence: string | null, target: string | null }>
    return rows.map((row) => {
      const triage = parseStoredIssueTriage(row.triage_evidence)
      return {
        taskId: row.task_id,
        issueNumber: row.issue_number,
        title: row.title,
        body: '',
        triageSummary: triage === null ? null : `${triage.summary} Next action: ${triage.nextAction}`,
        relatedIssues: triage?.relatedIssues ?? [],
        target: row.target,
      }
    })
  }

  const readBatch = (row: BatchRow): Batch => ({
    id: row.id,
    repository: row.repository,
    state: batchState(row),
    issues: readIssues(row.id, row.repository),
    units: row.plan === null ? null : readUnits(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })

  const selectBatch = `
    SELECT batches.*, repositories.github AS repository, repositories.policy_json
    FROM batches
    JOIN repositories ON repositories.id = batches.repository_id
  `

  const transaction = <Value>(work: () => Value): Value => {
    database.exec('BEGIN IMMEDIATE')
    try {
      const value = work()
      database.exec('COMMIT')
      return value
    }
    catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  /** Frees every Task a finished Batch still holds, so plain Issue work can claim what the Batch left. */
  const releaseReservations = (batchId: string): void => {
    database.prepare('DELETE FROM batch_tasks WHERE batch_id = ?').run(batchId)
  }

  const recoverExpiredBatches = (now: string): void => {
    const expired = database.prepare(`
      SELECT id, fence FROM batches WHERE state_tag = 'Running' AND lease_expires_at <= ?
    `).all(now) as unknown as Array<{ id: string, fence: number }>
    expired.forEach((row) => {
      database.prepare(`
        UPDATE batches SET state_tag = 'Queued', worker_id = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state_tag = 'Running' AND fence = ?
      `).run(now, row.id, row.fence)
      // A unit that was mid-flight belongs to a dead Lease holder. Its Task lease
      // expires on its own, and the next Batch claim runs the unit again.
      database.prepare(`
        UPDATE batch_units SET state_tag = 'Waiting', reason = NULL, updated_at = ? WHERE batch_id = ? AND state_tag = 'Running'
      `).run(now, row.id)
    })
  }

  const planBatches: BatchStore['planBatches'] = at => transaction(() => {
    const eligible = database.prepare(`
      SELECT tasks.id AS task_id, repositories.id AS repository_id, repositories.github, subjects.github_number
      FROM tasks
      JOIN subjects ON subjects.id = tasks.subject_id
      JOIN repositories ON repositories.id = subjects.repository_id
      WHERE tasks.kind = 'issue_work' AND tasks.state_tag = 'Queued'
        AND tasks.revision_id = subjects.current_revision_id
        AND repositories.enabled = 1 AND repositories.paused = 0
        AND json_extract(repositories.policy_json, '$.issueWork') = 1
        AND NOT EXISTS (SELECT 1 FROM batch_tasks WHERE batch_tasks.task_id = tasks.id)
        AND NOT EXISTS (
          SELECT 1 FROM batches WHERE batches.repository_id = repositories.id AND batches.state_tag IN ('Queued', 'Running')
        )
        -- Routine-filed issues carry a target file and a fingerprint, so a plan
        -- over them is reliable. Human issues join once this has run a while.
        AND EXISTS (
          SELECT 1 FROM candidate_issue_commands
          WHERE candidate_issue_commands.repository = repositories.github
            AND candidate_issue_commands.github_issue_number = subjects.github_number
            AND candidate_issue_commands.state_tag = 'Published'
        )
      ORDER BY repositories.github, subjects.github_number
    `).all() as unknown as Array<{ task_id: string, repository_id: number, github: string, github_number: number }>
    const byRepository = new Map<string, typeof eligible>()
    eligible.forEach((row) => {
      const rows = byRepository.get(row.github) ?? []
      rows.push(row)
      byRepository.set(row.github, rows)
    })
    const opened: Array<{ batchId: string, repository: string, issueNumbers: number[] }> = []
    for (const [repository, rows] of byRepository) {
      if (rows.length < BATCH_MINIMUM_ISSUES)
        continue
      const chosen = rows.slice(0, BATCH_MAXIMUM_ISSUES)
      const batchId = digest(`${repository}:batch:${at}:${chosen.map(row => row.task_id).join(',')}`)
      database.prepare(`
        INSERT INTO batches (id, repository_id, state_tag, created_at, updated_at) VALUES (?, ?, 'Queued', ?, ?)
      `).run(batchId, chosen[0]!.repository_id, at, at)
      const reserve = database.prepare('INSERT INTO batch_tasks (batch_id, task_id) VALUES (?, ?)')
      chosen.forEach(row => reserve.run(batchId, row.task_id))
      opened.push({ batchId, repository, issueNumbers: chosen.map(row => row.github_number) })
    }
    return opened
  })

  const claimNextBatch: BatchStore['claimNextBatch'] = (workerId, now, leaseMilliseconds) => transaction(() => {
    recoverExpiredBatches(now)
    const row = database.prepare(`
      ${selectBatch}
      WHERE batches.state_tag = 'Queued' AND batches.attempts < batches.max_attempts
        AND repositories.enabled = 1 AND repositories.paused = 0
        AND json_extract(repositories.policy_json, '$.issueWork') = 1
      ORDER BY batches.created_at, batches.id
      LIMIT 1
    `).get() as BatchRow | undefined
    if (row === undefined)
      return null
    const fence = row.fence + 1
    const leaseExpiresAt = new Date(new Date(now).getTime() + leaseMilliseconds).toISOString()
    const update = database.prepare(`
      UPDATE batches
      SET state_tag = 'Running', worker_id = ?, fence = ?, attempts = attempts + 1, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND state_tag = 'Queued' AND fence = ?
    `).run(workerId, fence, leaseExpiresAt, now, row.id, row.fence)
    if (update.changes !== 1)
      throw new Error(`Batch claim lost for ${row.id}.`)
    const batch = readBatch({ ...row, state_tag: 'Running', worker_id: workerId, fence, lease_expires_at: leaseExpiresAt, updated_at: now })
    return {
      ...batch,
      state: { _tag: 'Running', workerId, fence, leaseExpiresAt },
      repositoryMapping: JSON.parse(row.policy_json) as RepositoryMapping,
    }
  })

  const ownedBatchSql = 'id = ? AND state_tag = \'Running\' AND worker_id = ? AND fence = ? AND lease_expires_at > ?'

  const heartbeatBatch: BatchStore['heartbeatBatch'] = input => database.prepare(`
    UPDATE batches SET lease_expires_at = ?, updated_at = ? WHERE ${ownedBatchSql}
  `).run(
    new Date(new Date(input.at).getTime() + input.leaseMilliseconds).toISOString(),
    input.at,
    input.batchId,
    input.workerId,
    input.fence,
    input.at,
  ).changes === 1

  const recordBatchPlan: BatchStore['recordBatchPlan'] = input => transaction(() => {
    const owned = database.prepare(`SELECT 1 FROM batches WHERE ${ownedBatchSql} AND plan IS NULL`)
      .get(input.batchId, input.workerId, input.fence, input.at)
    if (owned === undefined)
      return err('This Lease holder no longer owns the Batch, or the Batch already has a plan.')
    const reserved = database.prepare(`
      SELECT batch_tasks.task_id, subjects.github_number
      FROM batch_tasks
      JOIN tasks ON tasks.id = batch_tasks.task_id
      JOIN subjects ON subjects.id = tasks.subject_id
      WHERE batch_tasks.batch_id = ?
    `).all(input.batchId) as unknown as Array<{ task_id: string, github_number: number }>
    const taskByIssue = new Map(reserved.map(row => [row.github_number, row.task_id]))
    const normalized = normalizeBatchPlan(input.units, reserved.map(row => row.github_number))
    if (normalized._tag === 'Err')
      return normalized
    const unitIds = normalized.value.map((_, position) => digest(`${input.batchId}:unit:${position}`))
    const insert = database.prepare(`
      INSERT INTO batch_units (id, batch_id, position, primary_task_id, issue_numbers, depends_on_unit_id, rationale, state_tag, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Waiting', ?)
    `)
    const assign = database.prepare('UPDATE batch_tasks SET unit_id = ? WHERE task_id = ?')
    normalized.value.forEach((planned, position) => {
      const primaryTaskId = taskByIssue.get(planned.issueNumbers[0]!)!
      insert.run(
        unitIds[position]!,
        input.batchId,
        position,
        primaryTaskId,
        JSON.stringify(planned.issueNumbers),
        planned.dependsOn === null ? null : unitIds[planned.dependsOn]!,
        planned.rationale,
        input.at,
      )
      planned.issueNumbers.forEach(issueNumber => assign.run(unitIds[position]!, taskByIssue.get(issueNumber)!))
    })
    database.prepare('UPDATE batches SET plan = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(normalized.value), input.at, input.batchId)
    return ok(readUnits(input.batchId))
  })

  const claimBatchUnitTask: BatchStore['claimBatchUnitTask'] = (input) => {
    const row = database.prepare(`
      SELECT primary_task_id FROM batch_units WHERE id = ? AND state_tag = 'Waiting'
    `).get(input.unitId) as { primary_task_id: string } | undefined
    if (row === undefined)
      return null
    const task = dependencies.claimIssueWorkTask(input.workerId, input.now, input.leaseMilliseconds, row.primary_task_id)
    if (task === null)
      return null
    database.prepare(`UPDATE batch_units SET state_tag = 'Running', reason = NULL, updated_at = ? WHERE id = ?`).run(input.now, input.unitId)
    return task
  }

  const getBatchDependency: BatchStore['getBatchDependency'] = (unitId) => {
    const row = database.prepare(`
      SELECT
        batch_units.state_tag, batch_units.reason, batch_units.pull_request_number, batch_units.head_ref, batch_units.head_sha,
        tasks.state_tag AS task_state, tasks.reason AS task_reason,
        publication_commands.state_tag AS publication_state, publication_commands.reason AS publication_reason,
        publication_commands.head_ref AS publication_head_ref, publication_commands.commit_sha, publication_commands.pull_request_number AS published_number
      FROM batch_units
      JOIN tasks ON tasks.id = batch_units.primary_task_id
      LEFT JOIN publication_commands ON publication_commands.task_id = tasks.id
        AND publication_commands.state_tag IN ('Pending', 'Running', 'Published', 'Failed')
      WHERE batch_units.id = ?
      ORDER BY publication_commands.updated_at DESC
      LIMIT 1
    `).get(unitId) as {
      state_tag: BatchUnitState['_tag']
      reason: string | null
      pull_request_number: number | null
      head_ref: string | null
      head_sha: string | null
      task_state: string
      task_reason: string | null
      publication_state: string | null
      publication_reason: string | null
      publication_head_ref: string | null
      commit_sha: string | null
      published_number: number | null
    } | undefined
    if (row === undefined)
      return { _tag: 'Unavailable', reason: 'The unit does not exist.' }
    if (row.state_tag === 'Published' && row.pull_request_number !== null && row.head_ref !== null && row.head_sha !== null)
      return { _tag: 'Published', pullRequestNumber: row.pull_request_number, headRef: row.head_ref, headSha: row.head_sha }
    if (row.state_tag === 'ActionRequired' || row.state_tag === 'Failed')
      return { _tag: 'Unavailable', reason: row.reason ?? 'The unit did not publish.' }
    if (row.publication_state === 'Published' && row.published_number !== null && row.publication_head_ref !== null && row.commit_sha !== null)
      return { _tag: 'Published', pullRequestNumber: row.published_number, headRef: row.publication_head_ref, headSha: row.commit_sha }
    if (row.publication_state === 'Failed')
      return { _tag: 'Unavailable', reason: row.publication_reason ?? 'The unit publication failed.' }
    if (row.task_state === 'Failed' || row.task_state === 'ActionRequired' || row.task_state === 'Superseded')
      return { _tag: 'Unavailable', reason: row.task_reason ?? `The unit Task is ${row.task_state}.` }
    return { _tag: 'Pending' }
  }

  const settleBatchUnit: BatchStore['settleBatchUnit'] = (input) => {
    const state = input.state
    const published = state._tag === 'Published' ? state : null
    return database.prepare(`
      UPDATE batch_units
      SET state_tag = ?, reason = ?, pull_request_number = ?, head_ref = ?, head_sha = ?, updated_at = ?
      WHERE id = ? AND state_tag IN ('Waiting', 'Running')
    `).run(
      state._tag,
      state._tag === 'Published' ? null : state.reason,
      published?.pullRequestNumber ?? null,
      published?.headRef ?? null,
      published?.headSha ?? null,
      input.at,
      input.unitId,
    ).changes === 1
  }

  const completeCombinedIssueWork: BatchStore['completeCombinedIssueWork'] = input => transaction(() => {
    const row = database.prepare('SELECT fence FROM tasks WHERE id = ? AND state_tag = \'Queued\'').get(input.taskId) as { fence: number } | undefined
    if (row === undefined)
      return false
    const result = database.prepare(`
      UPDATE tasks SET state_tag = 'Completed', evidence = ?, reason = NULL, updated_at = ? WHERE id = ? AND state_tag = 'Queued'
    `).run(input.evidence, input.at, input.taskId)
    if (result.changes === 1)
      dependencies.recordTransition({ taskId: input.taskId, from: 'Queued', to: 'Completed', reason: 'Another unit of the Batch closes this issue.', fence: row.fence, at: input.at })
    return result.changes === 1
  })

  const finishBatch = (input: { batchId: string, workerId: string, fence: number, at: string }, state: 'Completed' | 'Failed', reason: string | null): boolean => transaction(() => {
    const result = database.prepare(`
      UPDATE batches SET state_tag = ?, reason = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE ${ownedBatchSql}
    `).run(state, reason, input.at, input.batchId, input.workerId, input.fence, input.at)
    if (result.changes === 1)
      releaseReservations(input.batchId)
    return result.changes === 1
  })

  const completeBatch: BatchStore['completeBatch'] = input => finishBatch(input, 'Completed', null)
  const failBatch: BatchStore['failBatch'] = input => finishBatch(input, 'Failed', input.reason)

  const batchReservationReasons: BatchStore['batchReservationReasons'] = () => {
    const rows = database.prepare(`
      SELECT batch_tasks.task_id, batch_tasks.batch_id, subjects.github_number
      FROM batch_tasks
      JOIN tasks ON tasks.id = batch_tasks.task_id
      JOIN subjects ON subjects.id = tasks.subject_id
      WHERE tasks.state_tag = 'Queued'
      ORDER BY subjects.github_number
    `).all() as unknown as Array<{ task_id: string, batch_id: string, github_number: number }>
    const issuesByBatch = new Map<string, number[]>()
    rows.forEach((row) => {
      const numbers = issuesByBatch.get(row.batch_id) ?? []
      numbers.push(row.github_number)
      issuesByBatch.set(row.batch_id, numbers)
    })
    return new Map(rows.map((row) => {
      const others = (issuesByBatch.get(row.batch_id) ?? []).filter(number => number !== row.github_number).map(number => `#${number}`)
      return [row.task_id, others.length === 0 ? 'Planned in a Batch.' : `Planned in a Batch with ${others.join(', ')}.`]
    }))
  }

  const listBatches: BatchStore['listBatches'] = (limit = 20) => (database.prepare(`
    ${selectBatch} ORDER BY batches.created_at DESC LIMIT ?
  `).all(Math.max(1, Math.min(200, Math.trunc(limit)))) as unknown as BatchRow[]).map(readBatch)

  return {
    planBatches,
    claimNextBatch,
    heartbeatBatch,
    recordBatchPlan,
    claimBatchUnitTask,
    getBatchDependency,
    settleBatchUnit,
    completeCombinedIssueWork,
    completeBatch,
    failBatch,
    batchReservationReasons,
    listBatches,
  }
}
