import type { OpenAgentPullRequest, PullRequestBase } from './types.ts'

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
