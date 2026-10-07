import type { AgentEvent, AgentTurnRequest } from '../src/agent-provider.ts'
import { expect, it } from 'vitest'
import { createCodexProvider } from '../src/codex-provider.ts'
import { createOpencodeProvider } from '../src/opencode-provider.ts'

it.each([createCodexProvider, createOpencodeProvider])('refuses Review before starting a provider without central proof ownership', async (createProvider) => {
  const request: AgentTurnRequest = {
    taskId: 'review-task',
    toolPolicy: { _tag: 'Review', headSha: 'a'.repeat(40), workerId: 'worker', fence: 1 },
    workspace: '/missing-worktree',
    prompt: '',
    model: '',
    sessionId: 'old-unrestricted-session',
    outputSchema: {},
    signal: new AbortController().signal,
  }
  const events: AgentEvent[] = []
  for await (const event of createProvider().runTurn(request))
    events.push(event)
  expect(events).toEqual([{ _tag: 'Failed', reason: 'The Review requires its controller proof authority.' }])
})
