import type { GitHubTokenProvider } from './github-auth.ts'
import type { Result } from './result.ts'
import type { GitHubPullRequestSubject, GitHubSubject, RepositoryMapping } from './types.ts'
import { Octokit } from 'octokit'
import { approvalLabels } from './approval-labels.ts'
import { err, ok } from './result.ts'
import { priorAutomatedReviewForHead } from './review-comment.ts'
import { isReviewRerunCommand } from './review-rerun.ts'

export interface GitHubReadError {
  repository: string
  message: string
  status?: number
}

export interface GitHubReviewRerunRequest {
  author: string
  commentId: number
  pullRequestNumber: number
  updatedAt: string
}

export interface GitHubSource {
  isBranchProtected: (repository: RepositoryMapping, branch: string, signal?: AbortSignal) => Promise<Result<boolean, GitHubReadError>>
  getPullRequest: (repository: RepositoryMapping, number: number, signal?: AbortSignal) => Promise<Result<GitHubPullRequestSubject, GitHubReadError>>
  listOpenSubjects: (repository: RepositoryMapping, signal?: AbortSignal) => Promise<Result<GitHubSubject[], GitHubReadError>>
  listReviewRerunRequests: (repository: RepositoryMapping, signal?: AbortSignal) => Promise<Result<GitHubReviewRerunRequest[], GitHubReadError>>
}

export interface GitHubSourceOptions {
  tokens: GitHubTokenProvider
  issueCutoff: string
  userAgent?: string
}

export interface PublishedPullRequest {
  number: number
  url: string
}

export interface GitHubPullRequestPublisher {
  ensurePullRequest: (input: {
    repository: RepositoryMapping
    headRef: string
    expectedHeadSha: string
    title: string
    body: string
  }, signal?: AbortSignal) => Promise<Result<PublishedPullRequest, GitHubReadError>>
}

export interface GitHubPullRequestPublisherOptions extends Pick<GitHubSourceOptions, 'tokens' | 'userAgent'> {
  createClient?: (token: string) => Octokit
}

function repositoryParts(repository: string): { owner: string, repo: string } {
  const [owner, repo] = repository.split('/')
  if (owner === undefined || repo === undefined)
    throw new Error(`Invalid repository mapping: ${repository}.`)
  return { owner, repo }
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error))
    return undefined
  return typeof error.status === 'number' ? error.status : undefined
}

export function isAutomatedGitHubActor(actor: { login: string, type?: string | undefined }): boolean {
  const login = actor.login.toLowerCase()
  return actor.type === 'Bot' || login.includes('bot') || login.startsWith('app/')
}

export function isIssueAtOrAfterCutoff(createdAt: string, cutoff: string): boolean {
  return Date.parse(createdAt) >= Date.parse(`${cutoff}T00:00:00.000Z`)
}

function pullRequestSubject(repository: RepositoryMapping, pull: Awaited<ReturnType<Octokit['rest']['pulls']['get']>>['data']): GitHubPullRequestSubject {
  return {
    kind: 'pull_request',
    approvalLabels: approvalLabels(pull.labels.flatMap(label => typeof label === 'string' || label.name === undefined ? [] : [label.name])),
    repository: repository.github,
    number: pull.number,
    state: pull.state === 'closed' ? 'closed' : 'open',
    mergedAt: pull.merged_at,
    title: pull.title,
    author: pull.user?.login ?? 'ghost',
    url: pull.html_url,
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    draft: pull.draft ?? false,
    baseSha: pull.base.sha,
    headSha: pull.head.sha,
    headRepository: pull.head.repo?.full_name ?? '',
    headRef: pull.head.ref,
    maintainerCanModify: pull.maintainer_can_modify ?? false,
    mergeState: pull.mergeable === false
      ? 'conflicting'
      : pull.mergeable === true ? 'clean' : 'unknown',
    priorAutomatedReview: { _tag: 'None' },
  }
}

async function mapConcurrent<Input, Output>(
  values: Input[],
  concurrency: number,
  transform: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const output: Array<Output | undefined> = Array.from({ length: values.length })
  let nextIndex = 0

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      const value = values[index]
      if (value !== undefined)
        output[index] = await transform(value)
    }
  }))
  if (output.includes(undefined))
    throw new Error('Concurrent mapping completed without every result.')
  return output as Output[]
}

export function createGitHubSource(options: GitHubSourceOptions): GitHubSource {
  const client = async (repository: string, signal?: AbortSignal): Promise<Result<Octokit, GitHubReadError>> => {
    const token = await options.tokens.getToken(repository, 'read', signal)
    if (token._tag === 'Err')
      return err(token.error)
    return ok(new Octokit({ auth: token.value.token, userAgent: options.userAgent ?? 'harlan-github-agent/0.0.0' }))
  }

  return {
    isBranchProtected: async (repository, branch, signal) => {
      const { owner, repo } = repositoryParts(repository.github)
      const octokit = await client(repository.github, signal)
      if (octokit._tag === 'Err')
        return octokit
      return octokit.value.rest.repos.getBranch({ owner, repo, branch, ...(signal === undefined ? {} : { request: { signal } }) })
        .then(response => ok(response.data.protected))
        .catch((error: unknown): Result<boolean, GitHubReadError> => {
          const status = errorStatus(error)
          return err({
            repository: repository.github,
            message: error instanceof Error ? error.message : 'GitHub request failed.',
            ...(status === undefined ? {} : { status }),
          })
        })
    },
    getPullRequest: async (repository, number, signal) => {
      const { owner, repo } = repositoryParts(repository.github)
      const octokit = await client(repository.github, signal)
      if (octokit._tag === 'Err')
        return octokit
      return octokit.value.rest.pulls.get({ owner, repo, pull_number: number, ...(signal === undefined ? {} : { request: { signal } }) })
        .then(response => ok(pullRequestSubject(repository, response.data)))
        .catch((error: unknown): Result<GitHubPullRequestSubject, GitHubReadError> => {
          const status = errorStatus(error)
          return err({
            repository: repository.github,
            message: error instanceof Error ? error.message : 'GitHub request failed.',
            ...(status === undefined ? {} : { status }),
          })
        })
    },
    listReviewRerunRequests: async (repository, signal) => {
      const { owner, repo } = repositoryParts(repository.github)
      const octokit = await client(repository.github, signal)
      if (octokit._tag === 'Err')
        return octokit
      return octokit.value.rest.issues.listCommentsForRepo({
        owner,
        repo,
        sort: 'updated',
        direction: 'desc',
        per_page: 100,
        ...(signal === undefined ? {} : { request: { signal } }),
      }).then(response => ok(response.data.flatMap((comment): GitHubReviewRerunRequest[] => {
        const body = comment.body ?? ''
        const author = comment.user?.login
        const pullRequestNumber = Number(comment.issue_url.split('/').at(-1))
        return author === undefined || !Number.isSafeInteger(pullRequestNumber) || !isReviewRerunCommand(body)
          ? []
          : [{ author, commentId: comment.id, pullRequestNumber, updatedAt: comment.updated_at }]
      }))).catch((error: unknown): Result<GitHubReviewRerunRequest[], GitHubReadError> => {
        const status = errorStatus(error)
        return err({
          repository: repository.github,
          message: error instanceof Error ? error.message : 'GitHub request failed.',
          ...(status === undefined ? {} : { status }),
        })
      })
    },
    listOpenSubjects: async (repository, signal) => {
      const { owner, repo } = repositoryParts(repository.github)
      const requestOptions = signal === undefined ? {} : { request: { signal } }
      const octokit = await client(repository.github, signal)
      if (octokit._tag === 'Err')
        return octokit

      const request = Promise.all([
        octokit.value.paginate(octokit.value.rest.issues.listForRepo, { owner, repo, state: 'open', per_page: 100, ...requestOptions }),
        octokit.value.paginate(octokit.value.rest.pulls.list, { owner, repo, state: 'open', per_page: 100, ...requestOptions }),
      ]).then(async ([issueRows, pullRows]) => {
        const issues: GitHubSubject[] = issueRows
          .filter(issue => issue.pull_request === undefined)
          .filter(issue => !isAutomatedGitHubActor({
            login: issue.user?.login ?? 'ghost',
            type: issue.user?.type,
          }))
          .filter(issue => isIssueAtOrAfterCutoff(issue.created_at, options.issueCutoff))
          .map(issue => ({
            kind: 'issue',
            approvalLabels: approvalLabels(issue.labels.flatMap(label => typeof label === 'string' || label.name === undefined ? [] : [label.name])),
            repository: repository.github,
            number: issue.number,
            state: issue.state === 'closed' ? 'closed' : 'open',
            title: issue.title,
            author: issue.user?.login ?? 'ghost',
            url: issue.html_url,
            createdAt: issue.created_at,
            updatedAt: issue.updated_at,
          }))

        const humanPullRows = pullRows.filter(pull => !isAutomatedGitHubActor({
          login: pull.user?.login ?? 'ghost',
          type: pull.user?.type,
        }))
        const pullRequests: GitHubSubject[] = await mapConcurrent(humanPullRows, 4, async (pull) => {
          const [detail, comments] = await Promise.all([
            octokit.value.rest.pulls.get({ owner, repo, pull_number: pull.number, ...requestOptions }).then(response => response.data),
            octokit.value.paginate(octokit.value.rest.issues.listComments, { owner, repo, issue_number: pull.number, per_page: 100, ...requestOptions }),
          ])
          return {
            ...pullRequestSubject(repository, detail),
            priorAutomatedReview: priorAutomatedReviewForHead(comments.flatMap(comment =>
              comment.body === undefined || comment.body === null || comment.user?.login === undefined
                ? []
                : [{
                    authorAssociation: comment.author_association,
                    authorLogin: comment.user.login,
                    body: comment.body,
                    url: comment.html_url,
                  }]), detail.head.sha, 'harlan-github-agent[bot]'),
          }
        })

        return [...issues, ...pullRequests]
      })

      return request
        .then((subjects): Result<GitHubSubject[], GitHubReadError> => ok(subjects))
        .catch((error: unknown): Result<GitHubSubject[], GitHubReadError> => {
          const status = errorStatus(error)
          return err({
            repository: repository.github,
            message: error instanceof Error ? error.message : 'GitHub request failed.',
            ...(status === undefined ? {} : { status }),
          })
        })
    },
  }
}

export function createGitHubPullRequestPublisher(options: GitHubPullRequestPublisherOptions): GitHubPullRequestPublisher {
  return {
    async ensurePullRequest(input, signal) {
      const { owner, repo } = repositoryParts(input.repository.github)
      const credential = await options.tokens.getToken(input.repository.github, 'pull_requests_write', signal)
      if (credential._tag === 'Err')
        return credential
      const octokit = options.createClient?.(credential.value.token)
        ?? new Octokit({ auth: credential.value.token, userAgent: options.userAgent ?? 'harlan-github-agent/0.0.0' })
      const request = signal === undefined ? {} : { request: { signal } }
      return octokit.rest.pulls.list({
        owner,
        repo,
        state: 'open',
        head: `${owner}:${input.headRef}`,
        base: input.repository.defaultBranch,
        per_page: 10,
        ...request,
      }).then(async (response): Promise<Result<PublishedPullRequest, GitHubReadError>> => {
        const existing = response.data.find(pull => pull.head.sha === input.expectedHeadSha)
        if (existing?.draft === true) {
          return err({
            repository: input.repository.github,
            message: `Pull request #${existing.number} is still draft.`,
          })
        }
        if (existing !== undefined)
          return ok({ number: existing.number, url: existing.html_url })
        return octokit.rest.pulls.create({
          owner,
          repo,
          head: input.headRef,
          base: input.repository.defaultBranch,
          title: input.title,
          body: input.body,
          draft: false,
          ...request,
        }).then(created => ok({ number: created.data.number, url: created.data.html_url }))
      }).catch((error: unknown): Result<PublishedPullRequest, GitHubReadError> => {
        const status = errorStatus(error)
        return err({
          repository: input.repository.github,
          message: error instanceof Error ? error.message : 'GitHub request failed.',
          ...(status === undefined ? {} : { status }),
        })
      })
    },
  }
}
