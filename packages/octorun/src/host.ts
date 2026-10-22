import type { AgentProvider, GitHubClient } from '@harlan-zw/octorun'
import { mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { adversarialReviewPreset, changeSummaryPreset, createGitHubAppAuth, createGitHubClient, createOctorun, err } from '@harlan-zw/octorun'
import { createKitRunAuthorizer, loadKitAppPrivateKey, loadKitServiceSettings } from './authority.ts'
import { buildKitOctorunConfig, KIT_PRIVATE_KEY_ENV, KIT_REPOSITORY } from './config.ts'
import { createKitTaskTypes } from './tasks.ts'

export interface KitHostOptions {
  configurationPath: string
  stateDir: string
  model: string
  env: NodeJS.ProcessEnv
  client?: GitHubClient
  provider?: AgentProvider
}

export async function createKitHost(options: KitHostOptions) {
  const settings = await loadKitServiceSettings(options.configurationPath)
  if (settings._tag === 'Err')
    return settings
  const key = await loadKitAppPrivateKey(settings.value.github.privateKeyPath)
  if (key._tag === 'Err')
    return key
  const client = options.client ?? createGitHubClient({ auth: createGitHubAppAuth({ appId: Number(settings.value.github.appId), privateKey: key.value }) })
  const repository = await client.repository(KIT_REPOSITORY)
  if (repository._tag === 'Err')
    return repository
  if (repository.value.archived)
    return err({ _tag: 'Authorization', message: 'The GitHub repository is archived. Octorun cannot start work there.' })
  const setup = {
    settings: settings.value,
    repository: repository.value.ref,
    stateDir: options.stateDir,
    provider: { _tag: 'Claude' as const, command: 'claude', model: options.model, timeoutMs: 180000, maxResponseBytes: 1048576, maxInputBytes: 262144 },
    presets: { summary: { ...changeSummaryPreset(), tasks: changeSummaryPreset().tasks.map(task => task.uses === 'changes.comment' ? { ...task, uses: 'kit.summary.publish' } : task) }, review: adversarialReviewPreset() },
  }
  const candidate = buildKitOctorunConfig(setup)
  if (candidate._tag === 'Err')
    return candidate
  const paths = await mkdir(candidate.value.stateDir, { recursive: true, mode: 0o700 }).then(async () => {
    const [stateDir, legacyDirectory, checkout] = await Promise.all([realpath(candidate.value.stateDir), realpath(dirname(settings.value.storagePath)), realpath(settings.value.repository.checkout)])
    return { stateDir, legacyDirectory, checkout }
  }).then(value => ({ _tag: 'Ok' as const, value }), () => err({ _tag: 'Configuration', message: 'Cannot resolve the Octorun state, Service database, or repository directories.' }))
  if (paths._tag === 'Err')
    return paths
  const config = buildKitOctorunConfig({ ...setup, stateDir: paths.value.stateDir, settings: { ...settings.value, repository: { ...settings.value.repository, checkout: paths.value.checkout }, storagePath: join(paths.value.legacyDirectory, basename(settings.value.storagePath)) } })
  if (config._tag === 'Err')
    return config
  return createOctorun({ config: config.value, client, ...(options.provider ? { provider: options.provider } : {}), env: { ...options.env, [KIT_PRIVATE_KEY_ENV]: key.value }, taskTypes: createKitTaskTypes(), authorizeRun: createKitRunAuthorizer({ configurationPath: options.configurationPath, settings: settings.value, repository: repository.value.ref, client }) })
}
