import type { AutoMergePolicy } from './auto-merge.ts'
import type { GitHubPullRequestMerger } from './github.ts'
import type { JournalStore } from './store.ts'
import type { GitHubItem, RepositoryMapping } from './types.ts'
import { autoMergeDecision } from './auto-merge.ts'

export type AutoMergeEvent
  /** GitHub owns the merge from here and performs it when its checks pass. */
  = | { _tag: 'AutoMergeEnabled', repository: string, pullRequestNumber: number }
    /** GitHub had nothing left to wait for, so the merge happened immediately. */
    | { _tag: 'Merged', repository: string, pullRequestNumber: number, sha: string }
    | { _tag: 'Refused', repository: string, pullRequestNumber: number, reason: string }

export interface AutoMergeController {
  reconcile: (repository: RepositoryMapping, subject: GitHubItem, signal: AbortSignal) => Promise<void>
}

export interface AutoMergeControllerOptions {
  merger: GitHubPullRequestMerger
  policy: AutoMergePolicy
  /** Every merge and every refusal is reported. A refusal never fails the poll. */
  report: (event: AutoMergeEvent) => void
  store: Pick<JournalStore, 'listReviewRuns'>
}

export function createAutoMergeController(options: AutoMergeControllerOptions): AutoMergeController {
  return {
    async reconcile(repository, subject, signal) {
      if (options.policy._tag === 'Disabled' || subject.kind !== 'pull_request' || !subject.autoMerge)
        return
      const decision = autoMergeDecision({
        attempts: options.store.listReviewRuns(repository.github, subject.number),
        policy: options.policy,
        pullRequest: subject,
        repository,
      })
      if (decision._tag === 'Hold')
        return

      const handoff = await options.merger.merge({
        repository,
        number: subject.number,
        expectedHeadSha: decision.headSha,
        method: decision.method,
      }, signal)
      if (handoff._tag === 'Err') {
        options.report({ _tag: 'Refused', repository: repository.github, pullRequestNumber: subject.number, reason: handoff.error.message })
        return
      }
      options.report(handoff.value._tag === 'AutoMergeEnabled'
        ? { _tag: 'AutoMergeEnabled', repository: repository.github, pullRequestNumber: subject.number }
        : { _tag: 'Merged', repository: repository.github, pullRequestNumber: subject.number, sha: handoff.value.sha })
    },
  }
}
