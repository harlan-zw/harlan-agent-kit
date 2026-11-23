import type { GitHubAgentSource } from './github-agent-source.ts'
import type { GitHubIssuePublisher } from './github.ts'
import type { LoggedFindingStore } from './logged-finding-store.ts'
import type { Result } from './result.ts'
import type { ReviewFindingThread } from './review-finding-threads.ts'
import type { RepositoryMapping } from './types.ts'
import { FOLLOW_UP_ISSUE_LABEL } from './follow-up-issue.ts'
import { err, ok } from './result.ts'

/**
 * Files the issues follow-up ticks staged, a few per pass.
 *
 * Each command first looks for its marker, because GitHub may have filed an
 * issue whose reply was lost. A refusal returns the command to the store,
 * which retries a transient one and stops a permanent one for a person.
 */
export async function publishFollowUpIssues(options: {
  github: Pick<GitHubIssuePublisher, 'createIssue' | 'findOpenIssueByMarker'>
  store: Pick<LoggedFindingStore, 'claimFollowUpIssue' | 'authorizeFollowUpIssue' | 'completeFollowUpIssue' | 'failFollowUpIssue'>
  now: () => Date
  workerId: string
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
    const existing = await options.github.findOpenIssueByMarker({ repository: command.repositoryMapping, marker: command.marker }, signal)
    if (existing._tag === 'Err') {
      settle(existing)
      continue
    }
    if (existing.value !== null) {
      settle(ok(existing.value))
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
  // Bound one pass. A failed comment releases itself when its lease expires.
  for (let index = 0; index < 20 && !signal.aborted; index++) {
    const command = options.store.claimLoggedFindingComment(options.workerId, options.now().toISOString(), 60_000, options.controls)
    if (command === null)
      break
    const mapping = options.repositories.find(mapping => mapping.github.toLowerCase() === command.repository.toLowerCase())
    if (mapping === undefined)
      continue
    const authorize = () => options.store.authorizeLoggedFindingComment(command, options.now().toISOString())
      ? ok(undefined)
      : err('The finding status lost its publication authority.')
    const authority = authorize()
    if (authority._tag === 'Err') {
      errors.push(authority.error)
      continue
    }
    const result = await options.github.editReviewStatus(mapping, command.pullRequestNumber, command.commentId, command.expectedBody, command.body, signal, authorize)
      .catch((error: unknown) => err(error instanceof Error ? error.message : 'The finding status update failed.'))
    if (result._tag === 'Err') {
      errors.push(`${command.repository}#${command.pullRequestNumber}: ${result.error}`)
    }
    else if (result.value._tag === 'Edited') {
      if (!options.store.completeLoggedFindingComment(command, options.now().toISOString()))
        errors.push(`${command.repository}#${command.pullRequestNumber}: the finding status receipt lost its publication lease.`)
    }
  }
  return errors
}
