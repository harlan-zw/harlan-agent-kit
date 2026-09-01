import type { DashboardRoutineRun, DashboardTask, ItemSummary, ReviewAgent } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import {
  canRerunReview,
  feedbackFormState,
  historyRangeFromQuery,
  historyRowBadge,
  historyRows,
  historyRowUrl,
  outcomeFilterMatches,
  reviewCommentUrl,
} from '../dashboard/app/utils/history.ts'
import { dashboardSnapshot, pullRequestItem } from './fixtures.ts'

function reviewAgent(overrides: Partial<ReviewAgent> = {}): ReviewAgent {
  return {
    _tag: 'ReviewAgent',
    role: 'adversarial_review',
    id: 'review-1',
    repository: 'harlan-zw/nuxt-seo',
    repositoryUrl: 'https://github.com/harlan-zw/nuxt-seo',
    pullRequestNumber: 412,
    revisionId: 'rev-a',
    headSha: 'abc1234',
    provider: 'codex',
    sessionId: 'session-1',
    model: 'gpt-5.6-sol',
    agentVersion: '1.0.0',
    skillDigest: 'sha256:0',
    startedAt: '2026-08-20T11:00:00.000Z',
    completedAt: '2026-08-20T12:00:00.000Z',
    updatedAt: '2026-08-20T12:00:00.000Z',
    title: 'A pull request',
    author: 'harlan-zw',
    subjectUrl: 'https://github.com/harlan-zw/nuxt-seo/pull/412',
    commitUrl: 'https://github.com/harlan-zw/nuxt-seo/commit/abc1234',
    pullRequestStatus: { _tag: 'Open' },
    gates: {
      merge: { _tag: 'Passed', evidence: [] },
      review: { _tag: 'Passed', evidence: [] },
      ci: { _tag: 'Passed', evidence: [] },
    },
    outcome: { _tag: 'Ready', confidence: 90 },
    findings: [],
    usage: { _tag: 'Unavailable' },
    feedback: null,
    publications: [],
    ...overrides,
  }
}

function task(overrides: Partial<DashboardTask> = {}): DashboardTask {
  return {
    id: 'task-1',
    kind: 'issue_work',
    repository: 'unjs/unhead',
    issueNumber: 702,
    revisionId: 'rev-t',
    state: { _tag: 'Completed', evidence: 'Opened a draft pull request.' },
    updatedAt: '2026-08-21T12:00:00.000Z',
    progress: { percent: 100, label: 'Done' },
    ...overrides,
  } as DashboardTask
}

function routineRun(overrides: Partial<DashboardRoutineRun> = {}): DashboardRoutineRun {
  return {
    id: 'run-1',
    routineId: 'harlan-zw/nuxt-seo:pr-triage',
    repository: 'harlan-zw/nuxt-seo',
    name: 'pr-triage',
    scheduledFor: '2026-08-19T12:00:00.000Z',
    specSha: 'abc123',
    mode: 'report',
    state: { _tag: 'Completed', evidence: 'Ranked 6 open pull requests.' },
    fence: 1,
    attempts: 1,
    progress: { percent: 100, label: 'Done' },
    usage: { _tag: 'Unavailable' },
    candidates: [],
    activity: [],
    reportState: 'Published',
    createdAt: '2026-08-19T12:00:00.000Z',
    updatedAt: '2026-08-19T12:05:00.000Z',
    ...overrides,
  }
}

function openPullRequest(overrides: Partial<Extract<ItemSummary, { kind: 'pull_request' }>> = {}): ItemSummary {
  return {
    ...pullRequestItem({ repository: 'harlan-zw/nuxt-seo', number: 412, state: 'open', draft: false, mergeState: 'clean', headSha: 'abc1234' }),
    revisionId: 'rev-a',
    observedAt: '2026-08-20T12:00:00.000Z',
    dismissed: false,
    approval: { _tag: 'NotRequired' },
    ...overrides,
  }
}

describe('historyRows', () => {
  it('lists every finished record newest first and leaves live work out', () => {
    const snapshot = dashboardSnapshot({
      agents: [reviewAgent()],
      tasks: [task(), task({ id: 'task-live', state: { _tag: 'Running', workerId: 'w', fence: 1, leaseExpiresAt: '2026-08-22T00:00:00.000Z' } })],
      routineRuns: [routineRun(), routineRun({ id: 'run-queued', state: { _tag: 'Queued' } })],
    })

    expect(historyRows(snapshot).map(row => row.key)).toEqual(['task-1', 'review-1', 'run-1'])
  })

  it('keeps only the rows the outcome chip names', () => {
    const snapshot = dashboardSnapshot({
      agents: [
        reviewAgent({ id: 'ready' }),
        reviewAgent({ id: 'blocked', outcome: { _tag: 'Blocked' }, findings: [{ _tag: 'Open', summary: 'x', nextAction: 'y' }] }),
        reviewAgent({ id: 'pending', outcome: { _tag: 'Pending' } }),
      ],
      tasks: [
        task({ id: 'failed', state: { _tag: 'Failed', reason: 'Exited 1.' } }),
        task({ id: 'superseded', state: { _tag: 'Superseded', reason: 'The head moved.' } }),
      ],
    })

    const keys = (filter: Parameters<typeof historyRows>[1]) => historyRows(snapshot, filter).map(row => row.key).sort()
    expect(keys('ready')).toEqual(['ready'])
    expect(keys('findings')).toEqual(['blocked'])
    expect(keys('pending')).toEqual(['pending'])
    expect(keys('blocked')).toEqual(['failed'])
    expect(keys('superseded')).toEqual(['superseded'])
    expect(keys('all')).toHaveLength(5)
  })

  it('narrows to the Stats range by work and by day', () => {
    const snapshot = dashboardSnapshot({
      agents: [
        reviewAgent({ id: 'inside', completedAt: '2026-08-20T12:00:00.000Z' }),
        reviewAgent({ id: 'before', completedAt: '2026-08-10T12:00:00.000Z' }),
      ],
      tasks: [task({ id: 'other-work', updatedAt: '2026-08-21T12:00:00.000Z' })],
    })

    const rows = historyRows(snapshot, 'all', { _tag: 'Stats', from: '2026-08-15', to: '2026-08-25', work: 'adversarial_review' })
    expect(rows.map(row => row.key)).toEqual(['inside'])
  })
})

describe('historyRangeFromQuery', () => {
  it('reads nothing as every record', () => {
    expect(historyRangeFromQuery({})).toEqual({ _tag: 'All' })
    expect(historyRangeFromQuery({ from: '' })).toEqual({ _tag: 'All' })
  })

  it('keeps the dates and drops a work kind it does not know', () => {
    expect(historyRangeFromQuery({ from: '2026-08-01', to: '2026-08-31', work: 'issue_work' }))
      .toEqual({ _tag: 'Stats', from: '2026-08-01', to: '2026-08-31', work: 'issue_work' })
    expect(historyRangeFromQuery({ from: '2026-08-01', work: 'mystery' }))
      .toEqual({ _tag: 'Stats', from: '2026-08-01', to: undefined, work: undefined })
  })
})

describe('outcomeFilterMatches', () => {
  it('reads a BLOCKED Review outcome as Findings and a failed Task as Blocked', () => {
    const blockedReview = { _tag: 'Review' as const, key: 'r', at: '', agent: reviewAgent({ outcome: { _tag: 'Blocked' } }) }
    const failedTask = { _tag: 'Task' as const, key: 't', at: '', task: task({ state: { _tag: 'Failed', reason: 'x' } }) }

    expect(outcomeFilterMatches(blockedReview, 'findings')).toBe(true)
    expect(outcomeFilterMatches(blockedReview, 'blocked')).toBe(false)
    expect(outcomeFilterMatches(failedTask, 'blocked')).toBe(true)
    expect(outcomeFilterMatches(failedTask, 'findings')).toBe(false)
  })
})

describe('canRerunReview', () => {
  it('allows a rerun only while the pull request is still at the reviewed head and the controller would accept it', () => {
    const agent = reviewAgent()

    expect(canRerunReview(agent, dashboardSnapshot({ items: [openPullRequest()] }))).toBe(true)
    expect(canRerunReview(agent, dashboardSnapshot({ items: [openPullRequest({ revisionId: 'rev-b' })] }))).toBe(false)
    expect(canRerunReview(agent, dashboardSnapshot({ items: [openPullRequest({ draft: true })] }))).toBe(false)
    expect(canRerunReview(agent, dashboardSnapshot({ items: [openPullRequest({ mergeState: 'conflicting' })] }))).toBe(false)
    expect(canRerunReview(agent, dashboardSnapshot({ items: [openPullRequest({ approval: { _tag: 'ReviewRequired' } })] }))).toBe(false)
    expect(canRerunReview(agent, dashboardSnapshot({ items: [] }))).toBe(false)
  })
})

describe('feedbackFormState', () => {
  it('shows the recorded verdict instead of the form', () => {
    const feedback = { _tag: 'Noisy' as const, reason: 'Repeated a lint warning.', updatedAt: '2026-08-20T13:00:00.000Z' }

    expect(feedbackFormState(reviewAgent({ feedback }), 'ignored draft', false)).toEqual({ _tag: 'Recorded', feedback })
  })

  it('holds Noisy and Wrong until a reason exists, and everything while saving', () => {
    const agent = reviewAgent()

    expect(feedbackFormState(agent, '   ', false)).toMatchObject({ _tag: 'Open', reason: '', usefulEnabled: true, reasonedEnabled: false })
    expect(feedbackFormState(agent, ' too chatty ', false)).toMatchObject({ _tag: 'Open', reason: 'too chatty', usefulEnabled: true, reasonedEnabled: true })
    expect(feedbackFormState(agent, 'too chatty', true)).toMatchObject({ _tag: 'Open', usefulEnabled: false, reasonedEnabled: false, pending: true })
    expect(feedbackFormState(agent, '', false, 'The request failed.')).toMatchObject({ _tag: 'Open', error: 'The request failed.' })
  })
})

describe('historyRowBadge', () => {
  it('uppercases Review outcomes only and carries confidence on READY alone', () => {
    expect(historyRowBadge({ _tag: 'Review', key: 'r', at: '', agent: reviewAgent() }))
      .toEqual({ label: 'READY', tone: 'success', confidence: 90, uppercase: true })
    expect(historyRowBadge({ _tag: 'Review', key: 'r', at: '', agent: reviewAgent({ outcome: { _tag: 'Pending' } }) }))
      .toEqual({ label: 'PENDING', tone: 'warning', confidence: undefined, uppercase: true })
    expect(historyRowBadge({ _tag: 'Task', key: 't', at: '', task: task({ state: { _tag: 'Failed', reason: 'x' } }) }))
      .toEqual({ label: 'Failed', tone: 'error', uppercase: false })
    expect(historyRowBadge({ _tag: 'Routine', key: 'u', at: '', run: routineRun({ state: { _tag: 'Skipped', reason: 'Outside the catch-up window.' } }) }))
      .toEqual({ label: 'Skipped', tone: 'neutral', uppercase: false })
  })
})

describe('historyRowUrl', () => {
  it('opens a Routine run at its tracking issue when the Routine has one', () => {
    const run = routineRun()
    const snapshot = dashboardSnapshot({
      routines: [{ id: run.routineId, repository: run.repository, name: 'pr-triage', crons: ['0 9 * * 1-5'], timeZone: 'UTC', mode: 'report', enabled: true, specSha: 'abc123', lastRunAt: null, trackingIssueNumber: 380, updatedAt: '' }],
    })

    expect(historyRowUrl({ _tag: 'Routine', key: 'u', at: '', run }, snapshot)).toBe('https://github.com/harlan-zw/nuxt-seo/issues/380')
    expect(historyRowUrl({ _tag: 'Routine', key: 'u', at: '', run }, dashboardSnapshot())).toBe('https://github.com/harlan-zw/nuxt-seo')
  })
})

describe('reviewCommentUrl', () => {
  it('returns the published canonical comment and ignores failed Publications', () => {
    const agent = reviewAgent({
      publications: [
        { id: 'p1', reviewRunId: 'review-1', body: '', bodySha256: '', at: '', result: { _tag: 'Failed', reason: 'GitHub answered 502.' } },
        { id: 'p2', reviewRunId: 'review-1', body: '', bodySha256: '', at: '', result: { _tag: 'Published', githubCommentId: 1, url: 'https://github.com/harlan-zw/nuxt-seo/pull/412#issuecomment-1' } },
      ],
    })

    expect(reviewCommentUrl(agent)).toBe('https://github.com/harlan-zw/nuxt-seo/pull/412#issuecomment-1')
    expect(reviewCommentUrl(reviewAgent())).toBeUndefined()
  })
})
