import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSessionController } from '../src/session-controller.ts'
import { parseStartSession } from '../src/session-protocol.ts'

function fixture() {
  let time = new Date('2026-10-08T00:00:00Z')
  const path = join(mkdtempSync(join(tmpdir(), 'agent-sessions-')), 'sessions.json')
  const options = { path, now: () => time }
  const controller = createSessionController(options)
  controller.report({ instanceId: 'desktop-1', protocol: 1, projects: [{ id: 'pkg/example', name: 'example', path: '/home/harlan/pkg/example', kind: 'pkg' }] })
  const input = { projectId: 'pkg/example', provider: 'codex' as const, model: 'gpt-5.6-sol', reasoningEffort: 'high' as const, prompt: 'Fix this project.', requestId: 'request-1' }
  return { controller, options, input, advance: () => {
    time = new Date(time.getTime() + 31_000)
  } }
}
describe('desktop Agent sessions', () => {
  it('rejects unsupported selection and missing prompts at the boundary', () => {
    const { input } = fixture()
    expect(() => parseStartSession({ ...input, provider: 'bash' })).toThrow('provider')
    expect(() => parseStartSession({ ...input, prompt: '' })).toThrow('prompt')
    expect(() => parseStartSession({ ...input, model: '--shell' })).toThrow('model')
  })
  it('deduplicates starts and prevents a second turn', () => {
    const { controller, input } = fixture()
    const session = controller.start(input)
    expect(controller.start(input).id).toBe(session.id)
    expect(controller.snapshot().sessions).toHaveLength(1)
    expect(() => controller.message(session.id, { prompt: 'Again', requestId: 'request-2' })).toThrow('stopped')
    expect(() => controller.start({ ...input, prompt: 'Other' })).toThrow('request ID')
  })
  it('stores ordered events and resumes the same desktop Worktree', () => {
    const { controller, input } = fixture()
    const session = controller.start(input)
    const turn = controller.claim({ instanceId: 'desktop-1', freeSlots: 1 })!
    const fence = { instanceId: 'desktop-1', sessionId: turn.sessionId, turnId: turn.turnId, leaseToken: turn.leaseToken }
    expect(() => controller.events({ ...fence, seq: 2, events: [] })).toThrow('order')
    expect(controller.events({ ...fence, seq: 1, events: [{ _tag: 'Message', text: 'Done' }] }).accepted).toBe(true)
    controller.events({ ...fence, seq: 1, events: [{ _tag: 'Message', text: 'Done' }] })
    controller.complete({ ...fence, outcome: 'completed', workspacePath: '/home/harlan/pkg/example.agent-session', providerSessionId: 'native-session' })
    expect(controller.get(session.id).events.map(event => event.event)).toEqual([{ _tag: 'Message', text: 'Done' }])
    controller.message(session.id, { prompt: 'Continue', requestId: 'request-2' })
    expect(controller.claim({ instanceId: 'desktop-1', freeSlots: 1 })).toMatchObject({ workspacePath: '/home/harlan/pkg/example.agent-session', providerSessionId: 'native-session', prompt: 'Continue' })
  })
  it('requires desktop confirmation before a running stop finishes', () => {
    const { controller, input } = fixture()
    const session = controller.start(input)
    const turn = controller.claim({ instanceId: 'desktop-1', freeSlots: 1 })!
    const fence = { instanceId: 'desktop-1', sessionId: turn.sessionId, turnId: turn.turnId, leaseToken: turn.leaseToken }
    expect(controller.stop(session.id).status).toBe('stopping')
    expect(controller.heartbeat(fence)).toEqual({ active: true, cancelled: true })
    controller.complete({ ...fence, outcome: 'stopped' })
    expect(controller.get(session.id).status).toBe('stopped')
  })
  it('fences lost desktops and never replays uncertain work', () => {
    const { controller, input, advance } = fixture()
    const session = controller.start(input)
    const turn = controller.claim({ instanceId: 'desktop-1', freeSlots: 1 })!
    advance()
    expect(controller.get(session.id).status).toBe('interrupted')
    expect(controller.events({ instanceId: 'desktop-1', ...turn, seq: 1, events: [{ _tag: 'Message', text: 'Late' }] }).accepted).toBe(false)
    expect(controller.claim({ instanceId: 'desktop-1', freeSlots: 1 })).toBeNull()
  })
  it('preserves messages across controller restart without replaying running work', () => {
    const { controller, options, input } = fixture()
    const session = controller.start(input)
    controller.claim({ instanceId: 'desktop-1', freeSlots: 1 })
    const restarted = createSessionController(options)
    expect(restarted.get(session.id)).toMatchObject({ status: 'interrupted', messages: [{ text: input.prompt }] })
    expect(restarted.start(input).id).toBe(session.id)
  })
})

it('resumes interrupted work only after the desktop confirms the old process stopped', () => {
  const { controller, input, advance } = fixture()
  const session = controller.start(input)
  const turn = controller.claim({ instanceId: 'desktop-1', freeSlots: 1 })!
  const fence = { instanceId: 'desktop-1', sessionId: turn.sessionId, turnId: turn.turnId, leaseToken: turn.leaseToken }
  advance()
  expect(controller.get(session.id).status).toBe('interrupted')
  controller.stop(session.id)
  const report = controller.report({ instanceId: 'desktop-2', protocol: 1, projects: [session.project] })
  expect(report.stops).toEqual([fence])
  expect(controller.events({ ...fence, seq: 1, events: [] }).accepted).toBe(false)
  expect(controller.complete({ ...fence, outcome: 'completed' }).accepted).toBe(false)
  expect(controller.complete({ ...fence, outcome: 'stopped', workspacePath: '/saved/worktree', providerSessionId: 'native' }).accepted).toBe(true)
  controller.message(session.id, { prompt: 'Resume', requestId: 'resume' })
  expect(controller.claim({ instanceId: 'desktop-2', freeSlots: 1 })).toMatchObject({ workspacePath: '/saved/worktree', providerSessionId: 'native' })
})

it('deduplicates prototype-named request IDs across restart', () => {
  const { controller, input, options } = fixture()
  const session = controller.start({ ...input, requestId: '__proto__' })
  expect(controller.start({ ...input, requestId: '__proto__' }).id).toBe(session.id)
  const restarted = createSessionController(options)
  expect(restarted.start({ ...input, requestId: '__proto__' }).id).toBe(session.id)
})

it('rejects a failed save without acknowledging an unpersisted Session on retry', () => {
  const { controller, input, options } = fixture()
  const directory = dirname(options.path)
  renameSync(directory, `${directory}.saved`)
  writeFileSync(directory, 'This path cannot be a directory.')
  expect(() => controller.start(input)).toThrow()
  expect(controller.snapshot().sessions).toEqual([])
  rmSync(directory)
  renameSync(`${directory}.saved`, directory)
  const session = controller.start(input)
  expect(createSessionController(options).get(session.id).messages[0]?.text).toBe(input.prompt)
})
