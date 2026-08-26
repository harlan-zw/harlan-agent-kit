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
