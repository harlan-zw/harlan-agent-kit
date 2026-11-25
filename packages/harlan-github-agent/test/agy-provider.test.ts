import type { ChildProcess } from 'node:child_process'
import type { AgentEvent, AgentTurnRequest } from '../src/agent-provider.ts'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { AGY_AGENT_PROFILE, parseAgentSelection, resolveAgentProfile } from '../src/agent-profile.ts'
import { agyAgentEvent, agyArguments, agyStepUsage, createAgyProvider } from '../src/agy-provider.ts'
import { stableProviderFailureClass } from '../src/provider-circuit.ts'

function fakeAgyChild(onStdinLine: (line: string, child: EventEmitter & { stdout: PassThrough, stderr: PassThrough, stdin: PassThrough, killed: string[], pid: number, kill: (signal: NodeJS.Signals) => boolean }) => void) {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = new PassThrough()
  const killed: string[] = []
  const emitter = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    stdin: PassThrough
    killed: string[]
    pid: number
    kill: (signal: NodeJS.Signals) => boolean
  }
  emitter.stdout = stdout
  emitter.stderr = stderr
  emitter.stdin = stdin
  emitter.killed = killed
  emitter.pid = 4242
  emitter.kill = (signal: NodeJS.Signals) => {
    killed.push(signal)
    if (signal === 'SIGKILL') {
      stdout.end()
      stderr.end()
      emitter.emit('exit', null, signal)
    }
    return true
  }
  let buffer = ''
  stdin.setEncoding('utf8')
  stdin.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim() !== '')
        onStdinLine(line, emitter)
    }
  })
  return emitter
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = []
  for await (const event of events)
    result.push(event)
  return result
}

describe('agy provider mapping and flags', () => {
  it('uses Flash medium by default and Hydrogen high for adversarial review with a single slot', () => {
    expect(AGY_AGENT_PROFILE.maximumActiveAgents).toBe(1)
    expect(AGY_AGENT_PROFILE.roles.adversarial_review.model).toBe('gemini-4-hydrogen-high')
    expect(AGY_AGENT_PROFILE.roles.routine_scan.model).toBe('gemini-3.8-flash-medium')
    expect(AGY_AGENT_PROFILE.roles.issue_work.model).toBe('gemini-3.8-flash-medium')

    const parsed = parseAgentSelection({ _tag: 'Pinned', provider: 'agy' })
    expect(parsed).toEqual({ _tag: 'Ok', value: { _tag: 'Pinned', provider: 'agy', model: null, reasoningEffort: null } })

    const resolved = resolveAgentProfile({ provider: 'agy', model: null, reasoningEffort: null }, AGY_AGENT_PROFILE.maximumActiveAgents)
    expect(resolved.roles.adversarial_review.model).toBe('gemini-4-hydrogen-high')
    expect(resolved.maximumActiveAgents).toBe(1)
  })

  it('disables Google One credit fallback and enables Review restrictions in CLI flags', () => {
    const args = agyArguments({
      model: 'gemini-4-hydrogen-high',
      reasoningEffort: 'high',
      outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      sessionId: 'conv-123',
    }, true)
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]!) as {
      useG1Credits: boolean
      permissions?: { allow: string[], deny: string[] }
    }
    expect(settings.useG1Credits).toBe(false)
    expect(settings.permissions?.allow).toEqual(['mcp(controller_review/*)'])
    expect(settings.permissions?.deny).toContain('read_file(*)')
    expect(args).toContain('--mode')
    expect(args).toContain('plan')
    expect(args).toContain('--conversation')
    expect(args).toContain('conv-123')
    expect(args.at(-1)).toBe('-p=')
  })

  it('maps step updates, token usage, structured output, and errors', () => {
    expect(agyStepUsage({
      event: 'step_update',
      step_update: {
        state: 'DONE',
        usage: { input_tokens: 120, cache_read_tokens: 800, output_tokens: 45, thinking_tokens: 15 },
      },
    })).toEqual({
      _tag: 'Available',
      input: 920,
      cachedInput: 800,
      cacheWrite: 0,
      output: 45,
      reasoning: 15,
    })

    expect(agyAgentEvent({
      event: 'step_update',
      step_update: { state: 'DONE', step_type: 'tool', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', parameters: { TargetFile: 'src/a.ts' } } },
    })).toEqual({ _tag: 'FileChanged', changes: [{ path: 'src/a.ts', kind: 'add' }] })

    expect(agyAgentEvent({
      event: 'result',
      result: { status: 'SUCCESS', structured_output: { ok: true }, response: 'noise\n{"ok":true}' },
    }, { type: 'object' })).toEqual({ _tag: 'Message', text: '{"ok":true}' })

    const limitEvent = agyAgentEvent({
      event: 'result',
      result: { status: 'ERROR', error: '429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric' },
    })
    expect(limitEvent?._tag).toBe('Failed')
    if (limitEvent?._tag === 'Failed')
      expect(stableProviderFailureClass(limitEvent.reason)).toBe('usage_limit')
  })

  it('streams a full turn over NDJSON and enforces the 6M cached context budget', async () => {
    const provider = createAgyProvider({
      cachedContextBudget: 1000,
      spawnAgy: async () => {
        let turns = 0
        const child = fakeAgyChild((_line, handle) => {
          turns += 1
          if (turns === 1) {
            handle.stdout.write(`${JSON.stringify({ event: 'init', conversation_id: 'conv-1' })}\n`)
            handle.stdout.write(`${JSON.stringify({
              event: 'step_update',
              step_update: {
                conversation_id: 'conv-1',
                state: 'DONE',
                step_type: 'thought',
                thinking_delta: 'Checking files.',
                usage: { input_tokens: 100, cache_read_tokens: 800, output_tokens: 20, thinking_tokens: 10 },
              },
            })}\n`)
            return
          }
          handle.stdout.write(`${JSON.stringify({
            event: 'result',
            result: { conversation_id: 'conv-1', status: 'SUCCESS', structured_output: { outcome: 'Ready' } },
          })}\n`)
          handle.stdout.end()
          handle.emit('exit', 0, null)
        })
        return { child: child as unknown as ChildProcess, release: async () => undefined }
      },
    })

    const request: AgentTurnRequest = {
      workspace: '/tmp/repo',
      prompt: 'Review changes.',
      model: 'gemini-3.8-flash-medium',
      outputSchema: { type: 'object' },
      sessionId: null,
      signal: new AbortController().signal,
    }
    const events = await collect(provider.runTurn(request))
    expect(events).toEqual([
      { _tag: 'SessionStarted', sessionId: 'conv-1' },
      { _tag: 'Reasoning', text: 'Checking files.' },
      { _tag: 'ContextBudgetWarned', cachedTokensRead: 800, delivery: { _tag: 'Sent' } },
      { _tag: 'Message', text: '{"outcome":"Ready"}' },
      { _tag: 'Usage', scope: 'Turn', usage: { _tag: 'Available', input: 900, cachedInput: 800, cacheWrite: 0, output: 20, reasoning: 10 } },
      { _tag: 'TurnCompleted' },
    ])
  })

  it('kills the process when cached context reads cross the budget ceiling', async () => {
    const provider = createAgyProvider({
      cachedContextBudget: 1000,
      spawnAgy: async () => {
        const child = fakeAgyChild((_line, handle) => {
          handle.stdout.write(`${JSON.stringify({
            event: 'step_update',
            step_update: {
              conversation_id: 'conv-2',
              state: 'DONE',
              usage: { input_tokens: 50, cache_read_tokens: 1200, output_tokens: 5 },
            },
          })}\n`)
        })
        return { child: child as unknown as ChildProcess, release: async () => undefined }
      },
    })
    const events = await collect(provider.runTurn({
      workspace: '/tmp/repo',
      prompt: 'Loop.',
      model: 'gemini-3.8-flash-medium',
      outputSchema: undefined,
      sessionId: null,
      signal: new AbortController().signal,
    }))
    expect(events).toEqual([
      { _tag: 'SessionStarted', sessionId: 'conv-2' },
      { _tag: 'Usage', scope: 'Turn', usage: { _tag: 'Available', input: 1250, cachedInput: 1200, cacheWrite: 0, output: 5, reasoning: 0 } },
      { _tag: 'ContextBudgetExhausted', cachedTokensRead: 1200 },
    ])
  })
})
