import type { ChildProcess } from 'node:child_process'
import type { AgentEvent, AgentProvider, AgentTokenUsage, AgentTurnRequest, ContextBudgetPhase } from './agent-provider.ts'
import type { AgentSandbox } from './agent-sandbox.ts'
import type { ReviewProofAuthorityFactory } from './review-proof-authority.ts'
import type { ReviewRuntime } from './review-runtime.ts'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { advanceContextBudget, agentProviderFailureReason, agentTextEvent, contextBudgetWrapUpPrompt, DEFAULT_AGY_CACHED_CONTEXT_BUDGET, extractJsonObject, jsonOutputInstruction } from './agent-provider.ts'
import { prepareAgentSandbox } from './agent-sandbox.ts'
import { agentSkillCatalogPrompt } from './agent-skill-catalog.ts'
import { materializeAgentMedia } from './github-media.ts'
import { createReviewRuntime } from './review-runtime.ts'
import { createVitalsEvidenceDirectory, inspectVitalsComparison, vitalsEvidenceInstructions } from './vitals-comparison-runtime.ts'

const fileTools = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content'])
const searchTools = new Set(['search_web', 'read_url_content'])
const commandTools = new Set(['run_command'])
/** Enough stderr to name the failure without storing a whole log. */
const maximumErrorCharacters = 600

export interface AgyUsagePayload {
  input_tokens?: unknown
  output_tokens?: unknown
  thinking_tokens?: unknown
  cache_read_tokens?: unknown
  total_tokens?: unknown
}

export interface AgyLine {
  event?: unknown
  conversation_id?: unknown
  init?: {
    model?: unknown
    cwd?: unknown
    tools?: unknown
  }
  step_update?: {
    conversation_id?: unknown
    step_index?: unknown
    state?: unknown
    step_type?: unknown
    tool_name?: unknown
    tool_info?: {
      name?: unknown
      parameters?: unknown
    }
    text_delta?: unknown
    thinking_delta?: unknown
    response?: unknown
    error?: unknown
    usage?: AgyUsagePayload
  }
  result?: {
    conversation_id?: unknown
    status?: unknown
    response?: unknown
    structured_output?: unknown
    error?: unknown
    usage?: AgyUsagePayload
  }
}

export interface LaunchedAgyProcess {
  child: ChildProcess
  skillCatalogPath?: string
  memoryExceeded?: () => Promise<boolean>
  release: () => Promise<void>
}

export interface AgyProviderOptions {
  environment?: NodeJS.ProcessEnv
  idleTimeoutMilliseconds?: number
  cachedContextBudget?: number
  memoryPerAgentGiB?: number
  reviewProofAuthority?: ReviewProofAuthorityFactory
  spawnAgy?: (input: {
    args: string[]
    workspace: string
    environment: NodeJS.ProcessEnv
    readOnlyPaths: readonly string[]
    taskId?: string
    review?: ReviewRuntime
    vitalsEvidenceDirectory?: string
    routineContext?: AgentTurnRequest['routineContext']
  }) => Promise<LaunchedAgyProcess>
}

type AgyExit
  = | { _tag: 'SpawnFailed', error: Error }
    | { _tag: 'Exited', code: number | null, signal: NodeJS.Signals | null }

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function addUsage(
  left: Extract<AgentTokenUsage, { _tag: 'Available' }>,
  right: Extract<AgentTokenUsage, { _tag: 'Available' }>,
): Extract<AgentTokenUsage, { _tag: 'Available' }> {
  return {
    _tag: 'Available',
    input: left.input + right.input,
    cachedInput: left.cachedInput + right.cachedInput,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
  }
}

/** Converts one `agy` usage object to the shared token ledger shape. */
export function agyUsageFromRaw(usage: AgyUsagePayload | undefined): Extract<AgentTokenUsage, { _tag: 'Available' }> | undefined {
  if (usage === undefined)
    return undefined
  const cachedInput = tokenCount(usage.cache_read_tokens)
  return {
    _tag: 'Available',
    // Keep parity with Codex/OpenCode reporting: input includes cached prompt reads.
    input: tokenCount(usage.input_tokens) + cachedInput,
    cachedInput,
    cacheWrite: 0,
    output: tokenCount(usage.output_tokens),
    reasoning: tokenCount(usage.thinking_tokens),
  }
}

/** Token usage reported when one `agy` model step completes. */
export function agyStepUsage(line: AgyLine): Extract<AgentTokenUsage, { _tag: 'Available' }> | undefined {
  if (line.event !== 'step_update' || line.step_update?.state !== 'DONE')
    return undefined
  return agyUsageFromRaw(line.step_update.usage)
}

function toolCommandText(toolInfo: NonNullable<AgyLine['step_update']>['tool_info']): string {
  const parameters = record(toolInfo?.parameters) ? toolInfo.parameters : {}
  return text(parameters.CommandLine) || text(parameters.command) || text(toolInfo?.name) || 'command'
}

function toolFilePath(toolInfo: NonNullable<AgyLine['step_update']>['tool_info']): string {
  const parameters = record(toolInfo?.parameters) ? toolInfo.parameters : {}
  return text(parameters.TargetFile) || text(parameters.target_file) || text(parameters.filePath) || text(parameters.path)
}

/** Maps one `agy --output-format stream-json` line to neutral Agent events. */
export function agyAgentEvent(line: AgyLine, outputSchema?: unknown): AgentEvent | undefined {
  if (line.event === 'step_update' && line.step_update !== undefined) {
    const update = line.step_update
    if (update.step_type === 'thought') {
      const thought = text(update.thinking_delta) || text(update.text_delta)
      return thought.trim() === '' ? undefined : { _tag: 'Reasoning', text: thought }
    }
    if (update.step_type === 'tool' || update.step_type === 'tool_call') {
      const toolName = text(update.tool_name) || text(update.tool_info?.name)
      if (update.state === 'ACTIVE' && commandTools.has(toolName))
        return { _tag: 'CommandStarted', command: toolCommandText(update.tool_info) }
      if (update.state === 'DONE') {
        if (searchTools.has(toolName))
          return { _tag: 'WebSearch' }
        if (fileTools.has(toolName)) {
          const path = toolFilePath(update.tool_info)
          return path === '' ? undefined : { _tag: 'FileChanged', changes: [{ path, kind: toolName === 'write_to_file' ? 'add' : 'update' }] }
        }
        if (commandTools.has(toolName)) {
          const failed = text(update.error) !== ''
          return {
            _tag: 'CommandCompleted',
            command: toolCommandText(update.tool_info),
            output: failed ? text(update.error) : text(update.response) || text(update.text_delta),
            exitCode: failed ? 1 : 0,
          }
        }
      }
    }
    return undefined
  }
  if (line.event === 'result' && line.result !== undefined) {
    const result = line.result
    if (result.status !== 'SUCCESS') {
      const reason = text(result.error) || text(result.response) || 'The agy session failed.'
      return { _tag: 'Failed', reason: agentProviderFailureReason('agy', reason) }
    }
    if (result.structured_output !== undefined && result.structured_output !== null)
      return agentTextEvent(JSON.stringify(result.structured_output))
    const rawText = text(result.response)
    if (rawText.trim() !== '')
      return agentTextEvent(outputSchema === undefined ? rawText : extractJsonObject(rawText))
    return { _tag: 'TurnCompleted' }
  }
  return undefined
}

/** Builds CLI flags for headless NDJSON Antigravity turns inside `bwrap`. */
export function agyArguments(
  request: {
    model: string
    reasoningEffort?: string | undefined
    outputSchema?: unknown
    sessionId: string | null
  },
  reviewMode = false,
): string[] {
  const settings = {
    useG1Credits: false,
    enableTerminalSandbox: false,
    toolPermission: 'always-proceed',
    ...(reviewMode
      ? {
          permissions: {
            allow: ['mcp(controller_review/*)'],
            deny: ['command(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)'],
          },
        }
      : {}),
  }
  return [
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--model',
    request.model,
    ...(request.reasoningEffort !== undefined && request.reasoningEffort !== 'none' ? ['--effort', request.reasoningEffort] : []),
    '--disable-slash-commands',
    '--dangerously-skip-permissions',
    ...(reviewMode ? ['--mode', 'plan'] : []),
    ...(request.outputSchema === undefined ? [] : ['--json-schema', JSON.stringify(request.outputSchema)]),
    '--settings',
    JSON.stringify(settings),
    ...(request.sessionId === null ? [] : ['--conversation', request.sessionId]),
    '-p=',
  ]
}

function agyPromptText(
  request: AgentTurnRequest,
  prompt: string,
  mediaPaths: readonly string[],
  skillCatalogPath: string | undefined,
): string {
  const sections = [
    prompt,
    ...(request.instructionPaths === undefined || request.instructionPaths.length === 0
      ? []
      : [`Controller instruction files:\n${request.instructionPaths.map(path => `- ${path}`).join('\n')}`]),
    ...(mediaPaths.length === 0
      ? []
      : [`Attached image files (read with your file reader if needed):\n${mediaPaths.map(path => `- ${path}`).join('\n')}`]),
    ...(request.vitalsComparison === undefined ? [] : [vitalsEvidenceInstructions(request.vitalsComparison)]),
  ].join('\n\n')
  return agentSkillCatalogPrompt(sections, skillCatalogPath)
}

function agyFailureReason(standardError: string, exit: { code: number | null, signal: NodeJS.Signals | null }): string {
  // eslint-disable-next-line no-control-regex
  const clean = standardError.replaceAll(/\u001B\[[\d;]*m/g, '').replace(/^Error:\s*/m, '').trim()
  if (clean.length > 0)
    return agentProviderFailureReason('agy', clean)
  return exit.signal === null
    ? `The agy session exited with code ${exit.code ?? 'unknown'}.`
    : `The agy session was stopped by ${exit.signal}.`
}

function writeStreamInput(child: ChildProcess, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.stdin === null || child.stdin.destroyed || child.stdin.writableEnded) {
      reject(new Error('The agy input stream is closed.'))
      return
    }
    child.stdin.write(`${JSON.stringify({ event: 'user', message: { content } })}\n`, (error) => {
      if (error)
        reject(error)
      else
        resolve()
    })
  })
}

export function createAgyProvider(options: AgyProviderOptions = {}): AgentProvider {
  const idleTimeoutMilliseconds = options.idleTimeoutMilliseconds ?? 10 * 60_000
  const cachedContextBudget = options.cachedContextBudget ?? DEFAULT_AGY_CACHED_CONTEXT_BUDGET
  const environment = options.environment ?? process.env

  async function* runOnce(
    request: AgentTurnRequest,
    prompt: string,
    mediaPaths: readonly string[],
    review: ReviewRuntime | undefined,
    vitalsEvidenceDirectory: string | undefined,
  ): AsyncGenerator<AgentEvent> {
    const taskId = request.taskId
    if (request.signal.aborted) {
      yield { _tag: 'Failed', reason: 'The agy turn was cancelled.', cause: 'host-cancelled' }
      return
    }
    const args = agyArguments(request, review !== undefined)
    let sandbox: AgentSandbox | undefined
    const launched = options.spawnAgy !== undefined
      ? await options.spawnAgy({
          args,
          workspace: request.workspace,
          environment,
          readOnlyPaths: [...mediaPaths, ...(request.instructionPaths ?? []), ...(review?.readOnlyPaths ?? [])],
          ...(taskId === undefined ? {} : { taskId }),
          ...(review === undefined ? {} : { review }),
          ...(vitalsEvidenceDirectory === undefined ? {} : { vitalsEvidenceDirectory }),
          ...(request.routineContext === undefined ? {} : { routineContext: request.routineContext }),
        }).then(value => ({ _tag: 'Ok' as const, value })).catch((error: unknown) => ({ _tag: 'Err' as const, reason: `The agy isolation failed: ${error instanceof Error ? error.message : String(error)}` }))
      : await (async () => {
          sandbox = await prepareAgentSandbox({
            workspace: request.workspace,
            environment,
            provider: 'agy',
            ...(options.memoryPerAgentGiB === undefined ? {} : { memoryPerAgentGiB: options.memoryPerAgentGiB }),
            readOnlyPaths: [...mediaPaths, ...(request.instructionPaths ?? []), ...(review?.readOnlyPaths ?? [])],
            ...(taskId === undefined ? {} : { taskId }),
            ...(review === undefined ? {} : { reviewHome: review.home, readOnly: true }),
            ...(vitalsEvidenceDirectory === undefined ? {} : { vitalsEvidenceDirectory }),
            ...(request.routineContext === undefined ? {} : { routineContext: request.routineContext }),
          })
          const child = spawn(sandbox.binary, [...sandbox.args, sandbox.providerBinary, ...args], {
            cwd: request.workspace,
            env: sandbox.environment,
            stdio: ['pipe', 'pipe', 'pipe'],
          })
          return {
            _tag: 'Ok' as const,
            value: {
              child,
              skillCatalogPath: sandbox.skillCatalogPath,
              memoryExceeded: sandbox.memoryExceeded,
              release: sandbox.release,
            },
          }
        })().catch((error: unknown) => ({ _tag: 'Err' as const, reason: `The agy isolation failed: ${error instanceof Error ? error.message : String(error)}` }))

    if (launched._tag === 'Err') {
      await sandbox?.release()
      yield { _tag: 'Failed', reason: launched.reason, cause: 'sandbox-setup' }
      return
    }

    const { child, skillCatalogPath, memoryExceeded, release } = launched.value
    const stop = (signal: NodeJS.Signals) => {
      if (child.pid !== undefined)
        child.kill(signal)
    }
    const abort = () => stop('SIGTERM')
    request.signal.addEventListener('abort', abort, { once: true })
    if (request.signal.aborted)
      abort()

    let standardError = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      standardError = `${standardError}${chunk}`.slice(-maximumErrorCharacters)
    })

    const exited = new Promise<AgyExit>((resolve) => {
      child.once('error', error => resolve({ _tag: 'SpawnFailed', error }))
      child.once('exit', (code, signal) => resolve({ _tag: 'Exited', code, signal }))
    })

    let inputError: Error | undefined
    child.stdin?.on('error', (error: Error) => {
      inputError = error
      stop('SIGKILL')
    })

    const fullPrompt = agyPromptText(request, prompt, mediaPaths, review === undefined ? skillCatalogPath : undefined)
    void writeStreamInput(child, fullPrompt).catch((error: Error) => {
      inputError = error
      stop('SIGKILL')
    })

    let lastOutputAt = Date.now()
    let silent = false
    const watchdog = setInterval(() => {
      if (Date.now() - lastOutputAt < idleTimeoutMilliseconds)
        return
      silent = true
      stop('SIGKILL')
    }, Math.max(1_000, Math.floor(idleTimeoutMilliseconds / 4)))
    watchdog.unref()

    let sessionId = request.sessionId
    let sessionReported = false
    let failed = false
    let completed = false
    let cachedTokensRead = 0
    let usage: Extract<AgentTokenUsage, { _tag: 'Available' }> = { _tag: 'Available', input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 }
    let usageAvailable = false
    let budget: ContextBudgetPhase = { _tag: 'Normal' }

    try {
      if (child.stdout === null)
        throw new Error('The agy session has no output stream.')
      for await (const raw of createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY })) {
        const line = raw.trim()
        lastOutputAt = Date.now()
        if (!line.startsWith('{'))
          continue
        const parsed = await new Response(line).json().catch(() => undefined)
        if (!record(parsed))
          continue
        const eventLine = parsed as AgyLine
        const eventConversationId = text(eventLine.conversation_id)
          || text(eventLine.step_update?.conversation_id)
          || text(eventLine.result?.conversation_id)
        if (eventConversationId !== '' && sessionId !== null && eventConversationId !== sessionId) {
          failed = true
          stop('SIGKILL')
          yield { _tag: 'Failed', reason: 'The agy stream returned another conversation identity.' }
          break
        }
        if (!sessionReported && eventConversationId !== '') {
          sessionReported = true
          sessionId = eventConversationId
          yield { _tag: 'SessionStarted', sessionId }
        }
        const stepUsage = agyStepUsage(eventLine)
        if (stepUsage !== undefined) {
          usageAvailable = true
          usage = addUsage(usage, stepUsage)
          cachedTokensRead += stepUsage.cachedInput
        }
        if (eventLine.event === 'result' && eventLine.result !== undefined) {
          if (!usageAvailable) {
            const totalUsage = agyUsageFromRaw(eventLine.result.usage)
            if (totalUsage !== undefined) {
              usageAvailable = true
              usage = totalUsage
            }
          }
          child.stdin?.end()
        }
        const event = agyAgentEvent(eventLine, request.outputSchema)
        if (event !== undefined) {
          if (event._tag === 'Failed') {
            failed = true
            yield (await memoryExceeded?.()) ? { _tag: 'Failed', reason: 'The Agent Task exceeded its memory budget.', cause: 'resource-limit' } : event
          }
          else if (event._tag !== 'TurnCompleted') {
            yield event
          }
        }
        if (eventLine.event === 'result' && eventLine.result?.status === 'SUCCESS') {
          completed = true
          break
        }
        if (stepUsage === undefined)
          continue
        const advanced = advanceContextBudget(budget, cachedTokensRead, cachedContextBudget)
        budget = advanced.phase
        if (advanced.action._tag === 'Stop') {
          stop('SIGKILL')
          break
        }
        if (advanced.action._tag === 'Warn') {
          const delivered = await writeStreamInput(child, contextBudgetWrapUpPrompt(cachedTokensRead, cachedContextBudget))
            .then(() => ({ _tag: 'Sent' as const }))
            .catch((error: unknown) => ({ _tag: 'Failed' as const, reason: error instanceof Error ? error.message : String(error) }))
          yield { _tag: 'ContextBudgetWarned', cachedTokensRead, delivery: delivered }
        }
      }

      const exit = await exited
      if (request.vitalsComparison !== undefined && sandbox !== undefined) {
        const result = await inspectVitalsComparison(sandbox, request.vitalsComparison, request.signal)
        yield { _tag: 'VitalsComparison', result, retainedDirectory: vitalsEvidenceDirectory ?? null }
      }
      if (usageAvailable)
        yield { _tag: 'Usage', usage, scope: 'Turn' }
      if (await memoryExceeded?.()) {
        yield { _tag: 'Failed', reason: 'The Agent Task exceeded its memory budget.', cause: 'resource-limit' }
        return
      }
      if (exit._tag === 'SpawnFailed') {
        yield { _tag: 'Failed', reason: agentProviderFailureReason('agy', exit.error.message) }
        return
      }
      if (budget._tag === 'Exhausted') {
        yield { _tag: 'ContextBudgetExhausted', cachedTokensRead }
        return
      }
      if (silent) {
        yield { _tag: 'Failed', reason: 'The agy session stopped sending output.' }
        return
      }
      if (request.signal.aborted) {
        yield { _tag: 'Failed', reason: 'The agy turn was cancelled.', cause: 'host-cancelled' }
        return
      }
      if (inputError !== undefined) {
        yield { _tag: 'Failed', reason: `The agy prompt delivery failed: ${inputError.message}` }
        return
      }
      if (completed && exit.code === 0) {
        yield { _tag: 'TurnCompleted' }
      }
      else if (exit.code !== 0 && !failed) {
        yield { _tag: 'Failed', reason: agyFailureReason(standardError, exit) }
      }
      else if (!failed && !completed) {
        yield { _tag: 'Failed', reason: 'The agy session finished without a result.' }
      }
    }
    finally {
      clearInterval(watchdog)
      request.signal.removeEventListener('abort', abort)
      stop('SIGTERM')
      await release()
    }
  }

  return {
    name: 'agy',
    runTurn: (request: AgentTurnRequest) => (async function* () {
      const media = await materializeAgentMedia(request.media)
      let review: ReviewRuntime | undefined
      let vitalsEvidenceDirectory: string | undefined
      try {
        if (request.vitalsComparison !== undefined) {
          if (request.routineContext?.routineName !== 'vitals-review' || request.taskId !== request.vitalsComparison.taskId || request.toolPolicy !== undefined) {
            yield { _tag: 'Failed', reason: 'The performance evidence request has no trusted vitals Task.' }
            return
          }
          vitalsEvidenceDirectory = await createVitalsEvidenceDirectory(environment.HOME ?? '/home/harlan', request.vitalsComparison)
        }
        if (request.toolPolicy?._tag === 'Review') {
          if (options.reviewProofAuthority === undefined) {
            yield { _tag: 'Failed', reason: 'The Review requires its controller proof authority.' }
            return
          }
          const prepared = await createReviewRuntime({ request, provider: 'agy', environment, authority: options.reviewProofAuthority })
            .then(value => ({ _tag: 'Ok' as const, value }))
            .catch((error: unknown) => ({ _tag: 'Err' as const, reason: `The Review tools failed to start: ${error instanceof Error ? error.message : String(error)}` }))
          if (prepared._tag === 'Err') {
            yield { _tag: 'Failed', reason: prepared.reason }
            return
          }
          review = prepared.value
        }
        yield* runOnce(
          request,
          `${request.prompt}\n\n${jsonOutputInstruction(request.outputSchema)}`,
          media.paths,
          review,
          vitalsEvidenceDirectory,
        )
      }
      finally {
        let released: Awaited<ReturnType<ReviewRuntime['release']>> | undefined
        try {
          released = await review?.release()
        }
        finally {
          await media.release()
        }
        for (const warning of released?.warnings ?? [])
          yield { _tag: 'Reasoning', text: `Controller warning: ${warning}` }
      }
    })(),
  }
}
