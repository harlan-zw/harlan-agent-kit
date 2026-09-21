import type { ConfigIssue } from './config.ts'
import type { GitIdentity } from './git-identity.ts'
import type { Result } from './result.ts'
import type { ValidatedAgentConfig } from './types.ts'
import { dirname, join } from 'node:path'
import { loadClassificationToken, loadConfig, loadGitHubAppPrivateKey, loadWebhookSecret, validateRepositoryMappings } from './config.ts'
import { loadDashboardPassword } from './dashboard-password.ts'
import { loadGitIdentity } from './git-identity.ts'
import { err, ok } from './result.ts'

/**
 * Everything the service needs before it binds a port: the parsed
 * configuration and every secret it names.
 *
 * A deploy reads the same inputs with the new revision before it asks the
 * running one to restart. A config the new revision rejects, such as a key
 * naming an Agent role that revision retired, then fails the deploy while the
 * old revision keeps serving. Without that read the failure lands in the
 * restart itself, where systemd retries a process that can never start.
 */
export interface ServiceInputs {
  config: ValidatedAgentConfig
  githubPrivateKey: string
  dashboardPassword: string
  webhookSecret: string | null
  classificationToken: string | null
  gitIdentity: GitIdentity
}

/** Each loader is injected, so a test states its inputs instead of writing files. */
export interface PreflightDependencies {
  loadConfig: typeof loadConfig
  validateRepositoryMappings: typeof validateRepositoryMappings
  loadGitHubAppPrivateKey: typeof loadGitHubAppPrivateKey
  loadDashboardPassword: typeof loadDashboardPassword
  loadWebhookSecret: typeof loadWebhookSecret
  loadClassificationToken: typeof loadClassificationToken
  loadGitIdentity: typeof loadGitIdentity
}

export const defaultPreflightDependencies: PreflightDependencies = {
  loadConfig,
  validateRepositoryMappings,
  loadGitHubAppPrivateKey,
  loadDashboardPassword,
  loadWebhookSecret,
  loadClassificationToken,
  loadGitIdentity,
}

/** The dashboard password sits beside the configuration file, under a fixed name. */
export function dashboardPasswordPath(configPath: string): string {
  return join(dirname(configPath), 'dashboard-password')
}

/** One issue list, so a caller prints every failure the same way. */
export function describePreflightIssues(issues: ConfigIssue[]): string {
  return issues.map(issue => `${issue.path}: ${issue.message}`).join('\n')
}

/**
 * Reads and validates every service input. The first failing stage returns;
 * later stages would report against inputs this revision already rejected.
 */
export async function loadServiceInputs(
  configPath: string,
  dependencies: PreflightDependencies = defaultPreflightDependencies,
): Promise<Result<ServiceInputs, ConfigIssue[]>> {
  const parsed = await dependencies.loadConfig(configPath)
  if (parsed._tag === 'Err')
    return parsed

  const validated = await dependencies.validateRepositoryMappings(parsed.value)
  if (validated._tag === 'Err')
    return validated

  const githubPrivateKey = await dependencies.loadGitHubAppPrivateKey(validated.value.github.privateKeyPath)
  if (githubPrivateKey._tag === 'Err')
    return githubPrivateKey

  const dashboardPassword = await dependencies.loadDashboardPassword(dashboardPasswordPath(configPath))
  if (dashboardPassword._tag === 'Err')
    return err([{ path: '$.server.dashboardPassword', message: dashboardPassword.error }])

  const webhook = validated.value.webhook
  const webhookSecret = webhook._tag === 'Enabled' ? await dependencies.loadWebhookSecret(webhook.secretPath) : null
  if (webhookSecret?._tag === 'Err')
    return webhookSecret

  const classification = validated.value.classification
  const classificationToken = classification._tag === 'Enabled'
    ? await dependencies.loadClassificationToken(classification.tokenPath)
    : null
  if (classificationToken?._tag === 'Err')
    return classificationToken

  const gitIdentity = await dependencies.loadGitIdentity()
  if (gitIdentity._tag === 'Err')
    return err([{ path: '$.git.identity', message: gitIdentity.error }])

  return ok({
    config: validated.value,
    githubPrivateKey: githubPrivateKey.value,
    dashboardPassword: dashboardPassword.value,
    webhookSecret: webhookSecret === null ? null : webhookSecret.value,
    classificationToken: classificationToken === null ? null : classificationToken.value,
    gitIdentity: gitIdentity.value,
  })
}
