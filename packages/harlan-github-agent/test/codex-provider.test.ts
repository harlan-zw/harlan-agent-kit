import type { ThreadEvent, ThreadOptions } from '@openai/codex-sdk'
import type { AgentEvent, AgentTurnRequest } from '../src/agent-provider.ts'
import { describe, expect, it } from 'vitest'
import { codexAgentEvent, createCodexProvider } from '../src/codex-provider.ts'

function request(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    model: 'gpt-5.6-terra',
    outputSchema: { type: 'object' },
    prompt: 'Resolve the conflict.',
    reasoningEffort: 'medium',
    sessionId: null,
    signal: new AbortController().signal,
    workspace: '/tmp/worktree',
    ...overrides,
  }
}

function thread(events: ThreadEvent[]) {
  return {
    runStreamed: () => Promise.resolve({
      events: (async function* () {
        yield* events
      })(),
    }),
  }
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const items: AgentEvent[] = []
  for await (const event of events)
    items.push(event)
  return items
}

const messageEvents = [
  { type: 'thread.started', thread_id: 'session-1' },
  { type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: '{"outcome":"resolved"}' } },
  { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } },
] as ThreadEvent[]

describe('codexAgentEvent', () => {
  it('maps a finished command to its output and exit code', () => {
    expect(codexAgentEvent({
      type: 'item.completed',
      item: { id: 'command-1', type: 'command_execution', command: 'pnpm test', aggregated_output: 'ok', status: 'completed', exit_code: 0 },
    } as ThreadEvent)).toEqual({ _tag: 'CommandCompleted', command: 'pnpm test', output: 'ok', exitCode: 0 })
  })

  it('maps a failed turn to a turn failure', () => {
    expect(codexAgentEvent({ type: 'turn.failed', error: { message: 'Usage limit reached.' } } as ThreadEvent))
      .toEqual({ _tag: 'Failed', reason: 'Usage limit reached.' })
  })
})

describe('createCodexProvider', () => {
  it('pins the model, reasoning effort, and worktree on a new thread', async () => {
    let threadOptions: ThreadOptions | undefined
    const provider = createCodexProvider({
      createCodex: () => ({
        startThread: (options) => {
          threadOptions = options
          return thread(messageEvents)
        },
        resumeThread: () => { throw new Error('A new turn must not resume.') },
      }),
    })

    expect(await collect(provider.runTurn(request()))).toEqual([
      { _tag: 'SessionStarted', sessionId: 'session-1' },
      { _tag: 'Message', text: '{"outcome":"resolved"}' },
      { _tag: 'TurnCompleted' },
    ])
    expect(threadOptions).toEqual(expect.objectContaining({
      model: 'gpt-5.6-terra',
      modelReasoningEffort: 'medium',
      workingDirectory: '/tmp/worktree',
      approvalPolicy: 'never',
    }))
  })

  it('starts a fresh thread when the saved rollout is gone', async () => {
    let resumeAttempts = 0
    const provider = createCodexProvider({
      createCodex: () => ({
        startThread: () => thread(messageEvents),
        resumeThread: () => ({
          runStreamed: () => {
            resumeAttempts += 1
            return Promise.resolve({
              events: (async function* () {
                throw new Error('thread/resume failed: no rollout found for thread id stale-session')
              })(),
            })
          },
        }),
      }),
    })

    const events = await collect(provider.runTurn(request({ sessionId: 'stale-session' })))

    expect(resumeAttempts).toBe(1)
    expect(events).toContainEqual({ _tag: 'Message', text: '{"outcome":"resolved"}' })
  })
})
