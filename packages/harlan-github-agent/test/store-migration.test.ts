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
  database.exec('PRAGMA user_version = 22')
  database.close()
}

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
      expect((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(24)
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
