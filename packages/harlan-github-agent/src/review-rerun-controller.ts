import type { GitHubSource } from './github.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { RepositoryMapping, ReviewRerunResult } from './types.ts'
import { err, ok } from './result.ts'

export interface ReviewRerunSync {
  repository: string
  results: ReviewRerunResult[]
}

export function syncReviewRerunRequests(
  repository: RepositoryMapping,
  dependencies: {
    github: Pick<GitHubSource, 'listReviewRerunRequests'>
    store: Pick<JournalStore, 'getDashboardSnapshot' | 'requestReviewRerun'>
    allowedAuthors: string[]
    now: () => Date
    signal?: AbortSignal
  },
): Promise<Result<ReviewRerunSync, string>> {
  return dependencies.github.listReviewRerunRequests(repository, dependencies.signal).then((requests) => {
    if (requests._tag === 'Err')
      return err(requests.error.message)
    const at = dependencies.now().toISOString()
    const subjects = dependencies.store.getDashboardSnapshot(at).subjects
    const allowedAuthors = new Set(dependencies.allowedAuthors.map(author => author.toLowerCase()))
    const results = requests.value.flatMap((request): ReviewRerunResult[] => {
      if (!allowedAuthors.has(request.author.toLowerCase()))
        return []
      const subject = subjects.find(candidate =>
        candidate.kind === 'pull_request'
        && candidate.repository === repository.github
        && candidate.number === request.pullRequestNumber,
      )
      if (subject === undefined)
        return []
      return [dependencies.store.requestReviewRerun({
        repository: repository.github,
        pullRequestNumber: request.pullRequestNumber,
        revisionId: subject.revisionId,
        requestId: `github-comment:${repository.github}:${request.commentId}:${request.updatedAt}`,
        source: 'github_comment',
        requestedBy: request.author,
        at,
      })]
    })
    return ok({ repository: repository.github, results })
  })
}
