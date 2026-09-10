import type { Octokit } from 'octokit'

/** Reads the live commit behind a pull request base branch. */
export async function currentBaseSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await octokit.rest.repos.getBranch({
    owner,
    repo,
    branch,
    ...(signal === undefined ? {} : { request: { signal } }),
  })
  return response.data.commit.sha
}

/**
 * How many base branch commits the CI read walks back from the branch head.
 *
 * A run of docs-only merges is a few commits long. Ten covers that, and it
 * bounds the API cost on a repository that runs no CI at all.
 */
export const BASE_CHECKS_HISTORY = 10

/**
 * Reads base branch CI from the newest commit that has a check run.
 *
 * A workflow with `paths-ignore` runs nothing for a docs-only commit, so a
 * docs-only merge leaves the base head with no check run. On 2026-09-10
 * gscdump#55 read "Base branch CI is unavailable" for that reason, with no
 * future CI result able to resolve it. A commit that ran no CI changed no
 * tested file, so the last CI verdict on the branch still describes it.
 *
 * `commits` lists the branch from its head, newest first. The read stops at
 * the first commit with a check run, and returns the head snapshot unchanged
 * when it is unreadable or when nothing in the window ran CI.
 */
export async function currentBaseChecks<Checks extends { _tag: 'Available', checks: unknown[] } | { _tag: 'Unavailable' }>(
  headSha: string,
  checksFor: (sha: string) => Promise<Checks>,
  commits: (headSha: string, count: number) => Promise<string[]>,
): Promise<Checks> {
  const head = await checksFor(headSha)
  if (head._tag !== 'Available' || head.checks.length > 0)
    return head
  const earlier = (await commits(headSha, BASE_CHECKS_HISTORY)).filter(sha => sha !== headSha)
  for (const sha of earlier) {
    const checks = await checksFor(sha)
    if (checks._tag !== 'Available' || checks.checks.length > 0)
      return checks
  }
  return head
}
