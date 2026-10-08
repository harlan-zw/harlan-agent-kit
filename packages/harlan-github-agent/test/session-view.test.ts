import type { DesktopSession } from '../src/session-protocol.ts'
import { describe, expect, it } from 'vitest'
import { sessionAcceptsMessage, sessionFailureMessage, sessionHostProjects, sessionRunning, sessionTimeline } from '../dashboard/app/utils/session.ts'

function session(overrides: Partial<DesktopSession> = {}): DesktopSession {
  return {
    id: 'one',
    host: 'desktop',
    project: { id: 'pkg/example', name: 'example', kind: 'pkg', path: '/home/harlan/pkg/example' },
    provider: 'codex',
    model: 'gpt-6.1-sol',
    reasoningEffort: 'high',
    title: 'Inspect routes',
    createdAt: '2026-10-08T01:00:00Z',
    updatedAt: '2026-10-08T01:00:00Z',
    status: 'idle',
    workspacePath: null,
    providerSessionId: null,
    messages: [],
    events: [],
    ...overrides,
  }
}

describe('session presentation', () => {
  it('pairs a command completion with its running row and preserves tool/message order', () => {
    const value = session({ messages: [{ id: 'prompt', role: 'user', text: 'Inspect routes', createdAt: '2026-10-08T01:00:00Z' }], events: [
      { seq: 1, turnId: 'turn', createdAt: '2026-10-08T01:01:00Z', event: { _tag: 'CommandStarted', command: 'pnpm test' } },
      { seq: 2, turnId: 'turn', createdAt: '2026-10-08T01:02:00Z', event: { _tag: 'CommandCompleted', command: 'pnpm test', output: 'Passed', exitCode: 0 } },
      { seq: 3, turnId: 'turn', createdAt: '2026-10-08T01:03:00Z', event: { _tag: 'Message', text: 'Routes pass.' } },
    ] })
    expect(sessionTimeline(value)).toEqual([
      { kind: 'message', id: 'prompt', role: 'You', text: 'Inspect routes', at: '2026-10-08T01:00:00Z' },
      { kind: 'activity', id: 'turn:1', tools: [{ id: 'turn:1', kind: 'command', label: 'pnpm test', detail: 'Passed', status: 'passed' }] },
      { kind: 'message', id: 'turn:3', role: 'Agent', text: 'Routes pass.', at: '2026-10-08T01:03:00Z' },
    ])
  })
  it('does not leave a command running after confirmed Stop', () => {
    const value = session({ status: 'stopped', events: [{ seq: 1, turnId: 'turn', createdAt: '2026-10-08T01:01:00Z', event: { _tag: 'CommandStarted', command: 'pnpm test' } }] })
    expect(sessionTimeline(value)).toEqual([{ kind: 'activity', id: 'turn:1', tools: [{ id: 'turn:1', kind: 'command', label: 'pnpm test', detail: 'Command output unavailable.', status: 'stopped' }] }])
  })
  it('retains host history when a disconnected host has no project report', () => {
    const desktop = session()
    const hogwild = session({ id: 'other', host: 'hogwild', project: { ...desktop.project, path: '/home/agent/pkg/example' } })
    const value = { hosts: { desktop: { connected: false, current: true }, hogwild: { connected: true, current: true } }, projects: { desktop: [], hogwild: [hogwild.project] }, sessions: [desktop, hogwild] }
    expect(sessionHostProjects(value, 'desktop')).toEqual([desktop.project])
    expect(sessionHostProjects(value, 'hogwild')).toEqual([hogwild.project])
  })
  it('requires confirmed Stop before another message after disconnection', () => {
    expect(sessionAcceptsMessage(session({ status: 'interrupted' }))).toBe(false)
    expect(sessionAcceptsMessage(session({ status: 'stopping' }))).toBe(false)
    expect(sessionAcceptsMessage(session({ status: 'stopped' }))).toBe(true)
  })
  it('shows the server connection instruction before the generic fetch failure', () => {
    const error = Object.assign(new Error('[GET] /api/sessions: 403 Forbidden'), { data: { message: 'Connect through Tailscale.' } })
    expect(sessionFailureMessage(error, 'Could not load sessions. Retry.')).toBe('Connect through Tailscale.')
  })
  it('shows the deployment instruction from statusMessage', () => {
    const error = { data: { statusMessage: 'Enable Agent sessions after installing the private ingress.' } }
    expect(sessionFailureMessage(error, 'Could not load sessions. Retry.')).toBe('Enable Agent sessions after installing the private ingress.')
  })
  it('rejects non-text server errors and uses the specific fallback', () => {
    expect(sessionFailureMessage({ data: { message: { detail: 'bad' } } }, 'Could not load sessions. Retry.')).toBe('Could not load sessions. Retry.')
  })
  it('puts messages in conversation order with command evidence between messages', () => {
    const value = session({
      messages: [
        { id: 'follow', role: 'user', text: 'Continue', createdAt: '2026-10-08T01:03:00Z' },
        { id: 'first', role: 'user', text: 'Inspect routes', createdAt: '2026-10-08T01:00:00Z' },
      ],
      events: [
        { seq: 1, turnId: 'turn', createdAt: '2026-10-08T01:01:00Z', event: { _tag: 'CommandCompleted', command: 'pnpm test', output: 'Passed', exitCode: 0 } },
        { seq: 2, turnId: 'turn', createdAt: '2026-10-08T01:02:00Z', event: { _tag: 'Message', text: 'Routes pass.' } },
      ],
    })
    expect(sessionTimeline(value).flatMap(entry => entry.kind === 'message' ? [`${entry.role}: ${entry.text}`] : [])).toEqual(['You: Inspect routes', 'Agent: Routes pass.', 'You: Continue'])
    expect(sessionTimeline(value).flatMap(entry => entry.kind === 'activity' ? entry.tools.map(tool => tool.detail) : [])).toEqual(['Passed'])
  })

  it('shows file changes and failure reasons without turning them into Agent messages', () => {
    const value = session({ events: [
      { seq: 1, turnId: 'turn', createdAt: '2026-10-08T01:01:00Z', event: { _tag: 'FileChanged', changes: [{ path: 'src/routes.ts', kind: 'update' }] } },
      { seq: 2, turnId: 'turn', createdAt: '2026-10-08T01:02:00Z', event: { _tag: 'Failed', reason: 'Desktop disconnected.' } },
    ] })
    expect(sessionTimeline(value).flatMap(entry => entry.kind === 'activity' ? entry.tools.map(tool => tool.detail) : [])).toEqual(['update: src/routes.ts', 'Desktop disconnected.'])
    expect(sessionTimeline(value).filter(entry => entry.kind === 'message')).toEqual([])
  })

  it.each(['queued', 'running', 'stopping'] as const)('keeps %s sessions busy until confirmed terminal', (status) => {
    expect(sessionRunning(session({ status }))).toBe(true)
  })
  it.each(['idle', 'failed', 'stopped', 'interrupted'] as const)('marks %s outside active execution', (status) => {
    expect(sessionRunning(session({ status }))).toBe(false)
  })
})
