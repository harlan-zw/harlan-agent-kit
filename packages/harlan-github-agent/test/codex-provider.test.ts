import type { ThreadEvent, ThreadOptions } from '@openai/codex-sdk'
import type { AgentEvent, AgentTurnRequest } from '../src/agent-provider.ts'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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

it('attributes missing worker configuration to sandbox setup before the model starts', async () => {
  vi.stubEnv('HOME', '/missing/codex-worker-test')
  try {
    expect(await collect(createCodexProvider().runTurn(request())))
      .toEqual([{ _tag: 'Failed', reason: expect.stringContaining('The Codex Agent worker isolation failed:'), cause: 'sandbox-setup' }])
  }
  finally {
    vi.unstubAllEnvs()
  }
})

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
      .toEqual({ _tag: 'Failed', reason: 'The codex session failed: Usage limit reached.' })
  })

  it('reads the Agent percentage from an intermediate progress message', () => {
    expect(codexAgentEvent({
      type: 'item.completed',
      item: { id: 'message-1', type: 'agent_message', text: '▓▓▓░░ 57% next-step (reviewed API routes).' },
    } as ThreadEvent)).toEqual({
      _tag: 'Progress',
      percent: 57,
      text: 'next-step (reviewed API routes).',
    })
  })
})

describe('createCodexProvider', () => {
  it.each([null, 'saved-session'])('uses controller isolation for a mutation turn with session %s', async (sessionId) => {
    const starts: ThreadOptions[] = []
    const start = (options: ThreadOptions) => {
      starts.push(options)
      return thread(messageEvents)
    }
    const provider = createCodexProvider({ createCodex: () => ({ startThread: start, resumeThread: (_id, options) => start(options) }) })
    await collect(provider.runTurn(request({ sessionId })))
    expect(starts).toEqual([expect.objectContaining({ sandboxMode: 'danger-full-access', approvalPolicy: 'never' })])
  })

  it.each(['complete', 'cancel', 'fail'])('attaches pixels outside the Worktree and cleans them after %s', async (outcome) => {
    let path = ''
    const image = { mime: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAABQAAAAKCAYAAAC0VX7mAAAAF0lEQVR4nGNkoDIYNZByMGog5YDqBgIAFJEAC2Vie2MAAAAASUVORK5CYII=', label: 'Before: diagram', source: 'https://github.com/user-attachments/assets/a' }
    const provider = createCodexProvider({ createCodex: () => ({ startThread: () => ({ runStreamed: async (input) => {
      if (typeof input === 'string')
        throw new Error('Pixel attachment missing.')
      const attachment = input.find(part => part.type === 'local_image')
      if (attachment?.type !== 'local_image')
        throw new Error('Pixel attachment missing.')
      path = attachment.path
      expect(path.startsWith('/tmp/worktree')).toBe(false)
      expect(await readFile(path)).toEqual(Buffer.from(image.data, 'base64'))
      return { events: (async function* () {
        yield messageEvents[0]!
        if (outcome === 'fail')
          throw new Error('Fixture failure.')
        yield* messageEvents.slice(1)
      })() }
    } }), resumeThread: () => { throw new Error('Unexpected resume.') } }) })
    const events = provider.runTurn(request({ media: [image] }))
    if (outcome === 'cancel') {
      const iterator = events[Symbol.asyncIterator]()
      await iterator.next()
      await iterator.return?.()
    }
    else if (outcome === 'fail') {
      await expect(collect(events)).rejects.toThrow('Fixture failure.')
    }
    else {
      await collect(events)
    }
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('starts Codex with the worktree .env layered over the service environment', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'codex-env-'))
    await writeFile(join(workspace, '.env'), 'CLOUDFLARE_API_TOKEN=from-repo\n')
    let codexOptions: { env?: Record<string, string> } | undefined
    const provider = createCodexProvider({
      createCodex: (options) => {
        codexOptions = options
        return {
          startThread: () => thread(messageEvents),
          resumeThread: () => { throw new Error('A new turn must not resume.') },
        }
      },
    })

    await collect(provider.runTurn(request({ workspace, taskId: 'owner/site:daily-checkin:2026-09-15T07:00:00.000Z' })))

    expect(codexOptions?.env?.DAILY_CHECKIN_DIR).toMatch(/\/daily-checkin\/owner\/site$/)
    expect(codexOptions?.env?.CLOUDFLARE_API_TOKEN).toBe('from-repo')
  })

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
      { _tag: 'Usage', usage: { _tag: 'Available', input: 1, cachedInput: 0, cacheWrite: 0, output: 1, reasoning: 0 } },
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
