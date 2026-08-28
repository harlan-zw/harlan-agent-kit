import type { ActiveAgent, DashboardRoutineRun, DashboardTask, Incident, QueueEntry, ReviewAgent, Routine } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import {
  activeAgentActivity,
  activeEntries,
  agentProfileState,
  agentStartState,
  approvalConsequence,
  buildHistory,
  decisionEntries,
  incidentEntries,
  incidentRecoveryLabel,
  incidentScopeLabel,
  incidentUrl,
  isIssueWorkThrottled,
  isProgressStalled,
  isSnapshotStale,
  providerCapacityPresentation,
  queuedEntries,
  queueDetail,
  queueStateLabel,
  queueWork,
  recentlyFinished,
  repositoryState,
  repositoryWritesControl,
  reviewOutcomeDetail,
  reviewOutcomeLabel,
  reviewUsageLabel,
  routineReportPending,
  routineRunPresentation,
  routineTrackingUrl,
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
    state: { _tag: 'Completed', evidence: 'No open Sentry issues.' },
    fence: 1,
    attempts: 1,
    progress: { percent: 85, label: 'Preparing the Routine result' },
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

describe('recentlyFinished', () => {
  it('keeps the three newest finished records for the System pane', () => {
    const tasks = [
      triageTask,
      { ...triageTask, id: 'task-2', updatedAt: '2026-08-14T11:46:00.000Z' },
      { ...triageTask, id: 'task-3', updatedAt: '2026-08-14T11:47:00.000Z' },
      { ...triageTask, id: 'task-4', updatedAt: '2026-08-14T11:48:00.000Z' },
    ]

    expect(recentlyFinished([], tasks).map(record => record.key)).toEqual([
      'task-4',
      'task-3',
      'task-2',
    ])
  })

  it('keeps superseded work in History without letting it crowd out System outcomes', () => {
    const superseded: DashboardTask = {
      ...triageTask,
      id: 'superseded',
      updatedAt: '2026-08-14T11:59:00.000Z',
      state: { _tag: 'Superseded', reason: 'A newer issue state replaced this Task.' },
    }

    expect(recentlyFinished([], [triageTask, superseded]).map(record => record.key)).toEqual(['task-triage'])
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

describe('queue copy', () => {
  it('says agents are paused rather than queued when the engine is paused', () => {
    const entry = queueEntry()
    expect(queueStateLabel(entry, { ...running, agentStart: { _tag: 'Paused' } })).toBe('Agents paused')
    expect(queueStateLabel(entry, { ...running, agentStart: { _tag: 'WritesDisabled' } })).toBe('Agents disabled')
    expect(queueStateLabel(entry, running)).toBe('Queued')
  })

  it('explains how to start work when Pause is on', () => {
    const entry = queueEntry()
    expect(queueDetail(entry, { ...running, agentStart: { _tag: 'Paused' } }))
      .toBe('Pause is on. Select Resume to start this Task.')
  })

  it('explains how to enable work when GitHub writes are off', () => {
    const entry = queueEntry()
    expect(queueDetail(entry, { ...running, agentStart: { _tag: 'WritesDisabled' } }))
      .toBe('GitHub writes are off. Enable them in the configuration, then restart the service.')
  })

  it('explains when every automatic provider has reached its Reserve', () => {
    const entry = queueEntry()
    const context = { ...running, agentStart: { _tag: 'ReserveReached' as const } }

    expect(queueStateLabel(entry, context)).toBe('Reserve reached')
    expect(queueDetail(entry, context)).toBe('Every automatic Agent provider reached its Reserve. Work starts after a limit resets.')
  })

  it('explains when provider limits could not load', () => {
    const entry = queueEntry()
    const context = { ...running, agentStart: { _tag: 'CapacityUnavailable' as const } }

    expect(queueStateLabel(entry, context)).toBe('Agent provider unavailable')
    expect(queueDetail(entry, context)).toBe('Agent provider limits could not load. The controller will retry.')
  })

  it('reports the reason a subject needs attention', () => {
    const entry = queueEntry({ state: { _tag: 'ActionRequired', reason: 'The fork branch is not writable.' } })
    expect(queueDetail(entry, running)).toBe('The fork branch is not writable.')
  })
})

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
    expect(queueDetail(issueWork, { ...running, openPullRequests: 17 }))
      .toBe('Issue work stops above 8 open pull requests, and 17 are open. Merge or close some to start it.')
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

  it('shows the percentage the Agent reported', () => {
    expect(activeAgentActivity(activeAgent({
      activity: [{
        _tag: 'Progress',
        at: '2026-08-14T11:59:00.000Z',
        percent: 25,
        text: 'next-step (waitlist flow read).',
      }],
    }))).toEqual({
      at: '2026-08-14T11:59:00.000Z',
      text: '25% · next-step (waitlist flow read).',
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
    expect(incidentRecoveryLabel(incident())).toBe('Retrying · attempt 2')
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
