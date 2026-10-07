import type { ReviewProofAuthority, ReviewProofOutcome, ReviewProofReceipt } from './review-proof-authority.ts'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { redactSecrets } from './agent-activity.ts'

export type { ReviewProofOutcome, ReviewProofReceipt } from './review-proof-authority.ts'
export type ReviewProofResult
  = | { _tag: 'Finished', receipt: ReviewProofReceipt }
    | { _tag: 'Refused', reason: string, receipt?: ReviewProofReceipt }
export interface ReviewProofLaunch {
  sourcePath: string
  workspace: string
  nodeArguments: string[]
  timeoutMilliseconds: number
}
export interface ReviewProofOptions {
  /** Controller-owned directory. Never mount it into a worker. */
  ledger: string
  workspace: string
  taskId: string
  headSha: string
  now: () => Date
  authority: ReviewProofAuthority
  /** Runs the fixed Node invocation inside the credential boundary. */
  launch: (input: ReviewProofLaunch) => Promise<ReviewProofOutcome>
}

const maximumSourceBytes = 20_000
const maximumOutputCharacters = 12_000
export const REVIEW_PROOF_TIMEOUT_MILLISECONDS = 30_000

function safeOutcome(outcome: ReviewProofOutcome): ReviewProofOutcome {
  return outcome._tag === 'LaunchFailed'
    ? { ...outcome, reason: redactSecrets(outcome.reason).slice(0, 500) }
    : { ...outcome, output: redactSecrets(outcome.output).slice(-maximumOutputCharacters) }
}

export function createReviewProof(options: ReviewProofOptions): { run: (input: unknown) => Promise<ReviewProofResult>, receipt: () => Promise<ReviewProofReceipt | null> } {
  const reservation = join(resolve(options.ledger), createHash('sha256').update(options.taskId).digest('hex'))
  let savedReceipt: ReviewProofReceipt | null = null
  return {
    async run(input) {
      if (typeof input !== 'object' || input === null || Array.isArray(input))
        return { _tag: 'Refused', reason: 'The proof request must contain a plan ID and TypeScript source.' }
      const record = input as Record<string, unknown>
      if (record.planId !== 'node-typescript' || typeof record.source !== 'string' || record.source.trim() === ''
        || Buffer.byteLength(record.source) > maximumSourceBytes || Object.keys(record).some(key => key !== 'planId' && key !== 'source')) {
        return { _tag: 'Refused', reason: 'Use the controller Node TypeScript plan with at most 20,000 source bytes.' }
      }
      const source = record.source
      const startedAt = options.now().toISOString()
      const sourceSha256 = createHash('sha256').update(source).digest('hex')
      const reserved = await options.authority.reserve({ taskId: options.taskId, headSha: options.headSha, sourceSha256, startedAt })
      if (reserved._tag === 'Refused')
        return reserved
      // The central reservation precedes every effect. A crash spends the attempt across both hosts.
      const sourcePath = join(reservation, 'proof.ts')
      const outcome = await (async () => {
        await mkdir(resolve(options.ledger), { recursive: true, mode: 0o700 })
        await mkdir(reservation, { mode: 0o700 })
        await writeFile(sourcePath, source, { flag: 'wx', mode: 0o400 })
        return options.launch({
          sourcePath,
          workspace: options.workspace,
          nodeArguments: ['--disable-sigusr1', '--experimental-strip-types', '--permission', `--allow-fs-read=${options.workspace}`, '--allow-fs-read=/run/proof/proof.ts', '/run/proof/proof.ts'],
          timeoutMilliseconds: REVIEW_PROOF_TIMEOUT_MILLISECONDS,
        })
      })().catch((error: unknown): ReviewProofOutcome => ({ _tag: 'LaunchFailed', reason: error instanceof Error ? error.message : String(error) }))
      const receipt: ReviewProofReceipt = {
        taskId: options.taskId,
        headSha: options.headSha,
        sourceSha256,
        startedAt,
        outcome: safeOutcome(outcome),
      }
      await options.authority.finish({ reservationId: reserved.reservationId, receipt })
      savedReceipt = receipt
      return { _tag: 'Finished', receipt }
    },
    async receipt() {
      return savedReceipt
    },
  }
}
