import type { EventEnvelope, PublicationPublisher, RepositoryPolicy, TaskContext, TaskOutcome, TaskType, WorkflowDefinition } from '../src/index.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRunner, ok, openStore, parseJsonValue, parseWorkflow } from '../src/index.ts'

const policy: RepositoryPolicy = { enabled: true, capabilities: ['repository:read', 'github:comment', 'github:check'], maxConcurrency: 2 }
const configuration = { source: 'operator', sha: 'trusted-config', digest: 'configuration-1' }
const event = (id = 'one', head = 'a'): EventEnvelope => ({ id, semanticKey: `head:${head}`, source: 'webhook', name: 'pull_request', action: 'opened', repository: { id: 1, fullName: 'acme/project', installationId: 2 }, actor: null, target: { _tag: 'PullRequest', number: 4, headSha: head.repeat(40), baseSha: 'b'.repeat(40) }, occurredAt: '2026-10-21T00:00:00.000Z', receivedAt: '2026-10-21T00:00:00.000Z', data: {} })
function definition(tasks: unknown[] = [{ id: 'first', uses: 'echo', with: { message: 'hello' } }], limits = {}): WorkflowDefinition {
  const result = parseWorkflow({ version: 1, id: 'example', name: 'Example', on: [{ event: 'pull_request' }], tasks, limits })
  if (result._tag === 'Err')
    throw new Error(result.error.message)
  return result.value
}
const type = (execute: (context: TaskContext, input: unknown) => Promise<TaskOutcome>, id = 'echo'): TaskType => ({ id, version: '1', capabilities: [], input: parseJsonValue, output: parseJsonValue, execute })
function start(runner: ReturnType<typeof createRunner>, input = event(), workflow = definition()) {
  const result = runner.start({ event: input, workflow, policy, configuration })
  if (result._tag === 'Err')
    throw new Error(result.error.message)
  return result.value
}

describe('durable workflow execution', () => {
  it('recovers a task failure committed before its workflow failure transition', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'octorun-failed-transition-'))
    await (async () => {
      const path = join(directory, 'state.sqlite')
      const store = openStore({ path })
      const first = createRunner({ store, taskTypes: [type(async () => ({ _tag: 'Succeeded', output: null }))] })
      const run = start(first)
      const error = { _tag: 'Permanent' as const, message: 'The recorded provider result is invalid.' }
      store.updateRun(run.id, value => ({ ...value, state: { _tag: 'Running' }, tasks: value.tasks.map(task => ({ ...task, state: { _tag: 'Failed', error }, failures: 1 })) }))
      await first.close()
      let calls = 0
      let successes = 0
      const recovered = createRunner({ store: openStore({ path }), taskTypes: [type(async () => {
        calls++
        return { _tag: 'Succeeded', output: null }
      })], onRunChanged: (value) => {
        if (value.state._tag === 'Succeeded')
          successes++
      } })
      await recovered.drain()
      expect(recovered.inspect(run.id)?.state).toEqual({ _tag: 'Failed', error })
      expect(calls).toBe(0)
      expect(successes).toBe(0)
      await recovered.close()
    })().finally(() => rm(directory, { recursive: true, force: true }))
  })

  it('does not resurrect a run cancelled while its admission policy is resolving', async () => {
    let release: (() => void) | undefined
    let entered: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const checking = new Promise<void>((resolve) => {
      entered = resolve
    })
    let calls = 0
    const runner = createRunner({ store: openStore({ path: ':memory:' }), policy: async () => {
      entered!()
      await waiting
      return ok(policy)
    }, taskTypes: [type(async () => {
      calls++
      return { _tag: 'Succeeded', output: null }
    })] })
    const run = start(runner)
    const admission = runner.tick()
    await checking
    runner.cancel(run.id)
    release!()
    await admission
    await runner.drain()
    expect(calls).toBe(0)
    expect(runner.inspect(run.id)?.state._tag).toBe('Cancelled')
    await runner.close()
  })

  it('holds automatic work while allowing explicit commands and finding conversations', async () => {
    let calls = 0
    const runner = createRunner({ store: openStore({ path: ':memory:' }), taskTypes: [type(async () => {
      calls++
      return { _tag: 'Succeeded', output: null }
    })] })
    runner.pause('acme/project', '1:pull_request:4', true)
    const automatic = start(runner)
    const conversation = start(runner, { ...event('conversation'), name: 'octorun.conversation', semanticKey: 'reply:52' }, { ...definition(), id: 'conversation' })
    const command = start(runner, { ...event('command'), name: 'octorun.command', semanticKey: 'command:53' }, { ...definition(), id: 'command' })
    await runner.drain()
    expect(runner.inspect(automatic.id)?.state._tag).toBe('Queued')
    expect(runner.inspect(conversation.id)?.state._tag).toBe('Succeeded')
    expect(runner.inspect(command.id)?.state._tag).toBe('Succeeded')
    expect(calls).toBe(2)
    await runner.close()
  })

  it('rejects negative usage rather than allowing it to expand a later task budget', async () => {
    let calls = 0
    const runner = createRunner({ store: openStore({ path: ':memory:' }), taskTypes: [type(async () => {
      calls++
      return { _tag: 'Succeeded', output: null, usage: { inputTokens: -100, outputTokens: 1, costUsd: 0 } }
    })] })
    const run = start(runner, event(), definition([{ id: 'first', uses: 'echo', with: {} }, { id: 'second', uses: 'echo', with: {} }]))
    await runner.drain()
    expect(calls).toBe(1)
    expect(runner.inspect(run.id)?.state).toMatchObject({ _tag: 'Failed', error: { message: expect.stringContaining('invalid token or cost usage') } })
    await runner.close()
  })

  it('checks cumulative currency usage after the final task', async () => {
    let calls = 0
    const runner = createRunner({ store: openStore({ path: ':memory:' }), taskTypes: [type(async () => {
      calls++
      return { _tag: 'Succeeded', output: null, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.6 } }
    })] })
    const run = start(runner, event(), definition([{ id: 'first', uses: 'echo', with: {} }, { id: 'second', uses: 'echo', with: {} }], { maxCostUsd: 1 }))
    await runner.drain()
    expect(calls).toBe(2)
    expect(runner.inspect(run.id)).toMatchObject({ state: { _tag: 'Failed' }, usage: { costUsd: 1.2 } })
    await runner.close()
  })

  it('rejects late task publications after shutdown without touching the closed store', async () => {
    let release: (() => void) | undefined
    let report: ((result: unknown) => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const late = new Promise<unknown>((resolve) => {
      report = resolve
    })
    const runner = createRunner({ store: openStore({ path: ':memory:' }), taskTypes: [type(async (context) => {
      await blocked
      report!(await context.publish('late', { _tag: 'Comment', repository: 'acme/project', number: 4, namespace: 'example', body: 'late' }).catch((cause: unknown) => cause))
      return { _tag: 'Succeeded', output: null }
    })] })
    start(runner, event(), definition(undefined, { timeoutMs: 10 }))
    await runner.tick()
    await runner.close()
    release!()
    expect(await late).toMatchObject({ _tag: 'Err', error: { _tag: 'Authorization' } })
  })

  it('rechecks cancellation after asynchronous publication authorization', async () => {
    let authorize: (() => void) | undefined
    let entered: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      authorize = resolve
    })
    const authorizing = new Promise<void>((resolve) => {
      entered = resolve
    })
    let writes = 0
    const publisher: PublicationPublisher = {
      authorize: async () => {
        entered!()
        await waiting
        return ok(undefined)
      },
      reconcile: async () => ok(null),
      publish: async () => {
        writes++
        return ok({ id: 'remote', url: null, data: null })
      },
    }
    const runner = createRunner({ store: openStore({ path: ':memory:' }), publisher, taskTypes: [type(async () => ({ _tag: 'Succeeded', output: null }))] })
    const run = start(runner)
    runner.publishSystem(run.id, 'queued', { _tag: 'Check', repository: 'acme/project', headSha: 'a'.repeat(40), name: 'Example', phase: { status: 'queued' }, summary: 'Queued.' })
    const flushing = runner.tick()
    await authorizing
    runner.cancel(run.id)
    authorize!()
    await flushing
    expect(writes).toBe(0)
    await runner.close()
  })

  it('closes safely while a publisher ignores cancellation during authorization', async () => {
    let authorize: (() => void) | undefined
    let entered: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      authorize = resolve
    })
    const authorizing = new Promise<void>((resolve) => {
      entered = resolve
    })
    let writes = 0
    const publisher: PublicationPublisher = {
      authorize: async () => {
        entered!()
        await waiting
        return ok(undefined)
      },
      reconcile: async () => ok(null),
      publish: async () => {
        writes++
        return ok({ id: 'remote', url: null, data: null })
      },
    }
    const runner = createRunner({ store: openStore({ path: ':memory:' }), publisher, taskTypes: [type(async () => ({ _tag: 'Succeeded', output: null }))] })
    const run = start(runner)
    runner.publishSystem(run.id, 'queued', { _tag: 'Check', repository: 'acme/project', headSha: 'a'.repeat(40), name: 'Example', phase: { status: 'queued' }, summary: 'Queued.' })
    const flushing = runner.tick()
    await authorizing
    await runner.close()
    authorize!()
    await flushing
    expect(writes).toBe(0)
  })

  it('fails an over-budget final task before publishing its output', async () => {
    let writes = 0
    const publisher: PublicationPublisher = {
      authorize: async () => ok(undefined),
      reconcile: async () => ok(null),
      publish: async () => {
        writes++
        return ok({ id: 'remote', url: null, data: null })
      },
    }
    const runner = createRunner({ store: openStore({ path: ':memory:' }), publisher, taskTypes: [type(async (context) => {
      await context.publish('result', { _tag: 'Comment', repository: 'acme/project', number: 4, namespace: 'example', body: 'result' })
      return { _tag: 'Succeeded', output: 'done', usage: { inputTokens: 6, outputTokens: 6, costUsd: 0 } }
    })] })
    const run = start(runner, event(), definition(undefined, { maxTokens: 10 }))
    await runner.drain()
    expect(runner.inspect(run.id)?.state).toMatchObject({ _tag: 'Failed', error: { message: expect.stringContaining('budget') } })
    expect(writes).toBe(0)
    await runner.close()
  })

  it('recovers an interrupted task without consuming its failure allowance', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'octorun-recovery-'))
    await (async () => {
      const path = join(directory, 'state.sqlite')
      const firstStore = openStore({ path })
      const first = createRunner({ store: firstStore, taskTypes: [type(async () => ({ _tag: 'Succeeded', output: null }))] })
      const run = start(first, event(), definition(undefined, { maxAttempts: 1 }))
      firstStore.updateRun(run.id, value => ({ ...value, state: { _tag: 'Running' }, tasks: value.tasks.map(task => ({ ...task, state: { _tag: 'Running', leaseUntil: new Date().toISOString() }, attempts: 1, fence: 1 })) }))
      await first.close()
      let calls = 0
      const recovered = createRunner({ store: openStore({ path }), taskTypes: [type(async () => {
        calls++
        return { _tag: 'Succeeded', output: 'recovered' }
      })] })
      await recovered.drain()
      expect(recovered.inspect(run.id)?.state).toEqual({ _tag: 'Succeeded' })
      expect(calls).toBe(1)
      await recovered.close()
    })().finally(() => rm(directory, { recursive: true, force: true }))
  })

  it('runs an arbitrary chain through validated prior outputs', async () => {
    const store = openStore({ path: ':memory:' })
    const calls: unknown[] = []
    const runner = createRunner({ store, taskTypes: [type(async (_context, input) => {
      calls.push(input)
      return { _tag: 'Succeeded', output: { message: 'next' } }
    })] })
    const run = start(runner, event(), definition([{ id: 'first', uses: 'echo', with: { message: 'hello' } }, { id: 'second', uses: 'echo', with: { message: { $ref: 'tasks.first.output.message' } } }]))
    await runner.drain()
    expect(calls).toEqual([{ message: 'hello' }, { message: 'next' }])
    expect(runner.inspect(run.id)?.state).toEqual({ _tag: 'Succeeded' })
    await runner.close()
  })

  it('coalesces duplicate automatic observations but preserves explicit re-runs', async () => {
    const runner = createRunner({ store: openStore({ path: ':memory:' }), taskTypes: [type(async () => ({ _tag: 'Succeeded', output: null }))] })
    const first = runner.ingest(event(), [definition()], policy, configuration)
    const duplicate = runner.ingest({ ...event('poll'), source: 'poll' }, [definition()], policy, configuration)
    expect(first._tag).toBe('Ok')
    expect(duplicate._tag).toBe('Ok')
    if (first._tag !== 'Ok' || duplicate._tag !== 'Ok')
      throw new Error('Fixture was rejected.')
    expect(duplicate.value.runIds).toEqual(first.value.runIds)
    const deliberate = runner.start({ event: event('manual'), workflow: definition(), policy, configuration, requestId: 'manual-1' })
    expect(deliberate._tag).toBe('Ok')
    if (deliberate._tag === 'Ok')
      expect(deliberate.value.id).not.toBe(first.value.runIds[0])
    await runner.close()
  })

  it('does not spend failed-execution allowance on four admission pauses', async () => {
    let clock = new Date('2026-10-21T00:00:00.000Z')
    let calls = 0
    const runner = createRunner({ store: openStore({ path: ':memory:' }), now: () => clock, taskTypes: [type(async () => ++calls <= 4 ? { _tag: 'Deferred', until: new Date(clock.getTime() + 1000).toISOString(), reason: 'Provider capacity is held.' } : { _tag: 'Succeeded', output: 'done' })] })
    const run = start(runner, event(), definition(undefined, { maxAttempts: 1 }))
    for (let index = 0; index < 4; index++) {
      await runner.drain()
      expect(runner.inspect(run.id)?.tasks[0]?.failures).toBe(0)
      expect(runner.inspect(run.id)?.state._tag).toBe('Waiting')
      clock = new Date(clock.getTime() + 1001)
    }
    await runner.drain()
    expect(runner.inspect(run.id)?.state._tag).toBe('Succeeded')
    expect(calls).toBe(5)
    await runner.close()
  })

  it('stops permanent provider configuration errors without another execution', async () => {
    let calls = 0
    const runner = createRunner({ store: openStore({ path: ':memory:' }), taskTypes: [type(async () => {
      calls++
      return { _tag: 'Failed', error: { _tag: 'Configuration', message: 'The provider model is unavailable.' } }
    })] })
    const run = start(runner)
    await runner.drain()
    await runner.drain()
    expect(calls).toBe(1)
    expect(runner.inspect(run.id)?.state).toMatchObject({ _tag: 'Failed', error: { _tag: 'Configuration' } })
    await runner.close()
  })

  it('persists a cancellation before an active task can prepare output', async () => {
    let finish: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      finish = resolve
    })
    let latePublication: unknown
    const runner = createRunner({ store: openStore({ path: ':memory:' }), taskTypes: [type(async (context) => {
      await waiting
      latePublication = await context.publish('late', { _tag: 'Comment', repository: 'acme/project', number: 4, namespace: 'example', body: 'late' })
      return { _tag: 'Succeeded', output: null }
    })] })
    const run = start(runner)
    await runner.tick()
    expect(runner.cancel(run.id)._tag).toBe('Ok')
    finish!()
    await runner.drain()
    expect(latePublication).toMatchObject({ _tag: 'Err', error: { _tag: 'Authorization' } })
    expect(runner.inspect(run.id)?.state._tag).toBe('Cancelled')
    await runner.close()
  })

  it('supersedes old automatic work when the pull request head changes', async () => {
    const runner = createRunner({ store: openStore({ path: ':memory:' }), taskTypes: [type(async () => ({ _tag: 'Succeeded', output: null }))] })
    const first = start(runner)
    const second = start(runner, event('two', 'c'))
    expect(runner.inspect(first.id)?.state).toEqual({ _tag: 'Superseded', byRunId: second.id })
    await runner.drain()
    expect(runner.inspect(second.id)?.state._tag).toBe('Succeeded')
    await runner.close()
  })

  it('reconciles an unknown remote result before repeating its write', async () => {
    let writes = 0
    let remote: { id: string, url: null, data: null } | null = null
    let clock = new Date('2026-10-21T00:00:00.000Z')
    const publisher: PublicationPublisher = {
      authorize: async () => ok(undefined),
      reconcile: async () => ok(remote),
      publish: async () => {
        writes++
        remote = { id: 'comment-1', url: null, data: null }
        return { _tag: 'Err', error: { _tag: 'Transient', message: 'The connection closed after the write.' } }
      },
    }
    const runner = createRunner({ store: openStore({ path: ':memory:' }), publisher, now: () => clock, taskTypes: [type(async (context) => {
      const result = await context.publish('overview', { _tag: 'Comment', repository: 'acme/project', number: 4, namespace: 'example', body: 'done' })
      return result._tag === 'Err' ? { _tag: 'Failed', error: result.error } : { _tag: 'Succeeded', output: null }
    })] })
    const run = start(runner)
    await runner.drain()
    clock = new Date(clock.getTime() + 60000)
    await runner.drain()
    expect(writes).toBe(1)
    expect(runner.inspect(run.id)?.state._tag).toBe('Succeeded')
    await runner.close()
  })

  it('rechecks live policy before starting a later task', async () => {
    let enabled = true
    let calls = 0
    const runner = createRunner({ store: openStore({ path: ':memory:' }), policy: async () => ok({ ...policy, enabled }), taskTypes: [type(async () => {
      calls++
      enabled = false
      return { _tag: 'Succeeded', output: null }
    })] })
    const run = start(runner, event(), definition([{ id: 'first', uses: 'echo', with: {} }, { id: 'second', uses: 'echo', with: {} }]))
    await runner.drain()
    expect(calls).toBe(1)
    expect(runner.inspect(run.id)?.state).toMatchObject({ _tag: 'Failed', error: { _tag: 'Authorization' } })
    await runner.close()
  })

  it('rejects cross-repository effects before creating publication intent', async () => {
    const runner = createRunner({ store: openStore({ path: ':memory:' }), taskTypes: [type(async (context) => {
      const publication = await context.publish('other', { _tag: 'Comment', repository: 'another/private', number: 4, namespace: 'example', body: 'wrong' })
      return publication._tag === 'Err' ? { _tag: 'Failed', error: publication.error } : { _tag: 'Succeeded', output: null }
    })] })
    const run = start(runner)
    await runner.drain()
    expect(runner.inspect(run.id)?.state).toMatchObject({ _tag: 'Failed', error: { _tag: 'Authorization' } })
    await runner.close()
  })
})
