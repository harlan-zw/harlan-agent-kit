import type { PreflightDependencies } from '../src/service-preflight.ts'
import type { AgentConfig, ValidatedAgentConfig } from '../src/types.ts'
import { describe, expect, it, vi } from 'vitest'
import { err, ok } from '../src/result.ts'
import { dashboardPasswordPath, describePreflightIssues, loadServiceInputs } from '../src/service-preflight.ts'

function validatedConfig(overrides: Record<string, unknown> = {}) {
  return {
    github: { privateKeyPath: '/keys/app.pem' },
    webhook: { _tag: 'Disabled' },
    classification: { _tag: 'Disabled' },
    server: { allowedOrigin: 'https://agent.example' },
    ...overrides,
  } as unknown as ValidatedAgentConfig
}

function dependencies(overrides: Partial<PreflightDependencies> = {}): PreflightDependencies {
  return {
    loadConfig: vi.fn(async () => ok({} as unknown as AgentConfig)),
    validateRepositoryMappings: vi.fn(async () => ok(validatedConfig())),
    loadGitHubAppPrivateKey: vi.fn(async () => ok('private-key')),
    loadDashboardPassword: vi.fn(async () => ok('password')),
    loadWebhookSecret: vi.fn(async () => ok('webhook-secret')),
    loadClassificationToken: vi.fn(async () => ok('classification-token')),
    loadGitIdentity: vi.fn(async () => ok({ name: 'Agent', email: 'agent@example.com' })),
    ...overrides,
  } as PreflightDependencies
}

describe('service preflight', () => {
  it('returns every input the service needs', async () => {
    const result = await loadServiceInputs('/config/agent.yml', dependencies())

    expect(result._tag).toBe('Ok')
    if (result._tag !== 'Ok')
      return
    expect(result.value.githubPrivateKey).toBe('private-key')
    expect(result.value.dashboardPassword).toBe('password')
    expect(result.value.gitIdentity.email).toBe('agent@example.com')
    expect(result.value.webhookSecret).toBeNull()
    expect(result.value.classificationToken).toBeNull()
  })

  it('reports a configuration this revision rejects and reads no secret', async () => {
    const loadGitHubAppPrivateKey = vi.fn(async () => ok('private-key'))
    const result = await loadServiceInputs('/config/agent.yml', dependencies({
      loadConfig: vi.fn(async () => err([{
        path: '$.agent.reasoning_effort.opencode.pull_request_triage',
        message: 'Expected one Agent role: adversarial_review, review_fix.',
      }])),
      loadGitHubAppPrivateKey,
    }))

    expect(result).toEqual({
      _tag: 'Err',
      error: [{
        path: '$.agent.reasoning_effort.opencode.pull_request_triage',
        message: 'Expected one Agent role: adversarial_review, review_fix.',
      }],
    })
    expect(loadGitHubAppPrivateKey).not.toHaveBeenCalled()
  })

  it('carries the webhook and classification secrets when both are enabled', async () => {
    const result = await loadServiceInputs('/config/agent.yml', dependencies({
      validateRepositoryMappings: vi.fn(async () => ok(validatedConfig({
        webhook: { _tag: 'Enabled', secretPath: '/keys/webhook' },
        classification: { _tag: 'Enabled', tokenPath: '/keys/classification' },
      }))),
    }))

    expect(result._tag).toBe('Ok')
    if (result._tag !== 'Ok')
      return
    expect(result.value.webhookSecret).toBe('webhook-secret')
    expect(result.value.classificationToken).toBe('classification-token')
  })

  it('gives a missing dashboard password an issue path', async () => {
    const result = await loadServiceInputs('/config/agent.yml', dependencies({
      loadDashboardPassword: vi.fn(async () => err('The dashboard password file does not exist.')),
    }))

    expect(result).toEqual({
      _tag: 'Err',
      error: [{ path: '$.server.dashboardPassword', message: 'The dashboard password file does not exist.' }],
    })
  })

  it('reads the dashboard password from beside the configuration file', () => {
    expect(dashboardPasswordPath('/config/agent.yml')).toBe('/config/dashboard-password')
  })

  it('prints one line for each issue', () => {
    expect(describePreflightIssues([
      { path: '$.a', message: 'First.' },
      { path: '$.b', message: 'Second.' },
    ])).toBe('$.a: First.\n$.b: Second.')
  })
})
