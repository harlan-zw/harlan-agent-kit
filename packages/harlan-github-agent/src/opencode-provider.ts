import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import type { AgentEvent, AgentProvider, AgentTokenUsage, AgentTurnRequest, ContextBudgetPhase } from './agent-provider.ts'
import type { Result } from './result.ts'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { opencodeTurnEnvironment } from './agent-context.ts'
import { advanceContextBudget, agentProviderFailureReason, agentTextEvent, contextBudgetWrapUpPrompt, DEFAULT_CACHED_CONTEXT_BUDGET, extractJsonObject, jsonOutputInstruction } from './agent-provider.ts'
import { opencodeSandboxPaths, prepareAgentSandbox } from './agent-sandbox.ts'
import { createAgentTransport } from './agent-transport.ts'
import { materializeAgentMedia } from './github-media.ts'
import { createOpencodeSession, readOpencodeMessages, recoverOpencodeResult } from './opencode-result.ts'
import { err, ok } from './result.ts'

/** Tools that write files, so activity shows a file change instead of a command. */
const fileTools = new Set(['edit', 'write', 'patch', 'multiedit'])
const searchTools = new Set(['webfetch', 'websearch'])
/** Enough stderr to name the failure without storing a whole log. */
const maximumErrorCharacters = 600

export type OpencodeProcess = ChildProcessByStdio<null, Readable, Readable>

type OpencodeExit
  = | { _tag: 'Exited', code: number | null, signal: NodeJS.Signals | null }
    | { _tag: 'SpawnFailed', error: Error }

/**
 * The OpenCode server one turn runs on.
 *
 * `opencode run` alone serves its session inside its own process, so nothing
 * outside can reach a running session. A turn therefore starts its own server,
 * and the run attaches to it. The server runs the tools, so it gets the turn
 * environment.
 */
export interface OpencodeServer {
  url: string
  /** Basic auth password for this server. It lives only as long as the turn. */
  password: string
  /** Internal socket directory for this turn's isolated attachment client. */
  transportDirectory?: string
  createSession: (signal: AbortSignal) => Promise<Result<string, string>>
  /** Adds one user message to a busy session. The session reads it before its next model step. */
  steer: (sessionId: string, text: string) => Promise<Result<void, string>>
  readMessages: (sessionId: string, signal: AbortSignal) => Promise<Result<unknown, string>>
  /** Stops the server, and with it every model call the session still makes. */
  close: (signal: NodeJS.Signals) => void | Promise<void>
}

export type StartOpencodeServer = (workspace: string, environment: NodeJS.ProcessEnv, readOnlyPaths?: readonly string[], taskId?: string) => Promise<Result<OpencodeServer, string>>

/** The fixed user name OpenCode expects with a server password. */
const serverUsername = 'opencode'
const serverStartMilliseconds = 60_000
const steerMilliseconds = 15_000
const serverListening = /opencode server listening on (http:\/\/\S+)/

/** Reads the address `opencode serve` prints once it listens. */
export function opencodeServerUrl(output: string): string | undefined {
  return serverListening.exec(output)?.[1]
}

/** Environment that authenticates a client to one turn server. */
function serverCredentials(password: string): NodeJS.ProcessEnv {
  return { OPENCODE_SERVER_USERNAME: serverUsername, OPENCODE_SERVER_PASSWORD: password }
}

/** Starts `opencode serve` on a free local port in the turn's worktree. */
export function spawnOpencodeServer(readOnly?: boolean): StartOpencodeServer {
  return async (workspace, environment, readOnlyPaths = [], taskId) => {
    const password = randomBytes(24).toString('hex')
    const transportDirectory = await mkdtemp(join(tmpdir(), 'agent-transport-'))
    const transport = await createAgentTransport(join(transportDirectory, 'opencode.sock'))
    const releaseTransport = async () => {
      await transport.close()
      await rm(transportDirectory, { recursive: true, force: true })
    }
    const prepared = await prepareAgentSandbox({ workspace, environment: { ...environment, ...serverCredentials(password) }, provider: 'opencode', readOnlyPaths: [...opencodeSandboxPaths(environment), ...readOnlyPaths], networkMode: 'opencode-server', transportDirectory, ...(taskId === undefined ? {} : { taskId }), ...(readOnly === undefined ? {} : { readOnly }) })
      .then(ok)
      .catch((error: unknown) => err(`The Agent worker isolation failed: ${error instanceof Error ? error.message : String(error)}`))
    if (prepared._tag === 'Err') {
      await releaseTransport()
      return prepared
    }
    const sandbox = prepared.value
    return new Promise((resolve) => {
      const child = spawn(sandbox.binary, [...sandbox.args, sandbox.providerBinary, 'serve', '--hostname', '127.0.0.1', '--port', '4097'], {
        cwd: workspace,
        env: sandbox.environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
      let cleanup: Promise<void> | undefined
      const release = () => {
        cleanup ??= closed.then(async () => {
          try {
            await sandbox.release()
          }
          finally {
            await releaseTransport()
          }
        })
        return cleanup
      }
      let output = ''
      let settled = false
      const settle = (result: Result<OpencodeServer, string>) => {
        if (settled)
          return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        settle(err(`The opencode server did not start within ${serverStartMilliseconds / 1000} seconds.`))
      }, serverStartMilliseconds)
      const read = (chunk: string) => {
        output = `${output}${chunk}`.slice(-maximumErrorCharacters)
        const url = opencodeServerUrl(output)
        if (url !== undefined) {
          settle(ok({ ...opencodeServer(transport.url, password, workspace, child), transportDirectory, close: async (signal) => {
            child.kill(signal)
            const stop = setTimeout(() => child.kill('SIGKILL'), 5_000)
            stop.unref()
            try {
              await release()
            }
            finally {
              clearTimeout(stop)
            }
          } }))
        }
      }
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', read)
      child.stderr.on('data', read)
      child.once('error', (error) => {
        void release().then(() => settle(err(error.message)), failure => settle(err(`Agent cleanup failed: ${failure.message}`)))
      })
      child.once('exit', (code, signal) => {
        void release().then(() => settle(err(opencodeFailureReason(output, { code, signal }))), (failure) => {
          process.stderr.write(`Agent cleanup failed: ${failure.message}\n`)
          settle(err(`Agent cleanup failed: ${failure.message}`))
        })
      })
    })
  }
}

function opencodeServer(url: string, password: string, workspace: string, child: OpencodeProcess): OpencodeServer {
  const authorization = `Basic ${Buffer.from(`${serverUsername}:${password}`).toString('base64')}`
  return {
    url,
    password,
    createSession: signal => createOpencodeSession({ url, password, workspace, signal }),
    readMessages: (sessionId, signal) => readOpencodeMessages({ url, password, workspace, sessionId, signal }),
    steer: (sessionId, text) => fetch(`${url}/session/${encodeURIComponent(sessionId)}/prompt_async?directory=${encodeURIComponent(workspace)}`, {
      method: 'POST',
      headers: { 'authorization': authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
      signal: AbortSignal.timeout(steerMilliseconds),
    })
      .then((response): Result<void, string> => response.ok ? ok(undefined) : err(`The opencode server answered ${response.status}.`))
      .catch((error: unknown) => err(`The opencode server did not take the message: ${error instanceof Error ? error.message : String(error)}`)),
    close: (signal) => { child.kill(signal) },
  }
}

export interface OpencodeProviderOptions {
  readOnly?: boolean
  /** Stops a run once its session has read this many cached context tokens. */
  cachedContextBudget?: number
  /** Exact environment shared with every OpenCode process. */
  environment?: NodeJS.ProcessEnv
  /** Kills a run that has printed nothing for this long. */
  idleTimeoutMilliseconds?: number
  /** Injected for tests. Starts the server one turn attaches to. */
  startOpencodeServer?: StartOpencodeServer
  /** Injected for tests. Returns the raw NDJSON line stream of one run. */
  spawnOpencode?: (args: string[], workspace: string, environment: NodeJS.ProcessEnv) => OpencodeProcess
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

/**
 * Cached context tokens one line reports.
 *
 * opencode closes every model step with a `step_finish` line that carries the
 * usage of that step alone. Those steps sum to the session total the local
 * opencode database records, so adding them meters the session exactly.
 */
export function opencodeCachedTokensRead(line: OpencodeLine): number {
  return opencodeAgentUsage(line)?.cachedInput ?? 0
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

export function opencodeAgentUsage(line: OpencodeLine): Extract<AgentTokenUsage, { _tag: 'Available' }> | undefined {
  if (line.type !== 'step_finish')
    return undefined
  const tokens = (line.part as { tokens?: { input?: unknown, output?: unknown, reasoning?: unknown, cache?: { read?: unknown, write?: unknown } } } | undefined)?.tokens
  if (tokens === undefined)
    return undefined
  return {
    _tag: 'Available',
    input: tokenCount(tokens.input),
    cachedInput: tokenCount(tokens.cache?.read),
    cacheWrite: tokenCount(tokens.cache?.write),
    output: tokenCount(tokens.output),
    reasoning: tokenCount(tokens.reasoning),
  }
}

/** Maps one `opencode run --format json` line to the provider-neutral event. */
export function opencodeAgentEvent(line: OpencodeLine): AgentEvent | undefined {
  if (line.type === 'error')
    return { _tag: 'Failed', reason: agentProviderFailureReason('opencode', errorMessage(line.error)) }
  if (line.type === 'reasoning')
    return { _tag: 'Reasoning', text: text(line.part?.text) }
  if (line.type === 'text') {
    const event = agentTextEvent(text(line.part?.text))
    return event._tag === 'Message'
      ? { ...event, text: extractJsonObject(event.text) }
      : event
  }
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
 * Ignore request.sessionId, because a saved session belongs to its earlier directory.
 * Create an empty session in this turn's prepared worktree before the CLI starts.
 * Its identity remains available even when the attached CLI emits no events.
 */
export function opencodeArguments(request: AgentTurnRequest, prompt: string, serverUrl: string, mediaPaths: readonly string[] = [], freshSessionId?: string): string[] {
  return [
    'run',
    '--attach',
    serverUrl,
    ...(freshSessionId === undefined ? [] : ['--session', freshSessionId]),
    ...(mediaPaths.length === 0 ? [] : ['--file', ...mediaPaths]),
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
  const idleTimeoutMilliseconds = options.idleTimeoutMilliseconds ?? 10 * 60_000
  const cachedContextBudget = options.cachedContextBudget ?? DEFAULT_CACHED_CONTEXT_BUDGET
  const environment = options.environment ?? process.env
  const startOpencodeServer = options.startOpencodeServer ?? spawnOpencodeServer(options.readOnly)
  const spawnOpencode = options.spawnOpencode ?? (async (args: string[], workspace: string, environment: NodeJS.ProcessEnv, mediaPaths: readonly string[], taskId?: string, transportDirectory?: string) => {
    if (transportDirectory === undefined)
      throw new Error('The OpenCode client needs its isolated turn transport.')
    const sandbox = await prepareAgentSandbox({ workspace, environment, provider: 'opencode', readOnlyPaths: [...opencodeSandboxPaths(environment), ...mediaPaths], networkMode: 'opencode-client', transportDirectory, ...(taskId === undefined ? {} : { taskId }), readOnly: true })
    const child = spawn(sandbox.binary, [...sandbox.args, sandbox.providerBinary, ...args], {
      cwd: workspace,
      env: sandbox.environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const release = () => {
      void sandbox.release().catch(error => process.stderr.write(`Agent sandbox cleanup failed: ${error.message}\n`))
    }
    child.once('exit', release)
    child.once('error', release)
    return child
  })

  async function* runOnce(request: AgentTurnRequest, prompt: string, mediaPaths: readonly string[] = []): AsyncGenerator<AgentEvent> {
    if (request.signal.aborted) {
      yield { _tag: 'Failed', reason: 'The OpenCode turn was cancelled.' }
      return
    }
    // Profile selection and instruction mounts use only controller inputs.
    // The sandbox loads repository tooling variables after selecting the boundary.
    const turnEnvironment = opencodeTurnEnvironment({
      environment,
      instructionPaths: request.instructionPaths ?? [],
    })
    if (turnEnvironment._tag === 'Err') {
      yield { _tag: 'Failed', reason: turnEnvironment.error }
      return
    }
    const started = await startOpencodeServer(request.workspace, turnEnvironment.value, mediaPaths, request.taskId)
    if (started._tag === 'Err') {
      yield { _tag: 'Failed', reason: agentProviderFailureReason('opencode', started.error) }
      return
    }
    const server = started.value
    const created = await server.createSession(request.signal).catch(() => err('The OpenCode session creation failed.'))
    if (created._tag === 'Err' || request.signal.aborted) {
      await server.close('SIGTERM')
      yield { _tag: 'Failed', reason: created._tag === 'Err' ? created.error : 'The OpenCode turn was cancelled.' }
      return
    }
    const launched = await Promise.resolve().then(() => spawnOpencode(
      opencodeArguments(request, prompt, server.url, mediaPaths, created.value),
      request.workspace,
      { ...turnEnvironment.value, ...serverCredentials(server.password) },
      mediaPaths,
      request.taskId,
      server.transportDirectory,
    )).then(ok).catch((error: unknown) => err(`The OpenCode client isolation failed: ${error instanceof Error ? error.message : String(error)}`))
    if (launched._tag === 'Err') {
      await server.close('SIGTERM')
      yield { _tag: 'Failed', reason: launched.error }
      return
    }
    const child = launched.value
    const stop = (signal: NodeJS.Signals) => {
      child.kill(signal)
      void Promise.resolve(server.close(signal)).catch(error => process.stderr.write(`Agent cleanup failed: ${error.message}\n`))
    }
    const abort = () => stop('SIGTERM')
    request.signal.addEventListener('abort', abort, { once: true })
    if (request.signal.aborted)
      abort()
    let standardError = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      standardError = `${standardError}${chunk}`.slice(-maximumErrorCharacters)
    })
    const exited = new Promise<OpencodeExit>((resolve) => {
      child.once('error', error => resolve({ _tag: 'SpawnFailed', error }))
      child.once('exit', (code, signal) => resolve({ _tag: 'Exited', code, signal }))
    })

    // A silent run means a wedged agent, and its Task holds its lease until the
    // process ends. Stop it so the Task can fail and retry.
    let lastOutputAt = Date.now()
    let silent = false
    const watchdog = setInterval(() => {
      if (Date.now() - lastOutputAt < idleTimeoutMilliseconds)
        return
      silent = true
      stop('SIGKILL')
    }, Math.max(1_000, Math.floor(idleTimeoutMilliseconds / 4)))
    watchdog.unref()

    const sessionId = created.value
    let sessionReported = false
    let assistantId: string | undefined
    const deliveredParts = new Set<string>()
    let failed = false
    let cachedTokensRead = 0
    let usage: Extract<AgentTokenUsage, { _tag: 'Available' }> = { _tag: 'Available', input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 }
    let usageAvailable = false
    let budget: ContextBudgetPhase = { _tag: 'Normal' }
    let completed = false
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
        if (typeof parsed.sessionID === 'string' && parsed.sessionID !== sessionId) {
          failed = true
          stop('SIGKILL')
          yield { _tag: 'Failed', reason: 'The OpenCode stream returned another session identity.' }
          break
        }
        if (!sessionReported && parsed.sessionID === sessionId) {
          sessionReported = true
          yield { _tag: 'SessionStarted', sessionId }
        }
        const stepUsage = opencodeAgentUsage(parsed)
        if (parsed.sessionID === sessionId && parsed.type === 'step_start' && typeof parsed.part?.messageID === 'string')
          assistantId ??= parsed.part.messageID
        if (typeof parsed.part?.id === 'string' && (stepUsage !== undefined || opencodeAgentEvent(parsed) !== undefined))
          deliveredParts.add(parsed.part.id)
        if (stepUsage !== undefined) {
          usageAvailable = true
          usage = {
            _tag: 'Available',
            input: usage.input + stepUsage.input,
            cachedInput: usage.cachedInput + stepUsage.cachedInput,
            cacheWrite: usage.cacheWrite + stepUsage.cacheWrite,
            output: usage.output + stepUsage.output,
            reasoning: usage.reasoning + stepUsage.reasoning,
          }
        }
        cachedTokensRead += stepUsage?.cachedInput ?? 0
        const event = opencodeAgentEvent(parsed)
        if (event !== undefined) {
          if (event._tag === 'Failed')
            failed = true
          if (event._tag === 'TurnCompleted') {
            completed = true
          }
          else {
            yield event
          }
        }
        if (completed)
          break
        // A stopping step ends the turn by itself, so the budget never discards
        // an answer the session already paid for. Every other step means one
        // more full read of the context. Past the warning share the session is
        // asked once to answer now. Past the budget it is stopped. SIGKILL,
        // because a run this deep must not negotiate.
        if (stepUsage === undefined)
          continue
        const advanced = advanceContextBudget(budget, cachedTokensRead, cachedContextBudget)
        budget = advanced.phase
        if (advanced.action._tag === 'Stop') {
          stop('SIGKILL')
          break
        }
        if (advanced.action._tag === 'Warn') {
          const delivered = await server.steer(sessionId, contextBudgetWrapUpPrompt(cachedTokensRead, cachedContextBudget))
          yield {
            _tag: 'ContextBudgetWarned',
            cachedTokensRead,
            delivery: delivered._tag === 'Ok' ? { _tag: 'Sent' } : { _tag: 'Failed', reason: delivered.error },
          }
        }
      }
      const exit = await exited
      if (exit._tag === 'SpawnFailed') {
        yield { _tag: 'Failed', reason: agentProviderFailureReason('opencode', exit.error.message) }
        return
      }
      if (budget._tag === 'Exhausted') {
        yield { _tag: 'ContextBudgetExhausted', cachedTokensRead }
        return
      }
      if (silent) {
        yield { _tag: 'Failed', reason: 'The opencode session stopped sending output.' }
        return
      }
      if (request.signal.aborted) {
        yield { _tag: 'Failed', reason: 'The OpenCode turn was cancelled.' }
        return
      }
      if (completed && exit.code === 0) {
        if (usageAvailable)
          yield { _tag: 'Usage', usage }
        yield { _tag: 'TurnCompleted' }
      }
      else if (exit.code !== 0 && !failed) {
        yield { _tag: 'Failed', reason: opencodeFailureReason(standardError, exit) }
      }
      else if (exit.code === 0 && !failed && !completed) {
        if (request.signal.aborted) {
          yield { _tag: 'Failed', reason: 'The OpenCode result read was cancelled.' }
          return
        }
        if (!sessionReported)
          yield { _tag: 'SessionStarted', sessionId }
        const read = await server.readMessages(sessionId, request.signal).catch(() => err('The OpenCode result read failed.'))
        const recovered = read._tag === 'Err' ? read : recoverOpencodeResult(read.value, sessionId, assistantId, deliveredParts)
        if (recovered._tag === 'Err') {
          yield { _tag: 'Failed', reason: recovered.error }
          return
        }
        if (request.signal.aborted) {
          yield { _tag: 'Failed', reason: 'The OpenCode result read was cancelled.' }
          return
        }
        yield { _tag: 'Reasoning', text: 'Recovered the completed OpenCode result after its attached stream ended.' }
        for (const line of recovered.value) {
          const stepUsage = opencodeAgentUsage(line)
          if (stepUsage !== undefined) {
            usageAvailable = true
            usage = { _tag: 'Available', input: usage.input + stepUsage.input, cachedInput: usage.cachedInput + stepUsage.cachedInput, cacheWrite: usage.cacheWrite + stepUsage.cacheWrite, output: usage.output + stepUsage.output, reasoning: usage.reasoning + stepUsage.reasoning }
          }
          const event = opencodeAgentEvent(line)
          if (event?._tag !== 'TurnCompleted' && event !== undefined)
            yield event
        }
        if (usageAvailable)
          yield { _tag: 'Usage', usage }
        yield { _tag: 'TurnCompleted' }
      }
    }
    finally {
      clearInterval(watchdog)
      request.signal.removeEventListener('abort', abort)
      // The run ended, so its server has no session left to serve.
      await server.close('SIGTERM')
    }
  }

  return {
    name: 'opencode',
    runTurn: (request: AgentTurnRequest) => (async function* () {
      const media = await materializeAgentMedia(request.media)
      try {
        yield* runOnce(request, `${request.prompt}

${jsonOutputInstruction(request.outputSchema)}`, media.paths)
      }
      finally {
        await media.release()
      }
    })(),
  }
}

function opencodeFailureReason(standardError: string, exit: { code: number | null, signal: NodeJS.Signals | null }): string {
  // eslint-disable-next-line no-control-regex
  const clean = standardError.replaceAll(/\u001B\[[\d;]*m/g, '').replace(/^Error:\s*/m, '').trim()
  if (clean.length > 0)
    return agentProviderFailureReason('opencode', clean)
  // A signal means something outside the turn ended it, which names the cause.
  return exit.signal === null
    ? `The opencode session exited with code ${exit.code ?? 'unknown'}.`
    : `The opencode session was stopped by ${exit.signal}.`
}
