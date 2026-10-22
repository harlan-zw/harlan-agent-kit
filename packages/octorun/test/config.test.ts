import type { WorkflowDefinition } from '@harlan-zw/octorun'
import { describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { buildKitOctorunConfig, parseKitServiceConfig } from '../src/config.ts'

function service(overrides: Record<string, unknown> = {}) {
  return {
    github: { app_id: 123, private_key_path: '/private/app.pem', allowed_owners: ['harlan-zw'] },
    storage: { path: '/state/legacy/state.sqlite' },
    repositories: [{ github: 'harlan-zw/harlan-agent-kit', checkout: '/repos/harlan-agent-kit', enabled: true, ownership: 'owned' }],
    ...overrides,
  }
}

function workflow(id: string): WorkflowDefinition {
  return {
    version: 1,
    id,
    name: id,
    on: [{ event: 'pull_request', actions: ['opened', 'synchronize'] }],
    tasks: [{ id: 'task', uses: 'example.task', with: {} }],
    concurrency: { mode: 'replace', group: 'target' },
    limits: { maxAttempts: 2, timeoutMs: 300_000, maxTokens: 100_000, maxCostUsd: null, maxDurationMs: 900_000 },
  }
}

function options() {
  const settings = parseKitServiceConfig(stringify(service()))
  if (settings._tag === 'Err')
    throw new Error(settings.error.message)
  return {
    settings: settings.value,
    repository: { id: 123, fullName: 'harlan-zw/harlan-agent-kit', installationId: 456 },
    stateDir: '/state/octorun-kit',
    provider: { baseUrl: 'http://127.0.0.1', model: 'claude-opus-5-5', apiKeyEnv: 'OCTORUN_KIT_PROVIDER_CREDENTIAL', timeoutMs: 120_000, maxInputCharacters: 200_000, maxResponseBytes: 2_097_152 },
    presets: { summary: workflow('change-summary'), review: workflow('adversarial-review') },
  }
}

describe('parseKitServiceConfig', () => {
  it('reads one eligible mapping from the existing Service configuration', () => {
    const parsed = parseKitServiceConfig(stringify(service({ unrelated: { token: 'do-not-propagate' } })))
    expect(parsed).toEqual({
      _tag: 'Ok',
      value: {
        github: { appId: 123, privateKeyPath: '/private/app.pem' },
        repository: { fullName: 'harlan-zw/harlan-agent-kit', checkout: '/repos/harlan-agent-kit' },
        storagePath: '/state/legacy/state.sqlite',
      },
    })
  })

  it.each([
    ['missing owner authority', { github: { app_id: 123, private_key_path: '/private/app.pem', allowed_owners: ['somebody-else'] } }],
    ['missing mapping', { repositories: [] }],
    ['disabled repository', { repositories: [{ ...service().repositories[0], enabled: false }] }],
    ['external repository', { repositories: [{ ...service().repositories[0], ownership: 'external' }] }],
    ['dedicated account', { repositories: [{ ...service().repositories[0], github_account: { login: 'somebody' } }] }],
    ['user authentication', { repositories: [{ ...service().repositories[0], authentication: 'user' }] }],
    ['duplicate mapping', { repositories: [...service().repositories, ...service().repositories] }],
    ['relative private key', { github: { app_id: 123, private_key_path: 'app.pem', allowed_owners: ['harlan-zw'] } }],
    ['invalid App identity', { github: { app_id: 0, private_key_path: '/private/app.pem', allowed_owners: ['harlan-zw'] } }],
    ['relative storage', { storage: { path: 'state.sqlite' } }],
  ])('rejects %s without copying secret values into errors', (_label, override) => {
    const parsed = parseKitServiceConfig(stringify(service({ ...override, secret: 'do-not-propagate' })))
    expect(parsed).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
    expect(JSON.stringify(parsed)).not.toContain('do-not-propagate')
  })

  it.each([
    ['duplicate keys', 'github: 1\ngithub: 2'],
    ['invalid YAML', 'github: ['],
    ['YAML aliases', 'github: &authority {}\nrepositories: *authority'],
    ['oversized input', ' '.repeat(1_048_577)],
  ])('rejects %s', (_label, input) => {
    expect(parseKitServiceConfig(input)).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
  })
})

describe('buildKitOctorunConfig', () => {
  it('keeps automatic summary events and requires explicit review selection', () => {
    const input = options()
    const built = buildKitOctorunConfig(input)
    if (built._tag === 'Err')
      throw new Error(built.error.message)
    const source = built.value.repositories[0]!.workflowSource
    if (source._tag !== 'Inline')
      throw new Error('Expected inline workflows')
    expect(source.definitions.find(workflow => workflow.id === 'change-summary')?.on)
      .toEqual(input.presets.summary.on)
    expect(source.definitions.find(workflow => workflow.id === 'adversarial-review')?.on).toEqual([])
    expect(input.presets.review.on).toEqual([{ event: 'pull_request', actions: ['opened', 'synchronize'] }])
    expect(built.value.repositories.map(repository => repository.fullName)).toEqual(['harlan-zw/harlan-agent-kit'])
    expect(built.value.github.privateKeyEnv).toBe('OCTORUN_KIT_GITHUB_PRIVATE_KEY')
  })

  it.each(['/state/legacy', '/state/legacy/new', '/state', '/', '/repos/harlan-agent-kit', '/repos'])('rejects overlapping state directory %s', (stateDir) => {
    expect(buildKitOctorunConfig({ ...options(), stateDir })).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
  })

  it.each([
    { id: 123, fullName: 'harlan-zw/another-repo', installationId: 456 },
    { id: 0, fullName: 'harlan-zw/harlan-agent-kit', installationId: 456 },
    { id: 123, fullName: 'harlan-zw/harlan-agent-kit', installationId: Number.NaN },
  ])('rejects an unbound GitHub identity', (repository) => {
    expect(buildKitOctorunConfig({ ...options(), repository })).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
  })
})
