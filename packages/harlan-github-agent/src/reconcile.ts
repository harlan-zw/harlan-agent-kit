import type { ApprovalController } from './approval-controller.ts'
import type { AutoMergeController } from './auto-merge-controller.ts'
import type { GitHubSource } from './github.ts'
import type { Result } from './result.ts'
import type { JournalStore, RecordObservationResult } from './store.ts'
import type { RepositoryMapping } from './types.ts'
import { createHash } from 'node:crypto'
import { isEligibleGitHubSubjectAuthor } from './github.ts'
import { err, ok } from './result.ts'

export interface ReconciliationSummary {
  repository: string
  inserted: number
  duplicates: number
  closed: number
  stale: number
  subjects: number
}

export interface ReconciliationError {
  repository: string
  message: string
}

export interface ReconciliationDependencies {
  approvals?: ApprovalController
  autoMerge?: AutoMergeController
  github: Pick<GitHubSource, 'getIssue' | 'getPullRequest' | 'listOpenItems'>
  store: JournalStore
  now: () => Date
  signal?: AbortSignal
}

const observationIdentityVersion = 'subject-revision-v2'

function observationId(repository: string, subject: { kind: string, number: number }): string {
  return createHash('sha256')
    .update(`${observationIdentityVersion}:${repository}:${subject.kind}:${subject.number}:${JSON.stringify(subject)}`)
    .digest('hex')
}

function countResults(results: RecordObservationResult[]): Pick<ReconciliationSummary, 'inserted' | 'duplicates' | 'stale'> {
  return {
    inserted: results.filter(result => result._tag === 'Inserted').length,
    duplicates: results.filter(result => result._tag === 'Duplicate').length,
    stale: results.filter(result => result._tag === 'Stale').length,
  }
}

export async function reconcileRepository(repository: RepositoryMapping, dependencies: ReconciliationDependencies): Promise<Result<ReconciliationSummary, ReconciliationError>> {
  const observedAt = dependencies.now().toISOString()
  const writesEnabled = dependencies.store.mayWriteRepository(repository.github)
  dependencies.store.recordPollAttempt(repository.github, observedAt)
  const result = await dependencies.github.listOpenItems(repository, dependencies.signal)
  if (result._tag === 'Err') {
    if (dependencies.signal?.aborted !== true)
      dependencies.store.recordPollFailure(repository.github, observedAt, result.error.message)
    return err({ repository: repository.github, message: result.error.message })
  }

  const eligibleItems = result.value.filter(subject => isEligibleGitHubSubjectAuthor(
    { login: subject.author },
    subject.kind === 'issue'
      ? { kind: 'issue', routineFiled: subject.routineFiled }
      : { kind: 'pull_request', allowedAuthors: repository.writablePullRequestAuthors },
  ))
  const seenIssues = new Set(eligibleItems.flatMap(subject => subject.kind === 'issue' ? [subject.number] : []))
  const missingIssueNumbers = dependencies.store.listOpenIssueNumbers(repository.github)
    .filter(number => !seenIssues.has(number))
  const seenPullRequests = new Set(eligibleItems.flatMap(subject => subject.kind === 'pull_request' ? [subject.number] : []))
  const missingPullRequestNumbers = dependencies.store.listOpenPullRequestNumbers(repository.github)
    .filter(number => !seenPullRequests.has(number))
  const unverifiedClosedPullRequestNumbers = dependencies.store.listUnverifiedClosedPullRequestNumbers(repository.github)
    .filter(number => !seenPullRequests.has(number))
  const finalPullRequestNumbers = [...new Set([...missingPullRequestNumbers, ...unverifiedClosedPullRequestNumbers])]
  const [finalIssueReads, finalPullRequestReads] = await Promise.all([
    Promise.all(missingIssueNumbers.map(number => dependencies.github.getIssue(repository, number, dependencies.signal))),
    Promise.all(finalPullRequestNumbers.map(number => dependencies.github.getPullRequest(repository, number, dependencies.signal))),
  ])
  const failedFinalRead = [...finalIssueReads, ...finalPullRequestReads].find(read => read._tag === 'Err')
  if (failedFinalRead?._tag === 'Err') {
    if (dependencies.signal?.aborted !== true)
      dependencies.store.recordPollFailure(repository.github, observedAt, failedFinalRead.error.message, failedFinalRead.error.status)
    return err({ repository: repository.github, message: failedFinalRead.error.message })
  }
  const finalIssues = finalIssueReads.flatMap(read => read._tag === 'Ok' ? [read.value] : [])
  const finalPullRequests = finalPullRequestReads.flatMap(read => read._tag === 'Ok' ? [read.value] : [])
  const observedItems = [...eligibleItems, ...finalIssues, ...finalPullRequests]
  const eligibleWrites = eligibleItems.map(subject => dependencies.store.recordObservation({
    externalId: observationId(repository.github, subject),
    observedAt,
    source: 'poll',
    subject,
  }))
  const finalIssueWrites = finalIssues.map(subject => dependencies.store.recordObservation({
    externalId: observationId(repository.github, subject),
    observedAt,
    source: 'poll',
    subject,
  }))
  const finalPullRequestWrites = finalPullRequests.map(subject => dependencies.store.recordExactPullRequestObservation({
    externalId: observationId(repository.github, subject),
    observedAt,
    subject,
  }))
  const writes = [...eligibleWrites, ...finalIssueWrites, ...finalPullRequestWrites]
  const conflict = writes.find(write => write._tag === 'Conflict')
  if (conflict?._tag === 'Conflict') {
    const message = `GitHub state hash collision: ${conflict.existingRevisionId} and ${conflict.receivedRevisionId}.`
    dependencies.store.recordPollFailure(repository.github, observedAt, message)
    return err({ repository: repository.github, message })
  }
  const closureVerificationFailed = finalPullRequests.some((pullRequest, index) => {
    const write = finalPullRequestWrites[index]
    if (pullRequest.state !== 'closed' || write === undefined || write._tag === 'Stale' || write._tag === 'Conflict')
      return false
    return !dependencies.store.recordVerifiedPullRequestClosure({
      repository: repository.github,
      pullRequestNumber: pullRequest.number,
      revisionId: write.revisionId,
      headSha: pullRequest.headSha,
      baseSha: pullRequest.baseSha,
      disposition: pullRequest.mergedAt === null ? { _tag: 'Closed' } : { _tag: 'Merged' },
      at: observedAt,
    })
  })
  if (closureVerificationFailed) {
    const message = 'The final pull request state could not be saved.'
    dependencies.store.recordPollFailure(repository.github, observedAt, message)
    return err({ repository: repository.github, message })
  }

  if (writesEnabled && dependencies.approvals !== undefined) {
    const approvals = await Promise.all(eligibleItems.map((subject, index) => {
      const write = writes[index]
      if (write === undefined || write._tag === 'Conflict' || write._tag === 'Stale')
        return Promise.resolve(ok(undefined))
      return dependencies.approvals?.reconcile(repository, subject, write.revisionId, dependencies.signal ?? AbortSignal.timeout(30_000)) ?? Promise.resolve(ok(undefined))
    }))
    const failed = approvals.find(approval => approval._tag === 'Err')
    if (failed?._tag === 'Err') {
      if (dependencies.signal?.aborted !== true)
        dependencies.store.recordPollFailure(repository.github, observedAt, failed.error)
      return err({ repository: repository.github, message: failed.error })
    }
  }

  if (writesEnabled && dependencies.autoMerge !== undefined) {
    const merges = dependencies.autoMerge
    await Promise.all(eligibleItems.map(subject => merges.reconcile(
      repository,
      subject,
      dependencies.signal ?? AbortSignal.timeout(30_000),
    )))
  }

  const missingIssues = new Set(missingIssueNumbers)
  const missingPullRequests = new Set(missingPullRequestNumbers)
  const closed = finalIssues.filter((issue, index) => {
    const write = finalIssueWrites[index]
    return missingIssues.has(issue.number)
      && issue.state === 'closed'
      && (write?._tag === 'Inserted' || write?._tag === 'Duplicate')
  }).length + finalPullRequests.filter((pullRequest, index) => {
    const write = finalPullRequestWrites[index]
    return missingPullRequests.has(pullRequest.number)
      && pullRequest.state === 'closed'
      && (write?._tag === 'Inserted' || write?._tag === 'Duplicate')
  }).length + dependencies.store.closeMissingItems(
    repository.github,
    observedItems.map(subject => ({ kind: subject.kind, number: subject.number })),
    observedAt,
  )
  dependencies.store.recordPollSuccess(repository.github, observedAt)
  return ok({
    repository: repository.github,
    subjects: eligibleItems.length,
    closed,
    ...countResults(writes.slice(0, eligibleItems.length)),
  })
}

export function reconcileAllRepositories(repositories: RepositoryMapping[], dependencies: ReconciliationDependencies): Promise<Array<Result<ReconciliationSummary, ReconciliationError>>> {
  return Promise.all(repositories
    .filter(repository => repository.enabled)
    .map(repository => reconcileRepository(repository, dependencies)))
}
