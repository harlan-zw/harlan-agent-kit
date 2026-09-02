#!/usr/bin/env node
import type { ControlClient } from './control-client.ts'
import type { Result } from './result.ts'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { invokesSubCommand } from './cli-subcommand.ts'
import { loadConfig, loadGitHubAppPrivateKey, loadWebhookSecret, validateRepositoryMappings } from './config.ts'
import { createControlClient } from './control-client.ts'
import { loadDashboardPassword } from './dashboard-password.ts'
import { loadGitIdentity } from './git-identity.ts'
import { discoverLocalCheckouts } from './repository-discovery.ts'
import { err } from './result.ts'
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

const controlConnectionArguments = {
  'config': configArgument,
  'url': {
    type: 'string',
    description: 'Service URL. Defaults to server.allowed_origin in the configuration file.',
  },
  'password-file': {
    type: 'string',
    description: 'Password file. Defaults to dashboard-password beside the configuration file.',
  },
} as const

interface ControlConnectionArguments {
  'config': string
  'url': string | undefined
  'password-file': string | undefined
}

type ControlCommandError
  = | { _tag: 'ConfigurationFailure', message: string }
    | { _tag: 'MissingTaskId', message: string }
    | { _tag: 'UnknownControlCommand', message: string }
    | { _tag: 'InvalidTaskId', message: string }
    | { _tag: 'InvalidEventLimit', message: string }
    | { _tag: 'InvalidStream', message: string }
    | { _tag: 'InvalidBaseUrl', message: string }

const workflowEventStreams = [
  'task',
  'worker_task',
  'publication',
  'review_run',
  'review_gate',
  'review_resolution',
  'review_status',
  'issue_triage_status',
  'routine_run',
  'candidate_issue',
  'routine_report',
  'provider_circuit',
] as const

async function loadControlClient(args: ControlConnectionArguments): Promise<Result<ControlClient, ControlCommandError>> {
  const configPath = resolve(args.config)
  let baseUrl = args.url
  if (baseUrl === undefined) {
    const configuration = await loadConfig(configPath).catch((error: unknown) =>
      err([{ path: '$', message: error instanceof Error ? error.message : 'The configuration file could not be read.' }]),
    )
    if (configuration._tag === 'Err') {
      return {
        _tag: 'Err',
        error: {
          _tag: 'ConfigurationFailure',
          message: configuration.error.map(issue => `${issue.path}: ${issue.message}`).join('\n'),
        },
      }
    }
    baseUrl = configuration.value.server.allowedOrigin
  }

  const passwordPath = resolve(args['password-file'] ?? join(dirname(configPath), 'dashboard-password'))
  const password = await loadDashboardPassword(passwordPath).catch((error: unknown) =>
    err(error instanceof Error ? error.message : 'The dashboard password file could not be read.'),
  )
  if (password._tag === 'Err')
    return { _tag: 'Err' as const, error: { _tag: 'ConfigurationFailure' as const, message: password.error } }

  return createControlClient({
    authentication: { _tag: 'Basic', password: password.value },
    baseUrl,
    fetch: globalThis.fetch,
  })
}

function writeJson(value: unknown, stream: NodeJS.WriteStream): void {
  stream.write(`${JSON.stringify(value)}\n`)
}

async function runControl<ErrorValue>(
  args: ControlConnectionArguments,
  action: (client: ControlClient) => Promise<Result<unknown, ErrorValue>>,
): Promise<void> {
  const client = await loadControlClient(args)
  if (client._tag === 'Err') {
    writeJson(client.error, process.stderr)
    process.exitCode = 1
    return
  }
  const result = await action(client.value)
  if (result._tag === 'Err') {
    writeJson(result.error, process.stderr)
    process.exitCode = 1
    return
  }
  writeJson(result.value, process.stdout)
}

function taskId(value: string): { _tag: 'Ok', value: string } | { _tag: 'Err', error: ControlCommandError } {
  return /^[a-f\d]{64}$/.test(value)
    ? { _tag: 'Ok', value }
    : { _tag: 'Err', error: { _tag: 'InvalidTaskId', message: 'The Task ID must contain 64 lowercase hexadecimal characters.' } }
}

function controlTaskCommand(input: { name: 'activity' | 'cancel', description: string }) {
  return defineCommand({
    meta: { name: input.name, description: input.description },
    args: {
      ...controlConnectionArguments,
      task: {
        type: 'string',
        description: 'Task ID.',
        required: true,
      },
    },
    async run({ args }) {
      const parsedTaskId = taskId(args.task)
      if (parsedTaskId._tag === 'Err') {
        writeJson(parsedTaskId.error, process.stderr)
        process.exitCode = 1
        return
      }
      await runControl(args, client => input.name === 'activity'
        ? client.activity(parsedTaskId.value).then(result => result._tag === 'Err' ? result : { _tag: 'Ok', value: { taskId: parsedTaskId.value, activity: result.value } })
        : client.cancelTask(parsedTaskId.value))
    },
  })
}

const controlCommand = defineCommand({
  meta: {
    name: 'control',
    description: 'Read and control one running Harlan GitHub Agent service.',
  },
  subCommands: {
    status: defineCommand({
      meta: { name: 'status', description: 'Read service health and the shared dashboard state.' },
      args: controlConnectionArguments,
      run: ({ args }) => runControl(args, client => client.status()),
    }),
    tasks: defineCommand({
      meta: { name: 'tasks', description: 'List current Tasks.' },
      args: controlConnectionArguments,
      run: ({ args }) => runControl(args, client => client.tasks().then(result => result._tag === 'Err' ? result : { _tag: 'Ok', value: { tasks: result.value } })),
    }),
    incidents: defineCommand({
      meta: { name: 'incidents', description: 'List unresolved Incidents.' },
      args: controlConnectionArguments,
      run: ({ args }) => runControl(args, client => client.incidents().then(result => result._tag === 'Err' ? result : { _tag: 'Ok', value: { incidents: result.value } })),
    }),
    activity: controlTaskCommand({ name: 'activity', description: 'Read the redacted activity for one active Task.' }),
    events: defineCommand({
      meta: { name: 'events', description: 'List durable workflow events.' },
      args: {
        ...controlConnectionArguments,
        stream: {
          type: 'string',
          description: `One workflow event stream: ${workflowEventStreams.join(', ')}.`,
        },
        limit: {
          type: 'string',
          description: 'Maximum events from 1 to 1000.',
          default: '200',
        },
      },
      async run({ args }) {
        const stream = workflowEventStreams.find(candidate => candidate === args.stream)
        if (args.stream !== undefined && stream === undefined) {
          writeJson({ _tag: 'InvalidStream', message: 'Select a valid workflow event stream.' } satisfies ControlCommandError, process.stderr)
          process.exitCode = 1
          return
        }
        const limit = Number(args.limit)
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
          writeJson({ _tag: 'InvalidEventLimit', message: 'Set the event limit from 1 to 1000.' } satisfies ControlCommandError, process.stderr)
          process.exitCode = 1
          return
        }
        await runControl(args as unknown as ControlConnectionArguments, client => client.workflowEvents({
          limit,
          ...(stream === undefined ? {} : { stream }),
        }).then(result => result._tag === 'Err' ? result : { _tag: 'Ok', value: { events: result.value } }))
      },
    }),
    pause: defineCommand({
      meta: { name: 'pause', description: 'Pause new agent Tasks.' },
      args: controlConnectionArguments,
      run: ({ args }) => runControl(args, client => client.pause()),
    }),
    resume: defineCommand({
      meta: { name: 'resume', description: 'Resume new agent Tasks.' },
      args: controlConnectionArguments,
      run: ({ args }) => runControl(args, client => client.resume()),
    }),
    restart: defineCommand({
      meta: { name: 'restart', description: 'Request Restart after current work.' },
      args: controlConnectionArguments,
      run: ({ args }) => runControl(args, client => client.restart()),
    }),
    update: defineCommand({
      meta: { name: 'update', description: 'Request Update after current work.' },
      args: controlConnectionArguments,
      run: ({ args }) => runControl(args, client => client.update()),
    }),
    cancel: controlTaskCommand({ name: 'cancel', description: 'Cancel one active or queued Task.' }),
  },
})

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
    'control': controlCommand,
  },
  async run({ args, rawArgs }) {
    // citty runs this after it ran the subcommand, so stop before the service
    // starts and binds the dashboard port.
    if (invokesSubCommand(rawArgs, ['combine-service-state', 'sweep-worktrees', 'control']))
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

type ControlCliInvocation
  = | { _tag: 'Run' }
    | { _tag: 'Fail', error: ControlCommandError }

function hasTaskArgument(rawArgs: readonly string[]): boolean {
  return rawArgs.some((argument, index) => {
    const nextArgument = rawArgs[index + 1]
    return argument.startsWith('--task=')
      || (argument === '--task' && nextArgument !== undefined && !nextArgument.startsWith('-'))
  })
}

function parseControlCliInvocation(rawArgs: readonly string[]): ControlCliInvocation {
  if (rawArgs[0] !== 'control' || rawArgs.some(argument => argument === '--help' || argument === '-h'))
    return { _tag: 'Run' }

  const commandName = rawArgs[1]
  const subCommands = controlCommand.subCommands
  if (commandName === undefined || typeof subCommands !== 'object' || subCommands === null || !Object.hasOwn(subCommands, commandName)) {
    return {
      _tag: 'Fail',
      error: { _tag: 'UnknownControlCommand', message: 'Select a valid control command.' },
    }
  }

  if ((commandName === 'activity' || commandName === 'cancel') && !hasTaskArgument(rawArgs.slice(2))) {
    return {
      _tag: 'Fail',
      error: { _tag: 'MissingTaskId', message: 'Set --task to one Task ID.' },
    }
  }

  return { _tag: 'Run' }
}

const controlCliInvocation = parseControlCliInvocation(process.argv.slice(2))
if (controlCliInvocation._tag === 'Fail') {
  writeJson(controlCliInvocation.error, process.stderr)
  process.exitCode = 1
}
else {
  void runMain(command)
}
