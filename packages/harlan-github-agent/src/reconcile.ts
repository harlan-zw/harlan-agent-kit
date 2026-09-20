import type { ApprovalController } from './approval-controller.ts'
import type { AutoMergeController } from './auto-merge-controller.ts'
import type { GitHubSource } from './github.ts'
import type { IssueClassificationController, IssueClassificationDecision } from './issue-classification.ts'
import type { PullRequestFile } from './merge-risk.ts'
import type { PullRequestTriageController, PullRequestTriageDecision } from './pull-request-triage.ts'
import type { Result } from './result.ts'
import type { JournalStore, RecordObservationResult } from './store.ts'
import type { RepositoryMapping } from './types.ts'
import { createHash } from 'node:crypto'
import { isEligibleGitHubSubjectAuthor } from './github.ts'
import { err, ok } from './result.ts'
import { revisionIdFor } from './store.ts'

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
  issueClassification?: IssueClassificationController
  pullRequestTriage?: PullRequestTriageController
  refreshReviewGates?: (repository: RepositoryMapping, signal: AbortSignal) => Promise<Result<void, string>>
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
  // Pull request triage decides before the observation is recorded, so the
  // planner never queues a Review Task it would skip. Only an open, writable,
  // review-enabled repository is worth a decision.
  const triageSignal = dependencies.signal ?? AbortSignal.timeout(30_000)
  const triageVerdicts = new Map<number, { decision: PullRequestTriageDecision, files: PullRequestFile[] | null }>()
  if (writesEnabled && dependencies.pullRequestTriage !== undefined) {
    const verdicts = await Promise.all(eligibleItems.map(async (subject) => {
      if (subject.kind !== 'pull_request' || subject.state !== 'open' || !repository.pullRequestReview || !repository.enabled)
        return null
      // A Dismissal outranks every planner and every classifier: a dismissed
      // pull request must not be read, classified, or settled on every poll
      // for a decision that can never land.
      if (dependencies.store.isItemDismissed(repository.github, 'pull_request', subject.number))
        return null
      // The planner queues a Review only for a clean, non-draft pull request
      // from a trusted author or one the manual label approves. The verdict
      // asks only those, so an ineligible head is never read or classified
      // on every poll for a decision that cannot land.
      if (subject.draft || subject.mergeState !== 'clean')
        return null
      // Match the planner's own approval rule: Manual Selection or an
      // untrusted author needs Approval before a Review is planned, so no
      // decision could land and asking would re-pay the classification and
      // re-settle the comment on every poll. The manual Review label is the
      // exception: it carries its own override decision.
      const trustedAuthor = repository.writablePullRequestAuthors.some(author => author.toLowerCase() === subject.author.toLowerCase())
      const approvalRequired = dependencies.store.getSelectionMode() === 'manual' || !trustedAuthor
      if (approvalRequired && !subject.approvalLabels.includes('review'))
        return null
      return dependencies.pullRequestTriage?.verdict(repository, subject, triageSignal)
    }))
    eligibleItems.forEach((subject, index) => {
      const verdict = verdicts[index]
      if (verdict !== null && verdict !== undefined)
        triageVerdicts.set(subject.number, verdict)
    })
  }
  // Issue triage classification decides at observation time too. A Revision
  // with a stored route needs no second decision, so only new content pays
  // for the read and the classification.
  const issueDecisions = new Map<number, IssueClassificationDecision>()
  /** Routed decisions to settle: fresh ones, plus stored ones a failed settle left behind. */
  const settleResults = new Map<number, Extract<IssueClassificationDecision, { _tag: 'Routed' }>['result']>()
  if (writesEnabled && dependencies.issueClassification !== undefined) {
    await Promise.all(eligibleItems.map(async (subject) => {
      // An external repository is watched, never acted in: its issues carry
      // no local decision row, so classifying them would publish comments
      // there and repeat the ask forever.
      if (subject.kind !== 'issue' || subject.state !== 'open' || !repository.issueWork || !repository.enabled || repository.ownership === 'external' || subject.routineTracking)
        return
      const revisionId = revisionIdFor(subject)
      const stored = dependencies.store.getLatestIssueTriageRun(repository.github, subject.number, revisionId)
      if (stored !== null) {
        // A stored routed decision settles again until its comment and label
        // land; an Agent-kept Revision needs nothing here, and an Agent
        // answer outranks both.
        if (stored._tag === 'Routed' && !dependencies.store.hasIssueTriageEvidence(repository.github, subject.number, revisionId))
          settleResults.set(subject.number, stored.result)
        return
      }
      if (dependencies.store.hasIssueTriageEvidence(repository.github, subject.number, revisionId))
        return
      const decision = await dependencies.issueClassification?.verdict(repository, subject, dependencies.signal ?? AbortSignal.timeout(30_000))
      if (decision !== undefined)
        issueDecisions.set(subject.number, decision)
    }))
  }
  const eligibleWrites = eligibleItems.map((subject) => {
    const verdict = subject.kind === 'pull_request' ? triageVerdicts.get(subject.number) : undefined
    const issueDecision = subject.kind === 'issue' ? issueDecisions.get(subject.number) : undefined
    return dependencies.store.recordObservation({
      externalId: observationId(repository.github, subject),
      observedAt,
      source: 'poll',
      subject,
      ...(verdict === undefined
        ? {}
        : {
            pullRequestTriage: verdict.decision,
            ...(verdict.files === null ? {} : { pullRequestFiles: verdict.files }),
          }),
      ...(issueDecision === undefined ? {} : { issueTriage: issueDecision }),
    })
  })
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

  // The decision rows landed with the observations above, so the visible half
  // of each decision can follow. A failure here retries on the next poll,
  // because the stored decision is reused and settled again.
  if (writesEnabled && dependencies.pullRequestTriage !== undefined) {
    const settled = await Promise.all(eligibleItems.map((subject, index) => {
      if (subject.kind !== 'pull_request')
        return Promise.resolve(ok(undefined))
      const verdict = triageVerdicts.get(subject.number)
      const write = eligibleWrites[index]
      if (verdict === undefined || write === undefined || (write._tag !== 'Inserted' && write._tag !== 'Duplicate'))
        return Promise.resolve(ok(undefined))
      return dependencies.pullRequestTriage?.settle(repository, subject, verdict.decision, dependencies.signal ?? AbortSignal.timeout(30_000)) ?? Promise.resolve(ok(undefined))
    }))
    // A failed settle records the failure and lets the pass continue: the
    // decision row landed with the observation, the settle retries from it on
    // the next poll, and Approvals and Auto merge are independent of it.
    const failedSettle = settled.find(result => result._tag === 'Err')
    if (failedSettle?._tag === 'Err' && dependencies.signal?.aborted !== true)
      dependencies.store.recordPollFailure(repository.github, observedAt, failedSettle.error)
  }

  // A routed Issue triage decision publishes its comment and label after the
  // row landed with the observation. A fresh decision settles only when its
  // observation landed: a Stale or Conflicting write recorded no row, so
  // publishing its comment would put a verdict on GitHub the journal never
  // held. A stored row settles by definition, because the row is what
  // retries.
  if (writesEnabled && dependencies.issueClassification !== undefined) {
    eligibleItems.forEach((subject, index) => {
      if (subject.kind !== 'issue')
        return
      const decision = issueDecisions.get(subject.number)
      const write = eligibleWrites[index]
      if (decision !== undefined && decision._tag === 'Routed' && (write?._tag === 'Inserted' || write?._tag === 'Duplicate'))
        settleResults.set(subject.number, decision.result)
    })
    const settledIssues = await Promise.all(eligibleItems.map((subject) => {
      if (subject.kind !== 'issue')
        return Promise.resolve(ok(undefined))
      const result = settleResults.get(subject.number)
      if (result === undefined)
        return Promise.resolve(ok(undefined))
      return dependencies.issueClassification?.settle(repository, subject, result, dependencies.signal ?? AbortSignal.timeout(30_000)) ?? Promise.resolve(ok(undefined))
    }))
    const failedIssueSettle = settledIssues.find(result => result._tag === 'Err')
    if (failedIssueSettle?._tag === 'Err') {
      if (dependencies.signal?.aborted !== true)
        dependencies.store.recordPollFailure(repository.github, observedAt, failedIssueSettle.error)
      return err({ repository: repository.github, message: failedIssueSettle.error })
    }
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

  const reviewGates = writesEnabled && dependencies.refreshReviewGates !== undefined
    ? await dependencies.refreshReviewGates(repository, dependencies.signal ?? AbortSignal.timeout(30_000))
    : ok(undefined)

  if (writesEnabled && reviewGates._tag === 'Ok' && dependencies.autoMerge !== undefined) {
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
