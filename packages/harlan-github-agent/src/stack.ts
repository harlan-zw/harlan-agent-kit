import type { OpenAgentPullRequest, PullRequestBase } from './types.ts'

/** One stack candidate with the files its pull request changes. */
export interface StackCandidateFiles extends OpenAgentPullRequest {
  changedFiles: readonly string[]
}

function stacked(candidate: OpenAgentPullRequest): PullRequestBase {
  return {
    _tag: 'Stacked',
    ref: candidate.headRef,
    pullRequestNumber: candidate.pullRequestNumber,
    headSha: candidate.headSha,
  }
}

/**
 * Chooses the base branch for a new pull request before the agent runs.
 *
 * An open Baseline repair means the default branch is broken. Work branched off
 * the default branch inherits that breakage, so the new pull request stacks on
 * the repair instead.
 *
 * A repair that is itself stacked is skipped. The service stacks one level, so
 * every base it picks is a branch it opened directly on the default branch.
 */
export function chooseStackBase(input: {
  defaultBranch: string
  candidates: readonly OpenAgentPullRequest[]
}): PullRequestBase {
  const repair = input.candidates
    .filter(candidate => candidate.taskKind === 'baseline_repair' && candidate.baseRef === input.defaultBranch)
    .sort((left, right) => right.pullRequestNumber - left.pullRequestNumber)[0]
  return repair === undefined ? { _tag: 'DefaultBranch', ref: input.defaultBranch } : stacked(repair)
}

/**
 * Chooses the base branch again once the changed files are known.
 *
 * Overlapping files mean the new work builds on work that is still in review, so
 * the new pull request stacks on it and reviewers read one diff each.
 *
 * A base chosen before the agent ran already has a stronger reason, so it wins.
 */
export function chooseOverlappingStackBase(input: {
  chosen: PullRequestBase
  changedFiles: readonly string[]
  candidates: readonly StackCandidateFiles[]
}): PullRequestBase {
  const chosen = input.chosen
  if (chosen._tag === 'Stacked')
    return chosen
  const changed = new Set(input.changedFiles)
  const best = input.candidates
    .filter(candidate => candidate.baseRef === chosen.ref)
    .map(candidate => ({ candidate, overlap: candidate.changedFiles.filter(file => changed.has(file)).length }))
    .filter(entry => entry.overlap > 0)
    .sort((left, right) => right.overlap - left.overlap || right.candidate.pullRequestNumber - left.candidate.pullRequestNumber)[0]
  return best === undefined ? chosen : stacked(best.candidate)
}
