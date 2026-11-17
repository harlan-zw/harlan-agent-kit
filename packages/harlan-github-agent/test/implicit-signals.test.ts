import type { GitHubPullRequestItem, ReviewGates } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { terminalComment } from '../src/item-agent.ts'
import { openJournalStore } from '../src/store.ts'
import { issueItem, pullRequestItem, repositoryMapping } from './fixtures.ts'

type Store = ReturnType<typeof openJournalStore>

const stores: Store[] = []
afterEach(() => {
  stores.splice(0).forEach(store => store.close())
})

const ALL = { kinds: ['HumanCommit', 'ClosedUnmerged', 'MergedUntouched', 'LoggedFindingPickedUp'] as const, limitPerKind: 10 }
const passed: ReviewGates = { merge: { _tag: 'Passed', evidence: [] }, review: { _tag: 'Passed', evidence: [] }, ci: { _tag: 'Passed', evidence: [] } }
const blocked: ReviewGates = { ...passed, review: { _tag: 'Failed', reason: 'An Open Review finding.', evidence: [] } }

function at(minute: number): string {
  return new Date(Date.parse('2026-08-13T01:00:00.000Z') + minute * 60_000).toISOString()
}

function setup(): Store {
  const store = openJournalStore(':memory:')
  stores.push(store)
  store.syncRepositories([repositoryMapping()], at(0))
  return store
}

function observe(store: Store, minute: number, overrides: Partial<GitHubPullRequestItem>): { revisionId: string, subject: GitHubPullRequestItem } {
  const subject = pullRequestItem({ mergeState: 'clean', updatedAt: at(minute), ...overrides })
  const write = store.recordPollObservation({ observedAt: at(minute), subject })
  if (write._tag !== 'Inserted' && write._tag !== 'Duplicate')
    throw new Error(`Expected a recorded pull request: ${JSON.stringify(write)}`)
  return { revisionId: write.revisionId, subject }
}

function review(store: Store, id: string, minute: number, observed: { revisionId: string, subject: GitHubPullRequestItem }, gates = passed): void {
  store.recordReviewRun({
    id,
    repository: observed.subject.repository,
    pullRequestNumber: observed.subject.number,
    revisionId: observed.revisionId,
    headSha: observed.subject.headSha,
    provider: 'codex',
    sessionId: `session-${id}`,
    model: 'gpt-6.1-sol',
    agentVersion: '1',
    skillDigest: 'f'.repeat(64),
    startedAt: at(minute),
    completedAt: at(minute),
    gates,
    findings: [],
  })
}

function close(store: Store, minute: number, overrides: Partial<GitHubPullRequestItem>): boolean {
  const observed = observe(store, minute, { state: 'closed', ...overrides })
  return store.recordVerifiedPullRequestClosure({
    repository: observed.subject.repository,
    pullRequestNumber: observed.subject.number,
    revisionId: observed.revisionId,
    headSha: observed.subject.headSha,
    baseSha: observed.subject.baseSha,
    disposition: observed.subject.mergedAt === null ? { _tag: 'Closed' } : { _tag: 'Merged' },
    at: at(minute),
  })
}

describe('human commit after READY', () => {
  it('records one signal for each READY Review run a later head replaced', () => {
    const store = setup()
    review(store, 'review-a', 2, observe(store, 1, { headSha: 'head-a' }))

    observe(store, 3, { headSha: 'head-b' })
    observe(store, 4, { headSha: 'head-c' })

    expect(store.listImplicitSignals(ALL)).toEqual([expect.objectContaining({
      _tag: 'HumanCommit',
      repository: 'harlan-zw/example',
      pullRequestNumber: 24,
      headSha: 'head-b',
      occurredAt: at(3),
      openedBy: null,
      reviewRun: { id: 'review-a', headSha: 'head-a', outcome: expect.objectContaining({ _tag: 'Ready' }) },
    })])
  })

  it('records nothing when the latest Review run was not READY', () => {
    const store = setup()
    review(store, 'review-a', 2, observe(store, 1, { headSha: 'head-a' }), blocked)

    observe(store, 3, { headSha: 'head-b' })

    expect(store.listImplicitSignals(ALL)).toEqual([])
  })

  it('records nothing when the service published the new head', () => {
    const store = setup()
    const conflicting = observe(store, 1, { headSha: 'head-a', mergeState: 'conflicting' })
    review(store, 'review-a', 2, conflicting)
    const task = store.claimNextConflictTask('repair-agent', at(3), 10 * 60_000)
    if (task === null)
      throw new Error('Expected conflict resolution work.')
    const staged = store.stagePublication({
      taskId: task.id,
      workerId: task.state.workerId,
      fence: task.state.fence,
      at: at(4),
      publication: {
        _tag: 'UpdatePullRequest',
        taskKind: 'resolve_conflict',
        pullRequestNumber: task.pullRequestNumber,
        commitSha: 'service-head',
        baseSha: task.pullRequest.baseSha,
        baseRef: task.pullRequest.baseRef ?? 'main',
        expectedHeadSha: 'head-a',
        headRef: task.pullRequest.headRef,
        artifactRef: 'refs/harlan-github-agent/publications/signal-conflict',
        patchDigest: 'signal-patch',
        changedFiles: 1,
      },
    })
    if (staged._tag !== 'Staged')
      throw new Error(`Expected a staged Publication: ${JSON.stringify(staged)}`)

    observe(store, 5, { headSha: 'service-head' })

    expect(store.listImplicitSignals(ALL)).toEqual([])
  })
})

describe('closed without merge', () => {
  it('records a verified close on a reviewed pull request', () => {
    const store = setup()
    review(store, 'review-a', 2, observe(store, 1, { headSha: 'head-a' }), blocked)

    expect(close(store, 3, { headSha: 'head-a' })).toBe(true)

    expect(store.listImplicitSignals(ALL)).toEqual([expect.objectContaining({
      _tag: 'ClosedUnmerged',
      headSha: 'head-a',
      occurredAt: at(3),
      reviewRun: expect.objectContaining({ id: 'review-a', outcome: { _tag: 'Blocked' } }),
    })])
  })

  it('records nothing for a closure the service only inferred from the open list', () => {
    const store = setup()
    review(store, 'review-a', 2, observe(store, 1, { headSha: 'head-a' }))

    store.closeMissingItems('harlan-zw/example', [], at(3))

    expect(store.listImplicitSignals(ALL)).toEqual([])
  })

  it('records nothing on a pull request the service neither opened nor reviewed', () => {
    const store = setup()
    observe(store, 1, { headSha: 'head-a' })

    expect(close(store, 2, { headSha: 'head-a' })).toBe(true)

    expect(store.listImplicitSignals(ALL)).toEqual([])
  })
})

describe('merged untouched', () => {
  it('records a merge of the service head that opened the pull request, once', () => {
    const store = setup()
    store.setRepositoryWritesEnabled('harlan-zw/example', true)
    store.recordPollObservation({ observedAt: at(1), subject: issueItem({ author: 'harlan-zw' }) })
    const triage = store.claimNextIssueTriageTask('triage', at(2), 600_000)
    if (triage === null)
      throw new Error('Expected Issue triage.')
    store.completeWorkerTask({ taskId: triage.id, workerId: 'triage', fence: triage.state.fence, at: at(3), evidence: JSON.stringify({ _tag: 'READY_TO_IMPLEMENT' }) })
    const task = store.claimNextIssueWorkTask('implementer', at(4), 600_000)
    if (task === null)
      throw new Error('Expected Issue work.')
    const staged = store.stagePublication({ taskId: task.id, workerId: 'implementer', fence: task.state.fence, at: at(5), publication: {
      _tag: 'OpenPullRequest',
      taskKind: 'issue_work',
      issueNumber: 12,
      pullRequestTitle: 'fix: repair the issue',
      pullRequestBody: 'Closes #12.',
      diagram: null,
      commitSha: 'service-head',
      baseSha: 'base123',
      baseRef: 'main',
      expectedHeadSha: 'base123',
      headRef: 'fix/issue-12',
      artifactRef: 'refs/artifact',
      patchDigest: 'digest',
      changedFiles: 1,
    } })
    expect(staged._tag).toBe('Staged')
    const command = store.claimNextPublication('publisher', at(6), 600_000)
    if (command === null)
      throw new Error('Expected the Publication command.')
    expect(store.completePublication({ commandId: command.id, workerId: 'publisher', fence: command.fence, at: at(7), evidence: 'Opened pull request #24.', pullRequestNumber: 24 })).toBe(true)
    observe(store, 8, { headSha: 'service-head', headRef: 'fix/issue-12', author: 'harlan-github-agent[bot]', controllerOwned: true })

    expect(close(store, 9, { headSha: 'service-head', headRef: 'fix/issue-12', mergedAt: at(9), author: 'harlan-github-agent[bot]', controllerOwned: true })).toBe(true)
    expect(close(store, 10, { headSha: 'service-head', headRef: 'fix/issue-12', mergedAt: at(9), author: 'harlan-github-agent[bot]', controllerOwned: true })).toBe(true)

    expect(store.listImplicitSignals(ALL)).toEqual([expect.objectContaining({
      _tag: 'MergedUntouched',
      headSha: 'service-head',
      occurredAt: at(9),
      openedBy: 'issue_work',
      reviewRun: null,
    })])
    expect(store.listPaybackSignals({ from: at(0), to: at(60) })).toEqual([{ kind: 'MergedUntouched', openedBy: 'issue_work', reviewed: false }])
    expect(store.listPaybackSignals({ from: at(10), to: at(60) })).toEqual([])
  })

  it('records no merge as untouched after a head the service did not publish', () => {
    const store = setup()
    review(store, 'review-a', 2, observe(store, 1, { headSha: 'head-a' }), blocked)
    observe(store, 3, { headSha: 'head-b' })

    expect(close(store, 4, { headSha: 'head-b', mergedAt: at(4) })).toBe(true)

    expect(store.listImplicitSignals(ALL)).toEqual([])
  })
})

describe('logged finding picked up', () => {
  it('records the pickup with the Review run that logged the finding', () => {
    const store = openJournalStore(':memory:', true)
    stores.push(store)
    const mapping = repositoryMapping({ ownership: 'maintained' })
    store.syncRepositories([mapping], at(0))
    store.setRepositoryWritesEnabled(mapping.github, true)
    const finding = {
      _tag: 'Logged' as const,
      impact: 40,
      summary: 'The parser drops buffered bytes.',
      nextAction: 'Preserve buffered bytes between chunks.',
      details: { fingerprint: 'f'.repeat(64), identity: 'buffered bytes', location: { path: 'src/parser.ts', line: 42 }, proof: 'A split sequence loses bytes.' },
    }
    const pullRequest = pullRequestItem({ mergeState: 'clean', headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) })
    const observation = store.recordObservation({ externalId: 'open', observedAt: at(1), source: 'poll', subject: pullRequest })
    if (observation._tag !== 'Inserted')
      throw new Error('Expected a pull request.')
    const task = store.claimNextAdversarialReviewTask('reviewer', at(2), 60_000)
    if (task === null)
      throw new Error('Expected Review.')
    store.recordReviewRun({ id: 'review', repository: mapping.github, pullRequestNumber: pullRequest.number, revisionId: observation.revisionId, headSha: pullRequest.headSha, provider: 'codex', sessionId: 'session', model: 'model', agentVersion: 'version', skillDigest: 'c'.repeat(64), startedAt: at(2), completedAt: at(2), gates: passed, findings: [finding] })
    store.completeWorkerTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at: at(2), evidence: 'review' })
    const body = store.decorateLoggedFindings(terminalComment(pullRequest.headSha, pullRequest.baseSha, passed, [finding], 95, [], undefined, mapping.github), 'review')
    store.recordReviewPublication({ id: 'publication', reviewRunId: 'review', body, at: at(2), result: { _tag: 'Published', githubCommentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' } })
    const request = { repository: mapping.github, pullRequestNumber: pullRequest.number, headSha: pullRequest.headSha, commentId: 42, requestedBy: 'harlan-zw', commentAuthor: 'harlan-github-agent[bot]', fingerprints: [finding.details.fingerprint], before: body, requestId: 'delivery', at: at(3) }

    expect(store.requestLoggedFindingPickup(request)).toBe(true)
    expect(store.requestLoggedFindingPickup({ ...request, requestId: 'redelivery', at: at(4) })).toBe(true)

    expect(store.listImplicitSignals(ALL)).toEqual([expect.objectContaining({
      _tag: 'LoggedFindingPickedUp',
      headSha: pullRequest.headSha,
      occurredAt: at(3),
      reviewRun: expect.objectContaining({ id: 'review' }),
      finding,
    })])
  })
})

describe('listImplicitSignals', () => {
  it('returns the newest signals of each requested kind, newest first', () => {
    const store = setup()
    for (const number of [24, 25, 26]) {
      review(store, `review-${number}`, number, observe(store, number, { number, headSha: `head-${number}` }))
      observe(store, number + 10, { number, headSha: `next-${number}` })
    }
    expect(close(store, 40, { number: 26, headSha: 'next-26' })).toBe(true)

    expect(store.listImplicitSignals({ kinds: ['HumanCommit'], limitPerKind: 2 }).map(signal => signal.pullRequestNumber)).toEqual([26, 25])
    expect(store.listImplicitSignals({ kinds: ['HumanCommit', 'ClosedUnmerged'], limitPerKind: 1 }).map(signal => signal._tag)).toEqual(['ClosedUnmerged', 'HumanCommit'])
  })
})
