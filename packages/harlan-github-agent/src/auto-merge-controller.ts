import type { AutoMergeHoldCause, AutoMergeInput, AutoMergePolicy, HeadChangedFiles } from './auto-merge.ts'
import type { ChangedLinesReader } from './github-changed-lines.ts'
import type { GitHubPullRequestMerger } from './github.ts'
import type { JournalStore } from './store.ts'
import type { GitHubItem, RepositoryMapping } from './types.ts'
import { autoMergeCandidate, autoMergeDecision, comparedChangedFiles, hasCurrentPublishedReadyReview, heldOnlyByLabel } from './auto-merge.ts'
import { err, ok } from './result.ts'

const repositoryAutoMergeRetryMs = 60 * 60_000

export type AutoMergeEvent
  /** GitHub owns the merge from here and performs it when its checks pass. */
  = | { _tag: 'AutoMergeEnabled', repository: string, pullRequestNumber: number }
    /** GitHub had nothing left to wait for, so the merge happened immediately. */
    | { _tag: 'Merged', repository: string, pullRequestNumber: number, sha: string }
    | { _tag: 'Retargeted', repository: string, pullRequestNumber: number }
    | { _tag: 'Refused', repository: string, pullRequestNumber: number, reason: string }

export interface AutoMergeController {
  reconcile: (repository: RepositoryMapping, subject: GitHubItem, signal: AbortSignal) => Promise<void>
}

export interface AutoMergeControllerOptions {
  /** Compares two exact commits, so the changed files belong to the head and base the decision names. */
  changedLines: ChangedLinesReader
  merger: GitHubPullRequestMerger
  /** Stamps each hold record. */
  now: () => Date
  policy: AutoMergePolicy
  /** Every merge and every refusal is reported. A refusal never fails the poll. */
  report: (event: AutoMergeEvent) => void
  store: Pick<JournalStore, 'getAutoMergeContext' | 'listReviewRuns' | 'mergedWithFailingChecks' | 'recordAutoMergeHold'>
}

export function createAutoMergeController(options: AutoMergeControllerOptions): AutoMergeController {
  const repositoryRetryAt = new Map<string, number>()

  /**
   * The last complete comparison for each pull request.
   *
   * Two fixed commits always compare the same, so a head that waits for
   * GitHub's merge costs one read for each base commit it meets.
   */
  const compared = new Map<string, Extract<HeadChangedFiles, { _tag: 'Read' }>>()

  /**
   * The changed files of the exact observed base and head commits.
   *
   * The comparison names both commits by SHA, so its files can belong to no
   * other head. A new base commit can move the merge base and change what the
   * merge brings in, so it gets a new comparison.
   */
  const headChangedFiles = async (
    repository: RepositoryMapping,
    pullRequestNumber: number,
    commits: { baseSha: string, headSha: string },
    signal: AbortSignal,
  ): Promise<HeadChangedFiles> => {
    const key = `${repository.github}#${pullRequestNumber}`
    const remembered = compared.get(key)
    if (remembered !== undefined && remembered.baseSha === commits.baseSha && remembered.headSha === commits.headSha)
      return remembered
    const reading = comparedChangedFiles(commits, await options.changedLines(repository, commits.baseSha, commits.headSha, signal))
    if (reading._tag === 'Read')
      compared.set(key, reading)
    return reading
  }

  return {
    async reconcile(repository, subject, signal) {
      if (options.policy._tag === 'Disabled' || subject.kind !== 'pull_request' || !autoMergeCandidate(repository, subject))
        return
      if (subject.baseRef === undefined)
        return
      // Labels stay out of stored Revisions. The helper supplies its live GitHub label before each write.
      const currentContext = (autoMerge = subject.autoMerge) => {
        const current = options.store.getAutoMergeContext(repository.github, subject.number)
        return options.policy._tag === 'Disabled' || current === null
          || current.repository.defaultBranch !== repository.defaultBranch
          || current.pullRequest.headSha !== subject.headSha || current.pullRequest.baseRef !== subject.baseRef
          ? null
          : { ...current, pullRequest: { ...current.pullRequest, approvalLabels: [], autoMerge } }
      }
      const context = currentContext()
      if (context === null)
        return
      if (subject.baseRef !== repository.defaultBranch) {
        const authorize = (autoMerge: boolean) => {
          const current = currentContext(autoMerge)
          return current !== null && current.repository.enabled && current.repository.ownership === 'owned'
            && autoMergeCandidate(current.repository, current.pullRequest)
            && current.pullRequest.state === 'open' && current.pullRequest.mergedAt === null && !current.pullRequest.draft
            && current.repository.writablePullRequestAuthors.some(author => author.toLowerCase() === current.pullRequest.author.toLowerCase())
            ? ok(undefined)
            : err('Auto merge lost its current authority before retargeting the pull request.')
        }
        if (authorize(subject.autoMerge)._tag === 'Err')
          return
        const retargeted = await options.merger.retargetMergedParent({
          repository: context.repository,
          number: subject.number,
          expectedHeadSha: subject.headSha,
          expectedBaseRef: subject.baseRef,
          authorize,
        }, signal)
        if (retargeted._tag === 'Err')
          options.report({ _tag: 'Refused', repository: repository.github, pullRequestNumber: subject.number, reason: retargeted.error.message })
        else if (retargeted.value)
          options.report({ _tag: 'Retargeted', repository: repository.github, pullRequestNumber: subject.number })
        return
      }
      const attempts = options.store.listReviewRuns(repository.github, subject.number)
      // Without a current published READY Review the decision holds anyway, so
      // only a head that has one spends a read on its changed files.
      if (!hasCurrentPublishedReadyReview(attempts, subject.headSha, subject.baseRef))
        return
      // The decision reads the stored context, so the comparison uses its
      // commits. The subject can name an older base commit.
      const changedFiles = await headChangedFiles(repository, subject.number, { baseSha: context.pullRequest.baseSha, headSha: context.pullRequest.headSha }, signal)
      const input: AutoMergeInput = {
        attempts,
        changedFiles,
        mergedWithFailingChecks: options.store.mergedWithFailingChecks(repository.github, subject.number, context.pullRequest.headSha),
        policy: options.policy,
        pullRequest: context.pullRequest,
        repository: context.repository,
      }
      const recordHold = (cause: AutoMergeHoldCause, heldOnlyByLabel = false) => options.store.recordAutoMergeHold({
        repository: repository.github,
        pullRequestNumber: subject.number,
        headSha: context.pullRequest.headSha,
        cause,
        heldOnlyByLabel,
        at: options.now().toISOString(),
      })
      // A recorded local failure holds inside the decision, which authorize
      // reads again immediately before either GitHub merge path.
      const decision = autoMergeDecision(input)
      if (decision._tag === 'Hold') {
        // Only a head that reached a published READY Review gets here, so the
        // record says why a reviewed candidate waited for Harlan.
        if (autoMergeCandidate(context.repository, context.pullRequest))
          recordHold(decision.cause, heldOnlyByLabel(input))
        return
      }
      const publication = attempts.find(attempt => attempt.id === decision.reviewRunId)?.gatePublication
      if (publication?._tag !== 'Published')
        return

      const repositoryKey = repository.github.toLowerCase()
      if ((repositoryRetryAt.get(repositoryKey) ?? 0) > options.now().getTime()) {
        recordHold('GitHubAutoMergeDisabled')
        return
      }

      const handoff = await options.merger.merge({
        repository: context.repository,
        number: subject.number,
        expectedHeadSha: decision.headSha,
        method: decision.method,
        authorize: (autoMerge) => {
          const current = currentContext(autoMerge)
          if (current === null)
            return err('Auto merge lost its current authority before the GitHub write.')
          const currentAttempts = options.store.listReviewRuns(repository.github, subject.number)
          const currentDecision = autoMergeDecision({
            attempts: currentAttempts,
            changedFiles,
            mergedWithFailingChecks: options.store.mergedWithFailingChecks(repository.github, subject.number, current.pullRequest.headSha),
            policy: options.policy,
            pullRequest: current.pullRequest,
            repository: current.repository,
          })
          const currentPublication = currentAttempts.find(attempt => attempt.id === decision.reviewRunId)?.gatePublication
          return currentDecision._tag === 'Merge' && currentDecision.headSha === decision.headSha
            && currentDecision.method === decision.method && currentDecision.reviewRunId === decision.reviewRunId
            && currentPublication?._tag === 'Published' && currentPublication.publicationId === publication.publicationId
            ? ok(undefined)
            : err('Auto merge lost its current READY Review before the GitHub write.')
        },
      }, signal)
      if (handoff._tag === 'Err') {
        options.report({ _tag: 'Refused', repository: repository.github, pullRequestNumber: subject.number, reason: handoff.error.message })
        return
      }
      if (handoff.value._tag === 'RepositoryAutoMergeDisabled') {
        recordHold('GitHubAutoMergeDisabled')
        const now = options.now().getTime()
        if ((repositoryRetryAt.get(repositoryKey) ?? 0) > now)
          return
        repositoryRetryAt.set(repositoryKey, now + repositoryAutoMergeRetryMs)
        options.report({ _tag: 'Refused', repository: repository.github, pullRequestNumber: subject.number, reason: 'GitHub has disabled Auto merge for this repository. The Service will check again in one hour.' })
        return
      }
      repositoryRetryAt.delete(repositoryKey)
      options.report(handoff.value._tag === 'AutoMergeEnabled'
        ? { _tag: 'AutoMergeEnabled', repository: repository.github, pullRequestNumber: subject.number }
        : { _tag: 'Merged', repository: repository.github, pullRequestNumber: subject.number, sha: handoff.value.sha })
    },
  }
}
