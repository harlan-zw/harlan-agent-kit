import type { AgentEvent } from './agent-provider.ts'
import type { DesktopSession, SessionFence, SessionHost, SessionProject, SessionTurn, StartSessionRequest } from './session-protocol.ts'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { SESSION_PROTOCOL } from './session-protocol.ts'

interface ActiveTurn { turnId: string, leaseToken: string, instanceId: string | null, expiresAt: number, batchSeq: number }
interface StoredSession { session: DesktopSession, turn: ActiveTurn | null }
interface State { version: 2, sessions: StoredSession[], requests: Record<string, { sessionId: string, fingerprint: string }> }
interface HostReport { instanceId: string, protocol: number, reportedAt: number, projects: SessionProject[] }
export interface SessionSnapshot { hosts: Record<SessionHost, { connected: boolean, current: boolean }>, projects: Record<SessionHost, SessionProject[]>, sessions: DesktopSession[] }
function startFingerprint(input: StartSessionRequest): string {
  return JSON.stringify({ host: input.host, projectId: input.projectId, provider: input.provider, model: input.model, reasoningEffort: input.reasoningEffort, prompt: input.prompt, requestId: input.requestId })
}
export function createSessionController(options: { path: string, now: () => Date, availableSlots?: (host: SessionHost) => number }) {
  const loaded = existsSync(options.path) ? JSON.parse(readFileSync(options.path, 'utf8')) : { version: 2, sessions: [], requests: {} }
  if ((loaded.version !== 1 && loaded.version !== 2) || !Array.isArray(loaded.sessions) || typeof loaded.requests !== 'object' || loaded.requests === null)
    throw new Error('Stored Agent sessions are invalid.')
  if (loaded.version === 1) {
    for (const stored of loaded.sessions)
      stored.session.host = 'desktop'
    for (const request of Object.values(loaded.requests) as Array<{ fingerprint: string }>) {
      const original = JSON.parse(request.fingerprint)
      if (typeof original.projectId === 'string')
        request.fingerprint = startFingerprint({ ...original, host: 'desktop' })
    }
    loaded.version = 2
  }
  let state: State = loaded
  if (state.sessions.some(stored => stored.session.host !== 'desktop' && stored.session.host !== 'hogwild'))
    throw new Error('A stored Agent session has an invalid host.')
  const hosts: Record<SessionHost, HostReport | null> = { desktop: null, hogwild: null }
  const timestamp = () => options.now().toISOString()
  let committed = structuredClone(state)
  function save(): void {
    const temporary = `${options.path}.${randomUUID()}.tmp`
    let file: number | undefined
    let temporaryHeld = false
    try {
      mkdirSync(dirname(options.path), { recursive: true })
      file = openSync(temporary, 'wx', 0o600)
      temporaryHeld = true
      writeFileSync(file, JSON.stringify(state))
      fsyncSync(file)
      closeSync(file)
      file = undefined
      renameSync(temporary, options.path)
      temporaryHeld = false
      // Rename commits the new state. A later directory sync failure cannot undo it.
      committed = structuredClone(state)
      file = openSync(dirname(options.path), 'r')
      fsyncSync(file)
    }
    catch (error) {
      state = structuredClone(committed)
      throw error
    }
    finally {
      if (file !== undefined)
        closeSync(file)
      if (temporaryHeld)
        rmSync(temporary, { force: true })
    }
  }
  function interrupt(stored: StoredSession): void {
    if (stored.session.status !== 'stopping')
      stored.session.status = 'interrupted'
    stored.session.updatedAt = timestamp()
  }
  // A controller restart cannot prove that an old host process stopped.
  for (const stored of state.sessions) {
    if (stored.turn?.instanceId !== null && stored.turn !== null)
      interrupt(stored)
  }
  save()
  const connected = (host: SessionHost) => hosts[host] !== null && options.now().getTime() - hosts[host]!.reportedAt < 30_000
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
    const stored = state.sessions.find(candidate => candidate.session.id === input.sessionId)
    if (stored === undefined || stored.session.host !== input.host)
      return null
    recover()
    const turn = stored?.turn
    return stored !== undefined && stored.session.host === input.host && stored.session.status !== 'interrupted' && (turn?.expiresAt ?? 0) > options.now().getTime() && turn !== null && turn !== undefined && turn.turnId === input.turnId && turn.leaseToken === input.leaseToken && turn.instanceId === input.instanceId ? stored : null
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
      throw new Error('Confirm the Agent stopped before starting another turn.')
    if (!connected(stored.session.host) || hosts[stored.session.host]?.protocol !== SESSION_PROTOCOL)
      throw new Error('Connect the selected Agent host before sending a message.')
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
      return structuredClone({ hosts: { desktop: { connected: connected('desktop'), current: hosts.desktop?.protocol === SESSION_PROTOCOL }, hogwild: { connected: connected('hogwild'), current: hosts.hogwild?.protocol === SESSION_PROTOCOL } }, projects: { desktop: hosts.desktop?.projects ?? [], hogwild: hosts.hogwild?.projects ?? [] }, sessions: state.sessions.map(stored => stored.session) })
    },
    get(id: string): DesktopSession {
      recover()
      return structuredClone(find(id).session)
    },
    report(input: { host: SessionHost, instanceId: string, protocol: number, projects: SessionProject[] }): { accepted: boolean, stops: SessionFence[] } {
      const previous = hosts[input.host]
      if (previous !== null && previous.instanceId !== input.instanceId) {
        for (const stored of state.sessions) {
          if (stored.session.host === input.host && stored.turn?.instanceId !== null && stored.turn !== null)
            interrupt(stored)
        }
        save()
      }
      hosts[input.host] = { ...input, reportedAt: options.now().getTime() }
      return { accepted: input.protocol === SESSION_PROTOCOL, stops: state.sessions.filter(stored => stored.session.host === input.host && stored.session.status === 'stopping' && stored.turn?.instanceId != null).map(stored => ({ host: input.host, sessionId: stored.session.id, turnId: stored.turn!.turnId, leaseToken: stored.turn!.leaseToken, instanceId: stored.turn!.instanceId! })) }
    },
    start(input: StartSessionRequest): DesktopSession {
      const fingerprint = startFingerprint(input)
      const previous = duplicate(input.requestId, fingerprint)
      if (previous !== null)
        return previous
      const project = hosts[input.host]?.projects.find(project => project.id === input.projectId)
      if (project === undefined)
        throw new Error('Select a project reported by the selected Agent host.')
      const at = timestamp()
      const stored: StoredSession = { turn: null, session: { id: randomUUID(), host: input.host, project, provider: input.provider, model: input.model, reasoningEffort: input.reasoningEffort, title: input.prompt.slice(0, 80), createdAt: at, updatedAt: at, status: 'idle', workspacePath: null, providerSessionId: null, messages: [], events: [] } }
      // Validate availability before adding the session to persistent state.
      if (!connected(input.host) || hosts[input.host]?.protocol !== SESSION_PROTOCOL)
        throw new Error('Connect the selected Agent host before starting an Agent session.')
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
    claim(input: { host: SessionHost, instanceId: string, freeSlots: number }): SessionTurn | null {
      recover()
      const active = state.sessions.filter(stored => stored.session.host === input.host && stored.turn?.instanceId !== null && stored.turn !== null).length
      const host = hosts[input.host]
      if (!connected(input.host) || host?.protocol !== SESSION_PROTOCOL || host.instanceId !== input.instanceId || input.freeSlots < 1 || active >= (options.availableSlots?.(input.host) ?? 1))
        return null
      const stored = state.sessions.find(stored => stored.session.host === input.host && stored.session.status === 'queued' && stored.turn?.instanceId === null)
      if (stored === undefined || stored.turn === null)
        return null
      stored.turn.instanceId = input.instanceId
      stored.turn.expiresAt = options.now().getTime() + 30_000
      stored.session.status = 'running'
      stored.session.updatedAt = timestamp()
      save()
      return structuredClone({ host: stored.session.host, sessionId: stored.session.id, turnId: stored.turn.turnId, leaseToken: stored.turn.leaseToken, project: stored.session.project, provider: stored.session.provider, model: stored.session.model, reasoningEffort: stored.session.reasoningEffort, prompt: stored.session.messages.at(-1)!.text, workspacePath: stored.session.workspacePath, providerSessionId: stored.session.providerSessionId })
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
      const stopped = input.outcome === 'stopped' && held?.session.host === input.host && retired?.turnId === input.turnId && retired?.leaseToken === input.leaseToken && retired?.instanceId === input.instanceId
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
