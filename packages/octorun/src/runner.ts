import type { WorkflowStore } from './store.ts'
import type { ConfigurationSource, EventEnvelope, JsonValue, PublicationEffect, PublicationPublisher, PublicationRecord, RepositoryPolicy, Result, RunRecord, TaskFailure, TaskOutcome, TaskRecord, TaskType, Usage, WorkflowDefinition } from './types.ts'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { err, isJsonValue, ok } from './types.ts'
import { compileWorkflow, conditionMatches, digest, matchesWorkflow, parseEvent, parseWorkflow, resolveTaskInputs, targetKey, taskLimits } from './workflow.ts'

export interface RunnerOptions {
  store: WorkflowStore
  taskTypes: TaskType[]
  publisher?: PublicationPublisher
  policy?: (run: RunRecord) => Promise<Result<RepositoryPolicy>>
  now?: () => Date
  concurrency?: number
  onRunChanged?: (run: RunRecord) => void
}

export interface StartRunOptions {
  event: EventEnvelope
  workflow: WorkflowDefinition
  policy: RepositoryPolicy
  configuration: ConfigurationSource
  requestId?: string
}

const terminal = (state: { _tag: string }): boolean => ['Succeeded', 'Failed', 'Cancelled', 'Superseded', 'Skipped'].includes(state._tag)
const zeroUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, costUsd: 0 })
const sumUsage = (left: Usage, right: Usage): Usage => ({ inputTokens: left.inputTokens + right.inputTokens, outputTokens: left.outputTokens + right.outputTokens, costUsd: left.costUsd === null || right.costUsd === null ? null : left.costUsd + right.costUsd })
const rejected = (message: string): Result<never> => err({ _tag: 'Authorization', message })
const configurationError = (message: string): Result<never> => err({ _tag: 'Configuration', message })
const retryable = (error: TaskFailure): boolean => error._tag === 'Transient' || error._tag === 'Capacity'
const effectCapability = (effect: PublicationEffect) => effect._tag === 'Review' ? 'github:review' : effect._tag === 'Check' ? 'github:check' : 'github:comment'

export function createRunner(options: RunnerOptions) {
  const { store } = options
  const now = options.now ?? (() => new Date())
  const maximum = Math.max(1, Math.min(100, options.concurrency ?? 4))
  const registry = new Map(options.taskTypes.map(type => [type.id, type]))
  const active = new Map<string, { taskId: string, controller: AbortController, promise: Promise<void>, settled: boolean, lastPolicyCheck: number }>()
  let stopping = false
  let ticking: Promise<{ progressed: number }> | null = null
  let lastRepository = ''
  const at = () => now().toISOString()
  const changed = (run: RunRecord | null): void => {
    if (run)
      options.onRunChanged?.(run)
  }
  const update = (id: string, apply: (run: RunRecord) => RunRecord): RunRecord | null => {
    const next = store.updateRun(id, run => ({ ...apply(run), updatedAt: at() }))
    changed(next)
    return next
  }
  const cancelPending = (runId: string, reason: string): void => {
    for (const publication of store.publications({ runId, states: ['Queued', 'Waiting'] })) {
      if (publication.taskId === '__lifecycle')
        continue
      store.updatePublication(publication.id, current => ({ ...current, state: { _tag: 'Cancelled', reason }, updatedAt: at() }))
    }
  }
  const failRun = (id: string, error: TaskFailure): void => {
    update(id, run => terminal(run.state) ? run : ({ ...run, state: { _tag: 'Failed', error }, finishedAt: at(), tasks: run.tasks.map(task => ['Queued', 'Waiting', 'Running'].includes(task.state._tag) ? { ...task, state: { _tag: 'Cancelled', reason: error.message }, fence: task.fence + 1, finishedAt: at() } : task) }))
    cancelPending(id, error.message)
    active.get(id)?.controller.abort(new Error(error.message))
    store.log('run.failed', { error: error._tag, message: error.message }, id)
  }
  const effectivePolicy = async (run: RunRecord): Promise<Result<RepositoryPolicy>> => {
    const resolved = options.policy ? await options.policy(run) : ok(run.policy)
    if (resolved._tag === 'Err')
      return resolved
    if (!run.policy.enabled || !resolved.value.enabled)
      return rejected('Repository execution authority has been revoked.')
    return ok({ enabled: true, capabilities: run.policy.capabilities.filter(capability => resolved.value.capabilities.includes(capability)), maxConcurrency: Math.min(run.policy.maxConcurrency, resolved.value.maxConcurrency) })
  }
  const effectAllowed = (run: RunRecord, effect: PublicationEffect): Result<void> => {
    if (effect.repository !== run.event.repository.fullName || !run.policy.capabilities.includes(effectCapability(effect)))
      return rejected('This run cannot publish that repository effect.')
    const target = run.event.target
    if ('number' in effect && (target._tag === 'Revision' || effect.number !== target.number))
      return rejected('The publication does not match the accepted GitHub target.')
    if ('headSha' in effect && effect.headSha !== (target._tag === 'PullRequest' ? target.headSha : target._tag === 'Revision' ? target.sha : null))
      return rejected('The publication does not match the accepted revision.')
    if (!isJsonValue(effect) || JSON.stringify(effect).length > 1048576)
      return configurationError('Publication output must be bounded JSON data.')
    return ok(undefined)
  }
  const prepare = (run: RunRecord, taskId: string, key: string, effect: PublicationEffect): PublicationRecord => ({ id: randomUUID(), key, runId: run.id, taskId, effect, state: { _tag: 'Queued' }, attempts: 0, createdAt: at(), updatedAt: at() })

  for (const run of store.runs({ states: ['Queued', 'Running', 'Waiting'], limit: 10000 })) {
    if (!run.tasks.some(task => task.state._tag === 'Running'))
      continue
    store.updateRun(run.id, current => ({ ...current, state: { _tag: 'Waiting', reason: 'Recovering interrupted execution.', until: at() }, updatedAt: at(), tasks: current.tasks.map(task => task.state._tag === 'Running' ? { ...task, state: { _tag: 'Waiting', reason: 'Recovering interrupted execution.', until: at() }, fence: task.fence + 1, failures: task.failures + 1 } : task) }))
    store.log('run.recovered', { reason: 'The previous controller stopped during execution.' }, run.id)
  }
  for (const publication of store.publications({ states: ['Sending'] }))
    store.updatePublication(publication.id, current => ({ ...current, state: { _tag: 'Waiting', until: new Date(now().getTime() + 1000).toISOString(), reason: 'Reconciling an interrupted GitHub write.' }, updatedAt: at() }))

  const start = (input: StartRunOptions): Result<RunRecord> => {
    if (stopping)
      return rejected('The controller is draining. Start work after it resumes.')
    const parsedEvent = parseEvent(input.event)
    const parsedWorkflow = parseWorkflow(input.workflow)
    if (parsedEvent._tag === 'Err')
      return parsedEvent
    if (parsedWorkflow._tag === 'Err')
      return parsedWorkflow
    const compiled = compileWorkflow(parsedWorkflow.value, options.taskTypes)
    if (compiled._tag === 'Err')
      return compiled
    if (!input.policy.enabled || !Number.isSafeInteger(input.policy.maxConcurrency) || input.policy.maxConcurrency < 1)
      return rejected('The repository policy does not permit execution.')
    const workflow = parsedWorkflow.value
    for (const task of workflow.tasks) {
      if (registry.get(task.uses)!.capabilities.some(capability => !input.policy.capabilities.includes(capability)))
        return rejected(`The repository policy does not grant task ${task.id} its required capabilities.`)
    }
    const event = parsedEvent.value
    const definitionDigest = digest(workflow)
    const trigger = digest({ repository: event.repository.id, installation: event.repository.installationId, workflow: workflow.id, definitionDigest, configuration: input.configuration.digest, request: input.requestId ?? event.semanticKey })
    const previous = store.runByTrigger(trigger)
    if (previous) {
      if (input.requestId && digest({ target: previous.event.target, data: previous.event.data }) !== digest({ target: event.target, data: event.data }))
        return configurationError('The manual request ID already identifies a different target or input.')
      return ok(previous)
    }
    return store.transaction(() => {
      const accepted = store.recordEvent(event)
      if (accepted._tag === 'Err')
        return accepted
      const group = `${event.repository.id}:${workflow.id}:${workflow.concurrency.group === 'repository' ? '*' : targetKey(event)}`
      const others = store.runs({ group, states: ['Queued', 'Running', 'Waiting'] })
      const run: RunRecord = {
        id: randomUUID(), event, definition: workflow, definitionDigest, configuration: structuredClone(input.configuration), policy: structuredClone(input.policy),
        state: workflow.concurrency.mode === 'reject' && others.length ? { _tag: 'Skipped', reason: 'Another workflow run owns this concurrency group.' } : { _tag: 'Queued' },
        tasks: workflow.tasks.map(task => ({ id: task.id, definition: task, typeVersion: compiled.value[task.id]!, state: { _tag: 'Queued' }, attempts: 0, failures: 0, fence: 0, output: null, usage: zeroUsage(), startedAt: null, finishedAt: null })),
        usage: zeroUsage(), createdAt: at(), updatedAt: at(), startedAt: null, finishedAt: null,
      }
      const created = store.createRun(run, { trigger, group })
      if (!created.duplicate && workflow.concurrency.mode === 'replace') {
        for (const previous of others) {
          update(previous.id, value => ({ ...value, state: { _tag: 'Superseded', byRunId: run.id }, finishedAt: at(), tasks: value.tasks.map(task => terminal(task.state) ? task : { ...task, state: { _tag: 'Cancelled', reason: 'A newer workflow run superseded this work.' }, fence: task.fence + 1, finishedAt: at() }) }))
          cancelPending(previous.id, 'A newer workflow run superseded this work.')
          active.get(previous.id)?.controller.abort(new Error('The workflow run was superseded.'))
        }
      }
      changed(created.run)
      return ok(created.run)
    })
  }

  const finish = (runId: string): void => {
    const run = store.run(runId)
    if (!run || terminal(run.state) || run.tasks.some(task => !terminal(task.state)))
      return
    const publications = store.publications({ runId }).filter(publication => publication.taskId !== '__lifecycle')
    const failed = publications.find(publication => publication.state._tag === 'Failed')
    if (failed?.state._tag === 'Failed') {
      failRun(runId, failed.state.error)
      return
    }
    if (publications.some(publication => publication.state._tag !== 'Written'))
      return
    update(runId, current => ({ ...current, state: { _tag: 'Succeeded' }, finishedAt: at() }))
    store.log('run.succeeded', { workflow: run.definition.id }, runId)
  }

  const executeTask = async (runId: string, taskId: string, controller: AbortController): Promise<void> => {
    const snapshot = store.run(runId)!
    const task = snapshot.tasks.find(value => value.id === taskId)!
    const handler = registry.get(task.definition.uses)!
    const outputs = Object.fromEntries(snapshot.tasks.filter(value => value.state._tag === 'Succeeded').map(value => [value.id, value.output]))
    const resolved = resolveTaskInputs(task.definition.with, outputs, snapshot.event)
    const parsed = resolved._tag === 'Err' ? resolved : handler.input(resolved.value)
    let outcome: TaskOutcome
    if (parsed._tag === 'Err') {
      outcome = { _tag: 'Failed', error: parsed.error }
    }
    else {
      const context = {
        run: snapshot, task, event: snapshot.event, outputs, signal: controller.signal,
        publish: async (key: string, effect: PublicationEffect): Promise<Result<string>> => {
          const current = store.run(runId)
          if (!current || terminal(current.state) || controller.signal.aborted)
            return rejected('The task no longer owns publication authority.')
          const grant = await effectivePolicy(current)
          if (grant._tag === 'Err')
            return grant
          const allowed = effectAllowed({ ...current, policy: grant.value }, effect)
          if (allowed._tag === 'Err')
            return allowed
          if (!key || key.length > 256)
            return configurationError('The publication key must contain between 1 and 256 characters.')
          return store.enqueue(prepare(current, taskId, key, effect), task.fence)
        },
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      const execution = handler.execute(context, parsed.value).catch((cause: unknown): TaskOutcome => {
        const message = cause instanceof Error ? cause.message : String(cause)
        store.log('task.exception', { taskId, message }, runId)
        return { _tag: 'Failed', error: { _tag: 'Permanent', message: `Task ${taskId} failed unexpectedly: ${message}` } }
      })
      execution.then(() => {
        const entry = active.get(runId)
        if (entry?.taskId === taskId) {
          entry.settled = true
          if (controller.signal.aborted)
            active.delete(runId)
        }
      })
      const deadline = new Promise<TaskOutcome>((resolve) => {
        timer = setTimeout(() => {
          controller.abort(new Error('The task exceeded its execution timeout.'))
          resolve({ _tag: 'Failed', error: { _tag: 'Permanent', message: 'The task exceeded its execution timeout.' } })
        }, taskLimits(task.definition, snapshot.definition).timeoutMs)
      })
      outcome = await Promise.race([execution, deadline])
      clearTimeout(timer)
    }
    if (stopping)
      return
    const reportedUsage = outcome._tag === 'Succeeded' ? outcome.usage : outcome._tag === 'Failed' ? outcome.usage ?? outcome.error.usage : undefined
    let owned = false
    update(runId, current => ({ ...current, usage: reportedUsage ? sumUsage(current.usage, reportedUsage) : current.usage, tasks: current.tasks.map((item) => {
      if (item.id !== taskId)
        return item
      const usage = reportedUsage ? sumUsage(item.usage, reportedUsage) : item.usage
      if (item.state._tag !== 'Running' || item.fence !== task.fence || terminal(current.state))
        return { ...item, usage }
      owned = true
      if (outcome._tag === 'Succeeded') {
        const output = handler.output(outcome.output)
        if (output._tag === 'Err' || !isJsonValue(outcome.output) || JSON.stringify(outcome.output).length > 1048576)
          outcome = { _tag: 'Failed', error: output._tag === 'Err' ? output.error : { _tag: 'Permanent', message: 'The task output exceeded the JSON data limit.' } }
        else
          return { ...item, state: { _tag: 'Succeeded' }, output: output.value, usage, finishedAt: at() }
      }
      if (outcome._tag === 'Deferred')
        return { ...item, state: { _tag: 'Waiting', reason: outcome.reason, until: outcome.until }, usage }
      const error = outcome._tag === 'Failed' ? outcome.error : { _tag: 'Permanent' as const, message: 'The task returned an invalid outcome.' }
      if (error._tag === 'Capacity')
        return { ...item, state: { _tag: 'Waiting', reason: error.message, until: error.retryAt ?? new Date(now().getTime() + 30000).toISOString() }, usage }
      const failures = item.failures + 1
      return { ...item, failures, usage, state: retryable(error) && failures < taskLimits(item.definition, current.definition).maxAttempts ? { _tag: 'Waiting', reason: error.message, until: error.retryAt ?? new Date(now().getTime() + Math.min(60000, 1000 * 2 ** failures)).toISOString() } : { _tag: 'Failed', error }, finishedAt: retryable(error) && failures < taskLimits(item.definition, current.definition).maxAttempts ? null : at() }
    }) }))
    if (!owned)
      return
    const current = store.run(runId)!
    const failed = current.tasks.find(item => item.state._tag === 'Failed')
    if (failed?.state._tag === 'Failed')
      failRun(runId, failed.state.error)
    else {
      const waiting = current.tasks.find(item => item.state._tag === 'Waiting')
      if (waiting?.state._tag === 'Waiting')
        update(runId, run => ({ ...run, state: { _tag: 'Waiting', until: waiting.state._tag === 'Waiting' ? waiting.state.until : at(), reason: waiting.state._tag === 'Waiting' ? waiting.state.reason : 'Waiting for capacity.' } }))
      finish(runId)
    }
    store.log('task.settled', { taskId, outcome: outcome._tag }, runId)
  }

  const flushPublications = async (): Promise<number> => {
    let progressed = 0
    for (const publication of store.publications({ states: ['Queued', 'Sending', 'Waiting'] })) {
      if (publication.state._tag === 'Waiting' && publication.state.until > at())
        continue
      const run = store.run(publication.runId)
      if (!run)
        continue
      const system = publication.taskId === '__lifecycle'
      const task = run.tasks.find(item => item.id === publication.taskId)
      if (!system && task?.state._tag !== 'Succeeded' && !terminal(run.state))
        continue
      const controller = new AbortController()
      const context = { publication, run, signal: controller.signal }
      const publisher = options.publisher
      if (!publisher) {
        store.updatePublication(publication.id, value => ({ ...value, state: { _tag: 'Failed', error: { _tag: 'Configuration', message: 'No publication adapter is configured.' } }, updatedAt: at() }))
        if (!system)
          failRun(run.id, { _tag: 'Configuration', message: 'No publication adapter is configured.' })
        progressed++
        continue
      }
      if (publication.attempts > 0) {
        const reconciled = await publisher.reconcile(context)
        if (reconciled._tag === 'Ok' && reconciled.value !== null) {
          store.updatePublication(publication.id, value => ({ ...value, state: { _tag: 'Written', receipt: reconciled.value! }, updatedAt: at() }))
          finish(run.id)
          progressed++
          continue
        }
        if (reconciled._tag === 'Err') {
          const error = reconciled.error
          store.updatePublication(publication.id, value => ({ ...value, state: retryable(error) ? { _tag: 'Waiting', until: error.retryAt ?? new Date(now().getTime() + 30000).toISOString(), reason: error.message } : { _tag: 'Failed', error }, updatedAt: at() }))
          progressed++
          continue
        }
      }
      const current = store.run(run.id)!
      const terminalSystem = system && publication.effect._tag === 'Check' && publication.effect.phase.status === 'completed'
      if (terminal(current.state) && !terminalSystem && !(system && publication.effect._tag === 'Comment' && ['Failed', 'Succeeded'].includes(current.state._tag))) {
        store.updatePublication(publication.id, value => ({ ...value, state: { _tag: 'Cancelled', reason: 'The workflow run no longer permits new output.' }, updatedAt: at() }))
        progressed++
        continue
      }
      const grant = await effectivePolicy(current)
      const allowed = grant._tag === 'Err' ? grant : effectAllowed({ ...current, policy: grant.value }, publication.effect)
      const authorized = allowed._tag === 'Err' ? allowed : await publisher.authorize({ ...context, run: current })
      if (authorized._tag === 'Err') {
        store.updatePublication(publication.id, value => ({ ...value, state: { _tag: 'Failed', error: authorized.error }, updatedAt: at() }))
        if (!system)
          failRun(current.id, authorized.error)
        progressed++
        continue
      }
      const latest = store.run(run.id)!
      if (terminal(latest.state) && !terminalSystem && !system)
        continue
      store.updatePublication(publication.id, value => ({ ...value, state: { _tag: 'Sending' }, attempts: value.attempts + 1, updatedAt: at() }))
      const result = await publisher.publish({ ...context, run: latest })
      store.updatePublication(publication.id, value => ({ ...value, state: result._tag === 'Ok' ? { _tag: 'Written', receipt: result.value } : retryable(result.error) && value.attempts < 10 ? { _tag: 'Waiting', until: result.error.retryAt ?? new Date(now().getTime() + 2000 * value.attempts).toISOString(), reason: result.error.message } : { _tag: 'Failed', error: result.error }, updatedAt: at() }))
      store.log('publication.settled', { publicationId: publication.id, outcome: result._tag }, run.id)
      if (result._tag === 'Err' && !retryable(result.error) && !system)
        failRun(run.id, result.error)
      finish(run.id)
      progressed++
    }
    return progressed
  }

  const tickOnce = async (): Promise<{ progressed: number }> => {
    if (stopping)
      return { progressed: 0 }
    let progressed = 0
    for (const [runId, entry] of active) {
      if (now().getTime() - entry.lastPolicyCheck < 5000)
        continue
      entry.lastPolicyCheck = now().getTime()
      const run = store.run(runId)
      if (!run || terminal(run.state))
        continue
      const grant = await effectivePolicy(run)
      const type = registry.get(run.tasks.find(task => task.id === entry.taskId)!.definition.uses)
      if (grant._tag === 'Err' || type?.capabilities.some(capability => !grant.value.capabilities.includes(capability)))
        failRun(runId, grant._tag === 'Err' ? grant.error : { _tag: 'Authorization', message: 'The active task lost a required capability.' })
    }
    const candidates = store.runs({ states: ['Queued', 'Running', 'Waiting'], limit: 10000 })
    const repositories = [...new Set(candidates.map(run => run.event.repository.fullName))]
    const lastIndex = repositories.indexOf(lastRepository)
    const ordered = lastIndex < 0 ? candidates : [...repositories.slice(lastIndex + 1), ...repositories.slice(0, lastIndex + 1)].flatMap(repository => candidates.filter(run => run.event.repository.fullName === repository))
    for (const run of ordered) {
      finish(run.id)
      if (active.size >= maximum || active.has(run.id) || terminal(store.run(run.id)!.state) || store.operatorPaused())
        continue
      if (run.startedAt === null && run.event.name !== 'octorun.command' && run.event.source !== 'manual' && store.paused(run.event.repository.fullName, targetKey(run.event)))
        continue
      const group = `${run.event.repository.id}:${run.definition.id}:${run.definition.concurrency.group === 'repository' ? '*' : targetKey(run.event)}`
      const groupRuns = store.runs({ group, states: ['Queued', 'Running', 'Waiting'] })
      if (run.definition.concurrency.mode === 'queue' && groupRuns[0]?.id !== run.id)
        continue
      const task = run.tasks.find(item => !['Succeeded', 'Skipped'].includes(item.state._tag))
      if (!task || task.state._tag === 'Running' || (task.state._tag === 'Waiting' && task.state.until > at()))
        continue
      const limit = run.definition.limits
      if (now().getTime() - Date.parse(run.createdAt) >= limit.maxDurationMs || run.usage.inputTokens + run.usage.outputTokens >= limit.maxTokens || (limit.maxCostUsd !== null && (run.usage.costUsd === null || run.usage.costUsd >= limit.maxCostUsd))) {
        failRun(run.id, { _tag: 'Permanent', message: 'The workflow execution budget is exhausted or its cost is unknown.' })
        progressed++
        continue
      }
      const handler = registry.get(task.definition.uses)
      if (!handler || handler.version !== task.typeVersion) {
        failRun(run.id, { _tag: 'Configuration', message: `Task type ${task.definition.uses}@${task.typeVersion} is unavailable. Install a compatible implementation.` })
        progressed++
        continue
      }
      if (task.failures >= taskLimits(task.definition, run.definition).maxAttempts) {
        failRun(run.id, { _tag: 'Permanent', message: 'The task exhausted its execution attempts.' })
        progressed++
        continue
      }
      const grant = await effectivePolicy(run)
      if (grant._tag === 'Err' || handler.capabilities.some(capability => !grant.value.capabilities.includes(capability))) {
        failRun(run.id, grant._tag === 'Err' ? grant.error : { _tag: 'Authorization', message: 'The task lost a required capability.' })
        progressed++
        continue
      }
      const repositoryActive = [...active.keys()].filter(id => store.run(id)?.event.repository.id === run.event.repository.id).length
      if (repositoryActive >= grant.value.maxConcurrency)
        continue
      if (task.definition.when && !conditionMatches(task.definition.when, run)) {
        update(run.id, current => ({ ...current, tasks: current.tasks.map(item => item.id === task.id ? { ...item, state: { _tag: 'Skipped', reason: 'The task condition did not match.' }, finishedAt: at() } : item) }))
        progressed++
        continue
      }
      const controller = new AbortController()
      update(run.id, current => ({ ...current, state: { _tag: 'Running' }, startedAt: current.startedAt ?? at(), tasks: current.tasks.map(item => item.id === task.id ? { ...item, attempts: item.attempts + 1, fence: item.fence + 1, startedAt: at(), state: { _tag: 'Running', leaseUntil: new Date(now().getTime() + taskLimits(item.definition, current.definition).timeoutMs + 30000).toISOString() } } : item) }))
      const entry = { taskId: task.id, controller, promise: Promise.resolve(), settled: false, lastPolicyCheck: now().getTime() }
      active.set(run.id, entry)
      entry.promise = executeTask(run.id, task.id, controller).finally(() => {
        if (entry.settled || !controller.signal.aborted)
          active.delete(run.id)
      })
      lastRepository = run.event.repository.fullName
      progressed++
    }
    progressed += await flushPublications()
    return { progressed }
  }
  const tick = (): Promise<{ progressed: number }> => {
    ticking ??= tickOnce().finally(() => { ticking = null })
    return ticking
  }

  return {
    start,
    ingest(event: EventEnvelope, workflows: WorkflowDefinition[], policy: RepositoryPolicy, configuration: ConfigurationSource): Result<{ eventId: string, runIds: string[], duplicate: boolean }> {
      const parsed = parseEvent(event)
      if (parsed._tag === 'Err')
        return parsed
      return store.transaction(() => {
        const accepted = store.recordEvent(parsed.value)
        if (accepted._tag === 'Err')
          return accepted
        const runIds: string[] = []
        for (const workflow of workflows.filter(definition => matchesWorkflow(definition, parsed.value))) {
          const run = start({ event: parsed.value, workflow, policy, configuration })
          if (run._tag === 'Err')
            return run
          runIds.push(run.value.id)
        }
        return ok({ eventId: event.id, runIds, duplicate: accepted.value.duplicate })
      })
    },
    tick,
    async drain(): Promise<void> {
      const deadline = Date.now() + 300000
      while (!stopping) {
        const result = await tick()
        if (active.size === 0 && result.progressed === 0)
          return
        if (Date.now() > deadline)
          throw new Error('Workflow drain exceeded five minutes. Inspect active tasks before restarting.')
        if (active.size > 0)
          await Promise.race([...active.values()].map(value => value.promise).concat(delay(20)))
      }
    },
    cancel(runId: string, reason = 'A maintainer cancelled this workflow run.'): Result<RunRecord> {
      const run = store.run(runId)
      if (!run)
        return configurationError('The workflow run does not exist.')
      if (terminal(run.state))
        return ok(run)
      const cancelled = update(runId, current => ({ ...current, state: { _tag: 'Cancelled', reason }, finishedAt: at(), tasks: current.tasks.map(task => terminal(task.state) ? task : { ...task, state: { _tag: 'Cancelled', reason }, fence: task.fence + 1, finishedAt: at() }) }))!
      cancelPending(runId, reason)
      active.get(runId)?.controller.abort(new Error(reason))
      return ok(cancelled)
    },
    pause(repository: string, target: string | null, paused: boolean): void {
      store.setPause(repository, target, paused)
    },
    inspect: store.run,
    runs: store.runs,
    publishSystem(runId: string, key: string, effect: PublicationEffect): Result<string> {
      const run = store.run(runId)
      if (!run)
        return configurationError('The workflow run does not exist.')
      if (!['Comment', 'Check'].includes(effect._tag))
        return rejected('Lifecycle output supports only comments and checks.')
      const permitted = effectAllowed(run, effect)
      return permitted._tag === 'Err' ? permitted : store.enqueueSystem(prepare(run, '__lifecycle', key, effect))
    },
    async close(): Promise<void> {
      stopping = true
      for (const entry of active.values())
        entry.controller.abort(new Error('The controller is shutting down.'))
      await Promise.allSettled([...active.values()].map(entry => entry.promise))
      store.close()
    },
  }
}

export type WorkflowRunner = ReturnType<typeof createRunner>
