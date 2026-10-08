import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { H3 } from 'h3'
import { expect, it } from 'vitest'
import { createSessionController } from '../src/session-controller.ts'
import { registerSessionRoutes } from '../src/session-routes.ts'

it('runs the browser and desktop Session APIs and rejects malformed boundaries', async () => {
  const controller = createSessionController({ path: join(mkdtempSync(join(tmpdir(), 'session-routes-')), 'sessions.json'), now: () => new Date('2026-10-08T00:00:00Z') })
  const app = new H3()
  registerSessionRoutes(app, controller)
  async function post(path: string, input: unknown) {
    return app.request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(input) })
  }
  expect((await post('/api/desktop/sessions/report', { host: 'desktop' as const, instanceId: 'desktop', protocol: 2, projects: [{ id: 'pkg/demo', name: 'demo', path: '/home/harlan/pkg/demo', kind: 'pkg' }] })).status).toBe(200)
  const started = await post('/api/sessions', { host: 'desktop' as const, projectId: 'pkg/demo', provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high', prompt: 'Fix it', requestId: 'request' })
  expect(started.status).toBe(200)
  const session = await started.json() as { id: string }
  expect((await app.request(`http://localhost/api/sessions/${session.id}`)).status).toBe(200)
  const claimed = await post('/api/desktop/sessions/claim', { host: 'desktop' as const, instanceId: 'desktop', freeSlots: 1 })
  const turn = await claimed.json() as { sessionId: string, turnId: string, leaseToken: string }
  const fence = { host: 'desktop' as const, instanceId: 'desktop', sessionId: turn.sessionId, turnId: turn.turnId, leaseToken: turn.leaseToken }
  expect(await (await post('/api/desktop/sessions/heartbeat', fence)).json()).toEqual({ active: true, cancelled: false })
  expect((await post('/api/desktop/sessions/events', { ...fence, seq: 1, events: [{ _tag: 'ShellExecute', command: 'anything' }] })).status).toBe(400)
  expect((await post('/api/desktop/sessions/complete', { ...fence, outcome: 'completed', workspacePath: '../escape' })).status).toBe(400)
  expect((await post(`/api/sessions/${session.id}/stop`, {})).status).toBe(200)
  expect(await (await post('/api/desktop/sessions/complete', { ...fence, outcome: 'stopped' })).json()).toEqual({ accepted: true })
  expect((await post('/api/sessions', { projectId: '../../etc', prompt: 'bad' })).status).toBe(400)
  expect((await app.request('http://localhost/api/sessions', { method: 'POST', body: '{bad' })).status).toBe(400)
})

it('denies public ingress even when a session route was matched', async () => {
  const controller = createSessionController({ path: join(mkdtempSync(join(tmpdir(), 'session-ingress-')), 'sessions.json'), now: () => new Date() })
  const app = new H3()
  registerSessionRoutes(app, controller)
  const headers = { 'x-harlan-agent-ingress': 'public' }
  expect((await app.request('http://localhost/api/sessions', { headers })).status).toBe(403)
  expect((await app.request('http://localhost/api/desktop/sessions/claim', { method: 'POST', headers, body: JSON.stringify({ host: 'desktop' as const, instanceId: 'desktop', freeSlots: 1 }) })).status).toBe(403)
})

it('accepts completion before workspace and provider identity exist', async () => {
  const controller = createSessionController({ path: join(mkdtempSync(join(tmpdir(), 'session-null-')), 'sessions.json'), now: () => new Date() })
  controller.report({ host: 'desktop' as const, instanceId: 'desktop', protocol: 2, projects: [{ id: 'pkg/demo', name: 'demo', path: '/home/harlan/pkg/demo', kind: 'pkg' }] })
  const session = controller.start({ host: 'desktop' as const, projectId: 'pkg/demo', provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'high', prompt: 'Fix it', requestId: 'request' })
  const turn = controller.claim({ host: 'desktop' as const, instanceId: 'desktop', freeSlots: 1 })!
  const app = new H3()
  registerSessionRoutes(app, controller)
  const response = await app.request('http://localhost/api/desktop/sessions/complete', { method: 'POST', body: JSON.stringify({ host: 'desktop' as const, instanceId: 'desktop', sessionId: turn.sessionId, turnId: turn.turnId, leaseToken: turn.leaseToken, outcome: 'stopped', workspacePath: null, providerSessionId: null }) })
  expect(response.status).toBe(200)
  expect(controller.get(session.id)).toMatchObject({ status: 'stopped', workspacePath: null, providerSessionId: null })
})
