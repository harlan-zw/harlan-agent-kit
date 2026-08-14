#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { loadConfig, loadGitHubAppPrivateKey, validateRepositoryMappings } from './config.ts'
import { loadDashboardPassword } from './dashboard-password.ts'
import { loadGitIdentity } from './git-identity.ts'
import { startAgentService } from './service.ts'
import { stopWithin } from './shutdown.ts'

function waitForShutdown(): Promise<void> {
  return new Promise((resolveShutdown) => {
    const stop = (): void => resolveShutdown()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

const command = defineCommand({
  meta: {
    name: 'harlan-github-agent',
    version: '0.0.0',
    description: 'Run the local GitHub maintenance control plane.',
  },
  args: {
    config: {
      type: 'string',
      alias: 'c',
      description: 'Configuration file path.',
      default: 'harlan-github-agent.yml',
    },
  },
  async run({ args }) {
    const configPath = resolve(args.config)
    const parsed = await loadConfig(configPath)
    if (parsed._tag === 'Err')
      throw new Error(parsed.error.map(issue => `${issue.path}: ${issue.message}`).join('\n'))

    const validated = await validateRepositoryMappings(parsed.value)
    if (validated._tag === 'Err')
      throw new Error(validated.error.map(issue => `${issue.path}: ${issue.message}`).join('\n'))

    const privateKey = await loadGitHubAppPrivateKey(validated.value.github.privateKeyPath)
    if (privateKey._tag === 'Err')
      throw new Error(privateKey.error.map(issue => `${issue.path}: ${issue.message}`).join('\n'))

    const dashboardPassword = await loadDashboardPassword(join(dirname(configPath), 'dashboard-password'))
    if (dashboardPassword._tag === 'Err')
      throw new Error(dashboardPassword.error)

    const gitIdentity = await loadGitIdentity()
    if (gitIdentity._tag === 'Err')
      throw new Error(gitIdentity.error)

    const service = await startAgentService({
      config: validated.value,
      dashboardPassword: dashboardPassword.value,
      gitIdentity: gitIdentity.value,
      githubPrivateKey: privateKey.value,
      logger: consola,
    })
    consola.success(`Dashboard: http://${validated.value.server.allowedHost}`)
    await waitForShutdown()
    const stopped = await stopWithin(service.stop, 10_000)
    if (!stopped) {
      consola.warn('An agent ignored shutdown for 10 seconds. The next start will recover its task.')
      process.exit(0)
    }
  },
})

void runMain(command)
