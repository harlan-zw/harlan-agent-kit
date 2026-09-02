#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { invokesSubCommand } from './cli-subcommand.ts'
import { loadConfig, loadGitHubAppPrivateKey, loadWebhookSecret, validateRepositoryMappings } from './config.ts'
import { loadDashboardPassword } from './dashboard-password.ts'
import { loadGitIdentity } from './git-identity.ts'
import { discoverLocalCheckouts } from './repository-discovery.ts'
import { combineServiceState } from './service-state.ts'
import { createGitServiceUpdateSource } from './service-update.ts'
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

const combineState = defineCommand({
  meta: {
    name: 'combine-service-state',
    description: 'Build one service file from desktop GitHub state and Hogwild Routine state.',
  },
  args: {
    'github-state': {
      type: 'positional',
      description: 'Desktop GitHub state file.',
      required: true,
    },
    'routine-state': {
      type: 'positional',
      description: 'Hogwild Routine state file.',
      required: true,
    },
    'output': {
      type: 'string',
      alias: 'o',
      description: 'New combined service file.',
      required: true,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Check both sources and report totals. Write nothing.',
      default: false,
    },
  },
  async run({ args }) {
    const result = await combineServiceState({
      githubPath: args['github-state'],
      routinePath: args['routine-state'],
      outputPath: args.output,
      dryRun: args['dry-run'],
    })
    if (result._tag === 'Err')
      throw new Error(JSON.stringify(result.error))
    const action = args['dry-run'] ? 'Checked' : 'Combined'
    consola.success(`${action} ${result.value.routines} Routines, ${result.value.routineRuns} runs, and ${result.value.candidates} Candidates.`)
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
    'combine-service-state': combineState,
    'sweep-worktrees': sweepWorktrees,
  },
  async run({ args, rawArgs }) {
    // citty runs this after it ran the subcommand, so stop before the service
    // starts and binds the dashboard port.
    if (invokesSubCommand(rawArgs, ['combine-service-state', 'sweep-worktrees']))
      return
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

    const webhook = validated.value.webhook
    const webhookSecret = webhook._tag === 'Enabled' ? await loadWebhookSecret(webhook.secretPath) : null
    if (webhookSecret?._tag === 'Err')
      throw new Error(webhookSecret.error.map(issue => `${issue.path}: ${issue.message}`).join('\n'))

    const gitIdentity = await loadGitIdentity()
    if (gitIdentity._tag === 'Err')
      throw new Error(gitIdentity.error)

    const serviceUpdate = createGitServiceUpdateSource({
      repositoryRoot: process.cwd(),
      now: () => new Date(),
      onError: error => consola.error(error),
    })
    const service = await startAgentService({
      config: validated.value,
      dashboardPassword: dashboardPassword.value,
      gitIdentity: gitIdentity.value,
      githubPrivateKey: privateKey.value,
      ...(webhookSecret === null ? {} : { webhookSecret: webhookSecret.value }),
      logger: consola,
      serviceUpdate,
    })
    consola.success(`Dashboard: ${validated.value.server.allowedOrigin}`)
    if (webhook._tag === 'Enabled')
      consola.success(`Webhooks: http://${webhook.host}:${webhook.port}/webhook`)
    await Promise.race([waitForShutdown(), service.waitForRestart()])
    const stopped = await stopWithin(service.stop, 10_000)
    if (!stopped) {
      consola.warn('An agent ignored shutdown for 10 seconds. The next start will recover its task.')
      process.exit(0)
    }
  },
})

void runMain(command)
