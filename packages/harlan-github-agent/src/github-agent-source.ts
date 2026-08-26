import type { Octokit } from 'octokit'
import type { GitHubTokenProvider } from './github-auth.ts'
import type { Result } from './result.ts'
import type { PriorAutomatedReview } from './review-comment.ts'
import type { GitHubPullRequestItem, GitHubRepositoryAccess, RepositoryMapping } from './types.ts'
import { hasAutoMergeLabel } from './auto-merge.ts'
import { createAuthenticatedClient } from './github-auth.ts'
import { AUTOMATED_ISSUE_TRIAGE_MARKER } from './issue-triage-comment.ts'
import { err, ok } from './result.ts'
import { AUTOMATED_REVIEW_MARKER, automatedReviewHead, priorAutomatedReviewForHead } from './review-comment.ts'

/**
 * What the job steps say about a check run GitHub reports as failed.
 *
 * A self-hosted runner that restarts kills its container mid-job. GitHub then
 * reports the job as `failure`, no step reports failure, and every step after
 * the kill keeps a null conclusion. That shape is `RunnerLost`.
 *
 * The controller resolves this only for a failing GitHub Actions check run.
 * Every other check keeps `NotAsked`. `NotAsked` and `Unknown` both keep the
 * check failing, so a lookup the controller skipped or could not finish never
 * reads as a lost runner.
 */
export type CheckFailureEvidence
  = | { _tag: 'NotAsked' }
    | { _tag: 'Unknown', reason: string }
    | { _tag: 'StepFailed' }
    | { _tag: 'RunnerLost', incompleteSteps: number }

export interface GitHubCheck {
  conclusion: string | null
  /** What the job steps say, for a check run GitHub reports as failed. */
  failure: CheckFailureEvidence
  id: number
  name: string
  source: { _tag: 'CheckRun', appId: number | null } | { _tag: 'CommitStatus' }
  status: string
}

/** One GitHub Actions job step, reduced to the field that decides the class. */
export interface GitHubJobStep {
  conclusion: string | null
}

/**
 * Reads one failing GitHub Actions job as a real failure or a lost runner.
 *
 * A killed container leaves no failed step, because the kill lands between
 * steps. It leaves incomplete steps, because GitHub never gets their result.
 *
 * A container killed during a step is a different shape. That step reports
 * failure, and from here it is identical to a genuine failure. So one failed
 * step always means a genuine failure. Do not relax this rule: an OOM kill
 * inside a step was verified to look exactly like a broken build.
 *
 * A job with no failed step and no incomplete step is neither shape, so it
 * stays `Unknown` and keeps failing.
 */
export function classifyFailedJob(steps: GitHubJobStep[]): CheckFailureEvidence {
  if (steps.some(step => step.conclusion === 'failure'))
    return { _tag: 'StepFailed' }
  const incompleteSteps = steps.filter(step => step.conclusion === null).length
  return incompleteSteps === 0
    ? { _tag: 'Unknown', reason: 'The job reports no failed step and no incomplete step.' }
    : { _tag: 'RunnerLost', incompleteSteps }
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

export function chronologicalPullRequestComments(entries: Array<{ body: string, createdAt: string }>): string[] {
  return [...entries]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map(entry => entry.body)
}

export type GitHubChecksSnapshot
  = | { _tag: 'Available', checks: GitHubCheck[] }
    | { _tag: 'Unavailable', reason: string }

/**
 * Which checks GitHub requires before it allows a merge into the base branch.
 *
 * `Declared` means a ruleset names the required checks. `None` means GitHub
 * answered and named none, so GitHub allows a merge whatever the checks say.
 * `Unavailable` means the request failed, so the answer is unknown.
 *
 * Classic branch protection needs admin access to read, so a repository that
 * uses it reports `None` here. `None` and `Unavailable` both keep the strict
 * CI Review gate, so an unreadable requirement never relaxes a review.
 */
export type RequiredChecks
  = | { _tag: 'Declared', contexts: string[] }
    | { _tag: 'None' }
    | { _tag: 'Unavailable', reason: string }

export interface PullRequestReviewSnapshot {
  baseChecks: GitHubChecksSnapshot
  body: string
  checks: GitHubChecksSnapshot
  comments: string[]
  priorAutomatedReview: PriorAutomatedReview
  pullRequest: GitHubPullRequestItem
  requiredChecks: RequiredChecks
  reviews: string[]
}

/**
 * Reads the required check contexts out of one branch rules response.
 *
 * The rules endpoint returns a wide union, so the contexts are parsed once
 * here and trusted as `string[]` from then on.
 */
export function requiredCheckContexts(rules: unknown): string[] {
  if (!Array.isArray(rules))
    return []
  const contexts = rules.flatMap((rule): string[] => {
    const parameters = (rule as { parameters?: { required_status_checks?: unknown } }).parameters
    if ((rule as { type?: unknown }).type !== 'required_status_checks' || !Array.isArray(parameters?.required_status_checks))
      return []
    return parameters.required_status_checks.flatMap((entry: unknown) => {
      const context = (entry as { context?: unknown }).context
      return typeof context === 'string' && context.length > 0 ? [context] : []
    })
  })
  return [...new Set(contexts)]
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

/**
 * `Missing` means a person deleted the comment, so there is nothing to correct.
 * `Changed` means somebody wrote it after the caller last read it.
 */
export type EditedReviewStatus
  = | { _tag: 'Edited', commentId: number, url: string }
    | { _tag: 'Changed' }
    | { _tag: 'Missing' }

export interface GitHubAgentSource {
  consumeApprovalLabel: (repository: RepositoryMapping, subjectKind: 'issue' | 'pull_request', itemNumber: number, label: string, signal: AbortSignal) => Promise<Result<void, string>>
  ensureApprovalLabel: (repository: RepositoryMapping, label: string, signal: AbortSignal) => Promise<Result<void, string>>
  getIssueTriageSnapshot: (repository: RepositoryMapping, issueNumber: number, signal: AbortSignal) => Promise<Result<IssueTriageSnapshot, string>>
  getPullRequestTemplate: (repository: RepositoryMapping, signal: AbortSignal) => Promise<Result<PullRequestTemplate, string>>
  getPullRequestReviewSnapshot: (repository: RepositoryMapping, pullRequestNumber: number, signal: AbortSignal) => Promise<Result<PullRequestReviewSnapshot, string>>
  /** Every file one open pull request changes, which decides whether new work stacks on it. */
  listPullRequestFiles: (repository: RepositoryMapping, pullRequestNumber: number, signal: AbortSignal) => Promise<Result<string[], string>>
  upsertIssueTriageComment: (repository: RepositoryMapping, issueNumber: number, commentId: number | null, body: string, signal: AbortSignal) => Promise<Result<PublishedReviewStatus, string>>
  /**
   * Rewrites one comment this service already posted, and only that.
   *
   * `upsertReviewStatus` opens a comment when the stored identifier is gone,
   * which is right for a review that owns its comment and wrong for a sweep
   * correcting an old one: deleting the comment would bring it straight back.
   * A missing comment is an outcome here, not a failure.
   *
   * The write is a compare and swap against `expectedBody`, but GitHub's REST
   * API applies no precondition at write time, so the swap is a client side
   * read then write. A sweep reads the Queue, then spends round trips reaching
   * this call, and an agent that claims the Task can publish its own progress
   * inside that window; this call would overwrite it without knowing. The read
   * back after the write reports `Changed` when the comment no longer holds
   * what was written, which catches a writer that landed after the edit, but
   * the window between the read and the write cannot be closed here.
   */
  editReviewStatus: (repository: RepositoryMapping, pullRequestNumber: number, commentId: number, expectedBody: string, body: string, signal: AbortSignal) => Promise<Result<EditedReviewStatus, string>>
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

function isMissingComment(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && (error as { status: unknown }).status === 404
}

/** GitHub's own app slug for Actions. Only its check run id is also a job id. */
const ACTIONS_APP_SLUG = 'github-actions'

/**
 * How many failing Actions jobs one checks read resolves.
 *
 * Each job costs one request. A runner outage turns every check red at once,
 * which is the moment the controller sits nearest its rate limit. So the read
 * is capped. A job past the cap keeps `NotAsked`, so it still reads as failed.
 */
const FAILED_JOB_LOOKUP_LIMIT = 12

/**
 * Asks GitHub what the steps of each failing job say.
 *
 * For a GitHub Actions check run, the check run id is also the job id.
 * Verified on 2026-08-19: check run 96051144474 carries a `details_url` ending
 * `/job/96051144474`. A third-party check run id is not a job id, so the caller
 * passes Actions jobs only.
 *
 * A lookup that fails returns `Unknown`, which keeps the check failing.
 */
async function resolveFailedJobs(
  octokit: Octokit,
  owner: string,
  repo: string,
  jobIds: number[],
  signal: AbortSignal,
): Promise<Map<number, CheckFailureEvidence>> {
  const resolved = await Promise.all(jobIds.slice(0, FAILED_JOB_LOOKUP_LIMIT).map(async (jobId): Promise<[number, CheckFailureEvidence]> => {
    const job = await octokit.rest.actions.getJobForWorkflowRun({ owner, repo, job_id: jobId, request: { signal } })
      .then(response => ok(response.data.steps ?? []))
      .catch((error: unknown) => err(message(error)))
    return [jobId, job._tag === 'Err' ? { _tag: 'Unknown', reason: job.error } : classifyFailedJob(job.value)]
  }))
  return new Map(resolved)
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
  const client = async (repository: string, access: GitHubRepositoryAccess, signal: AbortSignal): Promise<Result<Octokit, string>> => {
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
    async listPullRequestFiles(repository, pullRequestNumber, signal) {
      const octokit = await client(repository.github, 'read', signal)
      if (octokit._tag === 'Err')
        return octokit
      const { owner, repo } = repositoryParts(repository.github)
      return octokit.value.paginate(octokit.value.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: pullRequestNumber,
        per_page: 100,
        request: { signal },
      })
        .then(files => ok(files.map(file => file.filename)))
        .catch((error: unknown): Result<string[], string> => err(message(error)))
    },

    async consumeApprovalLabel(repository, _subjectKind, itemNumber, label, signal) {
      const octokit = await client(repository.github, 'item_write', signal)
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
      const octokit = await client(repository.github, 'item_write', signal)
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
      const octokit = await client(repository.github, 'item_write', signal)
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
            ]).then(async ([runs, statuses]): Promise<GitHubChecksSnapshot> => {
              const current = currentGitHubChecks([
                ...runs.map(check => ({
                  id: check.id,
                  failure: { _tag: 'NotAsked' as const },
                  source: { _tag: 'CheckRun' as const, appId: check.app?.id ?? null },
                  name: check.name,
                  status: check.status,
                  conclusion: check.conclusion,
                })),
                ...statuses.data.statuses.map(status => ({
                  id: status.id,
                  failure: { _tag: 'NotAsked' as const },
                  source: { _tag: 'CommitStatus' as const },
                  name: status.context,
                  status: status.state === 'pending' ? 'in_progress' : 'completed',
                  conclusion: status.state,
                })),
              ])
              // Only a failing Actions check run can have lost its runner, and
              // only the `failure` conclusion can. GitHub reports a job a person
              // cancelled as `cancelled` with no failed step, which is the same
              // step shape for a different reason. Reading that one here would
              // report every cancelled job as a lost runner.
              const currentCheckRunIds = new Set(current.flatMap(check => check.source._tag === 'CheckRun' ? [check.id] : []))
              const failedActionsJobs = runs.flatMap(check => check.conclusion === 'failure'
                && check.app?.slug === ACTIONS_APP_SLUG
                && currentCheckRunIds.has(check.id)
                ? [check.id]
                : [])
              const evidence = await resolveFailedJobs(checksClient.value, owner, repo, failedActionsJobs, signal)
              // A commit status id and a check run id come from different
              // sequences, so the evidence is keyed back onto check runs only.
              return { _tag: 'Available', checks: current.map(check => check.source._tag === 'CheckRun'
                ? { ...check, failure: evidence.get(check.id) ?? check.failure }
                : check) }
            }).catch((error: unknown): GitHubChecksSnapshot => ({ _tag: 'Unavailable', reason: message(error) }))
        const requiredChecksFor = (branch: string): Promise<RequiredChecks> => octokit.value.rest.repos
          .getBranchRules({ owner, repo, branch, per_page: 100, request: { signal } })
          .then((rules): RequiredChecks => {
            const contexts = requiredCheckContexts(rules.data)
            return contexts.length === 0 ? { _tag: 'None' } : { _tag: 'Declared', contexts }
          })
          .catch((error: unknown): RequiredChecks => ({ _tag: 'Unavailable', reason: message(error) }))
        const [checks, baseChecks, requiredChecks] = await Promise.all([
          checksFor(pull.data.head.sha),
          checksFor(pull.data.base.sha),
          requiredChecksFor(pull.data.base.ref),
        ])
        return ok({
          baseChecks,
          body: pull.data.body ?? '',
          checks,
          comments: chronologicalPullRequestComments([
            ...issueComments.flatMap(comment => comment.body === undefined || comment.body === null
              || (comment.user?.login.toLowerCase() === options.actorLogin(repository).toLowerCase() && comment.body.includes(AUTOMATED_REVIEW_MARKER))
              ? []
              : [{ body: comment.body, createdAt: comment.created_at }]),
            ...reviewComments.flatMap(comment => comment.body === undefined
              || (comment.user?.login.toLowerCase() === options.actorLogin(repository).toLowerCase() && comment.body.includes(AUTOMATED_REVIEW_MARKER))
              ? []
              : [{ body: comment.body, createdAt: comment.created_at }]),
          ]),
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
          requiredChecks,
          reviews: chronologicalPullRequestComments(reviews.flatMap(review => review.body === undefined || review.body === null
            ? []
            : [{ body: review.body, createdAt: review.submitted_at ?? '' }])),
        })
      }).catch((error: unknown) => err(message(error)))
    },

    async editReviewStatus(repository, pullRequestNumber, commentId, expectedBody, body, signal) {
      const octokit = await client(repository.github, 'item_write', signal)
      if (octokit._tag === 'Err')
        return octokit
      const { owner, repo } = repositoryParts(repository.github)
      const requestOptions = { request: { signal } }
      const actor = options.actorLogin(repository).toLowerCase()
      return octokit.value.rest.issues.getComment({ owner, repo, comment_id: commentId, ...requestOptions })
        .then(async (existing) => {
          if (existing.data.user?.login.toLowerCase() !== actor)
            return err('The stored automated review comment belongs to another GitHub actor.')
          if (existing.data.issue_url !== undefined && !existing.data.issue_url.endsWith(`/${pullRequestNumber}`))
            return err('The stored automated review comment belongs to another pull request.')
          if (existing.data.body === body && existing.data.html_url !== undefined)
            return ok({ _tag: 'Edited' as const, commentId: existing.data.id, url: existing.data.html_url })
          if (existing.data.body !== expectedBody)
            return ok({ _tag: 'Changed' as const })
          await octokit.value.rest.issues.updateComment({ owner, repo, comment_id: commentId, body, ...requestOptions })
          // The compare and swap above is a client side read then write, so a
          // concurrent writer can land between the two. Reading back is the
          // only way to see that the written body no longer holds.
          const confirmed = await octokit.value.rest.issues.getComment({ owner, repo, comment_id: commentId, ...requestOptions })
          if (confirmed.data.user?.login.toLowerCase() !== actor)
            return err('GitHub did not confirm the edited automated review comment.')
          if (confirmed.data.body !== body)
            return ok({ _tag: 'Changed' as const })
          return ok({ _tag: 'Edited' as const, commentId: confirmed.data.id, url: confirmed.data.html_url })
        })
        .catch((error: unknown) => isMissingComment(error) ? ok({ _tag: 'Missing' as const }) : err(message(error)))
    },

    async upsertReviewStatus(repository, pullRequestNumber, commentId, body, replacePriorReview, signal) {
      const octokit = await client(repository.github, 'item_write', signal)
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
