import type { AgentEvent, AgentProvider, AgentTurnRequest } from '../src/agent-provider.ts'
import { describe, expect, it } from 'vitest'
import { createAgentPermitPool } from '../src/agent-permit-pool.ts'
import { agentHost, createHostAgentPool, parseAgentSlots } from '../src/host-capacity.ts'

const request: AgentTurnRequest = {
  model: 'test',
  outputSchema: {},
  prompt: 'test',
  sessionId: null,
  signal: new AbortController().signal,
  workspace: '/task',
}

function provider(name: 'codex' | 'opencode', started: () => void): AgentProvider {
  return { name, async* runTurn() {
    started()
    yield { _tag: 'Message', text: name } satisfies AgentEvent
  } }
}

describe('host admission', () => {
  it('removes a host assignment when its provider fails', async () => {
    const pool = createHostAgentPool({ localMaximum: 1, desktopMaximum: 1, desktopConnected: () => true, wait: async () => {} })
    const failing: AgentProvider = { name: 'codex', async* runTurn() {
      yield { _tag: 'Message', text: 'started' }
      throw new Error('Provider stopped')
    } }
    const turn = pool.provider(failing, failing).runTurn({ ...request, taskId: 'failed-task' })[Symbol.asyncIterator]()
    await turn.next()
    expect(pool.tasks()).toEqual([{ taskId: 'failed-task', host: 'hogwild' }])
    await expect(turn.next()).rejects.toThrow('Provider stopped')
    expect(pool.tasks()).toEqual([])
  })
  it('keeps the desktop idle while Hogwild has capacity', () => {
    expect(agentHost({ localActive: 1, localMaximum: 2, desktopActive: 0, desktopMaximum: 1, desktopConnected: true })).toBe('hogwild')
  })

  it('uses the desktop only when Hogwild is full and the desktop can answer', () => {
    const capacity = { localActive: 2, localMaximum: 2, desktopActive: 0, desktopMaximum: 1, desktopConnected: true }
    expect(agentHost(capacity)).toBe('desktop')
    expect(agentHost({ ...capacity, desktopConnected: false })).toBeNull()
    expect(agentHost({ ...capacity, desktopActive: 1 })).toBeNull()
  })

  it('shares the local limit across providers and releases it when a turn closes', async () => {
    const starts: string[] = []
    const pool = createHostAgentPool({ localMaximum: 1, desktopMaximum: 1, desktopConnected: () => true, wait: async () => {} })
    const first = pool.provider(provider('codex', () => starts.push('local')), provider('codex', () => starts.push('desktop'))).runTurn({ ...request, taskId: 'first' })[Symbol.asyncIterator]()
    const second = pool.provider(provider('opencode', () => starts.push('local')), provider('opencode', () => starts.push('desktop'))).runTurn({ ...request, taskId: 'second' })[Symbol.asyncIterator]()
    await first.next()
    await second.next()
    expect(starts).toEqual(['local', 'desktop'])
    expect(pool.tasks()).toEqual([{ taskId: 'first', host: 'hogwild' }, { taskId: 'second', host: 'desktop' }])
    await first.return?.()
    expect(pool.tasks()).toEqual([{ taskId: 'second', host: 'desktop' }])
    await second.return?.()
    expect(pool.read()).toMatchObject({ localActive: 0, desktopActive: 0 })
    expect(pool.tasks()).toEqual([])
  })
})

it('withholds the extra Task claim while the desktop is unavailable', () => {
  let maximum = 1
  const permits = createAgentPermitPool(() => maximum)
  const first = permits.tryAcquire()!
  expect(permits.tryAcquire()).toBeNull()
  maximum = 2
  const second = permits.tryAcquire()!
  maximum = 1
  expect(permits.tryAcquire()).toBeNull()
  second.release()
  expect(permits.tryAcquire()).toBeNull()
  first.release()
  expect(permits.tryAcquire()).not.toBeNull()
})

describe('a Worktree the desktop cannot carry', () => {
  it('runs the turn on Hogwild as soon as a local slot frees', async () => {
    const pool = createHostAgentPool({ localMaximum: 1, desktopMaximum: 1, desktopConnected: () => true, wait: async () => {} })
    const local: AgentProvider = { name: 'codex', async* runTurn() {
      yield { _tag: 'Message', text: 'hogwild' } satisfies AgentEvent
    } }
    const unsupported: AgentProvider = { name: 'codex', runTurn() {
      throw new Error('The desktop cannot run a turn for https://github.com/harlan-zw/nuxtseo.com. Its history is 326 MiB, and the limit is 256 MiB.', { cause: 'desktop-unsupported' })
    } }
    const held: AgentProvider = { name: 'codex', async* runTurn() {
      yield { _tag: 'Message', text: 'holding' } satisfies AgentEvent
      yield { _tag: 'Message', text: 'released' } satisfies AgentEvent
    } }

    const holding = pool.provider(held, held).runTurn({ ...request, taskId: 'holding' })[Symbol.asyncIterator]()
    await holding.next()
    const offloaded = pool.provider(local, unsupported).runTurn({ ...request, taskId: 'offloaded' })[Symbol.asyncIterator]()
    const waiting = offloaded.next()
    await holding.next()
    await holding.next()

    expect(await waiting).toEqual({ done: false, value: { _tag: 'Message', text: 'hogwild' } })
    expect(pool.tasks()).toEqual([{ taskId: 'offloaded', host: 'hogwild' }])
    await offloaded.next()
    expect(pool.tasks()).toEqual([])
  })

  it('fails a session already pinned to the desktop, because no other host owns it', async () => {
    const pool = createHostAgentPool({ localMaximum: 1, desktopMaximum: 1, desktopConnected: () => true, wait: async () => {} })
    const local: AgentProvider = { name: 'codex', async* runTurn() {
      yield { _tag: 'Message', text: 'hogwild' } satisfies AgentEvent
    } }
    const unsupported: AgentProvider = { name: 'codex', runTurn() {
      throw new Error('The desktop cannot run a turn for https://github.com/harlan-zw/nuxtseo.com. Its history is 326 MiB, and the limit is 256 MiB.', { cause: 'desktop-unsupported' })
    } }

    const turn = pool.provider(local, unsupported).runTurn({ ...request, sessionId: 'desktop:session-1' })[Symbol.asyncIterator]()

    await expect(turn.next()).rejects.toThrow('The desktop cannot run a turn')
    expect(pool.tasks()).toEqual([])
  })

  it('keeps a refused host out of the next selection', () => {
    const capacity = { localActive: 2, localMaximum: 2, desktopActive: 0, desktopMaximum: 1, desktopConnected: true }
    expect(agentHost(capacity)).toBe('desktop')
    expect(agentHost(capacity, new Set(['desktop']))).toBeNull()
  })
})

describe('agent slots', () => {
  const limits = { hogwildCeiling: 4, hogwildMemoryMaximum: 2, desktopCeiling: 2, memoryPerAgentGiB: 8 }

  it('admits a turn against the slot count in force, not the one the pool started with', async () => {
    let hogwild = 0
    const pool = createHostAgentPool({ localMaximum: () => hogwild, desktopMaximum: 0, desktopConnected: () => false, wait: async () => {} })
    const local = provider('codex', () => {})
    const turn = pool.provider(local, local).runTurn({ ...request, taskId: 'raised' })[Symbol.asyncIterator]()
    const started = turn.next()
    expect(pool.read().localMaximum).toBe(0)
    hogwild = 1
    await started
    expect(pool.tasks()).toEqual([{ taskId: 'raised', host: 'hogwild' }])
    await turn.return?.()
  })

  it('runs two desktop turns when the desktop holds two slots', async () => {
    const hosts: string[] = []
    const pool = createHostAgentPool({ localMaximum: 0, desktopMaximum: () => 2, desktopConnected: () => true, wait: async () => {} })
    const first = pool.provider(provider('codex', () => hosts.push('local')), provider('codex', () => hosts.push('desktop'))).runTurn({ ...request, taskId: 'first' })[Symbol.asyncIterator]()
    const second = pool.provider(provider('codex', () => hosts.push('local')), provider('codex', () => hosts.push('desktop'))).runTurn({ ...request, taskId: 'second' })[Symbol.asyncIterator]()
    await first.next()
    await second.next()
    expect(hosts).toEqual(['desktop', 'desktop'])
    await first.return?.()
    await second.return?.()
  })

  it('refuses a slot count the configuration does not allow', () => {
    expect(() => parseAgentSlots({ host: 'hogwild', slots: 5 }, limits)).toThrow('from 0 to 4')
    expect(() => parseAgentSlots({ host: 'desktop', slots: 3 }, limits)).toThrow('from 0 to 2')
    expect(() => parseAgentSlots({ host: 'laptop', slots: 1 }, limits)).toThrow('hogwild or desktop')
    expect(() => parseAgentSlots({ host: 'hogwild', slots: 1.5 }, limits)).toThrow('whole number')
    expect(() => parseAgentSlots('hogwild', limits)).toThrow('JSON object')
  })

  it('accepts a slot count above what host memory suggests, because memory is advice', () => {
    expect(parseAgentSlots({ host: 'hogwild', slots: 4 }, limits)).toEqual({ host: 'hogwild', slots: 4 })
    expect(parseAgentSlots({ host: 'desktop', slots: 0 }, limits)).toEqual({ host: 'desktop', slots: 0 })
  })
})
