import type { CodexOptions, Input, ThreadEvent, ThreadOptions } from '@openai/codex-sdk'
import type { AgentEvent, AgentProvider, AgentTokenUsage, AgentTurnRequest } from './agent-provider.ts'
import type { AgentSandbox } from './agent-sandbox.ts'
import type { ReviewProofAuthorityFactory } from './review-proof-authority.ts'
import type { ReviewRuntime } from './review-runtime.ts'
import { dirname } from 'node:path'
import process from 'node:process'
import { Codex } from '@openai/codex-sdk'
import { agentProviderFailureReason, agentTextEvent } from './agent-provider.ts'
import { prepareAgentSandbox } from './agent-sandbox.ts'
import { materializeAgentMedia } from './github-media.ts'
import { createReviewRuntime, REVIEW_CODEX_FEATURES } from './review-runtime.ts'
import { workspaceEnvironment } from './workspace-environment.ts'

interface CodexThread {
  runStreamed: (prompt: Input, options: { outputSchema: unknown, signal: AbortSignal }) => Promise<{ events: AsyncIterable<ThreadEvent> }>
}

export interface CodexThreadClient {
  startThread: (options: ThreadOptions) => CodexThread
  resumeThread: (sessionId: string, options: ThreadOptions) => CodexThread
}

export interface CodexProviderOptions {
  reviewProofAuthority?: ReviewProofAuthorityFactory
  createCodex?: (options: CodexOptions) => CodexThreadClient
  readOnly?: boolean
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
 * runaway Codex turn while it runs. `ContextBudgetWarned` and
 * `ContextBudgetExhausted` therefore never come from this provider. The SDK
 * also takes no message into a running turn, so a wrap-up warning has no way
 * in. If the SDK adds per-step usage, meter it here the way
 * `opencode-provider.ts` meters `step_finish`.
 */
function definedEntries(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

export function createCodexProvider(options: CodexProviderOptions = {}): AgentProvider {
  const factory = options.createCodex ?? (codexOptions => new Codex(codexOptions))
  return {
    name: 'codex',
    runTurn: (request: AgentTurnRequest) => (async function* () {
      const media = await materializeAgentMedia(request.media)
      let sandbox: AgentSandbox | undefined
      let review: ReviewRuntime | undefined
      try {
        if (request.toolPolicy?._tag === 'Review') {
          if (options.reviewProofAuthority === undefined) {
            yield { _tag: 'Failed', reason: 'The Review requires its controller proof authority.' }
            return
          }
          const prepared = await createReviewRuntime({ request, provider: 'codex', environment: process.env, authority: options.reviewProofAuthority }).then(value => ({ _tag: 'Ok' as const, value })).catch((error: unknown) => ({ _tag: 'Err' as const, error }))
          if (prepared._tag === 'Err') {
            yield { _tag: 'Failed', reason: `The Review tools failed to start: ${prepared.error instanceof Error ? prepared.error.message : String(prepared.error)}` }
            return
          }
          review = prepared.value
        }
        if (options.createCodex === undefined) {
          const prepared = await prepareAgentSandbox({
            workspace: request.workspace,
            environment: process.env,
            provider: 'codex',
            readOnlyPaths: [...media.paths, ...(request.instructionPaths ?? []), ...(review?.readOnlyPaths ?? [])],
            ...(review === undefined ? {} : { reviewHome: review.home, readOnly: true }),
            ...(request.taskId === undefined ? {} : { taskId: request.taskId }),
            ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
          }).then(value => ({ _tag: 'Ok' as const, value })).catch((error: unknown) => ({ _tag: 'Err' as const, error }))
          if (prepared._tag === 'Err') {
            yield { _tag: 'Failed', reason: `The Codex Agent worker isolation failed: ${prepared.error instanceof Error ? prepared.error.message : String(prepared.error)}`, cause: 'sandbox-setup' }
            return
          }
          sandbox = prepared.value
        }
        // Production uses the trusted adapter and its sanitized environment.
        // Injected clients exercise only the provider's event translation.
        const client = factory({ ...(sandbox === undefined
          ? { env: definedEntries(workspaceEnvironment(process.env, request.workspace, request.taskId)) }
          : {
              codexPathOverride: sandbox.adapterPath,
              env: {
                PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
                HARLAN_AGENT_SANDBOX_ARGS: JSON.stringify([...sandbox.args, sandbox.providerBinary]),
                HARLAN_AGENT_SANDBOX_ENV: JSON.stringify(sandbox.environment),
              },
            }), ...(review === undefined ? {} : { config: { features: REVIEW_CODEX_FEATURES, agents: { enabled: false, max_depth: 0 } } }) })
        const baseOptions = {
          model: request.model,
          workingDirectory: request.workspace,
          webSearchMode: review === undefined ? 'live' : 'disabled',
          approvalPolicy: 'never',
          // The controller already isolates the whole process. Mutation tools cannot nest Bubblewrap inside it.
          sandboxMode: review === undefined ? 'danger-full-access' : 'read-only',
        } satisfies ThreadOptions
        const threadOptions: ThreadOptions = request.reasoningEffort === undefined
          ? baseOptions
          : { ...baseOptions, modelReasoningEffort: request.reasoningEffort as NonNullable<ThreadOptions['modelReasoningEffort']> }
        const input: Input = media.paths.length === 0 ? request.prompt : [{ type: 'text', text: request.prompt }, ...media.paths.map(path => ({ type: 'local_image' as const, path }))]
        const run = (thread: CodexThread) => thread.runStreamed(input, {
          outputSchema: request.outputSchema,
          signal: request.signal,
        })

        if (request.sessionId !== null && review === undefined) {
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
      }
      finally {
        let released: Awaited<ReturnType<ReviewRuntime['release']>> | undefined
        try {
          await sandbox?.release()
        }
        finally {
          try {
            released = await review?.release()
          }
          finally {
            await media.release()
          }
        }
        for (const text of released?.warnings ?? [])
          yield { _tag: 'Reasoning', text: `Controller warning: ${text}` }
      }
    })(),
  }
}
