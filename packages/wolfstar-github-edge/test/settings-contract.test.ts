import { describe, expect, it } from 'vitest'
import {
  PROVIDERS,
  isProviderConfigured,
  providerKeys,
} from '../../wolfstar-github-agent/dashboard/app/utils/settings.ts'
import type { SettingsView } from '../../wolfstar-github-agent/dashboard/app/utils/settings.ts'
import { parseProviderChanges, settingsView } from '../src/settings.ts'
import { READY_SETUP } from './fixtures.ts'

// The dashboard keeps its own copy of the view type, because it cannot import Worker code.
// These tests break when the two stop agreeing.
describe('the Worker and the dashboard agree on the settings contract', () => {
  it('gives the dashboard a view it can read, with no secret in it', () => {
    const produced = settingsView(
      {
        ...READY_SETUP,
        providers: { ...READY_SETUP.providers, workersAiToken: 'cf-secret', workersAiAccountId: 'a'.repeat(32) },
        githubUser: { token: 'ghp_secret', login: 'RedStar071' },
      },
      true,
    ) satisfies SettingsView

    expect(PROVIDERS.map((provider) => isProviderConfigured(produced, provider.id))).toEqual([true, false, false, true])
    expect(JSON.stringify(produced)).not.toMatch(/secret|sk-ant|ghp_/)
  })

  it('accepts every field the dashboard can send', () => {
    const body: Record<string, string> = {}
    for (const provider of PROVIDERS) for (const key of providerKeys(provider.id)) body[key] = 'value'
    body.githubUserToken = 'value'
    expect(parseProviderChanges(body)).toEqual({ _tag: 'Ok', changes: body })
  })
})
