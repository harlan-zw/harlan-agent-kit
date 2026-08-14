import type { DashboardSnapshot, ExternalRepositoryWatch, GitHubIssueSubject, RepositoryStatus, SubjectSummary } from './types.ts'
import { createHash } from 'node:crypto'
import { Octokit } from 'octokit'
import { isAutomatedGitHubActor, isIssueAtOrAfterCutoff } from './github.ts'

export interface PublicIssueSnapshot {
  number: number
  state: 'open' | 'closed'
  title: string
  author: string
  url: string
  createdAt: string
  updatedAt: string
  isPullRequest: boolean
  authorType?: string
}

export interface ExternalWatchSnapshot {
  repositories: RepositoryStatus[]
  subjects: SubjectSummary[]
}

export interface ExternalWatchController {
  poll: (signal?: AbortSignal) => Promise<Array<{ repository: string, subjects: number, error?: string }>>
  snapshot: () => ExternalWatchSnapshot
}

export interface ExternalWatchControllerOptions {
  watches: ExternalRepositoryWatch[]
  issueCutoff: string
  now: () => Date
  requestIssue?: (repository: string, number: number, signal?: AbortSignal) => Promise<PublicIssueSnapshot>
  requestIssues?: (repository: string, signal?: AbortSignal) => Promise<PublicIssueSnapshot[]>
}

function repositoryParts(repository: string): { owner: string, repo: string } {
  const [owner, repo] = repository.split('/')
  if (owner === undefined || repo === undefined)
    throw new Error(`Invalid external repository: ${repository}.`)
  return { owner, repo }
}

function defaultIssueRequest(repository: string, number: number, signal?: AbortSignal): Promise<PublicIssueSnapshot> {
  const { owner, repo } = repositoryParts(repository)
  const octokit = new Octokit({ userAgent: 'harlan-github-agent/0.0.0' })
  return octokit.rest.issues.get({
    owner,
    repo,
    issue_number: number,
    ...(signal === undefined ? {} : { request: { signal } }),
  }).then(({ data }) => ({
    number: data.number,
    state: data.state === 'closed' ? 'closed' : 'open',
    title: data.title,
    author: data.user?.login ?? 'ghost',
    url: data.html_url,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    isPullRequest: data.pull_request !== undefined,
    ...(data.user?.type === undefined ? {} : { authorType: data.user.type }),
  }))
}

function defaultIssueListRequest(repository: string, signal?: AbortSignal): Promise<PublicIssueSnapshot[]> {
  const { owner, repo } = repositoryParts(repository)
  const octokit = new Octokit({ userAgent: 'harlan-github-agent/0.0.0' })
  return octokit.paginate(octokit.rest.issues.listForRepo, {
    owner,
    repo,
    state: 'open',
    per_page: 100,
    ...(signal === undefined ? {} : { request: { signal } }),
  }).then(issues => issues.map(issue => ({
    number: issue.number,
    state: issue.state === 'closed' ? 'closed' : 'open',
    title: issue.title,
    author: issue.user?.login ?? 'ghost',
    url: issue.html_url,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    isPullRequest: issue.pull_request !== undefined,
    ...(issue.user?.type === undefined ? {} : { authorType: issue.user.type }),
  })))
}

function issueSubject(repository: string, issue: PublicIssueSnapshot): GitHubIssueSubject {
  return {
    kind: 'issue',
    approvalLabels: [],
    repository,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    author: issue.author,
    url: issue.url,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  }
}

export function createExternalWatchController(options: ExternalWatchControllerOptions): ExternalWatchController {
  const requestIssue = options.requestIssue ?? defaultIssueRequest
  const requestIssues = options.requestIssues ?? defaultIssueListRequest
  const states = new Map<string, { repository: RepositoryStatus, subjects: SubjectSummary[] }>(options.watches.map(watch => [watch.github, {
    repository: {
      github: watch.github,
      enabled: true,
      ownership: 'external' as const,
      lastAttemptAt: null,
      lastSuccessAt: null,
      paused: false,
      lastError: null,
      subjectCount: 0,
    },
    subjects: [] as SubjectSummary[],
  }]))

  const poll: ExternalWatchController['poll'] = async signal => Promise.all(options.watches.map(async (watch) => {
    const at = options.now().toISOString()
    const current = states.get(watch.github)
    if (current === undefined)
      throw new Error(`External repository state is missing: ${watch.github}.`)
    current.repository = { ...current.repository, lastAttemptAt: at }

    const requested = watch.issues === 'all'
      ? requestIssues(watch.github, signal)
      : Promise.all(watch.issues.map(number => requestIssue(watch.github, number, signal)))
    return requested
      .then((issues) => {
        const subjects = issues
          .filter(issue => !issue.isPullRequest)
          .filter(issue => issue.state === 'open')
          .filter(issue => isIssueAtOrAfterCutoff(issue.createdAt, options.issueCutoff))
          .filter(issue => !isAutomatedGitHubActor({ login: issue.author, type: issue.authorType }))
          .map((issue) => {
            const subject = issueSubject(watch.github, issue)
            const revisionId = createHash('sha256').update(JSON.stringify(subject)).digest('hex')
            return { ...subject, revisionId, observedAt: at }
          })
        current.subjects = subjects
        current.repository = {
          ...current.repository,
          lastSuccessAt: at,
          lastError: null,
          subjectCount: subjects.length,
        }
        return { repository: watch.github, subjects: subjects.length }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Public GitHub request failed.'
        current.repository = { ...current.repository, lastError: message }
        return { repository: watch.github, subjects: current.subjects.length, error: message }
      })
  }))

  return {
    poll,
    snapshot: () => ({
      repositories: [...states.values()].map(state => state.repository),
      subjects: [...states.values()].flatMap(state => state.subjects),
    }),
  }
}

export function mergeExternalWatchSnapshot(snapshot: DashboardSnapshot, external: ExternalWatchSnapshot): DashboardSnapshot {
  const repositories = new Set(snapshot.repositories.map(repository => repository.github.toLowerCase()))
  const externalRepositories = external.repositories.filter(repository => !repositories.has(repository.github.toLowerCase()))
  const subjects = new Set(snapshot.subjects.map(subject => `${subject.repository.toLowerCase()}:${subject.kind}:${subject.number}`))
  const externalSubjects = external.subjects.filter(subject => !subjects.has(`${subject.repository.toLowerCase()}:${subject.kind}:${subject.number}`))
  return {
    ...snapshot,
    status: snapshot.status === 'ready' && externalRepositories.some(repository => repository.lastError !== null) ? 'degraded' : snapshot.status,
    repositories: [...snapshot.repositories, ...externalRepositories].sort((left, right) => left.github.localeCompare(right.github)),
    subjects: [...snapshot.subjects, ...externalSubjects],
  }
}
