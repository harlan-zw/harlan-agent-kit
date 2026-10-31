import { afterEach, expect, it, vi } from 'vitest'
import { prepareAgentSandbox } from '../src/agent-sandbox.ts'
import { createCodexProvider } from '../src/codex-provider.ts'
import { createOpencodeProvider } from '../src/opencode-provider.ts'

vi.mock('../src/agent-sandbox.ts', () => ({
  prepareAgentSandbox: vi.fn().mockRejectedValue(new Error('Fixture sandbox boundary')),
  opencodeSandboxPaths: () => [],
}))

afterEach(() => vi.clearAllMocks())

it.each(['codex', 'opencode'] as const)('passes trusted issue context to the %s tool sandbox', async (name) => {
  const provider = name === 'codex' ? createCodexProvider() : createOpencodeProvider()
  const routineContext = { repository: 'owner/site', routineName: 'seo-review' as const }
  const events = []
  for await (const event of provider.runTurn({
    model: 'fixture',
    outputSchema: {},
    prompt: 'Implement the verified issue.',
    sessionId: null,
    signal: new AbortController().signal,
    workspace: '/tmp/worktree',
    taskId: 'opaque-issue-work-task',
    routineContext,
  })) {
    events.push(event)
  }
  expect(events).toContainEqual(expect.objectContaining({ _tag: 'Failed', cause: 'sandbox-setup' }))
  expect(prepareAgentSandbox).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'opaque-issue-work-task', routineContext }))
})
