import type { DatabaseSync } from 'node:sqlite'
import type { ReviewProofOwnership, ReviewProofReceipt, ReviewProofReservation, ReviewProofReserveResult } from './review-proof-authority.ts'
import { randomUUID } from 'node:crypto'
import { redactSecrets } from './agent-activity.ts'

export type ReviewProofStore = ReturnType<typeof createReviewProofStore>
type ReservationInput = ReviewProofOwnership & ReviewProofReservation & { at: string }
type FinishInput = ReviewProofOwnership & { at: string, reservationId: string, receipt: ReviewProofReceipt }

const authority = `SELECT 1 FROM worker_tasks AS task
  JOIN subjects AS subject ON subject.id=task.subject_id
  JOIN revisions AS revision ON revision.id=task.revision_id
  JOIN repositories AS repository ON repository.id=subject.repository_id
  WHERE task.id=? AND task.kind='adversarial_review' AND task.state_tag='Running'
    AND task.worker_id=? AND task.fence=? AND task.lease_expires_at>?
    AND task.revision_id=subject.current_revision_id
    AND json_extract(revision.payload,'$.headSha')=?
    AND json_extract(revision.payload,'$.state')='open'
    AND repository.enabled=1 AND repository.paused=0
    AND NOT EXISTS(SELECT 1 FROM item_dismissals WHERE subject_id=subject.id)`

function validIdentity(input: ReservationInput): boolean {
  return input.taskId.length > 0 && input.workerId.length > 0 && Number.isSafeInteger(input.fence)
    && input.fence > 0 && /^[a-f0-9]{40}$/.test(input.headSha) && /^[a-f0-9]{64}$/.test(input.sourceSha256)
    && Number.isFinite(Date.parse(input.startedAt)) && Number.isFinite(Date.parse(input.at))
}

/** Controller Journal. A reservation remains spent without a receipt. */
export function createReviewProofStore(database: DatabaseSync) {
  database.exec(`CREATE TABLE IF NOT EXISTS review_proof_reservations (
    task_id TEXT PRIMARY KEY REFERENCES worker_tasks(id), reservation_id TEXT NOT NULL UNIQUE,
    head_sha TEXT NOT NULL, worker_id TEXT NOT NULL, fence INTEGER NOT NULL,
    source_sha256 TEXT NOT NULL, started_at TEXT NOT NULL, receipt TEXT
  )`)
  const getReviewProofReceipt = (taskId: string): ReviewProofReceipt | null => {
    const row = database.prepare('SELECT receipt FROM review_proof_reservations WHERE task_id=?').get(taskId) as { receipt: string | null } | undefined
    return row?.receipt ? JSON.parse(row.receipt) as ReviewProofReceipt : null
  }
  return {
    getReviewProofReceipt,
    reserveReviewProof(input: ReservationInput): ReviewProofReserveResult {
      if (!validIdentity(input) || database.prepare(authority).get(input.taskId, input.workerId, input.fence, input.at, input.headSha) === undefined)
        return { _tag: 'Refused', reason: 'The Review no longer owns this Task head and lease.' }
      const reservationId = randomUUID()
      const changed = database.prepare(`INSERT OR IGNORE INTO review_proof_reservations
        (task_id,reservation_id,head_sha,worker_id,fence,source_sha256,started_at)
        SELECT ?,?,?,?,?,?,? WHERE EXISTS(${authority})`).run(
        input.taskId,
        reservationId,
        input.headSha,
        input.workerId,
        input.fence,
        input.sourceSha256,
        input.startedAt,
        input.taskId,
        input.workerId,
        input.fence,
        input.at,
        input.headSha,
      ).changes === 1
      if (changed)
        return { _tag: 'Reserved', reservationId }
      const receipt = getReviewProofReceipt(input.taskId)
      return { _tag: 'Refused', reason: 'This Review already spent its one proof invocation.', ...(receipt === null ? {} : { receipt }) }
    },
    finishReviewProof(input: FinishInput): boolean {
      const receipt = input.receipt
      if (receipt.taskId !== input.taskId || receipt.headSha !== input.headSha)
        return false
      const outcome = receipt.outcome
      const safeReceipt: ReviewProofReceipt = {
        ...receipt,
        outcome: outcome._tag === 'LaunchFailed'
          ? { ...outcome, reason: redactSecrets(outcome.reason).slice(0, 500) }
          : { ...outcome, output: redactSecrets(outcome.output).slice(-12_000) },
      }
      return database.prepare(`UPDATE review_proof_reservations SET receipt=?
        WHERE task_id=? AND reservation_id=? AND head_sha=? AND worker_id=? AND fence=?
          AND source_sha256=? AND started_at=? AND receipt IS NULL AND EXISTS(${authority})`).run(
        JSON.stringify(safeReceipt),
        input.taskId,
        input.reservationId,
        input.headSha,
        input.workerId,
        input.fence,
        receipt.sourceSha256,
        receipt.startedAt,
        input.taskId,
        input.workerId,
        input.fence,
        input.at,
        input.headSha,
      ).changes === 1
    },
  }
}
