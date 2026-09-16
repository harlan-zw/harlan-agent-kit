import type { AgentProvider, AgentTurnRequest } from './agent-provider.ts'

export interface HostCapacity {
  localActive: number
  localMaximum: number
  desktopActive: number
  desktopMaximum: number
  desktopConnected: boolean
}

export type AgentHost = 'hogwild' | 'desktop'

/** The bounds of the Agent slot control, so the dashboard and the tray agree. */
export interface AgentSlotLimits {
  /** The most Agent slots Hogwild may be set to. */
  hogwildCeiling: number
  /** The Hogwild slot count host memory suggests. */
  hogwildMemoryMaximum: number
  /** The most Agent slots the desktop may be set to. */
  desktopCeiling: number
  /** Memory one Agent is assumed to need. */
  memoryPerAgentGiB: number
}

/** The stored Agent slot count for each host. NULL means the host default. */
export interface AgentSlotSetting {
  hogwild: number | null
  desktop: number | null
}

/**
 * Reads one Agent slot request from the Control API.
 *
 * The ceiling is a configuration decision, so a request above it is refused
 * here. Host memory is advice, and a count above it is allowed on purpose.
 */
export function parseAgentSlots(value: unknown, limits: AgentSlotLimits): { host: AgentHost, slots: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('An Agent slot request must be a JSON object.')
  const input = value as { host?: unknown, slots?: unknown }
  if (input.host !== 'hogwild' && input.host !== 'desktop')
    throw new Error('Agent slots must name the host hogwild or desktop.')
  const ceiling = input.host === 'hogwild' ? limits.hogwildCeiling : limits.desktopCeiling
  if (!Number.isSafeInteger(input.slots) || Number(input.slots) < 0 || Number(input.slots) > ceiling)
    throw new Error(`Agent slots must be a whole number from 0 to ${ceiling}.`)
  return { host: input.host, slots: Number(input.slots) }
}

/** The desktop helps only after Hogwild fills every local Agent slot. */
export function agentHost(capacity: HostCapacity, refused: ReadonlySet<AgentHost> = new Set()): AgentHost | null {
  if (!refused.has('hogwild') && capacity.localActive < capacity.localMaximum)
    return 'hogwild'
  if (!refused.has('desktop') && capacity.desktopConnected && capacity.desktopActive < capacity.desktopMaximum)
    return 'desktop'
  return null
}

export interface HostAgentPool {
  read: () => HostCapacity
  tasks: () => Array<{ taskId: string | null, host: AgentHost }>
  provider: (local: AgentProvider, desktop: AgentProvider) => AgentProvider
}

/** A limit Harlan can change while the service runs, or a fixed one. */
export type HostAgentLimit = number | (() => number)

function hostLimit(limit: HostAgentLimit): number {
  const value = typeof limit === 'number' ? limit : limit()
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Host Agent limits must be nonnegative integers.')
  return value
}

/** One pool spans both providers. Switching providers cannot double host capacity. */
export function createHostAgentPool(options: {
  localMaximum: HostAgentLimit
  desktopMaximum: HostAgentLimit
  desktopConnected: () => boolean
  wait: (signal: AbortSignal) => Promise<void>
}): HostAgentPool {
  // A function limit is read at every admission, so Agent slots set from the
  // dashboard or the tray apply to the next turn without a restart.
  for (const limit of [options.localMaximum, options.desktopMaximum])
    hostLimit(limit)
  let localActive = 0
  let desktopActive = 0
  const tasks = new Map<symbol, { taskId: string | null, host: AgentHost }>()
  const read = (): HostCapacity => ({
    localActive,
    localMaximum: hostLimit(options.localMaximum),
    desktopActive,
    desktopMaximum: hostLimit(options.desktopMaximum),
    desktopConnected: options.desktopConnected(),
  })
  return {
    read,
    tasks: () => [...tasks.values()],
    provider: (local, desktop) => ({
      name: local.name,
      runTurn: (request: AgentTurnRequest) => (async function* () {
        const pinned: AgentHost | null = request.sessionId?.startsWith('desktop:') === true
          ? 'desktop'
          : request.sessionId !== null ? 'hogwild' : null
        // A host that cannot carry this Worktree at all, such as a desktop
        // asked for a repository whose history exceeds the turn payload.
        const refused = new Set<AgentHost>()
        let refusal: Error | null = null
        const select = (): AgentHost | null => {
          const state = read()
          if (pinned !== null && refused.has(pinned))
            return null
          if (pinned === 'desktop')
            return state.desktopConnected && state.desktopActive < state.desktopMaximum ? 'desktop' : null
          if (pinned === 'hogwild')
            return state.localActive < state.localMaximum ? 'hogwild' : null
          return agentHost(state, refused)
        }
        while (true) {
          let host = select()
          while (host === null) {
            request.signal.throwIfAborted()
            // A pinned session belongs to one host, and a refusal there has no
            // second place to go. Waiting would hold the Task open forever.
            if (refusal !== null && (pinned !== null || refused.has('hogwild')))
              throw refusal
            await options.wait(request.signal)
            host = select()
          }
          request.signal.throwIfAborted()
          if (host === 'hogwild')
            localActive += 1
          else
            desktopActive += 1
          const turn = Symbol('turn')
          tasks.set(turn, { taskId: request.taskId ?? null, host })
          let started = false
          try {
            const target = host === 'hogwild' ? local : desktop
            const sessionId = host === 'desktop' ? request.sessionId?.replace(/^desktop:/, '') ?? null : request.sessionId
            for await (const event of target.runTurn({ ...request, sessionId })) {
              started = true
              yield host === 'desktop' && event._tag === 'SessionStarted'
                ? { ...event, sessionId: `desktop:${event.sessionId}` }
                : event
            }
            return
          }
          catch (error) {
            // Nothing reached the caller yet, so the other host may still run
            // this turn from the start.
            if (!started && error instanceof Error && error.cause === 'desktop-unsupported') {
              refused.add(host)
              refusal = error
              continue
            }
            throw error
          }
          finally {
            tasks.delete(turn)
            if (host === 'hogwild')
              localActive -= 1
            else
              desktopActive -= 1
          }
        }
      })(),
    }),
  }
}
