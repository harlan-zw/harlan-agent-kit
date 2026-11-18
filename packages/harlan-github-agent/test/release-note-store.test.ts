import type { ReleaseNoteSubject } from '../src/package-release-store.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { createPackageReleaseStore } from '../src/package-release-store.ts'

const subject: ReleaseNoteSubject = {
  repository: 'harlan-zw/example',
  pullRequestNumber: 24,
  packageName: 'example',
  version: '1.0.1',
  tag: 'v1.0.1',
  previousTag: 'v1.0.0',
  sha: 'd'.repeat(40),
  pullRequests: [{ number: 23, title: 'fix: handle input', body: 'Handles empty input.' }],
}
const lease = 60_000

function setup() {
  const database = new DatabaseSync(':memory:')
  return { database, store: createPackageReleaseStore(database) }
}

it('queues one draft per released version', () => {
  const { database, store } = setup()
  expect(store.queueReleaseNote(subject)).toBe(true)
  expect(store.queueReleaseNote({ ...subject, sha: 'e'.repeat(40) })).toBe(false)
  expect(store.getReleaseNote(subject.repository, subject.version)).toMatchObject({ sha: subject.sha, state: { _tag: 'Queued' }, attempts: 0 })
  database.close()
})

it('stores the draft only for the current lease holder', () => {
  const { database, store } = setup()
  store.queueReleaseNote(subject)
  const claimed = store.claimNextReleaseNote('worker', '2026-11-18T00:00:00.000Z', lease)
  expect(claimed).toMatchObject({ ...subject, attempts: 1, state: { _tag: 'Running', workerId: 'worker' } })
  expect(store.claimNextReleaseNote('other', '2026-11-18T00:00:01.000Z', lease)).toBeNull()
  const owner = { taskId: claimed!.id, workerId: 'worker', fence: claimed!.state.fence, at: '2026-11-18T00:00:02.000Z' }
  expect(store.completeReleaseNote({ ...owner, fence: owner.fence + 1, notes: 'Stale.' })).toBe(false)
  expect(store.completeReleaseNote({ ...owner, notes: 'Empty input no longer throws.' })).toBe(true)
  expect(store.getReleaseNote(subject.repository, subject.version)?.state).toEqual({ _tag: 'Drafted', text: 'Empty input no longer throws.' })
  database.close()
})

it('retries a failed or abandoned draft, then stops after three attempts', () => {
  const { database, store } = setup()
  store.queueReleaseNote(subject)
  const first = store.claimNextReleaseNote('worker', '2026-11-18T00:00:00.000Z', lease)!
  expect(store.failReleaseNote({ taskId: first.id, workerId: 'worker', fence: first.state.fence, at: '2026-11-18T00:00:01.000Z', reason: 'Provider error.' })).toBe('Retrying')
  const second = store.claimNextReleaseNote('worker', '2026-11-18T00:00:02.000Z', lease)!
  expect(store.heartbeatReleaseNote({ taskId: second.id, workerId: 'worker', fence: second.state.fence, at: '2026-11-18T00:00:30.000Z', leaseMilliseconds: lease })).toBe(true)
  // The lease runs out, as after a Service restart. Another worker reclaims it.
  const third = store.claimNextReleaseNote('other', '2026-11-18T00:02:00.000Z', lease)!
  expect(third.attempts).toBe(3)
  expect(store.heartbeatReleaseNote({ taskId: second.id, workerId: 'worker', fence: second.state.fence, at: '2026-11-18T00:02:01.000Z', leaseMilliseconds: lease })).toBe(false)
  expect(store.failReleaseNote({ taskId: third.id, workerId: 'other', fence: third.state.fence, at: '2026-11-18T00:02:02.000Z', reason: 'Invalid JSON.' })).toBe('Failed')
  expect(store.getReleaseNote(subject.repository, subject.version)?.state).toEqual({ _tag: 'Failed', reason: 'Invalid JSON.' })
  expect(store.claimNextReleaseNote('worker', '2026-11-18T01:00:00.000Z', lease)).toBeNull()
  database.close()
})
