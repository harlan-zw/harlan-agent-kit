import type { QueuedReviewStatus } from '../src/store.ts'
import { describe, expect, it } from 'vitest'
import { publishQueuePositions, queuedReviewHistoryLine, queuePositionComment } from '../src/queue-position-sweep.ts'
import { err, ok } from '../src/result.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

function queuedRepair(overrides: Partial<QueuedReviewStatus> = {}): QueuedReviewStatus {
  return {
    taskId: 'repair-task',
    taskKind: 'review_fix',
    repository: 'harlan-zw/example',
    pullRequestNumber: 24,
    revisionId: 'revision-1',
    headSha: 'abc123',
    queue: { _tag: 'Waiting', position: 3, total: 7 },
    verdict: { _tag: 'Answered' },
    history: { _tag: 'FirstReview' },
    commentId: 42,
    publishedBody: '### 🤖 REVIEWING · Repair queued',
    ...overrides,
  }
}

function snapshot(overrides: Parameters<typeof pullRequestItem>[0] = {}) {
  return ok({
    baseChecks: { _tag: 'Available' as const, checks: [] },
    body: '',
    checks: { _tag: 'Available' as const, checks: [] },
    comments: [],
    priorAutomatedReview: { _tag: 'None' as const },
    pullRequest: pullRequestItem({ headSha: 'abc123', ...overrides }),
    requiredChecks: { _tag: 'None' as const },
    reviews: [],
  })
}

describe('the queued review history line', () => {
  it('says nothing before any Review has run', () => {
    expect(queuedReviewHistoryLine({ _tag: 'FirstReview' })).toBeNull()
  })

  it('names the Repair when the controller pushed the commit under review', () => {
    const line = queuedReviewHistoryLine({
      _tag: 'AfterRepair',
      priorHeadSha: 'eb2933b2d12adbdc25a9600668450b395bc55ff8',
      priorOutcome: 'Blocked',
      findings: 4,
    })

    expect(line).toBe('The last Review of `eb2933b2d12a` answered blocked on 4 defects. A Repair pushed this commit, so this Review answers the Repair.')
  })

  it('names a new commit when somebody else pushed it', () => {
    const line = queuedReviewHistoryLine({
      _tag: 'AfterPush',
      priorHeadSha: 'eb2933b2d12adbdc25a9600668450b395bc55ff8',
      priorOutcome: 'Blocked',
      findings: 1,
    })

    expect(line).toBe('The last Review of `eb2933b2d12a` answered blocked on 1 defect. A new commit replaced it, so this Review answers the new commit.')
  })

  it('leaves the defect count out when the prior Review found none', () => {
    const line = queuedReviewHistoryLine({
      _tag: 'AfterPush',
      priorHeadSha: 'eb2933b2d12adbdc25a9600668450b395bc55ff8',
      priorOutcome: 'Ready',
      findings: 0,
    })

    expect(line).toBe('The last Review of `eb2933b2d12a` answered ready. A new commit replaced it, so this Review answers the new commit.')
  })

  it('puts the history into the comment a waiting pull request carries', () => {
    const body = queuePositionComment(queuedRepair({
      taskKind: 'adversarial_review',
      history: { _tag: 'AfterRepair', priorHeadSha: 'eb2933b2d12adbdc25a9600668450b395bc55ff8', priorOutcome: 'Blocked', findings: 4 },
    }))

    expect(body).toContain('A Repair pushed this commit, so this Review answers the Repair.')
    expect(body).toContain('Next: Review starts when an Agent is free.')
  })
})

describe('queuePositionComment', () => {
  it('keeps exact position in the Dashboard', () => {
    const body = queuePositionComment(queuedRepair())

    expect(body).toContain('### 🤖 QUEUED')
    expect(body).toContain('The Dashboard shows the exact Queue position.')
    expect(body).not.toContain('3rd')
    expect(body).not.toMatch(/[▓░]|\b\d+%/)
  })

  it('says an agent is the only thing left to wait for at the head of the Queue', () => {
    expect(queuePositionComment(queuedRepair({ queue: { _tag: 'Waiting', position: 1, total: 4 } })))
      .toContain('Next: Repair starts when an Agent is free.')
  })

  it('names the work the Queue is holding', () => {
    expect(queuePositionComment(queuedRepair({ taskKind: 'adversarial_review', queue: { _tag: 'Waiting', position: 2, total: 2 } })))
      .toContain('Next: Review starts when an Agent is free.')
  })

  it('renders the same body for the same position, so an idle Queue writes nothing', () => {
    expect(queuePositionComment(queuedRepair())).toBe(queuePositionComment(queuedRepair()))
  })

  it('ignores Queue movement, so a Task finishing rewrites nothing', () => {
    const before = queuePositionComment(queuedRepair({ queue: { _tag: 'Waiting', position: 3, total: 7 } }))
    const after = queuePositionComment(queuedRepair({ queue: { _tag: 'Waiting', position: 1, total: 40 } }))

    expect(after).toBe(before)
  })

  it('names the pause, because a position on a paused repository never moves', () => {
    const body = queuePositionComment(queuedRepair({ queue: { _tag: 'Paused' } }))

    expect(body).toContain('### 🤖 PAUSED')
    expect(body).toContain('Next: Repair starts when this repository resumes.')
  })
})

describe('publishQueuePositions', () => {
  it('reads Queue positions one at a time to protect the GitHub request quota', async () => {
    let active = 0
    let maximumActive = 0
    const statuses = Array.from({ length: 8 }, (_, index) => queuedRepair({
      taskId: `repair-task-${index}`,
      pullRequestNumber: 24 + index,
    }))

    await publishQueuePositions({
      github: {
        clearAgentLabels: () => Promise.resolve(ok(undefined)),
        getPullRequestReviewSnapshot: async () => {
          active += 1
          maximumActive = Math.max(maximumActive, active)
          await new Promise(resolve => setTimeout(resolve, 5))
          active -= 1
          return snapshot()
        },
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' })),
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      repositories: [repositoryMapping()],
      store: {
        recordDeletedReviewComment: () => true,
        listQueuedReviewStatuses: () => statuses,
        isQueuedReviewStatus: () => true,
        recordQueuedReviewStatus: () => true,
      },
    }, new AbortController().signal)

    expect(maximumActive).toBe(1)
  })

  it('rewrites the canonical comment and records the position it published', async () => {
    let edited: { commentId: number, body: string } | undefined
    let recorded: { taskId: string, body: string } | undefined
    const results = await publishQueuePositions({
      github: {
        clearAgentLabels: () => Promise.resolve(ok(undefined)),
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot()),
        editReviewStatus: (_repository, _number, commentId, _expectedBody, body) => {
          edited = { commentId, body }
          return Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' }))
        },
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      repositories: [repositoryMapping()],
      store: {
        recordDeletedReviewComment: () => true,
        listQueuedReviewStatuses: () => [queuedRepair()],
        isQueuedReviewStatus: () => true,
        recordQueuedReviewStatus: (input) => {
          recorded = { taskId: input.taskId, body: input.body }
          return true
        },
      },
    }, new AbortController().signal)

    expect(results).toEqual([ok({ _tag: 'Published', repository: 'harlan-zw/example', pullRequestNumber: 24, queue: { _tag: 'Waiting', position: 3, total: 7 } })])
    expect(edited?.commentId).toBe(42)
    expect(edited?.body).toContain('### 🤖 QUEUED')
    expect(recorded?.taskId).toBe('repair-task')
    expect(recorded?.body).toBe(edited?.body)
  })

  it('writes nothing while the position has not moved', async () => {
    let writes = 0
    const unchanged = queuedRepair()
    const results = await publishQueuePositions({
      github: {
        clearAgentLabels: () => Promise.resolve(ok(undefined)),
        getPullRequestReviewSnapshot: () => Promise.resolve(err('Unexpected snapshot read.')),
        editReviewStatus: () => {
          writes += 1
          return Promise.resolve(err('Unexpected comment write.'))
        },
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      repositories: [repositoryMapping()],
      store: {
        recordDeletedReviewComment: () => true,
        listQueuedReviewStatuses: () => [{ ...unchanged, publishedBody: queuePositionComment(unchanged) }],
        isQueuedReviewStatus: () => true,
        recordQueuedReviewStatus: () => true,
      },
    }, new AbortController().signal)

    expect(results).toEqual([])
    expect(writes).toBe(0)
  })

  it('takes the verdict off a head no Review has answered for', async () => {
    const cleared: number[] = []
    await publishQueuePositions({
      github: {
        clearAgentLabels: (_repository, pullRequestNumber) => {
          cleared.push(pullRequestNumber)
          return Promise.resolve(ok(undefined))
        },
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot()),
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' })),
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      repositories: [repositoryMapping()],
      store: {
        isQueuedReviewStatus: () => true,
        recordDeletedReviewComment: () => true,
        listQueuedReviewStatuses: () => [queuedRepair({ verdict: { _tag: 'Unanswered' } })],
        recordQueuedReviewStatus: () => true,
      },
    }, new AbortController().signal)

    expect(cleared).toEqual([24])
  })

  it('keeps the verdict a Review reached for this head, which the queued Repair is fixing', async () => {
    let cleared = 0
    await publishQueuePositions({
      github: {
        clearAgentLabels: () => {
          cleared += 1
          return Promise.resolve(ok(undefined))
        },
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot()),
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' })),
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      repositories: [repositoryMapping()],
      store: {
        isQueuedReviewStatus: () => true,
        recordDeletedReviewComment: () => true,
        listQueuedReviewStatuses: () => [queuedRepair({ verdict: { _tag: 'Answered' } })],
        recordQueuedReviewStatus: () => true,
      },
    }, new AbortController().signal)

    expect(cleared).toBe(0)
  })

  it('retires the publication a person deleted, so no later pass asks again', async () => {
    const retired: number[] = []
    let recorded = 0
    const results = await publishQueuePositions({
      github: {
        clearAgentLabels: () => Promise.resolve(ok(undefined)),
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot()),
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Missing' })),
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      repositories: [repositoryMapping()],
      store: {
        recordDeletedReviewComment: (input) => {
          retired.push(input.commentId)
          return true
        },
        listQueuedReviewStatuses: () => [queuedRepair()],
        isQueuedReviewStatus: () => true,
        recordQueuedReviewStatus: () => {
          recorded += 1
          return true
        },
      },
    }, new AbortController().signal)

    expect(results).toEqual([ok({ _tag: 'CommentGone', repository: 'harlan-zw/example', pullRequestNumber: 24 })])
    expect(recorded).toBe(0)
    expect(retired).toEqual([42])
  })

  it('retires the publication once the comment belongs to another actor', async () => {
    const retired: Array<{ commentId: number, reason: string }> = []
    let recorded = 0
    const reason = 'The stored automated review comment belongs to another GitHub actor.' as const
    const results = await publishQueuePositions({
      github: {
        clearAgentLabels: () => Promise.resolve(ok(undefined)),
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot()),
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Foreign', reason })),
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      repositories: [repositoryMapping()],
      store: {
        recordDeletedReviewComment: (input) => {
          retired.push({ commentId: input.commentId, reason: input.reason })
          return true
        },
        listQueuedReviewStatuses: () => [queuedRepair()],
        isQueuedReviewStatus: () => true,
        recordQueuedReviewStatus: () => {
          recorded += 1
          return true
        },
      },
    }, new AbortController().signal)

    expect(results).toEqual([ok({ _tag: 'Retired', repository: 'harlan-zw/example', pullRequestNumber: 24, reason })])
    expect(recorded).toBe(0)
    expect(retired).toEqual([{ commentId: 42, reason }])
  })
  it('leaves the comment alone once the head commit moves', async () => {
    let writes = 0
    const results = await publishQueuePositions({
      github: {
        clearAgentLabels: () => Promise.resolve(ok(undefined)),
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot({ headSha: 'def456' })),
        editReviewStatus: () => {
          writes += 1
          return Promise.resolve(err('Unexpected comment write.'))
        },
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      repositories: [repositoryMapping()],
      store: {
        recordDeletedReviewComment: () => true,
        listQueuedReviewStatuses: () => [queuedRepair()],
        isQueuedReviewStatus: () => true,
        recordQueuedReviewStatus: () => true,
      },
    }, new AbortController().signal)

    expect(writes).toBe(0)
    expect(results).toEqual([{
      _tag: 'Err',
      error: 'harlan-zw/example#24: the pull request changed before the Queue position comment.',
    }])
  })

  it('skips the edit once an agent claimed the Task before the comment was written', async () => {
    let writes = 0
    const results = await publishQueuePositions({
      github: {
        clearAgentLabels: () => Promise.resolve(ok(undefined)),
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot()),
        editReviewStatus: () => {
          writes += 1
          return Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' }))
        },
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      repositories: [repositoryMapping()],
      store: {
        recordDeletedReviewComment: () => true,
        listQueuedReviewStatuses: () => [queuedRepair()],
        // An agent claimed the Task between the Queue read and the write.
        isQueuedReviewStatus: () => false,
        recordQueuedReviewStatus: () => false,
      },
    }, new AbortController().signal)

    expect(writes).toBe(0)
    expect(results).toEqual([ok({ _tag: 'Superseded', repository: 'harlan-zw/example', pullRequestNumber: 24 })])
  })

  it('offers the body it read as the compare and swap, so a claimed agent cannot be overwritten', async () => {
    let expected: string | undefined
    await publishQueuePositions({
      github: {
        clearAgentLabels: () => Promise.resolve(ok(undefined)),
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot()),
        editReviewStatus: (_repository, _number, _commentId, expectedBody) => {
          expected = expectedBody
          return Promise.resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' }))
        },
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      repositories: [repositoryMapping()],
      store: {
        recordDeletedReviewComment: () => true,
        listQueuedReviewStatuses: () => [queuedRepair()],
        isQueuedReviewStatus: () => true,
        recordQueuedReviewStatus: () => true,
      },
    }, new AbortController().signal)

    expect(expected).toBe(queuedRepair().publishedBody)
  })

  it('leaves the comment to the agent that published first, and saves nothing', async () => {
    let recorded = 0
    const results = await publishQueuePositions({
      github: {
        clearAgentLabels: () => Promise.resolve(ok(undefined)),
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot()),
        // The claimed agent published its own progress, so GitHub no longer
        // holds the body the Queue read saw and the swap declines.
        editReviewStatus: () => Promise.resolve(ok({ _tag: 'Changed' })),
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      repositories: [repositoryMapping()],
      store: {
        recordDeletedReviewComment: () => true,
        listQueuedReviewStatuses: () => [queuedRepair()],
        isQueuedReviewStatus: () => true,
        recordQueuedReviewStatus: () => {
          recorded += 1
          return true
        },
      },
    }, new AbortController().signal)

    expect(recorded).toBe(0)
    expect(results).toEqual([ok({ _tag: 'Superseded', repository: 'harlan-zw/example', pullRequestNumber: 24 })])
  })

  it('reports the lost claim as Superseded instead of an unsaved comment once an agent claims the Task mid-edit', async () => {
    let claimed = false
    let recorded = 0
    const results = await publishQueuePositions({
      github: {
        clearAgentLabels: () => Promise.resolve(ok(undefined)),
        getPullRequestReviewSnapshot: () => Promise.resolve(snapshot()),
        editReviewStatus: () => new Promise((resolve) => {
          // The claim lands while the comment edit is in flight.
          claimed = true
          resolve(ok({ _tag: 'Edited', commentId: 42, url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42' }))
        }),
      },
      now: () => new Date('2026-08-15T04:00:00.000Z'),
      repositories: [repositoryMapping()],
      store: {
        recordDeletedReviewComment: () => true,
        listQueuedReviewStatuses: () => [queuedRepair()],
        isQueuedReviewStatus: () => !claimed,
        recordQueuedReviewStatus: () => {
          recorded += 1
          return false
        },
      },
    }, new AbortController().signal)

    expect(recorded).toBe(1)
    expect(results).toEqual([ok({ _tag: 'Superseded', repository: 'harlan-zw/example', pullRequestNumber: 24 })])
  })
})
