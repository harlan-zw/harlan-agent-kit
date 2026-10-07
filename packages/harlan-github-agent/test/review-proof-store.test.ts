import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createReviewProofAuthority } from '../src/review-proof-controller.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
const roots: string[] = []
const at = '2026-10-07T00:00:00.000Z'
afterEach(() => {
  stores.splice(0).forEach(store => store.close())
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }))
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'review-proof-store-'))
  roots.push(root)
  const path = join(root, 'journal.sqlite')
  const store = openJournalStore(path)
  stores.push(store)
  store.syncRepositories([repositoryMapping()], at)
  const item = pullRequestItem({ mergeState: 'clean', headSha: 'd'.repeat(40) })
  store.recordObservation({ externalId: 'proof', observedAt: at, source: 'poll', subject: item })
  const task = store.claimNextAdversarialReviewTask('reviewer', at, 60_000)!
  const ownership = { taskId: task.id, headSha: item.headSha, workerId: task.state.workerId, fence: task.state.fence }
  const request = { ...ownership, sourceSha256: 'a'.repeat(64), startedAt: at, at }
  return { path, store, item, ownership, request }
}

it('spends the reservation across controller restart and records actual failure output', () => {
  const { path, store, request } = fixture()
  const reserved = store.reserveReviewProof(request)
  expect(reserved._tag).toBe('Reserved')
  expect(store.reserveReviewProof(request)._tag).toBe('Refused')
  const restarted = openJournalStore(path)
  stores.push(restarted)
  expect(restarted.reserveReviewProof(request)._tag).toBe('Refused')
  if (reserved._tag !== 'Reserved')
    throw new Error('Expected reservation.')
  const receipt = { taskId: request.taskId, headSha: request.headSha, sourceSha256: request.sourceSha256, startedAt: at, outcome: { _tag: 'Exited' as const, exitCode: 1, output: 'actual failure' } }
  expect(restarted.finishReviewProof({ ...request, reservationId: reserved.reservationId, receipt })).toBe(true)
  expect(restarted.getReviewProofReceipt(request.taskId)).toEqual(receipt)
  expect(restarted.finishReviewProof({ ...request, reservationId: reserved.reservationId, receipt })).toBe(false)
})

it('rejects wrong head, wrong fence, expired lease and changed current head', () => {
  const { store, request, item } = fixture()
  expect(store.reserveReviewProof({ ...request, headSha: 'b'.repeat(40) })._tag).toBe('Refused')
  expect(store.reserveReviewProof({ ...request, fence: request.fence + 1 })._tag).toBe('Refused')
  expect(store.reserveReviewProof({ ...request, at: '2026-10-07T00:01:00.000Z' })._tag).toBe('Refused')
  store.recordObservation({ externalId: 'new-head', observedAt: '2026-10-07T00:00:01.000Z', source: 'poll', subject: { ...item, headSha: 'c'.repeat(40) } })
  expect(store.reserveReviewProof(request)._tag).toBe('Refused')
})

it('keeps disconnected or expired reservations spent and rejects fabricated receipt identity', () => {
  const { store, request } = fixture()
  const reserved = store.reserveReviewProof(request)
  if (reserved._tag !== 'Reserved')
    throw new Error('Expected reservation.')
  const receipt = { taskId: request.taskId, headSha: request.headSha, sourceSha256: request.sourceSha256, startedAt: at, outcome: { _tag: 'TimedOut' as const, output: 'bounded timeout' } }
  expect(store.finishReviewProof({ ...request, reservationId: reserved.reservationId, receipt: { ...receipt, sourceSha256: 'b'.repeat(64) } })).toBe(false)
  expect(store.finishReviewProof({ ...request, at: '2026-10-07T00:01:00.000Z', reservationId: reserved.reservationId, receipt })).toBe(false)
  expect(store.reserveReviewProof(request)._tag).toBe('Refused')
  expect(store.getReviewProofReceipt(request.taskId)).toBeNull()
})

it('binds trusted callbacks to their captured owner and rejects pass claims or oversized output', async () => {
  const { store, request, ownership } = fixture()
  const authority = createReviewProofAuthority(store, () => new Date(at))(ownership)
  const reservation = { taskId: request.taskId, headSha: request.headSha, sourceSha256: request.sourceSha256, startedAt: at }
  expect((await authority.reserve({ ...reservation, taskId: 'another-task' }))._tag).toBe('Refused')
  const result = await authority.reserve(reservation)
  if (result._tag !== 'Reserved')
    throw new Error('Expected reservation.')
  const receipt = { ...reservation, outcome: { _tag: 'Exited' as const, exitCode: 1, output: 'real process failure' } }
  await expect(authority.finish({ reservationId: result.reservationId, receipt: { ...receipt, outcome: { ...receipt.outcome, output: 'x'.repeat(12_001) } } })).rejects.toThrow('output is invalid')
  await expect(authority.finish({ reservationId: result.reservationId, receipt: { ...receipt, pass: true } as typeof receipt })).rejects.toThrow('receipt is invalid')
  await authority.finish({ reservationId: result.reservationId, receipt })
  expect(await authority.reserve(reservation)).toEqual({ _tag: 'Refused', reason: 'This Review already spent its one proof invocation.', receipt })
})

it('rejects the old worker fence after takeover and keeps its disconnected attempt spent', () => {
  const { store, request } = fixture()
  const reserved = store.reserveReviewProof(request)
  if (reserved._tag !== 'Reserved')
    throw new Error('Expected reservation.')
  const takeoverAt = '2026-10-07T00:01:01.000Z'
  const next = store.claimNextAdversarialReviewTask('replacement', takeoverAt, 60_000)!
  expect(next.id).toBe(request.taskId)
  expect(next.state.fence).toBeGreaterThan(request.fence)
  const receipt = { taskId: request.taskId, headSha: request.headSha, sourceSha256: request.sourceSha256, startedAt: at, outcome: { _tag: 'Exited' as const, exitCode: 0, output: 'late result' } }
  expect(store.finishReviewProof({ ...request, at: takeoverAt, reservationId: reserved.reservationId, receipt })).toBe(false)
  expect(store.reserveReviewProof({ ...request, workerId: next.state.workerId, fence: next.state.fence, at: takeoverAt })._tag).toBe('Refused')
  expect(store.getReviewProofReceipt(request.taskId)).toBeNull()
})
