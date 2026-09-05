import type { CodexOptions, ThreadEvent, ThreadOptions } from '@openai/codex-sdk'
import type { AgentEvent, AgentProvider, AgentTokenUsage, AgentTurnRequest } from './agent-provider.ts'
import process from 'node:process'
import { Codex } from '@openai/codex-sdk'
import { agentProviderFailureReason, agentTextEvent } from './agent-provider.ts'
import { workspaceEnvironment } from './workspace-environment.ts'

interface CodexThread {
  runStreamed: (prompt: string, options: { outputSchema: unknown, signal: AbortSignal }) => Promise<{ events: AsyncIterable<ThreadEvent> }>
}

export interface CodexThreadClient {
  startThread: (options: ThreadOptions) => CodexThread
  resumeThread: (sessionId: string, options: ThreadOptions) => CodexThread
}

export interface CodexProviderOptions {
  createCodex?: (options: CodexOptions) => CodexThreadClient
}

function isMissingSession(error: unknown): boolean {
  return error instanceof Error && error.message.includes('no rollout found for thread id')
}

/** Maps one Codex thread event to the provider-neutral event. */
export function codexAgentEvent(event: ThreadEvent): AgentEvent | undefined {
  if (event.type === 'thread.started')
    return { _tag: 'SessionStarted', sessionId: event.thread_id }
  if (event.type === 'item.started') {
    if (event.item.type === 'command_execution')
      return { _tag: 'CommandStarted', command: event.item.command }
    if (event.item.type === 'web_search')
      return { _tag: 'WebSearch' }
    if (event.item.type === 'file_change')
      return { _tag: 'FileChanged', changes: event.item.changes.map(change => ({ path: change.path, kind: change.kind })) }
  }
  if (event.type === 'item.completed') {
    if (event.item.type === 'command_execution') {
      return {
        _tag: 'CommandCompleted',
        command: event.item.command,
        output: event.item.aggregated_output,
        exitCode: event.item.exit_code ?? null,
      }
    }
    if (event.item.type === 'file_change')
      return { _tag: 'FileChanged', changes: event.item.changes.map(change => ({ path: change.path, kind: change.kind })) }
    if (event.item.type === 'reasoning')
      return { _tag: 'Reasoning', text: event.item.text }
    if (event.item.type === 'agent_message')
      return agentTextEvent(event.item.text)
  }
  if (event.type === 'turn.completed')
    return { _tag: 'TurnCompleted' }
  if (event.type === 'turn.failed')
    return { _tag: 'Failed', reason: agentProviderFailureReason('codex', event.error.message) }
  if (event.type === 'error')
    return { _tag: 'Failed', reason: agentProviderFailureReason('codex', event.message) }
  return undefined
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

export function codexAgentUsage(event: ThreadEvent): Extract<AgentTokenUsage, { _tag: 'Available' }> | undefined {
  if (event.type !== 'turn.completed')
    return undefined
  return {
    _tag: 'Available',
    input: tokenCount(event.usage.input_tokens),
    cachedInput: tokenCount(event.usage.cached_input_tokens),
    cacheWrite: tokenCount(event.usage.cache_write_input_tokens),
    output: tokenCount(event.usage.output_tokens),
    reasoning: tokenCount(event.usage.reasoning_output_tokens),
  }
}

async function* providerEvents(events: AsyncIterable<ThreadEvent>): AsyncGenerator<AgentEvent> {
  for await (const event of events) {
    const usage = codexAgentUsage(event)
    if (usage !== undefined)
      yield { _tag: 'Usage', usage }
    const mapped = codexAgentEvent(event)
    if (mapped !== undefined)
      yield mapped
  }
}

/**
 * Codex sessions carry no Context budget.
 *
 * The Codex SDK reports usage once, on `turn.completed`, after the whole turn
 * has been paid for. It reports nothing per model step, so nothing can stop a
 * runaway Codex turn while it runs. `ContextBudgetExhausted` therefore never
 * comes from this provider. If the SDK adds per-step usage, meter it here the
 * way `opencode-provider.ts` meters `step_finish`.
 */
function definedEntries(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

export function createCodexProvider(options: CodexProviderOptions = {}): AgentProvider {
  const factory = options.createCodex ?? (codexOptions => new Codex(codexOptions))
  return {
    name: 'codex',
    runTurn: (request: AgentTurnRequest) => (async function* () {
      // The SDK replaces the inherited environment when `env` is set, so the
      // whole service environment goes with the worktree's seeded .env on top.
      // Codex takes no per-turn instruction file, so it ignores
      // `request.instructionPaths`. The prompt names the memory index path, and
      // the turn opens it as a file instead.
      const client = factory({ env: definedEntries(workspaceEnvironment(process.env, request.workspace)) })
      const baseOptions = {
        model: request.model,
        workingDirectory: request.workspace,
        webSearchMode: 'live',
        approvalPolicy: 'never',
      } satisfies ThreadOptions
      const threadOptions: ThreadOptions = request.reasoningEffort === undefined
        ? baseOptions
        : { ...baseOptions, modelReasoningEffort: request.reasoningEffort as NonNullable<ThreadOptions['modelReasoningEffort']> }
      const run = (thread: CodexThread) => thread.runStreamed(request.prompt, {
        outputSchema: request.outputSchema,
        signal: request.signal,
      })

      if (request.sessionId !== null) {
        try {
          const resumed = await run(client.resumeThread(request.sessionId, threadOptions))
          yield* providerEvents(resumed.events)
          return
        }
        catch (error) {
          // A dropped rollout is expected after a restart: start a fresh thread.
          if (!isMissingSession(error))
            throw error
        }
      }

      const started = await run(client.startThread(threadOptions))
      yield* providerEvents(started.events)
    })(),
  }
}
