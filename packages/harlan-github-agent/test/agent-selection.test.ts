import type { AgentSelection } from '../src/agent-profile.ts'
import type { AgentProvider, AgentTurnRequest } from '../src/agent-provider.ts'
import { describe, expect, it } from 'vitest'
import {
  createAgentRuntimeSource,
  parseAgentSelection,
  resolveAgentProfile,
} from '../src/agent-profile.ts'
import { runAgentTurn } from '../src/agent-turn.ts'
import { openJournalStore } from '../src/store.ts'
import { stubProvider, turnEvents } from './fixtures.ts'

const codexProvider: AgentProvider = {
  name: 'codex',
  runTurn: () => (async function* () {})(),
}

const opencodeProvider: AgentProvider = {
  name: 'opencode',
  runTurn: () => (async function* () {})(),
}

describe('agent selection parsing', () => {
  it('accepts a provider on its own and keeps every role default', () => {
    const parsed = parseAgentSelection({ _tag: 'Pinned', provider: 'opencode' })

    expect(parsed).toEqual({ _tag: 'Ok', value: { _tag: 'Pinned', provider: 'opencode', model: null, reasoningEffort: null } })
  })

  it('accepts a model and a reasoning effort the provider offers', () => {
    const parsed = parseAgentSelection({ _tag: 'Pinned', provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' })

    expect(parsed).toEqual({ _tag: 'Ok', value: { _tag: 'Pinned', provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'max' } })
  })

  it('accepts GLM 5.3 Flash from OpenCode Go', () => {
    const parsed = parseAgentSelection({ _tag: 'Pinned', provider: 'opencode', model: 'opencode-go/glm-5.3-flash', reasoningEffort: 'high' })

    expect(parsed).toEqual({ _tag: 'Ok', value: { _tag: 'Pinned', provider: 'opencode', model: 'opencode-go/glm-5.3-flash', reasoningEffort: 'high' } })
  })

  it('rejects a model that belongs to the other provider', () => {
    const parsed = parseAgentSelection({ _tag: 'Pinned', provider: 'codex', model: 'opencode-go/deepseek-v4-pro' })

    expect(parsed).toEqual({ _tag: 'Err', error: 'The Agent provider codex does not offer that model.' })
  })

  it('rejects an unknown provider', () => {
    const parsed = parseAgentSelection({ _tag: 'Pinned', provider: 'claude' })

    expect(parsed).toEqual({ _tag: 'Err', error: 'Select codex or opencode as the Agent provider.' })
  })

  it('rejects an unknown reasoning effort', () => {
    const parsed = parseAgentSelection({ _tag: 'Pinned', provider: 'codex', reasoningEffort: 'extreme' })

    expect(parsed).toEqual({ _tag: 'Err', error: 'Select one reasoning effort: none, low, medium, high, xhigh, or max.' })
  })

  it('accepts a selection that follows the configuration', () => {
    const parsed = parseAgentSelection({ _tag: 'FollowsConfiguration' })

    expect(parsed).toEqual({ _tag: 'Ok', value: { _tag: 'FollowsConfiguration' } })
  })

  it('rejects a body that names no selection state', () => {
    const parsed = parseAgentSelection({ provider: 'codex', model: null })

    expect(parsed).toEqual({ _tag: 'Err', error: 'Pin an Agent provider, select automatic, or follow the configuration.' })
  })

  it('rejects a body that is not an object', () => {
    expect(parseAgentSelection('codex')).toEqual({ _tag: 'Err', error: 'Send an Agent selection to apply.' })
  })
})

describe('agent profile resolution', () => {
  it('keeps each role default when the selection names only a provider', () => {
    const profile = resolveAgentProfile({ provider: 'codex', model: null, reasoningEffort: null }, 3)

    expect(profile.roles.adversarial_review).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'high' })
    expect(profile.roles.issue_work).toEqual({ model: 'gpt-5.6-terra', reasoningEffort: 'medium' })
  })

  it('applies one model and one reasoning effort to every role', () => {
    const profile = resolveAgentProfile({ provider: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'low' }, 3)

    for (const role of Object.values(profile.roles))
      expect(role).toEqual({ model: 'gpt-5.6-luna', reasoningEffort: 'low' })
  })

  it('takes agent capacity from the caller, because the service fixes it at start', () => {
    const profile = resolveAgentProfile({ provider: 'opencode', model: null, reasoningEffort: null }, 5)

    expect(profile.maximumActiveAgents).toBe(5)
    expect(profile.provider).toBe('opencode')
  })
})

describe('agent runtime source', () => {
  it('answers with the configured provider until the selection pins one', () => {
    let selection: AgentSelection = { _tag: 'FollowsConfiguration' }
    const runtime = createAgentRuntimeSource({
      configuredProvider: 'codex',
      maximumActiveAgents: 3,
      providers: { codex: codexProvider, opencode: opencodeProvider },
      selection: () => selection,
    })

    const before = runtime()
    selection = { _tag: 'Pinned', provider: 'opencode', model: null, reasoningEffort: null }
    const after = runtime()

    expect(before.provider).toBe(codexProvider)
    expect(before.profile.roles.issue_triage.model).toBe('gpt-5.6-terra')
    expect(after.provider).toBe(opencodeProvider)
    expect(after.profile.roles.issue_triage.model).toBe('zai-coding-plan/glm-5.3-flash')
  })
})

describe('switching the Agent selection at runtime', () => {
  it('sends the newly selected model to the next agent turn', async () => {
    const store = openJournalStore(':memory:')
    const codex = { requests: [] as AgentTurnRequest[] }
    const opencode = { requests: [] as AgentTurnRequest[] }
    const options = {
      now: () => new Date('2026-08-18T01:00:00.000Z'),
      runtime: createAgentRuntimeSource({
        configuredProvider: 'codex',
        maximumActiveAgents: 3,
        providers: {
          codex: stubProvider(turnEvents({ outcome: 'resolved' }), codex),
          opencode: stubProvider(turnEvents({ outcome: 'resolved' }), opencode, 'opencode'),
        },
        selection: store.getAgentSelection,
      }),
      store: { getWorkerSession: () => null, saveWorkerSession: () => undefined },
    }
    const input = {
      number: 24,
      prompt: 'Resolve the conflict.',
      repository: 'harlan-zw/example',
      role: 'conflict_resolution' as const,
      schema: { type: 'object' },
      taskId: 'task-1',
      workspace: '/tmp/worktree',
    }

    try {
      await runAgentTurn(options, input, new AbortController().signal)
      store.selectAgent({ _tag: 'Pinned', provider: 'opencode', model: 'opencode-go/deepseek-v4-pro', reasoningEffort: 'low' }, '2026-08-18T01:01:00.000Z')
      await runAgentTurn(options, input, new AbortController().signal)
    }
    finally {
      store.close()
    }

    expect(codex.requests.map(request => [request.model, request.reasoningEffort]))
      .toEqual([['gpt-5.6-terra', 'medium']])
    expect(opencode.requests.map(request => [request.model, request.reasoningEffort]))
      .toEqual([['opencode-go/deepseek-v4-pro', 'low']])
  })
})
