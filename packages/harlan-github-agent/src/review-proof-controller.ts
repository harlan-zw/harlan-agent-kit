import type { ReviewProofAuthorityFactory, ReviewProofReceipt, ReviewProofReservation, ReviewProofReserveResult } from './review-proof-authority.ts'
import type { ReviewProofStore } from './review-proof-store.ts'
import { constants } from 'node:os'

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}
function exact(input: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(input).length === keys.length && Object.keys(input).every(key => keys.includes(key))
}
export function parseReviewProofReservation(input: unknown): ReviewProofReservation {
  if (!record(input) || !exact(input, ['taskId', 'headSha', 'sourceSha256', 'startedAt'])
    || typeof input.taskId !== 'string' || input.taskId.length > 200
    || typeof input.headSha !== 'string' || !/^[a-f0-9]{40}$/.test(input.headSha)
    || typeof input.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sourceSha256)
    || typeof input.startedAt !== 'string' || input.startedAt.length > 40 || !Number.isFinite(Date.parse(input.startedAt))) {
    throw new Error('The Review proof reservation is invalid.')
  }
  return { taskId: input.taskId, headSha: input.headSha, sourceSha256: input.sourceSha256, startedAt: input.startedAt }
}
export function parseReviewProofReceipt(input: unknown): ReviewProofReceipt {
  if (!record(input) || !exact(input, ['taskId', 'headSha', 'sourceSha256', 'startedAt', 'outcome']) || !record(input.outcome))
    throw new Error('The Review proof receipt is invalid.')
  const identity = parseReviewProofReservation({ taskId: input.taskId, headSha: input.headSha, sourceSha256: input.sourceSha256, startedAt: input.startedAt })
  const outcome = input.outcome
  if (outcome._tag === 'LaunchFailed' && exact(outcome, ['_tag', 'reason']) && typeof outcome.reason === 'string' && outcome.reason.length <= 500)
    return { ...identity, outcome: { _tag: 'LaunchFailed', reason: outcome.reason } }
  if (typeof outcome.output !== 'string' || outcome.output.length > 12_000)
    throw new Error('The Review proof output is invalid.')
  if (outcome._tag === 'Exited' && exact(outcome, ['_tag', 'exitCode', 'output']) && Number.isSafeInteger(outcome.exitCode) && Number(outcome.exitCode) >= 0 && Number(outcome.exitCode) <= 255)
    return { ...identity, outcome: { _tag: 'Exited', exitCode: Number(outcome.exitCode), output: outcome.output } }
  if (outcome._tag === 'Signaled' && exact(outcome, ['_tag', 'signal', 'output']) && typeof outcome.signal === 'string' && Object.hasOwn(constants.signals, outcome.signal))
    return { ...identity, outcome: { _tag: 'Signaled', signal: outcome.signal as NodeJS.Signals, output: outcome.output } }
  if (outcome._tag === 'TimedOut' && exact(outcome, ['_tag', 'output']))
    return { ...identity, outcome: { _tag: 'TimedOut', output: outcome.output } }
  throw new Error('The Review proof process outcome is invalid.')
}
export function parseReviewProofReserveResult(input: unknown): ReviewProofReserveResult {
  if (!record(input))
    throw new Error('The Review proof reservation response is invalid.')
  if (input._tag === 'Reserved' && exact(input, ['_tag', 'reservationId']) && typeof input.reservationId === 'string'
    && input.reservationId.length > 0 && input.reservationId.length <= 100) {
    return { _tag: 'Reserved', reservationId: input.reservationId }
  }
  if (input._tag === 'Refused' && typeof input.reason === 'string' && input.reason.length <= 500
    && exact(input, input.receipt === undefined ? ['_tag', 'reason'] : ['_tag', 'reason', 'receipt'])) {
    return { _tag: 'Refused', reason: input.reason, ...(input.receipt === undefined ? {} : { receipt: parseReviewProofReceipt(input.receipt) }) }
  }
  throw new Error('The Review proof reservation response is invalid.')
}

/** Binds every invocation to the original worker fence, never the latest lease. */
export function createReviewProofAuthority(store: ReviewProofStore, now: () => Date): ReviewProofAuthorityFactory {
  return ownership => ({
    async reserve(value) {
      const input = parseReviewProofReservation(value)
      if (input.taskId !== ownership.taskId || input.headSha !== ownership.headSha)
        return { _tag: 'Refused', reason: 'The proof request names another Review Task or head.' }
      return store.reserveReviewProof({ ...input, ...ownership, at: now().toISOString() })
    },
    async finish(value) {
      const receipt = parseReviewProofReceipt(value.receipt)
      if (!store.finishReviewProof({ ...ownership, reservationId: value.reservationId, receipt, at: now().toISOString() }))
        throw new Error('The Review proof receipt no longer owns its reservation and lease.')
    },
  })
}
