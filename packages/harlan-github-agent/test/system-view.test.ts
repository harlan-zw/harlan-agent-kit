import type { ActiveAgent, AgentStartState, Incident, QueueEntry } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import {
  capacityRow,
  circuitNotice,
  documentTitle,
  faviconTone,
  nextRoutineInstant,
  restartNotice,
  systemChipState,
} from '../dashboard/app/utils/system.ts'
import { dashboardSnapshot } from './fixtures.ts'

function activeAgent(overrides: Partial<ActiveAgent> = {}): ActiveAgent {
  return {
    _tag: 'ActiveAgent',
    id: 'agent-1',
    provider: 'codex',
    role: 'review_fix',
    session: { _tag: 'Connected', id: '0f7d1c2e-1111-4222-8333-444455556666' },
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

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: 'incident-1',
    scope: { _tag: 'Repository', repository: 'harlan-zw/unhead' },
    kind: 'github_access',
    severity: 'error',
    message: 'GitHub answered 403.',
    operation: 'poll',
    recovery: { _tag: 'Retrying', attempt: 2, nextAttemptAt: '2026-08-14T12:05:00.000Z' },
    occurrences: 3,
    firstSeenAt: '2026-08-14T11:00:00.000Z',
    lastSeenAt: '2026-08-14T11:58:00.000Z',
    ...overrides,
  }
}

function queueEntry(state: QueueEntry['state'], number = 1): QueueEntry {
  return {
    kind: 'pull_request',
    position: number,
    revisionId: 'a'.repeat(64),
    repository: 'harlan-zw/nuxt-seo',
    repositoryUrl: 'https://github.com/harlan-zw/nuxt-seo',
    number,
    title: `Pull request ${number}`,
    author: 'contributor',
    subjectUrl: `https://github.com/harlan-zw/nuxt-seo/pull/${number}`,
    headSha: 'abc123',
    commitUrl: 'https://github.com/harlan-zw/nuxt-seo/commit/abc123',
    createdAt: '2026-08-14T10:00:00.000Z',
    updatedAt: '2026-08-14T10:00:00.000Z',
    state,
  }
}

describe('documentTitle', () => {
  it('leads with the Needs you count on every page', () => {
    expect(documentTitle(2)).toBe('(2) Harlan GitHub Agent')
    expect(documentTitle(2, 'Stats')).toBe('(2) Stats · Harlan GitHub Agent')
    expect(documentTitle(0, 'How it works')).toBe('How it works · Harlan GitHub Agent')
  })
})

describe('systemChipState', () => {
  it('reports nothing before the first snapshot, so placeholder state never reads as amber', () => {
    expect(systemChipState(dashboardSnapshot({ generatedAt: '', agentStart: { _tag: 'WritesDisabled' } }))).toEqual({ _tag: 'Loading' })
  })

  it('reads grey with the running count and pulses only while an agent runs', () => {
    const idle = systemChipState(dashboardSnapshot({ agentStart: { _tag: 'Available' } }))
    expect(idle).toEqual({ _tag: 'Normal', active: 0, maximum: 4, live: false })

    const busy = systemChipState(dashboardSnapshot({ agentStart: { _tag: 'Available' }, agents: [activeAgent()] }))
    expect(busy).toMatchObject({ _tag: 'Normal', active: 1, live: true })
  })

  it('names the one reason work cannot start', () => {
    const reasons: Array<[AgentStartState, string]> = [
      [{ _tag: 'Paused' }, 'Paused'],
      [{ _tag: 'WritesDisabled' }, 'Writes off'],
      [{ _tag: 'ReserveReached' }, 'Reserve reached'],
      [{ _tag: 'CapacityUnavailable' }, 'No capacity'],
      [{ _tag: 'RestartRequested' }, 'Restarting after current work'],
    ]
    reasons.forEach(([agentStart, reason]) => {
      expect(systemChipState(dashboardSnapshot({ agentStart }))).toMatchObject({ _tag: 'CannotStart', reason })
    })
  })

  it('names Manual only when every candidate waits on an Approval', () => {
    const waiting = dashboardSnapshot({
      agentStart: { _tag: 'Available' },
      selectionMode: 'manual',
      queue: [queueEntry({ _tag: 'AwaitingApproval', kind: 'review' })],
    })
    expect(systemChipState(waiting)).toMatchObject({ _tag: 'CannotStart', reason: 'Manual' })

    const flowing = dashboardSnapshot({
      agentStart: { _tag: 'Available' },
      selectionMode: 'manual',
      queue: [queueEntry({ _tag: 'AwaitingApproval', kind: 'review' }), queueEntry({ _tag: 'Queued', work: 'review_fix' }, 2)],
    })
    expect(systemChipState(flowing)._tag).toBe('Normal')

    const empty = dashboardSnapshot({ agentStart: { _tag: 'Available' }, selectionMode: 'manual' })
    expect(systemChipState(empty)._tag).toBe('Normal')
  })

  it('turns red with the count once an Incident is open, even while paused', () => {
    const snapshot = dashboardSnapshot({
      agentStart: { _tag: 'Paused' },
      incidents: [incident(), incident({ id: 'incident-2', severity: 'warning' })],
      agents: [activeAgent()],
    })
    expect(systemChipState(snapshot)).toEqual({ _tag: 'Incident', incidents: 2, active: 1, maximum: 4, live: true })
  })
})

describe('capacityRow', () => {
  it('shows what is left and whether the Reserve holds it', () => {
    const open = capacityRow({ provider: 'codex', reservePercent: 20, capacity: { _tag: 'Available', usedPercent: 63.26, resetsAt: '2026-08-17T00:00:00.000Z' } })
    expect(open).toMatchObject({ name: 'Codex', value: '36.7% left', detail: 'Reserve 20%', resetsAt: '2026-08-17T00:00:00.000Z', tone: 'neutral' })

    const held = capacityRow({ provider: 'codex', reservePercent: 20, capacity: { _tag: 'Available', usedPercent: 85, resetsAt: '2026-08-17T00:00:00.000Z' } })
    expect(held).toMatchObject({ value: '15% left', detail: 'Reserve 20% reached', tone: 'warning' })
  })

  it('says when a provider publishes no limit or cannot be read', () => {
    expect(capacityRow({ provider: 'opencode', reservePercent: 0, capacity: { _tag: 'Unpublished' } }))
      .toMatchObject({ name: 'opencode', value: 'Not published', resetsAt: null, tone: 'neutral' })
    expect(capacityRow({ provider: 'codex', reservePercent: 20, capacity: { _tag: 'Unavailable', reason: 'Login expired.' } }))
      .toMatchObject({ value: 'Unavailable', detail: 'Login expired.', tone: 'warning' })
  })
})

describe('circuitNotice', () => {
  const base = {
    id: 'circuit-1',
    provider: 'codex' as const,
    credential: 'chatgpt',
    model: 'gpt-5.6-sol',
    failureClass: 'network' as const,
    failures: 3,
    lastDetail: 'ECONNRESET',
    updatedAt: '2026-08-14T11:00:00.000Z',
  }

  it('stays silent while the circuit is closed', () => {
    expect(circuitNotice({ ...base, state: { _tag: 'Closed' } })).toBeUndefined()
  })

  it('names the provider, the failure count, and when the next attempt happens', () => {
    const open = circuitNotice({ ...base, state: { _tag: 'Open', retryAt: '2026-08-14T11:30:00.000Z' } })
    expect(open).toEqual({ _tag: 'Open', text: 'Codex circuit is open after 3 failures (network).', retryAt: '2026-08-14T11:30:00.000Z' })

    const half = circuitNotice({ ...base, failures: 1, state: { _tag: 'HalfOpen', workerId: 'w', fence: 1, leaseExpiresAt: '2026-08-14T11:40:00.000Z' } })
    expect(half?._tag).toBe('HalfOpen')
  })
})

describe('restartNotice', () => {
  const base = { id: 'restart-1', source: 'dashboard' as const, requestedAt: '2026-08-14T11:00:00.000Z' }

  it('renders nothing for no request or a finished one', () => {
    expect(restartNotice(null)).toBeUndefined()
    expect(restartNotice({ ...base, _tag: 'Completed', restartingAt: '2026-08-14T11:05:00.000Z', completedAt: '2026-08-14T11:06:00.000Z' })).toBeUndefined()
  })

  it('carries the reason when the restart needs a person', () => {
    expect(restartNotice({ ...base, _tag: 'Requested' })?._tag).toBe('Requested')
    expect(restartNotice({ ...base, _tag: 'Restarting', restartingAt: '2026-08-14T11:05:00.000Z' })?._tag).toBe('Restarting')
    expect(restartNotice({ ...base, _tag: 'ActionRequired', actionRequiredAt: '2026-08-14T11:07:00.000Z', reason: 'The new process never answered /health.' }))
      .toEqual({ _tag: 'ActionRequired', text: 'Restart did not complete: The new process never answered /health.' })
  })
})

describe('nextRoutineInstant', () => {
  it('finds the next weekday morning in the Routine time zone', () => {
    // Friday 14 August 2026, 02:00 UTC is 12:00 in Sydney, past the 09:00 slot.
    const from = new Date('2026-08-14T02:00:00.000Z')
    const next = nextRoutineInstant({ crons: ['0 9 * * 1-5'], timeZone: 'Australia/Sydney', enabled: true }, from)
    // Monday 17 August 09:00 AEST is 23:00 UTC on Sunday 16 August.
    expect(next?.toISOString()).toBe('2026-08-16T23:00:00.000Z')
  })

  it('takes the earliest of several expressions and skips a disabled Routine', () => {
    const from = new Date('2026-08-14T02:00:00.000Z')
    const next = nextRoutineInstant({ crons: ['0 9 * * 1-5', '30 14 * * *'], timeZone: 'Australia/Sydney', enabled: true }, from)
    expect(next?.toISOString()).toBe('2026-08-14T04:30:00.000Z')
    expect(nextRoutineInstant({ crons: ['0 9 * * *'], timeZone: 'UTC', enabled: false }, from)).toBeUndefined()
  })
})

describe('faviconTone', () => {
  it('goes red for a failing repository or an Incident nobody retries', () => {
    expect(faviconTone(dashboardSnapshot({ incidents: [incident({ recovery: { _tag: 'Exhausted' } })] }), 0)).toBe('error')
    expect(faviconTone(dashboardSnapshot({ repositories: [{ github: 'harlan-zw/unhead', enabled: true, writesEnabled: true, ownership: 'owned', lastAttemptAt: null, lastSuccessAt: null, lastError: 'boom', paused: false, subjectCount: 0 }] }), 0)).toBe('error')
  })

  it('goes amber when a decision waits or a retry is under way, else green', () => {
    expect(faviconTone(dashboardSnapshot(), 2)).toBe('warning')
    expect(faviconTone(dashboardSnapshot({ incidents: [incident()] }), 0)).toBe('warning')
    expect(faviconTone(dashboardSnapshot(), 0)).toBe('success')
  })
})
