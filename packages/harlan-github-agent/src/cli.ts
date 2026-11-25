#!/usr/bin/env node
import type { ControlClient } from './control-client.ts'
import type { Result } from './result.ts'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { jev } from 'advocaat'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { agentWorkerHomes, checkAgentWorker } from './agent-sandbox.ts'
import { createPairingLink, pairingTarget } from './browser-auth-authorities.ts'
import { createClassificationSource } from './classification.ts'
import { forwardLeadingOptions } from './cli-leading-options.ts'
import { invokesSubCommand } from './cli-subcommand.ts'
import { configuredCheckoutRoots, loadClassificationToken, loadConfig } from './config.ts'
import { createControlClient } from './control-client.ts'
import { loadDashboardPassword } from './dashboard-password.ts'
import { parseIncidentResolutionRequest } from './incident-resolution.ts'
import { privateDetailsFor } from './public-text.ts'
import { parsePullRequestWatchTarget } from './pull-request-watch.ts'
import { discoverLocalCheckouts } from './repository-discovery.ts'
import { parseHandoffQuery, parsePostHandoff } from './repository-handoff-types.ts'
import { err } from './result.ts'
import { describePreflightIssues, loadServiceInputs } from './service-preflight.ts'
import { combineServiceState } from './service-state.ts'
import { createGitServiceUpdateSource } from './service-update.ts'
import { startAgentService } from './service.ts'
import { describeStopOutcome, stopWithin } from './shutdown.ts'
import { openJournalStore } from './store.ts'
import { replayStoredIssueTriage, replayStoredTriage } from './triage-evaluation.ts'
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
    | { _tag: 'InvalidIncidentResolution', message: string }
    | { _tag: 'InvalidReviewTarget', message: string }
    | { _tag: 'InvalidIssueTarget', message: string }
    | { _tag: 'InvalidWatchTarget', message: string }
    | { _tag: 'InvalidCompletionTarget', message: string }
    | { _tag: 'InvalidHandoff', message: string }
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
  'incident',
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
  return /^(?:logged-finding:)?[a-f\d]{64}$/.test(value)
    ? { _tag: 'Ok', value }
    : { _tag: 'Err', error: { _tag: 'InvalidTaskId', message: 'Set a 64-character Task ID or logged-finding Task ID.' } }
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
    'reviews': defineCommand({
      meta: { name: 'reviews', description: 'Show automated review runs, findings, and Review gates for one pull request.' },
      args: {
        ...controlConnectionArguments,
        repository: { type: 'string', description: 'Repository as OWNER/NAME.', required: true },
        number: { type: 'string', description: 'Pull request number.', required: true },
        head: { type: 'string', description: 'Optional full head SHA.' },
      },
      async run({ args }) {
        const target = parsePullRequestWatchTarget({ repository: args.repository, number: Number(args.number) })
        if (target._tag === 'Err' || (args.head !== undefined && !/^[a-f\d]{40}$/.test(args.head))) {
          writeJson({ _tag: 'InvalidReviewTarget', message: target._tag === 'Err' ? target.error : 'Set head to one full head SHA.' } satisfies ControlCommandError, process.stderr)
          process.exitCode = 1
          return
        }
        await runControl(args, client => client.reviews({ ...target.value, ...(args.head === undefined ? {} : { head: args.head }) }))
      },
    }),
    'register-completion': defineCommand({
      meta: { name: 'register-completion', description: 'Register a pull request for delivery checks after merge.' },
      args: {
        ...controlConnectionArguments,
        repository: { type: 'string', description: 'Repository as OWNER/NAME.', required: true },
        number: { type: 'string', description: 'Pull request number.', required: true },
      },
      async run({ args }) {
        const target = parsePullRequestWatchTarget({ repository: args.repository, number: Number(args.number) })
        if (target._tag === 'Err') {
          writeJson({ _tag: 'InvalidCompletionTarget', message: target.error } satisfies ControlCommandError, process.stderr)
          process.exitCode = 1
          return
        }
        await runControl(args, client => client.registerCompletion(target.value))
      },
    }),
    'watch-pr': defineCommand({
      meta: { name: 'watch-pr', description: 'Watch the Service for updates on one pull request.' },
      args: {
        ...controlConnectionArguments,
        'repository': { type: 'string', description: 'Repository as OWNER/NAME.', required: true },
        'number': { type: 'string', description: 'Pull request number.', required: true },
        'until': { type: 'string', description: 'Choose when to stop watching. Use attention, review, or merged.', default: 'attention' },
        'timeout-seconds': { type: 'string', description: 'Optional watch duration from 1 to 86400 seconds.' },
      },
      async run({ args }) {
        const target = parsePullRequestWatchTarget({ repository: args.repository, number: Number(args.number) })
        const until = args.until
        const timeoutSeconds = args['timeout-seconds'] === undefined ? undefined : Number(args['timeout-seconds'])
        if (target._tag === 'Err' || (until !== 'attention' && until !== 'review' && until !== 'merged')) {
          writeJson({ _tag: 'InvalidWatchTarget', message: target._tag === 'Err' ? target.error : 'Set until to attention, review, or merged.' } satisfies ControlCommandError, process.stderr)
          process.exitCode = 1
          return
        }
        if (timeoutSeconds !== undefined && (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400)) {
          writeJson({ _tag: 'InvalidWatchTarget', message: 'Set timeout-seconds from 1 to 86400.' } satisfies ControlCommandError, process.stderr)
          process.exitCode = 1
          return
        }
        const controller = new AbortController()
        const stop = () => controller.abort()
        process.once('SIGINT', stop)
        process.once('SIGTERM', stop)
        try {
          await runControl(args, client => client.watchPullRequest(target.value, {
            signal: timeoutSeconds === undefined ? controller.signal : AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutSeconds * 1_000)]),
            until,
            onUpdate: state => writeJson({ event: 'pull-request', status: state._tag, ...(state._tag === 'NotObserved'
              ? {}
              : { headSha: state.pullRequest.headSha, tasks: state.tasks.map(task => ({ id: task.id, kind: task.kind, state: task.state._tag })), ...(state.agentStart === undefined ? {} : { agentStart: state.agentStart }) }) }, process.stderr),
            onReconnect: reconnect => writeJson({ event: 'reconnect', attempt: reconnect.attempt, delaySeconds: reconnect.delayMilliseconds / 1_000, error: reconnect.error }, process.stderr),
          }))
        }
        finally {
          process.removeListener('SIGINT', stop)
          process.removeListener('SIGTERM', stop)
        }
      },
    }),
    'status': defineCommand({
      meta: { name: 'status', description: 'Show Service health and the current dashboard data.' },
      args: controlConnectionArguments,
      run: ({ args }) => runControl(args, client => client.status()),
    }),
    'tasks': defineCommand({
      meta: { name: 'tasks', description: 'List current Tasks.' },
      args: controlConnectionArguments,
      run: ({ args }) => runControl(args, client => client.tasks()),
    }),
    'handoffs': defineCommand({
      meta: { name: 'handoffs', description: 'Read private Handoffs for one repository.' },
      args: {
        ...controlConnectionArguments,
        'repository': { type: 'string', required: true, description: 'Repository as OWNER/NAME.' },
        'after': { type: 'string', description: 'Return Handoffs after this cursor. Use 0 to start at the beginning.' },
        'limit': { type: 'string', description: 'Maximum Handoffs from 1 to 50.' },
        'wait-seconds': { type: 'string', description: 'With --after, wait up to 25 seconds for a new Handoff.' },
      },
      async run({ args }) {
        const search = new URLSearchParams({ repository: args.repository })
        for (const key of ['after', 'limit', 'wait-seconds'] as const) {
          if (args[key] !== undefined)
            search.set(key, args[key])
        }
        const query = parseHandoffQuery(search)
        if (query._tag === 'Err') {
          writeJson({ _tag: 'InvalidHandoff', message: query.error } satisfies ControlCommandError, process.stderr)
          process.exitCode = 1
          return
        }
        await runControl(args, client => client.handoffs(query.value))
      },
    }),
    'post-handoff': defineCommand({
      meta: { name: 'post-handoff', description: 'Send a private Handoff to Agents working on one repository.' },
      args: {
        ...controlConnectionArguments,
        'repository': { type: 'string', required: true, description: 'Repository as OWNER/NAME.' },
        'agent': { type: 'string', required: true, description: 'The name of your Agent session.' },
        'message': { type: 'string', required: true, description: 'A concise update or a next action for other Agents.' },
        'issue': { type: 'string', description: 'Optional Issue number.' },
        'pull-request': { type: 'string', description: 'Optional pull request number.' },
        'reply-to': { type: 'string', description: 'Optional earlier Handoff ID in the same repository.' },
        'request-id': { type: 'string', description: 'Reuse this ID if you retry the same Handoff.' },
      },
      async run({ args }) {
        const item = args.issue !== undefined
          ? { _tag: 'Issue', number: Number(args.issue) }
          : args['pull-request'] !== undefined ? { _tag: 'PullRequest', number: Number(args['pull-request']) } : undefined
        const parsed = args.issue !== undefined && args['pull-request'] !== undefined
          ? err('Link a Handoff to one Issue or pull request.')
          : parsePostHandoff({
              repository: args.repository,
              agent: args.agent,
              message: args.message,
              item,
              replyTo: args['reply-to'] === undefined ? undefined : Number(args['reply-to']),
              requestId: args['request-id'] ?? randomUUID(),
            })
        if (parsed._tag === 'Err') {
          writeJson({ _tag: 'InvalidHandoff', message: parsed.error } satisfies ControlCommandError, process.stderr)
          process.exitCode = 1
          return
        }
        await runControl(args, client => client.postHandoff(parsed.value))
      },
    }),
    'incidents': defineCommand({
      meta: { name: 'incidents', description: 'List unresolved Incidents.' },
      args: controlConnectionArguments,
      run: ({ args }) => runControl(args, client => client.incidents().then(result => result._tag === 'Err' ? result : { _tag: 'Ok', value: { incidents: result.value } })),
    }),
    'activity': controlTaskCommand({ name: 'activity', description: 'Show recent activity for one active Task.' }),
    'events': defineCommand({
      meta: { name: 'events', description: 'List saved workflow events.' },
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
    'pause': defineCommand({
      meta: { name: 'pause', description: 'Pause new agent Tasks.' },
      args: controlConnectionArguments,
      run: ({ args }) => runControl(args, client => client.pause()),
    }),
    'resume': defineCommand({
      meta: { name: 'resume', description: 'Resume new agent Tasks.' },
      args: controlConnectionArguments,
      run: ({ args }) => runControl(args, client => client.resume()),
    }),
    'restart': defineCommand({
      meta: { name: 'restart', description: 'Request Restart after current work.' },
      args: controlConnectionArguments,
      run: ({ args }) => runControl(args, client => client.restart()),
    }),
    'reload-external-watches': defineCommand({
      meta: { name: 'reload-external-watches', description: 'Reload public issue watches without restarting agents.' },
      args: controlConnectionArguments,
      run: ({ args }) => runControl(args, client => client.reloadExternalWatches()),
    }),
    'update': defineCommand({
      meta: { name: 'update', description: 'Request Update after current work.' },
      args: { ...controlConnectionArguments, commit: { type: 'string', description: 'Full commit SHA for this Update.' } },
      run: ({ args }) => runControl(args, client => client.update(args.commit)),
    }),
    'cancel': controlTaskCommand({ name: 'cancel', description: 'Cancel one active or queued Task.' }),
    'recover-repair': defineCommand({
      meta: { name: 'recover-repair', description: 'Preview recovery from a saved Repair commit. Use --apply to run checks before opening a pull request.' },
      args: {
        ...controlConnectionArguments,
        'task': { type: 'string', description: 'Task ID for the Repair you want to recover.', required: true },
        'commit': { type: 'string', description: 'Full SHA of the saved Repair commit.', required: true },
        'apply': { type: 'boolean', description: 'Start recovery and run the checks again.', default: false },
        'expected-base': { type: 'string', description: 'Base SHA from the recovery preview.' },
      },
      run: ({ args }) => runControl(args, client => client.recoverRepair(args.apply
        ? { _tag: 'Apply', taskId: args.task, commitSha: args.commit, expectedBase: args['expected-base'] ?? '' }
        : { _tag: 'Plan', taskId: args.task, commitSha: args.commit })),
    }),
    'resolve-incident': defineCommand({
      meta: { name: 'resolve-incident', description: 'Resolve one exact incident with verified evidence.' },
      args: {
        ...controlConnectionArguments,
        'incident': { type: 'string', description: 'Exact incident ID.' },
        'last-seen-at': { type: 'string', description: 'Exact UTC lastSeenAt from the incident.' },
        'evidence': { type: 'string', description: 'Verified recovery evidence.' },
      },
      async run({ args }) {
        const parsed = parseIncidentResolutionRequest({ incidentId: args.incident, lastSeenAt: args['last-seen-at'], evidence: args.evidence })
        if (parsed._tag === 'Err') {
          writeJson({ _tag: 'InvalidIncidentResolution', message: parsed.error } satisfies ControlCommandError, process.stderr)
          process.exitCode = 1
          return
        }
        await runControl(args, client => client.resolveIncident(parsed.value))
      },
    }),
    'stop-review': defineCommand({
      meta: { name: 'stop-review', description: 'Stop automated review for one pull request head commit.' },
      args: {
        ...controlConnectionArguments,
        repository: { type: 'string', description: 'Repository as OWNER/NAME.', required: true },
        number: { type: 'string', description: 'Pull request number.', required: true },
        head: { type: 'string', description: 'Exact head commit SHA.', required: true },
      },
      async run({ args }) {
        const number = Number(args.number)
        if (!/^[^/]+\/[^/]+$/.test(args.repository) || !Number.isSafeInteger(number) || number < 1 || !/^[a-f\d]{40}$/.test(args.head)) {
          writeJson({ _tag: 'InvalidReviewTarget', message: 'Set a valid repository, pull request number, and head commit.' } satisfies ControlCommandError, process.stderr)
          process.exitCode = 1
          return
        }
        await runControl(args, client => client.stopReview(args.repository, number, args.head))
      },
    }),
    'rerun-issue': defineCommand({
      meta: { name: 'rerun-issue', description: 'Run Issue triage again for the current version of a GitHub issue.' },
      args: {
        ...controlConnectionArguments,
        repository: { type: 'string', description: 'Repository as OWNER/NAME.', required: true },
        number: { type: 'string', description: 'Issue number.', required: true },
        revision: { type: 'string', description: 'Optional ID of the current issue version.' },
      },
      async run({ args }) {
        const number = Number(args.number)
        if (!/^[^/]+\/[^/]+$/.test(args.repository) || !Number.isSafeInteger(number) || number < 1 || (args.revision !== undefined && !/^[a-f\d]{64}$/.test(args.revision))) {
          writeJson({ _tag: 'InvalidIssueTarget', message: 'Enter a repository and issue number. If you pass --revision, use the current issue version ID.' } satisfies ControlCommandError, process.stderr)
          process.exitCode = 1
          return
        }
        await runControl(args, async (client) => {
          if (args.revision !== undefined)
            return client.rerunIssueTriage(args.repository, number, args.revision)
          const current = await client.issueStatus(args.repository, number)
          return current._tag === 'Err' ? current : client.rerunIssueTriage(args.repository, number, current.value.revisionId)
        })
      },
    }),
    'routine-run': defineCommand({
      meta: { name: 'routine-run', description: 'Queue a Routine run before its next scheduled time.' },
      args: {
        ...controlConnectionArguments,
        routine: {
          type: 'string',
          description: 'Routine ID, as OWNER/REPOSITORY:NAME.',
          required: true,
        },
      },
      run: ({ args }) => runControl(args, client => client.runRoutine(args.routine)),
    }),
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

const rootArguments = {
  config: configArgument,
}

const evaluateTriage = defineCommand({
  meta: {
    name: 'evaluate-triage',
    description: 'Replay saved pull request triage decisions and suggest when to skip automated review.',
  },
  args: {
    ...rootArguments,
    limit: {
      type: 'string',
      alias: 'l',
      description: 'Newest decisions to replay.',
      default: '100',
    },
  },
  async run({ args }) {
    const parsed = await loadConfig(resolve(args.config))
    if (parsed._tag === 'Err')
      throw new Error(parsed.error.map(issue => `${issue.path}: ${issue.message}`).join('\n'))
    const classification = parsed.value.classification
    if (classification._tag !== 'Enabled')
      throw new Error('Add a classification block to the configuration before running this command.')
    const token = await loadClassificationToken(classification.tokenPath)
    if (token._tag === 'Err')
      throw new Error(token.error.map(issue => `${issue.path}: ${issue.message}`).join('\n'))
    const limit = Number.parseInt(args.limit ?? '100', 10)
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error('--limit needs a whole number above zero.')
    const summary = await replayStoredTriage({
      journalPath: parsed.value.storage.path,
      limit,
      classification: createClassificationSource({
        client: jev({
          accountId: classification.accountId,
          apiToken: token.value,
          ...(classification.gatewayId === undefined ? {} : { gatewayId: classification.gatewayId }),
          model: classification.model,
        }),
      }),
      log: line => consola.info(line),
    })
    consola.success(`Replayed ${summary.replayed} pull request triage decisions. The classifier answered ${summary.classified}. Saved decisions without a list of changed files: ${summary.skippedWithoutFiles}.`)
    consola.info(`Suggested threshold for skipping review is ${summary.suggestion.band}. It matched ${summary.suggestion.agreed} of ${summary.classified} saved decisions. It would skip review for ${summary.suggestion.skipsAdded} decisions marked for review.`)
  },
})

const evaluateIssueTriage = defineCommand({
  meta: {
    name: 'evaluate-issue-triage',
    description: 'Replay saved issue triage decisions and suggest a confidence threshold.',
  },
  args: {
    ...rootArguments,
    limit: {
      type: 'string',
      alias: 'l',
      description: 'Newest decisions to replay.',
      default: '100',
    },
  },
  async run({ args }) {
    const parsed = await loadConfig(resolve(args.config))
    if (parsed._tag === 'Err')
      throw new Error(parsed.error.map(issue => `${issue.path}: ${issue.message}`).join('\n'))
    const classification = parsed.value.classification
    if (classification._tag !== 'Enabled')
      throw new Error('Add a classification block to the configuration before running this command.')
    const token = await loadClassificationToken(classification.tokenPath)
    if (token._tag === 'Err')
      throw new Error(token.error.map(issue => `${issue.path}: ${issue.message}`).join('\n'))
    const limit = Number.parseInt(args.limit ?? '100', 10)
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error('--limit needs a whole number above zero.')
    const source = createClassificationSource({
      client: jev({
        accountId: classification.accountId,
        apiToken: token.value,
        ...(classification.gatewayId === undefined ? {} : { gatewayId: classification.gatewayId }),
        model: classification.model,
      }),
    })
    const summary = await replayStoredIssueTriage({
      journalPath: parsed.value.storage.path,
      limit,
      classification: source,
      log: line => consola.info(line),
    })
    consola.success(`Replayed ${summary.replayed} triage decisions using issue titles. The classifier answered ${summary.answered}.`)
    consola.info(`Suggested issue_triage_band is ${summary.suggestion.band}. It would skip Agent triage for ${summary.suggestion.routedAsStored} of ${summary.answered} answered cases, in line with the saved decisions. ${summary.suggestion.readyStalled} issues marked ready would wait.`)
  },
})

const checkConfig = defineCommand({
  meta: {
    name: 'check-config',
    description: 'Read the configuration and every secret it names, without starting the service.',
  },
  args: rootArguments,
  async run({ args }) {
    const configPath = resolve(args.config)
    const inputs = await loadServiceInputs(configPath)
    if (inputs._tag === 'Err') {
      consola.error(`This revision rejects ${configPath}:\n${describePreflightIssues(inputs.error)}`)
      process.exitCode = 1
      return
    }
    await checkAgentWorker(process.env)
    consola.success(`This revision accepts ${configPath}.`)
  },
})

const pair = defineCommand({
  meta: {
    name: 'pair',
    description: 'Print a single-use link that adds a Passkey to one browser origin.',
  },
  args: {
    ...rootArguments,
    origin: {
      type: 'string',
      description: 'Browser origin: server.allowed_origin or the server.browser_origins entry.',
    },
  },
  async run({ args }) {
    const parsed = await loadConfig(resolve(args.config))
    if (parsed._tag === 'Err') {
      consola.error(describePreflightIssues(parsed.error))
      process.exitCode = 1
      return
    }
    const target = pairingTarget(parsed.value, args.origin)
    if (target._tag === 'Err') {
      consola.error(target.error)
      process.exitCode = 1
      return
    }
    const link = createPairingLink({ ...target.value, now: Date.now })
    if (link._tag === 'Err') {
      consola.error(link.error)
      process.exitCode = 1
      return
    }
    consola.info('Open this link in the browser that should hold the Passkey. It works once and expires in 5 minutes. Keep it private.')
    process.stdout.write(`${link.value.url}\n`)
  },
})

const rootSubCommandNames = ['check-config', 'combine-service-state', 'sweep-worktrees', 'control', 'evaluate-triage', 'evaluate-issue-triage', 'pair']

const command = defineCommand({
  meta: {
    name: 'harlan-github-agent',
    version: '0.0.0',
    description: 'Run the local Harlan GitHub Agent service.',
  },
  args: rootArguments,
  subCommands: {
    'check-config': checkConfig,
    'combine-service-state': combineState,
    'sweep-worktrees': sweepWorktrees,
    'control': controlCommand,
    'evaluate-triage': evaluateTriage,
    'evaluate-issue-triage': evaluateIssueTriage,
    'pair': pair,
  },
  async run({ args, rawArgs }) {
    // citty runs this after it ran the subcommand, so stop before the service
    // starts and binds the dashboard port. citty dispatches on the first
    // positional argument, so look there, even when options precede the name.
    if (invokesSubCommand(rawArgs, rootSubCommandNames, rootArguments))
      return
    const configPath = resolve(args.config)
    const inputs = await loadServiceInputs(configPath)
    if (inputs._tag === 'Err')
      throw new Error(describePreflightIssues(inputs.error))

    const { classificationToken, config, dashboardPassword, gitIdentity, githubPrivateKey, webhookSecret } = inputs.value
    await checkAgentWorker(process.env)
    const classification = config.classification
    const webhook = config.webhook
    const privateDetails = privateDetailsFor({
      home: homedir(),
      storagePath: config.storage.path,
      // Both spellings: the resolved roots, and the configured ones under the home directory.
      checkoutRoots: [...config.trustedCheckoutRoots, ...configuredCheckoutRoots(homedir())],
      workerHomes: await agentWorkerHomes(process.env),
      serviceOrigins: [config.server.allowedOrigin, ...(config.server.browserOrigins ?? [])],
    })

    const serviceUpdate = createGitServiceUpdateSource({
      repositoryRoot: process.cwd(),
      now: () => new Date(),
      onError: error => consola.error(error),
    })
    const capacityCommand = process.env.HARLAN_HOST_CAPACITY_COMMAND
    if (capacityCommand !== undefined && (!isAbsolute(capacityCommand) || capacityCommand.includes('\0') || capacityCommand.length > 4096))
      throw new Error('The host capacity command requires an absolute path.')
    const service = await startAgentService({
      ...(capacityCommand === undefined ? {} : { capacityCommand }),
      ...(classification._tag === 'Enabled' && classificationToken !== null
        ? { classification: { accountId: classification.accountId, apiToken: classificationToken, ...(classification.gatewayId === undefined ? {} : { gatewayId: classification.gatewayId }), model: classification.model } }
        : {}),
      config,
      configPath,
      dashboardPassword,
      gitIdentity,
      githubPrivateKey,
      ...(webhookSecret === null ? {} : { webhookSecret }),
      logger: consola,
      privateDetails,
      serviceUpdate,
    })
    consola.success(`Dashboard: ${config.server.allowedOrigin}`)
    if (webhook._tag === 'Enabled')
      consola.success(`Webhooks: http://${webhook.host}:${webhook.port}/webhook`)
    await Promise.race([waitForShutdown(), service.waitForRestart()])
    const stopped = await stopWithin(service.stop, { timeoutMilliseconds: 10_000 })
    if (stopped._tag === 'Overran') {
      consola.warn(describeStopOutcome(stopped))
      process.exit(0)
    }
    consola.info(describeStopOutcome(stopped))
  },
})

type ControlCliInvocation
  = | { _tag: 'Run', rawArgs: string[] }
    | { _tag: 'Fail', error: ControlCommandError }

const controlValueOptionFlags = ['--config', '-c', '--url', '--password-file']

function hasTaskArgument(rawArgs: readonly string[]): boolean {
  return rawArgs.some((argument, index) => {
    const nextArgument = rawArgs[index + 1]
    return argument.startsWith('--task=')
      || (argument === '--task' && nextArgument !== undefined && !nextArgument.startsWith('-'))
  })
}

function parseControlCliInvocation(rawArgs: readonly string[]): ControlCliInvocation {
  if (rawArgs[0] !== 'control' || rawArgs.some(argument => argument === '--help' || argument === '-h'))
    return { _tag: 'Run', rawArgs: [...rawArgs] }

  const subCommands = controlCommand.subCommands
  if (typeof subCommands !== 'object' || subCommands === null)
    return { _tag: 'Run', rawArgs: [...rawArgs] }

  // citty dispatches on the first positional argument, so connection options
  // between `control` and the nested command name must not hide the name.
  // Skip value-taking option tokens, then forward those options to the end,
  // where the subcommand parses them.
  const leading: string[] = []
  let index = 1
  let argument = rawArgs[index]
  while (argument !== undefined && argument.startsWith('-') && argument !== '--') {
    const nextArgument = rawArgs[index + 1]
    const takesValue = !argument.includes('=') && controlValueOptionFlags.includes(argument)
      && nextArgument !== undefined && !nextArgument.startsWith('-')
    leading.push(...takesValue ? [argument, nextArgument] : [argument])
    index += takesValue ? 2 : 1
    argument = rawArgs[index]
  }
  const commandName = rawArgs[index]
  if (commandName === undefined || !Object.hasOwn(subCommands, commandName)) {
    return {
      _tag: 'Fail',
      error: { _tag: 'UnknownControlCommand', message: 'Select a valid control command.' },
    }
  }

  const nestedRawArgs = leading.length === 0
    ? [...rawArgs]
    : ['control', ...rawArgs.slice(index), ...leading]
  if ((commandName === 'activity' || commandName === 'cancel') && !hasTaskArgument(nestedRawArgs.slice(2))) {
    return {
      _tag: 'Fail',
      error: { _tag: 'MissingTaskId', message: 'Set --task to one Task ID.' },
    }
  }

  return { _tag: 'Run', rawArgs: nestedRawArgs }
}

const cliArguments = process.argv.slice(2)
// A leading `--config` binds to the root command in citty, so forward the
// connection options behind every subcommand name, where they parse them.
const normalizedCliArguments = forwardLeadingOptions(cliArguments, controlValueOptionFlags, rootSubCommandNames)
const controlCliInvocation = parseControlCliInvocation(normalizedCliArguments)
if (controlCliInvocation._tag === 'Fail') {
  writeJson(controlCliInvocation.error, process.stderr)
  process.exitCode = 1
}
else {
  void runMain(command, { rawArgs: controlCliInvocation.rawArgs })
}
