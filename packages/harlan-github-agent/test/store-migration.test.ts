import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { repositoryQuarantineReason } from '../src/github-write-gate.ts'
import { openJournalStore } from '../src/store.ts'
import { issueItem, pullRequestItem, repositoryMapping } from './fixtures.ts'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'harlan-agent-store-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function dropReviewResolutionAdditions(database: DatabaseSync): void {
  dropRestartOperationAdditions(database)
  database.exec('DROP TABLE IF EXISTS review_gate_projections')
  database.exec('DROP INDEX IF EXISTS routines_active')
  const routineRunColumns = database.prepare('PRAGMA table_info(routine_runs)').all() as unknown as Array<{ name: string }>
  if (routineRunColumns.some(column => column.name === 'mode'))
    database.exec('ALTER TABLE routine_runs DROP COLUMN mode')
  const routineColumns = database.prepare('PRAGMA table_info(routines)').all() as unknown as Array<{ name: string }>
  if (routineColumns.some(column => column.name === 'retired_at'))
    database.exec('ALTER TABLE routines DROP COLUMN retired_at')
  database.exec('DROP TABLE IF EXISTS review_evidence_scopes')
  database.exec('DROP TABLE IF EXISTS review_resolutions')
  const reviewStatusColumns = database.prepare('PRAGMA table_info(review_status_commands)').all() as unknown as Array<{ name: string }>
  if (reviewStatusColumns.some(column => column.name === 'desired_outcome'))
    database.exec('ALTER TABLE review_status_commands DROP COLUMN desired_outcome')
  if (reviewStatusColumns.some(column => column.name === 'review_run_id'))
    database.exec('ALTER TABLE review_status_commands DROP COLUMN review_run_id')
}

/** Rewinds past the Repair report table, which every version below 60 predates. */
function dropRepairReports(database: DatabaseSync): void {
  database.exec('DROP TABLE IF EXISTS repair_reports')
}

function dropRestartOperationAdditions(database: DatabaseSync): void {
  dropRepairReports(database)
  const columns = database.prepare('PRAGMA table_info(restart_requests)').all() as unknown as Array<{ name: string }>
  if (columns.some(column => column.name === 'target_commit'))
    database.exec('ALTER TABLE restart_requests DROP COLUMN target_commit')
  if (columns.some(column => column.name === 'operation_tag'))
    database.exec('ALTER TABLE restart_requests DROP COLUMN operation_tag')
}

/** Rewinds past the Routine tables, which every version below 38 predates. */
function dropRoutines(database: DatabaseSync): void {
  dropReviewResolutionAdditions(database)
  database.exec('DROP TABLE IF EXISTS provider_circuits')
  database.exec('DROP TABLE IF EXISTS workflow_events')
  database.exec('DROP TABLE IF EXISTS pull_request_closure_verifications')
  database.exec('DROP TABLE IF EXISTS review_closure_resolutions')
  database.exec('DROP TABLE IF EXISTS restart_requests')
  database.exec('DROP TABLE IF EXISTS agent_feedback')
  database.exec('DROP TABLE IF EXISTS routine_report_commands')
  database.exec('DROP TABLE IF EXISTS candidate_issue_commands')
  database.exec('DROP TABLE IF EXISTS candidates')
  database.exec('DROP TABLE IF EXISTS routine_runs')
  database.exec('DROP TABLE IF EXISTS routines')
}

/** Every rewind here predates the newest schema, so its additions have to go too. */
function dropSelectionMode(database: DatabaseSync): void {
  database.exec('ALTER TABLE agent_control DROP COLUMN selection_mode')
  database.exec('DROP TABLE item_dismissals')
  database.exec('ALTER TABLE repositories DROP COLUMN writes_enabled')
  dropRoutines(database)
  restoreExpectedUpdatedAt(database)
}

/** Rewinds the triage comment table to version 49, which still stored the expected updated at. */
function restoreExpectedUpdatedAt(database: DatabaseSync): void {
  database.exec(`ALTER TABLE issue_triage_comment_commands ADD COLUMN expected_updated_at TEXT NOT NULL DEFAULT ''`)
}

/**
 * Builds a journal that still speaks the pre-GitHub vocabulary.
 *
 * Opening it at the current version has to carry the old rows across, which is
 * the part a fresh in-memory database can never exercise: a new journal has no
 * `Waiting` or `NeedsAttention` row to migrate.
 */
function journalAtVersion22(path: string): void {
  const store = openJournalStore(path, true, CODEX_AGENT_PROFILE)
  store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
  store.setRepositoryWritesEnabled('harlan-zw/example', true)
  store.recordObservation({
    externalId: 'legacy-pr',
    observedAt: '2026-08-18T00:00:00.000Z',
    source: 'poll',
    subject: pullRequestItem({ mergeState: 'clean' }),
  })
  store.close()

  const database = new DatabaseSync(path)
  database.exec('PRAGMA foreign_keys = OFF')
  // Rewind the vocabulary and the schema version to what version 22 stored.
  for (const table of ['tasks', 'worker_tasks']) {
    const definition = (database.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
    ).get(table) as { sql: string }).sql
    // `ALTER TABLE ... RENAME` rewrites sqlite_master with the name quoted.
    database.exec(definition
      .replace(new RegExp(`CREATE TABLE\\s+"?${table}"?`), `CREATE TABLE ${table}_v22`)
      .replaceAll(`'ActionRequired'`, `'NeedsAttention'`))
    database.exec(`INSERT INTO ${table}_v22 SELECT * FROM ${table}`)
    database.exec(`DROP TABLE ${table}`)
    database.exec(`ALTER TABLE ${table}_v22 RENAME TO ${table}`)
  }
  database.exec('ALTER TABLE review_runs DROP COLUMN usage')
  database.exec(`ALTER TABLE review_runs RENAME TO attempts`)
  database.exec(`ALTER TABLE review_publications RENAME COLUMN review_run_id TO attempt_id`)
  const attempts = (database.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attempts'`,
  ).get() as { sql: string }).sql
  database.exec(attempts
    .replace(/CREATE TABLE\s+"?attempts"?/, 'CREATE TABLE attempts_v22')
    .replaceAll(`'Pending'`, `'Waiting'`))
  database.exec('INSERT INTO attempts_v22 SELECT * FROM attempts')
  database.exec('DROP TABLE attempts')
  database.exec('ALTER TABLE attempts_v22 RENAME TO attempts')

  // Version 22 also named its indexes after the old table.
  database.exec('DROP INDEX IF EXISTS review_runs_subject_completed')
  database.exec('DROP INDEX IF EXISTS review_publications_run_created')
  database.exec('CREATE INDEX attempts_subject_completed ON attempts(subject_id, completed_at DESC)')
  database.exec('CREATE INDEX review_publications_attempt_created ON review_publications(attempt_id, created_at)')

  database.prepare(`UPDATE worker_tasks SET state_tag = 'NeedsAttention', reason = 'Legacy state.'`).run()
  // Version 22 stored no Agent selection.
  database.exec('DROP TABLE IF EXISTS agent_selection')
  dropSelectionMode(database)
  database.exec('PRAGMA user_version = 22')
  database.close()
}

/**
 * Builds a journal with one Published Publication, then removes the base branch
 * column so the stack migration has a real row to backfill.
 */
function journalAtVersion25(path: string): void {
  const store = openJournalStore(path, true, CODEX_AGENT_PROFILE)
  store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
  store.setRepositoryWritesEnabled('harlan-zw/example', true)
  store.recordObservation({
    externalId: 'migrated-pr',
    observedAt: '2026-08-18T00:00:00.000Z',
    source: 'poll',
    subject: pullRequestItem({ mergeState: 'clean' }),
  })
  const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-18T00:01:00.000Z', 600_000)
  if (review === null)
    throw new Error('Expected the review Task.')
  const queued = store.queueBaselineRepairForReview({
    taskId: review.id,
    workerId: review.state.workerId,
    fence: review.state.fence,
    baseSha: review.pullRequest.baseSha,
    at: '2026-08-18T00:02:00.000Z',
  })
  if (queued._tag === 'Rejected' || queued._tag === 'NotAuthorized')
    throw new Error(queued.reason)
  const repair = store.claimNextBaselineRepairTask('baseline-agent', '2026-08-18T00:03:00.000Z', 600_000)
  if (repair === null)
    throw new Error('Expected the Baseline repair Task.')
  const staged = store.stagePublication({
    taskId: repair.id,
    workerId: repair.state.workerId,
    fence: repair.state.fence,
    at: '2026-08-18T00:04:00.000Z',
    publication: {
      _tag: 'OpenPullRequest',
      taskKind: 'baseline_repair',
      pullRequestNumber: repair.pullRequestNumber,
      pullRequestTitle: 'fix(ci): repair the default branch',
      pullRequestBody: 'Repairs default branch CI.',
      commitSha: 'baseline-commit',
      baseSha: repair.pullRequest.baseSha,
      baseRef: 'main',
      expectedHeadSha: repair.pullRequest.baseSha,
      headRef: 'fix/baseline-ci-abcdef012345',
      artifactRef: 'refs/harlan-github-agent/publications/baseline',
      patchDigest: 'patch',
      changedFiles: 1,
    },
  })
  if (staged._tag !== 'Staged')
    throw new Error('Expected a staged publication.')
  store.close()

  const database = new DatabaseSync(path)
  database.exec('PRAGMA foreign_keys = OFF')
  const definition = (database.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'publication_commands'`,
  ).get() as { sql: string }).sql
  const columns = (database.prepare('PRAGMA table_info(publication_commands)').all() as unknown as Array<{ name: string }>)
    .map(column => column.name)
    .filter(name => name !== 'base_ref')
  database.exec(definition
    .replace(/CREATE TABLE\s+"?publication_commands"?/, 'CREATE TABLE publication_commands_v25')
    .replace(/\s*base_ref TEXT NOT NULL CHECK \(base_ref != ''\),/, '')
    .replace(/\s*-- [^\n]*\n\s*CHECK \(base_ref != head_ref\),/, ''))
  database.exec(`INSERT INTO publication_commands_v25 (${columns.join(', ')}) SELECT ${columns.join(', ')} FROM publication_commands`)
  database.exec('DROP TABLE publication_commands')
  database.exec('ALTER TABLE publication_commands_v25 RENAME TO publication_commands')
  database.exec('CREATE INDEX publication_commands_state_tag ON publication_commands(state_tag)')
  database.exec(`CREATE UNIQUE INDEX one_live_publication_command_per_task
    ON publication_commands(task_id) WHERE state_tag IN ('Pending', 'Running', 'Published')`)
  const rebuilt = database.prepare('PRAGMA table_info(publication_commands)').all() as unknown as Array<{ name: string }>
  if (rebuilt.some(column => column.name === 'base_ref'))
    throw new Error('Version 25 stored no base branch, so the rewind must remove that column.')
  database.exec('ALTER TABLE review_runs DROP COLUMN usage')
  dropSelectionMode(database)
  database.exec('PRAGMA user_version = 25')
  database.close()
}

function journalAtVersion30(path: string): void {
  const store = openJournalStore(path, true, CODEX_AGENT_PROFILE)
  store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
  store.setRepositoryWritesEnabled('harlan-zw/example', true)
  const observed = store.recordObservation({
    externalId: 'review-usage-migration',
    observedAt: '2026-08-18T00:00:00.000Z',
    source: 'poll',
    subject: pullRequestItem({ mergeState: 'clean' }),
  })
  store.close()
  if (observed._tag !== 'Inserted')
    throw new Error('Expected the Review migration pull request.')

  const database = new DatabaseSync(path)
  database.exec('ALTER TABLE review_runs DROP COLUMN usage')
  const subject = database.prepare(`SELECT id FROM subjects WHERE github_number = 24`).get() as { id: number }
  database.prepare(`
    INSERT INTO review_runs (
      id, subject_id, revision_id, kind, provider, session_id, model, agent_version,
      skill_digest, head_sha, started_at, completed_at, gates, outcome_tag,
      confidence, findings, content_digest
    ) VALUES (?, ?, ?, 'adversarial_review', 'codex', 'session-legacy', 'gpt-5.6-sol',
      '1.0.0', ?, 'abc123', ?, ?, ?, 'Ready', 95, '[]', ?)
  `).run(
    'legacy-review-run',
    subject.id,
    observed.revisionId,
    'f'.repeat(64),
    '2026-08-18T00:01:00.000Z',
    '2026-08-18T00:02:00.000Z',
    JSON.stringify({
      head: { _tag: 'Passed', evidence: [] },
      merge: { _tag: 'Passed', evidence: [] },
      metadata: { _tag: 'Passed', evidence: [] },
      review: { _tag: 'Passed', evidence: [] },
      verification: { _tag: 'Passed', evidence: [] },
      ci: { _tag: 'Passed', evidence: [] },
    }),
    'a'.repeat(64),
  )
  dropRoutines(database)
  restoreExpectedUpdatedAt(database)
  database.exec('PRAGMA user_version = 30')
  database.close()
}

describe('stacked pull request migration', () => {
  it('gives every existing Publication the default branch as its base', () => {
    const path = join(directory, 'state.sqlite')
    journalAtVersion25(path)

    const store = openJournalStore(path, true, CODEX_AGENT_PROFILE)
    const claimed = store.claimNextPublication('publisher', '2026-08-18T00:05:00.000Z', 60_000)
    store.close()

    expect(claimed).toEqual(expect.objectContaining({ baseRef: 'main', headRef: 'fix/baseline-ci-abcdef012345' }))
  })
})

describe('review usage migration', () => {
  it('marks older Review runs as unavailable', () => {
    const path = join(directory, 'state.sqlite')
    journalAtVersion30(path)

    const store = openJournalStore(path, true, CODEX_AGENT_PROFILE)
    try {
      expect(store.listReviewRuns('harlan-zw/example', 24)[0]?.usage).toEqual({ _tag: 'Unavailable' })
    }
    finally {
      store.close()
    }
  })
})

describe('pull request closure verification migration', () => {
  it('rechecks closure resolutions written before exact verification existed', () => {
    const path = join(directory, 'state.sqlite')
    const store = openJournalStore(path, true, CODEX_AGENT_PROFILE)
    const repository = repositoryMapping()
    const pullRequest = pullRequestItem({ mergeState: 'clean' })
    store.syncRepositories([repository], '2026-08-18T00:00:00.000Z')
    store.setRepositoryWritesEnabled(repository.github, true)
    const observed = store.recordObservation({
      externalId: 'review-before-legacy-closure',
      observedAt: '2026-08-18T00:00:00.000Z',
      source: 'poll',
      subject: pullRequest,
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected the open pull request Revision.')
    const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-18T00:01:00.000Z', 600_000)
    if (review === null)
      throw new Error('Expected the Review Task.')
    const staged = store.stageReviewStatus({
      taskKind: 'adversarial_review',
      phase: 'terminal',
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-18T00:02:00.000Z',
      revisionId: review.revisionId,
      expectedHeadSha: pullRequest.headSha,
      body: '### 🤖 READY',
    })
    if (staged._tag === 'Rejected')
      throw new Error(staged.reason)
    const command = store.claimReviewStatus(staged.commandId, 'status-agent', '2026-08-18T00:02:01.000Z', 60_000)
    if (command === null)
      throw new Error('Expected the Review status command.')
    store.completeReviewStatus({
      commandId: command.id,
      workerId: command.workerId,
      fence: command.fence,
      at: '2026-08-18T00:02:02.000Z',
      commentId: 42,
      url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
    })
    store.completeWorkerTask({
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-18T00:02:03.000Z',
      evidence: 'Review finished.',
    })
    const merged = store.recordObservation({
      externalId: 'legacy-closure-resolution',
      observedAt: '2026-08-18T00:03:00.000Z',
      source: 'poll',
      subject: {
        ...pullRequest,
        state: 'closed',
        mergedAt: '2026-08-18T00:03:00.000Z',
        updatedAt: '2026-08-18T00:03:00.000Z',
      },
    })
    if (merged._tag !== 'Inserted')
      throw new Error('Expected the merged pull request Revision.')
    expect(store.recordVerifiedPullRequestClosure({
      repository: repository.github,
      pullRequestNumber: pullRequest.number,
      revisionId: merged.revisionId,
      headSha: pullRequest.headSha,
      baseSha: pullRequest.baseSha,
      disposition: { _tag: 'Merged' },
      at: '2026-08-18T00:03:00.000Z',
    })).toBe(true)
    expect(store.recordReviewClosure({
      repository: repository.github,
      pullRequestNumber: pullRequest.number,
      revisionId: merged.revisionId,
      headSha: pullRequest.headSha,
      baseSha: pullRequest.baseSha,
      disposition: { _tag: 'Merged' },
      result: { _tag: 'Superseded' },
      at: '2026-08-18T00:04:00.000Z',
    })).toBe(true)
    store.close()

    const oldJournal = new DatabaseSync(path)
    dropReviewResolutionAdditions(oldJournal)
    oldJournal.exec(`
      DROP TABLE provider_circuits;
      DROP TABLE workflow_events;
      ALTER TABLE routine_runs DROP COLUMN usage;
      DROP TABLE pull_request_closure_verifications;
      PRAGMA user_version = 48;
    `)
    restoreExpectedUpdatedAt(oldJournal)
    oldJournal.close()

    const migrated = openJournalStore(path, true, CODEX_AGENT_PROFILE)
    try {
      expect(migrated.listUnverifiedClosedPullRequestNumbers(repository.github)).toEqual([pullRequest.number])
    }
    finally {
      migrated.close()
    }
  })
})

describe('installation permission recovery migration', () => {
  it('gives Tasks blocked by the old Workflow permission request one bounded recovery', () => {
    const path = join(directory, 'state.sqlite')
    const store = openJournalStore(path, true, CODEX_AGENT_PROFILE)
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.setRepositoryWritesEnabled('harlan-zw/example', true)
    store.recordObservation({
      externalId: 'old-workflow-permission',
      observedAt: '2026-08-18T00:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem(),
    })
    const reason = 'The level of access for permissions requested are not granted to this installation.'
    let elapsedMilliseconds = 0
    const at = (advance = 1_000) => {
      elapsedMilliseconds += advance
      return new Date(Date.parse('2026-08-18T00:00:00.000Z') + elapsedMilliseconds).toISOString()
    }
    for (let recovery = 0; recovery <= 5; recovery += 1) {
      for (const attempt of [1, 2, 3]) {
        const task = store.claimNextConflictTask(`worker-${recovery}-${attempt}`, at(), 60_000)
        if (task === null)
          throw new Error(`Expected attempt ${attempt} of recovery ${recovery}.`)
        store.failTask({
          taskId: task.id,
          workerId: task.state.workerId,
          fence: task.state.fence,
          at: at(),
          reason,
        })
      }
      if (recovery < 5)
        expect(store.retryRecoverableWorkerFailures(at(3_600_000))).toBe(1)
    }
    expect(store.listIncidents()[0]?.recovery).toEqual({ _tag: 'Exhausted' })
    store.close()

    const oldJournal = new DatabaseSync(path)
    dropRoutines(oldJournal)
    restoreExpectedUpdatedAt(oldJournal)
    oldJournal.exec('PRAGMA user_version = 32')
    oldJournal.close()

    const migrated = openJournalStore(path, true, CODEX_AGENT_PROFILE)
    try {
      expect(migrated.listIncidents()).toEqual([])
      expect(migrated.retryRecoverableWorkerFailures(at())).toBe(1)
      expect(migrated.claimNextConflictTask('recovered-worker', at(), 60_000)).not.toBeNull()
    }
    finally {
      migrated.close()
    }
  })
})

describe('provider session recovery migration', () => {
  it('gives exhausted provider stalls one fresh Agent recovery', () => {
    const path = join(directory, 'state.sqlite')
    const store = openJournalStore(path, true, CODEX_AGENT_PROFILE)
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
    store.setRepositoryWritesEnabled('harlan-zw/example', true)
    store.recordObservation({
      externalId: 'stalled-issue',
      observedAt: '2026-08-18T00:00:00.000Z',
      source: 'poll',
      subject: issueItem(),
    })
    const reason = 'The opencode session stopped sending output.'
    let elapsedMilliseconds = 0
    const at = (advance = 1_000) => {
      elapsedMilliseconds += advance
      return new Date(Date.parse('2026-08-18T00:00:00.000Z') + elapsedMilliseconds).toISOString()
    }
    for (let recovery = 0; recovery <= 5; recovery += 1) {
      for (const attempt of [1, 2, 3]) {
        const task = store.claimNextIssueTriageTask(`worker-${recovery}-${attempt}`, at(), 60_000)
        if (task === null)
          throw new Error(`Expected attempt ${attempt} of recovery ${recovery}.`)
        store.failWorkerTask({
          taskId: task.id,
          workerId: task.state.workerId,
          fence: task.state.fence,
          at: at(),
          reason,
        })
      }
      if (recovery < 5)
        expect(store.retryRecoverableWorkerFailures(at(3_600_000))).toBe(1)
    }
    expect(store.listIncidents()[0]?.recovery).toEqual(expect.objectContaining({ _tag: 'Retrying' }))
    store.close()

    const oldJournal = new DatabaseSync(path)
    dropRoutines(oldJournal)
    restoreExpectedUpdatedAt(oldJournal)
    oldJournal.exec('PRAGMA user_version = 34')
    oldJournal.close()

    const migrated = openJournalStore(path, true, CODEX_AGENT_PROFILE)
    try {
      expect(migrated.listIncidents()).toEqual([])
      expect(migrated.retryRecoverableWorkerFailures(at())).toBe(1)
      expect(migrated.claimNextIssueTriageTask('fresh-worker', at(), 60_000)?.state.fence).toBeGreaterThan(1)
    }
    finally {
      migrated.close()
    }
  })
})

describe('review status Incident recovery migration', () => {
  it('clears only Service Incidents that predate repository-scoped Publication recovery', () => {
    const path = join(directory, 'state.sqlite')
    const store = openJournalStore(path, true, CODEX_AGENT_PROFILE)
    store.recordIncident({
      scope: { _tag: 'Service' },
      kind: 'unknown',
      severity: 'error',
      operation: 'review_status_publication',
      message: 'GitHub did not stamp the harlan-agent-ready label.',
      recovery: { _tag: 'ActionRequired' },
      at: '2026-08-31T14:18:11.426Z',
    })
    store.recordIncident({
      scope: { _tag: 'Service' },
      kind: 'network',
      severity: 'warning',
      operation: 'review_rerun',
      message: 'GitHub timed out.',
      recovery: { _tag: 'Retrying', attempt: 1, nextAttemptAt: '2026-08-31T14:19:11.426Z' },
      at: '2026-08-31T14:18:11.426Z',
    })
    store.close()

    const oldJournal = new DatabaseSync(path)
    dropRestartOperationAdditions(oldJournal)
    oldJournal.exec('PRAGMA user_version = 56')
    oldJournal.close()

    const migrated = openJournalStore(path, true, CODEX_AGENT_PROFILE)
    try {
      expect(migrated.listIncidents()).toMatchObject([{
        operation: 'review_rerun',
        message: 'GitHub timed out.',
      }])
    }
    finally {
      migrated.close()
    }
  })
})

describe('write quarantine Incident recovery migration', () => {
  it('clears every legacy quarantine scope and preserves genuine policy Incidents', () => {
    const path = join(directory, 'state.sqlite')
    const store = openJournalStore(path, true, CODEX_AGENT_PROFILE)
    const repository = 'harlan-zw/example'
    const message = repositoryQuarantineReason(repository)
    store.recordIncident({
      scope: { _tag: 'Repository', repository },
      kind: 'policy',
      severity: 'warning',
      operation: 'write',
      message,
      recovery: { _tag: 'ActionRequired' },
      at: '2026-09-02T00:00:00.000Z',
    })
    store.recordIncident({
      scope: { _tag: 'Task', taskId: 'legacy-task', repository, itemNumber: 24 },
      kind: 'policy',
      severity: 'error',
      operation: 'adversarial_review',
      message,
      recovery: { _tag: 'ActionRequired' },
      at: '2026-09-02T00:00:01.000Z',
    })
    store.recordIncident({
      scope: { _tag: 'Service' },
      kind: 'policy',
      severity: 'warning',
      operation: 'running_label',
      message: `${repository}: ${message}`,
      recovery: { _tag: 'ActionRequired' },
      at: '2026-09-02T00:00:02.000Z',
    })
    store.recordIncident({
      scope: { _tag: 'Repository', repository },
      kind: 'policy',
      severity: 'error',
      operation: 'configuration',
      message: 'The repository mapping is invalid.',
      recovery: { _tag: 'ActionRequired' },
      at: '2026-09-02T00:00:03.000Z',
    })
    store.close()

    const oldJournal = new DatabaseSync(path)
    dropRepairReports(oldJournal)
    oldJournal.exec('PRAGMA user_version = 58')
    oldJournal.close()

    const migrated = openJournalStore(path, true, CODEX_AGENT_PROFILE)
    try {
      expect(migrated.listIncidents()).toMatchObject([{
        operation: 'configuration',
        message: 'The repository mapping is invalid.',
      }])
    }
    finally {
      migrated.close()
    }
  })
})

describe('gitHub vocabulary migration', () => {
  it('carries a version 22 journal across without losing a row', () => {
    const path = join(directory, 'state.sqlite')
    journalAtVersion22(path)

    const store = openJournalStore(path, true, CODEX_AGENT_PROFILE)
    try {
      const snapshot = store.getDashboardSnapshot('2026-08-18T01:00:00.000Z')
      expect(snapshot.items).toHaveLength(1)
      expect(snapshot.tasks.some(task => task.state._tag === 'ActionRequired')).toBe(true)
    }
    finally {
      store.close()
    }

    const database = new DatabaseSync(path)
    try {
      expect((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(62)
      // The old words must be gone from the rows and from the constraints.
      expect(database.prepare(`SELECT count(*) AS total FROM worker_tasks WHERE state_tag = 'NeedsAttention'`).get())
        .toEqual({ total: 0 })
      expect(database.prepare(`SELECT count(*) AS total FROM sqlite_master WHERE sql LIKE '%NeedsAttention%'`).get())
        .toEqual({ total: 0 })
      expect(database.prepare(`SELECT count(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'review_runs'`).get())
        .toEqual({ total: 1 })
    }
    finally {
      database.close()
    }
  })

  it('keeps every constraint the rebuilt table had', () => {
    const path = join(directory, 'state.sqlite')
    journalAtVersion22(path)
    const store = openJournalStore(path, true, CODEX_AGENT_PROFILE)
    store.close()

    const database = new DatabaseSync(path)
    try {
      const definition = (database.prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'worker_tasks'`,
      ).get() as { sql: string }).sql
      expect(definition).toContain(`'ActionRequired'`)
      expect(definition).toContain('max_attempts')
      expect(definition).toContain('recovery_attempts')
      expect(definition).toContain('lease_expires_at')
    }
    finally {
      database.close()
    }
  })
})

/** Rewinds the Agent selection to version 26, which could only store a pin. */
function pinnedSelectionAtVersion26(path: string): void {
  const store = openJournalStore(path, false, CODEX_AGENT_PROFILE)
  store.close()

  const database = new DatabaseSync(path)
  database.exec('ALTER TABLE review_runs DROP COLUMN usage')
  dropSelectionMode(database)
  database.exec('DROP TABLE agent_selection')
  database.exec(`
    CREATE TABLE agent_selection (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      provider TEXT NOT NULL CHECK (provider IN ('codex', 'opencode')),
      model TEXT,
      reasoning_effort TEXT,
      updated_at TEXT NOT NULL
    );
    INSERT INTO agent_selection VALUES (1, 'opencode', 'opencode-go/deepseek-v4-pro', 'low', '2026-08-18T00:00:00.000Z');
    PRAGMA user_version = 26;
  `)
  database.close()
}

describe('agent selection migration', () => {
  it('keeps a version 26 pin, and lets it go back to the configuration', () => {
    const path = join(directory, 'state.sqlite')
    pinnedSelectionAtVersion26(path)

    const store = openJournalStore(path, false, CODEX_AGENT_PROFILE)
    try {
      expect(store.getAgentSelection())
        .toEqual({ _tag: 'Pinned', provider: 'opencode', model: 'opencode-go/deepseek-v4-pro', reasoningEffort: 'low' })

      store.selectAgent({ _tag: 'FollowsConfiguration' }, '2026-08-18T01:00:00.000Z')

      expect(store.getAgentSelection()).toEqual({ _tag: 'FollowsConfiguration' })
      expect(store.getDashboardSnapshot('2026-08-18T01:00:01.000Z').agentProfile.provider).toBe('codex')
    }
    finally {
      store.close()
    }
  })
})
