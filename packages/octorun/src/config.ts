import type { Capability, RepositoryPolicy, RepositoryRef, Result, WorkflowDefinition } from './types.ts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { parseDocument, stringify } from 'yaml'
import { err, ok } from './types.ts'
import { parseWorkflow } from './workflow.ts'

export type PresetName = 'adversarial-review' | 'change-summary'
export type WorkflowSource
  = | { _tag: 'Presets', presets: PresetName[] }
    | { _tag: 'Inline', definitions: WorkflowDefinition[] }
    | { _tag: 'Repository', path: string }

export interface ConfiguredRepository extends RepositoryRef {
  policy: RepositoryPolicy
  workflowSource: WorkflowSource
}

export interface OperatorConfig {
  version: 1
  stateDir: string
  host: string
  port: number
  handle: string
  github: { appId: string, privateKeyEnv: string, webhookSecretEnv: string, apiUrl: string }
  provider: { baseUrl: string, model: string, apiKeyEnv: string, timeoutMs: number, maxResponseBytes: number, maxInputCharacters: number }
  repositories: ConfiguredRepository[]
  pollIntervalMs: number
  limits: { bodyBytes: number, requestsPerMinute: number, concurrency: number }
}

export interface ConfigContext {
  configDir: string
  env?: NodeJS.ProcessEnv
  home?: string
}

export interface SecretValues {
  privateKey: string
  webhookSecret: string | null
  apiKey: string
}

const defaultCapabilities: Capability[] = ['repository:read', 'agent:invoke', 'github:comment', 'github:review', 'github:check']
const allowedCapabilities = new Set(defaultCapabilities)
const invalid = (message: string): Result<never> => err({ _tag: 'Configuration', message })
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 2048
const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const envName = (value: unknown): value is string => typeof value === 'string' && /^[A-Z_][A-Z0-9_]{0,127}$/.test(value)
const keys = (input: Record<string, unknown>, allowed: string[]): string | undefined => Object.keys(input).find(key => !allowed.includes(key))
const parseUrl = (value: unknown): URL | null => typeof value === 'string' ? URL.parse(value) : null

export function resolvePaths(options: { env?: NodeJS.ProcessEnv, home?: string } = {}): { configPath: string, stateDir: string } {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config')
  const stateHome = env.XDG_STATE_HOME || join(home, '.local', 'state')
  if (!isAbsolute(home) || !isAbsolute(configHome) || !isAbsolute(stateHome))
    throw new Error('Home and XDG paths must be absolute.')
  return { configPath: join(configHome, 'octorun', 'config.yaml'), stateDir: join(stateHome, 'octorun') }
}

function parseSource(value: unknown): Result<WorkflowSource> {
  if (value === undefined)
    return ok({ _tag: 'Presets', presets: ['adversarial-review'] })
  if (!record(value))
    return invalid('workflowSource must select Presets, Inline, or Repository.')
  if (value._tag === 'Presets') {
    const unknown = keys(value, ['_tag', 'presets'])
    if (unknown || !Array.isArray(value.presets) || value.presets.length < 1 || value.presets.some(item => !['adversarial-review', 'change-summary'].includes(item)))
      return invalid('workflowSource.presets must contain supported presets.')
    return ok({ _tag: 'Presets', presets: [...new Set(value.presets)] as PresetName[] })
  }
  if (value._tag === 'Repository') {
    if (keys(value, ['_tag', 'path']) || !text(value.path) || !/^\.github\/[\w./-]+\.ya?ml$/.test(value.path) || value.path.split('/').some(part => part === '..' || part === '.'))
      return invalid('workflowSource.path must name a YAML file inside .github/.')
    return ok({ _tag: 'Repository', path: value.path })
  }
  if (value._tag === 'Inline') {
    if (keys(value, ['_tag', 'definitions']) || !Array.isArray(value.definitions) || value.definitions.length < 1 || value.definitions.length > 100)
      return invalid('workflowSource.definitions must contain one to 100 workflows.')
    const definitions: WorkflowDefinition[] = []
    for (const definition of value.definitions) {
      const parsed = parseWorkflow(definition)
      if (parsed._tag === 'Err')
        return parsed
      if (definitions.some(item => item.id === parsed.value.id))
        return invalid('workflowSource.definitions contains a duplicate workflow ID.')
      definitions.push(parsed.value)
    }
    return ok({ _tag: 'Inline', definitions })
  }
  return invalid('workflowSource must select Presets, Inline, or Repository.')
}

function parseRepository(value: unknown): Result<ConfiguredRepository> {
  if (!record(value))
    return invalid('Each repositories entry must be an object.')
  const unknown = keys(value, ['id', 'installationId', 'fullName', 'policy', 'workflowSource'])
  if (unknown)
    return invalid(`Unknown repository setting: ${unknown}.`)
  if (!integer(value.id, 1, Number.MAX_SAFE_INTEGER) || !integer(value.installationId, 1, Number.MAX_SAFE_INTEGER))
    return invalid('Repository id and installationId must be positive integers.')
  if (!text(value.fullName) || !/^[\w.-]+\/[\w.-]+$/.test(value.fullName) || value.fullName.split('/').some(part => part === '.' || part === '..'))
    return invalid('Repository fullName must use owner/repository.')
  const policy = value.policy ?? { enabled: true, capabilities: defaultCapabilities, maxConcurrency: 1 }
  if (!record(policy) || keys(policy, ['enabled', 'capabilities', 'maxConcurrency']) || typeof policy.enabled !== 'boolean' || !integer(policy.maxConcurrency, 1, 100))
    return invalid('Repository policy needs enabled, capabilities, and maxConcurrency.')
  if (!Array.isArray(policy.capabilities) || policy.capabilities.some(item => typeof item !== 'string' || !allowedCapabilities.has(item as Capability)))
    return invalid('Repository policy capabilities support read, agent, comment, review, and check operations only.')
  const source = parseSource(value.workflowSource)
  if (source._tag === 'Err')
    return source
  return ok({
    id: value.id,
    installationId: value.installationId,
    fullName: value.fullName,
    policy: { enabled: policy.enabled, capabilities: [...new Set(policy.capabilities)] as Capability[], maxConcurrency: policy.maxConcurrency },
    workflowSource: source.value,
  })
}

export function parseConfig(input: unknown, context: ConfigContext): Result<OperatorConfig> {
  if (!record(input))
    return invalid('Configuration must be an object.')
  const unknown = keys(input, ['version', 'stateDir', 'host', 'port', 'handle', 'github', 'provider', 'repositories', 'pollIntervalMs', 'limits'])
  if (unknown)
    return invalid(`Unknown configuration setting: ${unknown}.`)
  if (input.version !== 1)
    return invalid('Configuration version must be 1.')
  const github = input.github
  if (!record(github))
    return invalid('github must define the App ID and secret environment names.')
  const githubUnknown = keys(github, ['appId', 'privateKeyEnv', 'webhookSecretEnv', 'apiUrl'])
  if (githubUnknown)
    return invalid(`Unknown github setting: ${githubUnknown}. Store secrets in environment variables.`)
  if (!text(github.appId) || !/^\d+$/.test(github.appId) || !integer(Number(github.appId), 1, Number.MAX_SAFE_INTEGER))
    return invalid('github.appId must be a positive safe integer written as a string.')
  if (!envName(github.privateKeyEnv) || !envName(github.webhookSecretEnv))
    return invalid('github secret references must name environment variables.')
  const apiUrl = github.apiUrl ?? 'https://api.github.com'
  const parsedApi = parseUrl(apiUrl)
  if (!parsedApi || parsedApi.protocol !== 'https:' || parsedApi.username || parsedApi.password || parsedApi.search || parsedApi.hash)
    return invalid('github.apiUrl must use HTTPS without credentials or query parameters.')
  const provider = input.provider
  if (!record(provider))
    return invalid('provider must define baseUrl, model, and apiKeyEnv.')
  const providerUnknown = keys(provider, ['baseUrl', 'model', 'apiKeyEnv', 'timeoutMs', 'maxResponseBytes', 'maxInputCharacters'])
  if (providerUnknown)
    return invalid(`Unknown provider setting: ${providerUnknown}. Store secrets in environment variables.`)
  const baseUrl = parseUrl(provider.baseUrl)
  if (!baseUrl || (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname))) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash)
    return invalid('provider.baseUrl must use HTTPS, or HTTP on localhost, without credentials or query parameters.')
  if (!text(provider.model) || !provider.model.trim() || provider.model.length > 200 || !envName(provider.apiKeyEnv))
    return invalid('provider needs a model and an apiKeyEnv environment reference.')
  const timeoutMs = provider.timeoutMs ?? 120000
  const maxResponseBytes = provider.maxResponseBytes ?? 2097152
  const maxInputCharacters = provider.maxInputCharacters ?? 200000
  if (!integer(timeoutMs, 100, 900000) || !integer(maxResponseBytes, 1024, 4194304) || !integer(maxInputCharacters, 1024, 1048576))
    return invalid('Provider limits exceed the supported timeout or response bounds.')
  const host = input.host ?? '127.0.0.1'
  const port = input.port ?? 3333
  const handle = input.handle ?? 'octorun'
  const pollIntervalMs = input.pollIntervalMs ?? 60000
  if (!text(host) || /[\s/\\]/.test(host) || !integer(port, 0, 65535))
    return invalid('host and port must identify a valid HTTP address.')
  if (!text(handle) || !/^[\w-]{1,100}$/.test(handle))
    return invalid('handle must contain letters, digits, underscores, or hyphens.')
  if (!integer(pollIntervalMs, 0, 86400000) || (pollIntervalMs > 0 && pollIntervalMs < 1000))
    return invalid('pollIntervalMs must be zero or at least 1000 milliseconds.')
  const limits = input.limits ?? {}
  if (!record(limits) || keys(limits, ['bodyBytes', 'requestsPerMinute', 'concurrency']))
    return invalid('limits supports bodyBytes, requestsPerMinute, and concurrency.')
  const bodyBytes = limits.bodyBytes ?? 2097152
  const requestsPerMinute = limits.requestsPerMinute ?? 300
  const concurrency = limits.concurrency ?? 2
  if (!integer(bodyBytes, 1024, 26214400) || !integer(requestsPerMinute, 1, 100000) || !integer(concurrency, 1, 100))
    return invalid('Request and concurrency limits exceed supported bounds.')
  if (!Array.isArray(input.repositories) || input.repositories.length < 1 || input.repositories.length > 10000)
    return invalid('repositories must contain one to 10000 explicit App repository mappings.')
  const repositories: ConfiguredRepository[] = []
  for (const value of input.repositories) {
    const repository = parseRepository(value)
    if (repository._tag === 'Err')
      return repository
    if (repositories.some(item => item.id === repository.value.id || item.fullName.toLowerCase() === repository.value.fullName.toLowerCase()))
      return invalid('repositories contains a duplicate ID or fullName.')
    repositories.push(repository.value)
  }
  if (input.stateDir !== undefined && !text(input.stateDir))
    return invalid('stateDir must be an absolute or configuration-relative path.')
  const stateDir = input.stateDir === undefined
    ? resolvePaths({ env: context.env ?? process.env, home: context.home ?? homedir() }).stateDir
    : resolve(context.configDir, input.stateDir)
  if (stateDir === parse(stateDir).root || stateDir === (context.home ?? homedir()))
    return invalid('stateDir must use a dedicated directory beneath the root or home directory.')
  return ok({
    version: 1,
    stateDir,
    host,
    port,
    handle,
    github: { appId: github.appId, privateKeyEnv: github.privateKeyEnv, webhookSecretEnv: github.webhookSecretEnv, apiUrl: parsedApi.href.replace(/\/$/, '') },
    provider: { baseUrl: baseUrl.href.replace(/\/$/, ''), model: provider.model, apiKeyEnv: provider.apiKeyEnv, timeoutMs, maxResponseBytes, maxInputCharacters },
    repositories,
    pollIntervalMs,
    limits: { bodyBytes, requestsPerMinute, concurrency },
  })
}

export async function readConfig(options: { path?: string, env?: NodeJS.ProcessEnv, home?: string } = {}): Promise<Result<OperatorConfig>> {
  const path = options.path ?? resolvePaths(options).configPath
  const contents = await readFile(path, 'utf8').then(ok).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return invalid('Configuration was not found. Run octorun init with your App and repository IDs.')
    throw error
  })
  if (contents._tag === 'Err')
    return contents
  if (Buffer.byteLength(contents.value) > 1048576)
    return invalid('Configuration exceeds the one MiB limit.')
  const document = parseDocument(contents.value, { strict: true, uniqueKeys: true })
  if (document.errors.length > 0)
    return invalid('Configuration contains invalid YAML or duplicate keys. Check the file syntax.')
  const value = await Promise.resolve().then(() => ok(document.toJS({ maxAliasCount: 0 }) as unknown)).catch(() => invalid('Configuration cannot use YAML aliases. Replace aliases with explicit values.'))
  if (value._tag === 'Err')
    return value
  return parseConfig(value.value, { configDir: dirname(resolve(path)), env: options.env ?? process.env, home: options.home ?? homedir() })
}

export function resolveSecrets(config: OperatorConfig, env: NodeJS.ProcessEnv = process.env, options: { requireWebhook?: boolean } = {}): Result<SecretValues> {
  const references = [config.github.privateKeyEnv, config.provider.apiKeyEnv]
  if (options.requireWebhook)
    references.push(config.github.webhookSecretEnv)
  for (const name of references) {
    if (!env[name]?.trim())
      return invalid(`Set ${name} before starting Octorun.`)
  }
  const webhookSecret = env[config.github.webhookSecretEnv]?.trim() || null
  if (webhookSecret !== null && webhookSecret.length < 16)
    return invalid(`Set ${config.github.webhookSecretEnv} to at least 16 characters.`)
  return ok({ privateKey: env[config.github.privateKeyEnv]!, apiKey: env[config.provider.apiKeyEnv]!, webhookSecret })
}

export async function initConfig(options: { path: string, repository: string, repositoryId: number, installationId: number, appId: string, model: string, baseUrl?: string }): Promise<Result<{ path: string }>> {
  const raw = {
    version: 1,
    github: { appId: options.appId, privateKeyEnv: 'OCTORUN_GITHUB_PRIVATE_KEY', webhookSecretEnv: 'OCTORUN_WEBHOOK_SECRET' },
    provider: { baseUrl: options.baseUrl ?? 'https://api.openai.com/v1', model: options.model, apiKeyEnv: 'OCTORUN_API_KEY' },
    repositories: [{ id: options.repositoryId, fullName: options.repository, installationId: options.installationId }],
  }
  const parsed = parseConfig(raw, { configDir: dirname(resolve(options.path)) })
  if (parsed._tag === 'Err')
    return parsed
  await mkdir(dirname(resolve(options.path)), { recursive: true, mode: 0o700 })
  return writeFile(options.path, stringify(raw), { mode: 0o600, flag: 'wx' }).then(() => ok({ path: resolve(options.path) })).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST')
      return invalid('Configuration already exists. Choose another --output path.')
    throw error
  })
}
