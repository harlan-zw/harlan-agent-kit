export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export interface JsonObject { [key: string]: JsonValue }

export type Result<T, E = TaskFailure> = { _tag: 'Ok', value: T } | { _tag: 'Err', error: E }

export interface TaskFailure {
  _tag: 'Configuration' | 'Authorization' | 'Transient' | 'Capacity' | 'Permanent'
  message: string
  retryAt?: string
  usage?: Usage
}

export type Parser<T> = (input: unknown) => Result<T>

export type Capability = 'repository:read' | 'agent:invoke' | 'github:comment' | 'github:review' | 'github:check' | 'process:execute' | 'repository:write' | 'github:merge' | 'secret:read'

export interface RepositoryRef {
  id: number
  fullName: string
  installationId: number
}

export interface Actor {
  id: number
  login: string
  kind: 'User' | 'Bot'
}

export type EventTarget
  = | { _tag: 'PullRequest', number: number, headSha: string, baseSha: string }
    | { _tag: 'Issue', number: number }
    | { _tag: 'Revision', sha: string, ref: string }

export interface EventEnvelope {
  id: string
  source: 'webhook' | 'poll' | 'manual'
  name: string
  action: string
  repository: RepositoryRef
  actor: Actor | null
  target: EventTarget
  occurredAt: string
  receivedAt: string
  semanticKey: string
  data: JsonValue
}

export interface WorkflowSelector {
  event: string
  actions?: string[]
}

export type TaskCondition
  = | { _tag: 'OutputEquals', task: string, path: string, value: JsonValue }
    | { _tag: 'EventAction', action: string }
    | { _tag: 'Succeeded', task: string }
    | { _tag: 'Not', condition: TaskCondition }

export interface TaskLimits {
  maxAttempts: number
  timeoutMs: number
}

export interface WorkflowLimits extends TaskLimits {
  maxTokens: number
  maxCostUsd: number | null
  maxDurationMs: number
}

export interface TaskDefinition {
  id: string
  uses: string
  with: JsonObject
  when?: TaskCondition
  limits?: TaskLimits
}

export interface WorkflowDefinition {
  version: 1
  id: string
  name: string
  on: WorkflowSelector[]
  tasks: TaskDefinition[]
  concurrency: { mode: 'replace' | 'queue' | 'reject', group: 'target' | 'repository' }
  limits: WorkflowLimits
}

export interface ConfigurationSource {
  source: string
  sha: string
  digest: string
}

export interface RepositoryPolicy {
  enabled: boolean
  capabilities: Capability[]
  maxConcurrency: number
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  costUsd: number | null
}

export type UsageReservation
  = | { _tag: 'Reserved', id: string, fence: number, ceiling: Usage }
    | { _tag: 'Settled', id: string, fence: number, ceiling: Usage, actual: Usage }

export type RunState
  = | { _tag: 'Queued' }
    | { _tag: 'Running' }
    | { _tag: 'Waiting', reason: string, until: string }
    | { _tag: 'Succeeded' }
    | { _tag: 'Failed', error: TaskFailure }
    | { _tag: 'Cancelled', reason: string }
    | { _tag: 'Superseded', byRunId: string }
    | { _tag: 'Skipped', reason: string }

export type TaskState
  = | { _tag: 'Queued' }
    | { _tag: 'Running', leaseUntil: string }
    | { _tag: 'Waiting', reason: string, until: string }
    | { _tag: 'Succeeded' }
    | { _tag: 'Failed', error: TaskFailure }
    | { _tag: 'Cancelled', reason: string }
    | { _tag: 'Skipped', reason: string }

export interface TaskRecord {
  id: string
  definition: TaskDefinition
  typeVersion: string
  state: TaskState
  attempts: number
  failures: number
  fence: number
  output: JsonValue | null
  usage: Usage
  unreservedUsage: Usage
  usageReservations: UsageReservation[]
  startedAt: string | null
  finishedAt: string | null
}

export interface RunRecord {
  id: string
  event: EventEnvelope
  definition: WorkflowDefinition
  definitionDigest: string
  configuration: ConfigurationSource
  policy: RepositoryPolicy
  state: RunState
  tasks: TaskRecord[]
  usage: Usage
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface ReviewComment {
  fingerprint: string
  path: string
  line: number
  side: 'LEFT' | 'RIGHT'
  body: string
  startLine?: number
}

export type CheckPhase
  = | { status: 'queued' | 'in_progress' }
    | { status: 'completed', conclusion: 'success' | 'neutral' | 'failure' | 'cancelled' | 'timed_out' | 'action_required' | 'skipped' }

export type PublicationEffect
  = | { _tag: 'Comment', repository: string, number: number, namespace: string, body: string }
    | { _tag: 'Review', repository: string, number: number, headSha: string, body: string, comments: ReviewComment[] }
    | { _tag: 'Check', repository: string, headSha: string, name: string, phase: CheckPhase, summary: string, detailsUrl?: string }
    | { _tag: 'Reply', repository: string, number: number, commentId: number, body: string }

export interface PublicationReceipt {
  id: string
  url: string | null
  data: JsonValue
}

export type PublicationState
  = | { _tag: 'Queued' }
    | { _tag: 'Sending' }
    | { _tag: 'Written', receipt: PublicationReceipt }
    | { _tag: 'Waiting', until: string, reason: string }
    | { _tag: 'Failed', error: TaskFailure }
    | { _tag: 'Cancelled', reason: string }

export interface PublicationRecord {
  id: string
  key: string
  runId: string
  taskId: string
  effect: PublicationEffect
  state: PublicationState
  attempts: number
  createdAt: string
  updatedAt: string
}

export interface PublicationContext {
  publication: PublicationRecord
  run: RunRecord
  signal: AbortSignal
}

export interface PublicationPublisher {
  authorize: (context: PublicationContext) => Promise<Result<void>>
  reconcile: (context: PublicationContext) => Promise<Result<PublicationReceipt | null>>
  publish: (context: PublicationContext) => Promise<Result<PublicationReceipt>>
}

export type TaskOutcome
  = | { _tag: 'Succeeded', output: JsonValue, usage?: Usage }
    | { _tag: 'Deferred', until: string, reason: string }
    | { _tag: 'Failed', error: TaskFailure, usage?: Usage }

export interface TaskContext {
  run: RunRecord
  task: TaskRecord
  event: EventEnvelope
  outputs: Record<string, JsonValue>
  signal: AbortSignal
  /** Reserve before a paid call. Unknown results keep this durable charge. */
  reserveUsage: (ceiling: Usage) => Promise<Result<string>>
  /** Settle only positively known usage. Repeating the same result is safe. */
  settleUsage: (reservationId: string, actual: Usage) => Promise<Result<void>>
  publish: (key: string, effect: PublicationEffect) => Promise<Result<string>>
}

export interface TaskType {
  id: string
  version: string
  capabilities: Capability[]
  input: Parser<JsonValue>
  output: Parser<JsonValue>
  execute: (context: TaskContext, input: JsonValue) => Promise<TaskOutcome>
}

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AgentRequest {
  messages: AgentMessage[]
  maxOutputTokens: number
  signal: AbortSignal
}

export interface AgentResponse {
  text: string
  usage: Usage
}

export interface AgentProvider {
  id: string
  generate: (request: AgentRequest) => Promise<Result<AgentResponse>>
}

export const ok = <T>(value: T): Result<T> => ({ _tag: 'Ok', value })
export const err = (error: TaskFailure): Result<never> => ({ _tag: 'Err', error })

export function isJsonValue(input: unknown, depth = 0): input is JsonValue {
  if (depth > 30)
    return false
  if (input === null || typeof input === 'string' || typeof input === 'boolean')
    return true
  if (typeof input === 'number')
    return Number.isFinite(input)
  if (Array.isArray(input))
    return input.every(value => isJsonValue(value, depth + 1))
  return typeof input === 'object' && Object.getPrototypeOf(input) === Object.prototype
    && Object.entries(input).every(([key, value]) => !['__proto__', 'constructor', 'prototype'].includes(key) && isJsonValue(value, depth + 1))
}

export const parseJsonValue: Parser<JsonValue> = input => isJsonValue(input)
  ? ok(input)
  : err({ _tag: 'Configuration', message: 'Expected bounded JSON data without prototype keys.' })

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, costUsd: null })
