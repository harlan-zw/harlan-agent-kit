import type { EventEnvelope, PublicationEffect, PublicationPublisher, TaskContext, TaskOutcome, TaskType } from '../src/index.ts'
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createRunner, ok, openStore, parseJsonValue, parseWorkflow } from '../src/index.ts'

const event: EventEnvelope = {
  id: 'outbox-event',
  semanticKey: 'outbox-event',
  source: 'manual',
  name: 'pull_request',
  action: 'opened',
  repository: { id: 1, fullName: 'acme/project', installationId: 2 },
  actor: null,
  target: { _tag: 'PullRequest', number: 4, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) },
  occurredAt: '2026-10-21T00:00:00Z',
  receivedAt: '2026-10-21T00:00:00Z',
  data: {},
}
const comment = (body: string): PublicationEffect => ({ _tag: 'Comment', repository: 'acme/project', number: 4, namespace: 'review', body })

function harness(publisher: PublicationPublisher, execute: (context: TaskContext) => Promise<TaskOutcome>, policy?: NonNullable<Parameters<typeof createRunner>[0]['policy']>) {
  let clock = new Date('2026-10-21T00:00:00Z')
  const store = openStore({ path: ':memory:' })
  const task: TaskType = { id: 'publish', version: '1', capabilities: [], input: parseJsonValue, output: parseJsonValue, execute }
  const runner = createRunner({ store, publisher, taskTypes: [task], now: () => clock, ...(policy ? { policy } : {}) })
  const workflow = parseWorkflow({ version: 1, id: 'outbox', name: 'Outbox', on: [], tasks: [{ id: 'publish', uses: 'publish', with: {} }] })
  if (workflow._tag === 'Err')
    throw new Error(workflow.error.message)
  const run = runner.start({ event, workflow: workflow.value, policy: { enabled: true, capabilities: ['github:comment', 'github:check'], maxConcurrency: 1 }, configuration: { source: 'fixture', sha: 'trusted', digest: 'fixture' } })
  if (run._tag === 'Err')
    throw new Error(run.error.message)
  return { runner, store, run: run.value, advance: (milliseconds = 3000) => {
    clock = new Date(clock.getTime() + milliseconds)
  } }
}

describe('publication recovery and ordering', () => {
  it.each([false, true])('reconciles an attempted write after cancellation without repeating it, remote exists: %s', async (exists) => {
    let writes = 0
    let reconciliations = 0
    const h = harness({
      authorize: async () => ok(undefined),
      reconcile: async () => {
        reconciliations++
        return ok(exists ? { id: 'remote', url: null, data: null } : null)
      },
      publish: async () => {
        writes++
        return { _tag: 'Err', error: { _tag: 'Transient', message: 'The write result is unknown.' } }
      },
    }, async (context) => {
      await context.publish('result', comment('FINAL'))
      return { _tag: 'Succeeded', output: null }
    })
    await h.runner.drain()
    h.runner.cancel(h.run.id)
    h.advance(60_000)
    await h.runner.drain()
    expect(writes).toBe(1)
    expect(reconciliations).toBe(1)
    expect(h.store.publications({ runId: h.run.id })[0]?.state._tag).toBe(exists ? 'Written' : 'Cancelled')
    expect(h.runner.inspect(h.run.id)?.state._tag).toBe('Cancelled')
    await h.runner.close()
  })

  it('waits for temporary admission policy failure without spending an execution attempt', async () => {
    let checks = 0
    let calls = 0
    const h = harness({ authorize: async () => ok(undefined), reconcile: async () => ok(null), publish: async () => ok({ id: 'unused', url: null, data: null }) }, async () => {
      calls++
      return { _tag: 'Succeeded', output: null }
    }, async run => ++checks === 1 ? { _tag: 'Err', error: { _tag: 'Capacity', message: 'Temporary GitHub rate limit.', retryAt: '2026-10-21T00:00:01Z' } } : ok(run.policy))
    await h.runner.tick()
    h.advance()
    await h.runner.drain()
    expect(calls).toBe(1)
    expect(h.runner.inspect(h.run.id)).toMatchObject({ state: { _tag: 'Succeeded' }, tasks: [{ attempts: 1, failures: 0 }] })
    await h.runner.close()
  })

  it('keeps active work during a policy outage and withholds its publication until recovery', async () => {
    let release: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    let outage = false
    let calls = 0
    let writes = 0
    const h = harness({ authorize: async () => ok(undefined), reconcile: async () => ok(null), publish: async () => {
      writes++
      return ok({ id: 'comment', url: null, data: null })
    } }, async (context) => {
      calls++
      await waiting
      await context.publish('result', comment('FINAL'))
      return { _tag: 'Succeeded', output: null }
    }, async run => outage ? { _tag: 'Err', error: { _tag: 'Transient', message: 'GitHub permissions are temporarily unavailable.' } } : ok(run.policy))
    await h.runner.tick()
    outage = true
    h.advance(6000)
    await h.runner.tick()
    release!()
    await h.runner.drain()
    expect(writes).toBe(0)
    expect(h.runner.inspect(h.run.id)?.state._tag).toBe('Waiting')
    outage = false
    h.advance(60_000)
    await h.runner.drain()
    expect(calls).toBe(1)
    expect(writes).toBe(1)
    expect(h.runner.inspect(h.run.id)?.state._tag).toBe('Succeeded')
    await h.runner.close()
  })

  it('never retries an old lifecycle overview after the final task result exists', async () => {
    let release: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    let remote = ''
    let attempts = 0
    const h = harness({
      authorize: async () => ok(undefined),
      reconcile: async () => ok(null),
      publish: async ({ publication }) => {
        if (publication.effect._tag !== 'Comment')
          throw new Error('Expected a comment.')
        if (publication.effect.body === 'RUNNING' && ++attempts === 1)
          return { _tag: 'Err', error: { _tag: 'Transient', message: 'Connection closed before confirmation.' } }
        remote = publication.effect.body
        return ok({ id: 'comment', url: null, data: null })
      },
    }, async (context) => {
      await waiting
      await context.publish('final', comment('FINAL'))
      return { _tag: 'Succeeded', output: null }
    })
    h.runner.publishSystem(h.run.id, 'running', comment('RUNNING'))
    await h.runner.tick()
    release!()
    await h.runner.drain()
    h.advance()
    await h.runner.drain()
    expect(remote).toBe('FINAL')
    expect(attempts).toBe(1)
    await h.runner.close()
  })

  it('keeps the newest native check phase while its task is still active', async () => {
    let release: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    let remote = ''
    let attempts = 0
    const h = harness({ authorize: async () => ok(undefined), reconcile: async () => ok(null), publish: async ({ publication }) => {
      if (publication.effect._tag !== 'Check')
        throw new Error('Expected a check.')
      if (publication.effect.phase.status === 'queued' && ++attempts === 1)
        return { _tag: 'Err', error: { _tag: 'Transient', message: 'Temporary check failure.' } }
      remote = publication.effect.phase.status
      return ok({ id: 'check', url: null, data: null })
    } }, async () => {
      await waiting
      return { _tag: 'Succeeded', output: null }
    })
    const check = (status: 'queued' | 'in_progress'): PublicationEffect => ({ _tag: 'Check', repository: 'acme/project', headSha: 'a'.repeat(40), name: 'Outbox', phase: { status }, summary: status })
    h.runner.publishSystem(h.run.id, 'queued', check('queued'))
    await h.runner.tick()
    h.runner.publishSystem(h.run.id, 'running', check('in_progress'))
    await h.runner.tick()
    h.advance()
    await h.runner.tick()
    expect(remote).toBe('in_progress')
    expect(attempts).toBe(1)
    release!()
    await h.runner.drain()
    await h.runner.close()
  })

  it('reconciles a real HTTP write whose acknowledgement throws without writing twice', async () => {
    let writes = 0
    const server = createServer((incoming, outgoing) => {
      incoming.resume()
      if (incoming.method === 'POST')
        writes++
      outgoing.setHeader('content-type', 'application/json')
      outgoing.end(JSON.stringify(writes ? { id: 'remote', url: null, data: null } : null))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    await (async () => {
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('The HTTP fixture did not bind.')
      const url = `http://127.0.0.1:${address.port}`
      let reconciliations = 0
      const h = harness({
        authorize: async () => ok(undefined),
        reconcile: async () => {
          const response = await fetch(url)
          if (++reconciliations === 1)
            throw new Error('Response body disconnected during reconciliation.')
          return ok(await response.json())
        },
        publish: async () => {
          await fetch(url, { method: 'POST' })
          throw new Error('The transport closed after GitHub accepted the write.')
        },
      }, async (context) => {
        await context.publish('result', comment('FINAL'))
        return { _tag: 'Succeeded', output: null }
      })
      await h.runner.drain()
      h.advance(60_000)
      await h.runner.drain()
      h.advance(60_000)
      await h.runner.drain()
      expect(writes).toBe(1)
      expect(reconciliations).toBe(2)
      expect(h.runner.inspect(h.run.id)?.state._tag).toBe('Succeeded')
      await h.runner.close()
    })().finally(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  })

  it('waits for temporary publication authorization without repeating the task', async () => {
    let checks = 0
    let tasks = 0
    let writes = 0
    const h = harness({
      authorize: async () => ++checks === 1 ? { _tag: 'Err', error: { _tag: 'Capacity', message: 'GitHub rate limit.' } } : ok(undefined),
      reconcile: async () => ok(null),
      publish: async () => {
        writes++
        return ok({ id: 'comment', url: null, data: null })
      },
    }, async (context) => {
      tasks++
      await context.publish('result', comment('FINAL'))
      return { _tag: 'Succeeded', output: null }
    })
    await h.runner.drain()
    h.advance(60_000)
    await h.runner.drain()
    expect(tasks).toBe(1)
    expect(writes).toBe(1)
    expect(h.runner.inspect(h.run.id)?.state._tag).toBe('Succeeded')
    await h.runner.close()
  })
})
