import type { EventEnvelope, RepositoryPolicy, TaskContext, TaskOutcome, TaskType, Usage, WorkflowDefinition } from '../src/index.ts'
import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adversarialReviewPreset, createOpenAICompatibleProvider, createReviewTaskTypes, createRunner, openStore, parseJsonValue, parseWorkflow } from '../src/index.ts'

const event: EventEnvelope = {
  id: 'reservation-event',
  semanticKey: 'reservation-event',
  source: 'manual',
  name: 'pull_request',
  action: 'opened',
  repository: { id: 1, fullName: 'acme/project', installationId: 2 },
  actor: null,
  target: { _tag: 'PullRequest', number: 4, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
  occurredAt: new Date().toISOString(),
  receivedAt: new Date().toISOString(),
  data: {},
}
const policy: RepositoryPolicy = { enabled: true, capabilities: ['agent:invoke', 'github:comment'], maxConcurrency: 1 }
const ceiling: Usage = { inputTokens: 20, outputTokens: 30, costUsd: null }
const actual: Usage = { inputTokens: 3, outputTokens: 4, costUsd: null }

function definition(maxTokens = 80): WorkflowDefinition {
  const parsed = parseWorkflow({ version: 1, id: 'reserved', name: 'Reserved usage', on: [], tasks: [{ id: 'turn', uses: 'turn', with: {} }], limits: { maxTokens, maxAttempts: 1 } })
  if (parsed._tag === 'Err')
    throw new Error(parsed.error.message)
  return parsed.value
}

function task(execute: (context: TaskContext) => Promise<TaskOutcome>): TaskType {
  return { id: 'turn', version: '1', capabilities: ['agent:invoke'], input: parseJsonValue, output: parseJsonValue, execute }
}

function start(runner: ReturnType<typeof createRunner>, maxTokens = 80) {
  const started = runner.start({ event, workflow: definition(maxTokens), policy, configuration: { source: 'fixture', sha: 'trusted', digest: 'fixture' } })
  if (started._tag === 'Err')
    throw new Error(started.error.message)
  return started.value
}

describe('durable usage reservations', () => {
  it('records known zero cost when no provider call is needed', async () => {
    let calls = 0
    const types = createReviewTaskTypes({ snapshots: { read: async () => ({ _tag: 'Ok', value: { headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), title: 'No changes', body: '', files: [] } }) }, provider: {
      id: 'unused',
      generate: async () => {
        calls++
        throw new Error('No provider call is needed.')
      },
    } })
    const workflow = adversarialReviewPreset()
    workflow.limits.maxCostUsd = 1
    const runner = createRunner({ store: openStore({ path: ':memory:' }), taskTypes: types, publisher: {
      authorize: async () => ({ _tag: 'Ok', value: undefined }),
      reconcile: async () => ({ _tag: 'Ok', value: null }),
      publish: async () => ({ _tag: 'Ok', value: { id: 'comment', url: null, data: null } }),
    } })
    const run = runner.start({ event, workflow, policy: { ...policy, capabilities: ['agent:invoke', 'github:comment', 'github:review', 'repository:read'] }, configuration: { source: 'fixture', sha: 'trusted', digest: 'fixture' } })
    if (run._tag === 'Err')
      throw new Error(run.error.message)
    await runner.drain()
    expect(calls).toBe(0)
    expect(runner.inspect(run.value.id)).toMatchObject({ state: { _tag: 'Succeeded' }, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } })
    await runner.close()
  })

  it('keeps a reservation after SIGKILL before a provider response', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'octorun-killed-reservation-'))
    await (async () => {
      const path = join(directory, 'state.sqlite')
      const child = fork(new URL('./fixtures/runner-usage-crash.ts', import.meta.url), [path], { execArgv: ['--experimental-strip-types'], silent: true })
      const runId = await new Promise<string>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => reject(new Error(`The crash fixture exited early, ${code ?? signal}.`)))
        child.once('message', (message: unknown) => {
          if (message && typeof message === 'object' && '_tag' in message && message._tag === 'Reserved' && 'runId' in message && typeof message.runId === 'string')
            resolve(message.runId)
          else
            reject(new Error('The crash fixture returned invalid reservation evidence.'))
        })
      })
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
      })
      child.kill('SIGKILL')
      await exited
      let calls = 0
      const recovered = createRunner({ store: openStore({ path }), taskTypes: [task(async (context) => {
        const reserved = await context.reserveUsage(ceiling)
        if (reserved._tag === 'Err')
          return { _tag: 'Failed', error: reserved.error }
        calls++
        return { _tag: 'Succeeded', output: null }
      })] })
      await recovered.drain()
      expect(calls).toBe(0)
      expect(recovered.inspect(runId)).toMatchObject({ state: { _tag: 'Failed' }, usage: ceiling })
      await recovered.close()
    })().finally(() => rm(directory, { recursive: true, force: true }))
  })

  it.each(['transient', 'timeout', 'rejected'])('retains uncertain provider charges and refunds proven rejection: %s', async (outcome) => {
    const knownZero = outcome === 'rejected'
    let calls = 0
    const http = createOpenAICompatibleProvider({ baseUrl: 'https://models.example/v1', apiKey: 'fixture', model: 'fixture', timeoutMs: 20 }, {
      fetch: async (_input, init) => {
        calls++
        if (outcome === 'timeout') {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('Timed out')), { once: true })
          })
        }
        return new Response('', { status: knownZero ? 401 : 500 })
      },
    })
    if (http._tag === 'Err')
      throw new Error(http.error.message)
    const types = createReviewTaskTypes({ provider: http.value, snapshots: { read: async () => ({ _tag: 'Ok', value: {
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      title: 'Change the name',
      body: '',
      files: [{ path: 'name.ts', status: 'modified', truncated: false, patch: '@@ -1 +1 @@\n-old\n+new' }],
    } }) } })
    const workflow = adversarialReviewPreset()
    workflow.limits.maxAttempts = 1
    workflow.tasks[1]!.with.roles = ['correctness']
    workflow.tasks[1]!.with.maxOutputTokens = 512
    const runner = createRunner({ store: openStore({ path: ':memory:' }), taskTypes: types })
    const run = runner.start({ event, workflow, policy: { ...policy, capabilities: ['agent:invoke', 'github:comment', 'github:review', 'repository:read'] }, configuration: { source: 'fixture', sha: 'trusted', digest: 'fixture' } })
    if (run._tag === 'Err')
      throw new Error(run.error.message)
    await runner.drain()
    expect(calls).toBe(1)
    expect(runner.inspect(run.value.id)?.state._tag).toBe('Failed')
    const usage = runner.inspect(run.value.id)!.usage
    if (knownZero) {
      expect(usage.inputTokens + usage.outputTokens).toBe(0)
      expect(usage.costUsd).toBe(0)
    }
    else {
      expect(usage.inputTokens).toBeGreaterThan(0)
      expect(usage.outputTokens).toBe(512)
    }
    await runner.close()
  })

  it('retains an interrupted call charge across restart and rejects a retry beyond the remaining budget', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'octorun-reservations-'))
    await (async () => {
      const path = join(directory, 'state.sqlite')
      let reserved: (() => void) | undefined
      const prepared = new Promise<void>((resolve) => {
        reserved = resolve
      })
      const first = createRunner({ store: openStore({ path }), taskTypes: [task(async (context) => {
        const reservation = await context.reserveUsage(ceiling)
        if (reservation._tag === 'Err')
          return { _tag: 'Failed', error: reservation.error }
        reserved!()
        return new Promise<TaskOutcome>(() => {})
      })] })
      const run = start(first)
      await first.tick()
      await prepared
      expect(first.inspect(run.id)?.usage).toEqual(ceiling)
      await first.close()
      let calls = 0
      const recovered = createRunner({ store: openStore({ path }), taskTypes: [task(async (context) => {
        const reservation = await context.reserveUsage(ceiling)
        if (reservation._tag === 'Err')
          return { _tag: 'Failed', error: reservation.error }
        calls++
        return { _tag: 'Succeeded', output: null }
      })] })
      await recovered.drain()
      expect(calls).toBe(0)
      expect(recovered.inspect(run.id)).toMatchObject({ state: { _tag: 'Failed' }, usage: ceiling })
      await recovered.close()
    })().finally(() => rm(directory, { recursive: true, force: true }))
  })

  it('settles each known result once without counting the task aggregate twice', async () => {
    let settlement: unknown
    const runner = createRunner({ store: openStore({ path: ':memory:' }), taskTypes: [task(async (context) => {
      for (let index = 0; index < 2; index++) {
        const reservation = await context.reserveUsage(ceiling)
        if (reservation._tag === 'Err')
          return { _tag: 'Failed', error: reservation.error }
        await context.settleUsage(reservation.value, actual)
        settlement = await context.settleUsage(reservation.value, actual)
      }
      return { _tag: 'Succeeded', output: null, usage: { inputTokens: 6, outputTokens: 8, costUsd: null } }
    })] })
    const run = start(runner)
    await runner.drain()
    expect(settlement).toEqual({ _tag: 'Ok', value: undefined })
    expect(runner.inspect(run.id)).toMatchObject({ state: { _tag: 'Succeeded' }, usage: { inputTokens: 6, outputTokens: 8, costUsd: null } })
    await runner.close()
  })

  it('serializes parallel reservations against one remaining workflow budget', async () => {
    let admitted = 0
    const runner = createRunner({ store: openStore({ path: ':memory:' }), taskTypes: [task(async (context) => {
      const results = await Promise.all([context.reserveUsage(ceiling), context.reserveUsage(ceiling)])
      admitted = results.filter(result => result._tag === 'Ok').length
      return { _tag: 'Succeeded', output: null }
    })] })
    const run = start(runner)
    await runner.drain()
    expect(admitted).toBe(1)
    expect(runner.inspect(run.id)?.usage).toEqual(ceiling)
    await runner.close()
  })

  it('records known usage after cancellation while keeping publication revoked', async () => {
    let release: (() => void) | undefined
    let entered: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const reserved = new Promise<void>((resolve) => {
      entered = resolve
    })
    let settled: unknown
    let publication: unknown
    const runner = createRunner({ store: openStore({ path: ':memory:' }), taskTypes: [task(async (context) => {
      const reservation = await context.reserveUsage(ceiling)
      if (reservation._tag === 'Err')
        return { _tag: 'Failed', error: reservation.error }
      entered!()
      await waiting
      settled = await context.settleUsage(reservation.value, actual)
      publication = await context.publish('late', { _tag: 'Comment', repository: 'acme/project', number: 4, namespace: 'test', body: 'late' })
      return { _tag: 'Succeeded', output: null, usage: actual }
    })] })
    const run = start(runner)
    await runner.tick()
    await reserved
    runner.cancel(run.id)
    release!()
    await runner.drain()
    expect(settled).toEqual({ _tag: 'Ok', value: undefined })
    expect(publication).toMatchObject({ _tag: 'Err', error: { _tag: 'Authorization' } })
    expect(runner.inspect(run.id)).toMatchObject({ state: { _tag: 'Cancelled' }, usage: actual })
    await runner.close()
  })

  it('does not permit a different result to refund an already settled call', async () => {
    let duplicate: unknown
    const runner = createRunner({ store: openStore({ path: ':memory:' }), taskTypes: [task(async (context) => {
      const reservation = await context.reserveUsage(ceiling)
      if (reservation._tag === 'Err')
        return { _tag: 'Failed', error: reservation.error }
      await context.settleUsage(reservation.value, actual)
      duplicate = await context.settleUsage(reservation.value, { inputTokens: 0, outputTokens: 0, costUsd: 0 })
      return { _tag: 'Succeeded', output: null }
    })] })
    const run = start(runner)
    await runner.drain()
    expect(duplicate).toMatchObject({ _tag: 'Err' })
    expect(runner.inspect(run.id)?.usage).toEqual(actual)
    await runner.close()
  })
})
