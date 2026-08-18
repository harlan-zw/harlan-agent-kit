import type { AgentEvent, AgentProvider } from '../src/agent-provider.ts'
import type { Result } from '../src/result.ts'
import { describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { runParsedAgentTurn } from '../src/agent-turn.ts'
import { err, ok } from '../src/result.ts'
import { agentRuntime, turnEvents } from './fixtures.ts'

function replies(responses: unknown[], capture: { prompts: string[] }): AgentProvider {
  return {
    name: 'opencode',
    runTurn: (request) => {
      capture.prompts.push(request.prompt)
      const response = responses[capture.prompts.length - 1]
      return (async function* () {
        yield* turnEvents(response) as AgentEvent[]
      })()
    },
  }
}

function options(provider: AgentProvider) {
  return {
    now: () => new Date('2026-08-16T00:00:00.000Z'),
    runtime: agentRuntime(CODEX_AGENT_PROFILE, provider),
    store: {
      getWorkerSession: () => null,
      saveWorkerSession: () => undefined,
    },
    parse: (response: string): Result<{ outcome: string }, string> => {
      const value = JSON.parse(response) as { outcome?: string }
      return value.outcome === 'resolved'
        ? ok({ outcome: value.outcome })
        : err('The agent returned an invalid conflict resolution result.')
    },
  }
}

const input = {
  number: 24,
  prompt: 'Resolve the conflict.',
  repository: 'harlan-zw/example',
  role: 'conflict_resolution' as const,
  schema: { type: 'object' },
  taskId: 'task-1',
  workspace: '/tmp/worktree',
}

describe('runParsedAgentTurn', () => {
  it('asks once for a corrected result, keeping the work behind it', async () => {
    const capture = { prompts: [] as string[] }
    const provider = replies([{ outcome: 'nearly' }, { outcome: 'resolved' }], capture)

    const result = await runParsedAgentTurn(options(provider), input, new AbortController().signal)

    expect(result).toEqual(ok({ value: { outcome: 'resolved' }, sessionId: 'session-1' }))
    expect(capture.prompts).toHaveLength(2)
    expect(capture.prompts[1]).toContain('The agent returned an invalid conflict resolution result.')
    expect(capture.prompts[1]).toContain('Use no tool.')
  })

  it('reports the first rejection when the correction fails too', async () => {
    const capture = { prompts: [] as string[] }
    const provider = replies([{ outcome: 'nearly' }, { outcome: 'still wrong' }], capture)

    const result = await runParsedAgentTurn(options(provider), input, new AbortController().signal)

    expect(result).toEqual(err('The agent returned an invalid conflict resolution result.'))
    expect(capture.prompts).toHaveLength(2)
  })

  it('never asks twice for a result that already fits', async () => {
    const capture = { prompts: [] as string[] }
    const provider = replies([{ outcome: 'resolved' }], capture)

    const result = await runParsedAgentTurn(options(provider), input, new AbortController().signal)

    expect(result).toEqual(ok({ value: { outcome: 'resolved' }, sessionId: 'session-1' }))
    expect(capture.prompts).toHaveLength(1)
  })
})
