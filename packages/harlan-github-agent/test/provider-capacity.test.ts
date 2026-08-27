import type { AgentProviderName } from '../src/agent-provider.ts'
import type { ProviderCapacity } from '../src/types.ts'
import { describe, expect, it } from 'vitest'
import { createAgentRuntimeSource, parseAgentSelection, resolveAgentSelection } from '../src/agent-profile.ts'
import {
  chooseAgentProvider,
  createProviderCapacitySource,
  hasSpendableCapacity,
  WEEKLY_WINDOW_MINUTES,
  weeklyCodexCapacity,
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
      reservePercent: 20,
    })

    expect(chosen).toBe('codex')
  })

  it('falls to the next provider once the reserve is reached', () => {
    const chosen = chooseAgentProvider({
      capacity: capacities({ _tag: 'Available', usedPercent: 85, resetsAt: '' }),
      order: ['codex', 'opencode'],
      reservePercent: 20,
    })

    expect(chosen).toBe('opencode')
  })

  it('answers null when no provider may spend', () => {
    const chosen = chooseAgentProvider({
      capacity: () => ({ _tag: 'Unavailable', reason: 'unread' }),
      order: ['codex', 'opencode'],
      reservePercent: 20,
    })

    expect(chosen).toBeNull()
  })

  it('honours preference order, so opencode can lead', () => {
    const chosen = chooseAgentProvider({
      capacity: capacities({ _tag: 'Available', usedPercent: 0, resetsAt: '' }),
      order: ['opencode', 'codex'],
      reservePercent: 20,
    })

    expect(chosen).toBe('opencode')
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
    expect(after.profile.roles.adversarial_review.model).toBe('opencode-go/deepseek-v4-flash')
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
  it('reports opencode as unpublished, because opencode publishes no quota', () => {
    const source = createProviderCapacitySource({ onError: () => undefined })

    expect(source.read('opencode')).toEqual({ _tag: 'Unpublished' })
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
    })

    await source.refresh()

    expect(source.read('codex')).toMatchObject({ _tag: 'Available', usedPercent: 30 })
    expect(source.read('codex')).toMatchObject({ _tag: 'Available', usedPercent: 30 })
    expect(reads).toBe(1)
  })
})
