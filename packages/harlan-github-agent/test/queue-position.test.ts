import type { ReviewGates } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []

afterEach(() => {
  stores.splice(0).forEach(store => store.close())
})

function createStore() {
  const store = openJournalStore(':memory:')
  stores.push(store)
  store.syncRepositories([repositoryMapping()], '2026-08-13T00:00:00.000Z')
  return store
}

function passedReviewGates(): ReviewGates {
  return {
    head: { _tag: 'Passed', evidence: [{ label: 'head', sha256: 'a'.repeat(64) }] },
    merge: { _tag: 'Passed', evidence: [{ label: 'mergeability', sha256: 'b'.repeat(64) }] },
    metadata: { _tag: 'Passed', evidence: [] },
    review: { _tag: 'Failed', reason: 'A material finding remains.', evidence: [] },
    verification: { _tag: 'Passed', evidence: [{ label: 'tests', sha256: 'd'.repeat(64) }] },
    ci: { _tag: 'Passed', evidence: [{ label: 'required-ci', sha256: 'e'.repeat(64) }] },
  }
}

/**
 * One pull request carried to the exact state the sweep reads: a Review that
 * published its canonical comment, then queued a Repair behind it.
 */
function queuedRepair(store: ReturnType<typeof openJournalStore>, number: number, at: string): { commentId: number, body: string } {
  const observed = store.recordObservation({
    externalId: `queue-position-${number}`,
    observedAt: at,
    source: 'poll',
    subject: pullRequestItem({
      number,
      headRef: `fix/thing-${number}`,
      headSha: `head${number}`,
      mergeState: 'clean',
      url: `https://github.com/harlan-zw/example/pull/${number}`,
    }),
  })
  if (observed._tag !== 'Inserted')
    throw new Error('Expected a new pull request revision.')
  const review = store.claimNextAdversarialReviewTask(`review-agent-${number}`, at, 600_000)
  if (review === null)
    throw new Error('Expected the review Task.')

  const body = `### 🤖 REVIEWING · Repair queued for ${number}`
  const staged = store.stageReviewStatus({
    taskKind: 'adversarial_review',
    phase: 'review',
    taskId: review.id,
    workerId: review.state.workerId,
    fence: review.state.fence,
    at,
    revisionId: observed.revisionId,
    expectedHeadSha: review.pullRequest.headSha,
    body,
  })
  if (staged._tag === 'Rejected')
    throw new Error(staged.reason)
  const command = store.claimReviewStatus(staged.commandId, `status-worker-${number}`, at, 60_000)
  if (command === null)
    throw new Error('Expected the review status command.')
  const commentId = 100 + number
  store.completeReviewStatus({
    commandId: command.id,
    workerId: command.workerId,
    fence: command.fence,
    at,
    commentId,
    url: `https://github.com/harlan-zw/example/pull/${number}#issuecomment-${commentId}`,
  })

  store.recordReviewRun({
    id: `review-run-${number}`,
    repository: 'harlan-zw/example',
    pullRequestNumber: number,
    revisionId: observed.revisionId,
    headSha: review.pullRequest.headSha,
    provider: 'codex',
    sessionId: `queue-position-session-${number}`,
    model: 'gpt-5.6',
    agentVersion: '1.2.3',
    skillDigest: 'f'.repeat(64),
    startedAt: at,
    completedAt: at,
    gates: passedReviewGates(),
    findings: [{
      _tag: 'Open',
      summary: 'Unsafe parser input.',
      nextAction: 'Parse input before use.',
      resolution: 'Repair',
      details: {
        fingerprint: 'f'.repeat(64),
        identity: 'unsafe-parser-input',
        location: { path: 'src/parser.ts', line: 42 },
        proof: 'Malformed input reaches the unsafe parser branch.',
        regressionTest: 'Pass malformed input and assert a tagged rejection.',
      },
    }],
  })
  const queued = store.queueReviewFixTaskForReview({
    taskId: review.id,
    workerId: review.state.workerId,
    fence: review.state.fence,
    at,
  })
  if (queued._tag !== 'Queued')
    throw new Error(`Expected a queued Repair, received ${queued._tag}.`)
  store.completeWorkerTask({
    taskId: review.id,
    workerId: review.state.workerId,
    fence: review.state.fence,
    at,
    evidence: `review-run-${number}`,
  })
  return { commentId, body }
}

describe('listQueuedReviewStatuses', () => {
  it('numbers every queued Repair in the order an agent claims them', () => {
    const store = createStore()
    const first = queuedRepair(store, 24, '2026-08-13T01:00:00.000Z')
    const second = queuedRepair(store, 25, '2026-08-13T02:00:00.000Z')

    expect(store.listQueuedReviewStatuses()).toEqual([
      expect.objectContaining({ pullRequestNumber: 24, position: 1, total: 2, commentId: first.commentId, publishedBody: first.body }),
      expect.objectContaining({ pullRequestNumber: 25, position: 2, total: 2, commentId: second.commentId, publishedBody: second.body }),
    ])
  })

  it('agrees with the claim, so position 1 is the Task the next agent takes', () => {
    const store = createStore()
    queuedRepair(store, 24, '2026-08-13T01:00:00.000Z')
    queuedRepair(store, 25, '2026-08-13T02:00:00.000Z')

    const claimed = store.claimNextReviewFixTask('repair-agent', '2026-08-13T03:00:00.000Z', 60_000)
    expect(claimed?.pullRequestNumber).toBe(24)
    expect(store.listQueuedReviewStatuses()).toEqual([
      expect.objectContaining({ pullRequestNumber: 25, position: 1, total: 1 }),
    ])
  })

  it('takes over an Approval prompt the person has already answered', () => {
    const store = createStore()
    const observed = store.recordObservation({
      externalId: 'approval-prompt-30',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({
        number: 30,
        author: 'contributor',
        headRef: 'fix/from-contributor',
        headSha: 'head30',
        mergeState: 'clean',
        url: 'https://github.com/harlan-zw/example/pull/30',
      }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    // No Task exists while the pull request waits for Approval, so the prompt
    // is the only comment on it and nothing owns it yet.
    expect(store.listQueuedReviewStatuses()).toEqual([])
    expect(store.recordApprovalPromptComment({
      repository: 'harlan-zw/example',
      pullRequestNumber: 30,
      revisionId: observed.revisionId,
      commentId: 900,
      body: '### 🤖 REVIEW PAUSED',
      at: '2026-08-13T01:00:01.000Z',
    })).toBe(true)

    expect(store.approvePullRequest({
      repository: 'harlan-zw/example',
      pullRequestNumber: 30,
      revisionId: observed.revisionId,
      kind: 'review',
      at: '2026-08-13T01:00:02.000Z',
    })._tag).toBe('Approved')

    expect(store.listQueuedReviewStatuses()).toEqual([
      expect.objectContaining({
        taskKind: 'adversarial_review',
        pullRequestNumber: 30,
        position: 1,
        total: 1,
        commentId: 900,
        publishedBody: '### 🤖 REVIEW PAUSED',
      }),
    ])
  })

  it('says nothing about a Task no agent can claim', () => {
    const store = createStore()
    queuedRepair(store, 24, '2026-08-13T01:00:00.000Z')
    store.setRepositoryPaused('harlan-zw/example', true)

    expect(store.listQueuedReviewStatuses()).toEqual([])
    expect(store.claimNextReviewFixTask('repair-agent', '2026-08-13T03:00:00.000Z', 60_000)).toBeNull()
  })
})

describe('recordQueuedReviewStatus', () => {
  it('becomes what the next pass compares against, so a still Queue writes nothing', () => {
    const store = createStore()
    queuedRepair(store, 24, '2026-08-13T01:00:00.000Z')
    const status = store.listQueuedReviewStatuses()[0]!

    expect(store.recordQueuedReviewStatus({
      taskId: status.taskId,
      taskKind: status.taskKind,
      revisionId: status.revisionId,
      expectedHeadSha: status.headSha,
      body: '### 🤖 QUEUED · 1st of 1',
      at: '2026-08-13T01:05:00.000Z',
      commentId: status.commentId,
      url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-124',
    })).toBe(true)
    expect(store.listQueuedReviewStatuses()).toEqual([
      expect.objectContaining({ publishedBody: '### 🤖 QUEUED · 1st of 1', commentId: 124 }),
    ])
  })

  it('refuses once an agent has claimed the Task, because the comment is the agent to write', () => {
    const store = createStore()
    queuedRepair(store, 24, '2026-08-13T01:00:00.000Z')
    const status = store.listQueuedReviewStatuses()[0]!
    store.claimNextReviewFixTask('repair-agent', '2026-08-13T01:04:00.000Z', 60_000)

    expect(store.recordQueuedReviewStatus({
      taskId: status.taskId,
      taskKind: status.taskKind,
      revisionId: status.revisionId,
      expectedHeadSha: status.headSha,
      body: '### 🤖 QUEUED · 1st of 1',
      at: '2026-08-13T01:05:00.000Z',
      commentId: status.commentId,
      url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-124',
    })).toBe(false)
  })
})
