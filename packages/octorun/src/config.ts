import type { OperatorConfig, RepositoryRef, Result, WorkflowDefinition } from '@harlan-zw/octorun'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { parseDocument } from 'yaml'

export const KIT_REPOSITORY = 'harlan-zw/harlan-agent-kit'
export const KIT_PRIVATE_KEY_ENV = 'OCTORUN_KIT_GITHUB_PRIVATE_KEY'
export const KIT_WEBHOOK_ENV = 'OCTORUN_KIT_WEBHOOK_SECRET'

export interface KitServiceSettings {
  github: { appId: number, privateKeyPath: string }
  repository: { fullName: string, checkout: string, trustedAuthors: string[] }
  storagePath: string
}

export interface KitOctorunOptions {
  settings: KitServiceSettings
  repository: RepositoryRef
  stateDir: string
  provider: OperatorConfig['provider']
  presets: { summary: WorkflowDefinition, review: WorkflowDefinition }
}

const object = (input: unknown): input is Record<string, unknown> => input !== null && typeof input === 'object' && !Array.isArray(input)
const id = (input: unknown): input is number => typeof input === 'number' && Number.isSafeInteger(input) && input > 0
const absolutePath = (input: unknown): input is string => typeof input === 'string' && input.length <= 4096 && !/[\r\n\0]/.test(input) && isAbsolute(input)
const invalid = (message: string): Result<never> => ({ _tag: 'Err', error: { _tag: 'Configuration', message } })
function within(parent: string, path: string): boolean {
  const child = relative(parent, path)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}

/** Read existing authority without copying unrelated settings or credentials. */
export function parseKitServiceConfig(text: string): Result<KitServiceSettings> {
  if (Buffer.byteLength(text) > 1_048_576)
    return invalid('The Service configuration exceeds one MiB.')
  const document = parseDocument(text, { strict: true, uniqueKeys: true })
  if (document.errors.length > 0)
    return invalid('The Service configuration contains invalid YAML or duplicate keys.')
  let input: unknown
  try {
    input = document.toJS({ maxAliasCount: 0 }) as unknown
  }
  catch {
    return invalid('The Service configuration cannot use YAML aliases.')
  }
  if (!object(input) || !object(input.github) || !id(input.github.app_id) || !absolutePath(input.github.private_key_path))
    return invalid('The Service configuration requires an App ID and absolute private key path.')
  const allowed = Array.isArray(input.github.allowed_owners) && input.github.allowed_owners.every(owner => typeof owner === 'string')
    ? input.github.allowed_owners.map(owner => (owner as string).trim().toLowerCase())
    : []
  if (allowed.length === 0 || allowed.some(owner => !/^[\w-]+(?:\/[\w.-]+)?$/.test(owner))
    || new Set(allowed).size !== allowed.length
    || !allowed.some(owner => owner === 'harlan-zw' || owner === KIT_REPOSITORY)) {
    return invalid('The Service configuration must explicitly allow Harlan Agent Kit through valid, unique owner or repository entries.')
  }
  if (!object(input.storage) || !absolutePath(input.storage.path))
    return invalid('The Service configuration requires an absolute database path.')
  if (!Array.isArray(input.repositories))
    return invalid('The Service configuration requires an explicit Harlan Agent Kit repository mapping.')
  const mappings = input.repositories.filter((mapping): mapping is Record<string, unknown> => object(mapping)
    && typeof mapping.github === 'string' && mapping.github.toLowerCase() === KIT_REPOSITORY)
  if (mappings.length !== 1)
    return invalid('The Service configuration requires exactly one Harlan Agent Kit repository mapping.')
  const mapping = mappings[0]!
  if (mapping.enabled !== true || mapping.ownership !== 'owned' || !absolutePath(mapping.checkout))
    return invalid('The Harlan Agent Kit repository must be enabled, owned, and mapped to an absolute checkout.')
  if (mapping.github_account !== undefined || (mapping.authentication !== undefined && mapping.authentication !== 'app'))
    return invalid('The Harlan Agent Kit repository must use the configured GitHub App.')
  if (!Array.isArray(mapping.writable_pr_authors) || !mapping.writable_pr_authors.every(author => typeof author === 'string' && author.trim().length > 0))
    return invalid('The Harlan Agent Kit repository requires its Service list of trusted pull request authors.')
  return {
    _tag: 'Ok',
    value: {
      github: { appId: input.github.app_id, privateKeyPath: resolve(input.github.private_key_path) },
      repository: { fullName: KIT_REPOSITORY, checkout: resolve(mapping.checkout), trustedAuthors: mapping.writable_pr_authors.map(author => (author as string).trim()) },
      storagePath: resolve(input.storage.path),
    },
  }
}

/** Keep summaries automatic and preserve the existing Service's review ownership. */
export function buildKitOctorunConfig(options: KitOctorunOptions): Result<OperatorConfig> {
  const { settings, repository } = options
  if (repository.fullName.toLowerCase() !== KIT_REPOSITORY || settings.repository.fullName !== KIT_REPOSITORY
    || !id(repository.id) || !id(repository.installationId)) {
    return invalid('The GitHub installation must identify the configured Harlan Agent Kit repository.')
  }
  if (!absolutePath(options.stateDir))
    return invalid('Octorun requires an absolute state directory.')
  const stateDir = resolve(options.stateDir)
  const legacyDirectory = dirname(settings.storagePath)
  if (within(legacyDirectory, stateDir) || within(stateDir, legacyDirectory)
    || within(settings.repository.checkout, stateDir) || within(stateDir, settings.repository.checkout)) {
    return invalid('Octorun state must remain separate from the existing Service database and repository checkout.')
  }
  if (options.presets.summary.id !== 'change-summary' || options.presets.review.id !== 'adversarial-review')
    return invalid('Octorun requires the change summary and adversarial review presets.')
  return {
    _tag: 'Ok',
    value: {
      version: 1,
      stateDir,
      host: '127.0.0.1',
      port: 3334,
      handle: 'octorun',
      github: {
        appId: String(settings.github.appId),
        privateKeyEnv: KIT_PRIVATE_KEY_ENV,
        webhookSecretEnv: KIT_WEBHOOK_ENV,
        apiUrl: 'https://api.github.com',
      },
      provider: { ...options.provider },
      repositories: [{
        ...repository,
        fullName: KIT_REPOSITORY,
        policy: { enabled: true, capabilities: ['repository:read', 'agent:invoke', 'github:comment', 'github:review', 'github:check'], maxConcurrency: 1 },
        workflowSource: {
          _tag: 'Inline',
          definitions: [options.presets.summary, { ...options.presets.review, on: [] }],
        },
      }],
      pollIntervalMs: 60_000,
      limits: { bodyBytes: 2_097_152, requestsPerMinute: 300, concurrency: 1 },
    },
  }
}
