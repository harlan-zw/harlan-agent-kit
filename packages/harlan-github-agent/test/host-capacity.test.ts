import type { AgentEvent, AgentProvider, AgentTurnRequest } from '../src/agent-provider.ts'
import { describe, expect, it } from 'vitest'
import { createAgentPermitPool } from '../src/agent-permit-pool.ts'
import { agentHost, createHostAgentPool } from '../src/host-capacity.ts'

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
    const first = pool.provider(provider('codex', () => starts.push('local')), provider('codex', () => starts.push('desktop'))).runTurn(request)[Symbol.asyncIterator]()
    const second = pool.provider(provider('opencode', () => starts.push('local')), provider('opencode', () => starts.push('desktop'))).runTurn(request)[Symbol.asyncIterator]()
    await first.next()
    await second.next()
    expect(starts).toEqual(['local', 'desktop'])
    await first.return?.()
    await second.return?.()
    expect(pool.read()).toMatchObject({ localActive: 0, desktopActive: 0 })
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
