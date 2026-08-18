#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { loadConfig, loadGitHubAppPrivateKey, validateRepositoryMappings } from './config.ts'
import { loadDashboardPassword } from './dashboard-password.ts'
import { loadGitIdentity } from './git-identity.ts'
import { discoverLocalCheckouts } from './repository-discovery.ts'
import { startAgentService } from './service.ts'
import { stopWithin } from './shutdown.ts'
import { openJournalStore } from './store.ts'
import { agentWorktreeLeaseKey, listSweepableAgentWorktrees, sweepAgentWorktrees } from './worktree.ts'

function waitForShutdown(): Promise<void> {
  return new Promise((resolveShutdown) => {
    const stop = (): void => resolveShutdown()
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

const configArgument = {
  type: 'string',
  alias: 'c',
  description: 'Configuration file path.',
  default: 'harlan-github-agent.yml',
} as const

const sweepWorktrees = defineCommand({
  meta: {
    name: 'sweep-worktrees',
    description: 'Remove agent worktrees that no active task uses.',
  },
  args: {
    'config': configArgument,
    'dry-run': {
      type: 'boolean',
      description: 'Report the worktrees to remove. Remove nothing.',
      default: false,
    },
  },
  async run({ args }) {
    const configPath = resolve(args.config)
    const parsed = await loadConfig(configPath)
    if (parsed._tag === 'Err')
      throw new Error(parsed.error.map(issue => `${issue.path}: ${issue.message}`).join('\n'))

    const checkouts = await discoverLocalCheckouts(parsed.value.trustedCheckoutRoots)
    const store = openJournalStore(parsed.value.storage.path)
    // The live leases protect a Running or Queued task, so this is safe to run
    // while the service runs.
    const readLiveLeaseKeys = (): ReadonlySet<string> => new Set(store.listActiveTaskLeases().map(agentWorktreeLeaseKey))
    const signal = new AbortController().signal
    let total = 0
    try {
      for (const { checkout } of checkouts) {
        if (args['dry-run']) {
          const planned = await listSweepableAgentWorktrees({ checkout, readLiveLeaseKeys }, signal)
          if (planned._tag === 'Err') {
            consola.error(`${checkout}: ${planned.error}`)
            continue
          }
          planned.value.forEach(branch => consola.info(`${checkout}: would remove ${branch}`))
          total += planned.value.length
          continue
        }
        const swept = await sweepAgentWorktrees({ checkout, readLiveLeaseKeys }, signal)
        if (swept._tag === 'Err') {
          consola.error(`${checkout}: ${swept.error}`)
          continue
        }
        swept.value.removed.forEach(branch => consola.info(`${checkout}: removed ${branch}`))
        swept.value.failures.forEach(failure => consola.error(`${checkout}: could not remove ${failure.branch}: ${failure.reason}`))
        total += swept.value.removed.length
      }
    }
    finally {
      store.close()
    }
    consola.success(args['dry-run']
      ? `${total} agent worktrees are ready to remove.`
      : `Removed ${total} agent worktrees.`)
  },
})

const command = defineCommand({
  meta: {
    name: 'harlan-github-agent',
    version: '0.0.0',
    description: 'Run the local GitHub maintenance control plane.',
  },
  args: {
    config: configArgument,
  },
  subCommands: {
    'sweep-worktrees': sweepWorktrees,
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
