import type { ThreadEvent, ThreadOptions } from '@openai/codex-sdk'

interface CodexThread {
  runStreamed: (prompt: string, options: { outputSchema: unknown, signal: AbortSignal }) => Promise<{ events: AsyncIterable<ThreadEvent> }>
}

export interface CodexThreadClient {
  startThread: (options: ThreadOptions) => CodexThread
  resumeThread: (sessionId: string, options: ThreadOptions) => CodexThread
}

interface RunCodexTurnOptions {
  client: CodexThreadClient
  outputSchema: unknown
  prompt: string
  sessionId: string | null
  signal: AbortSignal
  threadOptions: ThreadOptions
}

function isMissingSession(error: unknown): boolean {
  return error instanceof Error && error.message.includes('no rollout found for thread id')
}

export function runCodexTurn(options: RunCodexTurnOptions): Promise<{ events: AsyncIterable<ThreadEvent> }> {
  const sessionId = options.sessionId
  const run = (thread: CodexThread) => thread.runStreamed(options.prompt, {
    outputSchema: options.outputSchema,
    signal: options.signal,
  })
  if (sessionId === null)
    return run(options.client.startThread(options.threadOptions))

  return Promise.resolve({
    events: (async function* () {
      try {
        const resumed = await run(options.client.resumeThread(sessionId, options.threadOptions))
        for await (const event of resumed.events)
          yield event
        return
      }
      catch (error) {
        if (!isMissingSession(error))
          throw error
      }

      const started = await run(options.client.startThread(options.threadOptions))
      for await (const event of started.events)
        yield event
    })(),
  })
}
