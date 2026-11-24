import type { ReviewGates } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { progressComment } from '../src/item-agent.ts'
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
    merge: { _tag: 'Passed', evidence: [{ label: 'mergeability', sha256: 'b'.repeat(64) }] },
    review: { _tag: 'Failed', reason: 'A material finding remains.', evidence: [] },
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
      expect.objectContaining({ pullRequestNumber: 24, queue: { _tag: 'Waiting', position: 1, total: 2 }, verdict: { _tag: 'Answered' }, commentId: first.commentId, publishedBody: first.body }),
      expect.objectContaining({ pullRequestNumber: 25, queue: { _tag: 'Waiting', position: 2, total: 2 }, commentId: second.commentId, publishedBody: second.body }),
    ])
  })

  it('names the Repair a queued Review is answering, so a re-review is not a bare QUEUED', () => {
    const store = createStore()
    queuedRepair(store, 30, '2026-08-13T01:00:00.000Z')
    const repair = store.claimNextReviewFixTask('repair-agent', '2026-08-13T01:01:00.000Z', 600_000)
    if (repair === null)
      throw new Error('Expected the Repair Task.')
    const repairCommit = 'd'.repeat(40)
    const stagedPublication = store.stagePublication({
      taskId: repair.id,
      workerId: repair.state.workerId,
      fence: repair.state.fence,
      at: '2026-08-13T01:02:00.000Z',
      publication: {
        _tag: 'UpdatePullRequest',
        taskKind: 'review_fix',
        baseRef: 'main',
        pullRequestNumber: repair.pullRequestNumber,
        commitSha: repairCommit,
        baseSha: repair.pullRequest.baseSha,
        expectedHeadSha: repair.pullRequest.headSha,
        headRef: repair.pullRequest.headRef,
        artifactRef: 'refs/harlan-github-agent/publications/queued-history',
        patchDigest: 'repair-patch',
        changedFiles: 1,
      },
    })
    if (stagedPublication._tag !== 'Staged')
      throw new Error(`stagePublication: ${JSON.stringify(stagedPublication)}`)
    const publication = store.claimNextPublication('publisher', '2026-08-13T01:03:00.000Z', 60_000)
    if (publication === null)
      throw new Error('Expected the Repair Publication.')
    expect(store.completePublication({
      commandId: publication.id,
      workerId: publication.workerId,
      fence: publication.fence,
      at: '2026-08-13T01:04:00.000Z',
      evidence: 'Published Repair commit.',
    })).toBe(true)

    // The Repair push becomes the next head, which queues a fresh Review.
    const repaired = store.recordObservation({
      externalId: 'queued-history-repaired-head',
      observedAt: '2026-08-13T01:05:00.000Z',
      source: 'poll',
      subject: pullRequestItem({
        number: 30,
        headRef: 'fix/thing-30',
        headSha: repairCommit,
        mergeState: 'clean',
        url: 'https://github.com/harlan-zw/example/pull/30',
        updatedAt: '2026-08-13T01:05:00.000Z',
      }),
    })
    if (repaired._tag !== 'Inserted')
      throw new Error('Expected the Repair push to create a new Revision.')

    expect(store.listQueuedReviewStatuses()).toEqual([
      expect.objectContaining({
        pullRequestNumber: 30,
        taskKind: 'adversarial_review',
        history: {
          _tag: 'AfterRepair',
          priorHeadSha: 'head30',
          priorOutcome: 'Blocked',
          findings: 1,
        },
      }),
    ])
    // The running Review reads the same history, so its comment names the Repair too.
    expect(store.priorReviewHistory(repaired.revisionId)).toEqual({
      _tag: 'AfterRepair',
      priorHeadSha: 'head30',
      priorOutcome: 'Blocked',
      findings: 1,
    })

    // Once the Review of the Repair commit is recorded, the newest run answers this head,
    // so the history reads FirstReview. The Repair's own source Review still names what it fixed.
    const rereview = store.claimNextAdversarialReviewTask('review-agent-repaired', '2026-08-13T01:06:00.000Z', 600_000)
    if (rereview === null)
      throw new Error('Expected the Review of the Repair commit.')
    store.recordReviewRun({
      id: 'review-run-repaired',
      repository: 'harlan-zw/example',
      pullRequestNumber: 30,
      revisionId: repaired.revisionId,
      headSha: repairCommit,
      provider: 'codex',
      sessionId: 'queue-position-session-repaired',
      model: 'gpt-5.6',
      agentVersion: '1.2.3',
      skillDigest: 'f'.repeat(64),
      startedAt: '2026-08-13T01:07:00.000Z',
      completedAt: '2026-08-13T01:07:00.000Z',
      gates: { merge: passedReviewGates().merge, review: { _tag: 'Passed', evidence: [] }, ci: passedReviewGates().ci },
      findings: [],
    })
    expect(store.priorReviewHistory(repaired.revisionId)).toEqual({ _tag: 'FirstReview' })
    expect(store.repairSource(repaired.revisionId)).toEqual({ headSha: 'head30', builtOnHeadSha: 'head30', fingerprints: ['f'.repeat(64)] })
    expect(store.repairSource(store.listReviewRuns('harlan-zw/example', 30).find(run => run.headSha === 'head30')!.revisionId)).toBeNull()
  })

  it('agrees with the claim, so position 1 is the Task the next agent takes', () => {
    const store = createStore()
    queuedRepair(store, 24, '2026-08-13T01:00:00.000Z')
    queuedRepair(store, 25, '2026-08-13T02:00:00.000Z')

    const claimed = store.claimNextReviewFixTask('repair-agent', '2026-08-13T03:00:00.000Z', 60_000)
    expect(claimed?.pullRequestNumber).toBe(24)
    expect(store.listQueuedReviewStatuses()).toEqual([
      expect.objectContaining({ pullRequestNumber: 25, queue: { _tag: 'Waiting', position: 1, total: 1 } }),
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
        queue: { _tag: 'Waiting', position: 1, total: 1 },
        commentId: 900,
        publishedBody: '### 🤖 REVIEW PAUSED',
      }),
    ])
  })

  it('answers the Approval prompt per head commit, not per Revision', () => {
    const store = createStore()
    const contributorPullRequest = (headSha: string, title: string) => pullRequestItem({
      number: 30,
      author: 'contributor',
      headRef: 'fix/from-contributor',
      headSha,
      mergeState: 'clean',
      title,
      url: 'https://github.com/harlan-zw/example/pull/30',
    })
    const observed = store.recordObservation({
      externalId: 'approval-prompt-head30',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: contributorPullRequest('head30', 'Bound a start tag'),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    expect(store.hasApprovalPromptComment('harlan-zw/example', 30, observed.revisionId)).toBe(false)
    expect(store.recordApprovalPromptComment({
      repository: 'harlan-zw/example',
      pullRequestNumber: 30,
      revisionId: observed.revisionId,
      commentId: 900,
      body: '### 🤖 REVIEW PAUSED',
      at: '2026-08-13T01:00:01.000Z',
    })).toBe(true)
    expect(store.hasApprovalPromptComment('harlan-zw/example', 30, observed.revisionId)).toBe(true)

    // An edit that leaves the head commit alone keeps the prompt, so a later
    // poll asks GitHub for nothing.
    const edited = store.recordObservation({
      externalId: 'approval-prompt-head30-edited',
      observedAt: '2026-08-13T02:00:00.000Z',
      source: 'poll',
      subject: contributorPullRequest('head30', 'Bound a start tag by the bytes it retains'),
    })
    if (edited._tag !== 'Inserted')
      throw new Error('Expected the edit to create a new Revision.')
    expect(store.hasApprovalPromptComment('harlan-zw/example', 30, edited.revisionId)).toBe(true)

    // A force push is a new head commit. No prompt answers it, so the prompt
    // path clears the verdict label the old head left behind.
    const forcePushed = store.recordObservation({
      externalId: 'approval-prompt-head31',
      observedAt: '2026-08-13T03:00:00.000Z',
      source: 'poll',
      subject: contributorPullRequest('head31', 'Bound a start tag by the bytes it retains'),
    })
    if (forcePushed._tag !== 'Inserted')
      throw new Error('Expected the force push to create a new Revision.')
    expect(store.hasApprovalPromptComment('harlan-zw/example', 30, forcePushed.revisionId)).toBe(false)
  })

  it('reports the pause for a Task no agent can claim, so the comment stops claiming progress', () => {
    const store = createStore()
    queuedRepair(store, 24, '2026-08-13T01:00:00.000Z')
    store.setRepositoryPaused('harlan-zw/example', true)

    expect(store.listQueuedReviewStatuses()).toEqual([
      expect.objectContaining({ pullRequestNumber: 24, queue: { _tag: 'Paused' } }),
    ])
    expect(store.claimNextReviewFixTask('repair-agent', '2026-08-13T03:00:00.000Z', 60_000)).toBeNull()
  })

  it('reports every Task of a paused repository as paused, never as a Queue position', () => {
    const store = createStore()
    queuedRepair(store, 24, '2026-08-13T01:00:00.000Z')
    queuedRepair(store, 25, '2026-08-13T02:00:00.000Z')
    store.setRepositoryPaused('harlan-zw/example', true)

    expect(store.listQueuedReviewStatuses()).toEqual([
      expect.objectContaining({ pullRequestNumber: 24, queue: { _tag: 'Paused' } }),
      expect.objectContaining({ pullRequestNumber: 25, queue: { _tag: 'Paused' } }),
    ])
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

describe('isQueuedReviewStatus', () => {
  it('holds while the Task is Queued and breaks the moment an agent claims it', () => {
    const store = createStore()
    queuedRepair(store, 24, '2026-08-13T01:00:00.000Z')
    const status = store.listQueuedReviewStatuses()[0]!

    expect(store.isQueuedReviewStatus({ taskId: status.taskId, taskKind: status.taskKind })).toBe(true)
    store.claimNextReviewFixTask('repair-agent', '2026-08-13T01:04:00.000Z', 60_000)
    expect(store.isQueuedReviewStatus({ taskId: status.taskId, taskKind: status.taskKind })).toBe(false)
  })

  it('answers for the exact Task, not any Task of the same kind', () => {
    const store = createStore()

    expect(store.isQueuedReviewStatus({ taskId: 'missing-task', taskKind: 'review_fix' })).toBe(false)
  })
})

describe('listQueuedReviewStatuses across revisions', () => {
  it('takes over the Repair comment left on the head the Repair itself pushed', () => {
    const store = createStore()
    const review = queuedRepair(store, 24, '2026-08-13T01:00:00.000Z')
    const repair = store.claimNextReviewFixTask('repair-agent', '2026-08-13T01:10:00.000Z', 600_000)
    if (repair === null)
      throw new Error('Expected the Repair Task.')

    const progress = '### 🤖 REPAIR · Repair ready to publish'
    const staged = store.stageReviewStatus({
      taskKind: 'review_fix',
      phase: 'repair',
      taskId: repair.id,
      workerId: repair.state.workerId,
      fence: repair.state.fence,
      at: '2026-08-13T01:15:00.000Z',
      revisionId: repair.revisionId,
      expectedHeadSha: repair.pullRequest.headSha,
      body: progress,
    })
    if (staged._tag === 'Rejected')
      throw new Error(staged.reason)
    const command = store.claimReviewStatus(staged.commandId, 'status-worker', '2026-08-13T01:15:00.000Z', 60_000)
    if (command === null)
      throw new Error('Expected the Repair status command.')
    store.completeReviewStatus({
      commandId: command.id,
      workerId: command.workerId,
      fence: command.fence,
      at: '2026-08-13T01:15:00.000Z',
      commentId: review.commentId,
      url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-124',
    })
    expect(store.completeTask({
      taskId: repair.id,
      workerId: repair.state.workerId,
      fence: repair.state.fence,
      at: '2026-08-13T01:16:00.000Z',
      evidence: 'Published repaired24.',
    })).toBe(true)

    // The Repair push is the next head, so the comment it left behind belongs
    // to a Revision the pull request has moved past.
    const repaired = store.recordObservation({
      externalId: 'queue-position-24-repaired',
      observedAt: '2026-08-13T01:31:00.000Z',
      source: 'poll',
      subject: pullRequestItem({
        number: 24,
        headRef: 'fix/thing-24',
        headSha: 'repaired24',
        mergeState: 'clean',
        updatedAt: '2026-08-13T01:31:00.000Z',
        url: 'https://github.com/harlan-zw/example/pull/24',
      }),
    })
    if (repaired._tag !== 'Inserted')
      throw new Error('Expected the repaired head to be a new revision.')

    expect(store.listQueuedReviewStatuses()).toEqual([
      expect.objectContaining({
        taskKind: 'adversarial_review',
        pullRequestNumber: 24,
        headSha: 'repaired24',
        queue: { _tag: 'Waiting', position: 1, total: 1 },
        // No Review has read this head, so the verdict on the pull request is
        // still the one its previous head earned.
        verdict: { _tag: 'Unanswered' },
        commentId: review.commentId,
        publishedBody: progress,
      }),
    ])
  })
  it('takes over a Review comment the pull request left behind when a person pushed', () => {
    const store = createStore()
    const observed = store.recordObservation({
      externalId: 'queue-position-40',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({
        number: 40,
        headRef: 'fix/thing-40',
        headSha: 'head40',
        mergeState: 'clean',
        url: 'https://github.com/harlan-zw/example/pull/40',
      }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:00:00.000Z', 600_000)
    if (review === null)
      throw new Error('Expected the review Task.')

    const progress = '### 🤖 REVIEWING · Reading the diff'
    const staged = store.stageReviewStatus({
      taskKind: 'adversarial_review',
      phase: 'review',
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:05:00.000Z',
      revisionId: observed.revisionId,
      expectedHeadSha: 'head40',
      body: progress,
    })
    if (staged._tag === 'Rejected')
      throw new Error(staged.reason)
    const command = store.claimReviewStatus(staged.commandId, 'status-worker', '2026-08-13T01:05:00.000Z', 60_000)
    if (command === null)
      throw new Error('Expected the review status command.')
    store.completeReviewStatus({
      commandId: command.id,
      workerId: command.workerId,
      fence: command.fence,
      at: '2026-08-13T01:05:00.000Z',
      commentId: 140,
      url: 'https://github.com/harlan-zw/example/pull/40#issuecomment-140',
    })

    // The person pushes while the Review runs. The Review dies with its comment
    // still reading as though it were under way.
    const pushed = store.recordObservation({
      externalId: 'queue-position-40-pushed',
      observedAt: '2026-08-13T01:06:00.000Z',
      source: 'poll',
      subject: pullRequestItem({
        number: 40,
        headRef: 'fix/thing-40',
        headSha: 'head40b',
        mergeState: 'clean',
        updatedAt: '2026-08-13T01:06:00.000Z',
        url: 'https://github.com/harlan-zw/example/pull/40',
      }),
    })
    if (pushed._tag !== 'Inserted')
      throw new Error('Expected the pushed head to be a new revision.')

    expect(store.listQueuedReviewStatuses()).toEqual([
      expect.objectContaining({
        pullRequestNumber: 40,
        headSha: 'head40b',
        commentId: 140,
        publishedBody: progress,
      }),
    ])
  })

  it('leaves a finished Review comment alone, because it still answers the person', () => {
    const store = createStore()
    const observed = store.recordObservation({
      externalId: 'queue-position-41',
      observedAt: '2026-08-13T01:00:00.000Z',
      source: 'poll',
      subject: pullRequestItem({
        number: 41,
        headRef: 'fix/thing-41',
        headSha: 'head41',
        mergeState: 'clean',
        url: 'https://github.com/harlan-zw/example/pull/41',
      }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    const review = store.claimNextAdversarialReviewTask('review-agent', '2026-08-13T01:00:00.000Z', 600_000)
    if (review === null)
      throw new Error('Expected the review Task.')

    const staged = store.stageReviewStatus({
      taskKind: 'adversarial_review',
      phase: 'terminal',
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at: '2026-08-13T01:05:00.000Z',
      revisionId: observed.revisionId,
      expectedHeadSha: 'head41',
      body: '### 🤖 BLOCKED · One material finding',
    })
    if (staged._tag === 'Rejected')
      throw new Error(staged.reason)
    const command = store.claimReviewStatus(staged.commandId, 'status-worker', '2026-08-13T01:05:00.000Z', 60_000)
    if (command === null)
      throw new Error('Expected the review status command.')
    store.completeReviewStatus({
      commandId: command.id,
      workerId: command.workerId,
      fence: command.fence,
      at: '2026-08-13T01:05:00.000Z',
      commentId: 141,
      url: 'https://github.com/harlan-zw/example/pull/41#issuecomment-141',
    })

    const pushed = store.recordObservation({
      externalId: 'queue-position-41-pushed',
      observedAt: '2026-08-13T01:06:00.000Z',
      source: 'poll',
      subject: pullRequestItem({
        number: 41,
        headRef: 'fix/thing-41',
        headSha: 'head41b',
        mergeState: 'clean',
        updatedAt: '2026-08-13T01:06:00.000Z',
        url: 'https://github.com/harlan-zw/example/pull/41',
      }),
    })
    if (pushed._tag !== 'Inserted')
      throw new Error('Expected the pushed head to be a new revision.')

    expect(store.listQueuedReviewStatuses()).toEqual([])
  })
})

/**
 * One pull request whose Review published a progress comment, then failed.
 * The Task keeps the canonical comment, so the sweep is what tells the pull
 * request the attempt stopped.
 */
function failingReview(store: ReturnType<typeof openJournalStore>, number: number, at: string) {
  const observed = store.recordObservation({
    externalId: `failing-review-${number}`,
    observedAt: at,
    source: 'poll',
    subject: pullRequestItem({ number, headSha: `head${number}`, mergeState: 'clean' }),
  })
  if (observed._tag !== 'Inserted')
    throw new Error('Expected a new pull request revision.')
  const review = store.claimNextAdversarialReviewTask(`review-agent-${number}`, at, 600_000)
  if (review === null)
    throw new Error('Expected the review Task.')
  const staged = store.stageReviewStatus({
    taskKind: 'adversarial_review',
    phase: 'review',
    taskId: review.id,
    workerId: review.state.workerId,
    fence: review.state.fence,
    at,
    revisionId: observed.revisionId,
    expectedHeadSha: review.pullRequest.headSha,
    body: '### 🤖 REVIEWING · 35% · Git worktree ready',
  })
  if (staged._tag === 'Rejected')
    throw new Error(staged.reason)
  const command = store.claimReviewStatus(staged.commandId, `status-worker-${number}`, at, 60_000)
  if (command === null)
    throw new Error('Expected the review status command.')
  store.completeReviewStatus({
    commandId: command.id,
    workerId: command.workerId,
    fence: command.fence,
    at,
    commentId: 200 + number,
    url: `https://github.com/harlan-zw/example/pull/${number}#issuecomment-${200 + number}`,
  })
  return review
}

const providerFailure = 'The opencode session failed: Unexpected server error.'

function failUntilFailed(store: ReturnType<typeof openJournalStore>, firstClaim: { id: string, state: { workerId: string, fence: number } }, at: string) {
  let task: { id: string, state: { workerId: string, fence: number } } | null = firstClaim
  while (task !== null) {
    const outcome = store.failWorkerTask({ taskId: task.id, workerId: task.state.workerId, fence: task.state.fence, at, reason: providerFailure })
    task = outcome === 'Retrying' ? store.claimNextAdversarialReviewTask('retry-agent', at, 600_000) : null
  }
}

describe('a Review whose attempt failed', () => {
  // nuxtseo.com#1796: the comment held REVIEWING 35% during every backoff and
  // a plain QUEUED after every requeue, for a day, and never named the failure.
  it('names the failure and the restart time while the Task waits on a backoff', () => {
    const store = createStore()
    failUntilFailed(store, failingReview(store, 40, '2026-08-13T01:00:00.000Z'), '2026-08-13T01:00:00.000Z')

    expect(store.listQueuedReviewStatuses()).toEqual([expect.objectContaining({
      pullRequestNumber: 40,
      attempt: { _tag: 'Retrying', reason: providerFailure, retry: null, nextAttemptAt: '2026-08-13T01:00:00.000Z' },
    })])
  })

  it('keeps naming the failure once the retry is back in the Queue', () => {
    const store = createStore()
    failUntilFailed(store, failingReview(store, 41, '2026-08-13T01:00:00.000Z'), '2026-08-13T01:00:00.000Z')
    expect(store.retryRecoverableWorkerFailures('2026-08-13T01:01:00.000Z')).toBe(1)

    expect(store.listQueuedReviewStatuses()).toEqual([expect.objectContaining({
      pullRequestNumber: 41,
      queue: { _tag: 'Waiting', position: 1, total: 1 },
      attempt: { _tag: 'Retrying', reason: providerFailure, retry: { spent: 1, limit: 12 }, nextAttemptAt: null },
    })])
  })

  it('says the Review is stuck once its retries run out', () => {
    const store = createStore()
    let at = '2026-08-13T00:00:00.000Z'
    let claim = failingReview(store, 42, at)
    for (;;) {
      failUntilFailed(store, claim, at)
      // Past the longest backoff, so only the budget decides.
      at = new Date(Date.parse(at) + 60 * 60_000).toISOString()
      if (store.retryRecoverableWorkerFailures(at) === 0)
        break
      const reclaimed = store.claimNextAdversarialReviewTask('retry-agent', at, 600_000)
      if (reclaimed === null)
        throw new Error('Expected the requeued Review.')
      claim = reclaimed
    }

    expect(store.listQueuedReviewStatuses()).toEqual([expect.objectContaining({
      pullRequestNumber: 42,
      attempt: { _tag: 'Stuck', reason: providerFailure },
    })])
  })

  it('leaves a first attempt alone', () => {
    const store = createStore()
    queuedRepair(store, 43, '2026-08-13T01:00:00.000Z')

    expect(store.listQueuedReviewStatuses()).toEqual([expect.objectContaining({ attempt: { _tag: 'FirstAttempt' } })])
  })
})

describe('priorReviewHistory', () => {
  function observe(store: ReturnType<typeof openJournalStore>, number: number, headSha: string, baseSha: string, at: string): string {
    const observed = store.recordObservation({
      externalId: `prior-review-${number}-${headSha}-${baseSha}`,
      observedAt: at,
      source: 'poll',
      subject: pullRequestItem({
        number,
        headRef: `fix/thing-${number}`,
        headSha,
        baseSha,
        mergeState: 'clean',
        url: `https://github.com/harlan-zw/example/pull/${number}`,
        updatedAt: at,
      }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    return observed.revisionId
  }

  it('names the last verdict of an earlier head after a person pushes', () => {
    const store = createStore()
    queuedRepair(store, 40, '2026-08-13T01:00:00.000Z')
    const revisionId = observe(store, 40, 'e'.repeat(40), 'base123', '2026-08-13T01:05:00.000Z')

    expect(store.priorReviewHistory(revisionId)).toEqual({
      _tag: 'AfterPush',
      priorHeadSha: 'head40',
      priorOutcome: 'Blocked',
      findings: 1,
    })
  })

  it('reads no earlier verdict when only the base branch moved', () => {
    const store = createStore()
    queuedRepair(store, 41, '2026-08-13T01:00:00.000Z')
    const revisionId = observe(store, 41, 'head41', 'base456', '2026-08-13T01:05:00.000Z')

    expect(store.priorReviewHistory(revisionId)).toEqual({ _tag: 'FirstReview' })
  })

  const readyGates: ReviewGates = {
    merge: { _tag: 'Passed', evidence: [{ label: 'mergeability', sha256: 'b'.repeat(64) }] },
    review: { _tag: 'Passed', evidence: [] },
    ci: { _tag: 'Passed', evidence: [{ label: 'required-ci', sha256: 'e'.repeat(64) }] },
  }

  function reviewed(
    store: ReturnType<typeof openJournalStore>,
    number: number,
    headSha: string,
    baseSha: string,
    at: string,
    gates: ReviewGates = passedReviewGates(),
    findings: Parameters<typeof store.recordReviewRun>[0]['findings'] = [],
  ): string {
    const revisionId = observe(store, number, headSha, baseSha, at)
    const review = store.claimNextAdversarialReviewTask(`review-agent-${headSha}`, at, 600_000)
    if (review === null || review.revisionId !== revisionId)
      throw new Error('Expected the Review Task for this head.')
    store.recordReviewRun({
      id: `review-run-${headSha}-${baseSha}`,
      repository: 'harlan-zw/example',
      pullRequestNumber: number,
      revisionId,
      headSha,
      provider: 'codex',
      sessionId: `prior-review-session-${headSha}-${baseSha}`,
      model: 'gpt-5.6',
      agentVersion: '1.2.3',
      skillDigest: 'f'.repeat(64),
      startedAt: at,
      completedAt: at,
      gates,
      findings,
    })
    store.completeWorkerTask({ taskId: review.id, workerId: review.state.workerId, fence: review.state.fence, at, evidence: `review-run-${headSha}` })
    return revisionId
  }

  it('names the verdict a gate refresh settled, which is the one a person read', () => {
    const store = createStore()
    const ciPending: ReviewGates = { ...readyGates, ci: { _tag: 'Pending', reason: 'typecheck is still running.', evidence: [] } }
    const priorRevision = reviewed(store, 43, 'heada', 'base123', '2026-08-13T01:00:00.000Z', ciPending)
    const refreshed = store.stageReviewGateStatus({
      reviewRunId: 'review-run-heada-base123',
      repository: 'harlan-zw/example',
      pullRequestNumber: 43,
      revisionId: priorRevision,
      expectedHeadSha: 'heada',
      gates: readyGates,
      body: '### 🤖 READY · 90/100',
      desiredOutcome: 'READY',
      at: '2026-08-13T01:10:00.000Z',
    })
    expect(refreshed._tag).toBe('Staged')
    const revisionId = observe(store, 43, 'headb', 'base123', '2026-08-13T02:00:00.000Z')

    expect(store.priorReviewHistory(revisionId)).toEqual({ _tag: 'AfterPush', priorHeadSha: 'heada', priorOutcome: 'Ready', findings: 0 })
  })

  it('counts only Open findings as defects', () => {
    const store = createStore()
    const details = { fingerprint: 'f'.repeat(64), identity: 'fallback', location: { path: 'src/config.ts', line: 1 }, proof: 'The fallback needs more context.' }
    reviewed(store, 44, 'heada', 'base123', '2026-08-13T01:00:00.000Z', passedReviewGates(), [
      { _tag: 'Open', summary: 'Unsafe parser input.', nextAction: 'Parse input before use.', resolution: 'Repair', details: { ...details, identity: 'parser', regressionTest: 'Pass malformed input.' } },
      { _tag: 'Logged', impact: 40, summary: 'Improve fallback handling.', nextAction: 'Name the fallback.', details },
    ])
    const revisionId = observe(store, 44, 'headb', 'base123', '2026-08-13T02:00:00.000Z')

    expect(store.priorReviewHistory(revisionId)).toEqual({ _tag: 'AfterPush', priorHeadSha: 'heada', priorOutcome: 'Blocked', findings: 1 })
  })

  it('reads no older head when the newest Review answered this same head', () => {
    const store = createStore()
    reviewed(store, 42, 'heada', 'base123', '2026-08-13T01:00:00.000Z')
    reviewed(store, 42, 'headb', 'base123', '2026-08-13T02:00:00.000Z')
    reviewed(store, 42, 'headc', 'base123', '2026-08-13T03:00:00.000Z')
    const revisionId = observe(store, 42, 'headc', 'base456', '2026-08-13T04:00:00.000Z')

    // The last Review answered headc. Naming headb would call a stale verdict the last one.
    expect(store.priorReviewHistory(revisionId)).toEqual({ _tag: 'FirstReview' })
  })
})

describe('steady running comment', () => {
  const at = '2026-08-13T01:00:00.000Z'

  function claimedProgress(store: ReturnType<typeof openJournalStore>) {
    const observed = store.recordObservation({
      externalId: 'steady-running-comment',
      observedAt: at,
      source: 'poll',
      subject: pullRequestItem({ number: 50, headRef: 'fix/thing-50', headSha: 'head50', mergeState: 'clean', url: 'https://github.com/harlan-zw/example/pull/50' }),
    })
    if (observed._tag !== 'Inserted')
      throw new Error('Expected a new pull request revision.')
    const review = store.claimNextAdversarialReviewTask('review-agent-50', at, 600_000)
    if (review === null)
      throw new Error('Expected the Review Task.')
    const status = {
      taskKind: 'adversarial_review' as const,
      phase: 'review' as const,
      taskId: review.id,
      workerId: review.state.workerId,
      fence: review.state.fence,
      at,
      revisionId: observed.revisionId,
      expectedHeadSha: review.pullRequest.headSha,
      body: progressComment(review.pullRequest.headSha, review.pullRequest.baseSha, { _tag: 'FirstReview' }),
    }
    const first = store.stageReviewStatus(status)
    if (first._tag !== 'Staged')
      throw new Error(`Expected a staged status, received ${first._tag}.`)
    const command = store.claimReviewStatus(first.commandId, 'status-worker', at, 60_000)
    if (command === null)
      throw new Error('Expected the review status command.')
    return { status, command }
  }

  it('publishes a repeated body once, so a later phase writes nothing new', () => {
    const store = createStore()
    const { status, command } = claimedProgress(store)
    const url = 'https://github.com/harlan-zw/example/pull/50#issuecomment-150'
    store.completeReviewStatus({ commandId: command.id, workerId: command.workerId, fence: command.fence, at, commentId: 150, url })

    expect(store.stageReviewStatus({ ...status, at: '2026-08-13T01:05:00.000Z' })).toEqual({ _tag: 'Published', commandId: command.id, commentId: 150, url })
  })

  it('repeats why a superseded body never published, instead of reading as a stuck queue', () => {
    const store = createStore()
    const { status, command } = claimedProgress(store)
    const reason = 'The pull request changed before the review comment was posted.'
    expect(store.supersedeReviewStatus({ commandId: command.id, workerId: command.workerId, fence: command.fence, at, reason })).toBe(true)

    expect(store.stageReviewStatus({ ...status, at: '2026-08-13T01:05:00.000Z' })).toEqual({ _tag: 'Rejected', reason })
  })
})
