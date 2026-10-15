import { describe, expect, it } from 'vitest'
import {
  availabilityFromError,
  canRemoveProvider,
  codexLoginProblem,
  configuredProviderCount,
  PROVIDERS,
  providerKeys,
  removeChanges,
  saveChanges,
} from '../dashboard/app/utils/settings.ts'
import type { SettingsView } from '../dashboard/app/utils/settings.ts'

function view(configured: Partial<Record<'claude' | 'codex' | 'opencode' | 'workersAi', boolean>>): SettingsView {
  return {
    ready: true,
    app: null,
    providers: {
      claude: { configured: configured.claude ?? false },
      codex: { configured: configured.codex ?? false },
      opencode: { configured: configured.opencode ?? false },
      workersAi: { configured: configured.workersAi ?? false, accountId: null },
    },
    githubUser: null,
    mutationsEnabled: true,
  }
}

describe('providers', () => {
  it('lists each provider once, with fields the Worker accepts', () => {
    const accepted = [
      'claudeToken',
      'codexAuth',
      'zaiApiKey',
      'workersAiToken',
      'workersAiAccountId',
      'githubUserToken',
    ]
    expect(new Set(PROVIDERS.map((provider) => provider.id)).size).toBe(PROVIDERS.length)
    for (const provider of PROVIDERS) for (const key of providerKeys(provider.id)) expect(accepted).toContain(key)
  })

  it('counts configured providers', () => {
    expect(configuredProviderCount(view({}))).toBe(0)
    expect(configuredProviderCount(view({ claude: true, workersAi: true }))).toBe(2)
  })

  it('does not offer to remove the last provider, or one that is not set', () => {
    expect(canRemoveProvider(view({ claude: true }), 'claude')).toBe(false)
    expect(canRemoveProvider(view({ claude: true, codex: true }), 'codex')).toBe(true)
    expect(canRemoveProvider(view({ claude: true, codex: true }), 'opencode')).toBe(false)
  })
})

describe('what a save sends', () => {
  it('sends only the fields that were filled in, trimmed', () => {
    expect(saveChanges('workersAi', { workersAiToken: '  cf-token ', workersAiAccountId: '   ' })).toEqual({
      workersAiToken: 'cf-token',
    })
    expect(saveChanges('claude', {})).toEqual({})
  })

  it('ignores fields that belong to another provider', () => {
    expect(saveChanges('claude', { claudeToken: 'a', zaiApiKey: 'b' })).toEqual({ claudeToken: 'a' })
  })

  it('removes every field of a provider with null, so no orphan account ID stays', () => {
    expect(removeChanges('workersAi')).toEqual({ workersAiToken: null, workersAiAccountId: null })
    expect(removeChanges('codex')).toEqual({ codexAuth: null })
  })
})

describe('codex login check', () => {
  it('accepts an empty field, a JSON object, and refuses the rest', () => {
    expect(codexLoginProblem('')).toBeNull()
    expect(codexLoginProblem('{"tokens":{}}')).toBeNull()
    expect(codexLoginProblem('not json')).toContain('not JSON')
    expect(codexLoginProblem('[1]')).toContain('not the contents')
    expect(codexLoginProblem('"text"')).toContain('not the contents')
  })
})

describe('availability', () => {
  it('maps the status of a failed load to what the page says', () => {
    expect(availabilityFromError(401, 'x')._tag).toBe('SignedOut')
    expect(availabilityFromError(403, 'x')._tag).toBe('SignedOut')
    expect(availabilityFromError(404, 'x')._tag).toBe('Unmanaged')
    expect(availabilityFromError(500, 'boom')).toEqual({ _tag: 'Failed', reason: 'boom' })
    expect(availabilityFromError(undefined, 'offline')).toEqual({ _tag: 'Failed', reason: 'offline' })
  })
})
