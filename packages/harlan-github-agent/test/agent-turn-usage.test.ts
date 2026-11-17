import type { AgentEvent, AgentProvider } from '../src/agent-provider.ts'
import { describe, expect, it } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { runAgentTurn, runParsedAgentTurn } from '../src/agent-turn.ts'
import { opencodeAgentUsage } from '../src/opencode-provider.ts'
import { err, ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { agentRuntime } from './fixtures.ts'

const range = { from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' }

const input = {
  number: 1094,
  prompt: 'Resolve the conflict.',
  repository: 'harlan-zw/example',
  role: 'conflict_resolution' as const,
  schema: { type: 'object' },
  taskId: 'task-1',
  workspace: '/tmp/worktree',
}

function usage(inputTokens: number, cachedInput: number, output: number) {
  return { _tag: 'Available' as const, input: inputTokens, cachedInput, cacheWrite: 0, output, reasoning: 0 }
}

/** A provider that answers each turn with the next scripted events. */
function scripted(name: AgentProvider['name'], turns: AgentEvent[][]): AgentProvider {
  let index = 0
  return {
    name,
    runTurn: () => {
      const events = turns[index++] ?? []
      return (async function* () {
        yield* events
      })()
    },
  }
}

function answered(sessionId: string, reported: AgentEvent): AgentEvent[] {
  return [
    { _tag: 'SessionStarted', sessionId },
    { _tag: 'Message', text: JSON.stringify({ outcome: 'resolved' }) },
    reported,
    { _tag: 'TurnCompleted' },
  ]
}

function harness(provider: AgentProvider, resumedSession: string | null = null) {
  const journal = openJournalStore(':memory:')
  let session = resumedSession
  return {
    journal,
    options: {
      now: () => new Date('2026-11-17T00:00:00.000Z'),
      runtime: agentRuntime(CODEX_AGENT_PROFILE, provider),
      store: {
        getWorkerSession: () => session,
        saveWorkerSession: (_repository: string, _number: number, _role: string, sessionId: string) => {
          session = sessionId
        },
        recordAgentTurn: journal.recordAgentTurn,
        agentSessionTotal: journal.agentSessionTotal,
      },
    },
  }
}

describe('agent turn usage', () => {
  it('counts only the tokens a resumed session spent in this turn', async () => {
    const provider = scripted('codex', [
      answered('thread-1', { _tag: 'Usage', scope: 'Session', usage: usage(1_000, 400, 10) }),
      answered('thread-1', { _tag: 'Usage', scope: 'Session', usage: usage(2_500, 1_800, 25) }),
    ])
    const { journal, options } = harness(provider)

    const first = await runAgentTurn(options, input, new AbortController().signal)
    const second = await runAgentTurn(options, input, new AbortController().signal)

    expect(first._tag === 'Ok' && first.value.usage).toEqual(usage(1_000, 400, 10))
    expect(second._tag === 'Ok' && second.value.usage).toEqual(usage(1_500, 1_400, 15))
    expect(journal.listAgentTurns(range).map(turn => turn.usage)).toEqual([usage(1_000, 400, 10), usage(1_500, 1_400, 15)])
  })

  it('counts a result correction as its own turn in the same session', async () => {
    const provider = scripted('codex', [
      [
        { _tag: 'SessionStarted', sessionId: 'thread-1' },
        { _tag: 'Message', text: JSON.stringify({ outcome: 'nearly' }) },
        { _tag: 'Usage', scope: 'Session', usage: usage(100, 50, 20) },
        { _tag: 'TurnCompleted' },
      ],
      answered('thread-1', { _tag: 'Usage', scope: 'Session', usage: usage(260, 150, 30) }),
    ])
    const { options } = harness(provider)

    const result = await runParsedAgentTurn({
      ...options,
      parse: (response: string) => JSON.parse(response).outcome === 'resolved' ? ok({ outcome: 'resolved' }) : err('The agent returned an invalid result.'),
    }, input, new AbortController().signal)

    expect(result._tag === 'Ok' && result.value.usage).toEqual(usage(260, 150, 30))
  })

  it('records a failed turn with the provider, model, and tokens it spent', async () => {
    const provider = scripted('opencode', [[
      { _tag: 'SessionStarted', sessionId: 'session-9' },
      { _tag: 'Usage', scope: 'Turn', usage: usage(700, 600, 5) },
      { _tag: 'Failed', reason: 'The opencode session failed: overloaded' },
    ]])
    const { journal, options } = harness(provider)

    const result = await runAgentTurn(options, input, new AbortController().signal)

    expect(result).toEqual(err('The opencode session failed: overloaded'))
    expect(journal.listAgentTurns(range)).toEqual([expect.objectContaining({
      taskId: 'task-1',
      role: 'conflict_resolution',
      repository: 'harlan-zw/example',
      itemNumber: 1094,
      provider: 'opencode',
      model: CODEX_AGENT_PROFILE.roles.conflict_resolution.model,
      sessionId: 'session-9',
      outcome: 'Failed',
      usage: usage(700, 600, 5),
    })])
  })

  it('reports no usage when a resumed session has no earlier total on record', async () => {
    const provider = scripted('codex', [
      answered('thread-old', { _tag: 'Usage', scope: 'Session', usage: usage(58_000_000, 55_000_000, 40_000) }),
      answered('thread-old', { _tag: 'Usage', scope: 'Session', usage: usage(60_000_000, 57_000_000, 41_200) }),
    ])
    const { options } = harness(provider, 'thread-old')

    const first = await runAgentTurn(options, input, new AbortController().signal)
    const second = await runAgentTurn(options, input, new AbortController().signal)

    expect(first._tag === 'Ok' && first.value.usage).toEqual({ _tag: 'Unavailable' })
    expect(second._tag === 'Ok' && second.value.usage).toEqual(usage(2_000_000, 2_000_000, 1_200))
  })
})

describe('opencode usage', () => {
  it('counts cache reads and writes as input, the way Codex does', () => {
    const line = { type: 'step_finish', part: { tokens: { input: 5, output: 3, reasoning: 1, cache: { read: 20, write: 2 } } } }

    expect(opencodeAgentUsage(line as Parameters<typeof opencodeAgentUsage>[0])).toEqual({
      _tag: 'Available',
      input: 27,
      cachedInput: 20,
      cacheWrite: 2,
      output: 3,
      reasoning: 1,
    })
  })
})
