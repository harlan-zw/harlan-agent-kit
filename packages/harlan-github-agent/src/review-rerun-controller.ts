import type { GitHubSource } from './github.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { RepositoryMapping, ReviewRerunResult } from './types.ts'
import { err, ok } from './result.ts'

export interface ReviewRerunSync {
  repository: string
  results: ReviewRerunResult[]
}

export interface ReviewRerunDependencies {
  github: Pick<GitHubSource, 'listReviewRerunRequests'>
  store: Pick<JournalStore, 'listOpenPullRequestRevisions' | 'requestReviewRerun' | 'requestPullRequestChange'>
  allowedAuthors: string[]
  now: () => Date
  signal?: AbortSignal
}

export function syncReviewRerunRequests(
  repository: RepositoryMapping,
  dependencies: ReviewRerunDependencies,
): Promise<Result<ReviewRerunSync, string>> {
  return dependencies.github.listReviewRerunRequests(repository, dependencies.signal).then((requests) => {
    if (requests._tag === 'Err')
      return err(requests.error.message)
    const at = dependencies.now().toISOString()
    const subjects = dependencies.store.listOpenPullRequestRevisions(repository.github)
    const allowedAuthors = new Set(dependencies.allowedAuthors.map(author => author.toLowerCase()))
    const results = requests.value.flatMap((request): ReviewRerunResult[] => {
      if (!allowedAuthors.has(request.author.toLowerCase()))
        return []
      const subject = subjects.find(candidate =>
        candidate.number === request.pullRequestNumber,
      )
      if (subject === undefined)
        return []
      if (request.origin === 'ChangeRequest') {
        return [dependencies.store.requestPullRequestChange({
          repository: repository.github,
          pullRequestNumber: request.pullRequestNumber,
          revisionId: subject.revisionId,
          requestId: `github-change:${repository.github}:${request.commentId}:${request.updatedAt}`,
          instruction: request.instruction,
          requestedBy: request.author,
          at,
        })]
      }
      return [dependencies.store.requestReviewRerun({
        repository: repository.github,
        pullRequestNumber: request.pullRequestNumber,
        revisionId: subject.revisionId,
        // Conversation and review comment ids are separate GitHub sequences.
        requestId: `${request.origin === 'Command' ? 'github-comment' : 'github-review-comment'}:${repository.github}:${request.commentId}:${request.updatedAt}`,
        source: 'github_comment',
        requestedBy: request.author,
        at,
      })]
    })
    return ok({ repository: repository.github, results })
  })
}

/**
 * Reads review commands only where an open pull request can accept one.
 *
 * Repository discovery can expose hundreds of installations. Polling every
 * repository once per minute exhausted the GitHub App request quota, even when
 * almost all repositories had no open pull requests. Sequential reads also
 * avoid a secondary-rate-limit burst when several repositories are active.
 */
export async function syncOpenReviewRerunRequests(
  repositories: RepositoryMapping[],
  dependencies: ReviewRerunDependencies,
): Promise<Array<Result<ReviewRerunSync, string>>> {
  const eligible = repositories.filter(repository => repository.enabled
    && repository.pullRequestReview
    && dependencies.store.listOpenPullRequestRevisions(repository.github).length > 0)
  const results: Array<Result<ReviewRerunSync, string>> = []
  for (const repository of eligible)
    results.push(await syncReviewRerunRequests(repository, dependencies))
  return results
}
