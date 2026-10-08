import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

it('keeps closed-PR reconciliation responsive with unrelated publication history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'closure-lookup-'))
  const path = join(directory, 'state.sqlite')
  const store = openJournalStore(path, true)
  const at = '2026-08-13T01:00:00.000Z'
  const repository = repositoryMapping()
  store.syncRepositories([repository], at)
  const observed = store.recordObservation({ externalId: 'published-history', observedAt: at, source: 'poll', subject: pullRequestItem({ number: 1 }) })
  if (observed._tag !== 'Inserted')
    throw new Error('Expected a publication-history Revision.')
  for (let number = 2; number <= 201; number++) {
    store.recordObservation({ externalId: `closed-${number}`, observedAt: at, source: 'poll', subject: pullRequestItem({ number, state: 'closed' }) })
  }
  const database = new DatabaseSync(path)
  const insert = database.prepare(`
    INSERT INTO review_status_commands (
      id, task_kind, task_id, task_fence, revision_id, expected_head_sha,
      phase, body, body_sha256, state_tag, github_comment_id, github_url, created_at, updated_at
    ) VALUES (?, 'existing_review', ?, 0, ?, ?, 'terminal', 'Review', ?, 'Published', ?, ?, ?, ?)
  `)
  database.exec('BEGIN')
  for (let number = 0; number < 20_000; number++) {
    insert.run(`history-${number}`, `history-${number}`, observed.revisionId, 'a'.repeat(40), 'b'.repeat(64), number, 'https://github.com/review', at, at)
  }
  database.exec('COMMIT')
  database.close()
  try {
    const started = performance.now()
    expect(store.listUnverifiedClosedPullRequestNumbers(repository.github)).toEqual([])
    expect(performance.now() - started).toBeLessThan(250)
  }
  finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 60_000)
