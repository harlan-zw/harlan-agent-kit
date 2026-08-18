import type { Octokit } from 'octokit'
import type { GitHubTokenProvider } from './github-auth.ts'
import type { Result } from './result.ts'
import type { PriorAutomatedReview } from './review-comment.ts'
import type { GitHubPullRequestItem, RepositoryMapping } from './types.ts'
import { hasAutoMergeLabel } from './auto-merge.ts'
import { createAuthenticatedClient } from './github-auth.ts'
import { AUTOMATED_ISSUE_TRIAGE_MARKER } from './issue-triage-comment.ts'
import { err, ok } from './result.ts'
import { AUTOMATED_REVIEW_MARKER, automatedReviewHead, priorAutomatedReviewForHead } from './review-comment.ts'

export interface GitHubCheck {
  conclusion: string | null
  id: number
  name: string
  source: { _tag: 'CheckRun', appId: number | null } | { _tag: 'CommitStatus' }
  status: string
}

function checkContext(check: GitHubCheck): string {
  return check.source._tag === 'CheckRun'
    ? `check:${check.source.appId ?? 'any'}:${check.name}`
    : `status:${check.name}`
}

export function currentGitHubChecks(checks: GitHubCheck[]): GitHubCheck[] {
  const current = new Map<string, GitHubCheck>()
  for (const check of checks) {
    const context = checkContext(check)
    const previous = current.get(context)
    if (previous === undefined || check.id > previous.id)
      current.set(context, check)
  }
  return [...current.values()]
}

export type GitHubChecksSnapshot
  = | { _tag: 'Available', checks: GitHubCheck[] }
    | { _tag: 'Unavailable', reason: string }

export interface PullRequestReviewSnapshot {
  baseChecks: GitHubChecksSnapshot
  body: string
  checks: GitHubChecksSnapshot
  comments: string[]
  priorAutomatedReview: PriorAutomatedReview
  pullRequest: GitHubPullRequestItem
  reviews: string[]
}

export interface IssueTriageSnapshot {
  body: string
  comments: string[]
  state: 'open' | 'closed'
  title: string
  updatedAt: string
}

export type PullRequestTemplate
  = | { _tag: 'Found', body: string }
    | { _tag: 'Missing' }

export interface PublishedReviewStatus {
  commentId: number
  url: string
}

export interface GitHubAgentSource {
  consumeApprovalLabel: (repository: RepositoryMapping, subjectKind: 'issue' | 'pull_request', itemNumber: number, label: string, signal: AbortSignal) => Promise<Result<void, string>>
  ensureApprovalLabel: (repository: RepositoryMapping, label: string, signal: AbortSignal) => Promise<Result<void, string>>
  getIssueTriageSnapshot: (repository: RepositoryMapping, issueNumber: number, signal: AbortSignal) => Promise<Result<IssueTriageSnapshot, string>>
  getPullRequestTemplate: (repository: RepositoryMapping, signal: AbortSignal) => Promise<Result<PullRequestTemplate, string>>
  getPullRequestReviewSnapshot: (repository: RepositoryMapping, pullRequestNumber: number, signal: AbortSignal) => Promise<Result<PullRequestReviewSnapshot, string>>
  upsertIssueTriageComment: (repository: RepositoryMapping, issueNumber: number, commentId: number | null, body: string, signal: AbortSignal) => Promise<Result<PublishedReviewStatus, string>>
  upsertReviewStatus: (repository: RepositoryMapping, pullRequestNumber: number, commentId: number | null, body: string, replacePriorReview: boolean, signal: AbortSignal) => Promise<Result<PublishedReviewStatus, string>>
}

export interface GitHubAgentSourceOptions {
  /** The login the controller posts as, which depends on how the repository authenticates. */
  actorLogin: (repository: RepositoryMapping) => string
  tokens: GitHubTokenProvider
  userAgent?: string
}

function repositoryParts(repository: string): { owner: string, repo: string } {
  const [owner, repo] = repository.split('/')
  if (owner === undefined || repo === undefined)
    throw new Error(`Invalid repository mapping: ${repository}.`)
  return { owner, repo }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'GitHub request failed.'
}

function errorStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
    ? error.status
    : undefined
}

function pullRequestItem(repository: RepositoryMapping, pull: Awaited<ReturnType<Octokit['rest']['pulls']['get']>>['data']): GitHubPullRequestItem {
  return {
    kind: 'pull_request',
    approvalLabels: [],
    autoMerge: hasAutoMergeLabel(pull.labels.flatMap(label => label.name === undefined ? [] : [label.name])),
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
    mergeState: pull.mergeable === false ? 'conflicting' : pull.mergeable === true ? 'clean' : 'unknown',
    priorAutomatedReview: { _tag: 'None' },
  }
}

export function createGitHubAgentSource(options: GitHubAgentSourceOptions): GitHubAgentSource {
  const client = async (repository: string, access: 'read' | 'checks_read' | 'issues_write' | 'pull_requests_write', signal: AbortSignal): Promise<Result<Octokit, string>> => {
    const token = await options.tokens.getToken(repository, access, signal)
    return token._tag === 'Err'
      ? err(token.error.message)
      : ok(createAuthenticatedClient({
          access,
          repository,
          signal,
          token: token.value.token,
          tokens: options.tokens,
          userAgent: options.userAgent ?? 'harlan-github-agent/0.0.0',
        }))
  }

  return {
    async consumeApprovalLabel(repository, subjectKind, itemNumber, label, signal) {
      const access = subjectKind === 'issue' ? 'issues_write' : 'pull_requests_write'
      const octokit = await client(repository.github, access, signal)
      if (octokit._tag === 'Err')
        return octokit
      const { owner, repo } = repositoryParts(repository.github)
      const request = { owner, repo, issue_number: itemNumber, request: { signal } }
      const removed = await octokit.value.rest.issues.removeLabel({ ...request, name: label })
        .then((): Result<void, string> => ok(undefined))
        .catch((error: unknown): Result<void, string> => err(message(error)))
      const current = await octokit.value.rest.issues.get(request)
        .then(response => ok(response.data.labels.flatMap(value => typeof value === 'string' ? [value] : value.name === undefined ? [] : [value.name])))
        .catch((error: unknown): Result<string[], string> => err(message(error)))
      if (current._tag === 'Err')
        return current
      if (current.value.some(value => value.toLowerCase() === label.toLowerCase()))
        return removed._tag === 'Err' ? removed : err(`GitHub did not remove the ${label} label.`)
      return ok(undefined)
    },

    async ensureApprovalLabel(repository, label, signal) {
      const octokit = await client(repository.github, 'pull_requests_write', signal)
      if (octokit._tag === 'Err')
        return octokit
      const { owner, repo } = repositoryParts(repository.github)
      const requestOptions = { request: { signal } }
      const existing = await octokit.value.rest.issues.getLabel({ owner, repo, name: label, ...requestOptions })
        .then((): Result<void, string> => ok(undefined))
        .catch((error: unknown): Result<void, string> => errorStatus(error) === 404 ? err('missing') : err(message(error)))
      if (existing._tag === 'Ok')
        return existing
      if (existing.error !== 'missing')
        return existing
      return octokit.value.rest.issues.createLabel({
        owner,
        repo,
        name: label,
        color: '8250df',
        description: 'Approve automated work for the current issue state or pull request head commit.',
        ...requestOptions,
      }).then(() => ok(undefined)).catch(async (error: unknown): Promise<Result<void, string>> => {
        if (errorStatus(error) !== 422)
          return err(message(error))
        return octokit.value.rest.issues.getLabel({ owner, repo, name: label, ...requestOptions })
          .then(() => ok(undefined))
          .catch((confirmationError: unknown): Result<void, string> => err(message(confirmationError)))
      })
    },

    async getIssueTriageSnapshot(repository, issueNumber, signal) {
      const octokit = await client(repository.github, 'read', signal)
      if (octokit._tag === 'Err')
        return octokit
      const { owner, repo } = repositoryParts(repository.github)
      return Promise.all([
        octokit.value.rest.issues.get({ owner, repo, issue_number: issueNumber, request: { signal } }),
        octokit.value.paginate(octokit.value.rest.issues.listComments, { owner, repo, issue_number: issueNumber, per_page: 100, request: { signal } }),
      ]).then(([issue, comments]) => ok({
        body: issue.data.body ?? '',
        comments: comments.flatMap(comment => comment.body === undefined || comment.body === null
          || (comment.user?.login.toLowerCase() === options.actorLogin(repository).toLowerCase() && comment.body.includes(AUTOMATED_ISSUE_TRIAGE_MARKER))
          ? []
          : [comment.body]),
        state: issue.data.state === 'closed' ? 'closed' as const : 'open' as const,
        title: issue.data.title,
        updatedAt: issue.data.updated_at,
      })).catch((error: unknown) => err(message(error)))
    },

    async getPullRequestTemplate(repository, signal) {
      const octokit = await client(repository.github, 'read', signal)
      if (octokit._tag === 'Err')
        return octokit
      const { owner, repo } = repositoryParts(repository.github)
      const profile = await octokit.value.rest.repos.getCommunityProfileMetrics({ owner, repo, request: { signal } })
        .then(response => ok(response.data.files?.pull_request_template?.url ?? null))
        .catch((error: unknown): Result<string | null, string> => err(message(error)))
      if (profile._tag === 'Err')
        return profile
      if (profile.value === null)
        return ok({ _tag: 'Missing' })
      return octokit.value.request({
        method: 'GET',
        url: profile.value,
        headers: { accept: 'application/vnd.github.raw+json' },
        request: { signal },
      }).then((response): Result<PullRequestTemplate, string> => typeof response.data === 'string'
        ? ok({ _tag: 'Found', body: response.data })
        : err('GitHub returned an invalid pull request template.')).catch((error: unknown): Result<PullRequestTemplate, string> => err(message(error)))
    },

    async upsertIssueTriageComment(repository, issueNumber, commentId, body, signal) {
      if (!body.includes(AUTOMATED_ISSUE_TRIAGE_MARKER))
        return err('The automated issue triage comment is missing its marker.')
      const octokit = await client(repository.github, 'issues_write', signal)
      if (octokit._tag === 'Err')
        return octokit
      const { owner, repo } = repositoryParts(repository.github)
      const requestOptions = { request: { signal } }
      return octokit.value.paginate(octokit.value.rest.issues.listComments, {
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100,
        ...requestOptions,
      }).then(async (comments) => {
        const existing = commentId === null
          ? comments
            .filter(comment => comment.user?.login.toLowerCase() === options.actorLogin(repository).toLowerCase() && comment.body?.includes(AUTOMATED_ISSUE_TRIAGE_MARKER))
            .sort((left, right) => right.id - left.id)[0]
          : comments.find(comment => comment.id === commentId)
        if (existing !== undefined && existing.user?.login.toLowerCase() !== options.actorLogin(repository).toLowerCase())
          return err('The stored issue triage comment belongs to another GitHub actor.')
        if (existing !== undefined && existing.body === body && existing.html_url !== undefined)
          return ok({ commentId: existing.id, url: existing.html_url })
        const written = existing === undefined
          ? await octokit.value.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body, ...requestOptions })
          : await octokit.value.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body, ...requestOptions })
        const confirmed = await octokit.value.rest.issues.getComment({ owner, repo, comment_id: written.data.id, ...requestOptions })
        if (
          confirmed.data.user?.login.toLowerCase() !== options.actorLogin(repository).toLowerCase()
          || confirmed.data.body !== body
          || !confirmed.data.body.includes(AUTOMATED_ISSUE_TRIAGE_MARKER)
        ) {
          return err('GitHub did not confirm the marked issue triage comment.')
        }
        return ok({ commentId: confirmed.data.id, url: confirmed.data.html_url })
      }).catch((error: unknown) => err(message(error)))
    },

    async getPullRequestReviewSnapshot(repository, pullRequestNumber, signal) {
      const octokit = await client(repository.github, 'read', signal)
      if (octokit._tag === 'Err')
        return octokit
      const { owner, repo } = repositoryParts(repository.github)
      const request = { owner, repo, pull_number: pullRequestNumber, request: { signal } }
      return Promise.all([
        octokit.value.rest.pulls.get(request),
        octokit.value.paginate(octokit.value.rest.issues.listComments, { owner, repo, issue_number: pullRequestNumber, per_page: 100, request: { signal } }),
        octokit.value.paginate(octokit.value.rest.pulls.listReviews, { ...request, per_page: 100 }),
        octokit.value.paginate(octokit.value.rest.pulls.listReviewComments, { ...request, per_page: 100 }),
      ]).then(async ([pull, issueComments, reviews, reviewComments]) => {
        const checksClient = await client(repository.github, 'checks_read', signal)
        const checksFor = (ref: string): Promise<GitHubChecksSnapshot> => checksClient._tag === 'Err'
          ? Promise.resolve({ _tag: 'Unavailable', reason: checksClient.error })
          : Promise.all([
              checksClient.value.paginate(checksClient.value.rest.checks.listForRef, { owner, repo, ref, per_page: 100, request: { signal } }),
              checksClient.value.rest.repos.getCombinedStatusForRef({ owner, repo, ref, per_page: 100, request: { signal } }),
            ]).then(([runs, statuses]): GitHubChecksSnapshot => ({
              _tag: 'Available',
              checks: currentGitHubChecks([
                ...runs.map(check => ({
                  id: check.id,
                  source: { _tag: 'CheckRun' as const, appId: check.app?.id ?? null },
                  name: check.name,
                  status: check.status,
                  conclusion: check.conclusion,
                })),
                ...statuses.data.statuses.map(status => ({
                  id: status.id,
                  source: { _tag: 'CommitStatus' as const },
                  name: status.context,
                  status: status.state === 'pending' ? 'in_progress' : 'completed',
                  conclusion: status.state,
                })),
              ]),
            })).catch((error: unknown): GitHubChecksSnapshot => ({ _tag: 'Unavailable', reason: message(error) }))
        const [checks, baseChecks] = await Promise.all([checksFor(pull.data.head.sha), checksFor(pull.data.base.sha)])
        return ok({
          baseChecks,
          body: pull.data.body ?? '',
          checks,
          comments: [
            ...issueComments.flatMap(comment => comment.body === undefined || comment.body === null
              || (comment.user?.login.toLowerCase() === options.actorLogin(repository).toLowerCase() && comment.body.includes(AUTOMATED_REVIEW_MARKER))
              ? []
              : [comment.body]),
            ...reviewComments.flatMap(comment => comment.body === undefined
              || (comment.user?.login.toLowerCase() === options.actorLogin(repository).toLowerCase() && comment.body.includes(AUTOMATED_REVIEW_MARKER))
              ? []
              : [comment.body]),
          ],
          priorAutomatedReview: priorAutomatedReviewForHead(issueComments.flatMap(comment =>
            comment.body === undefined || comment.body === null || comment.user?.login === undefined
              ? []
              : [{
                  authorAssociation: comment.author_association,
                  authorLogin: comment.user.login,
                  body: comment.body,
                  url: comment.html_url,
                }]), pull.data.head.sha, options.actorLogin(repository)),
          pullRequest: pullRequestItem(repository, pull.data),
          reviews: reviews.flatMap(review => review.body === undefined || review.body === null ? [] : [review.body]),
        })
      }).catch((error: unknown) => err(message(error)))
    },

    async upsertReviewStatus(repository, pullRequestNumber, commentId, body, replacePriorReview, signal) {
      const octokit = await client(repository.github, 'pull_requests_write', signal)
      if (octokit._tag === 'Err')
        return octokit
      const { owner, repo } = repositoryParts(repository.github)
      const requestOptions = { request: { signal } }
      return octokit.value.paginate(octokit.value.rest.issues.listComments, {
        owner,
        repo,
        issue_number: pullRequestNumber,
        per_page: 100,
        ...requestOptions,
      }).then(async (comments) => {
        const headSha = automatedReviewHead(body)
        if (headSha === undefined)
          return err('The automated review comment is missing its head commit marker.')
        const priorReview = priorAutomatedReviewForHead(comments.flatMap(comment =>
          comment.body === undefined || comment.body === null || comment.user?.login === undefined
            ? []
            : [{
                authorAssociation: comment.author_association,
                authorLogin: comment.user.login,
                body: comment.body,
                url: comment.html_url,
              }]), headSha, options.actorLogin(repository))
        if (priorReview._tag === 'Found' && !replacePriorReview)
          return err(`The current head commit already has an automated review by @${priorReview.authorLogin}: ${priorReview.url}`)
        const existing = commentId === null
          ? comments
            .filter(comment => comment.user?.login.toLowerCase() === options.actorLogin(repository).toLowerCase() && comment.body?.includes(AUTOMATED_REVIEW_MARKER))
            .sort((left, right) => right.id - left.id)[0]
          : comments.find(comment => comment.id === commentId)
        if (existing !== undefined && existing.user?.login.toLowerCase() !== options.actorLogin(repository).toLowerCase())
          return err('The stored automated review comment belongs to another GitHub actor.')
        if (existing !== undefined && existing.body === body && existing.html_url !== undefined)
          return ok({ commentId: existing.id, url: existing.html_url })
        const written = existing === undefined
          ? await octokit.value.rest.issues.createComment({ owner, repo, issue_number: pullRequestNumber, body, ...requestOptions })
          : await octokit.value.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body, ...requestOptions })
        const confirmed = await octokit.value.rest.issues.getComment({ owner, repo, comment_id: written.data.id, ...requestOptions })
        if (
          confirmed.data.user?.login.toLowerCase() !== options.actorLogin(repository).toLowerCase()
          || confirmed.data.body !== body
          || !confirmed.data.body.includes(AUTOMATED_REVIEW_MARKER)
        ) {
          return err('GitHub did not confirm the marked automated review comment.')
        }
        return ok({ commentId: confirmed.data.id, url: confirmed.data.html_url })
      }).catch((error: unknown) => err(message(error)))
    },
  }
}
