import type { GitHubAgentSource } from './github-agent-source.ts'
import type { LoggedFindingStore } from './logged-finding-store.ts'
import type { RepositoryMapping } from './types.ts'
import { err, ok } from './result.ts'

/** Updates the existing canonical comment under a durable Publication lease. */
export async function publishLoggedFindingPickups(options: {
  github: Pick<GitHubAgentSource, 'editReviewStatus'>
  store: LoggedFindingStore
  repositories: readonly RepositoryMapping[]
  now: () => Date
  workerId: string
}, signal: AbortSignal): Promise<string[]> {
  const errors: string[] = []
  // Bound one pass. A failed comment releases itself when its lease expires.
  for (let index = 0; index < 20 && !signal.aborted; index++) {
    const command = options.store.claimLoggedFindingComment(options.workerId, options.now().toISOString(), 60_000)
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
