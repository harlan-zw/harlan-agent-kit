import type { GitHubAgentSource } from './github-agent-source.ts'
import type { GitHubIssuePublisher, GitHubSource } from './github.ts'
import type { LoggedFindingPickup } from './logged-finding-pickup.ts'
import type { LoggedFindingComment, LoggedFindingStore } from './logged-finding-store.ts'
import type { Result } from './result.ts'
import type { ReviewFindingThread, ReviewFindingThreadSource } from './review-finding-threads.ts'
import type { JournalStore } from './store.ts'
import type { RepositoryMapping } from './types.ts'
import { FOLLOW_UP_ISSUE_LABEL, hasFollowUpIssueLabel, isPublishedFollowUp } from './follow-up-issue.ts'
import { err, ok } from './result.ts'

/**
 * Files the issues follow-up ticks staged, a few per pass.
 *
 * Each command first looks for its marker, because GitHub may have filed an
 * issue whose reply was lost. A refusal returns the command to the store,
 * which retries a transient one and stops a permanent one for a person.
 */
export async function publishFollowUpIssues(options: {
  github: Pick<GitHubIssuePublisher, 'createIssue' | 'findFollowUpIssues'>
  store: Pick<LoggedFindingStore, 'claimFollowUpIssue' | 'authorizeFollowUpIssue' | 'completeFollowUpIssue' | 'failFollowUpIssue'>
  now: () => Date
  workerId: string
  /** The login GitHub shows as the author of an issue this controller files in one repository. */
  actorLogin: (repository: RepositoryMapping) => string
}, signal: AbortSignal, limit = 3): Promise<Array<Result<{ repository: string, issueNumber: number }, string>>> {
  const results: Array<Result<{ repository: string, issueNumber: number }, string>> = []
  for (let filed = 0; filed < limit && !signal.aborted; filed++) {
    const command = options.store.claimFollowUpIssue(options.workerId, options.now().toISOString(), 60_000)
    if (command === null)
      break
    const settle = (result: Result<{ number: number, url: string }, { message: string, status?: number | undefined }>) => {
      // An aborted pass is a shutdown. The lease expires and the next pass claims the command again.
      if (signal.aborted)
        return
      if (result._tag === 'Ok') {
        options.store.completeFollowUpIssue({ id: command.id, workerId: command.workerId, fence: command.fence, at: options.now().toISOString(), issueNumber: result.value.number, url: result.value.url })
        results.push(ok({ repository: command.repository, issueNumber: result.value.number }))
        return
      }
      options.store.failFollowUpIssue({ id: command.id, workerId: command.workerId, fence: command.fence, at: options.now().toISOString(), reason: result.error.message, status: result.error.status })
      results.push(err(`${command.repository}#${command.pullRequestNumber}: ${result.error.message}`))
    }
    const marked = await options.github.findFollowUpIssues({ repository: command.repositoryMapping, marker: command.marker }, signal)
    if (marked._tag === 'Err') {
      settle(marked)
      continue
    }
    // Anyone can copy the marker into an issue. Only the controller's own
    // publication, labelled and unchanged, answers this command.
    const actor = options.actorLogin(command.repositoryMapping).toLowerCase()
    const existing = marked.value.find(issue => issue.authorLogin.toLowerCase() === actor
      && hasFollowUpIssueLabel(issue.labels)
      && isPublishedFollowUp(issue, command, command.repositoryMapping.githubAccount))
    if (existing !== undefined) {
      settle(ok(existing))
      continue
    }
    const authorize = () => !signal.aborted && options.store.authorizeFollowUpIssue(command, options.now().toISOString())
      ? ok(undefined)
      : err('The follow-up issue lost its publication authority.')
    // Keep revoked work leased so a later pass can recover it.
    if (authorize()._tag === 'Err')
      continue
    const result = await options.github.createIssue({ repository: command.repositoryMapping, title: command.title, body: command.body, labels: [FOLLOW_UP_ISSUE_LABEL] }, signal, authorize)
    if (result._tag === 'Err' && authorize()._tag === 'Err')
      continue
    settle(result)
  }
  return results
}

/**
 * Applies one signed follow-up tick against GitHub's state now, and says whether the store staged it.
 *
 * The tick must name the live head, and an open pull request's live target
 * branch. An inline tick needs its own thread open. A Merged tick reads every
 * finding thread, because a person can resolve or reopen one after the last sync.
 */
export async function applyLoggedFindingPickup(options: {
  github: Pick<GitHubSource, 'getPullRequest'> & Pick<ReviewFindingThreadSource, 'listReviewFindingThreads'>
  store: Pick<LoggedFindingStore, 'requestLoggedFindingPickup'> & Pick<JournalStore, 'getOpenPullRequest'>
  now: () => Date
}, repository: RepositoryMapping, request: LoggedFindingPickup & { requestId: string }, signal: AbortSignal): Promise<Result<boolean, string>> {
  const observed = options.store.getOpenPullRequest(repository.github, request.pullRequestNumber)
  const live = await options.github.getPullRequest(repository, request.pullRequestNumber, signal)
  if (live._tag === 'Err')
    return err(live.error.message)
  if (live.value.headSha !== request.headSha || (live.value.state === 'open' && observed?.baseRef !== live.value.baseRef))
    return ok(false)
  const threads = request.inline === true || request._tag === 'MergedFollowUps'
    ? await options.github.listReviewFindingThreads(repository, request.pullRequestNumber, signal)
    : null
  if (threads !== null && threads._tag === 'Err')
    return threads
  if (request.inline === true && (threads === null || !threads.value.some(thread => !thread.resolved && thread.comment?.id === request.commentId)))
    return ok(false)
  return ok(options.store.requestLoggedFindingPickup({
    ...request,
    at: options.now().toISOString(),
    ...(threads === null ? {} : { threads: threads.value }),
  }))
}

/** Refresh conversation authority before claiming work or publishing a fix. */
export async function refreshLoggedFindingThreads(
  store: LoggedFindingStore,
  read: (repository: string, number: number) => Promise<Result<ReviewFindingThread[], string>>,
  at: string,
  taskId?: string,
  hold?: (selection: { repository: string, pullRequestNumber: number }, reason: string) => void,
): Promise<Result<void, string>> {
  for (const selection of store.listLoggedFindingThreadSelections(taskId)) {
    const threads = await read(selection.repository, selection.pullRequestNumber)
    store.holdLoggedFindingSelection(selection, threads._tag === 'Err')
    if (threads._tag === 'Err') {
      if (hold === undefined)
        return threads
      hold(selection, threads.error)
      continue
    }
    store.reconcileLoggedFindingThreads(selection.repository, selection.pullRequestNumber, threads.value, at)
  }
  return ok(undefined)
}

/** How long a comment that did not update waits before the sweep tries it again. */
const RETRY_AFTER = {
  /** GitHub or the network failed. The same write may work soon. */
  Failed: 15 * 60_000,
  /** The comment changed on GitHub, belongs to someone else, or is gone. The same write will not work until its source changes. */
  Refused: 24 * 60 * 60_000,
} as const

/** Updates the existing canonical comment under a durable Publication lease. */
export async function publishLoggedFindingPickups(options: {
  github: Pick<GitHubAgentSource, 'editReviewStatus'>
  store: LoggedFindingStore
  repositories: readonly RepositoryMapping[]
  now: () => Date
  workerId: string
  controls?: (repository: string) => boolean
}, signal: AbortSignal): Promise<string[]> {
  const errors: string[] = []
  // The claim scans in a fixed order. A comment that did not update waits out
  // its back-off, so it never takes the next claim from one that can update.
  const retryLater = (command: LoggedFindingComment, wait: number): void => {
    options.store.deferLoggedFindingComment(command, new Date(options.now().getTime() + wait).toISOString())
  }
  for (let index = 0; index < 20 && !signal.aborted; index++) {
    const command = options.store.claimLoggedFindingComment(options.workerId, options.now().toISOString(), 60_000, options.controls)
    if (command === null)
      break
    const mapping = options.repositories.find(mapping => mapping.github.toLowerCase() === command.repository.toLowerCase())
    if (mapping === undefined) {
      retryLater(command, RETRY_AFTER.Refused)
      continue
    }
    const authorize = () => options.store.authorizeLoggedFindingComment(command, options.now().toISOString())
      ? ok(undefined)
      : err('The finding status lost its publication authority.')
    const authority = authorize()
    if (authority._tag === 'Err') {
      errors.push(authority.error)
      retryLater(command, RETRY_AFTER.Failed)
      continue
    }
    const result = await options.github.editReviewStatus(mapping, command.pullRequestNumber, command.commentId, command.expectedBody, command.body, signal, authorize)
      .catch((error: unknown) => err(error instanceof Error ? error.message : 'The finding status update failed.'))
    if (result._tag === 'Err') {
      errors.push(`${command.repository}#${command.pullRequestNumber}: ${result.error}`)
      retryLater(command, RETRY_AFTER.Failed)
    }
    else if (result.value._tag === 'Edited') {
      if (!options.store.completeLoggedFindingComment(command, options.now().toISOString()))
        errors.push(`${command.repository}#${command.pullRequestNumber}: the finding status receipt lost its publication lease.`)
    }
    else {
      retryLater(command, RETRY_AFTER.Refused)
    }
  }
  return errors
}
