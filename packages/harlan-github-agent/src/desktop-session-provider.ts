import type { Input, ThreadEvent, ThreadOptions, TurnOptions } from '@openai/codex-sdk'
import type { SpawnOptionsWithoutStdio } from 'node:child_process'
import type { AgentProvider } from './agent-provider.ts'
import { spawn } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import { Codex } from '@openai/codex-sdk'
import { agentProviderFailureReason, agentTextEvent } from './agent-provider.ts'
import { codexAgentEvent } from './codex-provider.ts'
import { opencodeAgentEvent, opencodeAgentUsage } from './opencode-provider.ts'
import { workspaceEnvironment } from './workspace-environment.ts'

interface SessionThread {
  runStreamed: (prompt: Input, options: TurnOptions) => Promise<{ events: AsyncIterable<ThreadEvent> }>
}

interface SessionCodex {
  startThread: (options: ThreadOptions) => SessionThread
  resumeThread: (id: string, options: ThreadOptions) => SessionThread
}

export interface DesktopSessionProviderOptions {
  provider: AgentProvider['name']
  environment: NodeJS.ProcessEnv
  createCodex?: (environment: Record<string, string>) => SessionCodex
  launchOpencode?: (args: string[], options: SpawnOptionsWithoutStdio) => ReturnType<typeof spawn>
}

/** Trusted desktop sessions use the user's local login, tools, and instructions. */
export function createDesktopSessionProvider(options: DesktopSessionProviderOptions): AgentProvider {
  return {
    name: options.provider,
    runTurn: request => (async function* () {
      request.signal.throwIfAborted()
      if (request.toolPolicy !== undefined)
        throw new Error('A desktop session cannot execute a maintenance Review.')
      const environment = workspaceEnvironment(options.environment, request.workspace)
      const publicShim = join(options.environment.HOME ?? '', '.local/share/harlan-agent-kit/github-bin')
      // Interactive sessions inherit the desktop's normal GitHub credentials.
      const sessionEnvironment = { ...environment, PATH: environment.PATH?.split(delimiter).filter(path => path !== publicShim).join(delimiter) }
      if (options.provider === 'codex') {
        const env = Object.fromEntries(Object.entries(sessionEnvironment).filter((entry): entry is [string, string] => entry[1] !== undefined))
        const codex = options.createCodex?.(env) ?? new Codex({ env })
        const threadOptions: ThreadOptions = {
          workingDirectory: request.workspace,
          model: request.model,
          sandboxMode: 'danger-full-access',
          approvalPolicy: 'never',
          webSearchMode: 'live',
          ...(request.reasoningEffort === undefined ? {} : { modelReasoningEffort: request.reasoningEffort as NonNullable<ThreadOptions['modelReasoningEffort']> }),
        }
        const thread = request.sessionId === null
          ? codex.startThread(threadOptions)
          : codex.resumeThread(request.sessionId, threadOptions)
        const turn = await thread.runStreamed(request.prompt, { signal: request.signal })
        for await (const raw of turn.events) {
          const event = codexAgentEvent(raw)
          if (raw.type === 'turn.completed') {
            const usage = raw.usage
            yield { _tag: 'Usage', usage: { _tag: 'Available', input: usage.input_tokens, output: usage.output_tokens, cachedInput: usage.cached_input_tokens, cacheWrite: usage.cache_write_input_tokens ?? 0, reasoning: usage.reasoning_output_tokens ?? 0 } }
          }
          if (event !== undefined)
            yield event
        }
        return
      }
      const args = ['run', '--format', 'json', '--auto', '--model', request.model, '--dir', request.workspace, ...(request.sessionId === null ? [] : ['--session', request.sessionId]), ...(request.reasoningEffort === undefined ? [] : ['--variant', request.reasoningEffort])]
      // The desktop executor owns this process group and recovers it after crashes.
      const childOptions: SpawnOptionsWithoutStdio = { cwd: request.workspace, env: sessionEnvironment, stdio: ['pipe', 'pipe', 'pipe'] }
      const child = options.launchOpencode?.(args, childOptions) ?? spawn('opencode', args, childOptions)
      let stderr = ''
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (data: string) => {
        stderr = (stderr + data).slice(-4000)
      })
      const closed = new Promise<{ code: number | null, error?: string }>((resolve) => {
        child.once('error', error => resolve({ code: null, error: error.message }))
        child.once('close', code => resolve({ code }))
      })
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const signalGroup = (signal: NodeJS.Signals) => {
        if (child.pid === undefined)
          return
        try {
          child.kill(signal)
        }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
            throw error
        }
      }
      const stop = () => {
        signalGroup('SIGTERM')
        killTimer ??= setTimeout(signalGroup, 3000, 'SIGKILL')
        killTimer.unref()
      }
      request.signal.addEventListener('abort', stop, { once: true })
      let pipeError: string | undefined
      child.stdin?.once('error', (error) => {
        pipeError = error.message
        stop()
      })
      if (request.signal.aborted)
        stop()
      child.stdin?.end(request.prompt)
      let completed = false
      let failed = false
      let sessionId = request.sessionId
      try {
        if (child.stdout === null)
          throw new Error('The opencode session has no output stream.')
        for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
          if (line.trim() === '')
            continue
          const raw: unknown = JSON.parse(line)
          if (typeof raw !== 'object' || raw === null || !('type' in raw) || typeof raw.type !== 'string')
            throw new Error('The opencode session returned an invalid event.')
          const value = raw as Parameters<typeof opencodeAgentEvent>[0]
          if (typeof value.sessionID === 'string' && value.sessionID !== sessionId) {
            if (sessionId !== null)
              throw new Error('The opencode session changed its conversation identity.')
            sessionId = value.sessionID
            yield { _tag: 'SessionStarted', sessionId }
          }
          const event = value.type === 'text' && typeof value.part?.text === 'string'
            ? agentTextEvent(value.part.text)
            : opencodeAgentEvent(value)
          const usage = opencodeAgentUsage(value)
          if (usage !== undefined)
            yield { _tag: 'Usage', usage }
          if (event?._tag === 'TurnCompleted') {
            completed = true
          }
          else if (event !== undefined) {
            failed ||= event._tag === 'Failed'
            yield event
          }
        }
        const exit = await closed
        if (request.signal.aborted)
          request.signal.throwIfAborted()
        if (exit.code !== 0 || pipeError !== undefined || !completed) {
          if (!failed)
            yield { _tag: 'Failed', reason: agentProviderFailureReason('opencode', exit.error ?? pipeError ?? (stderr.trim() || `Exited with status ${exit.code ?? 'unknown'} before completing the turn.`)) }
        }
        else if (!failed) {
          yield { _tag: 'TurnCompleted' }
        }
      }
      finally {
        stop()
        await closed
        if (killTimer !== undefined)
          clearTimeout(killTimer)
        request.signal.removeEventListener('abort', stop)
      }
    })(),
  }
}
