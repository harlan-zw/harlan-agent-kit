import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'harlan-agent-store-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

/** Every rewind here predates the newest schema, so its additions have to go too. */
function dropSelectionMode(database: DatabaseSync): void {
  database.exec('ALTER TABLE agent_control DROP COLUMN selection_mode')
  database.exec('DROP TABLE item_dismissals')
  database.exec('ALTER TABLE repositories DROP COLUMN writes_enabled')
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

describe('installation permission recovery migration', () => {
  it('gives Tasks blocked by the old Workflow permission request one bounded recovery', () => {
    const path = join(directory, 'state.sqlite')
    const store = openJournalStore(path, true, CODEX_AGENT_PROFILE)
    store.syncRepositories([repositoryMapping()], '2026-08-18T00:00:00.000Z')
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
      expect((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(33)
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
