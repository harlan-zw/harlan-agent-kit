import type { AgentProviderName } from './agent-provider.ts'
import type { Result } from './result.ts'
import type { PinnedAgentSelection } from './types.ts'
import { join } from 'node:path'
import { stringify } from 'yaml'
import { isAllowedRepository } from './repository-discovery.ts'
import { err, ok } from './result.ts'
import { WORKERS_AI_MODELS, WORKERS_AI_PROVIDER, workersAiBaseUrl } from './workers-ai.ts'

/**
 * Everything the Cloudflare Container hands the controller at start.
 *
 * On Hogwild these live in files a person wrote once. In the Container the
 * edge Worker holds them, from the GitHub App manifest flow and the setup
 * form, and passes them as environment variables. This module turns them back
 * into the files the controller already reads, so the controller keeps one
 * way of loading its inputs.
 */
export interface CloudflareRuntimeInputs {
  appId: number
  /** The slug of the App the setup page created. Its bot posts as `<slug>[bot]`. */
  appSlug: string
  privateKey: string
  webhookSecret: string
  dashboardPassword: string
  allowedOwners: string[]
  gitName: string
  gitEmail: string
  mutationsEnabled: boolean
  /**
   * The maintainer's own GitHub token, for the GitHub CLI login Hogwild has.
   * The controller reads that login for comment commands, fork workflow merges,
   * and pull request diagrams. Absent, those features report it instead.
   */
  githubUserToken: string | null
  /** Issues older than this date are left alone, so a first start does not work the whole backlog. */
  issueCutoff: string
  providers: ProviderCredentials
}

export interface ProviderCredentials {
  /** From `claude setup-token`. The Agent SDK reads it as `CLAUDE_CODE_OAUTH_TOKEN`. */
  claudeToken: string | null
  /** The whole `~/.codex/auth.json` after `codex login`. */
  codexAuth: string | null
  /** The GLM Coding Plan key opencode uses. */
  zaiApiKey: string | null
  /** A Cloudflare API token with Workers AI access, and the account it bills. opencode runs these models. */
  workersAi: { apiToken: string; accountId: string } | null
}

/** The variable names the edge Worker sets. Keep in step with `packages/wolfstar-github-edge`. */
export const RUNTIME_VARIABLES = {
  appId: 'WOLFSTAR_GITHUB_APP_ID',
  appSlug: 'WOLFSTAR_GITHUB_APP_SLUG',
  privateKey: 'WOLFSTAR_GITHUB_APP_PRIVATE_KEY',
  webhookSecret: 'WOLFSTAR_GITHUB_WEBHOOK_SECRET',
  dashboardPassword: 'WOLFSTAR_DASHBOARD_PASSWORD',
  allowedOwners: 'WOLFSTAR_ALLOWED_OWNERS',
  gitName: 'WOLFSTAR_GIT_NAME',
  gitEmail: 'WOLFSTAR_GIT_EMAIL',
  mutationsEnabled: 'WOLFSTAR_MUTATIONS_ENABLED',
  issueCutoff: 'WOLFSTAR_ISSUE_CUTOFF',
  claudeToken: 'CLAUDE_CODE_OAUTH_TOKEN',
  codexAuth: 'WOLFSTAR_CODEX_AUTH_JSON',
  zaiApiKey: 'WOLFSTAR_ZAI_API_KEY',
  workersAiToken: 'WOLFSTAR_WORKERS_AI_TOKEN',
  workersAiAccountId: 'WOLFSTAR_WORKERS_AI_ACCOUNT_ID',
  githubUserToken: 'WOLFSTAR_GITHUB_USER_TOKEN',
} as const

/**
 * The environment the controller starts with.
 *
 * Every Agent inherits the controller's environment and runs repository code,
 * so the App key, the webhook secret, the dashboard password, and the Codex
 * and opencode logins leave it. The controller reads them from the files this
 * Container writes. The Claude token stays, because the Agent SDK reads it
 * from the environment.
 */
export function controllerEnvironment(environment: Record<string, string | undefined>): Record<string, string> {
  const secrets = new Set<string>(
    Object.entries(RUNTIME_VARIABLES)
      .filter(([key]) => key !== 'claudeToken')
      .map(([, name]) => name),
  )
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !secrets.has(entry[0]),
    ),
  )
}

function optional(value: string | undefined): string | null {
  return value === undefined || value.trim() === '' ? null : value
}

export function readRuntimeInputs(
  environment: Record<string, string | undefined>,
): Result<CloudflareRuntimeInputs, string[]> {
  const issues: string[] = []
  const required = (name: string): string => {
    const value = optional(environment[name])
    if (value === null) issues.push(`${name} is not set.`)
    return value ?? ''
  }

  const appIdText = required(RUNTIME_VARIABLES.appId)
  const appId = Number(appIdText)
  if (appIdText !== '' && (!Number.isSafeInteger(appId) || appId <= 0))
    issues.push(`${RUNTIME_VARIABLES.appId} is not a positive integer.`)
  const appSlug = required(RUNTIME_VARIABLES.appSlug).toLowerCase()
  if (appSlug !== '' && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(appSlug))
    issues.push(`${RUNTIME_VARIABLES.appSlug} is not a GitHub App slug.`)
  const privateKey = required(RUNTIME_VARIABLES.privateKey)
  const webhookSecret = required(RUNTIME_VARIABLES.webhookSecret)
  const dashboardPassword = required(RUNTIME_VARIABLES.dashboardPassword)
  const allowedOwners = required(RUNTIME_VARIABLES.allowedOwners)
    .split(',')
    .map((owner) => owner.trim())
    .filter((owner) => owner !== '')
  const gitName = required(RUNTIME_VARIABLES.gitName)
  const gitEmail = required(RUNTIME_VARIABLES.gitEmail)
  const issueCutoff = required(RUNTIME_VARIABLES.issueCutoff)
  if (issueCutoff !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(issueCutoff))
    issues.push(`${RUNTIME_VARIABLES.issueCutoff} is not a YYYY-MM-DD date.`)

  const workersAiToken = optional(environment[RUNTIME_VARIABLES.workersAiToken])
  const workersAiAccountId = optional(environment[RUNTIME_VARIABLES.workersAiAccountId])
  if (workersAiToken !== null && (workersAiAccountId === null || workersAiBaseUrl(workersAiAccountId)._tag === 'Err'))
    issues.push(`${RUNTIME_VARIABLES.workersAiAccountId} must be the 32 character Cloudflare account ID.`)
  const providers: ProviderCredentials = {
    claudeToken: optional(environment[RUNTIME_VARIABLES.claudeToken]),
    codexAuth: optional(environment[RUNTIME_VARIABLES.codexAuth]),
    zaiApiKey: optional(environment[RUNTIME_VARIABLES.zaiApiKey]),
    workersAi:
      workersAiToken === null || workersAiAccountId === null
        ? null
        : { apiToken: workersAiToken, accountId: workersAiAccountId },
  }
  if (configuredProviders(providers).length === 0)
    issues.push('No Agent provider credential is set. Add one on the setup page.')

  if (issues.length > 0) return err(issues)
  return ok({
    appId,
    appSlug,
    privateKey,
    webhookSecret,
    dashboardPassword,
    allowedOwners,
    gitName,
    gitEmail,
    mutationsEnabled: environment[RUNTIME_VARIABLES.mutationsEnabled] === 'true',
    githubUserToken: optional(environment[RUNTIME_VARIABLES.githubUserToken]),
    issueCutoff,
    providers,
  })
}

/** The providers with a credential, in the order Automatic selection tries them. */
export function configuredProviders(providers: ProviderCredentials): AgentProviderName[] {
  return [
    ...(providers.claudeToken === null ? [] : ['claude' as const]),
    ...(providers.codexAuth === null ? [] : ['codex' as const]),
    // opencode serves both the GLM Coding Plan and Workers AI.
    ...(providers.zaiApiKey === null && providers.workersAi === null ? [] : ['opencode' as const]),
  ]
}

export interface RuntimePaths {
  home: string
  configDirectory: string
  config: string
  privateKey: string
  dashboardPassword: string
  webhookSecret: string
  storage: string
  /** The controller only trusts checkouts under these two roots. */
  checkoutRoot: string
  sitesRoot: string
  codexAuth: string
  opencodeConfig: string
  /** The sandboxed Agent home, outside every controller credential path. */
  workerHome: string
  workerProfile: string
  /** Where `scripts/agent-tools.ts` installs gh, codex, opencode, wt, rg, and fd. */
  toolsBin: string
  /** The host capacity command for a host with one account. See `wolfstar-host-capacity`. */
  hostCapacityCommand: string
}

export function runtimePaths(home: string, repositoryRoot: string = join(home, 'wolfstar-agent-kit')): RuntimePaths {
  const configDirectory = join(home, '.config', 'wolfstar-github-agent')
  return {
    home,
    configDirectory,
    config: join(configDirectory, 'config.yml'),
    privateKey: join(configDirectory, 'app.pem'),
    // The controller reads the password beside the configuration, under this fixed name.
    dashboardPassword: join(configDirectory, 'dashboard-password'),
    webhookSecret: join(configDirectory, 'webhook-secret'),
    storage: join(home, '.local', 'share', 'wolfstar-github-agent', 'state.sqlite'),
    checkoutRoot: join(home, 'pkg'),
    sitesRoot: join(home, 'sites'),
    codexAuth: join(home, '.codex', 'auth.json'),
    opencodeConfig: join(home, '.config', 'opencode', 'opencode.json'),
    workerHome: join(home, '.local', 'share', 'wolfstar-agent-kit', 'worker-home'),
    workerProfile: join(configDirectory, 'worker.json'),
    toolsBin: join(home, '.local', 'share', 'wolfstar-agent-kit', 'tools', 'bin'),
    hostCapacityCommand: join(repositoryRoot, 'packages/wolfstar-github-edge/container/wolfstar-host-capacity'),
  }
}

/** The dashboard origin the controller accepts. The edge Worker translates the public one to it. */
export const CONTAINER_DASHBOARD_ORIGIN = 'https://wolfstar-github-agent.localhost'

/**
 * The controller configuration for one Container.
 *
 * A standard-4 instance has 12 GiB. Four per Agent with two for the
 * controller suggests two Agents at once, where the Hogwild defaults would
 * suggest none.
 */
export function renderRuntimeConfig(inputs: CloudflareRuntimeInputs, paths: RuntimePaths): string {
  const providers = configuredProviders(inputs.providers)
  return stringify({
    agent: {
      provider: providers[0],
      order: providers,
      memory_per_agent_gib: 4,
      host_reserve_gib: 2,
    },
    github: {
      app_id: inputs.appId,
      app_slug: inputs.appSlug,
      private_key_path: paths.privateKey,
      allowed_owners: inputs.allowedOwners,
    },
    server: {
      host: '127.0.0.1',
      port: 3210,
      allowed_origin: CONTAINER_DASHBOARD_ORIGIN,
    },
    webhook: {
      enabled: true,
      port: 3211,
      secret_path: paths.webhookSecret,
    },
    storage: { path: paths.storage },
    triggers: ['github', 'routine'],
    mutations_enabled: inputs.mutationsEnabled,
    auto_merge: { enabled: false, minimum_confidence: 100, method: 'squash' },
    max_open_pull_requests: 8,
    issue_batches: true,
    // Webhooks arrive through the edge Queue, so polling only recovers what they missed.
    poll_interval_seconds: 300,
    issue_cutoff: inputs.issueCutoff,
    external_repositories: [],
    repositories: [],
  })
}

/**
 * The provider logins opencode reads, in the opencode v2 shape.
 *
 * The service reads the GLM Coding Plan key from here too, and worker
 * provisioning copies both entries into the sandboxed worker home.
 */
export function renderOpencodeConfig(
  existing: string | null,
  credentials: Pick<ProviderCredentials, 'zaiApiKey' | 'workersAi'>,
): string {
  let config: Record<string, unknown> = {}
  if (existing !== null) {
    try {
      const parsed: unknown = JSON.parse(existing)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
        config = parsed as Record<string, unknown>
    } catch {
      // A broken file is replaced. The Container owns it.
    }
  }
  const providers = { ...(isRecord(config.providers) ? config.providers : {}) }
  const withSettings = (id: string, settings: Record<string, string>): void => {
    const current = isRecord(providers[id]) ? providers[id] : {}
    const previous = isRecord(current.settings) ? current.settings : {}
    providers[id] = { ...current, settings: { ...previous, ...settings } }
  }
  if (credentials.zaiApiKey !== null) withSettings('zai-coding-plan', { apiKey: credentials.zaiApiKey })
  if (credentials.workersAi !== null) {
    const baseURL = workersAiBaseUrl(credentials.workersAi.accountId)
    if (baseURL._tag === 'Ok')
      withSettings(WORKERS_AI_PROVIDER, { apiKey: credentials.workersAi.apiToken, baseURL: baseURL.value })
  }
  return `${JSON.stringify({ ...config, providers }, null, 2)}\n`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The selection that makes Workers AI usable when it is the only route.
 *
 * Every opencode role defaults to a GLM Coding Plan model. With only Workers
 * AI configured those turns would fail, so the Container pins a Workers AI
 * model once, while the selection still follows the configuration.
 */
export function workersAiOnlySelection(providers: ProviderCredentials): PinnedAgentSelection | null {
  const onlyWorkersAi =
    providers.workersAi !== null &&
    providers.zaiApiKey === null &&
    providers.claudeToken === null &&
    providers.codexAuth === null
  return onlyWorkersAi ? { provider: 'opencode', model: WORKERS_AI_MODELS[0], reasoningEffort: null } : null
}

export interface InstallationRepository {
  fullName: string
  archived: boolean
  fork: boolean
}

/**
 * Where each repository is cloned, under `~/pkg`.
 *
 * The directory is the repository name. When two owners share a name, the
 * owner joins it, so neither clone hides the other.
 */
export function checkoutDirectories(
  repositories: readonly InstallationRepository[],
  allowedOwners: string[],
): Map<string, string> {
  const kept = repositories.filter(
    (repository) => !repository.archived && !repository.fork && isAllowedRepository(repository.fullName, allowedOwners),
  )
  const counts = new Map<string, number>()
  for (const repository of kept) {
    const name = repository.fullName.split('/')[1]!.toLowerCase()
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return new Map(
    kept
      .map((repository) => {
        const [owner, name] = repository.fullName.split('/') as [string, string]
        return [repository.fullName, (counts.get(name.toLowerCase()) ?? 0) > 1 ? `${owner}-${name}` : name] as const
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}
