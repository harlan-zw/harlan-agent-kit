import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openJournalStore } from '../src/index.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
const directories: string[] = []
afterEach(() => {
  stores.splice(0).forEach(store => store.close())
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
})

describe.each(['mutation', 'review'] as const)('recovering historical %s attempts', (kind) => {
  it.each([
    ['Failed', '2026-08-13T01:00:02.000Z'],
    ['Failed', '2026-08-13T01:00:01.000Z'],
    ['Queued', '2026-08-13T01:00:02.000Z'],
    ['Queued', '2026-08-13T01:00:00.000Z'],
    ['Completed', '2026-08-13T01:00:02.000Z'],
  ] as const)('preserves the selected %s attempt updated at %s', (state, updatedAt) => {
    const directory = mkdtempSync(join(tmpdir(), 'recovery-owner-'))
    directories.push(directory)
    const path = join(directory, 'state.sqlite')
    const store = openJournalStore(path)
    stores.push(store)
    store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
    store.recordObservation({
      externalId: 'recovery-owner',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({ mergeState: kind === 'mutation' ? 'conflicting' : 'clean' }),
    })
    // Older journals can retain several failed attempts for one revision.
    const fixture = new DatabaseSync(path)
    const table = kind === 'mutation' ? 'tasks' : 'worker_tasks'
    fixture.prepare(`UPDATE ${table} SET state_tag = 'Failed', reason = ?, updated_at = ?`)
      .run('The permissions requested are not granted to this installation.', '2026-08-13T01:00:01.000Z')
    fixture.prepare(`
      INSERT INTO ${table} (id, subject_id, revision_id, kind, state_tag, reason, evidence, updated_at)
      SELECT 'newest-attempt', subject_id, revision_id, kind, ?, ?, ?, ? FROM ${table} LIMIT 1
    `).run(state, state === 'Failed' ? 'The permissions requested are not granted to this installation.' : null, state === 'Completed' ? 'Published the repair.' : null, updatedAt)
    fixture.close()

    expect(store.retryRecoverableWorkerFailures('2026-08-13T02:00:00.000Z')).toBe(state === 'Failed' ? 1 : 0)
    const task = kind === 'mutation'
      ? store.claimNextConflictTask('worker', '2026-08-13T02:00:01.000Z', 60_000)
      : store.claimNextAdversarialReviewTask('worker', '2026-08-13T02:00:01.000Z', 60_000)
    expect(task?.id ?? null).toBe(state === 'Completed' ? null : 'newest-attempt')
    expect(store.retryRecoverableWorkerFailures('2026-08-13T03:00:00.000Z')).toBe(0)
  })
})
