import type { FindingThreadSyncStore } from './finding-thread-sync-store.ts'
import type { GitHubSource } from './github.ts'
import type { ReviewFindingThreadMirror, ReviewFindingThreadsOutcome } from './review-finding-threads.ts'
import { err, ok } from './result.ts'
import { mirrorReviewFindingThreads } from './review-finding-threads.ts'

export function createFindingThreadSyncController(options: {
  store: FindingThreadSyncStore
  readPullRequest: GitHubSource['getPullRequest']
  mirror: ReviewFindingThreadMirror
  now: () => Date
  workerId: string
}) {
  return {
    async run(
      signal: AbortSignal,
    ): Promise<Array<{ repository: string; number: number; outcome: ReviewFindingThreadsOutcome }>> {
      const results: Array<{ repository: string; number: number; outcome: ReviewFindingThreadsOutcome }> = []
      options.store.restoreReviewFindingThreadSyncs(options.now().toISOString())
      for (let count = 0; count < 3 && !signal.aborted; count++) {
        const command = options.store.claimReviewFindingThreadSync(
          options.workerId,
          options.now().toISOString(),
          2 * 60_000,
        )
        if (command === null) break
        let authorityLost = false
        let receiptSaved = true
        const report = (outcome: ReviewFindingThreadsOutcome): void => {
          const at = options.now().toISOString()
          receiptSaved =
            outcome._tag === 'Written'
              ? options.store.completeReviewFindingThreadSync(command, at)
              : options.store.deferReviewFindingThreadSync(command, at, outcome.message)
          if (receiptSaved && !signal.aborted && !authorityLost) options.mirror.report(command.repository, outcome)
        }
        const live = await options.readPullRequest(command.repositoryMapping, command.pullRequestNumber, signal)
        if (live._tag === 'Err') {
          const outcome = { _tag: 'Failed' as const, message: live.error.message }
          report(outcome)
          results.push({ repository: command.repository, number: command.pullRequestNumber, outcome })
          continue
        }
        const pull = live.value
        if (
          pull.headSha !== command.headSha ||
          pull.baseRef !== command.baseRef ||
          (pull.state === 'closed' && pull.mergedAt === null)
        ) {
          options.store.supersedeReviewFindingThreadSync(command, options.now().toISOString())
          continue
        }
        const outcome = await mirrorReviewFindingThreads(
          { ...options.mirror, report: (_repository, result) => report(result) },
          command.repositoryMapping,
          command.pullRequestNumber,
          command.headSha,
          command.findings,
          signal,
          () => {
            authorityLost =
              signal.aborted || !options.store.authorizeReviewFindingThreadSync(command, options.now().toISOString())
            return authorityLost ? err('The finding thread sync lost its Publication authority.') : ok(undefined)
          },
          pull.state === 'closed' ? 'merged' : 'open',
        )
        results.push({
          repository: command.repository,
          number: command.pullRequestNumber,
          outcome: receiptSaved
            ? outcome
            : { _tag: 'Failed', message: 'The finding thread sync receipt lost its Publication lease.' },
        })
      }
      return results
    },
  }
}
