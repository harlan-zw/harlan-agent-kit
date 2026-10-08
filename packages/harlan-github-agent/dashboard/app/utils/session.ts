import type { DesktopSession } from '../../../src/session-protocol.ts'

export function sessionRunning(session: DesktopSession | undefined): boolean {
  return session !== undefined && ['queued', 'running', 'stopping'].includes(session.status)
}

export function sessionTranscript(session: DesktopSession | undefined) {
  if (session === undefined)
    return []
  return [
    ...session.messages.map(message => ({ id: message.id, at: message.createdAt, role: 'You', text: message.text })),
    ...session.events.flatMap(entry => entry.event._tag === 'Message' || entry.event._tag === 'Progress'
      ? [{ id: `event-${entry.seq}`, at: entry.createdAt, role: 'Agent', text: entry.event.text }]
      : []),
  ].sort((left, right) => left.at.localeCompare(right.at))
}

export function sessionActivity(session: DesktopSession | undefined) {
  return session?.events.flatMap(({ event, seq }) => {
    switch (event._tag) {
      case 'CommandStarted': return [{ id: seq, label: event.command, detail: 'Running command' }]
      case 'CommandCompleted': return [{ id: seq, label: event.command, detail: event.output || `Exit ${event.exitCode ?? 'unavailable'}` }]
      case 'FileChanged': return [{ id: seq, label: 'Files changed', detail: event.changes.map(change => `${change.kind}: ${change.path}`).join('\n') }]
      case 'Reasoning': return [{ id: seq, label: 'Reasoning', detail: event.text }]
      case 'Failed': return [{ id: seq, label: 'Agent stopped', detail: event.reason }]
      default: return []
    }
  }) ?? []
}
