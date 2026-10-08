import type { ThreadEvent, ThreadOptions, TurnOptions } from '@openai/codex-sdk'
import type { AgentEvent, AgentTurnRequest } from '../src/agent-provider.ts'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { opencodeAgentEnvironment } from '../src/agent-context.ts'
import { createDesktopSessionProvider } from '../src/desktop-session-provider.ts'

const request: AgentTurnRequest = { model: 'test-model', prompt: 'Explain this code.', outputSchema: undefined, sessionId: null, signal: new AbortController().signal, workspace: '/tmp' }

async function collect(events: AsyncIterable<AgentEvent>) {
  const result: AgentEvent[] = []
  for await (const event of events)
    result.push(event)
  return result
}

describe('desktop session provider', () => {
  it('keeps the desktop GitHub client available for the normal PR workflow', async () => {
    const home = await mkdtemp(join(tmpdir(), 'desktop-session-env-'))
    const publicShim = join(home, '.local/share/harlan-agent-kit/github-bin')
    await mkdir(publicShim, { recursive: true })
    let path: string | undefined
    const provider = createDesktopSessionProvider({ provider: 'codex', environment: { HOME: home, PATH: '/usr/local/bin:/usr/bin' }, createCodex: (env) => {
      path = env.PATH
      return {
        startThread: () => ({ runStreamed: async () => ({ events: (async function* () {})() }) }),
        resumeThread: () => {
          throw new Error('Unexpected resume.')
        },
      }
    } })
    await collect(provider.runTurn(request))
    expect(path).toBe('/usr/local/bin:/usr/bin')
  })
  it('resumes Codex without adding a structured response contract', async () => {
    let options: ThreadOptions | undefined
    let turn: TurnOptions | undefined
    let resumed = ''
    const provider = createDesktopSessionProvider({
      provider: 'codex',
      environment: process.env,
      createCodex: () => ({
        startThread: () => { throw new Error('Must resume the original conversation.') },
        resumeThread: (id, input) => {
          resumed = id
          options = input
          return { runStreamed: async (_prompt, input) => {
            turn = input
            return { events: (async function* () {
              yield { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Use { value: 1 } here.' } } as ThreadEvent
              yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, reasoning_output_tokens: 0, cache_write_input_tokens: 0 } } as ThreadEvent
            })() }
          } }
        },
      }),
    })
    const events = await collect(provider.runTurn({ ...request, sessionId: 'saved-thread' }))
    expect(resumed).toBe('saved-thread')
    expect(options).toMatchObject({ workingDirectory: '/tmp', model: 'test-model' })
    expect(turn).toEqual({ signal: request.signal })
    expect(events).toContainEqual({ _tag: 'Message', text: 'Use { value: 1 } here.' })
  })

  it('reports a missing Codex conversation instead of silently starting another', async () => {
    const provider = createDesktopSessionProvider({ provider: 'codex', environment: process.env, createCodex: () => ({
      startThread: () => { throw new Error('Must not start a fresh conversation.') },
      resumeThread: () => ({ runStreamed: async () => { throw new Error('no rollout found for thread id') } }),
    }) })
    await expect(collect(provider.runTurn({ ...request, sessionId: 'missing' }))).rejects.toThrow('no rollout found')
  })

  it('delivers the plain prompt to opencode and preserves prose containing JSON', async () => {
    let args: string[] = []
    const provider = createDesktopSessionProvider({ provider: 'opencode', environment: process.env, launchOpencode: (input, options) => {
      args = input
      return spawn(process.execPath, ['-e', `
          let prompt = '';
          process.stdin.on('data', data => { prompt += data });
          process.stdin.on('end', () => {
            console.log(JSON.stringify({type:'text',sessionID:'ses_saved123',part:{text:'Reply: {"value":1}. ' + prompt}}));
            console.log(JSON.stringify({type:'step_finish',sessionID:'ses_saved123',part:{reason:'stop'}}));
          });
        `], options)
    } })
    const events = await collect(provider.runTurn({ ...request, sessionId: 'ses_saved123', reasoningEffort: 'high' }))
    expect(args).toEqual(['run', '--format', 'json', '--auto', '--model', 'test-model', '--dir', '/tmp', '--session', 'ses_saved123', '--variant', 'high'])
    expect(events).toContainEqual({ _tag: 'Message', text: 'Reply: {"value":1}. Explain this code.' })
    expect(events.at(-1)).toEqual({ _tag: 'TurnCompleted' })
  })

  it('reports opencode exit failure when no completion event arrives', async () => {
    const provider = createDesktopSessionProvider({ provider: 'opencode', environment: process.env, launchOpencode: (_args, options) => spawn(process.execPath, ['-e', 'process.stderr.write("Login expired"); process.exit(1)'], options) })
    expect(await collect(provider.runTurn(request))).toContainEqual({ _tag: 'Failed', reason: 'The opencode session failed: Login expired' })
  })
})

it('preserves process ownership through context and repository environment for both providers', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'session-owner-env-'))
  await writeFile(join(workspace, '.env'), 'HARLAN_SESSION_PROCESS_OWNER=repository-value\n')
  const environment = opencodeAgentEnvironment({ context: { claudeHome: workspace, instructionPaths: [], skillDirectories: [] }, environment: { ...process.env, HARLAN_SESSION_PROCESS_OWNER: 'trusted-turn-owner' } })
  if (environment._tag === 'Err')
    throw new Error(environment.error)
  try {
    for (const kind of ['codex', 'opencode'] as const) {
      let owner: string | undefined
      const provider = createDesktopSessionProvider({ provider: kind, environment: environment.value, createCodex: (env) => {
        owner = env.HARLAN_SESSION_PROCESS_OWNER
        return { startThread: () => ({ runStreamed: async () => ({ events: (async function* () {})() }) }), resumeThread: () => {
          throw new Error('Unexpected resume.')
        } }
      }, launchOpencode: (_args, options) => {
        owner = options.env?.HARLAN_SESSION_PROCESS_OWNER
        return spawn(process.execPath, ['-e', `process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({type:'step_finish',part:{reason:'stop'}})))`], options)
      } })
      await collect(provider.runTurn({ ...request, workspace }))
      expect(owner).toBe('trusted-turn-owner')
    }
  }
  finally { await rm(workspace, { recursive: true, force: true }) }
})
