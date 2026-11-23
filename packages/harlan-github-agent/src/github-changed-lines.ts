import type { ChangedLines } from './finding-scope.ts'
import type { GitHubTokenProvider } from './github-auth.ts'
import type { Result } from './result.ts'
import type { RepositoryMapping } from './types.ts'
import { changedLinesFromComparison } from './finding-scope.ts'
import { createAuthenticatedClient } from './github-auth.ts'
import { err } from './result.ts'

/** Reads the head lines one reviewed diff adds, pinned to exact base and head commits. */
export type ChangedLinesReader = (repository: RepositoryMapping, baseSha: string, headSha: string, signal: AbortSignal) => Promise<Result<ChangedLines, string>>

/**
 * Reads the triple-dot comparison GitHub keeps for two exact commits.
 *
 * The Review read the same merge-base diff, so a later push cannot move the
 * lines under a stored finding. GitHub detects renames here, so a moved file
 * does not read as every line added.
 */
export function createGitHubChangedLines(options: { tokens: GitHubTokenProvider, userAgent?: string }): ChangedLinesReader {
  return async (repository, baseSha, headSha, signal) => {
    const token = await options.tokens.getToken(repository.github, 'read', signal)
    if (token._tag === 'Err')
      return err('GitHub read authority is unavailable.')
    const [owner, repo] = repository.github.split('/')
    const client = createAuthenticatedClient({
      access: 'read',
      repository: repository.github,
      tokens: options.tokens,
      token: token.value.token,
      userAgent: options.userAgent ?? 'harlan-github-agent',
      signal,
    })
    return client.request('GET /repos/{owner}/{repo}/compare/{basehead}', { owner: owner!, repo: repo!, basehead: `${baseSha}...${headSha}`, per_page: 1, request: { signal } })
      .then(response => changedLinesFromComparison(response.data))
      .catch((error: unknown) => err(error instanceof Error ? error.message : 'GitHub refused the comparison.'))
  }
}
