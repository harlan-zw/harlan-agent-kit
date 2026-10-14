import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RUNTIME_VARIABLES,
  checkoutDirectories,
  controllerEnvironment,
  readRuntimeInputs,
  renderOpencodeConfig,
  renderRuntimeConfig,
  runtimePaths,
} from '../src/cloudflare-runtime.ts'
import { parseConfigText } from '../src/config.ts'

const environment = {
  [RUNTIME_VARIABLES.appId]: '123456',
  [RUNTIME_VARIABLES.privateKey]: '-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----\n',
  [RUNTIME_VARIABLES.webhookSecret]: 'w'.repeat(40),
  [RUNTIME_VARIABLES.dashboardPassword]: 'p'.repeat(43),
  [RUNTIME_VARIABLES.allowedOwners]: 'wolfstar-project, someone/one-repo',
  [RUNTIME_VARIABLES.gitName]: 'wolfstar-agent[bot]',
  [RUNTIME_VARIABLES.gitEmail]: '1+wolfstar-agent[bot]@users.noreply.github.com',
  [RUNTIME_VARIABLES.mutationsEnabled]: 'true',
  [RUNTIME_VARIABLES.issueCutoff]: '2026-09-14',
  [RUNTIME_VARIABLES.claudeToken]: 'sk-ant-oat01-token',
}

describe('Cloudflare runtime inputs', () => {
  it('reads every input the edge Worker sets', () => {
    const inputs = readRuntimeInputs(environment)

    expect(inputs).toMatchObject({
      _tag: 'Ok',
      value: {
        appId: 123456,
        allowedOwners: ['wolfstar-project', 'someone/one-repo'],
        mutationsEnabled: true,
        providers: { claudeToken: 'sk-ant-oat01-token', codexAuth: null, zaiApiKey: null },
      },
    })
  })

  it('names every missing input at once', () => {
    const inputs = readRuntimeInputs({ [RUNTIME_VARIABLES.appId]: 'abc' })

    expect(inputs._tag).toBe('Err')
    if (inputs._tag !== 'Err') return
    expect(inputs.error).toContain(`${RUNTIME_VARIABLES.appId} is not a positive integer.`)
    expect(inputs.error).toContain(`${RUNTIME_VARIABLES.privateKey} is not set.`)
    expect(inputs.error).toContain('No Agent provider credential is set. Add one on the setup page.')
  })

  it('keeps writes off unless the setup turned them on', () => {
    const inputs = readRuntimeInputs({ ...environment, [RUNTIME_VARIABLES.mutationsEnabled]: '' })

    expect(inputs._tag === 'Ok' && inputs.value.mutationsEnabled).toBe(false)
  })
})

describe('Cloudflare runtime configuration', () => {
  it('renders a configuration the controller accepts', () => {
    const inputs = readRuntimeInputs({
      ...environment,
      [RUNTIME_VARIABLES.codexAuth]: '{}',
      [RUNTIME_VARIABLES.zaiApiKey]: 'zai-key',
    })
    if (inputs._tag !== 'Ok') throw new Error(inputs.error.join('\n'))
    const paths = runtimePaths(homedir())

    const parsed = parseConfigText(renderRuntimeConfig(inputs.value, paths))

    if (parsed._tag !== 'Ok') throw new Error(JSON.stringify(parsed.error))
    expect(parsed.value.agent).toMatchObject({
      provider: 'claude',
      order: ['claude', 'codex', 'opencode'],
      memoryPerAgentGiB: 4,
      hostReserveGiB: 2,
    })
    expect(parsed.value.github.privateKeyPath).toBe(join(homedir(), '.config/wolfstar-github-agent/app.pem'))
    expect(parsed.value.webhook).toEqual({
      _tag: 'Enabled',
      host: '127.0.0.1',
      port: 3211,
      secretPath: join(homedir(), '.config/wolfstar-github-agent/webhook-secret'),
    })
    expect(parsed.value.mutationsEnabled).toBe(true)
  })

  it('starts with the only configured provider', () => {
    const inputs = readRuntimeInputs({
      ...environment,
      [RUNTIME_VARIABLES.claudeToken]: '',
      [RUNTIME_VARIABLES.zaiApiKey]: 'zai-key',
    })
    if (inputs._tag !== 'Ok') throw new Error(inputs.error.join('\n'))

    const parsed = parseConfigText(renderRuntimeConfig(inputs.value, runtimePaths(homedir())))

    expect(parsed._tag === 'Ok' && parsed.value.agent.provider).toBe('opencode')
  })
})

describe('opencode configuration', () => {
  it('sets the GLM Coding Plan key and keeps everything else', () => {
    const existing = JSON.stringify({ theme: 'dark', provider: { other: { options: { apiKey: 'x' } } } })

    expect(JSON.parse(renderOpencodeConfig(existing, 'zai-key'))).toEqual({
      theme: 'dark',
      provider: { other: { options: { apiKey: 'x' } }, 'zai-coding-plan': { options: { apiKey: 'zai-key' } } },
    })
  })

  it('replaces a file that is not JSON', () => {
    expect(JSON.parse(renderOpencodeConfig('{', 'zai-key'))).toEqual({
      provider: { 'zai-coding-plan': { options: { apiKey: 'zai-key' } } },
    })
  })
})

describe('checkout directories', () => {
  it('clones allowed, live repositories under their name, and joins the owner when names collide', () => {
    const directories = checkoutDirectories(
      [
        { fullName: 'wolfstar-project/plugins', archived: false, fork: false },
        { fullName: 'wolfstar-project/old', archived: true, fork: false },
        { fullName: 'wolfstar-project/forked', archived: false, fork: true },
        { fullName: 'wolfstar-project/site', archived: false, fork: false },
        { fullName: 'someone/site', archived: false, fork: false },
        { fullName: 'someone/other', archived: false, fork: false },
      ],
      ['wolfstar-project', 'someone/site'],
    )

    expect([...directories]).toEqual([
      ['someone/site', 'someone-site'],
      ['wolfstar-project/plugins', 'plugins'],
      ['wolfstar-project/site', 'wolfstar-project-site'],
    ])
  })
})

describe('controller environment', () => {
  it('keeps every secret but the Claude token away from the Agents', () => {
    const forwarded = controllerEnvironment({
      ...environment,
      [RUNTIME_VARIABLES.codexAuth]: '{}',
      [RUNTIME_VARIABLES.zaiApiKey]: 'zai-key',
      PATH: '/usr/bin',
      HOME: '/home/node',
    })

    expect(forwarded).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-token',
      PATH: '/usr/bin',
      HOME: '/home/node',
    })
  })
})
