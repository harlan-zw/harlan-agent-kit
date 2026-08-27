import type { ReviewOutcomeName } from './types.ts'

export interface ReviewOutcomeLabelDefinition {
  name: string
  color: string
  description: string
}

/**
 * The pull request label a finished Review stamps.
 *
 * The canonical comment already states the verdict, but a person deciding what
 * to review next reads a list of pull requests, not a list of comments. The
 * label carries the same word the comment heading uses, so the two never
 * disagree.
 */
export const REVIEW_OUTCOME_LABELS = {
  READY: {
    name: 'harlan-agent-ready',
    color: '0e8a16',
    description: 'The automated Review passed every gate on this head commit.',
  },
  PENDING: {
    name: 'harlan-agent-pending',
    color: 'fbca04',
    description: 'The automated Review is waiting on a gate for this head commit.',
  },
  BLOCKED: {
    name: 'harlan-agent-blocked',
    color: 'd73a4a',
    description: 'The automated Review found a material defect in this head commit.',
  },
} as const satisfies Record<ReviewOutcomeName, ReviewOutcomeLabelDefinition>

/**
 * The label writes one Review outcome needs.
 *
 * `add` is null when the pull request already carries the right label, so an
 * unchanged verdict writes nothing to GitHub. `remove` never names a label
 * outside this set: a person's own labels are theirs.
 */
export interface ReviewOutcomeLabelPlan {
  add: ReviewOutcomeLabelDefinition | null
  remove: string[]
}

const ownedLabels = new Set(Object.values(REVIEW_OUTCOME_LABELS).map(label => label.name.toLowerCase()))

export function planReviewOutcomeLabels(outcome: ReviewOutcomeName, current: string[]): ReviewOutcomeLabelPlan {
  const wanted = REVIEW_OUTCOME_LABELS[outcome]
  const present = current.map(label => label.toLowerCase())
  return {
    add: present.includes(wanted.name.toLowerCase()) ? null : wanted,
    // One head commit reached one verdict. A second outcome label on the same
    // pull request states a second one, so every other outcome label goes.
    remove: current.filter(label =>
      ownedLabels.has(label.toLowerCase()) && label.toLowerCase() !== wanted.name.toLowerCase()),
  }
}

/**
 * The verdict labels to strip from a pull request with no verdict.
 *
 * A label names the head its Review answered for, and GitHub cannot show that
 * head. Once a newer head arrives with no Review behind it, the label reads as
 * a verdict on work nobody reviewed, so it goes until the next Review stamps.
 */
export function staleReviewOutcomeLabels(current: string[]): string[] {
  return current.filter(label => ownedLabels.has(label.toLowerCase()))
}
