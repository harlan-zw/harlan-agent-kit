/**
 * One provider-neutral boundary for every agent turn.
 *
 * Each provider translates its own transport into `AgentEvent`, so workers,
 * activity, and progress never see a vendor event shape.
 */

export type AgentProviderName = 'codex' | 'opencode'

/** Keeps the failure owner intact after workers persist only its reason. */
export function agentProviderFailureReason(provider: AgentProviderName, reason: string): string {
  return `The ${provider} session failed: ${reason}`
}

export type AgentTokenUsage
  = | { _tag: 'Unavailable' }
    | {
      _tag: 'Available'
      input: number
      cachedInput: number
      cacheWrite: number
      output: number
      reasoning: number
    }

export function addAgentTokenUsage(left: AgentTokenUsage, right: AgentTokenUsage): AgentTokenUsage {
  if (left._tag === 'Unavailable' || right._tag === 'Unavailable')
    return { _tag: 'Unavailable' }
  return {
    _tag: 'Available',
    input: left.input + right.input,
    cachedInput: left.cachedInput + right.cachedInput,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
  }
}

export type AgentEvent
  = | { _tag: 'SessionStarted', sessionId: string }
    | { _tag: 'CommandStarted', command: string }
    | { _tag: 'CommandCompleted', command: string, output: string, exitCode: number | null }
    | { _tag: 'FileChanged', changes: Array<{ path: string, kind: 'add' | 'delete' | 'update' }> }
    | { _tag: 'Reasoning', text: string }
    | { _tag: 'Progress', percent: number, text: string }
    | { _tag: 'WebSearch' }
    | { _tag: 'Message', text: string }
    | { _tag: 'Usage', usage: Extract<AgentTokenUsage, { _tag: 'Available' }> }
    | { _tag: 'TurnCompleted' }
    /** The session read its whole Context budget, so the provider stopped it. */
    | { _tag: 'ContextBudgetExhausted', cachedTokensRead: number }
    | { _tag: 'Failed', reason: string }

const agentProgressPrefix = /^[▓░]+[ \t]+(\d{1,3})%[ \t]+/

/** Separates an Agent progress report from its final result message. */
export function agentTextEvent(text: string): Extract<AgentEvent, { _tag: 'Message' | 'Progress' }> {
  const candidate = text.trim()
  const match = agentProgressPrefix.exec(candidate)
  const percent = Number(match?.[1])
  if (match === null || !Number.isInteger(percent) || percent < 0 || percent > 100)
    return { _tag: 'Message', text }
  const detail = candidate.slice(match[0].length).trim()
  return detail.length > 0 && !detail.includes('\n') && !detail.includes('\r')
    ? { _tag: 'Progress', percent, text: detail }
    : { _tag: 'Message', text }
}

export interface AgentTurnRequest {
  /** Provider-specific model identifier taken from the worker profile. */
  model: string
  /** JSON Schema the turn must answer with. */
  outputSchema: unknown
  prompt: string
  reasoningEffort?: string
  /** Session to resume, or null to start a new one. */
  sessionId: string | null
  signal: AbortSignal
  /** Absolute path of the prepared Git worktree. */
  workspace: string
}

/**
 * Cached context tokens one agent session may read before its provider stops it.
 *
 * Measured over seven days of real sessions. The median session read 898,048
 * cached tokens and the 95th percentile read 10,838,912. Twenty million is
 * about 22 times the median, so a thorough review keeps its depth. It stops 7
 * of 321 sessions and removes 14.8 percent of all cached reads. The worst
 * session read 60,562,304 cached tokens for one pull request review.
 *
 * Cached context reads were 97 percent of all token volume, so this budget
 * bounds the bill.
 */
export const DEFAULT_CACHED_CONTEXT_BUDGET = 20_000_000

export interface AgentProvider {
  name: AgentProviderName
  runTurn: (request: AgentTurnRequest) => AsyncIterable<AgentEvent>
}

/**
 * Providers without a native output schema get the contract in the prompt.
 * The schema is data the controller wrote, so it is safe to inline.
 */
export function jsonOutputInstruction(schema: unknown): string {
  return `Return one JSON object as your final message. Return no prose, no explanation, and no Markdown code fence.
The object must match this JSON Schema exactly:
${JSON.stringify(schema)}`
}

/**
 * Extracts the JSON object a provider without schema support returned.
 * Falls back to the raw text so the caller reports one parse failure.
 */
export function extractJsonObject(text: string): string {
  const fenced = /```(?:json)?\n?([\s\S]*?)```/i.exec(text)
  const candidate = (fenced?.[1] ?? text).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  return start === -1 || end <= start ? candidate : candidate.slice(start, end + 1)
}
