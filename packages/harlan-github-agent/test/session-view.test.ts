import type { DesktopSession } from '../src/session-protocol.ts'
import { describe, expect, it } from 'vitest'
import { sessionAcceptsMessage, sessionActivity, sessionFailureMessage, sessionRunning, sessionTranscript } from '../dashboard/app/utils/session.ts'

function session(overrides: Partial<DesktopSession> = {}): DesktopSession {
  return {
    id: 'one',
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
    const error = { data: { statusMessage: 'Enable desktop sessions after installing the private ingress.' } }
    expect(sessionFailureMessage(error, 'Could not load sessions. Retry.')).toBe('Enable desktop sessions after installing the private ingress.')
  })
  it('rejects non-text server errors and uses the specific fallback', () => {
    expect(sessionFailureMessage({ data: { message: { detail: 'bad' } } }, 'Could not load sessions. Retry.')).toBe('Could not load sessions. Retry.')
  })
  it('puts messages in conversation order while keeping commands in Activity', () => {
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
    expect(sessionTranscript(value).map(message => `${message.role}: ${message.text}`)).toEqual(['You: Inspect routes', 'Agent: Routes pass.', 'You: Continue'])
    expect(sessionActivity(value)).toEqual([{ id: 1, label: 'pnpm test', detail: 'Passed' }])
  })

  it('shows file changes and failure reasons without turning them into Agent messages', () => {
    const value = session({ events: [
      { seq: 1, turnId: 'turn', createdAt: '2026-10-08T01:01:00Z', event: { _tag: 'FileChanged', changes: [{ path: 'src/routes.ts', kind: 'update' }] } },
      { seq: 2, turnId: 'turn', createdAt: '2026-10-08T01:02:00Z', event: { _tag: 'Failed', reason: 'Desktop disconnected.' } },
    ] })
    expect(sessionActivity(value).map(entry => entry.detail)).toEqual(['update: src/routes.ts', 'Desktop disconnected.'])
    expect(sessionTranscript(value)).toEqual([])
  })

  it.each(['queued', 'running', 'stopping'] as const)('keeps %s sessions busy until confirmed terminal', (status) => {
    expect(sessionRunning(session({ status }))).toBe(true)
  })
  it.each(['idle', 'failed', 'stopped', 'interrupted'] as const)('allows another turn after %s', (status) => {
    expect(sessionRunning(session({ status }))).toBe(false)
  })
})
