/** Fixed controller ownership. The Agent cannot select another Task or lease. */
export interface ReviewProofOwnership {
  taskId: string
  headSha: string
  workerId: string
  fence: number
}

export type ReviewProofOutcome
  = | { _tag: 'Exited', exitCode: number, output: string }
    | { _tag: 'Signaled', signal: NodeJS.Signals, output: string }
    | { _tag: 'TimedOut', output: string }
    | { _tag: 'LaunchFailed', reason: string }

export interface ReviewProofReceipt {
  taskId: string
  headSha: string
  sourceSha256: string
  startedAt: string
  outcome: ReviewProofOutcome
}

export interface ReviewProofReservation {
  taskId: string
  headSha: string
  sourceSha256: string
  startedAt: string
}

export type ReviewProofReserveResult
  = | { _tag: 'Reserved', reservationId: string }
    | { _tag: 'Refused', reason: string }

/** Only the trusted provider runtime receives this dependency. */
export interface ReviewProofAuthority {
  reserve: (input: ReviewProofReservation) => Promise<ReviewProofReserveResult>
  finish: (input: { reservationId: string, receipt: ReviewProofReceipt }) => Promise<void>
}

export type ReviewProofAuthorityFactory = (ownership: ReviewProofOwnership) => ReviewProofAuthority
