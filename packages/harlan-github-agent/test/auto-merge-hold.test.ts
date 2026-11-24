import type { AutoMergeControllerOptions } from '../src/auto-merge-controller.ts'
import type { MergeRisk } from '../src/merge-risk.ts'
import type { GitHubPullRequestItem, RepositoryAutoMergeScope, RepositoryMapping, ReviewGates } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { createAutoMergeController, openJournalStore } from '../src/index.ts'
import { ok } from '../src/result.ts'
import { changedLinesSource, pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: ReturnType<typeof openJournalStore>[] = []
afterEach(() => stores.splice(0).forEach(store => store.close()))

const started = '2026-11-25T01:00:00.000Z'
const changed = '2026-11-25T01:01:00.000Z'
const range = { from: '2026-11-25T00:00:00.000Z', to: '2026-11-26T00:00:00.000Z' }
const gates: ReviewGates = {
  merge: { _tag: 'Passed', evidence: [] },
  review: { _tag: 'Passed', evidence: [] },
  ci: { _tag: 'Passed', evidence: [] },
}

const containedScope: RepositoryAutoMergeScope = {
  _tag: 'Contained',
  labelOverridesRisk: true,
  minimumConfidence: 90,
  policy: { containedPaths: [], maximumChangedFiles: 12, maximumChangedLines: 300, requireTestChange: false, sensitivePaths: [] },
}

/** One pull request whose current head has a published READY Review, and a controller to reconcile it. */
function reviewedHead(input: {
  confidence: number
  labelled: boolean
  scope?: RepositoryAutoMergeScope
  mergeRisk?: MergeRisk
}) {
  const store = openJournalStore(':memory:', true)
  stores.push(store)
  const repository: RepositoryMapping = repositoryMapping(input.scope === undefined ? {} : { autoMerge: input.scope })
  const pullRequest = pullRequestItem({ autoMerge: input.labelled, mergeState: 'clean' })
  store.syncRepositories([repository], started)
  store.setRepositoryWritesEnabled(repository.github, true)
  const observation = store.recordObservation({ externalId: 'initial', observedAt: started, source: 'poll', subject: pullRequest })
  if (observation._tag !== 'Inserted')
    throw new Error('Expected the pull request Revision.')
  const task = store.claimNextAdversarialReviewTask('reviewer', started, 60_000)
  if (task === null)
    throw new Error('Expected a Review task.')
  const recorded = store.recordReviewRun({
    id: 'review',
    repository: repository.github,
    pullRequestNumber: pullRequest.number,
    revisionId: observation.revisionId,
    headSha: pullRequest.headSha,
    provider: 'codex',
    sessionId: 'session',
    model: 'gpt-5.6-sol',
    agentVersion: '0.0.0',
    skillDigest: 'd'.repeat(64),
    startedAt: started,
    completedAt: started,
    gates,
    confidence: input.confidence,
    findings: [],
    ...(input.mergeRisk === undefined ? {} : { mergeRisk: { claim: input.mergeRisk, combined: input.mergeRisk, floor: input.mergeRisk } }),
  })
  if (recorded._tag !== 'Inserted')
    throw new Error(`Expected the Review run: ${JSON.stringify(recorded)}`)
  expect(store.completeReviewTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: started, evidence: 'review', resolution: { _tag: 'Reviewed', reviewRunId: 'review' } })).toBe(true)
  const staged = store.stageReviewGateStatus({
    reviewRunId: 'review',
    repository: repository.github,
    pullRequestNumber: pullRequest.number,
    revisionId: observation.revisionId,
    expectedHeadSha: pullRequest.headSha,
    gates,
    body: 'READY',
    desiredOutcome: 'READY',
    at: started,
  })
  if (staged._tag === 'Rejected')
    throw new Error(staged.reason)
  const command = store.claimNextTerminalReviewStatus('publisher', started, 60_000)
  if (command === null)
    throw new Error('Expected the READY status command.')
  expect(store.completeReviewStatus({ commandId: command.id, workerId: command.workerId, fence: command.fence, at: started, commentId: 42, url: pullRequest.url })).toBe(true)

  const merges: string[] = []
  const options: AutoMergeControllerOptions = {
    changedLines: changedLinesSource(),
    merger: {
      merge: async (request) => {
        merges.push(request.expectedHeadSha)
        return ok({ _tag: 'AutoMergeEnabled' })
      },
      retargetMergedParent: async () => ok(false),
    },
    now: () => new Date(changed),
    policy: { _tag: 'Enabled', minimumConfidence: 90, method: 'squash' },
    report: () => undefined,
    store,
  }
  return {
    store,
    merges,
    observe: (overrides: Partial<GitHubPullRequestItem>) => store.recordObservation({ externalId: `changed-${JSON.stringify(overrides)}`, observedAt: changed, source: 'poll', subject: { ...pullRequest, ...overrides } }),
    /** Replaces the stored repository policy. The controller still receives the mapping it started with. */
    storePolicy: (autoMerge: RepositoryAutoMergeScope) => store.syncRepositories([{ ...repository, autoMerge }], changed),
    /** A fresh controller each time, as after a Service restart. */
    reconcile: () => createAutoMergeController(options).reconcile(repository, pullRequest, new AbortController().signal),
    holds: () => store.listTrialAutoMergeHolds(range),
  }
}

describe('auto merge hold record', () => {
  it('records a hold once per head and reason, however often it reconciles', async () => {
    const test = reviewedHead({ confidence: 85, labelled: true })
    await test.reconcile()
    await test.reconcile()
    await test.reconcile()

    expect(test.merges).toEqual([])
    expect(test.holds()).toEqual({
      holds: [{ repository: 'harlan-zw/example', pullRequestNumber: 24, headSha: 'abc123', cause: 'BelowConfidence', heldOnlyByLabel: false, occurredAt: changed }],
      unreadable: 0,
    })

    // The same head held for a second reason is a second record.
    test.observe({ mergeState: 'conflicting' })
    await test.reconcile()
    await test.reconcile()
    expect(test.holds().holds.map(hold => [hold.headSha, hold.cause])).toEqual([['abc123', 'BelowConfidence'], ['abc123', 'NotMergeable']])
  })

  it('records nothing when Auto merge hands the head to GitHub', async () => {
    const test = reviewedHead({ confidence: 95, labelled: true })
    await test.reconcile()

    expect(test.merges).toEqual(['abc123'])
    expect(test.holds()).toEqual({ holds: [], unreadable: 0 })
  })

  it('records nothing for a pull request outside Auto merge', async () => {
    const test = reviewedHead({ confidence: 85, labelled: false })
    await test.reconcile()

    expect(test.merges).toEqual([])
    expect(test.holds()).toEqual({ holds: [], unreadable: 0 })
  })

  it('records nothing once the stored policy no longer makes the pull request a candidate', async () => {
    // The poll still passes the `every` mapping, but the stored policy now needs the label.
    const test = reviewedHead({ confidence: 85, labelled: false, scope: { _tag: 'Every', minimumConfidence: 90 } })
    test.storePolicy({ _tag: 'Labelled', minimumConfidence: null })
    await test.reconcile()

    expect(test.merges).toEqual([])
    expect(test.holds()).toEqual({ holds: [], unreadable: 0 })
  })

  it('records when the label alone held a READY head', async () => {
    const test = reviewedHead({ confidence: 100, labelled: false, scope: containedScope, mergeRisk: { _tag: 'Reviewable', reason: 'it changes a shared default in a private module' } })
    await test.reconcile()

    expect(test.merges).toEqual([])
    expect(test.holds().holds).toEqual([expect.objectContaining({ cause: 'MergeRiskNotContained', heldOnlyByLabel: true })])
  })

  it('does not credit the label when it could not have merged the head', async () => {
    const test = reviewedHead({
      confidence: 100,
      labelled: false,
      scope: { ...containedScope, labelOverridesRisk: false },
      mergeRisk: { _tag: 'Sensitive', reason: 'it runs a migration' },
    })
    await test.reconcile()

    expect(test.holds().holds).toEqual([expect.objectContaining({ cause: 'SensitiveMergeRisk', heldOnlyByLabel: false })])
  })

  it('never counts a hold as a workflow failure', async () => {
    const test = reviewedHead({ confidence: 85, labelled: true })
    await test.reconcile()

    expect(test.store.groupWorkflowFailures({ since: range.from })).toEqual([])
    expect(test.store.listWorkflowEvents({ since: range.from, failures: true })).toEqual([])
    expect(test.store.summarizeWorkflowEvents({ since: range.from }).find(row => row.event === 'auto_merge_hold')).toMatchObject({ count: 1, failed: 0 })
  })
})
