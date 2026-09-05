import type { AgentProviderName } from '../src/agent-provider.ts'
import type { ProviderCapacity } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { createAgentRuntimeSource, parseAgentSelection, resolveAgentSelection } from '../src/agent-profile.ts'
import { agentStartBlockedReason, resolveAgentStartState } from '../src/capacity.ts'
import {
  chooseAgentProvider,
  createProviderCapacitySource,
  hasSpendableCapacity,
  readZaiApiKey,
  readZaiCapacity,
  WEEKLY_WINDOW_MINUTES,
  weeklyCodexCapacity,
  zaiPlanCapacity,
} from '../src/provider-capacity.ts'
import { openJournalStore } from '../src/store.ts'

const stubProvider = (name: AgentProviderName) => ({ name, runTurn: () => (async function* () {})() })

function codexResult(usedPercent: number, windowDurationMins = WEEKLY_WINDOW_MINUTES): unknown {
  return {
    rateLimitsByLimitId: {
      codex: {
        primary: { windowDurationMins: 300, usedPercent: 4, resetsAt: 1_800_000_000 },
        secondary: { windowDurationMins, usedPercent, resetsAt: 1_800_000_000 },
      },
    },
  }
}

describe('reading the weekly Codex window', () => {
  it('reads the seven-day window and reports when it resets', () => {
    expect(weeklyCodexCapacity(codexResult(55))).toEqual({
      _tag: 'Available',
      usedPercent: 55,
      resetsAt: '2027-01-15T08:00:00.000Z',
    })
  })

  it('reads the older rateLimits shape, because both versions are in use', () => {
    const result = {
      rateLimits: {
        primary: { windowDurationMins: WEEKLY_WINDOW_MINUTES, usedPercent: 12, resetsAt: 1_800_000_000 },
      },
    }

    expect(weeklyCodexCapacity(result)).toMatchObject({ _tag: 'Available', usedPercent: 12 })
  })

  it('reports unavailable when no window covers seven days', () => {
    expect(weeklyCodexCapacity(codexResult(55, 300))).toEqual({
      _tag: 'Unavailable',
      reason: 'Codex reported no seven-day window.',
    })
  })

  it('reports unavailable when the window carries no readable numbers', () => {
    const result = { rateLimits: { primary: { windowDurationMins: WEEKLY_WINDOW_MINUTES, usedPercent: 'most' } } }

    expect(weeklyCodexCapacity(result)).toEqual({
      _tag: 'Unavailable',
      reason: 'Codex reported an unreadable seven-day window.',
    })
  })
})

describe('spending a weekly window against the reserve', () => {
  it('spends a window that still has more than the reserve left', () => {
    expect(hasSpendableCapacity({ _tag: 'Available', usedPercent: 55, resetsAt: '' }, 20)).toBe(true)
  })

  it('stops at the reserve line, so interactive work keeps the last share', () => {
    expect(hasSpendableCapacity({ _tag: 'Available', usedPercent: 80, resetsAt: '' }, 20)).toBe(false)
    expect(hasSpendableCapacity({ _tag: 'Available', usedPercent: 95, resetsAt: '' }, 20)).toBe(false)
  })

  it('spends a provider that publishes no quota, because unknown is not empty', () => {
    expect(hasSpendableCapacity({ _tag: 'Unpublished' }, 20)).toBe(true)
  })

  it('keeps half the GLM Coding Plan for interactive work', () => {
    expect(hasSpendableCapacity({ _tag: 'Available', usedPercent: 49, resetsAt: '' }, 50)).toBe(true)
    expect(hasSpendableCapacity({ _tag: 'Available', usedPercent: 51, resetsAt: '' }, 50)).toBe(false)
  })

  it('refuses a published window it could not read', () => {
    expect(hasSpendableCapacity({ _tag: 'Unavailable', reason: 'timed out' }, 20)).toBe(false)
  })
})

describe('choosing an Agent provider automatically', () => {
  const capacities = (codex: ProviderCapacity) => (provider: AgentProviderName): ProviderCapacity =>
    provider === 'codex' ? codex : { _tag: 'Unpublished' }

  it('takes the first provider in preference order that may spend', () => {
    const chosen = chooseAgentProvider({
      capacity: capacities({ _tag: 'Available', usedPercent: 10, resetsAt: '' }),
      order: ['codex', 'opencode'],
      reservePercent: { codex: 20, opencode: 20 },
    })

    expect(chosen).toBe('codex')
  })

  it('falls to the next provider once the reserve is reached', () => {
    const chosen = chooseAgentProvider({
      capacity: capacities({ _tag: 'Available', usedPercent: 85, resetsAt: '' }),
      order: ['codex', 'opencode'],
      reservePercent: { codex: 20, opencode: 20 },
    })

    expect(chosen).toBe('opencode')
  })

  it('answers null when no provider may spend', () => {
    const chosen = chooseAgentProvider({
      capacity: () => ({ _tag: 'Unavailable', reason: 'unread' }),
      order: ['codex', 'opencode'],
      reservePercent: { codex: 20, opencode: 20 },
    })

    expect(chosen).toBeNull()
  })

  it('honours preference order, so opencode can lead', () => {
    const chosen = chooseAgentProvider({
      capacity: capacities({ _tag: 'Available', usedPercent: 0, resetsAt: '' }),
      order: ['opencode', 'codex'],
      reservePercent: { codex: 20, opencode: 20 },
    })

    expect(chosen).toBe('opencode')
  })
})

describe('resolving Agent start state', () => {
  const input = {
    mutationsEnabled: true,
    agentControl: { _tag: 'Running' as const },
    restartRequest: null,
    agentSelection: { _tag: 'Automatic' as const, order: ['codex'] as const },
  }

  it('names a reached Reserve without creating Action required', () => {
    expect(resolveAgentStartState({
      ...input,
      providerCapacities: [{
        provider: 'codex',
        reservePercent: 20,
        capacity: { _tag: 'Available', usedPercent: 86, resetsAt: '2026-08-28T00:00:00.000Z' },
      }],
    })).toEqual({ _tag: 'ReserveReached' })
  })

  it('blames the Reserve, not the unread provider, when one provider did publish', () => {
    // One unreadable provider used to name the whole state CapacityUnavailable,
    // which reads as a broken provider API. The Reserve is the actionable half.
    expect(resolveAgentStartState({
      ...input,
      agentSelection: { _tag: 'Automatic' as const, order: ['opencode', 'codex'] as const },
      providerCapacities: [
        {
          provider: 'opencode',
          reservePercent: 50,
          capacity: { _tag: 'Available', usedPercent: 50.36, resetsAt: '2026-09-04T14:33:32.989Z' },
        },
        {
          provider: 'codex',
          reservePercent: 20,
          capacity: { _tag: 'Unavailable', reason: 'Codex refused to report its rate limits.' },
        },
      ],
    })).toEqual({ _tag: 'ReserveReached' })
  })

  it('keeps an unread limit distinct from a reached Reserve', () => {
    expect(resolveAgentStartState({
      ...input,
      providerCapacities: [{
        provider: 'codex',
        reservePercent: 20,
        capacity: { _tag: 'Unavailable', reason: 'timed out' },
      }],
    })).toEqual({ _tag: 'CapacityUnavailable' })
  })
})

describe('naming why no Agent may start', () => {
  const selection = { _tag: 'Automatic' as const, order: ['opencode', 'codex'] as const }
  const reserved = {
    provider: 'opencode' as const,
    reservePercent: 25,
    capacity: { _tag: 'Available' as const, usedPercent: 50.36, resetsAt: '2026-09-04T14:33:32.989Z' },
  }
  const unreadable = {
    provider: 'codex' as const,
    reservePercent: 20,
    capacity: { _tag: 'Unavailable' as const, reason: 'Codex refused to report its rate limits.' },
  }

  it('says nothing while an Agent may start', () => {
    expect(agentStartBlockedReason({
      startState: { _tag: 'Available' },
      queuedTasks: 27,
      runningTasks: 0,
      agentSelection: selection,
      providerCapacities: [reserved, unreadable],
    })).toBeNull()
  })

  it('says nothing when no Task is waiting, because nothing is held', () => {
    expect(agentStartBlockedReason({
      startState: { _tag: 'ReserveReached' },
      queuedTasks: 0,
      runningTasks: 0,
      agentSelection: selection,
      providerCapacities: [reserved, unreadable],
    })).toBeNull()
  })

  it('names the Reserve, the usage, and the reset a person needs to act', () => {
    expect(agentStartBlockedReason({
      startState: { _tag: 'ReserveReached' },
      queuedTasks: 27,
      runningTasks: 0,
      agentSelection: selection,
      providerCapacities: [reserved, unreadable],
    })).toBe('Every Agent provider reached its Reserve, so 27 queued Tasks cannot start. opencode used 50.4% and reserves 25%, resetting 2026-09-04T14:33:32.989Z. codex did not report a limit: Codex refused to report its rate limits.')
  })

  it('says nothing while an Agent holds a Task, because a stall means nothing runs', () => {
    // One capacity reading missed a provider and named the whole fleet blocked
    // while six Agents were working. A held Task disproves the reading.
    expect(agentStartBlockedReason({
      startState: { _tag: 'CapacityUnavailable' },
      queuedTasks: 14,
      runningTasks: 6,
      agentSelection: selection,
      providerCapacities: [reserved, unreadable],
    })).toBeNull()
  })

  it('reads one waiting Task as one Task', () => {
    const reason = agentStartBlockedReason({
      startState: { _tag: 'CapacityUnavailable' },
      queuedTasks: 1,
      runningTasks: 0,
      agentSelection: selection,
      providerCapacities: [unreadable],
    })

    expect(reason).toContain('so 1 queued Task cannot start.')
  })
})

describe('parsing an automatic Agent selection', () => {
  it('accepts an explicit preference order', () => {
    expect(parseAgentSelection({ _tag: 'Automatic', order: ['opencode', 'codex'] })).toEqual({
      _tag: 'Ok',
      value: { _tag: 'Automatic', order: ['opencode', 'codex'] },
    })
  })

  it('defaults to every provider when the order is omitted', () => {
    expect(parseAgentSelection({ _tag: 'Automatic' })).toEqual({
      _tag: 'Ok',
      value: { _tag: 'Automatic', order: ['codex', 'opencode'] },
    })
  })

  it('rejects an empty order, because there would be nothing to walk', () => {
    expect(parseAgentSelection({ _tag: 'Automatic', order: [] })).toEqual({
      _tag: 'Err',
      error: 'List at least one Agent provider in preference order.',
    })
  })

  it('rejects a repeated provider', () => {
    expect(parseAgentSelection({ _tag: 'Automatic', order: ['codex', 'codex'] })).toEqual({
      _tag: 'Err',
      error: 'List every Agent provider once.',
    })
  })

  it('rejects an unknown provider in the order', () => {
    expect(parseAgentSelection({ _tag: 'Automatic', order: ['claude'] })).toEqual({
      _tag: 'Err',
      error: 'Select codex or opencode as the Agent provider.',
    })
  })
})

describe('resolving an automatic Agent selection', () => {
  const configured = { provider: 'codex' as const, model: null, reasoningEffort: null }

  it('asks the chooser which provider answers the next turn', () => {
    const resolved = resolveAgentSelection(
      { _tag: 'Automatic', order: ['codex', 'opencode'] },
      configured,
      () => 'opencode',
    )

    expect(resolved).toEqual({ provider: 'opencode', model: null, reasoningEffort: null })
  })

  it('keeps the first provider in order when none may spend, so the turn stays answerable', () => {
    const resolved = resolveAgentSelection(
      { _tag: 'Automatic', order: ['opencode', 'codex'] },
      configured,
      () => null,
    )

    expect(resolved.provider).toBe('opencode')
  })

  it('sends the chosen provider to the runtime, with that provider role defaults', () => {
    let chosen: AgentProviderName = 'codex'
    const runtime = createAgentRuntimeSource({
      chooseProvider: () => chosen,
      configuredProvider: 'codex',
      maximumActiveAgents: 3,
      providers: { codex: stubProvider('codex'), opencode: stubProvider('opencode') },
      selection: () => ({ _tag: 'Automatic', order: ['codex', 'opencode'] }),
    })

    const before = runtime()
    chosen = 'opencode'
    const after = runtime()

    expect(before.profile.roles.adversarial_review.model).toBe('gpt-5.6-sol')
    expect(after.profile.roles.adversarial_review.model).toBe('zai-coding-plan/glm-5.3-flash')
  })
})

describe('storing an automatic Agent selection', () => {
  it('survives a reopen, so a restart keeps automatic selection', () => {
    const store = openJournalStore(':memory:')
    try {
      store.selectAgent({ _tag: 'Automatic', order: ['opencode', 'codex'] }, '2026-08-27T01:00:00.000Z')

      expect(store.getAgentSelection()).toEqual({ _tag: 'Automatic', order: ['opencode', 'codex'] })
    }
    finally {
      store.close()
    }
  })

  it('replaces a pinned selection, so the two states never both apply', () => {
    const store = openJournalStore(':memory:')
    try {
      store.selectAgent({ _tag: 'Pinned', provider: 'opencode', model: null, reasoningEffort: null }, '2026-08-27T01:00:00.000Z')
      store.selectAgent({ _tag: 'Automatic', order: ['codex', 'opencode'] }, '2026-08-27T01:01:00.000Z')

      expect(store.getAgentSelection()).toEqual({ _tag: 'Automatic', order: ['codex', 'opencode'] })
    }
    finally {
      store.close()
    }
  })
})

describe('the capacity source', () => {
  it('reports opencode as unavailable until the first plan reading lands', () => {
    const source = createProviderCapacitySource({ onError: () => undefined })

    expect(source.read('opencode')).toMatchObject({ _tag: 'Unavailable' })
  })

  it('keeps reading opencode when Codex fails, so one outage stops nothing', async () => {
    const source = createProviderCapacitySource({
      onError: () => undefined,
      readCodex: () => Promise.reject(new Error('codex is down')),
      readOpencode: async () => ({ _tag: 'Available', usedPercent: 12, resetsAt: '2026-09-01T00:00:00.000Z' }),
    })

    await source.refresh()

    expect(source.read('codex')).toMatchObject({ _tag: 'Unavailable' })
    expect(source.read('opencode')).toMatchObject({ _tag: 'Available', usedPercent: 12 })
  })

  it('reports Codex as unavailable until the first reading lands', () => {
    const source = createProviderCapacitySource({ onError: () => undefined })

    expect(source.read('codex')).toMatchObject({ _tag: 'Unavailable' })
  })

  it('serves the last Codex reading without spawning a process per turn', async () => {
    let reads = 0
    const source = createProviderCapacitySource({
      onError: () => undefined,
      readCodex: async () => {
        reads += 1
        return { _tag: 'Available', usedPercent: 30, resetsAt: '2026-09-01T00:00:00.000Z' }
      },
      readOpencode: async () => ({ _tag: 'Unpublished' }),
    })

    await source.refresh()

    expect(source.read('codex')).toMatchObject({ _tag: 'Available', usedPercent: 30 })
    expect(source.read('codex')).toMatchObject({ _tag: 'Available', usedPercent: 30 })
    expect(reads).toBe(1)
  })
})

describe('reading the GLM Coding Plan quota', () => {
  /** The exact shape the plan answers with, taken from a live response. */
  const liveQuota = {
    code: 200,
    data: {
      level: 'max',
      limits: [
        { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 28_000, currentValue: 31, nextResetTime: 1_787_816_752_166 },
        { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 140_000, currentValue: 48, nextResetTime: 1_787_927_612_998 },
      ],
    },
  }

  it('computes its own percentage, because the plan rounds its one', () => {
    expect(zaiPlanCapacity(liveQuota)).toMatchObject({ _tag: 'Available' })
    const capacity = zaiPlanCapacity(liveQuota)
    if (capacity._tag !== 'Available')
      throw new Error('expected an available window')
    // 31 of 28,000 in the five-hour window beats 48 of 140,000 in the week.
    expect(capacity.usedPercent).toBeCloseTo((31 / 28_000) * 100, 6)
  })

  it('answers with the fullest window, so a spent five hours stops the fleet', () => {
    const capacity = zaiPlanCapacity({
      data: {
        limits: [
          { usage: 28_000, currentValue: 27_000, nextResetTime: 1_787_816_752_166 },
          { usage: 140_000, currentValue: 14_000, nextResetTime: 1_787_927_612_998 },
        ],
      },
    })

    expect(capacity).toEqual({
      _tag: 'Available',
      usedPercent: (27_000 / 28_000) * 100,
      resetsAt: new Date(1_787_816_752_166).toISOString(),
    })
  })

  it('reports unavailable when the plan answers no windows', () => {
    expect(zaiPlanCapacity({ data: { limits: [] } })).toEqual({
      _tag: 'Unavailable',
      reason: 'The GLM Coding Plan answered no quota windows.',
    })
  })

  it('reports unavailable when a window carries no readable numbers', () => {
    expect(zaiPlanCapacity({ data: { limits: [{ usage: 'lots', currentValue: 1 }] } })).toEqual({
      _tag: 'Unavailable',
      reason: 'The GLM Coding Plan answered no readable quota window.',
    })
  })

  it('ignores a window whose allowance is zero, so it never divides by it', () => {
    expect(zaiPlanCapacity({ data: { limits: [{ usage: 0, currentValue: 0 }] } })).toMatchObject({ _tag: 'Unavailable' })
  })

  it('names the HTTP status when the plan refuses the quota read', async () => {
    const capacity = await readZaiCapacity({
      apiKey: 'key',
      fetchQuota: async () => { throw new Error('The GLM Coding Plan answered 429.') },
    })

    expect(capacity).toEqual({ _tag: 'Unavailable', reason: 'The GLM Coding Plan answered 429.' })
  })

  it('names the socket error when the quota request never connects', async () => {
    const capacity = await readZaiCapacity({
      apiKey: 'key',
      fetchQuota: async () => { throw new TypeError('fetch failed', { cause: { code: 'ENETUNREACH' } }) },
    })

    expect(capacity).toEqual({ _tag: 'Unavailable', reason: 'The GLM Coding Plan quota could not be read: ENETUNREACH.' })
  })

  it('answers no key when opencode declares no plan, which is not a fault', () => {
    expect(readZaiApiKey('/nonexistent/opencode.json')).toBeNull()
  })
})
