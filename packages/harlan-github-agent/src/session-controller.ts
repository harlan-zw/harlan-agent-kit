import type { AgentEvent } from './agent-provider.ts'
import type { DesktopSession, SessionFence, SessionProject, SessionTurn, StartSessionRequest } from './session-protocol.ts'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { SESSION_PROTOCOL } from './session-protocol.ts'

interface ActiveTurn { turnId: string, leaseToken: string, instanceId: string | null, expiresAt: number, batchSeq: number }
interface StoredSession { session: DesktopSession, turn: ActiveTurn | null }
interface State { version: 1, sessions: StoredSession[], requests: Record<string, { sessionId: string, fingerprint: string }> }
export interface SessionSnapshot { desktop: { connected: boolean, current: boolean }, projects: SessionProject[], sessions: DesktopSession[] }
export function createSessionController(options: { path: string, now: () => Date, availableSlots?: () => number }) {
  const state: State = existsSync(options.path) ? JSON.parse(readFileSync(options.path, 'utf8')) : { version: 1, sessions: [], requests: {} }
  if (state.version !== 1 || !Array.isArray(state.sessions) || typeof state.requests !== 'object')
    throw new Error('Stored Agent sessions are invalid.')
  let desktop: { instanceId: string, protocol: number, reportedAt: number, projects: SessionProject[] } | null = null
  const timestamp = () => options.now().toISOString()
  function save(): void {
    mkdirSync(dirname(options.path), { recursive: true })
    const temporary = `${options.path}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 })
    renameSync(temporary, options.path)
  }
  function interrupt(stored: StoredSession): void {
    if (stored.session.status !== 'stopping')
      stored.session.status = 'interrupted'
    stored.session.updatedAt = timestamp()
  }
  // A controller restart cannot prove that an old desktop process stopped.
  for (const stored of state.sessions) {
    if (stored.turn?.instanceId !== null && stored.turn !== null)
      interrupt(stored)
  }
  save()
  const connected = () => desktop !== null && options.now().getTime() - desktop.reportedAt < 30_000
  function recover(): void {
    let changed = false
    for (const stored of state.sessions) {
      if (stored.session.status !== 'interrupted' && stored.session.status !== 'stopping' && stored.turn?.instanceId !== null && stored.turn !== null && stored.turn.expiresAt <= options.now().getTime()) {
        interrupt(stored)
        changed = true
      }
    }
    if (changed)
      save()
  }
  function find(id: string): StoredSession {
    const stored = state.sessions.find(candidate => candidate.session.id === id)
    if (stored === undefined)
      throw new Error('The Agent session was not found.')
    return stored
  }
  function fenced(input: SessionFence): StoredSession | null {
    recover()
    const stored = state.sessions.find(candidate => candidate.session.id === input.sessionId)
    const turn = stored?.turn
    return stored !== undefined && stored.session.status !== 'interrupted' && (turn?.expiresAt ?? 0) > options.now().getTime() && turn !== null && turn !== undefined && turn.turnId === input.turnId && turn.leaseToken === input.leaseToken && turn.instanceId === input.instanceId ? stored : null
  }
  function duplicate(requestId: string, fingerprint: string): DesktopSession | null {
    const previous = Object.hasOwn(state.requests, requestId) ? state.requests[requestId] : undefined
    if (previous === undefined)
      return null
    if (previous.fingerprint !== fingerprint)
      throw new Error('The request ID was used for another message.')
    return structuredClone(find(previous.sessionId).session)
  }
  function enqueue(stored: StoredSession, prompt: string, requestId: string, fingerprint: string): DesktopSession {
    if (stored.turn !== null || stored.session.status === 'interrupted')
      throw new Error('Confirm the desktop Agent stopped before starting another turn.')
    if (!connected() || desktop?.protocol !== SESSION_PROTOCOL)
      throw new Error('Connect the current desktop Agent before sending a message.')
    const at = timestamp()
    stored.session.messages.push({ id: requestId, role: 'user', text: prompt, createdAt: at })
    stored.session.status = 'queued'
    stored.session.updatedAt = at
    stored.turn = { turnId: randomUUID(), leaseToken: randomUUID(), instanceId: null, expiresAt: 0, batchSeq: 0 }
    state.requests = { ...state.requests, [requestId]: { sessionId: stored.session.id, fingerprint } }
    save()
    return structuredClone(stored.session)
  }
  return {
    snapshot(): SessionSnapshot {
      recover()
      return structuredClone({ desktop: { connected: connected(), current: desktop?.protocol === SESSION_PROTOCOL }, projects: desktop?.projects ?? [], sessions: state.sessions.map(stored => stored.session) })
    },
    get(id: string): DesktopSession {
      recover()
      return structuredClone(find(id).session)
    },
    report(input: { instanceId: string, protocol: number, projects: SessionProject[] }): { accepted: boolean, stops: SessionFence[] } {
      if (desktop !== null && desktop.instanceId !== input.instanceId) {
        for (const stored of state.sessions) {
          if (stored.turn?.instanceId !== null && stored.turn !== null)
            interrupt(stored)
        }
        save()
      }
      desktop = { ...input, reportedAt: options.now().getTime() }
      return { accepted: input.protocol === SESSION_PROTOCOL, stops: state.sessions.filter(stored => stored.session.status === 'stopping' && stored.turn?.instanceId != null).map(stored => ({ sessionId: stored.session.id, turnId: stored.turn!.turnId, leaseToken: stored.turn!.leaseToken, instanceId: stored.turn!.instanceId! })) }
    },
    start(input: StartSessionRequest): DesktopSession {
      const fingerprint = JSON.stringify(input)
      const previous = duplicate(input.requestId, fingerprint)
      if (previous !== null)
        return previous
      const project = desktop?.projects.find(project => project.id === input.projectId)
      if (project === undefined)
        throw new Error('Select a project reported by the desktop Agent.')
      const at = timestamp()
      const stored: StoredSession = { turn: null, session: { id: randomUUID(), project, provider: input.provider, model: input.model, reasoningEffort: input.reasoningEffort, title: input.prompt.slice(0, 80), createdAt: at, updatedAt: at, status: 'idle', workspacePath: null, providerSessionId: null, messages: [], events: [] } }
      // Validate availability before adding the session to persistent state.
      if (!connected() || desktop?.protocol !== SESSION_PROTOCOL)
        throw new Error('Connect the current desktop Agent before starting an Agent session.')
      state.sessions.push(stored)
      return enqueue(stored, input.prompt, input.requestId, fingerprint)
    },
    message(id: string, input: { prompt: string, requestId: string }): DesktopSession {
      recover()
      const fingerprint = JSON.stringify({ id, ...input })
      return duplicate(input.requestId, fingerprint) ?? enqueue(find(id), input.prompt, input.requestId, fingerprint)
    },
    stop(id: string): DesktopSession {
      recover()
      const stored = find(id)
      if (stored.turn?.instanceId === null) {
        stored.turn = null
        stored.session.status = 'stopped'
      }
      else if (stored.turn !== null) {
        stored.session.status = 'stopping'
      }
      else if (stored.session.status !== 'interrupted') {
        stored.session.status = 'stopped'
      }
      stored.session.updatedAt = timestamp()
      save()
      return structuredClone(stored.session)
    },
    claim(input: { instanceId: string, freeSlots: number }): SessionTurn | null {
      recover()
      const active = state.sessions.filter(stored => stored.turn?.instanceId !== null && stored.turn !== null).length
      if (!connected() || desktop?.protocol !== SESSION_PROTOCOL || desktop.instanceId !== input.instanceId || input.freeSlots < 1 || active >= (options.availableSlots?.() ?? 1))
        return null
      const stored = state.sessions.find(stored => stored.session.status === 'queued' && stored.turn?.instanceId === null)
      if (stored === undefined || stored.turn === null)
        return null
      stored.turn.instanceId = input.instanceId
      stored.turn.expiresAt = options.now().getTime() + 30_000
      stored.session.status = 'running'
      stored.session.updatedAt = timestamp()
      save()
      return structuredClone({ sessionId: stored.session.id, turnId: stored.turn.turnId, leaseToken: stored.turn.leaseToken, project: stored.session.project, provider: stored.session.provider, model: stored.session.model, reasoningEffort: stored.session.reasoningEffort, prompt: stored.session.messages.at(-1)!.text, workspacePath: stored.session.workspacePath, providerSessionId: stored.session.providerSessionId })
    },
    heartbeat(input: SessionFence): { active: boolean, cancelled: boolean } {
      const stored = fenced(input)
      if (stored === null || stored.turn === null)
        return { active: false, cancelled: true }
      stored.turn.expiresAt = options.now().getTime() + 30_000
      save()
      return { active: true, cancelled: stored.session.status === 'stopping' }
    },
    events(input: SessionFence & { seq: number, events: AgentEvent[] }): { accepted: boolean } {
      const stored = fenced(input)
      if (stored === null || stored.turn === null)
        return { accepted: false }
      if (input.seq <= stored.turn.batchSeq)
        return { accepted: true }
      if (input.seq !== stored.turn.batchSeq + 1)
        throw new Error('Send Agent event batches in order.')
      for (const event of input.events) {
        stored.session.events.push({ seq: stored.session.events.length + 1, turnId: input.turnId, event, createdAt: timestamp() })
        if (event._tag === 'SessionStarted')
          stored.session.providerSessionId = event.sessionId
      }
      stored.turn.batchSeq = input.seq
      stored.session.updatedAt = timestamp()
      save()
      return { accepted: true }
    },
    defer(input: SessionFence): { accepted: boolean } {
      const stored = fenced(input)
      if (stored === null || stored.turn === null)
        return { accepted: false }
      if (stored.session.status === 'stopping') {
        stored.turn = null
        stored.session.status = 'stopped'
      }
      else {
        stored.turn = { ...stored.turn, leaseToken: randomUUID(), instanceId: null, expiresAt: 0 }
        stored.session.status = 'queued'
      }
      save()
      return { accepted: true }
    },
    complete(input: SessionFence & { outcome: 'completed' | 'stopped' | 'failed', reason?: string, workspacePath?: string, providerSessionId?: string }): { accepted: boolean } {
      const held = state.sessions.find(candidate => candidate.session.id === input.sessionId)
      const retired = held?.turn
      const stopped = input.outcome === 'stopped' && retired?.turnId === input.turnId && retired?.leaseToken === input.leaseToken && retired?.instanceId === input.instanceId
      const stored = stopped ? held! : fenced(input)
      if (stored === null)
        return { accepted: false }
      stored.session.status = stored.session.status === 'stopping' ? 'stopped' : input.outcome === 'completed' ? 'idle' : input.outcome === 'stopped' ? 'stopped' : 'failed'
      if (input.workspacePath !== undefined)
        stored.session.workspacePath = input.workspacePath
      if (input.providerSessionId !== undefined)
        stored.session.providerSessionId = input.providerSessionId
      if (input.reason !== undefined)
        stored.session.events.push({ seq: stored.session.events.length + 1, turnId: input.turnId, event: { _tag: 'Failed', reason: input.reason }, createdAt: timestamp() })
      stored.session.updatedAt = timestamp()
      stored.turn = null
      save()
      return { accepted: true }
    },
  }
}
export type SessionController = ReturnType<typeof createSessionController>
