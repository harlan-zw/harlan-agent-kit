import type { AgentEvent, AgentTurnRequest } from '../src/agent-provider.ts'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { extractJsonObject } from '../src/agent-provider.ts'
import { createOpencodeProvider, opencodeAgentEvent, opencodeArguments } from '../src/opencode-provider.ts'

function request(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    model: 'opencode-go/deepseek-v4-flash',
    outputSchema: { type: 'object' },
    prompt: 'Resolve the conflict.',
    sessionId: null,
    signal: new AbortController().signal,
    workspace: '/tmp/worktree',
    ...overrides,
  }
}

/** One real child process that replays a fixed opencode run. */
function replay(lines: unknown[], options: { exitCode?: number, standardError?: string, failWithSession?: boolean } = {}) {
  const script = `
    const args = process.argv.slice(1)
    if (${options.failWithSession === true} && args.includes('--session')) {
      process.stderr.write('\\u001B[91mError: \\u001B[0mSession not found')
      process.exit(1)
    }
    process.stdout.write(${JSON.stringify(lines.map(line => `${JSON.stringify(line)}\n`).join(''))})
    process.stderr.write(${JSON.stringify(options.standardError ?? '')})
    process.exit(${options.exitCode ?? 0})
  `
  return (args: string[]) => spawn(process.execPath, ['-e', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const items: AgentEvent[] = []
  for await (const event of events)
    items.push(event)
  return items
}

const bashLine = {
  type: 'tool_use',
  sessionID: 'ses_abc12345',
  part: {
    type: 'tool',
    tool: 'bash',
    state: { status: 'completed', input: { command: 'pnpm test' }, output: 'ok\n', metadata: { exit: 0 } },
  },
}

const textLine = {
  type: 'text',
  sessionID: 'ses_abc12345',
  part: { type: 'text', text: '```json\n{"outcome":"resolved"}\n```' },
}

describe('opencodeArguments', () => {
  it('runs the pinned model in the prepared worktree with permissions answered', () => {
    expect(opencodeArguments(request(), 'the prompt')).toEqual([
      'run',
      '--format',
      'json',
      '--auto',
      '--model',
      'opencode-go/deepseek-v4-flash',
      '--dir',
      '/tmp/worktree',
      'the prompt',
    ])
  })

  it('passes the reasoning variant the role pins', () => {
    expect(opencodeArguments(request({ reasoningEffort: 'high' }), 'the prompt'))
      .toEqual(expect.arrayContaining(['--variant', 'high']))
  })

  it('never resumes a saved session, because a resumed run ignores the prepared worktree', () => {
    expect(opencodeArguments(request({ sessionId: 'ses_abc12345' }), 'the prompt'))
      .not
      .toContain('--session')
  })
})

describe('opencodeAgentEvent', () => {
  it('maps a finished shell tool call to its command, output, and exit code', () => {
    expect(opencodeAgentEvent(bashLine)).toEqual({
      _tag: 'CommandCompleted',
      command: 'pnpm test',
      output: 'ok\n',
      exitCode: 0,
    })
  })

  it('maps a failed shell tool call to a non-zero exit code', () => {
    expect(opencodeAgentEvent({
      type: 'tool_use',
      part: { type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'pnpm test' }, error: 'exit 1' } },
    })).toEqual({ _tag: 'CommandCompleted', command: 'pnpm test', output: 'exit 1', exitCode: 1 })
  })

  it('reads a search tool call as its command line', () => {
    expect(opencodeAgentEvent({
      type: 'tool_use',
      part: { type: 'tool', tool: 'grep', state: { status: 'completed', input: { pattern: 'stretch' }, output: 'nuxt.config.ts:4' } },
    })).toEqual({ _tag: 'CommandCompleted', command: 'grep stretch', output: 'nuxt.config.ts:4', exitCode: 0 })
  })

  it('maps a file edit to a file change', () => {
    expect(opencodeAgentEvent({
      type: 'tool_use',
      part: { type: 'tool', tool: 'edit', state: { status: 'completed', input: { filePath: 'src/parser.ts' } } },
    })).toEqual({ _tag: 'FileChanged', changes: [{ path: 'src/parser.ts', kind: 'update' }] })
  })

  it('strips the code fence from the final message', () => {
    expect(opencodeAgentEvent(textLine)).toEqual({ _tag: 'Message', text: '{"outcome":"resolved"}' })
  })

  it('reports a session error as a turn failure', () => {
    expect(opencodeAgentEvent({ type: 'error', error: { name: 'ProviderError', data: { message: 'Rate limited.' } } }))
      .toEqual({ _tag: 'Failed', reason: 'Rate limited.' })
  })

  it('completes the turn when the model stops', () => {
    expect(opencodeAgentEvent({ type: 'step_finish', part: { reason: 'stop' } })).toEqual({ _tag: 'TurnCompleted' })
  })
})

describe('createOpencodeProvider', () => {
  it('reports the session before the events it produced', async () => {
    const provider = createOpencodeProvider({ spawnOpencode: replay([bashLine, textLine]) })

    expect(await collect(provider.runTurn(request()))).toEqual([
      { _tag: 'SessionStarted', sessionId: 'ses_abc12345' },
      { _tag: 'CommandCompleted', command: 'pnpm test', output: 'ok\n', exitCode: 0 },
      { _tag: 'Message', text: '{"outcome":"resolved"}' },
    ])
  })

  it('fails the turn with the reported error when the run exits non-zero', async () => {
    const provider = createOpencodeProvider({
      spawnOpencode: replay([], { exitCode: 1, standardError: 'Error: No such model' }),
    })

    expect(await collect(provider.runTurn(request()))).toEqual([{ _tag: 'Failed', reason: 'No such model' }])
  })

  it('starts a fresh session even when one was saved', async () => {
    const provider = createOpencodeProvider({
      spawnOpencode: replay([textLine], { failWithSession: true }),
    })

    expect(await collect(provider.runTurn(request({ sessionId: 'ses_missing00' })))).toEqual([
      { _tag: 'SessionStarted', sessionId: 'ses_abc12345' },
      { _tag: 'Message', text: '{"outcome":"resolved"}' },
    ])
  })

  it('stops a run that goes silent, so its task can retry', async () => {
    const provider = createOpencodeProvider({
      idleTimeoutMilliseconds: 1_000,
      // A run that prints its session, then hangs without exiting.
      spawnOpencode: () => spawn(process.execPath, ['-e', `
        process.stdout.write(${JSON.stringify(`${JSON.stringify({ type: 'step_start', sessionID: 'ses_abc12345' })}\n`)})
        setInterval(() => {}, 1000)
      `], { stdio: ['ignore', 'pipe', 'pipe'] }),
    })

    expect(await collect(provider.runTurn(request()))).toEqual([
      { _tag: 'SessionStarted', sessionId: 'ses_abc12345' },
      { _tag: 'Failed', reason: 'The opencode session stopped sending output.' },
    ])
  })
})

describe('extractJsonObject', () => {
  it('takes the object out of a fenced block', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('takes the object out of surrounding prose', () => {
    expect(extractJsonObject('Here is the result: {"a":1} Done.')).toBe('{"a":1}')
  })

  it('returns the text unchanged when it holds no object', () => {
    expect(extractJsonObject('I could not finish.')).toBe('I could not finish.')
  })
})
