import type { ActiveAgent, DashboardRoutineRun, DashboardTask, Incident, QueueEntry, ReviewAgent, Routine } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import {
  activeAgentActivity,
  activeEntries,
  activeProviderCircuits,
  agentProfileState,
  agentStartState,
  approvalActionLabel,
  approvalConsequence,
  boardColumns,
  buildHistory,
  cancelConsequence,
  cardActions,
  cardStateLine,
  columnEmptyReason,
  decisionEntries,
  dismissConsequence,
  incidentEntries,
  incidentKindLabel,
  incidentRecoveryLabel,
  incidentScopeLabel,
  incidentUrl,
  isIssueWorkThrottled,
  isProgressStalled,
  isSnapshotStale,
  presentWorkKinds,
  providerCapacityPresentation,

  queuedEntries,
  queueWork,
  repositoryState,
  repositoryWritesControl,
  reviewOutcomeDetail,
  reviewOutcomeLabel,
  reviewUsageLabel,
  routineReportPending,
  routineRunPresentation,
  routineTrackingUrl,
  runningPhaseLine,
  scheduledRoutineRecords,
  stalledLabel,
  systemState,
  taskHistoryCategory,
  taskKindLabel,
  taskProgressDetail,
  taskStateTone,
  taskSubjectUrl,
  waitingEntries,
} from '../dashboard/app/utils/dashboard.ts'
import { OPENCODE_AGENT_PROFILE } from '../src/agent-profile.ts'
import { dashboardSnapshot } from './fixtures.ts'

const now = new Date('2026-08-14T12:00:00.000Z')

function activeAgent(overrides: Partial<ActiveAgent> = {}): ActiveAgent {
  return {
    _tag: 'ActiveAgent',
    id: 'agent-1',
    provider: 'codex',
    role: 'adversarial_review',
    session: { _tag: 'Starting' },
    author: 'harlan-zw',
    repository: 'harlan-zw/nuxt-seo',
    repositoryUrl: 'https://github.com/harlan-zw/nuxt-seo',
    subjectKind: 'pull_request',
    itemNumber: 412,
    title: 'A pull request',
    subjectUrl: 'https://github.com/harlan-zw/nuxt-seo/pull/412',
    startedAt: '2026-08-14T11:00:00.000Z',
    updatedAt: '2026-08-14T11:59:30.000Z',
    progress: { percent: 50, label: 'Working' },
    activity: [],
    state: { _tag: 'Working', workerId: 'worker-1', fence: 1, leaseExpiresAt: '2026-08-14T12:30:00.000Z' },
    ...overrides,
  }
}

function routine(overrides: Partial<Routine> = {}): Routine {
  return {
    id: 'harlan-zw/example:sentry-checkin',
    repository: 'harlan-zw/example',
    name: 'sentry-checkin',
    crons: ['0 7 * * *'],
    timeZone: 'Australia/Melbourne',
    mode: 'report',
    enabled: true,
    specSha: 'abc123',
    lastRunAt: '2026-08-27T21:00:00.000Z',
    trackingIssueNumber: 42,
    updatedAt: '2026-08-27T21:00:01.000Z',
    ...overrides,
  }
}

function routineRun(overrides: Partial<DashboardRoutineRun> = {}): DashboardRoutineRun {
  return {
    id: 'routine-run-1',
    routineId: 'harlan-zw/example:sentry-checkin',
    repository: 'harlan-zw/example',
    name: 'sentry-checkin',
    scheduledFor: '2026-08-27T21:00:00.000Z',
    specSha: 'abc123',
    mode: 'report',
    state: { _tag: 'Completed', evidence: 'No open Sentry issues.' },
    fence: 1,
    attempts: 1,
    progress: { percent: 85, label: 'Preparing the Routine result' },
    usage: { _tag: 'Unavailable' },
    candidates: [],
    activity: [],
    reportState: null,
    createdAt: '2026-08-27T21:00:00.000Z',
    updatedAt: '2026-08-27T21:01:00.000Z',
    ...overrides,
  }
}

function queueEntry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    position: 1,
    kind: 'pull_request',
    revisionId: 'rev-a',
    repository: 'harlan-zw/nuxt-seo',
    repositoryUrl: 'https://github.com/harlan-zw/nuxt-seo',
    number: 412,
    title: 'A pull request',
    author: 'harlan-zw',
    subjectUrl: 'https://github.com/harlan-zw/nuxt-seo/pull/412',
    headSha: 'abc1234',
    commitUrl: 'https://github.com/harlan-zw/nuxt-seo/commit/abc1234',
    createdAt: '2026-08-14T10:00:00.000Z',
    updatedAt: '2026-08-14T11:00:00.000Z',
    state: { _tag: 'Queued', work: 'adversarial_review' },
    ...overrides,
  } as QueueEntry
}

function reviewAgent(overrides: Partial<ReviewAgent> = {}): ReviewAgent {
  return {
    _tag: 'ReviewAgent',
    role: 'adversarial_review',
    id: 'attempt-1',
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
    startedAt: '2026-08-14T11:00:00.000Z',
    completedAt: '2026-08-14T11:30:00.000Z',
    title: 'A pull request',
    subjectUrl: 'https://github.com/harlan-zw/nuxt-seo/pull/412',
    commitUrl: 'https://github.com/harlan-zw/nuxt-seo/commit/abc1234',
    pullRequestStatus: { _tag: 'Open' },
    updatedAt: '2026-08-14T11:30:00.000Z',
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
  } as ReviewAgent
}

const reviewTask: DashboardTask = {
  id: 'task-review',
  kind: 'adversarial_review',
  repository: 'harlan-zw/nuxt-seo',
  pullRequestNumber: 412,
  revisionId: 'rev-a',
  state: { _tag: 'Completed', evidence: 'done' },
  updatedAt: '2026-08-14T11:31:00.000Z',
  progress: { percent: 95, label: 'Review complete' },
}

const triageTask: DashboardTask = {
  id: 'task-triage',
  kind: 'issue_triage',
  repository: 'harlan-zw/unlighthouse',
  issueNumber: 88,
  revisionId: 'rev-i',
  state: { _tag: 'Failed', reason: 'The focused test suite did not pass.' },
  updatedAt: '2026-08-14T11:45:00.000Z',
  progress: { percent: 70, label: 'Running tests and checks' },
}

describe('buildHistory', () => {
  it('drops the task for a review that already reports its own outcome', () => {
    const history = buildHistory([reviewAgent()], [reviewTask])
    expect(history).toHaveLength(1)
    expect(history[0]!._tag).toBe('Review')
  })

  it('keeps work that produces no review, so it cannot finish invisibly', () => {
    const history = buildHistory([], [triageTask])
    expect(history.map(record => record._tag)).toEqual(['Task'])
  })

  it('ignores work that has not finished', () => {
    const running: DashboardTask = { ...triageTask, state: { _tag: 'Queued' } }
    expect(buildHistory([], [running])).toEqual([])
  })

  it('orders newest first across both sources', () => {
    const history = buildHistory([reviewAgent()], [triageTask])
    expect(history.map(record => record.at)).toEqual(['2026-08-14T11:45:00.000Z', '2026-08-14T11:30:00.000Z'])
  })

  it('keeps a review task whose revision does not match any recorded review', () => {
    const history = buildHistory([reviewAgent({ revisionId: 'rev-b' })], [reviewTask])
    expect(history).toHaveLength(2)
  })

  it('keeps a finished Routine as evidence', () => {
    const history = buildHistory([], [], [routineRun()])
    expect(history).toEqual([expect.objectContaining({ _tag: 'Routine', key: 'routine-run-1' })])
  })
})

describe('history outcome visibility', () => {
  it('does not promise a Repair before its Task exists', () => {
    const blocked = reviewAgent({
      outcome: { _tag: 'Blocked' },
      findings: [{
        _tag: 'Open',
        summary: 'The parser accepts an invalid state.',
        nextAction: 'Reject the invalid state at the boundary.',
        resolution: 'Repair',
      }],
    })

    expect(reviewOutcomeDetail(blocked)).toBe('1 issue found.')
  })

  it('names the unsettled gate and reason for a pending review', () => {
    const pending = reviewAgent({
      outcome: { _tag: 'Pending' },
      gates: {
        ...reviewAgent().gates,
        ci: { _tag: 'Pending', reason: 'Required checks are still running.', evidence: [] },
      },
    })

    expect(reviewOutcomeDetail(pending)).toBe('CI Review gate pending. Required checks are still running.')
  })

  it('keeps superseded work out of failure filters', () => {
    const superseded = { ...reviewTask, state: { _tag: 'Superseded' as const, reason: 'A newer head commit replaced this review.' } }

    expect(taskHistoryCategory(superseded)).toBe('superseded')
  })

  it('shows the last phase without presenting it as completion progress', () => {
    const failed = {
      ...triageTask,
      progress: { percent: 70, label: 'Running tests and checks' },
    }

    expect(taskProgressDetail(failed)).toBe('Last phase: Running tests and checks')
  })
})

describe('reviewUsageLabel', () => {
  it('formats the whole Review run usage as one compact aggregate', () => {
    expect(reviewUsageLabel({
      _tag: 'Available',
      input: 12_000,
      cachedInput: 1_809_408,
      cacheWrite: 0,
      output: 9_577,
      reasoning: 5_356,
    })).toBe('12k input · 1.8m cached · 9.6k output · 5.4k reasoning · 0 cache write')
  })

  it('states when the Agent provider reported no usage', () => {
    expect(reviewUsageLabel({ _tag: 'Unavailable' })).toBe('Usage unavailable')
  })
})

describe('queuedEntries', () => {
  it('keeps work an agent will pick up', () => {
    const entry = queueEntry({ state: { _tag: 'Queued', work: 'adversarial_review' } })
    expect(queuedEntries([entry])).toHaveLength(1)
  })

  it('excludes work that already started', () => {
    const entry = queueEntry({ state: { _tag: 'Active', work: 'adversarial_review' } })
    expect(queuedEntries([entry])).toEqual([])
  })

  it('excludes anything that needs a decision', () => {
    const entry = queueEntry({ state: { _tag: 'AwaitingApproval', kind: 'review' } })
    expect(queuedEntries([entry])).toEqual([])
  })

  it('excludes work blocked on something outside the engine', () => {
    const entry = queueEntry({ state: { _tag: 'Pending', reason: 'Draft pull request.' } })
    expect(queuedEntries([entry])).toEqual([])
  })
})

describe('waitingEntries', () => {
  it('collects work that is blocked, so a forecast never promises it', () => {
    const entry = queueEntry({ state: { _tag: 'Pending', reason: 'Draft pull request.' } })
    expect(waitingEntries([entry])).toHaveLength(1)
  })

  it('leaves queued work out', () => {
    const entry = queueEntry({ state: { _tag: 'Queued', work: 'adversarial_review' } })
    expect(waitingEntries([entry])).toEqual([])
  })
})

describe('activeEntries', () => {
  it('hides work that is already visible as a running agent', () => {
    const entry = queueEntry({ state: { _tag: 'Active', work: 'adversarial_review' } })
    expect(activeEntries([entry], [activeAgent()])).toEqual([])
  })

  it('keeps active work when no agent reports it, so it cannot vanish', () => {
    const entry = queueEntry({ state: { _tag: 'Active', work: 'adversarial_review' } })
    expect(activeEntries([entry], [])).toHaveLength(1)
  })
})

describe('queueWork', () => {
  it('names the work an approval would start', () => {
    expect(queueWork(queueEntry({ state: { _tag: 'AwaitingApproval', kind: 'review' } }))).toBe('adversarial_review')
  })

  it('has no work for a condition that names none', () => {
    expect(queueWork(queueEntry({ state: { _tag: 'Pending', reason: 'Waiting for mergeability.' } }))).toBeUndefined()
  })
})

describe('decisionEntries', () => {
  it('collects approvals and failures only', () => {
    const entries = [
      queueEntry({ state: { _tag: 'AwaitingApproval', kind: 'review' } }),
      queueEntry({ state: { _tag: 'ActionRequired', reason: 'Not writable.' } }),
      queueEntry({ state: { _tag: 'Queued', work: 'adversarial_review' } }),
    ]
    expect(decisionEntries(entries)).toHaveLength(2)
  })
})

const running = { agentStart: { _tag: 'Available' as const }, openPullRequests: 0, maxOpenPullRequests: 8, selectionMode: 'auto' as const }

describe('isIssueWorkThrottled', () => {
  const issueWork = queueEntry({ state: { _tag: 'Queued', work: 'issue_work' } })

  it('holds issue work at the open pull request limit', () => {
    expect(isIssueWorkThrottled(issueWork, { ...running, openPullRequests: 17 })).toBe(true)
  })

  it('lets issue work through below the limit', () => {
    expect(isIssueWorkThrottled(issueWork, { ...running, openPullRequests: 7 })).toBe(false)
  })

  it('ignores the limit in Manual, where Harlan is already the throttle', () => {
    expect(isIssueWorkThrottled(issueWork, { ...running, openPullRequests: 17, selectionMode: 'manual' })).toBe(false)
  })

  it('never holds back work the limit does not cover', () => {
    const review = queueEntry({ state: { _tag: 'Queued', work: 'adversarial_review' } })
    expect(isIssueWorkThrottled(review, { ...running, openPullRequests: 17 })).toBe(false)
  })

  it('names the limit and the count, so the number is actionable', () => {
    expect(cardStateLine(issueWork, dashboardSnapshot({ agentStart: { _tag: 'Available' }, openPullRequests: 17 }), now))
      .toEqual({ text: 'Issue work stops above 8 open pull requests, and 17 are open.', tone: 'muted' })
  })
})

describe('cardStateLine', () => {
  const available = dashboardSnapshot({ agentStart: { _tag: 'Available' } })

  it('names why a pull request needs Approval, by Selection mode', () => {
    const entry = queueEntry({ state: { _tag: 'AwaitingApproval', kind: 'review' } })
    expect(cardStateLine(entry, available, now)).toEqual({ text: 'Outside contributor. Approval starts Review.', tone: 'warning' })
    expect(cardStateLine(entry, dashboardSnapshot({ selectionMode: 'manual' }), now).text).toBe('Manual selection. Approval starts Review.')
  })

  it('names Issue work for an issue Approval', () => {
    const entry = queueEntry({ kind: 'issue', state: { _tag: 'AwaitingApproval', kind: 'issue_work' } })
    expect(cardStateLine(entry, available, now).text).toBe('Outside contributor. Approval starts Issue work.')
  })

  it('passes the reason through for Action required and Pending, with the right tone', () => {
    expect(cardStateLine(queueEntry({ state: { _tag: 'ActionRequired', reason: 'The fork branch is not writable.' } }), available, now))
      .toEqual({ text: 'The fork branch is not writable.', tone: 'error' })
    expect(cardStateLine(queueEntry({ state: { _tag: 'Pending', reason: 'Blocked on a draft.' } }), available, now))
      .toEqual({ text: 'Blocked on a draft.', tone: 'muted' })
  })

  it.each([
    [{ _tag: 'Available' } as const, 'Starts when an agent is free.'],
    [{ _tag: 'Paused' } as const, 'Paused. Nothing starts until you select Resume.'],
    [{ _tag: 'WritesDisabled' } as const, 'GitHub writes are off, so no agent will start.'],
    [{ _tag: 'ReserveReached' } as const, 'Every automatic Agent provider reached its Reserve.'],
    [{ _tag: 'CapacityUnavailable' } as const, 'Agent provider limits could not load. The controller will retry.'],
    [{ _tag: 'RestartRequested' } as const, 'A Restart request is finishing active work.'],
  ])('tells queued work what holds it: %o', (agentStart, text) => {
    expect(cardStateLine(queueEntry(), dashboardSnapshot({ agentStart }), now).text).toBe(text)
  })

  it('warns once a starting Task has reported nothing for the stall threshold', () => {
    const entry = queueEntry({ state: { _tag: 'Active', work: 'issue_work' }, updatedAt: '2026-08-14T11:59:30.000Z' })
    expect(cardStateLine(entry, available, now)).toEqual({ text: 'Starting.', tone: 'muted' })
    expect(cardStateLine({ ...entry, updatedAt: '2026-08-14T11:55:00.000Z' }, available, now))
      .toEqual({ text: 'Starting for 5m with nothing reported.', tone: 'warning' })
  })

  it('never names the work kind, which the chip on the same face already shows', () => {
    const queued = cardStateLine(queueEntry({ state: { _tag: 'Queued', work: 'review_fix' } }), available, now).text
    expect(queued).not.toMatch(/repair/i)
  })
})

describe('incidentKindLabel', () => {
  const base = {
    id: 'incident-1',
    scope: { _tag: 'Task' as const, taskId: 't', repository: 'harlan-zw/nuxt-seo', itemNumber: 412 },
    severity: 'warning' as const,
    message: 'The pull request changed before the review completed.',
    recovery: { _tag: 'Retrying' as const, attempt: 1, nextAttemptAt: '2026-08-14T12:05:00.000Z' },
    occurrences: 1,
    firstSeenAt: '2026-08-14T11:00:00.000Z',
    lastSeenAt: '2026-08-14T11:58:00.000Z',
  }

  it('names which GitHub state moved, never an Item', () => {
    expect(incidentKindLabel({ ...base, kind: 'subject_changed', operation: 'adversarial_review' })).toBe('Head commit moved')
    expect(incidentKindLabel({ ...base, kind: 'subject_changed', operation: 'issue_work' })).toBe('Issue changed')
    expect(incidentKindLabel({ ...base, kind: 'github_access', operation: 'poll' })).toBe('GitHub access')
  })
})

describe('runningPhaseLine', () => {
  it('drops the phase when it only repeats the chip', () => {
    expect(runningPhaseLine(activeAgent({ role: 'review_fix', progress: { percent: 40, label: 'Repair' } }))).toBeUndefined()
    expect(runningPhaseLine(activeAgent({ role: 'adversarial_review', progress: { percent: 40, label: 'review' } }))).toBeUndefined()
  })

  it('keeps a phase that says something the chip does not', () => {
    expect(runningPhaseLine(activeAgent({ role: 'review_fix', progress: { percent: 40, label: 'Running tests and checks' } }))).toBe('Running tests and checks')
  })
})

describe('columnEmptyReason', () => {
  it('keeps the Needs you slot with one line', () => {
    expect(columnEmptyReason('needsYou', dashboardSnapshot())).toEqual({ _tag: 'Plain', text: 'Nothing needs you.' })
  })

  it('offers Resume only when Pause is the cause', () => {
    expect(columnEmptyReason('upNext', dashboardSnapshot({ agentStart: { _tag: 'Paused' } })))
      .toEqual({ _tag: 'Paused', text: 'Paused. Nothing will start.' })
    expect(columnEmptyReason('upNext', dashboardSnapshot({ agentStart: { _tag: 'WritesDisabled' } })))
      .toEqual({ _tag: 'Plain', text: 'GitHub writes are off, so no agent will start.' })
  })

  it('points at the Needs you column in Manual when approvals are waiting', () => {
    const snapshot = dashboardSnapshot({
      agentStart: { _tag: 'Available' },
      selectionMode: 'manual',
      queue: [queueEntry({ state: { _tag: 'AwaitingApproval', kind: 'review' } })],
    })
    expect(columnEmptyReason('upNext', snapshot).text).toBe('Manual selection. Approve a pull request to queue it.')
    expect(columnEmptyReason('upNext', { ...snapshot, queue: [] }).text).toBe('Nothing queued.')
  })
})

describe('boardColumns', () => {
  const queue = [
    queueEntry({ number: 1, state: { _tag: 'AwaitingApproval', kind: 'review' } }),
    queueEntry({ number: 2, state: { _tag: 'ActionRequired', reason: 'Not writable.' } }),
    queueEntry({ number: 3, state: { _tag: 'Queued', work: 'adversarial_review' } }),
    queueEntry({ number: 4, state: { _tag: 'Queued', work: 'issue_work' } }),
    queueEntry({ number: 5, state: { _tag: 'Pending', reason: 'Blocked on a draft.' } }),
    queueEntry({ number: 412, state: { _tag: 'Active', work: 'adversarial_review' } }),
    queueEntry({ number: 6, state: { _tag: 'Active', work: 'review_fix' } }),
  ]

  it('places every entry in exactly one column, decided by state', () => {
    const columns = boardColumns(dashboardSnapshot({ agentStart: { _tag: 'Available' }, openPullRequests: 17, queue, agents: [activeAgent()] }))
    const numbers = (cards: ReturnType<typeof boardColumns>['queued']): Array<number | string> =>
      cards.map(card => card._tag === 'Running' ? card.agent.itemNumber : card._tag === 'Done' ? card.key : card.entry.number)
    expect(numbers(columns.needsYou)).toEqual([1, 2])
    expect(numbers(columns.queued)).toEqual([3])
    expect(numbers(columns.waiting)).toEqual([4, 5])
    expect(columns.running.map(card => card._tag)).toEqual(['Running', 'Starting'])
    expect(numbers(columns.running)).toEqual([412, 6])
  })

  it('holds eight Done cards and reports the full total', () => {
    const tasks = Array.from({ length: 10 }, (_, index) => ({ ...triageTask, id: `task-${index}` }))
    const columns = boardColumns(dashboardSnapshot({ tasks }))
    expect(columns.done).toHaveLength(8)
    expect(columns.doneTotal).toBe(10)
  })

  it('filters every column by work kind', () => {
    const columns = boardColumns(dashboardSnapshot({ agentStart: { _tag: 'Available' }, queue, agents: [activeAgent()] }), 'issue_work')
    expect(columns.needsYou).toEqual([])
    expect(columns.queued.map(card => card._tag === 'Queued' && card.entry.number)).toEqual([4])
    expect(columns.running).toEqual([])
  })

  it('only offers a work kind filter for kinds on the board', () => {
    const columns = boardColumns(dashboardSnapshot({ agentStart: { _tag: 'Available' }, queue: queue.slice(0, 1) }))
    expect(presentWorkKinds(columns).map(([role]) => role)).toEqual(['adversarial_review'])
  })
})

describe('card actions', () => {
  const needsYou = { _tag: 'NeedsYou' as const, key: 'a', entry: queueEntry({ state: { _tag: 'AwaitingApproval', kind: 'review' } }) }

  it('puts Dismiss last and offers Cancel only with a live Task', () => {
    expect(cardActions(needsYou, { canRunReview: false, hasTask: false })).toEqual(['open', 'dismiss'])
    expect(cardActions(needsYou, { canRunReview: false, hasTask: true })).toEqual(['open', 'cancel', 'dismiss'])
  })

  it('offers Rerun review only when the controller would accept it', () => {
    const waiting = { _tag: 'Waiting' as const, key: 'w', entry: queueEntry({ state: { _tag: 'Pending', reason: 'Approved and waiting.' } }) }
    expect(cardActions(waiting, { canRunReview: true, hasTask: false })).toEqual(['open', 'rerun', 'dismiss'])
  })

  it('lets a Done card only open on GitHub', () => {
    const done = { _tag: 'Done' as const, key: 'd', record: { _tag: 'Task' as const, key: 'd', at: triageTask.updatedAt, task: triageTask } }
    expect(cardActions(done, { canRunReview: true, hasTask: true })).toEqual(['open'])
  })

  it('names the primary action by what Approval starts', () => {
    expect(approvalActionLabel(queueEntry({ state: { _tag: 'AwaitingApproval', kind: 'review' } }))).toBe('Review and repair')
    expect(approvalActionLabel(queueEntry({ kind: 'issue', state: { _tag: 'AwaitingApproval', kind: 'issue_work' } }))).toBe('Approve')
    expect(approvalActionLabel(queueEntry({ state: { _tag: 'ActionRequired', reason: 'Not writable.' } }))).toBeUndefined()
  })

  it('states the consequence before the verb', () => {
    expect(dismissConsequence('pull_request')).toBe('This pull request will never run again, and any running work on it stops now.')
    expect(cancelConsequence('review_fix')).toBe('Repair stops now.')
    expect(cancelConsequence(undefined)).toBe('This task stops now.')
  })
})

describe('approvalConsequence', () => {
  it('explains what approving actually starts', () => {
    expect(approvalConsequence(queueEntry({ state: { _tag: 'AwaitingApproval', kind: 'issue_work' } })))
      .toContain('opens a draft pull request')
    expect(approvalConsequence(queueEntry({ state: { _tag: 'AwaitingApproval', kind: 'review' } })))
      .toContain('push verified repair commits')
  })

  it('is empty for an entry that needs no approval', () => {
    expect(approvalConsequence(queueEntry())).toBe('')
  })
})

describe('stalled progress', () => {
  it('stays quiet while the agent reports normally', () => {
    expect(isProgressStalled(activeAgent(), now)).toBe(false)
  })

  it('reports a stall once the agent has been silent past the threshold', () => {
    expect(isProgressStalled(activeAgent({ updatedAt: '2026-08-14T11:50:00.000Z' }), now)).toBe(true)
  })

  it('stays quiet while terminal activity continues', () => {
    const agent = activeAgent({
      updatedAt: '2026-08-14T11:50:00.000Z',
      activity: [{
        _tag: 'Command',
        at: '2026-08-14T11:59:00.000Z',
        command: 'pnpm test',
        output: 'passed',
        exitCode: 0,
      }],
    })

    expect(isProgressStalled(agent, now)).toBe(false)
    expect(stalledLabel(agent, now)).toBe('No progress for 1m')
  })
})

describe('activeAgentActivity', () => {
  it('shows the current command from structured Agent activity', () => {
    expect(activeAgentActivity(activeAgent({
      activity: [{
        _tag: 'Command',
        at: '2026-08-14T11:59:00.000Z',
        command: 'pnpm test',
        output: '',
        exitCode: null,
      }],
    }))).toEqual({
      at: '2026-08-14T11:59:00.000Z',
      text: 'Running pnpm test',
      tone: 'muted',
    })
  })

  it('names a failed command without hiding what ran', () => {
    expect(activeAgentActivity(activeAgent({
      activity: [{
        _tag: 'Command',
        at: '2026-08-14T11:59:00.000Z',
        command: 'pnpm typecheck',
        output: 'failed',
        exitCode: 1,
      }],
    }))).toEqual({
      at: '2026-08-14T11:59:00.000Z',
      text: 'Command failed: pnpm typecheck',
      tone: 'error',
    })
  })

  it('shows the phase the Agent reported and never its percentage', () => {
    expect(activeAgentActivity(activeAgent({
      activity: [{
        _tag: 'Progress',
        at: '2026-08-14T11:59:00.000Z',
        percent: 25,
        text: 'next-step (waitlist flow read).',
      }],
    }))).toEqual({
      at: '2026-08-14T11:59:00.000Z',
      text: 'next-step (waitlist flow read).',
      tone: 'muted',
    })
  })

  it('stays absent until the Agent reports structured activity', () => {
    expect(activeAgentActivity(activeAgent())).toBeUndefined()
  })
})

describe('isSnapshotStale', () => {
  it('treats a snapshot that never loaded as fresh, so the page does not cry wolf', () => {
    expect(isSnapshotStale('', now)).toBe(false)
  })

  it('flags a snapshot older than the threshold', () => {
    expect(isSnapshotStale('2026-08-14T11:58:00.000Z', now)).toBe(true)
    expect(isSnapshotStale('2026-08-14T11:59:30.000Z', now)).toBe(false)
  })
})

describe('agentProfileState', () => {
  it('does not expose the placeholder provider before state loads', () => {
    const snapshot = dashboardSnapshot({ generatedAt: '' })
    expect(agentProfileState(snapshot, true)).toEqual({ _tag: 'Loading' })
  })

  it('reports an unavailable provider after the first load fails', () => {
    const snapshot = dashboardSnapshot({ generatedAt: '' })
    expect(agentProfileState(snapshot, false)).toEqual({ _tag: 'Unavailable' })
  })

  it('exposes the provider from loaded state', () => {
    const snapshot = dashboardSnapshot({ agentProfile: OPENCODE_AGENT_PROFILE })
    expect(agentProfileState(snapshot, false)).toEqual({
      _tag: 'Available',
      profile: OPENCODE_AGENT_PROFILE,
    })
  })
})

describe('task presentation', () => {
  it('points an issue task at the issue url and a pull request task at the pull url', () => {
    expect(taskSubjectUrl(triageTask)).toBe('https://github.com/harlan-zw/unlighthouse/issues/88')
    expect(taskSubjectUrl(reviewTask)).toBe('https://github.com/harlan-zw/nuxt-seo/pull/412')
  })

  it('names the conflict task by its worker role', () => {
    expect(taskKindLabel({ ...reviewTask, kind: 'resolve_conflict' })).toBe('Conflict resolution')
  })

  it('keeps superseded work neutral rather than colouring it as success or failure', () => {
    expect(taskStateTone(reviewTask)).toBe('success')
    expect(taskStateTone(triageTask)).toBe('error')
    expect(taskStateTone({ ...reviewTask, state: { _tag: 'Superseded', reason: 'Head moved.' } })).toBe('neutral')
  })
})

describe('repositoryState', () => {
  it('ranks an error above a missing first poll', () => {
    expect(repositoryState({ github: 'a/b', enabled: true, writesEnabled: true, ownership: 'owned', paused: false, lastAttemptAt: null, lastSuccessAt: '2026-08-14T11:00:00.000Z', lastError: 'boom', subjectCount: 0 }).tone).toBe('error')
    expect(repositoryState({ github: 'a/b', enabled: true, writesEnabled: true, ownership: 'owned', paused: false, lastAttemptAt: null, lastSuccessAt: null, lastError: null, subjectCount: 0 }).tone).toBe('warning')
    expect(repositoryState({ github: 'a/b', enabled: true, writesEnabled: true, ownership: 'owned', paused: false, lastAttemptAt: null, lastSuccessAt: '2026-08-14T11:00:00.000Z', lastError: null, subjectCount: 0 }).tone).toBe('success')
  })
})

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'incident-1',
    scope: { _tag: 'Repository', repository: 'harlan-zw/example' },
    kind: 'github_access',
    severity: 'warning',
    message: 'Resource not accessible by integration',
    operation: 'poll',
    recovery: { _tag: 'Retrying', attempt: 2, nextAttemptAt: '2026-08-14T12:01:00.000Z' },
    occurrences: 3,
    firstSeenAt: '2026-08-14T11:50:00.000Z',
    lastSeenAt: '2026-08-14T11:59:00.000Z',
    ...overrides,
  }
}

describe('incident pane', () => {
  it('puts errors above warnings, then the most recent first', () => {
    const ordered = incidentEntries([
      incident({ id: 'old-warning', severity: 'warning', lastSeenAt: '2026-08-14T11:00:00.000Z' }),
      incident({ id: 'error', severity: 'error', lastSeenAt: '2026-08-14T10:00:00.000Z' }),
      incident({ id: 'new-warning', severity: 'warning', lastSeenAt: '2026-08-14T11:59:00.000Z' }),
    ])
    expect(ordered.map(entry => entry.id)).toEqual(['error', 'new-warning', 'old-warning'])
  })

  it('says what the controller will do next', () => {
    expect(incidentRecoveryLabel(incident())).toBe('Retrying · retry 2')
    expect(incidentRecoveryLabel(incident({ recovery: { _tag: 'Exhausted' } }))).toBe('Retries exhausted')
    expect(incidentRecoveryLabel(incident({ recovery: { _tag: 'ActionRequired' } }))).toBe('Action required')
  })

  it('names the scope a person can act on', () => {
    expect(incidentScopeLabel(incident())).toBe('harlan-zw/example')
    expect(incidentScopeLabel(incident({
      scope: { _tag: 'Task', taskId: 'task-1', repository: 'harlan-zw/example', itemNumber: 54 },
    }))).toBe('harlan-zw/example#54')
    expect(incidentScopeLabel(incident({ scope: { _tag: 'Service' } }))).toBe('Controller')
  })

  it('links a task incident to its pull request', () => {
    expect(incidentUrl(incident({
      scope: { _tag: 'Task', taskId: 'task-1', repository: 'harlan-zw/example', itemNumber: 54 },
    }))).toBe('https://github.com/harlan-zw/example/pull/54')
    expect(incidentUrl(incident({ scope: { _tag: 'Service' } }))).toBeUndefined()
  })

  it('reads a passing review that named no confidence as READY', () => {
    expect(reviewOutcomeLabel({ ...reviewAgent(), outcome: { _tag: 'Ready' } })).toBe('READY')
    expect(reviewOutcomeLabel({ ...reviewAgent(), outcome: { _tag: 'Ready', confidence: 92 } })).toBe('READY · 92/100')
  })
})

describe('system pane', () => {
  const capacity = {
    provider: 'codex' as const,
    reservePercent: 20,
    capacity: { _tag: 'Available' as const, usedPercent: 86, resetsAt: '2026-08-28T12:00:00.000Z' },
  }

  it('shows the published limit and whether its Reserve is reached', () => {
    expect(providerCapacityPresentation(capacity)).toEqual({
      label: 'Weekly Codex limit',
      value: '14% left',
      detail: '20% Reserve reached',
      tone: 'warning',
    })
  })

  it('keeps a missing reading distinct from an unpublished limit', () => {
    expect(providerCapacityPresentation({ ...capacity, capacity: { _tag: 'Unavailable', reason: 'The request timed out.' } })).toMatchObject({
      value: 'Unavailable',
      detail: 'The request timed out.',
      tone: 'warning',
    })
    expect(providerCapacityPresentation({ ...capacity, provider: 'opencode', capacity: { _tag: 'Unpublished' } })).toMatchObject({
      label: 'opencode',
      value: 'Limit not published',
      tone: 'neutral',
    })
  })

  it('stops automatic work at the Reserve without calling it Action required', () => {
    const snapshot = dashboardSnapshot({
      mutationsEnabled: true,
      agentSelection: { _tag: 'Automatic', order: ['codex'] },
      agentStart: { _tag: 'ReserveReached' },
      providerCapacities: [capacity],
    })

    expect(agentStartState(snapshot)).toEqual({ _tag: 'ReserveReached' })
    expect(systemState(snapshot)).toEqual({ label: 'Reserve reached', tone: 'warning' })
  })

  it('does not call the System healthy when an Agent provider is unavailable', () => {
    const snapshot = dashboardSnapshot({
      mutationsEnabled: true,
      agentStart: { _tag: 'Available' },
      providerCapacities: [
        { ...capacity, capacity: { _tag: 'Unavailable', reason: 'spawn codex ENOENT' } },
        { provider: 'opencode', reservePercent: 20, capacity: { _tag: 'Available', usedPercent: 29, resetsAt: '2026-08-28T12:00:00.000Z' } },
      ],
    })

    expect(systemState(snapshot)).toEqual({ label: 'Agent provider unavailable', tone: 'warning' })
  })

  it('shows a durable Agent provider pause separately from capacity', () => {
    const open = {
      id: 'provider-circuit-1',
      provider: 'opencode' as const,
      credential: 'opencode-go',
      model: 'zai-coding-plan/glm-5.3-flash',
      failureClass: 'network' as const,
      failures: 3,
      state: { _tag: 'Open' as const, retryAt: '2026-08-14T12:05:00.000Z' },
      lastDetail: 'The connection failed.',
      updatedAt: '2026-08-14T12:00:00.000Z',
    }
    const snapshot = dashboardSnapshot({
      mutationsEnabled: true,
      agentStart: { _tag: 'Available' },
      providerCircuits: [open, { ...open, id: 'closed', state: { _tag: 'Closed' as const } }],
    })

    expect(activeProviderCircuits(snapshot.providerCircuits)).toEqual([open])
    expect(systemState(snapshot)).toEqual({ label: 'Agent provider paused', tone: 'warning' })
  })

  it('puts an Incident needing a person above capacity status', () => {
    const snapshot = dashboardSnapshot({
      mutationsEnabled: true,
      incidents: [incident({ recovery: { _tag: 'ActionRequired' }, severity: 'error' })],
      agentSelection: { _tag: 'Automatic', order: ['codex'] },
      agentStart: { _tag: 'ReserveReached' },
      providerCapacities: [capacity],
    })

    expect(systemState(snapshot)).toEqual({ label: 'Action required', tone: 'error' })
  })

  it('pairs each Routine with its newest run', () => {
    const older = routineRun()
    const newest = routineRun({
      id: 'routine-run-2',
      scheduledFor: '2026-08-28T21:00:00.000Z',
      state: { _tag: 'Failed', reason: 'Sentry timed out.' },
      updatedAt: '2026-08-28T21:01:00.000Z',
    })

    expect(scheduledRoutineRecords([routine()], [older, newest])).toEqual([{
      routine: routine(),
      latestRun: newest,
    }])
  })

  it('presents Routine state and its durable detail', () => {
    expect(routineRunPresentation(routineRun({ state: { _tag: 'Failed', reason: 'Sentry timed out.' } }))).toEqual({
      label: 'Failed',
      tone: 'error',
      detail: 'Sentry timed out.',
    })
    expect(routineRunPresentation(undefined)).toEqual({ label: 'Never run', tone: 'neutral' })
    expect(routineRunPresentation(routineRun({ state: { _tag: 'Running', workerId: 'worker-1', leaseExpiresAt: '2026-08-28T22:00:00.000Z' } }))).toEqual({
      label: 'Running',
      tone: 'primary',
      detail: 'Preparing the Routine result',
    })
  })

  it('links a Routine to its tracking issue', () => {
    expect(routineTrackingUrl(routine())).toBe('https://github.com/harlan-zw/example/issues/42')
    expect(routineTrackingUrl(routine({ trackingIssueNumber: null }))).toBeUndefined()
  })
})

describe('routineReportPending', () => {
  it('stays quiet once the report is published, even with writes off', () => {
    expect(routineReportPending(routineRun(), false, true)).toBe(false)
    expect(routineReportPending(routineRun({ state: { _tag: 'Skipped', reason: 'Outside the catch-up window.' } }), false, true)).toBe(false)
  })

  it('reports a finished run whose report never published while writes are off', () => {
    expect(routineReportPending(routineRun(), false, false)).toBe(true)
    expect(routineReportPending(routineRun({ state: { _tag: 'Skipped', reason: 'Outside the catch-up window.' } }), false, false)).toBe(true)
  })

  it('stays quiet while writes are on, because the controller can still claim the report', () => {
    expect(routineReportPending(routineRun(), true, false)).toBe(false)
  })

  it('never reports a run that produces no report', () => {
    expect(routineReportPending(routineRun({ state: { _tag: 'Failed', reason: 'Sentry timed out.' } }), false, false)).toBe(false)
    expect(routineReportPending(routineRun({ state: { _tag: 'Queued' } }), false, false)).toBe(false)
    expect(routineReportPending(routineRun({ state: { _tag: 'Running', workerId: 'worker-1', leaseExpiresAt: '2026-08-28T22:00:00.000Z' } }), false, false)).toBe(false)
  })
})

describe('repositoryWritesControl', () => {
  it('offers no writes control for an external repository', () => {
    expect(repositoryWritesControl({
      github: 'someone/else',
      enabled: true,
      writesEnabled: false,
      ownership: 'external',
      lastAttemptAt: null,
      lastSuccessAt: '2026-08-14T11:00:00.000Z',
      lastError: null,
      paused: false,
      subjectCount: 3,
    })).toEqual({ _tag: 'External' })
  })

  it('keeps the writes control adjustable for mapped repositories', () => {
    const repository = {
      github: 'harlan-zw/example',
      enabled: true,
      writesEnabled: true,
      ownership: 'owned' as const,
      lastAttemptAt: null,
      lastSuccessAt: '2026-08-14T11:00:00.000Z',
      lastError: null,
      paused: false,
      subjectCount: 0,
    }
    expect(repositoryWritesControl(repository)).toEqual({ _tag: 'Adjustable', writesEnabled: true })
    expect(repositoryWritesControl({ ...repository, ownership: 'maintained', writesEnabled: false }))
      .toEqual({ _tag: 'Adjustable', writesEnabled: false })
  })
})
