/**
 * One provider-neutral boundary for every agent turn.
 *
 * Each provider translates its own transport into `AgentEvent`, so workers,
 * activity, and progress never see a vendor event shape.
 */

export type AgentProviderName = 'codex' | 'opencode'

export type AgentEvent
  = | { _tag: 'SessionStarted', sessionId: string }
    | { _tag: 'CommandStarted', command: string }
    | { _tag: 'CommandCompleted', command: string, output: string, exitCode: number | null }
    | { _tag: 'FileChanged', changes: Array<{ path: string, kind: 'add' | 'delete' | 'update' }> }
    | { _tag: 'Reasoning', text: string }
    | { _tag: 'WebSearch' }
    | { _tag: 'Message', text: string }
    | { _tag: 'TurnCompleted' }
    | { _tag: 'Failed', reason: string }

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
