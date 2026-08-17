import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import type { AgentEvent, AgentProvider, AgentTurnRequest } from './agent-provider.ts'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { extractJsonObject, jsonOutputInstruction } from './agent-provider.ts'

/** Tools that write files, so activity shows a file change instead of a command. */
const fileTools = new Set(['edit', 'write', 'patch', 'multiedit'])
const searchTools = new Set(['webfetch', 'websearch'])
/** Enough stderr to name the failure without storing a whole log. */
const maximumErrorCharacters = 600

export type OpencodeProcess = ChildProcessByStdio<null, Readable, Readable>

export interface OpencodeProviderOptions {
  binaryPath?: string
  /** Kills a run that has printed nothing for this long. */
  idleTimeoutMilliseconds?: number
  /** Injected for tests. Returns the raw NDJSON line stream of one run. */
  spawnOpencode?: (args: string[], workspace: string) => OpencodeProcess
}

interface OpencodeToolPart {
  type: 'tool'
  tool: string
  state: {
    status: string
    input?: Record<string, unknown>
    output?: string
    error?: string
    metadata?: { exit?: number, output?: string }
  }
}

interface OpencodeLine {
  type: string
  sessionID?: string
  part?: Record<string, unknown>
  error?: unknown
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toolCommand(part: OpencodeToolPart): string {
  const input = part.state.input ?? {}
  if (text(input.command) !== '')
    return text(input.command)
  // Every other tool reads as a command line, so activity stays one shape.
  const argument = text(input.pattern) || text(input.filePath) || text(input.path) || text(input.query) || text(input.description)
  return argument === '' ? part.tool : `${part.tool} ${argument}`
}

function toolPath(part: OpencodeToolPart): string {
  const input = part.state.input ?? {}
  return text(input.filePath) || text(input.path) || text(input.file)
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string')
    return error
  if (typeof error !== 'object' || error === null)
    return 'The opencode session failed.'
  const record = error as { name?: unknown, message?: unknown, data?: { message?: unknown } }
  return text(record.data?.message) || text(record.message) || text(record.name) || 'The opencode session failed.'
}

/** Maps one `opencode run --format json` line to the provider-neutral event. */
export function opencodeAgentEvent(line: OpencodeLine): AgentEvent | undefined {
  if (line.type === 'error')
    return { _tag: 'Failed', reason: errorMessage(line.error) }
  if (line.type === 'reasoning')
    return { _tag: 'Reasoning', text: text(line.part?.text) }
  if (line.type === 'text')
    return { _tag: 'Message', text: extractJsonObject(text(line.part?.text)) }
  if (line.type === 'step_finish' && text(line.part?.reason) === 'stop')
    return { _tag: 'TurnCompleted' }
  if (line.type === 'tool_use' && line.part !== undefined) {
    const part = line.part as unknown as OpencodeToolPart
    if (searchTools.has(part.tool))
      return { _tag: 'WebSearch' }
    if (fileTools.has(part.tool)) {
      const path = toolPath(part)
      return path === ''
        ? undefined
        : { _tag: 'FileChanged', changes: [{ path, kind: part.tool === 'write' ? 'add' : 'update' }] }
    }
    if (part.state.status === 'error') {
      return {
        _tag: 'CommandCompleted',
        command: toolCommand(part),
        output: text(part.state.error),
        exitCode: part.state.metadata?.exit ?? 1,
      }
    }
    return {
      _tag: 'CommandCompleted',
      command: toolCommand(part),
      output: text(part.state.output) || text(part.state.metadata?.output),
      exitCode: part.state.metadata?.exit ?? 0,
    }
  }
  return undefined
}

/**
 * Every turn starts its own session.
 *
 * `opencode run --session` reopens the session in the directory that created
 * it, which is never the worktree this turn prepared, and the process then
 * stays alive after its loop ends. Each turn therefore carries its own context.
 */
export function opencodeArguments(request: AgentTurnRequest, prompt: string): string[] {
  return [
    'run',
    '--format',
    'json',
    '--auto',
    '--model',
    request.model,
    '--dir',
    request.workspace,
    ...(request.reasoningEffort === undefined ? [] : ['--variant', request.reasoningEffort]),
    prompt,
  ]
}

export function createOpencodeProvider(options: OpencodeProviderOptions = {}): AgentProvider {
  const binaryPath = options.binaryPath ?? join(homedir(), '.opencode', 'bin', 'opencode')
  const idleTimeoutMilliseconds = options.idleTimeoutMilliseconds ?? 10 * 60_000
  const spawnOpencode = options.spawnOpencode ?? ((args, workspace) => spawn(binaryPath, args, {
    cwd: workspace,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }))

  async function* runOnce(request: AgentTurnRequest, prompt: string): AsyncGenerator<AgentEvent> {
    const child = spawnOpencode(opencodeArguments(request, prompt), request.workspace)
    const abort = () => child.kill('SIGTERM')
    request.signal.addEventListener('abort', abort, { once: true })
    let standardError = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      standardError = `${standardError}${chunk}`.slice(-maximumErrorCharacters)
    })
    const exited = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })

    // A silent run means a wedged agent, and its Task holds its lease until the
    // process ends. Stop it so the Task can fail and retry.
    let lastOutputAt = Date.now()
    let silent = false
    const watchdog = setInterval(() => {
      if (Date.now() - lastOutputAt < idleTimeoutMilliseconds)
        return
      silent = true
      child.kill('SIGKILL')
    }, Math.max(1_000, Math.floor(idleTimeoutMilliseconds / 4)))
    watchdog.unref()

    let sessionId: string | null = null
    let failed = false
    try {
      for await (const raw of createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY })) {
        const line = raw.trim()
        lastOutputAt = Date.now()
        if (line.length === 0)
          continue
        let parsed: OpencodeLine
        try {
          parsed = JSON.parse(line) as OpencodeLine
        }
        catch {
          // A non-JSON line is plugin or upgrade noise, never a turn result.
          continue
        }
        if (sessionId === null && typeof parsed.sessionID === 'string') {
          sessionId = parsed.sessionID
          yield { _tag: 'SessionStarted', sessionId }
        }
        const event = opencodeAgentEvent(parsed)
        if (event === undefined)
          continue
        if (event._tag === 'Failed')
          failed = true
        yield event
      }
      const exit = await exited
      if (silent) {
        yield { _tag: 'Failed', reason: 'The opencode session stopped sending output.' }
        return
      }
      if (exit.code !== 0 && !failed)
        yield { _tag: 'Failed', reason: opencodeFailureReason(standardError, exit) }
    }
    finally {
      clearInterval(watchdog)
      request.signal.removeEventListener('abort', abort)
    }
  }

  return {
    name: 'opencode',
    runTurn: (request: AgentTurnRequest) => runOnce(request, `${request.prompt}

${jsonOutputInstruction(request.outputSchema)}`),
  }
}

function opencodeFailureReason(standardError: string, exit: { code: number | null, signal: NodeJS.Signals | null }): string {
  // eslint-disable-next-line no-control-regex
  const clean = standardError.replaceAll(/\u001B\[[\d;]*m/g, '').replace(/^Error:\s*/m, '').trim()
  if (clean.length > 0)
    return clean
  // A signal means something outside the turn ended it, which names the cause.
  return exit.signal === null
    ? `The opencode session exited with code ${exit.code ?? 'unknown'}.`
    : `The opencode session was stopped by ${exit.signal}.`
}
