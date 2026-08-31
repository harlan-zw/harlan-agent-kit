import type { AgentEvent, AgentProvider } from '../src/agent-provider.ts'
import { describe, expect, it } from 'vitest'
import { createCircuitProtectedProvider, stableProviderFailureClass } from '../src/provider-circuit.ts'

async function events(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const found: AgentEvent[] = []
  for await (const event of iterable)
    found.push(event)
  return found
}

describe('agent provider circuit boundary', () => {
  it('removes random request identifiers from the failure class', () => {
    expect(stableProviderFailureClass('Network error request-id-abcd1234')).toBe('network')
    expect(stableProviderFailureClass('Network error request-id-different5678')).toBe('network')
  })

  it('records the exact provider and model around a failed turn', async () => {
    const recorded: unknown[] = []
    const provider: AgentProvider = {
      name: 'opencode',
      async* runTurn() {
        yield { _tag: 'Failed', reason: 'The opencode session failed: Network error request-id-abcd1234' }
      },
    }
    const protectedProvider = createCircuitProtectedProvider({
      credential: 'opencode-go',
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      provider,
      store: {
        reserveProviderStart: () => ({ _tag: 'Allowed', canary: null }),
        recordProviderFailure: input => recorded.push(input),
        recordProviderSuccess: () => 0,
      },
    })

    expect(await events(protectedProvider.runTurn({
      taskId: 'task-1',
      model: 'zai-coding-plan/glm-5.3-flash',
      outputSchema: {},
      prompt: 'Review.',
      sessionId: null,
      signal: new AbortController().signal,
      workspace: '/tmp/worktree',
    }))).toMatchObject([{ _tag: 'Failed' }])
    expect(recorded).toMatchObject([{
      provider: 'opencode',
      credential: 'opencode-go',
      model: 'zai-coding-plan/glm-5.3-flash',
      failureClass: 'network',
      workerId: 'task-1',
    }])
  })

  it('records one failure when a provider repeats its terminal event', async () => {
    const failures: unknown[] = []
    const protectedProvider = createCircuitProtectedProvider({
      credential: 'opencode-go',
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      provider: {
        name: 'opencode',
        async* runTurn() {
          yield { _tag: 'Failed', reason: 'Network error one.' }
          yield { _tag: 'Failed', reason: 'Network error two.' }
        },
      },
      store: {
        reserveProviderStart: () => ({ _tag: 'Allowed', canary: null }),
        recordProviderFailure: input => failures.push(input),
        recordProviderSuccess: () => 0,
      },
    })

    await events(protectedProvider.runTurn({
      taskId: 'task-1',
      model: 'model',
      outputSchema: {},
      prompt: '',
      sessionId: null,
      signal: new AbortController().signal,
      workspace: '/tmp/worktree',
    }))
    expect(failures).toHaveLength(1)
  })

  it('does not record success for an empty or aborted turn', async () => {
    let successes = 0
    let failures = 0
    const controller = new AbortController()
    const protectedProvider = createCircuitProtectedProvider({
      credential: 'opencode-go',
      now: () => new Date('2026-08-13T01:00:00.000Z'),
      provider: {
        name: 'opencode',
        async* runTurn(request) {
          if (request.prompt === 'abort') {
            controller.abort()
            yield { _tag: 'Failed', reason: 'The process was stopped by SIGTERM.' }
          }
        },
      },
      store: {
        reserveProviderStart: () => ({ _tag: 'Allowed', canary: null }),
        recordProviderFailure: () => failures += 1,
        recordProviderSuccess: () => successes += 1,
      },
    })
    const request = { taskId: 'task-1', model: 'model', outputSchema: {}, sessionId: null, workspace: '/tmp/worktree' }

    await events(protectedProvider.runTurn({ ...request, prompt: '', signal: new AbortController().signal }))
    await events(protectedProvider.runTurn({ ...request, prompt: 'abort', signal: controller.signal }))
    expect({ failures, successes }).toEqual({ failures: 0, successes: 0 })
  })
})
