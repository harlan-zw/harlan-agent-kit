import type { EventEnvelope, JsonObject, JsonValue, Result, TaskCondition, TaskDefinition, TaskLimits, TaskType, WorkflowDefinition, WorkflowLimits } from './types.ts'
import { createHash } from 'node:crypto'
import { err, isJsonValue, ok } from './types.ts'

const identifier = /^[a-z][\w-]{0,63}$/
const taskTypeName = /^[\w./@:-]{1,128}$/
const sha = /^[a-f\d]{40}(?:[a-f\d]{24})?$/i
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype'])
const defaults: WorkflowLimits = { maxAttempts: 3, timeoutMs: 300000, maxTokens: 100000, maxCostUsd: null, maxDurationMs: 1800000 }

const record = (input: unknown): input is Record<string, unknown> => input !== null && typeof input === 'object' && !Array.isArray(input) && Object.getPrototypeOf(input) === Object.prototype
const allowed = (input: Record<string, unknown>, keys: string[]) => Object.keys(input).every(key => keys.includes(key))
const positive = (input: unknown, maximum: number): input is number => Number.isSafeInteger(input) && Number(input) > 0 && Number(input) <= maximum
const text = (input: unknown, maximum = 1024): input is string => typeof input === 'string' && input.length > 0 && input.length <= maximum
const invalid = (message: string): Result<never> => err({ _tag: 'Configuration', message })

export function digest(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input)
    ? input.map(canonical)
    : record(input)
      ? Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key])]))
      : input
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

function parseLimits(input: unknown, workflow: boolean): Result<WorkflowLimits> {
  if (input === undefined)
    return ok({ ...defaults })
  if (!record(input) || !allowed(input, workflow ? ['maxAttempts', 'timeoutMs', 'maxTokens', 'maxCostUsd', 'maxDurationMs'] : ['maxAttempts', 'timeoutMs']))
    return invalid('limits: Expected supported limit fields.')
  const value = { ...defaults, ...input }
  if (!positive(value.maxAttempts, 100) || !positive(value.timeoutMs, 86400000) || !positive(value.maxTokens, 100000000) || !positive(value.maxDurationMs, 604800000))
    return invalid('limits: Expected positive, bounded execution limits.')
  if (value.maxCostUsd !== null && (typeof value.maxCostUsd !== 'number' || !Number.isFinite(value.maxCostUsd) || value.maxCostUsd < 0))
    return invalid('limits.maxCostUsd: Expected a nonnegative number or null.')
  return ok(value)
}

function parseCondition(input: unknown, prior: Set<string>, depth = 0): Result<TaskCondition> {
  if (depth > 10 || !record(input))
    return invalid('when: Expected a bounded task condition.')
  if (input._tag === 'EventAction' && allowed(input, ['_tag', 'action']) && text(input.action, 64))
    return ok({ _tag: 'EventAction', action: input.action })
  if (input._tag === 'Succeeded' && allowed(input, ['_tag', 'task']) && typeof input.task === 'string' && prior.has(input.task))
    return ok({ _tag: 'Succeeded', task: input.task })
  if (input._tag === 'OutputEquals' && allowed(input, ['_tag', 'task', 'path', 'value']) && typeof input.task === 'string' && prior.has(input.task) && typeof input.path === 'string' && validPath(input.path) && isJsonValue(input.value))
    return ok({ _tag: 'OutputEquals', task: input.task, path: input.path, value: input.value })
  if (input._tag === 'Not' && allowed(input, ['_tag', 'condition'])) {
    const parsed = parseCondition(input.condition, prior, depth + 1)
    return parsed._tag === 'Err' ? parsed : ok({ _tag: 'Not', condition: parsed.value })
  }
  return invalid('when: Expected a supported condition using an earlier task.')
}

const validPath = (path: string): boolean => path === '' || path.split('.').every(part => part.length > 0 && !unsafeKeys.has(part))

function references(input: JsonValue, prior: Set<string>): boolean {
  if (Array.isArray(input))
    return input.every(value => references(value, prior))
  if (!record(input))
    return true
  if ('$ref' in input) {
    if (Object.keys(input).length !== 1 || typeof input.$ref !== 'string' || !validPath(input.$ref))
      return false
    if (input.$ref === 'event' || input.$ref.startsWith('event.'))
      return true
    const match = /^tasks\.([\w-]+)\.output(?:\.(.+))?$/.exec(input.$ref)
    return match !== null && prior.has(match[1]!)
  }
  return Object.values(input).every(value => references(value as JsonValue, prior))
}

export function parseWorkflow(input: unknown): Result<WorkflowDefinition> {
  if (!record(input) || !allowed(input, ['version', 'id', 'name', 'on', 'tasks', 'concurrency', 'limits']))
    return invalid('workflow: Expected supported workflow fields.')
  if (input.version !== 1 || typeof input.id !== 'string' || !identifier.test(input.id) || !text(input.name, 128))
    return invalid('workflow: Expected version 1, a valid id, and a name.')
  if (!Array.isArray(input.on) || input.on.length > 64)
    return invalid('workflow.on: Expected at most 64 event selectors.')
  const selectors: WorkflowDefinition['on'] = []
  for (const selector of input.on) {
    if (!record(selector) || !allowed(selector, ['event', 'actions']) || !text(selector.event, 64) || (selector.actions !== undefined && (!Array.isArray(selector.actions) || selector.actions.length > 64 || !selector.actions.every(action => text(action, 64)))))
      return invalid('workflow.on: Expected event names and optional action lists.')
    selectors.push({ event: selector.event, ...(selector.actions === undefined ? {} : { actions: selector.actions as string[] }) })
  }
  if (!Array.isArray(input.tasks) || input.tasks.length === 0 || input.tasks.length > 128)
    return invalid('workflow.tasks: Expected between 1 and 128 tasks.')
  const tasks: TaskDefinition[] = []
  const prior = new Set<string>()
  for (const task of input.tasks) {
    if (!record(task) || !allowed(task, ['id', 'uses', 'with', 'when', 'limits']) || typeof task.id !== 'string' || !identifier.test(task.id) || prior.has(task.id) || typeof task.uses !== 'string' || !taskTypeName.test(task.uses))
      return invalid('workflow.tasks: Expected unique task ids and registered task types.')
    const inputs = task.with ?? {}
    if (!record(inputs) || !isJsonValue(inputs) || JSON.stringify(inputs).length > 1048576 || !references(inputs, prior))
      return invalid(`workflow.tasks.${task.id}.with: Expected bounded inputs referencing only earlier tasks.`)
    const limits = parseLimits(task.limits, false)
    if (limits._tag === 'Err')
      return limits
    const condition = task.when === undefined ? undefined : parseCondition(task.when, prior)
    if (condition?._tag === 'Err')
      return condition
    tasks.push({ id: task.id, uses: task.uses, with: inputs as JsonObject, ...(condition === undefined ? {} : { when: condition.value }), ...(task.limits === undefined ? {} : { limits: { maxAttempts: limits.value.maxAttempts, timeoutMs: limits.value.timeoutMs } }) })
    prior.add(task.id)
  }
  const concurrency = input.concurrency ?? { mode: 'replace', group: 'target' }
  if (!record(concurrency) || !allowed(concurrency, ['mode', 'group']) || !['replace', 'queue', 'reject'].includes(String(concurrency.mode)) || !['target', 'repository'].includes(String(concurrency.group)))
    return invalid('workflow.concurrency: Expected mode replace, queue, or reject and group target or repository.')
  const limits = parseLimits(input.limits, true)
  if (limits._tag === 'Err')
    return limits
  return ok({ version: 1, id: input.id, name: input.name, on: selectors, tasks, concurrency: concurrency as WorkflowDefinition['concurrency'], limits: limits.value })
}

export function parseEvent(input: unknown): Result<EventEnvelope> {
  if (!record(input) || !allowed(input, ['id', 'source', 'name', 'action', 'repository', 'actor', 'target', 'occurredAt', 'receivedAt', 'semanticKey', 'data']))
    return invalid('event: Expected supported event fields.')
  if (!text(input.id, 512) || !text(input.name, 128) || typeof input.action !== 'string' || input.action.length > 128 || !text(input.semanticKey, 2048) || !['webhook', 'poll', 'manual'].includes(String(input.source)))
    return invalid('event: Expected identity, source, name, action, and semantic key.')
  const repository = input.repository
  if (!record(repository) || !allowed(repository, ['id', 'fullName', 'installationId']) || !positive(repository.id, Number.MAX_SAFE_INTEGER) || !positive(repository.installationId, Number.MAX_SAFE_INTEGER) || typeof repository.fullName !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository.fullName))
    return invalid('event.repository: Expected a stable repository and installation identity.')
  const actor = input.actor
  if (actor !== null && (!record(actor) || !allowed(actor, ['id', 'login', 'kind']) || !positive(actor.id, Number.MAX_SAFE_INTEGER) || !text(actor.login, 128) || !['User', 'Bot'].includes(String(actor.kind))))
    return invalid('event.actor: Expected a GitHub actor or null.')
  const target = input.target
  if (!record(target))
    return invalid('event.target: Expected a typed GitHub target.')
  const validTarget = (target._tag === 'PullRequest' && allowed(target, ['_tag', 'number', 'headSha', 'baseSha']) && positive(target.number, Number.MAX_SAFE_INTEGER) && typeof target.headSha === 'string' && sha.test(target.headSha) && typeof target.baseSha === 'string' && sha.test(target.baseSha))
    || (target._tag === 'Issue' && allowed(target, ['_tag', 'number']) && positive(target.number, Number.MAX_SAFE_INTEGER))
    || (target._tag === 'Revision' && allowed(target, ['_tag', 'sha', 'ref']) && typeof target.sha === 'string' && sha.test(target.sha) && text(target.ref, 512))
  if (!validTarget || !text(input.occurredAt) || !Number.isFinite(Date.parse(input.occurredAt)) || !text(input.receivedAt) || !Number.isFinite(Date.parse(input.receivedAt)))
    return invalid('event: Expected a valid target and timestamps.')
  if (!isJsonValue(input.data) || JSON.stringify(input.data).length > 1048576)
    return invalid('event.data: Expected bounded JSON data.')
  return ok(input as unknown as EventEnvelope)
}

export function targetKey(event: EventEnvelope): string {
  switch (event.target._tag) {
    case 'PullRequest': return `${event.repository.id}:pull_request:${event.target.number}`
    case 'Issue': return `${event.repository.id}:issue:${event.target.number}`
    case 'Revision': return `${event.repository.id}:revision:${event.target.ref}`
  }
}

export function matchesWorkflow(workflow: WorkflowDefinition, event: EventEnvelope): boolean {
  return workflow.on.some(selector => selector.event === event.name && (selector.actions === undefined || selector.actions.includes(event.action)))
}

function pathValue(input: unknown, path: string): unknown {
  if (path === '')
    return input
  let value = input
  for (const key of path.split('.')) {
    if (unsafeKeys.has(key) || value === null || typeof value !== 'object' || !Object.hasOwn(value, key))
      return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

export function resolveTaskInputs(inputs: JsonObject, outputs: Record<string, JsonValue>, event: EventEnvelope): Result<JsonValue> {
  const resolve = (input: JsonValue): Result<JsonValue> => {
    if (Array.isArray(input)) {
      const values: JsonValue[] = []
      for (const item of input) {
        const result = resolve(item)
        if (result._tag === 'Err')
          return result
        values.push(result.value)
      }
      return ok(values)
    }
    if (!record(input))
      return ok(input)
    if ('$ref' in input) {
      const ref = String(input.$ref)
      const match = /^tasks\.([\w-]+)\.output(?:\.(.+))?$/.exec(ref)
      const value = ref === 'event' ? event : ref.startsWith('event.') ? pathValue(event, ref.slice(6)) : match === null ? undefined : pathValue(outputs[match[1]!], match[2] ?? '')
      return isJsonValue(value) ? ok(value) : invalid(`Task input reference ${ref} has no JSON value.`)
    }
    const values: JsonObject = {}
    for (const [key, item] of Object.entries(input)) {
      if (unsafeKeys.has(key))
        return invalid('Task inputs contain a forbidden prototype key.')
      const result = resolve(item as JsonValue)
      if (result._tag === 'Err')
        return result
      values[key] = result.value
    }
    return ok(values)
  }
  return resolve(inputs)
}

export function conditionMatches(condition: TaskCondition, run: { event: EventEnvelope, tasks: { id: string, state: { _tag: string }, output: JsonValue | null }[] }): boolean {
  switch (condition._tag) {
    case 'EventAction': return run.event.action === condition.action
    case 'Succeeded': return run.tasks.some(task => task.id === condition.task && task.state._tag === 'Succeeded')
    case 'OutputEquals': {
      const task = run.tasks.find(task => task.id === condition.task)
      const value = task?.state._tag === 'Succeeded' ? pathValue(task.output, condition.path) : undefined
      return value !== undefined && digest(value) === digest(condition.value)
    }
    case 'Not': return !conditionMatches(condition.condition, run)
  }
}

export function compileWorkflow(workflow: WorkflowDefinition, taskTypes: TaskType[]): Result<Record<string, string>> {
  const versions: Record<string, string> = {}
  const ids = new Set<string>()
  for (const type of taskTypes) {
    if (ids.has(type.id))
      return invalid(`Task type ${type.id} is registered more than once.`)
    ids.add(type.id)
  }
  for (const task of workflow.tasks) {
    const type = taskTypes.find(candidate => candidate.id === task.uses)
    if (!type)
      return invalid(`Task type ${task.uses} is not registered.`)
    versions[task.id] = type.version
    if (!JSON.stringify(task.with).includes('"$ref"')) {
      const parsed = type.input(task.with)
      if (parsed._tag === 'Err')
        return parsed
    }
  }
  return ok(versions)
}

export function taskLimits(task: TaskDefinition, workflow: WorkflowDefinition): TaskLimits {
  return task.limits ?? { maxAttempts: workflow.limits.maxAttempts, timeoutMs: workflow.limits.timeoutMs }
}
