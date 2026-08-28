import type { ReviewGates } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { parseAgentFeedback } from '../src/agent-feedback.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

function passedReviewGates(): ReviewGates {
  return {
    merge: { _tag: 'Passed', evidence: [] },
    review: { _tag: 'Passed', evidence: [] },
    ci: { _tag: 'Passed', evidence: [] },
  }
}

function recordReview(store: ReturnType<typeof openJournalStore>, input: {
  id: string
  completedAt: string
  headSha?: string
}) {
  const subject = pullRequestItem({ headSha: input.headSha ?? 'abc123', mergeState: 'clean' })
  const observed = store.recordObservation({
    externalId: `observation-${input.id}`,
    observedAt: input.completedAt,
    source: 'poll',
    subject,
  })
  if (observed._tag !== 'Inserted' && observed._tag !== 'Duplicate')
    throw new Error('Expected a recorded pull request.')
  store.recordReviewRun({
    id: input.id,
    repository: 'harlan-zw/example',
    pullRequestNumber: subject.number,
    revisionId: observed.revisionId,
    headSha: subject.headSha,
    provider: 'codex',
    sessionId: `session-${input.id}`,
    model: 'gpt-5.4',
    agentVersion: '1',
    skillDigest: 'f'.repeat(64),
    startedAt: new Date(Date.parse(input.completedAt) - 2_000).toISOString(),
    completedAt: input.completedAt,
    usage: { _tag: 'Available', input: 10, cachedInput: 5, cacheWrite: 0, output: 3, reasoning: 2 },
    gates: passedReviewGates(),
    findings: [],
  })
}

describe('agent feedback', () => {
  it('requires a reason for negative feedback', () => {
    expect(parseAgentFeedback({ reviewRunId: 'review-1', feedback: { _tag: 'Wrong', reason: ' ' } })).toEqual({
      _tag: 'Err',
      error: 'Wrong Agent feedback needs a reason.',
    })
    expect(parseAgentFeedback({ reviewRunId: 'review-1', feedback: { _tag: 'Useful' } })).toEqual({
      _tag: 'Ok',
      value: { reviewRunId: 'review-1', feedback: { _tag: 'Useful', reason: null } },
    })
  })

  it('returns only the latest explicit signals with Review evidence', () => {
    const store = openJournalStore(':memory:')
    store.syncRepositories([repositoryMapping()], '2026-08-29T00:00:00.000Z')
    for (let index = 0; index < 12; index++) {
      const completedAt = new Date(Date.parse('2026-08-29T00:00:00.000Z') + index * 60_000).toISOString()
      recordReview(store, { id: `review-${index}`, completedAt })
      store.recordAgentFeedback({
        reviewRunId: `review-${index}`,
        feedback: index === 11 ? { _tag: 'Wrong', reason: 'The finding did not reproduce.' } : { _tag: 'Useful', reason: null },
        at: completedAt,
      })
    }

    const signals = store.listAgentFeedback(10)

    expect(signals).toHaveLength(10)
    expect(signals[0]).toEqual(expect.objectContaining({
      reviewRunId: 'review-11',
      durationMs: 2_000,
      reviewRunsForHead: 12,
      feedback: { _tag: 'Wrong', reason: 'The finding did not reproduce.', updatedAt: '2026-08-29T00:11:00.000Z' },
    }))
    expect(signals.at(-1)?.reviewRunId).toBe('review-2')
    expect(store.listReviewRuns('harlan-zw/example', 24)[0]?.feedback).toEqual({
      _tag: 'Wrong',
      reason: 'The finding did not reproduce.',
      updatedAt: '2026-08-29T00:11:00.000Z',
    })
    store.close()
  })

  it('rejects feedback for a missing Review run', () => {
    const store = openJournalStore(':memory:')
    expect(store.recordAgentFeedback({
      reviewRunId: 'missing',
      feedback: { _tag: 'Useful', reason: null },
      at: '2026-08-29T00:00:00.000Z',
    })).toEqual({ _tag: 'Rejected', reason: { _tag: 'ReviewRunNotFound' } })
    store.close()
  })
})
