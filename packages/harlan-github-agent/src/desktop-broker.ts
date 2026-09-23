import type { AgentEvent, AgentProvider, AgentTurnRequest } from './agent-provider.ts'
import type { DesktopErrorCause, DesktopFailure } from './desktop-protocol.ts'
import type { DesktopWorktree } from './desktop-worktree.ts'
import type { RunnerJobs } from './runner-jobs.ts'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DESKTOP_MEMORY_PER_AGENT_GIB, DESKTOP_PROTOCOL, desktopErrorCause } from './desktop-protocol.ts'
import { exportDesktopWorktree, importDesktopWorktree } from './desktop-worktree.ts'

export interface DesktopTurn {
  id: string
  provider: AgentProvider['name']
  request: Omit<AgentTurnRequest, 'signal'>
  worktree: DesktopWorktree
}

interface PendingTurn {
  turn: DesktopTurn
  events: AgentEvent[]
  state: 'queued' | 'running' | 'completed' | 'cancelled'
  result: DesktopWorktree | null
  failure: DesktopFailure | null
}

export interface DesktopReport {
  /** The turn shape this desktop speaks. See `DESKTOP_PROTOCOL`. */
  protocol: number
  memoryGiB: number
  reservedGiB: number
  agents: number
  actions: number
  jobs?: RunnerJobs
}

export function createDesktopBroker(options: { now: () => number, settingsPath?: string }) {
  const pending = new Map<string, PendingTurn>()
  let report: DesktopReport | null = null
  let seenAt = 0
  let requestedMemoryGiB: number | null = options.settingsPath !== undefined && existsSync(options.settingsPath)
    ? JSON.parse(readFileSync(options.settingsPath, 'utf8')).requestedMemoryGiB
    : null
  const persistMemory = (value: number | null): void => {
    if (options.settingsPath !== undefined) {
      mkdirSync(dirname(options.settingsPath), { recursive: true })
      writeFileSync(`${options.settingsPath}.next`, JSON.stringify({ requestedMemoryGiB: value }), { mode: 0o600 })
      renameSync(`${options.settingsPath}.next`, options.settingsPath)
    }
    requestedMemoryGiB = value
  }
  const connected = () => report !== null && options.now() - seenAt < 15_000
  // A desktop on another revision reads a turn it was never taught. Standing it
  // down keeps the work on Hogwild, where the old design instead sent the turn
  // and failed the Task on the far side.
  const current = () => report !== null && report.protocol === DESKTOP_PROTOCOL
  return {
    available: () => connected() && current() && report !== null && report.memoryGiB - report.reservedGiB >= DESKTOP_MEMORY_PER_AGENT_GIB,
    read: () => ({ connected: connected(), current: current(), protocol: DESKTOP_PROTOCOL, report, requestedMemoryGiB }),
    setMemory: persistMemory,
    report: (value: DesktopReport) => {
      report = value
      seenAt = options.now()
      if (requestedMemoryGiB === value.memoryGiB)
        persistMemory(null)
      return { memoryGiB: requestedMemoryGiB }
    },
    claim: (): DesktopTurn | null => {
      if (!connected() || !current())
        return null
      const entry = [...pending.values()].find(entry => entry.state === 'queued')
      if (entry === undefined)
        return null
      entry.state = 'running'
      return entry.turn
    },
    defer: (id: string) => {
      const entry = pending.get(id)
      if (entry?.state !== 'running')
        return false
      entry.state = 'queued'
      return true
    },
    active: (id: string) => pending.get(id)?.state === 'running',
    events: (id: string, events: AgentEvent[]) => {
      const entry = pending.get(id)
      if (entry?.state !== 'running')
        return false
      entry.events.push(...events)
      return true
    },
    complete: (id: string, result: DesktopWorktree | null, failure: DesktopFailure | null) => {
      const entry = pending.get(id)
      if (entry?.state !== 'running')
        return false
      entry.result = result
      entry.failure = failure
      entry.state = 'completed'
      return true
    },
    provider: (name: AgentProvider['name']): AgentProvider => ({
      name,
      runTurn: (request: AgentTurnRequest) => (async function* () {
        const temporary = await mkdtemp(join(tmpdir(), 'desktop-turn-'))
        const id = randomUUID()
        let entry: PendingTurn | undefined
        try {
          const worktree = await exportDesktopWorktree(request.workspace, temporary, { signal: request.signal })
          const { signal, ...input } = request
          entry = { turn: { id, provider: name, request: input, worktree }, events: [], state: 'queued', result: null, failure: null }
          pending.set(id, entry)
          while (entry.state !== 'completed') {
            signal.throwIfAborted()
            if (!connected())
              throw new Error('Desktop disconnected during the Agent turn.')
            for (const event of entry.events.splice(0))
              yield event
            await delay(100, undefined, { signal })
          }
          for (const event of entry.events.splice(0))
            yield event
          if (entry.result !== null)
            await importDesktopWorktree(request.workspace, worktree, entry.result, temporary, signal)
          if (entry.failure !== null)
            throw new Error(entry.failure.reason, { cause: entry.failure._tag === 'SetupFailed' ? 'desktop-setup' : 'desktop-execution' })
          if (entry.result === null)
            throw new Error('Desktop returned no Worktree.')
        }
        catch (error) {
          // A Worktree the desktop cannot carry, or one it could not set up,
          // keeps its own cause, so the host pool runs the turn on Hogwild
          // instead of failing the Task.
          const cause: DesktopErrorCause = desktopErrorCause(error) ?? 'desktop-execution'
          throw new Error(error instanceof Error ? error.message : 'Desktop execution failed.', { cause })
        }
        finally {
          if (entry !== undefined)
            entry.state = 'cancelled'
          pending.delete(id)
          await rm(temporary, { recursive: true, force: true })
        }
      })(),
    }),
  }
}

export type DesktopBroker = ReturnType<typeof createDesktopBroker>
