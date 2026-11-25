import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createAgentApp } from '../src/app.ts'
import { openBrowserAuthStore } from '../src/browser-auth-store.ts'
import { createBrowserAuth } from '../src/browser-auth.ts'
import { createDesktopBroker } from '../src/desktop-broker.ts'
import { DESKTOP_PROTOCOL, readDesktopResponse } from '../src/desktop-protocol.ts'
import { desktopCommand } from '../src/desktop-worktree.ts'
import { createHandoffController, withRepositoryHandoffs } from '../src/repository-handoffs.ts'
import { openJournalStore } from '../src/store.ts'

const origin = 'http://localhost:3210'
const password = 'fixture-desktop-password'
const authorization = `Basic ${Buffer.from(`agent:${password}`).toString('base64')}`
const repository = 'harlan-zw/nuxtseo.com'
const now = new Date('2026-11-25T04:45:00Z')

it('keeps Handoff desktop turns private while allowing the machine client to claim them', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'desktop-handoff-access-'))
  const journal = openJournalStore(':memory:', false)
  const authStores = [openBrowserAuthStore(join(directory, 'public.sqlite')), openBrowserAuthStore(join(directory, 'private.sqlite'))]
  const authorities = authStores.map(store => createBrowserAuth({ origin, rpId: 'localhost', store, now: () => now.getTime(), surface: { _tag: 'Dashboard' }, bootstrapKind: 'passkey', bootstrap: () => false }))
  const publicAuth = authorities[0]!
  const privateAuth = authorities[1]!
  const desktop = createDesktopBroker({ now: () => now.getTime() })
  const handoffs = createHandoffController({ store: journal, repositories: [repository], now: () => now })
  const app = createAgentApp({ store: journal, handoffs, desktop, allowedOrigin: origin, dashboardPassword: password, now: () => now, browserAuth: { public: publicAuth, private: privateAuth } })
  const send = (path: string, credentials: Record<string, string>, method = 'POST') => app.request(`${origin}${path}`, {
    method,
    headers: { host: 'localhost:3210', origin, ...credentials },
    ...(method === 'POST' ? { body: '{}' } : {}),
  })
  const signal = new AbortController()
  let stopped: Promise<unknown> | undefined
  try {
    const message = 'Private Handoff: migration witness 798.'
    expect(handoffs.postControl({ repository, agent: 'fixture', requestId: 'fixture', message })._tag).toBe('Ok')
    const git = (args: string[]) => desktopCommand('git', ['-c', 'core.hooksPath=/dev/null', ...args], directory)
    await git(['init', '-b', 'main'])
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'test: seed'])
    await git(['remote', 'add', 'origin', 'https://github.com/harlan-zw/nuxtseo.com.git'])
    desktop.report({ protocol: DESKTOP_PROTOCOL, memoryGiB: 16, reservedGiB: 0, agents: 0, actions: 0 })
    const provider = withRepositoryHandoffs(desktop.provider('codex'), { handoffs, now: () => now, log: () => {}, readTask: () => ({
      id: 'task',
      repository,
      issueNumber: 42,
      kind: 'issue_work',
      revisionId: 'revision',
      updatedAt: now.toISOString(),
      progress: { percent: 0, label: 'Starting' },
      state: { _tag: 'Running', workerId: 'fixture', fence: 1, leaseExpiresAt: '2026-11-25T04:46:00Z' },
    }) })
    const iterator = provider.runTurn({ model: 'fixture', taskId: 'task', workspace: directory, prompt: 'Implement.', outputSchema: { type: 'object', properties: {}, required: [] }, sessionId: null, signal: signal.signal })[Symbol.asyncIterator]()
    stopped = expect(iterator.next()).rejects.toThrow()
    // Wait for the real Git export, then return the turn to the queue.
    await expect.poll(() => {
      const turn = desktop.claim()
      return turn !== null && desktop.defer(turn.id)
    }).toBe(true)

    const browsers: Record<string, string>[] = [
      { 'cookie': publicAuth.issueSession('fixture-passkey').split(';')[0]!, 'x-harlan-agent-ingress': 'public' },
      { cookie: privateAuth.issueSession('fixture-passkey').split(';')[0]! },
    ]
    for (const credentials of browsers) {
      expect(await (await send('/api/browser-auth/session', credentials, 'GET')).json()).toMatchObject({ authenticated: true })
      const snapshot = await send('/api/state', credentials, 'GET')
      expect(snapshot.status).toBe(200)
      expect(await snapshot.text()).not.toContain(message)
      const response = await send('/api/desktop/claim', credentials)
      expect(response.status).toBe(401)
      expect(await response.text()).not.toContain(message)
    }
    for (const credentials of [...browsers, { authorization, 'x-harlan-agent-ingress': 'public' }]) {
      for (const action of ['capacity', 'report', 'claim', 'defer', 'heartbeat', 'events', 'proof', 'complete', 'sessions/report', 'sessions/claim', 'sessions/heartbeat', 'sessions/defer', 'sessions/events', 'sessions/complete'])
        expect((await send(`/api/desktop/${action}`, credentials)).status, action).toBe(401)
      for (const method of ['GET', 'POST'])
        expect((await send('/api/handoffs', credentials, method)).status).toBe(401)
    }
    const response = await send('/api/desktop/claim', { authorization })
    expect(response.status).toBe(200)
    const claimed = await readDesktopResponse(response)
    expect(claimed).toMatchObject({ request: { prompt: expect.stringContaining('Implement.') } })
    expect(JSON.stringify(claimed)).not.toContain(message)
  }
  finally {
    signal.abort()
    await stopped
    authStores.forEach(store => store.close())
    journal.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
