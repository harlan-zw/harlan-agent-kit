import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initConfig, parseConfig, readConfig, resolvePaths, resolveSecrets } from '../src/config.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
function input() {
  return {
    version: 1,
    github: { appId: '123', privateKeyEnv: 'APP_KEY', webhookSecretEnv: 'HOOK_KEY' },
    provider: { baseUrl: 'https://example.test/v1', model: 'review-model', apiKeyEnv: 'MODEL_KEY' },
    repositories: [{ id: 7, fullName: 'team/example', installationId: 8 }],
  }
}
const context = { configDir: '/tmp/octorun-config', home: '/tmp/octorun-home', env: {} }

it('uses explicit XDG locations without depending on the current directory', () => {
  expect(resolvePaths({ home: '/home/operator', env: { XDG_CONFIG_HOME: '/cfg', XDG_STATE_HOME: '/state' } }))
    .toEqual({ configPath: '/cfg/octorun/config.yaml', stateDir: '/state/octorun' })
})

it('rejects relative XDG paths', () => {
  expect(() => resolvePaths({ home: '/home/operator', env: { XDG_STATE_HOME: './state' } })).toThrow('absolute')
})

it.each([
  [{ ...input(), version: 2 }, 'version'],
  [{ ...input(), github: { ...input().github, appId: '0' } }, 'appId'],
  [{ ...input(), github: { ...input().github, appId: '9007199254740992' } }, 'appId'],
  [{ ...input(), repositories: [] }, 'repositories'],
  [{ ...input(), repositories: [{ id: 7, fullName: '../example', installationId: 8 }] }, 'fullName'],
  [{ ...input(), repositories: [{ ...input().repositories[0], defaultBranch: 'untrusted-override' }] }, 'defaultBranch'],
  [{ ...input(), repositories: [{ id: 7, fullName: 'team/example', installationId: 8 }, { id: 7, fullName: 'team/example', installationId: 8 }] }, 'duplicate'],
  [{ ...input(), provider: { ...input().provider, apiKey: 'must-never-be-stored' } }, 'apiKey'],
  [{ ...input(), provider: { ...input().provider, baseUrl: 'http://example.test/v1' } }, 'HTTPS'],
  [{ ...input(), provider: { ...input().provider, maxResponseBytes: 8388608 } }, 'limits'],
  [{ ...input(), provider: { ...input().provider, maxInputCharacters: 1500000 } }, 'limits'],
  [{ ...input(), provider: { ...input().provider, model: 'm'.repeat(201) } }, 'model'],
  [{ ...input(), provider: { ...input().provider, model: '   ' } }, 'model'],
  [{ ...input(), repositories: [{ ...input().repositories[0], workflowSource: { _tag: 'Repository', path: '../workflow.yml' } }] }, 'path'],
  [{ ...input(), repositories: [{ ...input().repositories[0], policy: { enabled: true, maxConcurrency: 1, capabilities: ['repository:write'] } }] }, 'capabilities'],
])('rejects unsafe operator configuration: %s', (value, message) => {
  const result = parseConfig(value, context)
  expect(result._tag).toBe('Err')
  if (result._tag === 'Err')
    expect(result.error.message).toContain(message)
})

it('resolves relative state paths beside the configuration file', () => {
  const result = parseConfig({ ...input(), stateDir: './state' }, context)
  expect(result._tag).toBe('Ok')
  if (result._tag === 'Ok')
    expect(result.value.stateDir).toBe('/tmp/octorun-config/state')
})

it('resolves referenced secrets without returning secret values in errors', () => {
  const parsed = parseConfig(input(), context)
  if (parsed._tag === 'Err')
    throw new Error(parsed.error.message)
  const missing = resolveSecrets(parsed.value, { APP_KEY: 'PRIVATE-SECRET', HOOK_KEY: '123' })
  expect(missing).toEqual({ _tag: 'Err', error: { _tag: 'Configuration', message: 'Set MODEL_KEY before starting Octorun.' } })
  const found = resolveSecrets(parsed.value, { APP_KEY: 'PRIVATE-SECRET', HOOK_KEY: 'a-long-webhook-secret-for-tests-only', MODEL_KEY: 'API-SECRET' })
  expect(found).toEqual({ _tag: 'Ok', value: { privateKey: 'PRIVATE-SECRET', webhookSecret: 'a-long-webhook-secret-for-tests-only', apiKey: 'API-SECRET' } })
})

it('creates a private config without secrets and refuses to replace it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octorun-config-'))
  roots.push(root)
  const path = join(root, 'nested', 'config.yaml')
  const result = await initConfig({ path, repository: 'team/example', repositoryId: 7, installationId: 8, appId: '123', model: 'review-model' })
  expect(result._tag).toBe('Ok')
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  const loaded = await readConfig({ path, env: {}, home: root })
  expect(loaded._tag).toBe('Ok')
  const text = await readFile(path, 'utf8')
  expect(text).toContain('OCTORUN_GITHUB_PRIVATE_KEY')
  const again = await initConfig({ path, repository: 'team/other', repositoryId: 9, installationId: 8, appId: '123', model: 'other-model' })
  expect(again._tag).toBe('Err')
  expect(await readFile(path, 'utf8')).toBe(text)
})

describe('workflow source', () => {
  it('accepts a trusted repository workflow path without executing repository code', () => {
    const result = parseConfig({ ...input(), repositories: [{ ...input().repositories[0], workflowSource: { _tag: 'Repository', path: '.github/octorun.yaml' } }] }, context)
    expect(result._tag).toBe('Ok')
    if (result._tag === 'Ok')
      expect(result.value.repositories[0]?.workflowSource).toEqual({ _tag: 'Repository', path: '.github/octorun.yaml' })
  })
})

it('returns a configuration error for YAML aliases without exposing document values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octorun-alias-'))
  roots.push(root)
  const path = join(root, 'config.yaml')
  await writeFile(path, 'value: &secret NEVER-PRINT-THIS\ncopy: *secret\n')
  const result = await readConfig({ path, env: {}, home: root })
  expect(result._tag).toBe('Err')
  expect(JSON.stringify(result)).not.toContain('NEVER-PRINT-THIS')
})
