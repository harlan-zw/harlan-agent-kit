import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openJournalStore } from '../src/store.ts'

let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'harlan-agent-publication-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function openRaw(): { database: DatabaseSync, close: () => void } {
  const path = join(directory, 'state.sqlite')
  const store = openJournalStore(path)
  store.close()
  const database = new DatabaseSync(path)
  database.exec('PRAGMA foreign_keys = ON')
  return { database, close: () => database.close() }
}

const columns = `
  id, task_id, routine_run_id, state_tag, commit_sha, base_sha, base_ref,
  expected_head_sha, head_ref, artifact_ref, patch_digest, changed_files, updated_at
`

function values(taskId: string | null, routineRunId: string | null): unknown[] {
  return [
    'command-1',
    taskId,
    routineRunId,
    'Pending',
    'a'.repeat(40),
    'b'.repeat(40),
    'main',
    'b'.repeat(40),
    'agent/routine',
    'refs/agent/artifact',
    'digest',
    1,
    '2026-08-27T07:00:00.000Z',
  ]
}

describe('who owns one Publication command', () => {
  it('refuses a command owned by nobody', () => {
    const { database, close } = openRaw()
    try {
      expect(() => database
        .prepare(`INSERT INTO publication_commands (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...values(null, null) as never[]))
        .toThrow()
    }
    finally {
      close()
    }
  })

  it('refuses a command owned by both a Task and a Routine run', () => {
    const { database, close } = openRaw()
    try {
      expect(() => database
        .prepare(`INSERT INTO publication_commands (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...values('task-1', 'run-1') as never[]))
        .toThrow()
    }
    finally {
      close()
    }
  })

  it('refuses a Routine run owner that does not exist', () => {
    const { database, close } = openRaw()
    try {
      expect(() => database
        .prepare(`INSERT INTO publication_commands (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...values(null, 'run-that-never-existed') as never[]))
        .toThrow()
    }
    finally {
      close()
    }
  })

  it('accepts a command a real Routine run owns', () => {
    const path = join(directory, 'state.sqlite')
    const store = openJournalStore(path)
    store.syncRoutines({
      repository: 'harlan-zw/example',
      specSha: 'abc123',
      entries: [{ name: 'pr-triage', crons: ['0 7 * * *'], timeZone: 'UTC', mode: 'propose', enabled: true }],
      at: '2026-08-27T00:00:00.000Z',
    })
    const run = store.openRoutineRun({
      routineId: 'harlan-zw/example:pr-triage',
      scheduledFor: '2026-08-27T07:00:00.000Z',
      specSha: 'abc123',
      at: '2026-08-27T07:00:05.000Z',
    })
    store.close()

    const database = new DatabaseSync(path)
    database.exec('PRAGMA foreign_keys = ON')
    try {
      database
        .prepare(`INSERT INTO publication_commands (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(...values(null, run?.id ?? '') as never[])

      const stored = database
        .prepare('SELECT routine_run_id, task_id FROM publication_commands WHERE id = ?')
        .get('command-1') as { routine_run_id: string, task_id: string | null }

      expect(stored.routine_run_id).toBe(run?.id)
      expect(stored.task_id).toBeNull()
    }
    finally {
      database.close()
    }
  })

  it('keeps one live command per Routine run', () => {
    const path = join(directory, 'state.sqlite')
    const store = openJournalStore(path)
    store.syncRoutines({
      repository: 'harlan-zw/example',
      specSha: 'abc123',
      entries: [{ name: 'pr-triage', crons: ['0 7 * * *'], timeZone: 'UTC', mode: 'propose', enabled: true }],
      at: '2026-08-27T00:00:00.000Z',
    })
    const run = store.openRoutineRun({
      routineId: 'harlan-zw/example:pr-triage',
      scheduledFor: '2026-08-27T07:00:00.000Z',
      specSha: 'abc123',
      at: '2026-08-27T07:00:05.000Z',
    })
    store.close()

    const database = new DatabaseSync(path)
    database.exec('PRAGMA foreign_keys = ON')
    try {
      const insert = database.prepare(`INSERT INTO publication_commands (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      insert.run(...values(null, run?.id ?? '') as never[])

      expect(() => insert.run(...[
        'command-2',
        ...values(null, run?.id ?? '').slice(1),
      ] as never[])).toThrow()
    }
    finally {
      database.close()
    }
  })
})
