import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { collectAgentRetroEvidence } from '../src/agent-retro.ts'
import { openJournalStore } from '../src/store.ts'

let directory = ''
afterEach(() => rmSync(directory, { recursive: true, force: true }))

const now = new Date('2026-11-17T00:00:00.000Z')
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString()
const providerPrefix = 'provider returned 500 Internal Server Error while streaming the review turn for '
const leaseExpired = 'worker lease expired before the task finished; another worker claims it after the fence moves on'
const rateLimited = 'GitHub API rate limit reached for the installation token; the next window opens at the reset time'
const buriedReason = 'review checkout failed because the head commit vanished after a force push to the branch'

type Row = [stream: string, event: string, entity: string, to: string, reason: string | null, attempt: number, occurredAt: string]

/** Opens a real journal file, then inserts rows the way the live journal holds them. */
function journalWith(rows: Row[]) {
  directory = mkdtempSync(join(tmpdir(), 'harlan-agent-retro-'))
  const path = join(directory, 'state.sqlite')
  openJournalStore(path).close()
  const database = new DatabaseSync(path)
  const insert = database.prepare(`
    INSERT INTO workflow_events (stream, event, entity_id, repository, item_number, to_state, reason, attempt, fence, occurred_at)
    VALUES (?, ?, ?, 'harlan-zw/example', 7, ?, ?, ?, 0, ?)
  `)
  database.exec('BEGIN')
  for (const row of rows)
    insert.run(...row)
  database.exec('COMMIT')
  database.close()
  return openJournalStore(path)
}

function successes(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ['task', 'completed', `task-${index}`, 'Completed', null, 1, hoursAgo(1 + index / 1000)])
}

/** Reads group rows back into objects through the evidence's own legend. */
function decodeGroups({ failureGroups }: ReturnType<typeof collectAgentRetroEvidence>) {
  return failureGroups.rows.map(row => Object.fromEntries(failureGroups.columns.map((column, index) => [
    column,
    column === 'examples'
      ? (row[index] as ReadonlyArray<readonly unknown[]>).map(example => Object.fromEntries(failureGroups.exampleColumns.map((name, position) => [name, example[position]])))
      : row[index],
  ])))
}

const outsideWindow: Row = ['task', 'failed', 'task-old', 'Failed', 'outside the window', 2, hoursAgo(24 * 9)]

it('keeps a week-old failure that a thousand newer events would push out', () => {
  const store = journalWith([
    ['task', 'failed', 'task-buried', 'Failed', 'provider returned 500', 3, hoursAgo(72)],
    ...successes(1000),
    outsideWindow,
  ])
  const evidence = collectAgentRetroEvidence(store, now)
  store.close()
  expect(decodeGroups(evidence)).toMatchObject([{ reason: 'provider returned 500', count: 1, examples: [{ entityId: 'task-buried' }] }])
  expect(JSON.stringify(evidence)).not.toContain('task-old')
})

it('counts every event in the window, not only the sample', () => {
  const store = journalWith([
    ['task', 'failed', 'task-buried', 'Failed', 'provider returned 500', 3, hoursAgo(72)],
    ...successes(1000),
    outsideWindow,
  ])
  const evidence = collectAgentRetroEvidence(store, now)
  store.close()
  expect(evidence.summary).toEqual(expect.arrayContaining([
    { stream: 'task', event: 'completed', to: 'Completed', count: 1000, failed: 0, retried: 0 },
    { stream: 'task', event: 'failed', to: 'Failed', count: 1, failed: 1, retried: 1 },
  ]))
  expect(evidence.coverage.events).toBe('complete')
})

it('groups fifteen hundred failures by cause within a bounded prompt', () => {
  const store = journalWith([
    ...Array.from({ length: 700 }, (_, index): Row => ['task', 'failed', `provider-${index}`, 'Failed', `${providerPrefix}${index % 2 === 0 ? 'pull request one' : 'pull request two'}`, index % 4 === 0 ? 2 : 1, hoursAgo(2 + index / 100)]),
    ...Array.from({ length: 500 }, (_, index): Row => ['worker_task', 'failed', `lease-${index}`, 'Failed', leaseExpired, 1, hoursAgo(3 + index / 100)]),
    ...Array.from({ length: 298 }, (_, index): Row => ['review_status', 'failed', `rate-${index}`, 'Retrying', rateLimited, index % 2 === 0 ? 3 : 1, hoursAgo(4 + index / 100)]),
    ['task', 'retried', 'task-retry', 'Queued', null, 2, hoursAgo(1.5)],
    ['task', 'failed', 'task-buried', 'Failed', buriedReason, 1, hoursAgo(72)],
    ...successes(1000),
    outsideWindow,
  ])
  const evidence = collectAgentRetroEvidence(store, now)
  store.close()
  const groups = decodeGroups(evidence)
  expect(groups).toMatchObject([
    { stream: 'task', event: 'failed', to: 'Failed', reason: providerPrefix, count: 700, retried: 175 },
    { stream: 'worker_task', event: 'failed', to: 'Failed', reason: leaseExpired.slice(0, 80), count: 500, retried: 0 },
    { stream: 'review_status', event: 'failed', to: 'Retrying', reason: rateLimited.slice(0, 80), count: 298, retried: 149 },
    { stream: 'task', event: 'retried', to: 'Queued', reason: null, count: 1, retried: 1, examples: [{ entityId: 'task-retry' }] },
    { stream: 'task', event: 'failed', to: 'Failed', reason: buriedReason.slice(0, 80), count: 1, retried: 0, examples: [{ entityId: 'task-buried' }] },
  ])
  expect(groups[0]?.examples).toEqual([
    { id: expect.any(Number), entityId: 'provider-0', repository: 'harlan-zw/example', itemNumber: 7, occurredAt: hoursAgo(2) },
    { id: expect.any(Number), entityId: 'provider-1', repository: 'harlan-zw/example', itemNumber: 7, occurredAt: hoursAgo(2 + 1 / 100) },
    { id: expect.any(Number), entityId: 'provider-2', repository: 'harlan-zw/example', itemNumber: 7, occurredAt: hoursAgo(2 + 2 / 100) },
  ])
  expect(evidence.coverage).toMatchObject({ events: 'complete', windowEvents: 2500, failureEvents: 1500, failureGroups: 5, omittedFailureGroups: 0 })
  expect(evidence.failureSample).toHaveLength(40)
  expect(evidence.failureSample.map(event => event.entityId)).not.toContain('task-buried')
  expect(JSON.stringify(evidence)).not.toContain('task-old')
  expect(JSON.stringify(evidence).length).toBeLessThan(60_000)
})

it('fits every cause of a week with a hundred and fifty failure groups', () => {
  const store = journalWith([
    ...Array.from({ length: 150 }, (_, cause) => Array.from({ length: cause < 20 ? 5 : 1 }, (_, index): Row => [
      'task',
      'failed',
      `00000000-0000-4000-8000-${String(cause * 10 + index).padStart(12, '0')}`,
      'Failed',
      `cause ${cause}: GitHub API returned 422 because the head commit left the pull request branch before the check`,
      index === 0 ? 2 : 1,
      hoursAgo(2 + cause + index / 100),
    ])).flat(),
    ...successes(1000),
  ])
  const evidence = collectAgentRetroEvidence(store, now)
  store.close()
  expect(evidence.coverage).toMatchObject({ events: 'complete', failureEvents: 230, failureGroups: 150, omittedFailureGroups: 0 })
  const groups = decodeGroups(evidence)
  expect(groups.map(group => String(group.reason).split(':')[0]).sort()).toEqual(Array.from({ length: 150 }, (_, cause) => `cause ${cause}`).sort())
  expect(groups.map(group => (group.examples as unknown[]).length)).toEqual([...Array.from({ length: 20 }).fill(3), ...Array.from({ length: 130 }).fill(1)])
  expect(JSON.stringify(evidence).length).toBeLessThan(60_000)
})
