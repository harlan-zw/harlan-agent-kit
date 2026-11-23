import type { AutoMergePolicy, HeadChangedFiles } from './auto-merge.ts'
import type { GitHubAgentSource } from './github-agent-source.ts'
import type { GitHubPullRequestMerger } from './github.ts'
import type { PullRequestFile } from './merge-risk.ts'
import type { JournalStore } from './store.ts'
import type { GitHubItem, RepositoryMapping, ReviewRun } from './types.ts'
import { autoMergeCandidate, autoMergeDecision, hasCurrentPublishedReadyReview, latestReviewForHead } from './auto-merge.ts'
import { err, ok } from './result.ts'

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
  /** Lists the changed files when none are recorded for the reviewed Revision. */
  github: Pick<GitHubAgentSource, 'listPullRequestFiles'>
  merger: GitHubPullRequestMerger
  policy: AutoMergePolicy
  /** Every merge and every refusal is reported. A refusal never fails the poll. */
  report: (event: AutoMergeEvent) => void
  store: Pick<JournalStore, 'getAutoMergeContext' | 'getRevisionFiles' | 'listReviewRuns'>
}

interface ListedFiles {
  headSha: string
  baseRef: string
  files: readonly PullRequestFile[]
}

export function createAutoMergeController(options: AutoMergeControllerOptions): AutoMergeController {
  /** The last list GitHub returned for each pull request, so a head GitHub has not merged yet costs one read. */
  const listed = new Map<string, ListedFiles>()

  /**
   * The changed files of the reviewed head commit.
   *
   * The files recorded for the reviewed Revision cost no GitHub call, and they
   * are the list the Review read. Otherwise GitHub lists the pull request's
   * files. That list names no commit, so the pinned merge binds it: a list
   * read while GitHub held another head can only precede a merge GitHub
   * refuses at `expectedHeadSha`.
   */
  const headChangedFiles = async (
    repository: RepositoryMapping,
    pullRequestNumber: number,
    head: { headSha: string, baseRef: string },
    attempts: ReviewRun[],
    signal: AbortSignal,
  ): Promise<HeadChangedFiles> => {
    const key = `${repository.github}#${pullRequestNumber}`
    const remembered = listed.get(key)
    if (remembered !== undefined && remembered.headSha === head.headSha && remembered.baseRef === head.baseRef)
      return { _tag: 'Read', headSha: head.headSha, files: remembered.files }
    const reviewed = latestReviewForHead(attempts, head.headSha, head.baseRef)
    const recorded = reviewed === undefined ? null : options.store.getRevisionFiles(repository.github, pullRequestNumber, reviewed.revisionId)
    if (recorded !== null && recorded.headSha === head.headSha)
      return { _tag: 'Read', headSha: head.headSha, files: recorded.files }
    const read = await options.github.listPullRequestFiles(repository, pullRequestNumber, signal)
    if (read._tag === 'Err')
      return { _tag: 'Unavailable', reason: read.error }
    listed.set(key, { ...head, files: read.value })
    return { _tag: 'Read', headSha: head.headSha, files: read.value }
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
      const changedFiles = await headChangedFiles(repository, subject.number, { headSha: subject.headSha, baseRef: subject.baseRef }, attempts, signal)
      const decision = autoMergeDecision({
        attempts,
        changedFiles,
        policy: options.policy,
        pullRequest: context.pullRequest,
        repository: context.repository,
      })
      if (decision._tag === 'Hold')
        return
      const publication = attempts.find(attempt => attempt.id === decision.reviewRunId)?.gatePublication
      if (publication?._tag !== 'Published')
        return

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
      options.report(handoff.value._tag === 'AutoMergeEnabled'
        ? { _tag: 'AutoMergeEnabled', repository: repository.github, pullRequestNumber: subject.number }
        : { _tag: 'Merged', repository: repository.github, pullRequestNumber: subject.number, sha: handoff.value.sha })
    },
  }
}
