import type { AgentEvent, AgentProvider } from '../src/agent-provider.ts'
import type { DashboardTask } from '../src/types.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createAgentActivityLog } from '../src/agent-activity.ts'
import { CODEX_AGENT_PROFILE } from '../src/agent-profile.ts'
import { agentPhase } from '../src/agent-progress.ts'
import { runAgentTurn } from '../src/agent-turn.ts'
import { createAgentApp } from '../src/app.ts'
import { openBrowserAuthStore } from '../src/browser-auth-store.ts'
import { createBrowserAuth } from '../src/browser-auth.ts'
import { createHandoffController, withRepositoryHandoffs } from '../src/repository-handoffs.ts'
import { ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { agentRuntime, agentTurnLedger, dashboardSnapshot } from './fixtures.ts'

const origin = 'http://localhost:3210'
const password = 'fixture-password'
const authorization = `Basic ${Buffer.from(`agent:${password}`).toString('base64')}`
const repository = 'harlan-zw/nuxtseo.com'
const now = new Date('2026-11-25T04:45:00Z')
const marker = 'Private migration witness 798'
const events: AgentEvent[] = [
  { _tag: 'Reasoning', text: marker },
  { _tag: 'Progress', percent: 50, text: marker },
  { _tag: 'CommandStarted', command: marker },
  { _tag: 'CommandCompleted', command: marker, output: marker, exitCode: 0 },
  { _tag: 'FileChanged', changes: [{ path: marker, kind: 'update' }] },
  { _tag: 'ContextBudgetWarned', cachedTokensRead: 100, delivery: { _tag: 'Failed', reason: marker } },
]

it.each(events)('keeps Handoff-bearing Task activity private for $_tag', async (event) => {
  const directory = mkdtempSync(join(tmpdir(), 'handoff-activity-'))
  const journal = openJournalStore(':memory:', false)
  const authStores = [openBrowserAuthStore(join(directory, 'public.sqlite')), openBrowserAuthStore(join(directory, 'private.sqlite'))]
  const authorities = authStores.map(store => createBrowserAuth({ origin, rpId: 'localhost', store, now: () => now.getTime(), surface: { _tag: 'Dashboard' }, bootstrapKind: 'passkey', bootstrap: () => false }))
  const task: DashboardTask = {
    id: 'task',
    repository,
    issueNumber: 42,
    kind: 'issue_work',
    revisionId: 'revision',
    updatedAt: now.toISOString(),
    progress: { percent: 0, label: 'Starting' },
    state: { _tag: 'Running', workerId: 'fixture', fence: 1, leaseExpiresAt: '2026-11-25T04:46:00Z' },
  }
  const handoffs = createHandoffController({ store: journal, repositories: [repository], now: () => now })
  const activityLog = createAgentActivityLog()
  const shutdown = new AbortController()
  try {
    expect(handoffs.postControl({ repository, agent: 'fixture', requestId: 'fixture', message: marker })._tag).toBe('Ok')
    const provider: AgentProvider = {
      name: 'codex',
      async* runTurn(request) {
        expect(request.prompt).toContain(marker)
        yield { _tag: 'SessionStarted', sessionId: 'fixture' }
        yield event
        yield { _tag: 'Message', text: '{"outcome":"implemented","agentHandoff":null}' }
        yield { _tag: 'TurnCompleted' }
      },
    }
    const wrapped = withRepositoryHandoffs(provider, { handoffs, now: () => now, readTask: () => task, log: () => {} })
    const labels: string[] = []
    const result = await runAgentTurn({
      now: () => now,
      activityLog,
      runtime: agentRuntime(CODEX_AGENT_PROFILE, wrapped),
      store: { ...agentTurnLedger, getWorkerSession: () => null, saveWorkerSession: () => {} },
    }, {
      taskId: task.id,
      role: 'issue_work',
      repository,
      number: 42,
      workspace: directory,
      prompt: 'Implement.',
      schema: { type: 'object', properties: { outcome: { type: 'string' } }, required: ['outcome'] },
      progress: {
        current: agentPhase('WorktreeReady', 'Starting'),
        work: 'issue',
        report: (phase) => {
          labels.push(phase.label)
          return ok(undefined)
        },
      },
    }, shutdown.signal)
    expect(result._tag).toBe('Ok')
    expect(JSON.stringify(activityLog.read(task.id))).toContain(marker)
    expect.soft(JSON.stringify(labels)).not.toContain(marker)
    const snapshot = dashboardSnapshot({ agents: [{
      _tag: 'ActiveAgent',
      id: task.id,
      provider: 'codex',
      role: 'issue_work',
      author: 'harlan-zw',
      session: { _tag: 'Starting' },
      repository,
      repositoryUrl: `https://github.com/${repository}`,
      subjectKind: 'issue',
      itemNumber: 42,
      title: 'Fixture',
      subjectUrl: `https://github.com/${repository}/issues/42`,
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      progress: task.progress,
      activity: [],
      state: { _tag: 'Working', workerId: 'fixture', fence: 1, leaseExpiresAt: '2026-11-25T04:46:00Z' },
    }] })
    const app = createAgentApp({
      store: { ...journal, getTask: () => task, getDashboardSnapshot: () => snapshot },
      handoffs,
      activityLog,
      allowedOrigin: origin,
      dashboardPassword: password,
      now: () => now,
      browserAuth: { public: authorities[0]!, private: authorities[1]! },
      shutdownSignal: shutdown.signal,
    })
    const read = (path: string, credentials: Record<string, string>) => app.request(`${origin}${path}`, { headers: { host: 'localhost:3210', ...credentials } })
    const credentials = [
      { 'cookie': authorities[0]!.issueSession('fixture').split(';')[0]!, 'x-harlan-agent-ingress': 'public' },
      { cookie: authorities[1]!.issueSession('fixture').split(';')[0]! },
    ]
    for (const headers of credentials) {
      const response = await read('/api/tasks/activity?task=task', headers)
      expect.soft(await response.text()).not.toContain(marker)
      expect.soft(response.status).toBe(401)
      const state = await read('/api/state', headers)
      expect(state.status).toBe(200)
      expect.soft(await state.text()).not.toContain(marker)
      const stream = await read('/api/events', headers)
      const reader = stream.body!.getReader()
      try {
        await reader.read() // connected comment
        const initial = await reader.read()
        expect.soft(new TextDecoder().decode(initial.value)).not.toContain(marker)
      }
      finally {
        await reader.cancel()
      }
    }
    expect((await read('/api/tasks/activity?task=task', { authorization, 'x-harlan-agent-ingress': 'public' })).status).toBe(401)
    const control = await read('/api/tasks/activity?task=task', { authorization })
    expect(control.status).toBe(200)
    expect(await control.text()).toContain(marker)
  }
  finally {
    shutdown.abort()
    authStores.forEach(store => store.close())
    journal.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
