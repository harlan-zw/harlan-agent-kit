import type { Octokit } from 'octokit'
import type { AutoMergeMethod } from './auto-merge.ts'
import type { GitHubTokenProvider } from './github-auth.ts'
import type { Result } from './result.ts'
import type { GitHubItem, GitHubPullRequestItem, RepositoryMapping } from './types.ts'
import { approvalLabels } from './approval-labels.ts'
import { hasAutoMergeLabel } from './auto-merge.ts'
import { createAuthenticatedClient } from './github-auth.ts'
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
  hasOpenPullRequestForBranch: (repository: RepositoryMapping, headRef: string, signal?: AbortSignal) => Promise<Result<boolean, GitHubReadError>>
  getPullRequest: (repository: RepositoryMapping, number: number, signal?: AbortSignal) => Promise<Result<GitHubPullRequestItem, GitHubReadError>>
  listOpenItems: (repository: RepositoryMapping, signal?: AbortSignal) => Promise<Result<GitHubItem[], GitHubReadError>>
  listReviewRerunRequests: (repository: RepositoryMapping, signal?: AbortSignal) => Promise<Result<GitHubReviewRerunRequest[], GitHubReadError>>
}

export interface GitHubSourceOptions {
  tokens: GitHubTokenProvider
  issueCutoff: string
  /** The login the controller posts as, which depends on how the repository authenticates. */
  actorLogin: (repository: RepositoryMapping) => string
  userAgent?: string
}

export interface PublishedPullRequest {
  number: number
  url: string
}

export interface GitHubPullRequestPublisher {
  ensurePullRequest: (input: {
    repository: RepositoryMapping
    /** The branch the pull request merges into. A stack names another pull request's head branch. */
    baseRef: string
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

export function isAutomatedGitHubActor(
  actor: { login: string, type?: string | undefined },
  allowedPullRequestAuthors: readonly string[] = [],
): boolean {
  const login = actor.login.toLowerCase()
  if (allowedPullRequestAuthors.some(author => author.toLowerCase() === login))
    return false
  return actor.type === 'Bot' || login.includes('bot') || login.startsWith('app/')
}

export function isIssueAtOrAfterCutoff(createdAt: string, cutoff: string): boolean {
  return Date.parse(createdAt) >= Date.parse(`${cutoff}T00:00:00.000Z`)
}

function labelNames(labels: Array<string | { name?: string }>): string[] {
  return labels.flatMap(label => typeof label === 'string' ? [label] : label.name === undefined ? [] : [label.name])
}

function pullRequestItem(repository: RepositoryMapping, pull: Awaited<ReturnType<Octokit['rest']['pulls']['get']>>['data']): GitHubPullRequestItem {
  const labels = labelNames(pull.labels)
  return {
    kind: 'pull_request',
    approvalLabels: approvalLabels(labels),
    autoMerge: hasAutoMergeLabel(labels),
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
    baseRef: pull.base.ref,
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
    return ok(createAuthenticatedClient({
      access: 'read',
      repository,
      signal,
      token: token.value.token,
      tokens: options.tokens,
      userAgent: options.userAgent ?? 'harlan-github-agent/0.0.0',
    }))
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
    hasOpenPullRequestForBranch: async (repository, headRef, signal) => {
      const { owner, repo } = repositoryParts(repository.github)
      const octokit = await client(repository.github, signal)
      if (octokit._tag === 'Err')
        return octokit
      return octokit.value.rest.pulls.list({
        owner,
        repo,
        state: 'open',
        head: `${owner}:${headRef}`,
        per_page: 1,
        ...(signal === undefined ? {} : { request: { signal } }),
      })
        .then(response => ok(response.data.length > 0))
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
        .then(response => ok(pullRequestItem(repository, response.data)))
        .catch((error: unknown): Result<GitHubPullRequestItem, GitHubReadError> => {
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
    listOpenItems: async (repository, signal) => {
      const { owner, repo } = repositoryParts(repository.github)
      const requestOptions = signal === undefined ? {} : { request: { signal } }
      const octokit = await client(repository.github, signal)
      if (octokit._tag === 'Err')
        return octokit

      const request = Promise.all([
        octokit.value.paginate(octokit.value.rest.issues.listForRepo, { owner, repo, state: 'open', per_page: 100, ...requestOptions }),
        octokit.value.paginate(octokit.value.rest.pulls.list, { owner, repo, state: 'open', per_page: 100, ...requestOptions }),
      ]).then(async ([issueRows, pullRows]) => {
        const issues: GitHubItem[] = issueRows
          .filter(issue => issue.pull_request === undefined)
          .filter(issue => !isAutomatedGitHubActor({
            login: issue.user?.login ?? 'ghost',
            type: issue.user?.type,
          }))
          .filter(issue => isIssueAtOrAfterCutoff(issue.created_at, options.issueCutoff))
          .map(issue => ({
            kind: 'issue',
            approvalLabels: approvalLabels(labelNames(issue.labels)),
            repository: repository.github,
            number: issue.number,
            state: issue.state === 'closed' ? 'closed' : 'open',
            title: issue.title,
            author: issue.user?.login ?? 'ghost',
            url: issue.html_url,
            createdAt: issue.created_at,
            updatedAt: issue.updated_at,
          }))

        const eligiblePullRows = pullRows.filter(pull => !isAutomatedGitHubActor({
          login: pull.user?.login ?? 'ghost',
          type: pull.user?.type,
        }, repository.writablePullRequestAuthors))
        const pullRequests: GitHubItem[] = await mapConcurrent(eligiblePullRows, 4, async (pull) => {
          const [detail, comments] = await Promise.all([
            octokit.value.rest.pulls.get({ owner, repo, pull_number: pull.number, ...requestOptions }).then(response => response.data),
            octokit.value.paginate(octokit.value.rest.issues.listComments, { owner, repo, issue_number: pull.number, per_page: 100, ...requestOptions }),
          ])
          return {
            ...pullRequestItem(repository, detail),
            priorAutomatedReview: priorAutomatedReviewForHead(comments.flatMap(comment =>
              comment.body === undefined || comment.body === null || comment.user?.login === undefined
                ? []
                : [{
                    authorAssociation: comment.author_association,
                    authorLogin: comment.user.login,
                    body: comment.body,
                    url: comment.html_url,
                  }]), detail.head.sha, options.actorLogin(repository)),
          }
        })

        return [...issues, ...pullRequests]
      })

      return request
        .then((subjects): Result<GitHubItem[], GitHubReadError> => ok(subjects))
        .catch((error: unknown): Result<GitHubItem[], GitHubReadError> => {
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
        ?? createAuthenticatedClient({
          access: 'pull_requests_write',
          repository: input.repository.github,
          signal,
          token: credential.value.token,
          tokens: options.tokens,
          userAgent: options.userAgent ?? 'harlan-github-agent/0.0.0',
        })
      const request = signal === undefined ? {} : { request: { signal } }
      return octokit.rest.pulls.list({
        owner,
        repo,
        state: 'open',
        head: `${owner}:${input.headRef}`,
        base: input.baseRef,
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
          base: input.baseRef,
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

/**
 * How one pull request reached its merge.
 *
 * `AutoMergeEnabled` means GitHub owns the merge from here and will perform it
 * when its own branch protection is satisfied. `Merged` means GitHub had
 * nothing left to wait for, so the merge happened in this call.
 */
export type MergeHandoff
  = | { _tag: 'AutoMergeEnabled' }
    | { _tag: 'Merged', sha: string }

export interface GitHubPullRequestMerger {
  merge: (input: {
    repository: RepositoryMapping
    number: number
    expectedHeadSha: string
    method: AutoMergeMethod
  }, signal?: AbortSignal) => Promise<Result<MergeHandoff, GitHubReadError>>
}

/**
 * GitHub refuses to enable auto-merge on a pull request that has nothing left
 * to wait for. The message differs by API version, so match on the shape of the
 * complaint rather than one exact sentence.
 */
function refusedBecauseNothingToWaitFor(message: string): boolean {
  return /\bclean status\b/i.test(message)
    || /\bnot in the correct state\b/i.test(message)
    || /\bcannot be enabled\b/i.test(message)
}

function graphqlMergeMethod(method: AutoMergeMethod): 'MERGE' | 'REBASE' | 'SQUASH' {
  return method === 'rebase' ? 'REBASE' : method === 'squash' ? 'SQUASH' : 'MERGE'
}

const enableAutoMergeMutation = `
  mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!, $expectedHeadOid: GitObjectID!) {
    enablePullRequestAutoMerge(input: {
      pullRequestId: $pullRequestId,
      mergeMethod: $mergeMethod,
      expectedHeadOid: $expectedHeadOid
    }) {
      pullRequest { number }
    }
  }
`

export function createGitHubPullRequestMerger(options: GitHubPullRequestPublisherOptions): GitHubPullRequestMerger {
  return {
    async merge(input, signal) {
      const { owner, repo } = repositoryParts(input.repository.github)
      const credential = await options.tokens.getToken(input.repository.github, 'pull_requests_write', signal)
      if (credential._tag === 'Err')
        return credential
      const octokit = options.createClient?.(credential.value.token)
        ?? createAuthenticatedClient({
          access: 'pull_requests_write',
          repository: input.repository.github,
          signal,
          token: credential.value.token,
          tokens: options.tokens,
          userAgent: options.userAgent ?? 'harlan-github-agent/0.0.0',
        })
      const request = signal === undefined ? {} : { request: { signal } }
      const failure = (error: unknown): Result<never, GitHubReadError> => {
        const status = errorStatus(error)
        return err({
          repository: input.repository.github,
          message: error instanceof Error ? error.message : 'GitHub request failed.',
          ...(status === undefined ? {} : { status }),
        })
      }

      /**
       * Merges in this call, pinned to the reviewed head SHA.
       *
       * Only reached when GitHub says auto-merge has nothing to wait for, which
       * means the pull request already satisfies every requirement GitHub knows
       * about. GitHub rejects the call when `sha` is not the current head, so a
       * head that moved after the review can still never be merged here.
       */
      const mergeNow = (): Promise<Result<MergeHandoff, GitHubReadError>> => octokit.rest.pulls.merge({
        owner,
        repo,
        pull_number: input.number,
        sha: input.expectedHeadSha,
        merge_method: input.method,
        ...request,
      })
        .then((response): Result<MergeHandoff, GitHubReadError> => response.data.merged
          ? ok({ _tag: 'Merged', sha: response.data.sha })
          : err({ repository: input.repository.github, message: response.data.message }))
        .catch(failure)

      const pullRequest = await octokit.rest.pulls.get({ owner, repo, pull_number: input.number, ...request })
        .then(response => ok(response.data))
        .catch(failure)
      if (pullRequest._tag === 'Err')
        return pullRequest
      if (pullRequest.value.head.sha !== input.expectedHeadSha) {
        return err({
          repository: input.repository.github,
          message: 'The head commit moved before the merge was handed to GitHub.',
        })
      }

      // GitHub owns the merge decision from here. `expectedHeadOid` makes GitHub
      // cancel its own auto-merge when a new commit lands, so a review can never
      // merge a commit it did not read.
      return octokit.graphql(enableAutoMergeMutation, {
        pullRequestId: pullRequest.value.node_id,
        mergeMethod: graphqlMergeMethod(input.method),
        expectedHeadOid: input.expectedHeadSha,
        ...request,
      })
        .then((): Result<MergeHandoff, GitHubReadError> => ok({ _tag: 'AutoMergeEnabled' }))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'GitHub request failed.'
          return refusedBecauseNothingToWaitFor(message) ? mergeNow() : failure(error)
        })
    },
  }
}
