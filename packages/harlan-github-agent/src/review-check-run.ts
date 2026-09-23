import type { ReviewPublicationAuthority } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { RepositoryMapping, ReviewDesiredOutcome } from './types.ts'
import { classifyFailure } from './failure.ts'

/** The one check run this service reports its Review through. */
export const REVIEW_CHECK_RUN_NAME = 'harlan-agent-kit / Review'

export type ReviewCheckRunUpdate
  = | { _tag: 'Running', title: string }
    | { _tag: 'Completed', title: string, conclusion: 'success' | 'neutral', completedAt: string }

/** The phases one Review or Repair publication can carry. */
export type ReviewCheckRunPhase = 'snapshot' | 'review' | 'repair' | 'terminal'

export interface ReviewCheckRunPublisher {
  upsertReviewCheckRun: (repository: RepositoryMapping, headSha: string, update: ReviewCheckRunUpdate, signal: AbortSignal, authorize?: ReviewPublicationAuthority) => Promise<Result<void, string>>
}

/**
 * What one Review check run write did.
 *
 * `Refused` means the App installation does not hold Checks write. No retry
 * changes that, so it asks a person to grant the permission. `Failed` is any
 * other failure, and the next publication on the head writes the check run
 * again.
 */
export type ReviewCheckRunOutcome
  = | { _tag: 'Written' }
    | { _tag: 'Refused', permission: 'checks: write', message: string }
    | { _tag: 'Failed', message: string }

/** Hears every Review check run write, so a failure always reaches a person. */
export type ReviewCheckRunReport = (repository: string, outcome: ReviewCheckRunOutcome) => void

/** The Review check run publisher, and who hears what it did. */
export interface ReviewCheckRunMirror {
  publisher: ReviewCheckRunPublisher
  report: ReviewCheckRunReport
}

/**
 * Reads one check run write result as an outcome.
 *
 * GitHub refuses the token itself when the installation lacks the permission.
 * The token provider reports a narrower grant than it asked for the same way,
 * so both read as `Refused`.
 */
export function reviewCheckRunOutcome(result: Result<void, string>): ReviewCheckRunOutcome {
  if (result._tag === 'Ok')
    return { _tag: 'Written' }
  const message = result.error
  if (classifyFailure({ message }).kind === 'installation_access' || /\bgranted less access than this token asked for: .*\bchecks\b/i.test(message))
    return { _tag: 'Refused', permission: 'checks: write', message }
  return { _tag: 'Failed', message }
}

/**
 * Writes the Review check run and reports what happened.
 *
 * The check run mirrors the review comment. It never gates the comment, the
 * outcome label, or the command that carries them. In September 2026 an
 * installation without Checks write deferred every terminal Review on this
 * write, retried it every two seconds, and held every READY label for days.
 */
export async function mirrorReviewCheckRun(
  mirror: ReviewCheckRunMirror,
  repository: RepositoryMapping,
  headSha: string,
  update: ReviewCheckRunUpdate,
  signal: AbortSignal,
  authorize?: ReviewPublicationAuthority,
): Promise<ReviewCheckRunOutcome> {
  const outcome = reviewCheckRunOutcome(await mirror.publisher.upsertReviewCheckRun(repository, headSha, update, signal, authorize))
  mirror.report(repository.github, outcome)
  return outcome
}

/** The longest title GitHub accepts on one check run output. */
const CHECK_OUTPUT_TITLE_LIMIT = 255

/**
 * What one Review publication owes the Review check run.
 *
 * The check run mirrors the review comment, so `gh pr checks` shows the Review
 * beside CI without a person opening the pull request. It reports visibility,
 * never a verdict: only a READY Review concludes `success`, and every other
 * outcome concludes `neutral`, so no branch protection or CI Review gate can
 * read this service's own opinion as a failed check. A trusted foreign review
 * reports nothing, because this service does not own its visibility.
 *
 * `at` stamps the completion, because GitHub asks for it alongside a
 * conclusion and the caller owns the clock.
 */
export function reviewCheckRunUpdate(command: {
  taskKind: 'adversarial_review' | 'review_fix' | 'existing_review'
  phase: ReviewCheckRunPhase
  desiredOutcome: ReviewDesiredOutcome | null
  body: string
}, at: string): ReviewCheckRunUpdate | null {
  if (command.taskKind === 'existing_review')
    return null
  const headline = command.body.match(/^### (.+)$/m)?.[1] ?? 'Review'
  const title = headline.slice(0, CHECK_OUTPUT_TITLE_LIMIT)
  if (command.phase === 'terminal')
    return { _tag: 'Completed', title, conclusion: command.desiredOutcome === 'READY' ? 'success' : 'neutral', completedAt: at }
  return { _tag: 'Running', title }
}
