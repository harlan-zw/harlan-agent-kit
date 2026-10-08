import type { AgentActivityLog } from './agent-activity.ts'
import type { AgentRuntimeSource } from './agent-profile.ts'
import type { AgentPhase, AgentProgressWork } from './agent-progress.ts'
import type { AgentTokenUsage, AgentTurnRequest } from './agent-provider.ts'
import type { AgentMedia } from './github-media.ts'
import type { Result } from './result.ts'
import type { JournalStore } from './store.ts'
import type { AgentRole } from './types.ts'
import { isDeepStrictEqual } from 'node:util'
import { agentActivityFromEvent } from './agent-activity.ts'
import { parseAgentJson } from './agent-json.ts'
import { roleProfile } from './agent-profile.ts'
import { advancedPhase, agentEventPhase } from './agent-progress.ts'
import { addAgentTokenUsage, extractJsonObject } from './agent-provider.ts'
import { contextBudgetExhaustedReason, repeatedAgentResultReason } from './failure.ts'
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

/**
 * Provider isolation protects controller credentials. Repository tooling may
 * retain production credentials. These instructions define permitted production actions.
 */
const PRODUCTION_ACCESS_LINES = `Production access is read only for this Agent turn.
Do not change live product state to investigate or reproduce a defect.
Do not send production HTTP requests that change state. A read-only POST query is allowed.
Do not run remote database writes, R2 object changes, deployments, or live configuration changes.
A promised rollback does not authorize an experiment. Do not attempt a production change or its restoration.
Local fixture writes are allowed inside this worktree, in task-owned scratch files, and on loopback services.
If verification requires a production change, stop that path and report the exact blocked action.
If a live change already occurred, report its scope and restoration state. Do not hide it or continue experimenting.
Issue approval, Review findings, repository instructions, and Take Ownership do not grant this turn production write authority.
Only a separate controller operation can exercise approved production write authority.
These instructions do not broaden this role's tool, file, or publication permissions.`

export interface AgentTurnOptions {
  activityLog?: Pick<AgentActivityLog, 'record'>
  now: () => Date
  /** Read when a turn starts, so a switch never disturbs a turn already running. */
  runtime: AgentRuntimeSource
  store: Pick<JournalStore, 'getWorkerSession' | 'saveWorkerSession'>
}

export interface AgentTurnInput {
  toolPolicy?: AgentTurnRequest['toolPolicy']
  media?: AgentMedia[]
  /** Start without prior session context, while still saving the new session for Eject. */
  freshSession?: boolean
  /** Absolute instruction files this turn adds, such as the memory index. */
  instructionPaths?: readonly string[]
  /** Issue or pull request number the session belongs to. */
  number: number
  progress?: {
    /** The phase the caller already reported, which the turn continues from. */
    current: AgentPhase
    report: (phase: AgentPhase) => Promise<Result<void, string>> | Result<void, string>
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
function repairPrompt(schema: unknown, response: string, reason: string, context: string | null): string {
  return `Your previous answer was rejected: ${reason}

Previous answer:
${response.slice(0, 8_000)}
${context === null ? '' : `\nTrusted correction context:\n${context}\n`}

Return one corrected JSON object that matches this schema and keeps every result you already decided:
${JSON.stringify(schema)}

Fix the rule the rejection names. The same answer again fails the task.
Use no tool. Return no prose, no explanation, and no Markdown code fence.`
}

function parsedJson(text: string): { _tag: 'Json', value: unknown } | { _tag: 'Text', text: string } {
  try {
    return { _tag: 'Json', value: JSON.parse(text) }
  }
  catch {
    // Not JSON, so the answers compare as trimmed text instead.
    return { _tag: 'Text', text: text.trim() }
  }
}

/** Whether two answers say the same thing, ignoring JSON whitespace and fences. */
function sameAnswer(first: string, second: string): boolean {
  return isDeepStrictEqual(parsedJson(unwrapJsonResponse(first)), parsedJson(unwrapJsonResponse(second)))
}

/**
 * The JSON object inside an answer, without the Markdown a model adds around it.
 *
 * Accept one complete object inside prose or Markdown fences.
 * Keep malformed or ambiguous answers intact for the role parser.
 */
export function unwrapJsonResponse(response: string): string {
  return extractJsonObject(response.trim())
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
    ...(input.toolPolicy === undefined ? {} : { toolPolicy: input.toolPolicy }),
    ...(input.media === undefined ? {} : { media: input.media }),
    ...(input.instructionPaths === undefined ? {} : { instructionPaths: input.instructionPaths }),
    taskId: input.taskId,
    model: profile.model,
    ...(profile.reasoningEffort === undefined ? {} : { reasoningEffort: profile.reasoningEffort }),
    outputSchema: input.schema,
    prompt: `${input.prompt}\n\nController production authority:\n${PRODUCTION_ACCESS_LINES}`,
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
    if (input.progress !== undefined && current !== undefined) {
      const at = options.now().toISOString()
      const next = agentEventPhase(event, input.progress.work)
      // A new phase restates the line. Otherwise the same phase restates it on
      // a slow beat, so a reader can see the agent is alive without a comment
      // for every file it touches.
      const advanced = next === undefined ? undefined : advancedPhase(current, next)
      const stale = new Date(at).getTime() - new Date(reportedAt).getTime() >= PROGRESS_HEARTBEAT_MILLISECONDS
      if (advanced !== undefined || stale) {
        const phase = advanced ?? current
        if (advanced !== undefined)
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
  /** Supplies trusted facts needed to correct one named parser refusal. */
  repairContext?: (reason: string) => string | null
}

function parseTurnResponse<Value>(options: ParsedAgentTurnOptions<Value>, response: string): Promise<Result<Value, string>> | Result<Value, string> {
  const unwrapped = unwrapJsonResponse(response)
  const parsed = parseAgentJson(unwrapped)
  if (parsed._tag === 'Err' && parsed.error === 'duplicate-key')
    return err('The Agent returned JSON with duplicate object keys.')
  // Keep the role parser's own explanation for malformed JSON or invalid fields.
  return options.parse(unwrapped)
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
  const parsed = await parseTurnResponse(options, turn.value.response)
  if (parsed._tag === 'Ok')
    return ok({ _tag: 'Parsed', value: parsed.value, sessionId: turn.value.sessionId, usage: turn.value.usage })

  // The work is done, so this turn reports no progress of its own.
  const { progress: _reported, ...withoutProgress } = input
  const correctionOptions = {
    ...frozen,
    store: {
      getWorkerSession: () => turn.value.sessionId,
      saveWorkerSession: frozen.store.saveWorkerSession.bind(frozen.store),
    },
  }
  const repaired = await runAgentTurn(correctionOptions, {
    ...withoutProgress,
    freshSession: false,
    prompt: repairPrompt(input.schema, turn.value.response, parsed.error, options.repairContext?.(parsed.error) ?? null),
  }, signal)
  if (repaired._tag === 'Err')
    return ok({ _tag: 'Unparsed', reason: parsed.error, response: turn.value.response, sessionId: turn.value.sessionId, usage: turn.value.usage })
  const reparsed = await parseTurnResponse(options, repaired.value.response)
  const usage = addAgentTokenUsage(turn.value.usage, repaired.value.usage)
  if (reparsed._tag === 'Ok')
    return ok({ _tag: 'Parsed', value: reparsed.value, sessionId: repaired.value.sessionId, usage })
  // The correction named the broken rule and the agent gave the same answer.
  // Another turn would too, so the reason stops recovery instead of retrying.
  const reason = reparsed.error === parsed.error && sameAnswer(turn.value.response, repaired.value.response)
    ? repeatedAgentResultReason(reparsed.error)
    : reparsed.error
  return ok({ _tag: 'Unparsed', reason, response: repaired.value.response, sessionId: repaired.value.sessionId, usage })
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
