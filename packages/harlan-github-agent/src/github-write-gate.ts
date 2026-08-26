import type { GitHubTokenProvider } from './github-auth.ts'
import type { Result } from './result.ts'
import type { GitHubRepositoryAccess } from './types.ts'
import { err, ok } from './result.ts'

export interface GitHubWriteGateOptions {
  /** True when a person has trusted the controller to write to this repository. */
  mayWrite: (github: string) => boolean
  /** Called once for each refused write, so a person sees why nothing happened. */
  onRefused: (github: string) => void
  source: GitHubTokenProvider
}

/** The reason every write credential is refused for one quarantined repository. */
export function repositoryQuarantineReason(github: string): string {
  return `The controller has never been trusted to write to ${github}. Enable writes for it first.`
}

const writeAccess = new Set<GitHubRepositoryAccess>(['contents_write', 'item_write', 'workflows_write'])

/**
 * Refuses every write credential to a repository nobody enabled.
 *
 * Every GitHub mutation needs a write access level. Keeping the
 * gate at that shared boundary covers comments, labels, branches, pull requests,
 * and future writers without each caller remembering a separate policy check.
 */
export function createGitHubWriteGate(options: GitHubWriteGateOptions): GitHubTokenProvider {
  return {
    getToken(repository, access, signal) {
      if (!writeAccess.has(access) || options.mayWrite(repository))
        return options.source.getToken(repository, access, signal)
      options.onRefused(repository)
      return Promise.resolve(err({
        repository,
        message: repositoryQuarantineReason(repository),
      }))
    },
    invalidate: (repository, access) => options.source.invalidate(repository, access),
  }
}

export async function preflightGitHubWriteAccess(
  source: GitHubTokenProvider,
  repository: string,
  accesses: readonly GitHubRepositoryAccess[],
  signal?: AbortSignal,
): Promise<Result<void, string>> {
  for (const access of accesses) {
    const token = await source.getToken(repository, access, signal)
    if (token._tag === 'Err')
      return err(token.error.message)
  }
  return ok(undefined)
}

interface RepositoryWorker<Task extends { repository: string }, Value> {
  run: (task: Task, signal: AbortSignal) => Promise<Result<Value, string>>
}

/** Refuses work before an Agent turn when its required GitHub access is absent. */
export function withGitHubWritePreflight<Task extends { repository: string }, Value>(options: {
  accesses: readonly GitHubRepositoryAccess[]
  source: GitHubTokenProvider
  worker: RepositoryWorker<Task, Value>
}): RepositoryWorker<Task, Value> {
  return {
    async run(task, signal) {
      const access = await preflightGitHubWriteAccess(options.source, task.repository, options.accesses, signal)
      return access._tag === 'Err' ? access : options.worker.run(task, signal)
    },
  }
}
