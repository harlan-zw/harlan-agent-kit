import type { AgentEvent, AgentProvider, AgentTurnRequest } from '../src/agent-provider.ts'
import type { DashboardTask } from '../src/types.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { runParsedAgentTurn } from '../src/agent-turn.ts'
import { createAgentApp } from '../src/app.ts'
import { createControlClient } from '../src/control-client.ts'
import { createHandoffController, withRepositoryHandoffs } from '../src/repository-handoffs.ts'
import { err, ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { agentRuntime, agentTurnLedger } from './fixtures.ts'

const repository = 'harlan-zw/nuxtseo.com'
const other = 'harlan-zw/other'
const at = new Date('2026-11-25T04:45:00Z')
const origin = 'http://localhost:3210'
const password = 'fixture-handoff-password'
const logger = vi.fn()
const taskId = 'a'.repeat(64)
const issue = { _tag: 'Issue', number: 42 } as const

function clientFor(store: ReturnType<typeof openJournalStore>, passwordOverride = password, ingress?: 'public', declareBodySize = false) {
  const handoffs = createHandoffController({ store, repositories: [repository, other], now: () => at })
  const app = createAgentApp({ store, handoffs, allowedOrigin: origin, dashboardPassword: password, now: () => at })
  const client = createControlClient({
    baseUrl: origin,
    authentication: { _tag: 'Basic', password: passwordOverride },
    async fetch(input, init) {
      const request = new Request(input, init)
      request.headers.set('host', new URL(request.url).host)
      if (declareBodySize && typeof init?.body === 'string')
        request.headers.set('content-length', String(Buffer.byteLength(init.body)))
      if (ingress !== undefined)
        request.headers.set('x-harlan-agent-ingress', ingress)
      return app.fetch(request)
    },
  })
  if (client._tag === 'Err')
    throw new Error(client.error.message)
  return { client: client.value, handoffs }
}

it('keeps addressed Handoffs after restart and gives a retry the same receipt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'repo-handoffs-'))
  const path = join(directory, 'journal.sqlite')
  const root = { repository, agent: 'agent-a', message: 'Code is still running.', requestId: 'message-a', item: issue }
  let store = openJournalStore(path, false)
  try {
    const first = await clientFor(store).client.postHandoff(root)
    if (first._tag === 'Err')
      throw new Error(first.error.message)
    store.close()
    store = openJournalStore(path, false)
    const { client } = clientFor(store)
    await expect(client.postHandoff(root)).resolves.toEqual(first)
    await expect(client.postHandoff({ ...root, message: 'Different message.' })).resolves.toMatchObject({ _tag: 'Err', error: { status: 409 } })
    const reply = { repository, agent: 'agent-b', message: 'I will watch the deploy.', requestId: 'message-b', replyTo: first.value.id }
    await expect(client.postHandoff({ ...reply, repository: other })).resolves.toMatchObject({ _tag: 'Err', error: { status: 404 } })
    await expect(client.postHandoff(reply)).resolves.toMatchObject({ _tag: 'Ok', value: { item: issue, replyTo: first.value.id } })
    await expect(client.handoffs({ repository, after: first.value.id })).resolves.toMatchObject({ _tag: 'Ok', value: { handoffs: [{ message: reply.message }] } })
    await expect(client.handoffs({ repository: other })).resolves.toMatchObject({ _tag: 'Ok', value: { handoffs: [] } })
  }
  finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each([false, true])('rejects an oversized Handoff before parsing its message, with declared size %s', async (declareBodySize) => {
  const store = openJournalStore(':memory:', false)
  try {
    await expect(clientFor(store, password, undefined, declareBodySize).client.postHandoff({
      repository,
      agent: 'fixture',
      requestId: 'size',
      message: 'x'.repeat(13_000),
    })).resolves.toMatchObject({ _tag: 'Err', error: { status: 413 } })
  }
  finally {
    store.close()
  }
})

it('requires a Control credential and restricts access to enabled repositories', async () => {
  const store = openJournalStore(':memory:', false)
  try {
    const unauthenticated = clientFor(store, 'wrong').client
    await expect(unauthenticated.handoffs({ repository })).resolves.toMatchObject({ _tag: 'Err', error: { status: 401 } })
    await expect(clientFor(store, password, 'public').client.handoffs({ repository })).resolves.toMatchObject({ _tag: 'Err', error: { status: 401 } })
    const { client } = clientFor(store)
    await expect(client.handoffs({ repository: 'example/outside' })).resolves.toMatchObject({ _tag: 'Err', error: { status: 404 } })
  }
  finally {
    store.close()
  }
})

it('returns a new Handoff to an Agent waiting with a cursor', async () => {
  const store = openJournalStore(':memory:', false)
  try {
    const { client } = clientFor(store)
    let finished = false
    const waiting = client.handoffs({ repository, after: 0, waitSeconds: 2 }).then((result) => {
      finished = true
      return result
    })
    await setImmediate()
    expect(finished).toBe(false)
    await expect(client.postHandoff({ repository, agent: 'second-agent', requestId: 'is-ready', message: 'Ready to review.' })).resolves.toMatchObject({ _tag: 'Ok' })
    await expect(waiting).resolves.toMatchObject({ _tag: 'Ok', value: { handoffs: [{ message: 'Ready to review.' }] } })
  }
  finally {
    store.close()
  }
})

it.each([
  { result: 'implemented', stillOwnsTask: true, shouldPost: true },
  { result: 'implemented', stillOwnsTask: false, shouldPost: false },
  { result: 'rejected', stillOwnsTask: true, shouldPost: false },
])('posts a Handoff only from an accepted result that still owns its Task ($result, $stillOwnsTask)', async ({ result, stillOwnsTask, shouldPost }) => {
  const store = openJournalStore(':memory:', false)
  try {
    const { client, handoffs } = clientFor(store)
    await client.postHandoff({ repository, agent: 'first-agent', requestId: 'first', message: 'The migration has shipped.', item: issue })
    const captured: AgentTurnRequest[] = []
    let fence = 2
    const provider: AgentProvider = {
      name: 'codex',
      async* runTurn(request): AsyncGenerator<AgentEvent> {
        captured.push(request)
        yield { _tag: 'SessionStarted', sessionId: 'agent-handoff-fixture' }
        yield { _tag: 'Message', text: JSON.stringify({ outcome: result, agentHandoff: { message: 'Integration tests passed.', replyTo: 1 } }) }
        if (!stillOwnsTask)
          ++fence
        yield { _tag: 'TurnCompleted' }
      },
    }
    const readTask = (): DashboardTask => ({
      id: taskId,
      repository,
      issueNumber: 42,
      kind: 'issue_work',
      revisionId: 'revision',
      updatedAt: at.toISOString(),
      state: { _tag: 'Running', workerId: 'worker', fence, leaseExpiresAt: '2026-11-25T04:46:00Z' },
      progress: { percent: 0, label: 'Starting' },
    })
    const wrapped = withRepositoryHandoffs(provider, { handoffs, readTask, now: () => at, log: logger })
    const run = await runParsedAgentTurn({
      now: () => at,
      runtime: agentRuntime(CODEX_AGENT_PROFILE, wrapped),
      store: { getWorkerSession: () => null, saveWorkerSession: () => undefined, ...agentTurnLedger },
      parse: response => response === '{"outcome":"implemented"}' ? ok('implemented') : err('The Agent result was rejected.'),
    }, {
      repository,
      role: 'issue_work',
      number: 42,
      taskId,
      schema: { type: 'object', properties: { outcome: { type: 'string' } }, required: ['outcome'] },
      prompt: 'Implement the change.',
      workspace: '/tmp/fixture',
    }, new AbortController().signal)
    expect(captured[0]?.prompt).not.toContain('The migration has shipped.')
    expect(captured[0]?.prompt).toContain('return agentHandoff')
    expect(run._tag).toBe(result === 'implemented' ? 'Ok' : 'Err')
    const records = await client.handoffs({ repository, after: 1 })
    expect(records).toMatchObject({ _tag: 'Ok', value: { handoffs: shouldPost ? [{ message: 'Integration tests passed.', sender: { _tag: 'Task', taskId } }] : [] } })
  }
  finally {
    store.close()
  }
})
