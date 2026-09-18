import type { ReviewPublicationAuthority } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { RepositoryMapping, ReviewDesiredOutcome } from './types.ts'

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
