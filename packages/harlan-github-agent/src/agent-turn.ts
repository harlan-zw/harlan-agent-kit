import type { AgentActivityLog } from './agent-activity.ts'
import type { AgentRuntimeSource } from './agent-profile.ts'
import type { AgentProgressWork } from './agent-progress.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { AgentProgress, AgentRole } from './types.ts'
import { agentActivityFromEvent } from './agent-activity.ts'
import { roleProfile } from './agent-profile.ts'
import { agentEventProgress } from './agent-progress.ts'
import { err, ok } from './result.ts'

export interface AgentTurnOptions {
  activityLog?: Pick<AgentActivityLog, 'record'>
  now: () => Date
  /** Read when a turn starts, so a switch never disturbs a turn already running. */
  runtime: AgentRuntimeSource
  store: Pick<JournalStore, 'getWorkerSession' | 'saveWorkerSession'>
}

export interface AgentTurnInput {
  /** Issue or pull request number the session belongs to. */
  number: number
  progress?: {
    currentPercent: number
    report: (progress: AgentProgress) => Promise<Result<void, string>> | Result<void, string>
    work: AgentProgressWork
  }
  prompt: string
  repository: string
  role: AgentRole
  schema: unknown
  /** Digest of the exact subject state a resumable session belongs to. */
  scopeDigest?: string
  /** Role that owns the reusable session, when it differs from the model role. */
  sessionRole?: AgentRole
  taskId: string
  workspace: string
}

export interface AgentTurnResult {
  response: string
  sessionId: string
}

/**
 * Asks for one corrected result.
 *
 * A model without native schema support answers the work correctly and the
 * envelope wrongly, so the controller repairs the envelope instead of paying
 * for the whole turn again.
 */
function repairPrompt(schema: unknown, response: string, reason: string): string {
  return `Your previous answer was rejected: ${reason}

Previous answer:
${response.slice(0, 8_000)}

Return one corrected JSON object that matches this schema and keeps every result you already decided:
${JSON.stringify(schema)}

Use no tool. Return no prose, no explanation, and no Markdown code fence.`
}

/**
 * Runs one agent turn against the configured provider.
 *
 * Owns session reuse, activity, and progress so every worker role behaves the
 * same whichever provider answers.
 */
export async function runAgentTurn(
  options: AgentTurnOptions,
  input: AgentTurnInput,
  signal: AbortSignal,
): Promise<Result<AgentTurnResult, string>> {
  const sessionRole = input.sessionRole ?? input.role
  const sessionId = options.store.getWorkerSession(input.repository, input.number, sessionRole, input.scopeDigest)
  const runtime = options.runtime()
  const profile = roleProfile(runtime.profile, input.role)
  const events = runtime.provider.runTurn({
    model: profile.model,
    ...(profile.reasoningEffort === undefined ? {} : { reasoningEffort: profile.reasoningEffort }),
    outputSchema: input.schema,
    prompt: input.prompt,
    sessionId,
    signal,
    workspace: input.workspace,
  })

  let response: string | undefined
  let currentSessionId = sessionId
  let failure: string | undefined
  let currentPercent = input.progress?.currentPercent ?? 0
  for await (const event of events) {
    if (event._tag === 'SessionStarted') {
      currentSessionId = event.sessionId
      options.store.saveWorkerSession(input.repository, input.number, sessionRole, event.sessionId, options.now().toISOString(), input.scopeDigest)
    }
    if (event._tag === 'Message')
      response = event.text
    if (event._tag === 'Failed')
      failure ??= event.reason
    const activity = agentActivityFromEvent(event, options.now().toISOString())
    if (activity !== undefined)
      options.activityLog?.record(input.taskId, activity)
    const progress = input.progress === undefined ? undefined : agentEventProgress(event, input.progress.work)
    if (progress !== undefined && progress.percent > currentPercent) {
      const reported = await input.progress!.report(progress)
      if (reported._tag === 'Err')
        failure ??= reported.error
      else
        currentPercent = progress.percent
    }
  }

  if (failure !== undefined)
    return err(failure)
  if (response === undefined || currentSessionId === null)
    return err('The agent finished without a result.')
  return ok({ response, sessionId: currentSessionId })
}

export interface ParsedAgentTurnOptions<Value> extends AgentTurnOptions {
  parse: (response: string) => Promise<Result<Value, string>> | Result<Value, string>
}

/**
 * Runs one agent turn and returns its parsed result.
 *
 * One rejected result buys one repair attempt, because the work behind it stays
 * valid even when the answer arrives in the wrong shape.
 */
export async function runParsedAgentTurn<Value>(
  options: ParsedAgentTurnOptions<Value>,
  input: AgentTurnInput,
  signal: AbortSignal,
): Promise<Result<{ value: Value, sessionId: string }, string>> {
  // The repair turn quotes the first answer, so both turns use one runtime even
  // when the Agent selection changes between them.
  const runtime = options.runtime()
  const frozen = { ...options, runtime: () => runtime }
  const turn = await runAgentTurn(frozen, input, signal)
  if (turn._tag === 'Err')
    return turn
  const parsed = await options.parse(turn.value.response)
  if (parsed._tag === 'Ok')
    return ok({ value: parsed.value, sessionId: turn.value.sessionId })

  const repaired = await runAgentTurn(frozen, {
    ...input,
    prompt: repairPrompt(input.schema, turn.value.response, parsed.error),
    // The work is done, so this turn reports no progress of its own.
    ...(input.progress === undefined ? {} : { progress: { ...input.progress, currentPercent: 100 } }),
  }, signal)
  if (repaired._tag === 'Err')
    return err(parsed.error)
  const reparsed = await options.parse(repaired.value.response)
  return reparsed._tag === 'Ok'
    ? ok({ value: reparsed.value, sessionId: repaired.value.sessionId })
    : err(parsed.error)
}
