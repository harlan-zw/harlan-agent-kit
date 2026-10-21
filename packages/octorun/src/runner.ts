import type { WorkflowStore } from './store.ts'
import type { ConfigurationSource, EventEnvelope, PublicationEffect, PublicationPublisher, PublicationRecord, RepositoryPolicy, Result, RunRecord, TaskFailure, TaskOutcome, TaskRecord, TaskType, Usage, WorkflowDefinition } from './types.ts'
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
const validUsage = (usage: Usage): boolean => Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0 && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0 && (usage.costUsd === null || (Number.isFinite(usage.costUsd) && usage.costUsd >= 0))
const taskUsage = (task: TaskRecord): Usage => task.usageReservations.reduce((usage, reservation) => sumUsage(usage, reservation._tag === 'Reserved' ? reservation.ceiling : reservation.actual), task.unreservedUsage)
const totalUsage = (tasks: TaskRecord[]): Usage => tasks.reduce((usage, task) => sumUsage(usage, task.usage), zeroUsage())
const withinBudget = (run: RunRecord, usage: Usage): boolean => validUsage(usage) && usage.inputTokens + usage.outputTokens <= run.definition.limits.maxTokens && (run.definition.limits.maxCostUsd === null || (usage.costUsd !== null && usage.costUsd <= run.definition.limits.maxCostUsd))
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
  const publishing = new Map<string, { runId: string, controller: AbortController }>()
  let stopping = false
  let closing: Promise<void> | null = null
  let stopExecution: (() => void) | undefined
  const shutdown = new Promise<TaskOutcome>((resolve) => {
    stopExecution = () => resolve({ _tag: 'Failed', error: { _tag: 'Permanent', message: 'The controller is shutting down.' } })
  })
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
    for (const entry of publishing.values()) {
      if (entry.runId === runId)
        entry.controller.abort(new Error(reason))
    }
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
    store.updateRun(run.id, current => ({ ...current, state: { _tag: 'Waiting', reason: 'Recovering interrupted execution.', until: at() }, updatedAt: at(), tasks: current.tasks.map(task => task.state._tag === 'Running' ? { ...task, state: { _tag: 'Waiting', reason: 'Recovering interrupted execution.', until: at() }, fence: task.fence + 1 } : task) }))
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
        id: randomUUID(),
        event,
        definition: workflow,
        definitionDigest,
        configuration: structuredClone(input.configuration),
        policy: structuredClone(input.policy),
        state: workflow.concurrency.mode === 'reject' && others.length ? { _tag: 'Skipped', reason: 'Another workflow run owns this concurrency group.' } : { _tag: 'Queued' },
        tasks: workflow.tasks.map(task => ({ id: task.id, definition: task, typeVersion: compiled.value[task.id]!, state: { _tag: 'Queued' }, attempts: 0, failures: 0, fence: 0, output: null, usage: zeroUsage(), unreservedUsage: zeroUsage(), usageReservations: [], startedAt: null, finishedAt: null })),
        usage: zeroUsage(),
        createdAt: at(),
        updatedAt: at(),
        startedAt: null,
        finishedAt: null,
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
        run: snapshot,
        task,
        event: snapshot.event,
        outputs,
        signal: controller.signal,
        reserveUsage: async (ceiling: Usage): Promise<Result<string>> => {
          if (stopping || controller.signal.aborted)
            return rejected('The task no longer owns execution authority.')
          if (!validUsage(ceiling))
            return configurationError('Usage reservations require nonnegative token counts and known or explicitly unknown costs.')
          const grant = await effectivePolicy(snapshot)
          if (stopping || controller.signal.aborted)
            return rejected('The task no longer owns execution authority.')
          if (grant._tag === 'Err')
            return grant
          if (handler.capabilities.some(capability => !grant.value.capabilities.includes(capability)))
            return rejected('The task lost a required capability before reserving usage.')
          return store.transaction(() => {
            const current = store.run(runId)
            const owned = current?.tasks.find(item => item.id === taskId)
            if (!current || terminal(current.state) || owned?.state._tag !== 'Running' || owned.fence !== task.fence)
              return rejected('The task no longer owns execution authority.')
            if (now().getTime() - Date.parse(current.createdAt) >= current.definition.limits.maxDurationMs)
              return configurationError('The workflow duration budget is exhausted.')
            if (owned.usageReservations.length >= 1024)
              return configurationError('The task exceeded its usage reservation limit.')
            const reservation = { _tag: 'Reserved' as const, id: randomUUID(), fence: task.fence, ceiling: structuredClone(ceiling) }
            const amended = { ...owned, usageReservations: [...owned.usageReservations, reservation] }
            amended.usage = taskUsage(amended)
            const tasks = current.tasks.map(item => item.id === taskId ? amended : item)
            const usage = totalUsage(tasks)
            if (!withinBudget(current, usage))
              return configurationError('The usage reservation exceeds the remaining workflow budget or requires unknown prices.')
            update(runId, run => ({ ...run, tasks, usage }))
            store.log('usage.reserved', { taskId, reservationId: reservation.id, ceiling: { ...ceiling } }, runId)
            return ok(reservation.id)
          })
        },
        settleUsage: async (reservationId: string, actual: Usage): Promise<Result<void>> => {
          if (stopping)
            return rejected('The controller is shutting down. Reserved usage remains charged.')
          if (!validUsage(actual))
            return configurationError('Actual usage requires nonnegative token counts and known or explicitly unknown costs.')
          return store.transaction(() => {
            const current = store.run(runId)
            const owned = current?.tasks.find(item => item.id === taskId)
            const reservation = owned?.usageReservations.find(item => item.id === reservationId && item.fence === task.fence)
            if (!current || !owned || !reservation)
              return rejected('This task attempt does not own that usage reservation.')
            if (reservation._tag === 'Settled')
              return digest(reservation.actual) === digest(actual) ? ok(undefined) : configurationError('The usage reservation already records a different actual result.')
            const amended = { ...owned, usageReservations: owned.usageReservations.map(item => item.id === reservationId ? { ...reservation, _tag: 'Settled' as const, actual: structuredClone(actual) } : item) }
            amended.usage = taskUsage(amended)
            const tasks = current.tasks.map(item => item.id === taskId ? amended : item)
            const usage = totalUsage(tasks)
            update(runId, run => ({ ...run, tasks, usage }))
            store.log('usage.settled', { taskId, reservationId, actual: { ...actual } }, runId)
            if (!withinBudget(current, usage)) {
              const error: TaskFailure = { _tag: 'Permanent', message: 'Reported usage exceeds the workflow budget or requires unknown prices.' }
              failRun(runId, error)
              return err(error)
            }
            if (actual.inputTokens > reservation.ceiling.inputTokens || actual.outputTokens > reservation.ceiling.outputTokens
              || (reservation.ceiling.costUsd !== null && (actual.costUsd === null || actual.costUsd > reservation.ceiling.costUsd))) {
              const error: TaskFailure = { _tag: 'Permanent', message: 'Reported usage exceeds its reserved ceiling.' }
              failRun(runId, error)
              return err(error)
            }
            return ok(undefined)
          })
        },
        publish: async (key: string, effect: PublicationEffect): Promise<Result<string>> => {
          if (stopping || controller.signal.aborted)
            return rejected('The task no longer owns publication authority.')
          const current = store.run(runId)
          if (!current || terminal(current.state) || controller.signal.aborted)
            return rejected('The task no longer owns publication authority.')
          const grant = await effectivePolicy(current)
          if (stopping || controller.signal.aborted)
            return rejected('The task no longer owns publication authority.')
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
      const execution = Promise.resolve().then((): Promise<TaskOutcome> | TaskOutcome => stopping || controller.signal.aborted
        ? { _tag: 'Failed', error: { _tag: 'Authorization', message: 'The task no longer owns execution authority.' } }
        : handler.execute(context, parsed.value)).catch((cause: unknown): TaskOutcome => {
        const message = cause instanceof Error ? cause.message : String(cause)
        if (!stopping)
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
        }, Math.min(taskLimits(task.definition, snapshot.definition).timeoutMs, Math.max(1, snapshot.definition.limits.maxDurationMs - (now().getTime() - Date.parse(snapshot.createdAt)))))
      })
      outcome = await Promise.race([execution, deadline, shutdown])
      clearTimeout(timer)
    }
    if (stopping)
      return
    let reportedUsage = outcome._tag === 'Succeeded' ? outcome.usage : outcome._tag === 'Failed' ? outcome.usage ?? outcome.error.usage : undefined
    if (reportedUsage && !validUsage(reportedUsage)) {
      outcome = { _tag: 'Failed', error: { _tag: 'Permanent', message: 'The task reported invalid token or cost usage.' } }
      reportedUsage = undefined
    }
    let owned = false
    update(runId, (current) => {
      const tasks = current.tasks.map((item): TaskRecord => {
        if (item.id !== taskId)
          return item
        // Reservations account for every paid call in this attempt. Its aggregate is informational.
        const reserved = item.usageReservations.some(reservation => reservation.fence === task.fence)
        const unreservedUsage = reportedUsage && !reserved ? sumUsage(item.unreservedUsage, reportedUsage) : item.unreservedUsage
        item = { ...item, unreservedUsage }
        const usage = taskUsage(item)
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
      })
      return { ...current, tasks, usage: totalUsage(tasks) }
    })
    if (!owned)
      return
    const current = store.run(runId)!
    const limit = current.definition.limits
    if (current.usage.inputTokens + current.usage.outputTokens > limit.maxTokens
      || (limit.maxCostUsd !== null && (current.usage.costUsd === null || current.usage.costUsd > limit.maxCostUsd))
      || now().getTime() - Date.parse(current.createdAt) >= limit.maxDurationMs) {
      failRun(runId, { _tag: 'Permanent', message: 'The workflow execution budget is exhausted or its cost is unknown.' })
      return
    }
    const failed = current.tasks.find(item => item.state._tag === 'Failed')
    if (failed?.state._tag === 'Failed') {
      failRun(runId, failed.state.error)
    }
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
      publishing.set(publication.id, { runId: run.id, controller })
      try {
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
          if (stopping)
            return progressed
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
        if (stopping)
          return progressed
        const allowed = grant._tag === 'Err' ? grant : effectAllowed({ ...current, policy: grant.value }, publication.effect)
        const authorized = allowed._tag === 'Err' ? allowed : await publisher.authorize({ ...context, run: current })
        if (stopping)
          return progressed
        if (authorized._tag === 'Err') {
          store.updatePublication(publication.id, value => ({ ...value, state: { _tag: 'Failed', error: authorized.error }, updatedAt: at() }))
          if (!system)
            failRun(current.id, authorized.error)
          progressed++
          continue
        }
        const latest = store.run(run.id)!
        if (terminal(latest.state) && !terminalSystem && !(system && publication.effect._tag === 'Comment' && ['Failed', 'Succeeded'].includes(latest.state._tag))) {
          store.updatePublication(publication.id, value => ({ ...value, state: { _tag: 'Cancelled', reason: 'The workflow run no longer permits new output.' }, updatedAt: at() }))
          continue
        }
        store.updatePublication(publication.id, value => ({ ...value, state: { _tag: 'Sending' }, attempts: value.attempts + 1, updatedAt: at() }))
        const result = await publisher.publish({ ...context, run: latest })
        if (stopping)
          return progressed
        store.updatePublication(publication.id, value => ({ ...value, state: result._tag === 'Ok' ? { _tag: 'Written', receipt: result.value } : retryable(result.error) && value.attempts < 10 ? { _tag: 'Waiting', until: result.error.retryAt ?? new Date(now().getTime() + 2000 * value.attempts).toISOString(), reason: result.error.message } : { _tag: 'Failed', error: result.error }, updatedAt: at() }))
        store.log('publication.settled', { publicationId: publication.id, outcome: result._tag }, run.id)
        if (result._tag === 'Err' && !retryable(result.error) && !system)
          failRun(run.id, result.error)
        finish(run.id)
        progressed++
      }
      finally {
        publishing.delete(publication.id)
      }
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
      if (stopping)
        return { progressed }
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
      if (run.startedAt === null && !['octorun.command', 'octorun.conversation'].includes(run.event.name) && run.event.source !== 'manual' && store.paused(run.event.repository.fullName, targetKey(run.event)))
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
      if (stopping)
        return { progressed }
      const latestRun = store.run(run.id)
      if (!latestRun || terminal(latestRun.state) || store.operatorPaused())
        continue
      if (latestRun.startedAt === null && !['octorun.command', 'octorun.conversation'].includes(latestRun.event.name) && latestRun.event.source !== 'manual' && store.paused(latestRun.event.repository.fullName, targetKey(latestRun.event)))
        continue
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
    ticking ??= tickOnce().finally(() => {
      ticking = null
    })
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
      while (true) {
        if (stopping)
          return
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
      if (stopping)
        return rejected('The controller is shutting down.')
      const run = store.run(runId)
      if (!run)
        return configurationError('The workflow run does not exist.')
      if (!['Comment', 'Check'].includes(effect._tag))
        return rejected('Lifecycle output supports only comments and checks.')
      const permitted = effectAllowed(run, effect)
      return permitted._tag === 'Err' ? permitted : store.enqueueSystem(prepare(run, '__lifecycle', key, effect))
    },
    close(): Promise<void> {
      closing ??= (async () => {
        stopping = true
        stopExecution!()
        for (const entry of [...active.values(), ...publishing.values()])
          entry.controller.abort(new Error('The controller is shutting down.'))
        await Promise.allSettled([...active.values()].map(entry => entry.promise))
        store.close()
      })()
      return closing
    },
  }
}

export type WorkflowRunner = ReturnType<typeof createRunner>
