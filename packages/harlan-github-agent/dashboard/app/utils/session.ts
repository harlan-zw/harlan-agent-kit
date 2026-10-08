import type { DesktopSession, SessionHost, SessionProject } from '../../../src/session-protocol.ts'

export interface SessionViewSnapshot {
  hosts: Record<SessionHost, { connected: boolean, current: boolean }>
  projects: Record<SessionHost, SessionProject[]>
  sessions: DesktopSession[]
}

export const sessionHostLabels: Record<SessionHost, string> = { desktop: 'Desktop', hogwild: 'Hogwild' }

export interface SessionComposerSelection { host: SessionHost, projectId: string }

export function parseSessionComposerStorage(stored: string): SessionComposerSelection {
  const fallback: SessionComposerSelection = { host: 'desktop', projectId: '' }
  let value: unknown
  try {
    value = JSON.parse(stored)
  }
  catch {
    // An invalid browser storage entry has no recoverable selection.
    return fallback
  }
  if (typeof value !== 'object' || value === null || !('host' in value) || !('projectId' in value))
    return fallback
  if ((value.host !== 'desktop' && value.host !== 'hogwild') || typeof value.projectId !== 'string')
    return fallback
  return { host: value.host, projectId: value.projectId }
}

export function sessionProjectAvailable(snapshot: SessionViewSnapshot | undefined, host: SessionHost, projectId: string): boolean {
  return snapshot?.projects[host].some(project => project.id === projectId) === true
}

export function sessionHostProjects(snapshot: SessionViewSnapshot | undefined, host: SessionHost): SessionProject[] {
  if (!snapshot)
    return []
  const projects = new Map(snapshot.projects[host].map(project => [project.id, project]))
  for (const session of snapshot.sessions) {
    if (session.host === host && !projects.has(session.project.id))
      projects.set(session.project.id, session.project)
  }
  return [...projects.values()]
}

export function sessionHostStatus(snapshot: SessionViewSnapshot | undefined, host: SessionHost): string {
  const state = snapshot?.hosts[host]
  return !state ? 'Checking' : !state.connected ? 'Offline' : !state.current ? 'Update required' : 'Connected'
}

export interface SessionTool {
  id: string
  kind: 'command' | 'files' | 'reasoning' | 'search' | 'failure'
  label: string
  detail: string
  status: 'running' | 'passed' | 'failed' | 'finished' | 'stopped' | 'interrupted'
}

export type SessionTimelineEntry
  = | { kind: 'message', id: string, role: 'You' | 'Agent', text: string, at: string }
    | { kind: 'activity', id: string, tools: SessionTool[] }

/** Preserve provider order. Pair command starts and completions inside the same turn. */
export function sessionTimeline(session: DesktopSession | undefined): SessionTimelineEntry[] {
  if (!session)
    return []
  const entries: SessionTimelineEntry[] = []
  const pending = new Map<string, SessionTool[]>()
  const input = [
    ...session.messages.map(message => ({ kind: 'user' as const, at: message.createdAt, message })),
    ...session.events.map(event => ({ kind: 'event' as const, at: event.createdAt, record: event })),
  ].sort((left, right) => left.at.localeCompare(right.at))
  const appendTool = (tool: SessionTool) => {
    const previous = entries.at(-1)
    if (previous?.kind === 'activity')
      previous.tools.push(tool)
    else entries.push({ kind: 'activity', id: tool.id, tools: [tool] })
  }
  for (const entry of input) {
    if (entry.kind === 'user') {
      entries.push({ kind: 'message', id: entry.message.id, role: 'You', text: entry.message.text, at: entry.at })
      continue
    }
    const { event, seq, turnId } = entry.record
    const id = `${turnId}:${seq}`
    if (event._tag === 'Message' || event._tag === 'Progress') {
      entries.push({ kind: 'message', id, role: 'Agent', text: event.text, at: entry.at })
      continue
    }
    if (event._tag === 'CommandStarted' || event._tag === 'CommandCompleted') {
      const key = `${turnId}:${event.command}`
      const queue = pending.get(key) ?? []
      if (event._tag === 'CommandStarted') {
        const tool: SessionTool = { id, kind: 'command', label: event.command, detail: '', status: 'running' }
        queue.push(tool)
        pending.set(key, queue)
        appendTool(tool)
      }
      else {
        const tool = queue.shift()
        const result = { status: event.exitCode === 0 ? 'passed' as const : event.exitCode === null ? 'finished' as const : 'failed' as const, detail: event.output || `Exit ${event.exitCode ?? 'unavailable'}` }
        if (tool)
          Object.assign(tool, result)
        else appendTool({ id, kind: 'command', label: event.command, ...result })
      }
      continue
    }
    if (event._tag === 'FileChanged')
      appendTool({ id, kind: 'files', label: `${event.changes.length} ${event.changes.length === 1 ? 'file changed' : 'files changed'}`, detail: event.changes.map(change => `${change.kind}: ${change.path}`).join('\n'), status: 'finished' })
    if (event._tag === 'Reasoning')
      appendTool({ id, kind: 'reasoning', label: 'Reasoning', detail: event.text, status: 'finished' })
    if (event._tag === 'WebSearch')
      appendTool({ id, kind: 'search', label: 'Web search', detail: '', status: 'finished' })
    if (event._tag === 'Failed')
      appendTool({ id, kind: 'failure', label: 'Agent stopped', detail: event.reason, status: 'failed' })
  }
  if (!sessionRunning(session)) {
    for (const queue of pending.values()) {
      for (const tool of queue) {
        tool.status = session.status === 'stopped' ? 'stopped' : session.status === 'idle' ? 'finished' : 'interrupted'
        tool.detail = 'Command output unavailable.'
      }
    }
  }
  return entries
}

export function sessionFailureMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'data' in error) {
    const data = error.data
    if (typeof data === 'object' && data !== null) {
      if ('message' in data && typeof data.message === 'string' && data.message.trim().length > 0)
        return data.message
      if ('statusMessage' in data && typeof data.statusMessage === 'string' && data.statusMessage.trim().length > 0)
        return data.statusMessage
    }
  }
  return fallback
}

export function sessionRunning(session: DesktopSession | undefined): boolean {
  return session !== undefined && ['queued', 'running', 'stopping'].includes(session.status)
}

export function sessionAcceptsMessage(session: DesktopSession): boolean {
  return session.status === 'idle' || session.status === 'stopped' || session.status === 'failed'
}
