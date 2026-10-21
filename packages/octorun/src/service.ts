import type { ConfiguredRepository, OperatorConfig } from './config.ts'
import type { GitHubCommand } from './github-commands.ts'
import type { GitHubPollCursor } from './github-events.ts'
import type { GitHubClient } from './github.ts'
import type { WebhookRequest } from './server.ts'
import type { AgentProvider, ConfigurationSource, EventEnvelope, JsonValue, PublicationEffect, RepositoryPolicy, Result, RunRecord, TaskType, WorkflowDefinition } from './types.ts'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { resolveSecrets } from './config.ts'
import { githubId, githubObject } from './github-auth.ts'
import { isOctorunFinding } from './github-publication.ts'
import { authorizeGitHubCommand, createGitHubAppAuth, createGitHubClient, createGitHubPublisher, createGitHubSnapshotReader, githubDigest, githubRepositoryPath, normalizeGitHubWebhook, parseGitHubCommand, pollGitHubEvents, verifyWebhookSignature } from './github.ts'
import { createOpenAICompatibleProvider } from './providers.ts'
import { adversarialReviewPreset, changeSummaryPreset, conversationPreset, createReviewTaskTypes } from './review.ts'
import { createRunner } from './runner.ts'
import { openStore } from './store.ts'
import { err, ok, parseJsonValue } from './types.ts'
import { compileWorkflow, digest, parseWorkflow, targetKey, taskLimits } from './workflow.ts'

export function parseRepositoryWorkflows(text: string): Result<WorkflowDefinition[]> {
  if (Buffer.byteLength(text) > 512 * 1024)
    return err({ _tag: 'Configuration', message: 'Repository workflow configuration exceeds 512 KiB.' })
  const document = parseDocument(text, { strict: true, uniqueKeys: true })
  if (document.errors.length)
    return err({ _tag: 'Configuration', message: 'Repository workflow configuration contains invalid YAML or duplicate keys.' })
  let input: unknown
  try {
    input = document.toJS({ maxAliasCount: 0 })
  }
  catch {
    return err({ _tag: 'Configuration', message: 'Repository workflow configuration cannot use YAML aliases.' })
  }
  const object = githubObject(input)
  if (!object || Object.keys(object).some(key => !['version', 'workflows'].includes(key)) || object.version !== 1 || !Array.isArray(object.workflows) || object.workflows.length < 1 || object.workflows.length > 100)
    return err({ _tag: 'Configuration', message: 'Repository configuration requires version 1 and one to 100 workflows.' })
  const workflows: WorkflowDefinition[] = []
  for (const value of object.workflows) {
    const parsed = parseWorkflow(value)
    if (parsed._tag === 'Err')
      return parsed
    if (workflows.some(workflow => workflow.id === parsed.value.id))
      return err({ _tag: 'Configuration', message: `Repository workflow ID is repeated: ${parsed.value.id}.` })
    workflows.push(parsed.value)
  }
  return ok(workflows)
}

export interface OctorunServiceOptions {
  config: OperatorConfig
  env?: NodeJS.ProcessEnv
  fetch?: typeof globalThis.fetch
  now?: () => Date
  client?: GitHubClient
  provider?: AgentProvider
  taskTypes?: TaskType[]
}

export async function createOctorun(options: OctorunServiceOptions) {
  const { config } = options
  const now = options.now ?? (() => new Date())
  const secrets = resolveSecrets(config, options.env ?? process.env)
  if (secrets._tag === 'Err')
    return secrets
  const appId = Number(config.github.appId)
  if (!githubId(appId))
    return err({ _tag: 'Configuration', message: 'The GitHub App ID must be a positive safe integer.' })
  const provider = options.provider ? ok(options.provider) : createOpenAICompatibleProvider({ ...config.provider, apiKey: secrets.value.apiKey }, { ...(options.fetch ? { fetch: options.fetch } : {}), now })
  if (provider._tag === 'Err')
    return provider
  const client = options.client ?? createGitHubClient({ auth: createGitHubAppAuth({ appId, privateKey: secrets.value.privateKey, apiUrl: config.github.apiUrl, now: () => now().getTime(), ...(options.fetch ? { fetch: options.fetch } : {}) }), apiUrl: config.github.apiUrl, now: () => now().getTime(), ...(options.fetch ? { fetch: options.fetch } : {}) })
  const store = openStore({ path: join(config.stateDir, 'state.sqlite'), now })
  const repositories = new Map(config.repositories.map(repository => [repository.fullName.toLowerCase(), repository]))
  const configured = (name: string): Result<ConfiguredRepository> => {
    const repository = repositories.get(name.toLowerCase())
    return repository ? ok(repository) : err({ _tag: 'Authorization', message: 'The operator has not configured this repository.' })
  }
  const definitions = async (repository: ConfiguredRepository, signal?: AbortSignal): Promise<Result<{ workflows: WorkflowDefinition[], configuration: ConfigurationSource }>> => {
    const metadata = await client.repository(repository.fullName, signal)
    if (metadata._tag === 'Err')
      return metadata
    if (metadata.value.ref.id !== repository.id || metadata.value.ref.installationId !== repository.installationId)
      return err({ _tag: 'Authorization', message: 'The installed repository does not match the operator configuration.' })
    if (repository.workflowSource._tag === 'Repository') {
      const source = await client.readWorkflow(repository.fullName, repository.workflowSource.path, signal)
      if (source._tag === 'Err')
        return source
      if (source.value.text === null)
        return err({ _tag: 'Configuration', message: 'The trusted branch does not contain the configured workflow file.' })
      const workflows = parseRepositoryWorkflows(source.value.text)
      return workflows._tag === 'Err' ? workflows : ok({ workflows: workflows.value, configuration: { source: `${repository.fullName}:${repository.workflowSource.path}`, sha: source.value.sha, digest: githubDigest(source.value.text) } })
    }
    const workflows = repository.workflowSource._tag === 'Inline' ? repository.workflowSource.definitions : repository.workflowSource.presets.map(name => name === 'adversarial-review' ? adversarialReviewPreset() : changeSummaryPreset())
    return ok({ workflows, configuration: { source: `operator:${repository.workflowSource._tag.toLowerCase()}`, sha: 'operator', digest: digest(workflows) } })
  }
  const responder: TaskType = {
    id: 'octorun.respond',
    version: '1',
    capabilities: ['github:comment'],
    input: parseJsonValue,
    output: parseJsonValue,
    async execute(context, input) {
      const value = githubObject(input)
      if (typeof value?.body !== 'string' || !('number' in context.event.target))
        return { _tag: 'Failed', error: { _tag: 'Configuration', message: 'A command response needs a GitHub object and message.' } }
      const result = await context.publish('response', { _tag: 'Comment', repository: context.event.repository.fullName, number: context.event.target.number, namespace: `command:${String(githubObject(context.event.data)?.commentId ?? context.event.id)}`, body: value.body })
      return result._tag === 'Err' ? { _tag: 'Failed', error: result.error } : { _tag: 'Succeeded', output: { publicationId: result.value } }
    },
  }
  const reviewTypes = createReviewTaskTypes({ provider: provider.value, snapshots: createGitHubSnapshotReader(client), previousReview: async (context) => {
    const previous = store.runs({ repository: context.event.repository.fullName, states: ['Succeeded'] }).reverse().find(run => run.id !== context.run.id && targetKey(run.event) === targetKey(context.event) && run.definition.id === 'adversarial-review')
    const output = previous?.tasks.find(task => task.definition.uses === 'review.verify')?.output
    const report = githubObject(output)
    return report && typeof report.headSha === 'string' && typeof report.baseSha === 'string' && Array.isArray(report.fingerprints) && report.fingerprints.every(value => typeof value === 'string') ? { headSha: report.headSha, baseSha: report.baseSha, fingerprints: report.fingerprints as string[] } : null
  } })
  const providerBinding = digest({ id: provider.value.id, baseUrl: config.provider.baseUrl, model: config.provider.model, timeoutMs: config.provider.timeoutMs, maxResponseBytes: config.provider.maxResponseBytes, maxInputCharacters: config.provider.maxInputCharacters })
  const pinnedReviewTypes = reviewTypes.map(type => type.capabilities.includes('agent:invoke') ? { ...type, version: `${type.version}:${providerBinding}` } : type)
  const currentPolicy = async (run: RunRecord): Promise<Result<RepositoryPolicy>> => {
    const repository = configured(run.event.repository.fullName)
    if (repository._tag === 'Err')
      return repository
    const metadata = await client.repository(repository.value.fullName)
    if (metadata._tag === 'Err')
      return metadata
    if (metadata.value.ref.id !== run.event.repository.id || metadata.value.ref.installationId !== run.event.repository.installationId)
      return err({ _tag: 'Authorization', message: 'The workflow repository installation changed.' })
    if (['Queued', 'Running', 'Waiting'].includes(run.state._tag) && (run.event.action === 'command' || run.event.name === 'octorun.conversation')) {
      const permission = await authorizeGitHubCommand({ command: { _tag: 'Review', full: false }, actor: run.event.actor, repository: repository.value.fullName, resolvePermission: (name, actor) => client.permission(name, actor) })
      if (permission._tag === 'Err')
        return permission
    }
    return ok(repository.value.policy)
  }
  const publisher = createGitHubPublisher({ client, authorize: async (context) => {
    const repository = configured(context.run.event.repository.fullName)
    if (repository._tag === 'Err')
      return repository
    const capability = context.publication.effect._tag === 'Review' ? 'github:review' : context.publication.effect._tag === 'Check' ? 'github:check' : 'github:comment'
    if (!repository.value.policy.enabled || !repository.value.policy.capabilities.includes(capability) || !context.run.policy.capabilities.includes(capability))
      return err({ _tag: 'Authorization', message: 'Repository policy no longer permits this GitHub publication.' })
    const current = store.run(context.run.id)
    if (!current || (['Cancelled', 'Superseded'].includes(current.state._tag) && context.publication.effect._tag !== 'Check'))
      return err({ _tag: 'Authorization', message: 'The workflow run no longer permits this publication.' })
    if (context.publication.effect._tag !== 'Check') {
      const grant = await currentPolicy(context.run)
      if (grant._tag === 'Err')
        return grant
    }
    return ok(undefined)
  } })
  let observeRun = (_run: RunRecord): void => {}
  const taskTypes = [...pinnedReviewTypes, responder, ...(options.taskTypes ?? [])]
  const runner = createRunner({ store, taskTypes, publisher, now, concurrency: config.limits.concurrency, policy: currentPolicy, onRunChanged: (run) => {
    observeRun(run)
  } })
  let timer: ReturnType<typeof setInterval> | null = null
  let ticking: Promise<void> | null = null
  let closed = false
  let lastPollAt = 0

  const startWorkflow = (event: EventEnvelope, workflow: WorkflowDefinition, repository: ConfiguredRepository, configuration: ConfigurationSource, requestId: string): Result<RunRecord> => runner.start({ event, workflow, policy: repository.policy, configuration, requestId })
  const commandResponse = (event: EventEnvelope, repository: ConfiguredRepository, body: string): Result<RunRecord> => startWorkflow({ ...event, name: 'octorun.command' }, {
    version: 1,
    id: 'command-response',
    name: 'Command response',
    on: [],
    tasks: [{ id: 'respond', uses: 'octorun.respond', with: { body } }],
    concurrency: { mode: 'queue', group: 'target' },
    limits: { maxAttempts: 2, timeoutMs: 15000, maxTokens: 1, maxCostUsd: null, maxDurationMs: 60000 },
  }, repository, { source: 'operator:command-response', sha: 'operator', digest: 'command-response-v1' }, `response:${event.semanticKey}`)
  const statusFor = (event: EventEnvelope): string => {
    const runs = runner.runs({ repository: event.repository.fullName }).filter(run => targetKey(run.event) === targetKey(event) && run.definition.id !== 'command-response')
    const run = runs.at(-1)
    return run ? `${run.definition.name}: ${run.state._tag}.\nHead: ${run.event.target._tag === 'PullRequest' ? run.event.target.headSha.slice(0, 12) : 'not applicable'}.\nRun: ${run.id}.` : 'No workflow run exists for this target.'
  }
  const help = `Use @${config.handle} help, status, configuration, review, review full, run <workflow>, pause, resume, or cancel.\nRepair workflows are disabled.`
  const executeCommand = async (event: EventEnvelope, repository: ConfiguredRepository, command: GitHubCommand): Promise<Result<JsonValue>> => {
    const previous = store.cursor(`command:${event.semanticKey}`)
    if (previous !== null)
      return ok(previous)
    const permission = await authorizeGitHubCommand({ command, actor: event.actor, repository: repository.fullName, resolvePermission: (name, actor) => client.permission(name, actor) })
    if (permission._tag === 'Err')
      return permission
    let response: string | null = null
    let runId: string | null = null
    if (command._tag === 'Help') {
      response = help
    }
    else if (command._tag === 'Status') {
      response = statusFor(event)
    }
    else if (command._tag === 'Configuration') {
      response = `Workflow source: ${repository.workflowSource._tag}.\nCapabilities: ${repository.policy.capabilities.join(', ')}.\nCode changes and repair workflows are disabled.`
    }
    else if (command._tag === 'Pause' || command._tag === 'Resume') {
      runner.pause(repository.fullName, targetKey(event), command._tag === 'Pause')
      response = command._tag === 'Pause' ? 'Automatic workflow runs are paused for this target. Active runs continue. Use cancel to stop active work.' : 'Automatic workflow runs are enabled for this target.'
    }
    else if (command._tag === 'Cancel') {
      const active = runner.runs({ repository: repository.fullName }).filter(run => targetKey(run.event) === targetKey(event) && ['Queued', 'Running', 'Waiting'].includes(run.state._tag))
      for (const run of active)
        runner.cancel(run.id, `Cancelled by ${event.actor!.login}.`)
      response = `Cancelled ${active.length} active workflow run${active.length === 1 ? '' : 's'}.`
    }
    else if (command._tag === 'Repair') {
      return err({ _tag: 'Authorization', message: 'The operator must enable a repair workflow.' })
    }
    else {
      if (event.target._tag !== 'PullRequest')
        return err({ _tag: 'Configuration', message: 'This workflow command requires a pull request.' })
      const selected = await definitions(repository)
      if (selected._tag === 'Err')
        return selected
      const id = command._tag === 'Run' ? command.workflow : 'adversarial-review'
      let workflow = selected.value.workflows.find(candidate => candidate.id === id)
      if (!workflow)
        return err({ _tag: 'Configuration', message: `Workflow is not configured: ${id}.` })
      if (command._tag === 'Review' && command.full)
        workflow = { ...workflow, tasks: workflow.tasks.map(task => task.uses === 'review.snapshot' ? { ...task, with: { ...task.with, full: true } } : task) }
      const started = startWorkflow({ ...event, name: 'octorun.command', action: 'command' }, workflow, repository, selected.value.configuration, `command:${event.semanticKey}`)
      if (started._tag === 'Err')
        return started
      runId = started.value.id
    }
    if (response !== null) {
      const started = commandResponse(event, repository, response)
      if (started._tag === 'Err')
        return started
      runId = started.value.id
    }
    const result: JsonValue = { accepted: true, runId, command: command._tag, targetKey: targetKey(event) }
    store.setCursor(`command:${event.semanticKey}`, result)
    return ok(result)
  }

  const processEvent = async (event: EventEnvelope): Promise<Result<JsonValue>> => {
    const repository = configured(event.repository.fullName)
    if (repository._tag === 'Err')
      return repository
    if (repository.value.id !== event.repository.id || repository.value.installationId !== event.repository.installationId)
      return err({ _tag: 'Authorization', message: 'The GitHub event identifies a different repository installation.' })
    const data = githubObject(event.data)
    if (event.name === 'check_run') {
      if (!githubId(data?.checkId) || typeof data.externalId !== 'string' || !data.externalId.startsWith('octorun:') || !['cancel', 'rerun'].includes(String(data.command)))
        return err({ _tag: 'Authorization', message: 'The requested check action does not identify an Octorun run.' })
      const original = store.run(data.externalId.slice('octorun:'.length))
      if (!original || original.event.repository.id !== event.repository.id || original.event.repository.fullName.toLowerCase() !== event.repository.fullName.toLowerCase() || original.event.repository.installationId !== event.repository.installationId || original.event.target._tag !== 'PullRequest' || event.target._tag !== 'PullRequest' || original.event.target.number !== event.target.number || original.event.target.headSha !== event.target.headSha)
        return err({ _tag: 'Authorization', message: 'The requested check run does not match this repository and head.' })
      const headSha = event.target.headSha
      const recorded = store.publications({ runId: original.id }).some(publication => publication.effect._tag === 'Check' && publication.effect.headSha === headSha && publication.state._tag === 'Written' && publication.state.receipt.id === String(data.checkId))
      if (!recorded)
        return err({ _tag: 'Authorization', message: 'The requested check ID is not recorded for this workflow run.' })
      if (data.command === 'rerun')
        return executeCommand(event, repository.value, { _tag: 'Run', workflow: original.definition.id })
      const previous = store.cursor(`command:${event.semanticKey}`)
      if (previous !== null)
        return ok(previous)
      const permission = await authorizeGitHubCommand({ command: { _tag: 'Cancel' }, actor: event.actor, repository: repository.value.fullName, resolvePermission: (name, actor) => client.permission(name, actor) })
      if (permission._tag === 'Err')
        return permission
      const cancelled = runner.cancel(original.id, `Cancelled by ${event.actor!.login}.`)
      if (cancelled._tag === 'Err')
        return cancelled
      const result: JsonValue = { accepted: true, runId: cancelled.value.id, state: cancelled.value.state._tag, command: 'Cancel', targetKey: targetKey(event) }
      store.setCursor(`command:${event.semanticKey}`, result)
      return ok(result)
    }
    if (event.name.includes('comment') && typeof data?.body === 'string') {
      const command = parseGitHubCommand(data.body, config.handle)
      if (command._tag === 'Command')
        return executeCommand(event, repository.value, command.command)
      if (command._tag === 'Unknown') {
        const permission = await authorizeGitHubCommand({ command: { _tag: 'Help' }, actor: event.actor, repository: event.repository.fullName, resolvePermission: (name, actor) => client.permission(name, actor) })
        if (permission._tag === 'Err')
          return permission
        const response = commandResponse(event, repository.value, `Unknown command.\n${help}`)
        return response._tag === 'Err' ? response : ok({ runId: response.value.id })
      }
      if (event.name === 'pull_request_review_comment' && githubId(data.inReplyToId) && event.target._tag === 'PullRequest') {
        const permission = await authorizeGitHubCommand({ command: { _tag: 'Review', full: false }, actor: event.actor, repository: event.repository.fullName, resolvePermission: (name, actor) => client.permission(name, actor) })
        if (permission._tag === 'Err')
          return permission
        const root = await client.request(event.repository.fullName, 'read', `${githubRepositoryPath(event.repository.fullName)}/pulls/comments/${data.inReplyToId}`)
        if (root._tag === 'Err')
          return root
        const bot = await client.botIdentity(event.repository.fullName)
        if (bot._tag === 'Err')
          return bot
        const rootComment = githubObject(root.value)
        if (!rootComment || !isOctorunFinding(rootComment, bot.value.id))
          return ok({ ignored: true })
        const comments = await client.paginate(event.repository.fullName, `${githubRepositoryPath(event.repository.fullName)}/pulls/${event.target.number}/comments`)
        if (comments._tag === 'Err')
          return comments
        const history = comments.value.filter(raw => githubObject(raw)?.in_reply_to_id === data.inReplyToId && githubObject(raw)?.id !== data.commentId).slice(-20).map(raw => ({ role: githubObject(githubObject(raw)?.user)?.id === bot.value.id ? 'assistant' : 'user', content: String(githubObject(raw)?.body ?? '').slice(0, 4000) }))
        const conversation: EventEnvelope = { ...event, name: 'octorun.conversation', data: { commentId: data.inReplyToId, question: data.body.slice(0, 8000), reviewedHeadSha: typeof rootComment.commit_id === 'string' ? rootComment.commit_id : null, finding: { body: String(rootComment.body ?? '').slice(0, 10000), path: typeof rootComment.path === 'string' ? rootComment.path : null, line: typeof rootComment.line === 'number' ? rootComment.line : null }, history } }
        const started = startWorkflow(conversation, conversationPreset(), repository.value, { source: 'operator:review-conversation', sha: 'operator', digest: 'review-conversation-v1' }, `conversation:${event.semanticKey}`)
        return started._tag === 'Err' ? started : ok({ runId: started.value.id })
      }
      return ok({ ignored: true })
    }
    if (event.target._tag === 'PullRequest' && (data?.draft === true || data?.state === 'closed')) {
      for (const run of runner.runs({ repository: event.repository.fullName })) {
        if (targetKey(run.event) === targetKey(event) && ['Queued', 'Running', 'Waiting'].includes(run.state._tag))
          runner.cancel(run.id, data?.draft === true ? 'The pull request is a draft.' : 'The pull request closed.')
      }
      return ok({ skipped: true, reason: data?.draft === true ? 'draft' : 'closed' })
    }
    const selected = await definitions(repository.value)
    if (selected._tag === 'Err')
      return selected
    const accepted = runner.ingest(event, selected.value.workflows, repository.value.policy, selected.value.configuration)
    return accepted._tag === 'Err' ? accepted : ok({ eventId: accepted.value.eventId, runIds: accepted.value.runIds, duplicate: accepted.value.duplicate })
  }

  const handleWebhook = async (request: WebhookRequest): Promise<Result<JsonValue>> => {
    if (closed)
      return err({ _tag: 'Transient', message: 'Octorun is closing.' })
    if (secrets.value.webhookSecret === null || !verifyWebhookSignature(secrets.value.webhookSecret, request.body, request.signature))
      return err({ _tag: 'Authorization', message: 'Webhook signature did not match.' })
    if (Buffer.byteLength(request.body) > config.limits.bodyBytes || !/^[\w-]{1,128}$/.test(request.deliveryId) || !/^[a-z_]{1,100}$/.test(request.event))
      return err({ _tag: 'Configuration', message: 'Webhook body or headers exceed the accepted limits.' })
    const parsed = await Promise.resolve().then(() => JSON.parse(request.body) as unknown).then(ok).catch(() => err({ _tag: 'Configuration', message: 'Webhook body contains invalid JSON.' }))
    if (parsed._tag === 'Err')
      return parsed
    const repo = githubObject(githubObject(parsed.value)?.repository)
    if (request.event !== 'ping' && (typeof repo?.full_name !== 'string' || !repositories.has(repo.full_name.toLowerCase())))
      return err({ _tag: 'Authorization', message: 'The webhook repository is not configured.' })
    const accepted = store.acceptDelivery({ id: request.deliveryId, event: request.event, body: request.body, receivedAt: now().toISOString() })
    return accepted._tag === 'Err' ? accepted : ok({ accepted: true, deliveryId: accepted.value.id, duplicate: accepted.value.duplicate })
  }

  const poll = async (input: { backfill?: boolean, signal?: AbortSignal } = {}): Promise<Result<JsonValue>> => {
    let accepted = 0
    for (const repository of config.repositories) {
      const saved = store.cursor(`poll:${repository.id}`)
      const result = await pollGitHubEvents({ client, repository: repository.fullName, ...(saved ? { cursor: saved as unknown as GitHubPollCursor } : {}), includeExisting: input.backfill === true, now: () => now().getTime(), ...(input.signal ? { signal: input.signal } : {}) })
      if (result._tag === 'Err')
        return result
      for (const event of result.value.events) {
        const processed = await processEvent(event)
        if (processed._tag === 'Err') {
          // Denied actor commands are terminal observations. Other failures retain the cursor for recovery.
          if (processed.error._tag !== 'Authorization')
            return processed
          store.log('command.denied', { eventId: event.id, reason: processed.error.message })
        }
        else {
          accepted++
        }
      }
      store.setCursor(`poll:${repository.id}`, result.value.cursor as unknown as JsonValue)
    }
    lastPollAt = now().getTime()
    return ok({ accepted })
  }
  const lifecycleRun = (run: RunRecord): void => {
    if (run.event.target._tag !== 'PullRequest' || ['command-response', 'review-conversation'].includes(run.definition.id))
      return
    if (run.policy.capabilities.includes('github:check')) {
      const phase = run.state._tag === 'Queued'
        ? { status: 'queued' as const }
        : ['Running', 'Waiting'].includes(run.state._tag)
            ? { status: 'in_progress' as const }
            : { status: 'completed' as const, conclusion: run.state._tag === 'Succeeded' ? 'success' as const : run.state._tag === 'Failed' ? run.state.error.message.toLowerCase().includes('timeout') ? 'timed_out' as const : run.state.error._tag === 'Authorization' ? 'action_required' as const : 'failure' as const : run.state._tag === 'Skipped' ? 'skipped' as const : 'cancelled' as const }
      const effect: PublicationEffect = { _tag: 'Check', repository: run.event.repository.fullName, headSha: run.event.target.headSha, name: `Octorun / ${run.definition.name}`, phase, summary: `${run.definition.name}: ${run.state._tag}.${run.state._tag === 'Failed' ? `\n${run.state.error.message}` : run.state._tag === 'Waiting' ? `\n${run.state.reason}` : ''}` }
      runner.publishSystem(run.id, `check:${digest(effect)}`, effect)
    }
    if (run.policy.capabilities.includes('github:comment') && ['Queued', 'Running', 'Waiting', 'Failed'].includes(run.state._tag) && ['adversarial-review', 'change-summary'].includes(run.definition.id)) {
      const detail = run.state._tag === 'Failed' ? `\n${run.state.error.message}\nInspect this run before requesting another review.` : run.state._tag === 'Waiting' ? `\n${run.state.reason}` : '\nThe result will replace this comment.'
      const effect: PublicationEffect = { _tag: 'Comment', repository: run.event.repository.fullName, number: run.event.target.number, namespace: run.definition.id === 'adversarial-review' ? 'review' : 'change-summary', body: `${run.definition.name}: ${run.state._tag}.\nHead: ${run.event.target.headSha.slice(0, 12)}.${detail}` }
      runner.publishSystem(run.id, `overview:${digest(effect)}`, effect)
    }
  }
  const lifecycle = (): void => {
    for (const run of runner.runs())
      lifecycleRun(run)
  }
  observeRun = lifecycleRun
  const tick = async (): Promise<void> => {
    if (closed)
      return
    for (const delivery of store.pendingDeliveries()) {
      const normalized = await normalizeGitHubWebhook({ client, event: delivery.event, delivery: delivery.id, payload: JSON.parse(delivery.body), now: () => now().getTime(), resolveCheckTarget: async (externalId, headSha) => {
        const run = store.run(externalId.slice('octorun:'.length))
        return run?.event.target._tag === 'PullRequest' && run.event.target.headSha === headSha ? run.event.target : null
      } }).catch(() => err({ _tag: 'Transient', message: 'GitHub delivery processing failed. The delivery remains queued.' }))
      let processed: Result<JsonValue> = normalized._tag === 'Err' ? normalized : ok(null)
      if (normalized._tag === 'Ok') {
        for (const event of normalized.value) {
          processed = await processEvent(event).catch(() => err({ _tag: 'Transient', message: 'GitHub event processing failed. The delivery remains queued.' }))
          if (processed._tag === 'Err')
            break
        }
      }
      if (processed._tag === 'Err') {
        const retry = ['Capacity', 'Transient'].includes(processed.error._tag)
        store.updateDelivery(delivery.id, previous => ({ ...previous, state: retry ? 'Queued' : 'Failed', attempts: previous.attempts + 1, runAfter: processed.error.retryAt ?? new Date(now().getTime() + Math.min(300000, 1000 * 2 ** Math.min(previous.attempts, 8))).toISOString(), error: processed.error }))
      }
      else {
        store.updateDelivery(delivery.id, previous => ({ ...previous, state: 'Processed', attempts: previous.attempts + 1, error: null }))
      }
    }
    lifecycle()
    await runner.tick()
    lifecycle()
  }

  const run = async (input: { repository: string, number: number, workflow?: string, requestId?: string, signal?: AbortSignal }): Promise<Result<JsonValue>> => {
    const requestId = input.requestId ?? randomUUID()
    if (!/^[\w:.-]{1,128}$/.test(requestId))
      return err({ _tag: 'Configuration', message: 'Manual request IDs must contain one to 128 letters, digits, or separators.' })
    const previous = githubObject(store.cursor(`manual:${requestId}`))
    if (previous) {
      if (previous.repository !== input.repository.toLowerCase() || previous.number !== input.number || previous.workflow !== (input.workflow ?? 'adversarial-review'))
        return err({ _tag: 'Configuration', message: 'The manual request ID already identifies different inputs.' })
      const existing = typeof previous.runId === 'string' ? runner.inspect(previous.runId) : null
      return existing ? ok({ runId: existing.id, state: existing.state._tag, targetKey: targetKey(existing.event) }) : err({ _tag: 'Permanent', message: 'The accepted manual request no longer identifies a workflow run.' })
    }
    const repository = configured(input.repository)
    if (repository._tag === 'Err')
      return repository
    const snapshot = await client.snapshot(repository.value.fullName, input.number, input.signal)
    if (snapshot._tag === 'Err')
      return snapshot
    const selected = await definitions(repository.value, input.signal)
    if (selected._tag === 'Err')
      return selected
    const workflow = selected.value.workflows.find(value => value.id === (input.workflow ?? 'adversarial-review'))
    if (!workflow)
      return err({ _tag: 'Configuration', message: 'The requested workflow is not configured for this repository.' })
    const event: EventEnvelope = { id: `manual:${requestId}`, source: 'manual', name: 'pull_request', action: 'manual', repository: snapshot.value.repository, actor: null, target: { _tag: 'PullRequest', number: input.number, headSha: snapshot.value.headSha, baseSha: snapshot.value.baseSha }, occurredAt: now().toISOString(), receivedAt: now().toISOString(), semanticKey: `manual:${requestId}`, data: { draft: snapshot.value.draft, state: snapshot.value.state } }
    const started = startWorkflow(event, workflow, repository.value, selected.value.configuration, requestId)
    if (started._tag === 'Err')
      return started
    store.setCursor(`manual:${requestId}`, { repository: input.repository.toLowerCase(), number: input.number, workflow: workflow.id, runId: started.value.id })
    return ok({ runId: started.value.id, state: started.value.state._tag, targetKey: targetKey(event) })
  }
  const settle = async (): Promise<void> => {
    await tick()
    await runner.drain()
    lifecycle()
    await runner.drain()
  }
  const command = async (name: string, args: Record<string, unknown> = {}): Promise<Result<JsonValue>> => {
    if (name === 'status')
      return ok({ ready: !closed, paused: store.operatorPaused(), runs: runner.runs().map(value => ({ id: value.id, workflow: value.definition.id, repository: value.event.repository.fullName, state: value.state._tag, targetKey: targetKey(value.event) })) })
    if (name === 'inspect') {
      const value = typeof args.runId === 'string' ? runner.inspect(args.runId) : null
      return value ? ok({ ...value, targetKey: targetKey(value.event) } as unknown as JsonValue) : typeof args.runId === 'string' ? err({ _tag: 'Configuration', message: 'The workflow run was not found.' }) : ok(runner.runs() as unknown as JsonValue)
    }
    if (name === 'logs')
      return ok(store.logs({ ...(typeof args.runId === 'string' ? { runId: args.runId } : {}), ...(typeof args.limit === 'number' ? { limit: args.limit } : {}) }) as unknown as JsonValue)
    if (name === 'run') {
      if (typeof args.repository !== 'string' || !githubId(args.number))
        return err({ _tag: 'Configuration', message: 'Run requires a configured repository and pull request number.' })
      const started = await run({ repository: args.repository, number: args.number, ...(typeof args.workflow === 'string' ? { workflow: args.workflow } : {}), ...(typeof args.requestId === 'string' ? { requestId: args.requestId } : {}) })
      if (started._tag === 'Err')
        return started
      await settle()
      const runId = githubObject(started.value)?.runId
      const current = typeof runId === 'string' ? runner.inspect(runId) : null
      return current ? ok({ runId: current.id, state: current.state._tag, targetKey: targetKey(current.event) }) : started
    }
    if (name === 'poll') {
      const observed = await poll({ backfill: args.backfill === true })
      if (observed._tag === 'Err')
        return observed
      await settle()
      return observed
    }
    if (name === 'cancel') {
      if (typeof args.runId !== 'string')
        return err({ _tag: 'Configuration', message: 'Cancel requires a workflow run ID.' })
      const cancelled = runner.cancel(args.runId)
      return cancelled._tag === 'Err' ? cancelled : ok({ runId: cancelled.value.id, state: cancelled.value.state._tag })
    }
    if (name === 'pause' || name === 'resume') {
      if (args.repository === undefined) {
        if (args.number !== undefined || (args.targetKey !== undefined && args.targetKey !== null))
          return err({ _tag: 'Configuration', message: 'Target controls require a configured repository.' })
        store.setOperatorPause(name === 'pause')
        if (name === 'resume')
          await settle()
        return ok({ scope: 'controller', paused: name === 'pause' })
      }
      if (typeof args.repository !== 'string')
        return err({ _tag: 'Configuration', message: 'Pause and resume require a configured repository.' })
      const repository = configured(args.repository)
      if (repository._tag === 'Err')
        return repository
      const target = githubId(args.number) ? `${repository.value.id}:pull_request:${args.number}` : typeof args.targetKey === 'string' ? args.targetKey : null
      runner.pause(repository.value.fullName, target, name === 'pause')
      return ok({ repository: repository.value.fullName, targetKey: target, paused: name === 'pause' })
    }
    if (name === 'drain') {
      store.setOperatorPause(true)
      await runner.drain()
      return ok({ drained: true })
    }
    if (name === 'backup') {
      if (typeof args.destination !== 'string')
        return err({ _tag: 'Configuration', message: 'Backup requires a destination path.' })
      await store.backup(args.destination)
      return ok({ destination: args.destination })
    }
    if (name === 'prune') {
      if (typeof args.before !== 'string' || !Number.isFinite(Date.parse(args.before)))
        return err({ _tag: 'Configuration', message: 'Prune requires an ISO cutoff timestamp.' })
      return ok(store.prune({ before: args.before }))
    }
    if (name === 'plan') {
      if (typeof args.repository !== 'string' || !githubId(args.number))
        return err({ _tag: 'Configuration', message: 'Plan requires a configured repository and pull request number.' })
      if (args.workflow !== undefined && (typeof args.workflow !== 'string' || args.workflow.length === 0))
        return err({ _tag: 'Configuration', message: 'Plan requires a workflow ID when --workflow is supplied.' })
      const repository = configured(args.repository)
      if (repository._tag === 'Err')
        return repository
      const snapshot = await client.snapshot(repository.value.fullName, args.number)
      if (snapshot._tag === 'Err')
        return snapshot
      if (snapshot.value.repository.id !== repository.value.id || snapshot.value.repository.installationId !== repository.value.installationId)
        return err({ _tag: 'Authorization', message: 'The pull request installation does not match the operator configuration.' })
      const source = await definitions(repository.value)
      if (source._tag === 'Err')
        return source
      const workflow = source.value.workflows.find(value => value.id === (args.workflow ?? 'adversarial-review'))
      if (!workflow)
        return err({ _tag: 'Configuration', message: 'The requested workflow is not configured. Choose a configured --workflow ID.' })
      const compiled = compileWorkflow(workflow, taskTypes)
      if (compiled._tag === 'Err')
        return compiled
      const policy = repository.value.policy
      if (!policy.enabled)
        return err({ _tag: 'Authorization', message: 'The repository policy disables workflow execution.' })
      for (const task of workflow.tasks) {
        const type = taskTypes.find(type => type.id === task.uses)!
        if (type.capabilities.some(capability => !policy.capabilities.includes(capability)))
          return err({ _tag: 'Authorization', message: `The repository policy does not grant task ${task.id} its required capabilities.` })
      }
      const target = { _tag: 'PullRequest' as const, number: args.number, headSha: snapshot.value.headSha, baseSha: snapshot.value.baseSha }
      const selector = workflow.on.find(selector => selector.event === 'pull_request' && (selector.actions === undefined || selector.actions.includes('manual')))
      return ok({
        repository: repository.value.fullName,
        target,
        configuration: source.value.configuration,
        policy,
        workflow: { id: workflow.id, name: workflow.name, digest: digest(workflow) },
        selection: selector ? { _tag: 'Matched', selector } : { _tag: 'Manual', reason: 'Manual execution selects this workflow independently of automatic event selectors.' },
        tasks: workflow.tasks.map(task => ({ ...task, typeVersion: compiled.value[task.id]!, capabilities: taskTypes.find(type => type.id === task.uses)!.capabilities, limits: taskLimits(task, workflow) })),
        limits: workflow.limits,
      } as unknown as JsonValue)
    }
    if (name === 'doctor') {
      const results: JsonValue[] = []
      for (const repository of config.repositories) {
        const result = await definitions(repository)
        results.push({ repository: repository.fullName, ok: result._tag === 'Ok', error: result._tag === 'Err' ? result.error.message : null })
      }
      return ok({ ready: results.every(result => githubObject(result)?.ok === true), repositories: results, provider: { model: config.provider.model, configured: true }, webhook: secrets.value.webhookSecret !== null })
    }
    return err({ _tag: 'Configuration', message: 'The local control command is unknown.' })
  }
  const service = {
    store,
    runner,
    client,
    command,
    handleWebhook,
    poll,
    run,
    tick,
    settle,
    async start() {
      if (timer !== null || closed)
        return
      const advance = () => {
        if (ticking || closed)
          return
        ticking = tick().then(async () => {
          if (config.pollIntervalMs > 0 && now().getTime() - lastPollAt >= config.pollIntervalMs) {
            const result = await poll()
            if (result._tag === 'Err')
              store.log('poll.failed', { reason: result.error.message })
          }
        }).catch((error: unknown) => {
          store.log('service.failed', { message: error instanceof Error ? error.message.slice(0, 300) : 'Unexpected service failure.' })
        }).finally(() => { ticking = null })
      }
      timer = setInterval(advance, 250)
      timer.unref()
      advance()
    },
    async close() {
      if (closed)
        return
      closed = true
      if (timer)
        clearInterval(timer)
      await ticking
      await runner.close()
      store.close()
    },
  }
  return ok(service)
}

export type OctorunService = Extract<Awaited<ReturnType<typeof createOctorun>>, { _tag: 'Ok' }>['value']
