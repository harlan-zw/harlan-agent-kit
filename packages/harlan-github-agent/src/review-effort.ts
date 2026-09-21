import type { PullRequestFile } from './merge-risk.ts'
import type { CodexReasoningEffort } from './types.ts'
import { matchesGlob } from './merge-risk.ts'
import { isInstructionPath } from './pull-request-triage.ts'

/**
 * The Reasoning effort one Review run answers at.
 *
 * A subset of the Agent Reasoning efforts. A Review never runs at `none`, and
 * `xhigh` and `max` stay a manual pin.
 */
export type ReviewReasoningEffort = Extract<CodexReasoningEffort, 'low' | 'medium' | 'high'>

export interface ReviewReasoningEffortBand {
  effort: ReviewReasoningEffort
  /** Starts with `rule: ` so a stored row still names its source. */
  reason: string
}

/** Ranks the three values so the more expensive of two always wins. */
export function reviewReasoningEffortRank(effort: ReviewReasoningEffort): number {
  return effort === 'low' ? 0 : effort === 'medium' ? 1 : 2
}

export interface ReviewReasoningEffortPolicy {
  /** Any match reviews at `high`, whatever its size. */
  sensitivePaths: readonly string[]
  /** At or above this many changed files, or changed lines, the band is `high`. */
  wideChangedFiles: number
  wideChangedLines: number
  /** At or above this many changed files, or changed lines, the band is `medium`. */
  mediumChangedFiles: number
  mediumChangedLines: number
}

/**
 * The bands every repository starts from.
 *
 * They come from 93 recorded Review runs of public repositories, labelled by
 * whether that Review found a defect. Below `medium`, 9 percent of pull
 * requests carried one, against 24 percent across the whole set.
 */
export const DEFAULT_REVIEW_REASONING_EFFORT_POLICY: ReviewReasoningEffortPolicy = {
  sensitivePaths: [],
  wideChangedFiles: 20,
  wideChangedLines: 600,
  mediumChangedFiles: 5,
  mediumChangedLines: 120,
}

/**
 * How much reasoning an adversarial Review of this pull request needs.
 *
 * Paths and counts decide it, because they predict a defect better than a
 * judgement of the change does. Measured on the recorded Review runs, changed
 * lines rank a defect-carrying pull request at 0.80 area under the curve. The
 * classification service, asked the same thing from the same state, reaches
 * 0.72, and adding it to the line count moves nothing. So this stays a rule,
 * and the service is spared a call it cannot win.
 *
 * It only ever lowers the Reasoning effort below the Agent default. A wide,
 * sensitive, or unreadable change keeps `high`.
 */
export function reviewReasoningEffortBand(
  files: readonly PullRequestFile[] | null,
  policy: ReviewReasoningEffortPolicy = DEFAULT_REVIEW_REASONING_EFFORT_POLICY,
): ReviewReasoningEffortBand {
  if (files === null || files.length === 0)
    return { effort: 'high', reason: 'rule: the changed files could not be read.' }

  const instruction = files.find(file => isInstructionPath(file.path))
  if (instruction !== undefined)
    return { effort: 'high', reason: `rule: ${instruction.path} is read as instructions by an agent.` }

  const sensitive = files.find(file => policy.sensitivePaths.some(pattern => matchesGlob(pattern, file.path)))
  if (sensitive !== undefined)
    return { effort: 'high', reason: `rule: ${sensitive.path} is a sensitive path for this repository.` }

  const lines = files.reduce((total, file) => total + file.additions + file.deletions, 0)
  if (files.length >= policy.wideChangedFiles || lines >= policy.wideChangedLines)
    return { effort: 'high', reason: `rule: the pull request changes ${lines} lines in ${files.length} files.` }
  if (files.length >= policy.mediumChangedFiles || lines >= policy.mediumChangedLines)
    return { effort: 'medium', reason: `rule: the pull request changes ${lines} lines in ${files.length} files.` }
  return { effort: 'low', reason: `rule: the pull request changes ${lines} lines in ${files.length} files.` }
}

/**
 * The Reasoning effort this Review answers at, given the Agent default.
 *
 * The band may lower the default and never raise it, so switching provider or
 * pinning a cheaper effort still decides the ceiling. A default this service
 * does not know stays untouched.
 */
export function applyReviewReasoningEffortBand(
  agentDefault: CodexReasoningEffort | undefined,
  band: ReviewReasoningEffort,
): CodexReasoningEffort | undefined {
  if (agentDefault !== 'low' && agentDefault !== 'medium' && agentDefault !== 'high')
    return agentDefault
  return reviewReasoningEffortRank(band) < reviewReasoningEffortRank(agentDefault) ? band : agentDefault
}
