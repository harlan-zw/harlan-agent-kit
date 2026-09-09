import type { AgentActivityLog } from './agent-activity.ts'
import type { AgentRuntimeSource } from './agent-profile.ts'
import type { AgentProgressWork } from './agent-progress.ts'
import type { AgentTokenUsage } from './agent-provider.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { AgentProgress, AgentRole } from './types.ts'
import { agentActivityFromEvent } from './agent-activity.ts'
import { roleProfile } from './agent-profile.ts'
import { agentEventProgress } from './agent-progress.ts'
import { addAgentTokenUsage } from './agent-provider.ts'
import { contextBudgetExhaustedReason } from './failure.ts'
import { err, ok } from './result.ts'

/**
 * How often one unchanged phase restates itself on the pull request.
 *
 * Progress only moves forward, so a Repair that edits files for forty minutes
 * publishes one line and then goes quiet. A reader could not tell that from an
 * agent that had died. A slow beat proves the agent is still producing events,
 * and stays far below the noise of a comment per file.
 */
const PROGRESS_HEARTBEAT_MILLISECONDS = 15 * 60_000

export interface AgentTurnOptions {
  activityLog?: Pick<AgentActivityLog, 'record'>
  now: () => Date
  /** Read when a turn starts, so a switch never disturbs a turn already running. */
  runtime: AgentRuntimeSource
  store: Pick<JournalStore, 'getWorkerSession' | 'saveWorkerSession'>
}

export interface AgentTurnInput {
  /** Start without prior session context, while still saving the new session for Eject. */
  freshSession?: boolean
  /** Absolute instruction files this turn adds, such as the memory index. */
  instructionPaths?: readonly string[]
  /** Issue or pull request number the session belongs to. */
  number: number
  progress?: {
    /** The phase the caller already reported, which the turn continues from. */
    current: AgentProgress
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
  usage: AgentTokenUsage
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
 * The JSON object inside an answer, without the Markdown a model adds around it.
 *
 * A model that was told to return bare JSON still fences it or opens with a
 * sentence. The work behind such an answer is complete, so paying a repair
 * turn for the wrapper is waste. Prose before the object is accepted only when
 * the remainder parses, so a garbled answer still reaches the parser unchanged
 * and fails with its own tagged error.
 */
function stripCodeFence(text: string): string {
  if (!text.startsWith('```') || !text.endsWith('```'))
    return text
  const open = text.indexOf('\n')
  if (open === -1)
    return text
  return text.slice(open + 1, text.length - 3).trim()
}

export function unwrapJsonResponse(response: string): string {
  const body = stripCodeFence(response.trim())
  if (body.startsWith('{'))
    return body
  const start = body.indexOf('{')
  if (start === -1)
    return response
  const remainder = body.slice(start)
  try {
    JSON.parse(remainder)
    return remainder
  }
  catch {
    // The remainder is not JSON either, so the original answer goes to the
    // parser and its own error names the failure.
    return response
  }
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
  const sessionId = input.freshSession === true
    ? null
    : options.store.getWorkerSession(input.repository, input.number, sessionRole, input.scopeDigest)
  const runtime = options.runtime(input.repository)
  const profile = roleProfile(runtime.profile, input.role)
  const events = runtime.provider.runTurn({
    ...(input.instructionPaths === undefined ? {} : { instructionPaths: input.instructionPaths }),
    taskId: input.taskId,
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
  let usage: AgentTokenUsage = { _tag: 'Unavailable' }
  let current = input.progress?.current
  let phaseSince = options.now().toISOString()
  let reportedAt = phaseSince
  for await (const event of events) {
    if (event._tag === 'SessionStarted') {
      currentSessionId = event.sessionId
      options.store.saveWorkerSession(input.repository, input.number, sessionRole, event.sessionId, options.now().toISOString(), input.scopeDigest)
    }
    if (event._tag === 'Message')
      response = event.text
    if (event._tag === 'Usage')
      usage = event.usage
    if (event._tag === 'ContextBudgetExhausted') {
      // The turn names the Item, so the Incident names the pull request a
      // person must look at. The provider only knows how much it read.
      failure ??= contextBudgetExhaustedReason({
        cachedTokensRead: event.cachedTokensRead,
        itemNumber: input.number,
        repository: input.repository,
      })
    }
    if (event._tag === 'Failed')
      failure ??= event.reason
    const activity = agentActivityFromEvent(event, options.now().toISOString())
    if (activity !== undefined)
      options.activityLog?.record(input.taskId, activity)
    if (input.progress !== undefined) {
      const at = options.now().toISOString()
      const next = agentEventProgress(event, input.progress.work)
      // A new phase restates the line. Otherwise the same phase restates it on
      // a slow beat, so a reader can see the agent is alive without a comment
      // for every file it touches.
      const advanced = next !== undefined && current !== undefined && next.percent > current.percent
      const stale = new Date(at).getTime() - new Date(reportedAt).getTime() >= PROGRESS_HEARTBEAT_MILLISECONDS
      if (advanced || stale) {
        const phase = advanced ? next as AgentProgress : current as AgentProgress
        if (advanced)
          phaseSince = at
        const reported = await input.progress.report({ ...phase, since: phaseSince })
        if (reported._tag === 'Err') {
          failure ??= reported.error
        }
        else {
          current = phase
          reportedAt = at
        }
      }
    }
  }

  if (failure !== undefined)
    return err(failure)
  if (response === undefined || currentSessionId === null)
    return err('The agent finished without a result.')
  return ok({ response, sessionId: currentSessionId, usage })
}

export interface ParsedAgentTurnOptions<Value> extends AgentTurnOptions {
  parse: (response: string) => Promise<Result<Value, string>> | Result<Value, string>
}

/** A completed turn whose answer either fit the parser or, after one repair, still did not. */
export type RepairedAgentTurn<Value>
  = | { _tag: 'Parsed', value: Value, sessionId: string, usage: AgentTokenUsage }
    | { _tag: 'Unparsed', reason: string, response: string, sessionId: string, usage: AgentTokenUsage }

/**
 * Runs one agent turn, buys one repair for a rejected answer, and names the
 * answer that still did not fit.
 *
 * The work behind a rejected answer stays valid, so a worker whose patch
 * outlives a bad envelope reads the Unparsed answer, keeps what it can, and
 * publishes with its own metadata instead of throwing the change away.
 */
export async function runRepairedAgentTurn<Value>(
  options: ParsedAgentTurnOptions<Value>,
  input: AgentTurnInput,
  signal: AbortSignal,
): Promise<Result<RepairedAgentTurn<Value>, string>> {
  // The repair turn quotes the first answer, so both turns use one runtime even
  // when the Agent selection changes between them.
  const runtime = options.runtime(input.repository)
  const frozen = { ...options, runtime: () => runtime }
  const turn = await runAgentTurn(frozen, input, signal)
  if (turn._tag === 'Err')
    return turn
  const parsed = await options.parse(unwrapJsonResponse(turn.value.response))
  if (parsed._tag === 'Ok')
    return ok({ _tag: 'Parsed', value: parsed.value, sessionId: turn.value.sessionId, usage: turn.value.usage })

  const repaired = await runAgentTurn(frozen, {
    ...input,
    prompt: repairPrompt(input.schema, turn.value.response, parsed.error),
    // The work is done, so this turn reports no progress of its own.
    ...(input.progress === undefined ? {} : { progress: { ...input.progress, current: { percent: 100, label: input.progress.current.label } } }),
  }, signal)
  if (repaired._tag === 'Err')
    return ok({ _tag: 'Unparsed', reason: parsed.error, response: turn.value.response, sessionId: turn.value.sessionId, usage: turn.value.usage })
  const reparsed = await options.parse(unwrapJsonResponse(repaired.value.response))
  const usage = addAgentTokenUsage(turn.value.usage, repaired.value.usage)
  return reparsed._tag === 'Ok'
    ? ok({ _tag: 'Parsed', value: reparsed.value, sessionId: repaired.value.sessionId, usage })
    : ok({ _tag: 'Unparsed', reason: reparsed.error, response: repaired.value.response, sessionId: repaired.value.sessionId, usage })
}

/**
 * Runs one agent turn and returns its parsed result.
 *
 * One rejected result buys one repair attempt, because the work behind it stays
 * valid even when the answer arrives in the wrong shape. An answer that still
 * does not fit fails the turn with the rule it broke.
 */
export async function runParsedAgentTurn<Value>(
  options: ParsedAgentTurnOptions<Value>,
  input: AgentTurnInput,
  signal: AbortSignal,
): Promise<Result<{ value: Value, sessionId: string, usage: AgentTokenUsage }, string>> {
  const turn = await runRepairedAgentTurn(options, input, signal)
  if (turn._tag === 'Err')
    return turn
  return turn.value._tag === 'Parsed'
    ? ok({ value: turn.value.value, sessionId: turn.value.sessionId, usage: turn.value.usage })
    : err(turn.value.reason)
}
