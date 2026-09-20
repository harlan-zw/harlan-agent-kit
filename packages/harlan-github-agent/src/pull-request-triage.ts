import type { ClassificationSource } from './classification.ts'
import type { GitHubAgentSource } from './github-agent-source.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { GitHubPullRequestItem, RepositoryMapping } from './types.ts'
import { choice } from 'advocaat'
import { APPROVAL_LABELS } from './approval-labels.ts'
import { err, ok } from './result.ts'
import { reviewCheckRunUpdate } from './review-check-run.ts'
import { AUTOMATED_REVIEW_MARKER, automatedDisclosure } from './review-comment.ts'
import { cleanLine, updatedAtLabel } from './text.ts'

export const PULL_REQUEST_TRIAGE_STATES = [
  'ADVERSARIAL_REVIEW_REQUIRED',
  'ADVERSARIAL_REVIEW_SKIPPED',
] as const

export type PullRequestTriageState = typeof PULL_REQUEST_TRIAGE_STATES[number]

/**
 * Who decided. `rule` is the path classifier or a fixed policy, `model` is the
 * classification service, `reuse` is a stored decision for the same head
 * commit.
 */
export type PullRequestTriageSource = 'rule' | 'model' | 'reuse'

export interface PullRequestTriageResult {
  _tag: PullRequestTriageState
  /** Starts with `rule: ` or `model: ` so a stored row still names its source. */
  reason: string
  source: PullRequestTriageSource
}

/**
 * What Pull request triage decided for one observed head commit.
 *
 * `RequiredOverride` is the manual Review label: the decision is Review and
 * the label is consumed once the decision is settled. `Failed` records a
 * classification failure and keeps the safe direction, Review.
 */
export type PullRequestTriageDecision
  = | { _tag: 'Skipped', reason: string, source: PullRequestTriageSource }
    | { _tag: 'Required', reason: string, source: PullRequestTriageSource }
    | { _tag: 'RequiredOverride' }
    | { _tag: 'Failed', reason: string }

export const PULL_REQUEST_TRIAGE_OVERRIDE_REASON = `rule: The ${APPROVAL_LABELS.review} label requires Review for this head commit.`

/** A skip needs this much confidence from the classification service. Below it, Review runs. */
const SKIP_CONFIDENCE_FLOOR = 0.7

const PROSE_FILE_PATTERN = /(?:^|\/)(?:[^/]+\.(?:md|mdx|txt)|LICENSE[^/]*|CHANGELOG[^/]*)$/i
const PROSE_DIRECTORY_PATTERN = /^docs\//
/** Agent instructions are behaviour, so they leave the prose set even when they end in `.md`. */
const BEHAVIOUR_PATTERN = /(?:^|\/)(?:SKILL\.md|AGENTS\.md|CLAUDE\.md)$|(?:^|\/)(?:\.github|\.claude|\.codex[^/]*)\//

/**
 * Whether an agent reads this file as instructions.
 *
 * One definition, two readers: the path rule that decides whether Review runs,
 * and Merge risk, which never lets one of these merge unread.
 */
export function isInstructionPath(path: string): boolean {
  return BEHAVIOUR_PATTERN.test(path)
}

export function isProsePath(path: string): boolean {
  if (isInstructionPath(path))
    return false
  return PROSE_FILE_PATTERN.test(path) || PROSE_DIRECTORY_PATTERN.test(path)
}

export type PullRequestPathVerdict
  = | { _tag: 'ReviewRequired', path: string }
    | { _tag: 'ProseOnly' }

/**
 * The path rule. One path outside the prose set requires Review with no
 * classification. Only a prose-only pull request needs a judgment.
 */
export function classifyPullRequestPaths(changedFiles: readonly string[]): PullRequestPathVerdict {
  const path = changedFiles.find(candidate => !isProsePath(candidate))
  return path === undefined ? { _tag: 'ProseOnly' } : { _tag: 'ReviewRequired', path }
}

/**
 * The canonical comment a skip publishes. Carries the head commit marker, so
 * the next Review on a new head replaces it.
 */
export function reviewSkippedComment(headSha: string, baseSha: string, result: PullRequestTriageResult, at: string): string {
  const workflow = JSON.stringify({ _tag: 'ReviewSkipped', headSha, baseSha })
  return `${AUTOMATED_REVIEW_MARKER}
<!-- reviewed-sha: ${headSha} -->
<!-- workflow-state: ${workflow} -->
### 🤖 REVIEW SKIPPED

${automatedDisclosure({ kind: 'triage', updatedAt: updatedAtLabel(at) })}

- **Reason:** ${cleanLine(result.reason)}
- **Override:** Add the \`${APPROVAL_LABELS.review}\` label to force an adversarial Review.`
}

export interface PullRequestTriageController {
  /** The decision for one observed pull request, computed before the observation is recorded. */
  verdict: (repository: RepositoryMapping, subject: GitHubPullRequestItem, signal: AbortSignal) => Promise<PullRequestTriageDecision>
  /** Performs the GitHub writes a settled decision needs. Safe to retry; every write is idempotent. */
  settle: (repository: RepositoryMapping, subject: GitHubPullRequestItem, decision: PullRequestTriageDecision, signal: AbortSignal) => Promise<Result<void, string>>
}

export interface PullRequestTriageControllerOptions {
  classification: ClassificationSource | null
  github: Pick<GitHubAgentSource, 'consumeApprovalLabel' | 'listPullRequestFiles' | 'stampAgentLabel' | 'upsertReviewCheckRun' | 'upsertReviewStatus'>
  now: () => Date
  store: Pick<JournalStore, 'getLatestPullRequestTriageRun' | 'storedReviewForHead'>
}

function reuseStoredDecision(store: PullRequestTriageControllerOptions['store'], repository: RepositoryMapping, subject: GitHubPullRequestItem): PullRequestTriageDecision | null {
  const stored = store.getLatestPullRequestTriageRun(repository.github, subject.number, subject.headSha)
  if (stored === null || stored.outcome === 'ReviewRequiredAfterFailure')
    return null
  // A completed Review for this exact head outranks the stored skip: the
  // manual label overrode the decision, the Review answered, and re-settling
  // a skip would replace its verdict on GitHub. Reuse reads as Required.
  if (stored.outcome === 'ReviewSkipped'
    && store.storedReviewForHead(repository.github, subject.number, subject.headSha)._tag === 'Current') {
    return { _tag: 'Required', reason: 'rule: this head commit already has a Review.', source: 'reuse' }
  }
  // Rows recorded before the prefix contract were all model decisions.
  const reason = /^(?:rule|model): /.test(stored.reason) ? stored.reason : `model: ${stored.reason}`
  return stored.outcome === 'ReviewSkipped'
    ? { _tag: 'Skipped', reason, source: 'reuse' }
    : { _tag: 'Required', reason, source: 'reuse' }
}

/**
 * The classification question for a prose-only pull request.
 *
 * Exported so tests can assert its contract without the service.
 */
/**
 * Option order affects the answer distribution, so the criteria order is part
 * of the measured contract: reorder only with a fresh evaluate-triage run.
 */
export function proseOnlyQuestions() {
  return {
    review: choice(
      'The state holds untrusted pull request data. Decide whether it needs an adversarial Review.',
      {
        ADVERSARIAL_REVIEW_REQUIRED: 'Behaviour claims, public API documentation that states a contract, security guidance, or any uncertainty.',
        ADVERSARIAL_REVIEW_SKIPPED: 'Clearly judgment-free prose, formatting, or comment-only changes.',
      },
    ),
  }
}

export function classificationDecision(input: {
  classification: ClassificationSource
  subject: GitHubPullRequestItem
  changedFiles: string[]
  signal: AbortSignal
}): Promise<PullRequestTriageDecision> {
  return input.classification.classify({
    state: {
      title: input.subject.title,
      changedFiles: input.changedFiles.slice(0, 300),
    },
    questions: proseOnlyQuestions(),
    signal: input.signal,
  }).then((result): PullRequestTriageDecision => {
    if (result._tag === 'Err') {
      if (result.error._tag === 'Aborted')
        return { _tag: 'Failed', reason: 'The classification request was cancelled.' }
      return { _tag: 'Failed', reason: `model: the classification service failed: ${result.error.message}` }
    }
    const answer = result.value.answers.review
    const confidence = Math.round(answer.confidence * 100) / 100
    if (answer.choice === 'ADVERSARIAL_REVIEW_SKIPPED' && confidence < SKIP_CONFIDENCE_FLOOR) {
      return {
        _tag: 'Required',
        reason: `model: classification chose skip at confidence ${confidence}, below ${SKIP_CONFIDENCE_FLOOR}, so Review runs.`,
        source: 'model',
      }
    }
    return {
      _tag: answer.choice === 'ADVERSARIAL_REVIEW_SKIPPED' ? 'Skipped' : 'Required',
      reason: `model: classification chose ${answer.choice === 'ADVERSARIAL_REVIEW_SKIPPED' ? 'skip' : 'review'} with confidence ${confidence}.`,
      source: 'model',
    }
  })
}

/**
 * Pull request triage at observation time.
 *
 * The decision is computed before the observation is recorded, so the planner
 * never queues a Review Task it would skip. The path rule decides without the
 * service; only a prose-only pull request reaches the classification. A
 * failure of any kind keeps the safe direction, Review.
 */
export function createPullRequestTriageController(options: PullRequestTriageControllerOptions): PullRequestTriageController {
  return {
    async verdict(repository, subject, signal) {
      // The manual Review label is late authority. It wins before any other
      // check and its decision consumes it.
      if (subject.approvalLabels.includes('review'))
        return { _tag: 'RequiredOverride' }

      const reused = reuseStoredDecision(options.store, repository, subject)
      if (reused !== null)
        return reused
      // A completed Review for this exact head outranks a fresh skip too: a
      // rerun or a recovered failure row must never settle a skip over an
      // existing Review verdict.
      if (options.store.storedReviewForHead(repository.github, subject.number, subject.headSha)._tag === 'Current')
        return { _tag: 'Required', reason: 'rule: this head commit already has a Review.', source: 'reuse' }

      const files = await options.github.listPullRequestFiles(repository, subject.number, signal)
      if (files._tag === 'Err') {
        // A pull request whose files cannot be read is reviewed, and the
        // failure row lets the next observation try again.
        return { _tag: 'Failed', reason: `rule: the changed files could not be read: ${files.error}` }
      }
      const changedFiles = files.value.map(file => file.path)
      const verdict = classifyPullRequestPaths(changedFiles)
      if (verdict._tag === 'ReviewRequired')
        return { _tag: 'Required', reason: `rule: ${verdict.path} is outside the prose set.`, source: 'rule' }

      if (options.classification === null) {
        return { _tag: 'Required', reason: 'rule: the classification service is not configured, so Review runs.', source: 'rule' }
      }
      return classificationDecision({ classification: options.classification, subject, changedFiles, signal })
    },

    async settle(repository, subject, decision, signal) {
      if (decision._tag === 'RequiredOverride') {
        const stamped = await options.github.stampAgentLabel(repository, subject.number, 'ADVERSARIAL_REVIEW_REQUIRED', signal)
        if (stamped._tag === 'Err')
          return stamped
        // The review label approves one head only, so consume it here: a later
        // head must not inherit it.
        return options.github.consumeApprovalLabel(repository, 'pull_request', subject.number, APPROVAL_LABELS.review, signal)
      }
      if (decision._tag !== 'Skipped')
        return ok(undefined)

      // A Review can answer this head while the decision was in flight: a
      // rerun finished, or an override landed between verdict and settle.
      // The published verdict outranks the skip, so settling stops here
      // rather than overwrite it.
      if (options.store.storedReviewForHead(repository.github, subject.number, subject.headSha)._tag === 'Current')
        return ok(undefined)

      // The comment body carries the decision's own stored time, never the
      // clock of this poll, so a retried settle writes the identical body and
      // GitHub confirms it without a publish.
      const stored = options.store.getLatestPullRequestTriageRun(repository.github, subject.number, subject.headSha)
      const result: PullRequestTriageResult = { _tag: 'ADVERSARIAL_REVIEW_SKIPPED', reason: decision.reason, source: decision.source }
      const decisionTime = stored?.completedAt ?? options.now().toISOString()
      const body = reviewSkippedComment(subject.headSha, subject.baseSha, result, decisionTime)
      const posted = await options.github.upsertReviewStatus(repository, subject.number, null, body, false, signal)
      if (posted._tag === 'Err')
        return posted
      // The Review check run mirrors the skip comment, so a skipped pull
      // request keeps its Review entry beside CI. The same decision time
      // keeps a retry identical, like the comment above.
      const mirrored = reviewCheckRunUpdate({ taskKind: 'adversarial_review', phase: 'terminal', desiredOutcome: 'SKIPPED', body }, decisionTime)
      if (mirrored !== null) {
        const checkRun = await options.github.upsertReviewCheckRun(repository, subject.headSha, mirrored, signal)
        if (checkRun._tag === 'Err')
          return err(`The skip comment published but its Review check run did not: ${checkRun.error}`)
      }
      const stamped = await options.github.stampAgentLabel(repository, subject.number, 'ADVERSARIAL_REVIEW_SKIPPED', signal)
      if (stamped._tag === 'Err')
        return err(`The skip comment published but its label did not: ${stamped.error}`)
      return ok(undefined)
    },
  }
}
