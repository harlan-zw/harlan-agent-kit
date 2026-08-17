import type { GitHubSource } from './github.ts'
import type { DashboardSnapshot, GitHubPullRequestItem, PullRequestStatus, RepositoryMapping, ReviewAgent } from './types.ts'

export interface PullRequestStatusController {
  apply: (snapshot: DashboardSnapshot) => DashboardSnapshot
  sync: (snapshot: DashboardSnapshot, signal?: AbortSignal) => Promise<{ checked: number, errors: string[] }>
}

export interface PullRequestStatusControllerOptions {
  github: Pick<GitHubSource, 'getPullRequest'>
  now: () => Date
  repositories: RepositoryMapping[]
  limit?: number
}

function reviewKey(review: ReviewAgent): string {
  return `${review.repository}:${review.pullRequestNumber}`
}

function statusFromPullRequest(pullRequest: GitHubPullRequestItem): PullRequestStatus {
  if (pullRequest.state === 'open')
    return { _tag: 'Open' }
  return pullRequest.mergedAt === null
    ? { _tag: 'Closed' }
    : { _tag: 'Merged', mergedAt: pullRequest.mergedAt }
}

export function createPullRequestStatusController(options: PullRequestStatusControllerOptions): PullRequestStatusController {
  const statuses = new Map<string, PullRequestStatus>()
  const retryAfter = new Map<string, number>()
  const repositories = new Map(options.repositories.map(repository => [repository.github, repository]))
  const limit = options.limit ?? 5

  const apply = (snapshot: DashboardSnapshot): DashboardSnapshot => ({
    ...snapshot,
    agents: snapshot.agents.map(agent => agent._tag === 'ReviewAgent'
      ? { ...agent, pullRequestStatus: statuses.get(reviewKey(agent)) ?? agent.pullRequestStatus }
      : agent),
  })

  const sync: PullRequestStatusController['sync'] = async (snapshot, signal) => {
    const now = options.now().getTime()
    const openPullRequests = new Set(snapshot.items.flatMap(subject =>
      subject.kind === 'pull_request' ? [`${subject.repository}:${subject.number}`] : []))
    const recentReviews = snapshot.agents
      .filter((agent): agent is ReviewAgent => agent._tag === 'ReviewAgent')
      .toSorted((left, right) => right.completedAt.localeCompare(left.completedAt))
      .filter((review, index, reviews) => reviews.findIndex(candidate => reviewKey(candidate) === reviewKey(review)) === index)
      .slice(0, limit)
    const checks: ReviewAgent[] = []
    const errors: string[] = []

    recentReviews.forEach((review) => {
      const key = reviewKey(review)
      if (openPullRequests.has(key)) {
        statuses.set(key, { _tag: 'Open' })
        retryAfter.delete(key)
        return
      }
      const status = statuses.get(key)
      if (status?._tag === 'Merged' || status?._tag === 'Closed')
        return
      if ((retryAfter.get(key) ?? 0) > now)
        return
      checks.push(review)
    })

    await Promise.all(checks.map(async (review) => {
      const key = reviewKey(review)
      const repository = repositories.get(review.repository)
      if (repository === undefined) {
        errors.push(`${review.repository}: repository mapping is unavailable.`)
        retryAfter.set(key, now + 5 * 60_000)
        return
      }
      const result = await options.github.getPullRequest(repository, review.pullRequestNumber, signal)
      if (result._tag === 'Err') {
        errors.push(`${review.repository}#${review.pullRequestNumber}: ${result.error.message}`)
        retryAfter.set(key, now + 5 * 60_000)
        return
      }
      statuses.set(key, statusFromPullRequest(result.value))
      retryAfter.delete(key)
    }))

    return { checked: checks.length, errors }
  }

  return { apply, sync }
}
