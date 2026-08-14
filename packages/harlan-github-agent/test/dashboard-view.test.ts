import type { ActiveAgent, AgentTask, QueueEntry, ReviewAgent } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import {
  approvalConsequence,
  buildHistory,
  decisionEntries,
  isProgressStalled,
  isSnapshotStale,
  queueDetail,
  queueStateLabel,
  repositoryState,
  taskKindLabel,
  taskStateTone,
  taskSubjectUrl,
  upNextEntries,
} from '../dashboard/app/utils/dashboard.ts'

const now = new Date('2026-08-14T12:00:00.000Z')

function activeAgent(overrides: Partial<ActiveAgent> = {}): ActiveAgent {
  return {
    _tag: 'ActiveAgent',
    id: 'agent-1',
    provider: 'codex',
    role: 'adversarial_review',
    session: { _tag: 'Starting' },
    repository: 'harlan-zw/nuxt-seo',
    repositoryUrl: 'https://github.com/harlan-zw/nuxt-seo',
    subjectKind: 'pull_request',
    subjectNumber: 412,
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
      head: { _tag: 'Passed', evidence: [] },
      merge: { _tag: 'Passed', evidence: [] },
      metadata: { _tag: 'Passed', evidence: [] },
      review: { _tag: 'Passed', evidence: [] },
      verification: { _tag: 'Passed', evidence: [] },
      ci: { _tag: 'Passed', evidence: [] },
    },
    outcome: { _tag: 'Ready', confidence: 90 },
    findings: [],
    publications: [],
    ...overrides,
  } as ReviewAgent
}

const reviewTask: AgentTask = {
  id: 'task-review',
  kind: 'adversarial_review',
  repository: 'harlan-zw/nuxt-seo',
  pullRequestNumber: 412,
  revisionId: 'rev-a',
  state: { _tag: 'Completed', evidence: 'done' },
  updatedAt: '2026-08-14T11:31:00.000Z',
}

const triageTask: AgentTask = {
  id: 'task-triage',
  kind: 'issue_triage',
  repository: 'harlan-zw/unlighthouse',
  issueNumber: 88,
  revisionId: 'rev-i',
  state: { _tag: 'Failed', reason: 'The focused test suite did not pass.' },
  updatedAt: '2026-08-14T11:45:00.000Z',
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
    const running: AgentTask = { ...triageTask, state: { _tag: 'Queued' } }
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
})

describe('upNextEntries', () => {
  it('hides work that is already visible as a running agent', () => {
    const entry = queueEntry({ state: { _tag: 'Active', work: 'adversarial_review' } })
    expect(upNextEntries([entry], [activeAgent()])).toEqual([])
  })

  it('keeps active work when no agent reports it, so it cannot vanish', () => {
    const entry = queueEntry({ state: { _tag: 'Active', work: 'adversarial_review' } })
    expect(upNextEntries([entry], [])).toHaveLength(1)
  })

  it('excludes anything that needs a decision', () => {
    const entry = queueEntry({ state: { _tag: 'AwaitingApproval', kind: 'review' } })
    expect(upNextEntries([entry], [])).toEqual([])
  })
})

describe('decisionEntries', () => {
  it('collects approvals and failures only', () => {
    const entries = [
      queueEntry({ state: { _tag: 'AwaitingApproval', kind: 'review' } }),
      queueEntry({ state: { _tag: 'NeedsAttention', reason: 'Not writable.' } }),
      queueEntry({ state: { _tag: 'Queued', work: 'adversarial_review' } }),
    ]
    expect(decisionEntries(entries)).toHaveLength(2)
  })
})

describe('queue copy', () => {
  it('says agents are paused rather than queued when the engine is paused', () => {
    const entry = queueEntry()
    expect(queueStateLabel(entry, { agentsCanStart: false, agentsPaused: true })).toBe('Agents paused')
    expect(queueStateLabel(entry, { agentsCanStart: false, agentsPaused: false })).toBe('Agents disabled')
    expect(queueStateLabel(entry, { agentsCanStart: true, agentsPaused: false })).toBe('Queued')
  })

  it('reports the reason a subject needs attention', () => {
    const entry = queueEntry({ state: { _tag: 'NeedsAttention', reason: 'The fork branch is not writable.' } })
    expect(queueDetail(entry, { agentsCanStart: true, agentsPaused: false })).toBe('The fork branch is not writable.')
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
    expect(repositoryState({ github: 'a/b', enabled: true, ownership: 'owned', paused: false, lastAttemptAt: null, lastSuccessAt: '2026-08-14T11:00:00.000Z', lastError: 'boom', subjectCount: 0 }).tone).toBe('error')
    expect(repositoryState({ github: 'a/b', enabled: true, ownership: 'owned', paused: false, lastAttemptAt: null, lastSuccessAt: null, lastError: null, subjectCount: 0 }).tone).toBe('warning')
    expect(repositoryState({ github: 'a/b', enabled: true, ownership: 'owned', paused: false, lastAttemptAt: null, lastSuccessAt: '2026-08-14T11:00:00.000Z', lastError: null, subjectCount: 0 }).tone).toBe('success')
  })
})
