import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { collectAgentRetroEvidence } from '../src/agent-retro.ts'
import { openJournalStore } from '../src/store.ts'

let directory = ''
afterEach(() => rmSync(directory, { recursive: true, force: true }))

/** A real journal holding one retried failure behind a thousand newer successes. */
function journalWithBuriedFailure(now: Date) {
  directory = mkdtempSync(join(tmpdir(), 'harlan-agent-retro-'))
  const path = join(directory, 'state.sqlite')
  openJournalStore(path).close()
  const database = new DatabaseSync(path)
  const insert = database.prepare(`
    INSERT INTO workflow_events (stream, event, entity_id, to_state, reason, attempt, fence, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `)
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString()
  insert.run('task', 'failed', 'task-buried', 'Failed', 'provider returned 500', 3, hoursAgo(72))
  for (let index = 0; index < 1000; index++)
    insert.run('task', 'completed', `task-${index}`, 'Completed', null, 1, hoursAgo(1 + index / 1000))
  insert.run('task', 'failed', 'task-old', 'Failed', 'outside the window', 2, hoursAgo(24 * 9))
  database.close()
  return openJournalStore(path)
}

it('keeps a week-old failure that a thousand newer events would push out', () => {
  const now = new Date('2026-11-17T00:00:00.000Z')
  const store = journalWithBuriedFailure(now)
  const evidence = collectAgentRetroEvidence(store, now)
  store.close()
  expect(evidence.events.map(event => event.entityId)).toContain('task-buried')
  expect(evidence.events.map(event => event.entityId)).not.toContain('task-old')
})

it('counts every event in the window, not only the sample', () => {
  const now = new Date('2026-11-17T00:00:00.000Z')
  const store = journalWithBuriedFailure(now)
  const evidence = collectAgentRetroEvidence(store, now)
  store.close()
  expect(evidence.summary).toEqual(expect.arrayContaining([
    { stream: 'task', event: 'completed', to: 'Completed', count: 1000, failed: 0, retried: 0 },
    { stream: 'task', event: 'failed', to: 'Failed', count: 1, failed: 1, retried: 1 },
  ]))
  expect(evidence.coverage.events).toBe('complete')
})
