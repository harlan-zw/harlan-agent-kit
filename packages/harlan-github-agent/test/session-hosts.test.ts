import type { SessionHost } from '../src/session-protocol.ts'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createSessionController } from '../src/session-controller.ts'
import { parseSessionFence, parseStartSession } from '../src/session-protocol.ts'

function fixture(availableSlots?: (host: SessionHost) => number) {
  const path = join(mkdtempSync(join(tmpdir(), 'session-hosts-')), 'sessions.json')
  const options = { path, now: () => new Date('2026-10-08T00:00:00Z'), ...(availableSlots === undefined ? {} : { availableSlots }) }
  const controller = createSessionController(options)
  for (const host of ['desktop', 'hogwild'] as const)
    controller.report({ host, instanceId: host, protocol: 2, projects: [{ id: 'pkg/demo', name: 'demo', path: `/home/${host}/pkg/demo`, kind: 'pkg' }] })
  const input = { host: 'desktop' as const, projectId: 'pkg/demo', provider: 'codex' as const, model: 'gpt-5.6-sol', reasoningEffort: 'high' as const, prompt: 'Fix this', requestId: 'request' }
  return { controller, options, input }
}
it('parses explicit host selection and refuses missing hosts', () => {
  const { input } = fixture()
  expect(parseStartSession(input).host).toBe('desktop')
  expect(() => parseStartSession({ ...input, host: undefined })).toThrow('host')
  expect(() => parseSessionFence({ instanceId: 'desktop', sessionId: 's', turnId: 't', leaseToken: 'l' })).toThrow('host')
})
it('isolates inventories, running turns, and stop lists by host', () => {
  const { controller, input } = fixture()
  const desktop = controller.start(input)
  const hogwild = controller.start({ ...input, host: 'hogwild', requestId: 'hogwild-request' })
  const turn = controller.claim({ host: 'desktop', instanceId: 'desktop', freeSlots: 1 })!
  const localTurn = controller.claim({ host: 'hogwild', instanceId: 'hogwild', freeSlots: 1 })!
  expect(turn).toMatchObject({ host: 'desktop', project: { path: '/home/desktop/pkg/demo' } })
  expect(localTurn).toMatchObject({ host: 'hogwild', project: { path: '/home/hogwild/pkg/demo' } })
  controller.report({ host: 'hogwild', instanceId: 'hogwild-new', protocol: 2, projects: [] })
  expect(controller.get(desktop.id).status).toBe('running')
  expect(controller.get(hogwild.id).status).toBe('interrupted')
  controller.stop(hogwild.id)
  const report = controller.report({ host: 'desktop', instanceId: 'desktop', protocol: 2, projects: [desktop.project] })
  expect(report.stops).toEqual([])
  expect(controller.snapshot()).toMatchObject({ hosts: { desktop: { connected: true, current: true }, hogwild: { connected: true, current: true } }, projects: { desktop: [desktop.project], hogwild: [] } })
})
it('rejects wronghost fenced actions without altering the Session', () => {
  const { controller, input } = fixture()
  const session = controller.start(input)
  const turn = controller.claim({ host: 'desktop', instanceId: 'desktop', freeSlots: 1 })!
  const fence = { host: 'hogwild' as const, instanceId: 'desktop', sessionId: turn.sessionId, turnId: turn.turnId, leaseToken: turn.leaseToken }
  expect(controller.heartbeat(fence)).toEqual({ active: false, cancelled: true })
  expect(controller.events({ ...fence, seq: 1, events: [{ _tag: 'Message', text: 'Wrong host' }] }).accepted).toBe(false)
  expect(controller.complete({ ...fence, outcome: 'stopped' }).accepted).toBe(false)
  expect(controller.defer(fence).accepted).toBe(false)
  expect(controller.get(session.id)).toMatchObject({ host: 'desktop', status: 'running', events: [] })
})
it('deduplicates within the pinned host and rejects reusing a request on another host', () => {
  const { controller, input } = fixture()
  const session = controller.start(input)
  expect(controller.start(input).id).toBe(session.id)
  expect(() => controller.start({ ...input, host: 'hogwild' })).toThrow('request ID')
})
it('uses each host capacity without moving a queued Session to another host', () => {
  const { controller, input } = fixture(host => host === 'desktop' ? 0 : 1)
  const desktop = controller.start(input)
  const hogwild = controller.start({ ...input, host: 'hogwild', requestId: 'local-request' })
  expect(controller.claim({ host: 'desktop', instanceId: 'desktop', freeSlots: 1 })).toBeNull()
  expect(controller.claim({ host: 'hogwild', instanceId: 'hogwild', freeSlots: 4 })?.sessionId).toBe(hogwild.id)
  expect(controller.get(desktop.id)).toMatchObject({ host: 'desktop', status: 'queued' })
})
it('migrates version one desktop Sessions and preserves interrupted recovery fences', () => {
  const { controller, input, options } = fixture()
  const session = controller.start(input)
  const turn = controller.claim({ host: 'desktop', instanceId: 'desktop', freeSlots: 1 })!
  const saved = JSON.parse(readFileSync(options.path, 'utf8'))
  saved.version = 1
  for (const stored of saved.sessions) {
    delete stored.session.host
    stored.session.workspacePath = '/saved/desktop/worktree'
    stored.session.providerSessionId = 'original-native-session'
  }
  saved.requests[input.requestId].fingerprint = JSON.stringify({ projectId: input.projectId, provider: input.provider, model: input.model, reasoningEffort: input.reasoningEffort, prompt: input.prompt, requestId: input.requestId })
  writeFileSync(options.path, JSON.stringify(saved))
  const restarted = createSessionController(options)
  expect(restarted.get(session.id)).toMatchObject({ host: 'desktop', status: 'interrupted', workspacePath: '/saved/desktop/worktree', providerSessionId: 'original-native-session' })
  expect(restarted.start(input).id).toBe(session.id)
  restarted.stop(session.id)
  const report = restarted.report({ host: 'desktop', instanceId: 'desktop-new', protocol: 2, projects: [session.project] })
  expect(report.stops).toEqual([{ host: 'desktop', instanceId: 'desktop', sessionId: session.id, turnId: turn.turnId, leaseToken: turn.leaseToken }])
  expect(JSON.parse(readFileSync(options.path, 'utf8')).version).toBe(2)
})
