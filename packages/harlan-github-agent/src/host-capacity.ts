import type { AgentProvider, AgentTurnRequest } from './agent-provider.ts'

export interface HostCapacity {
  localActive: number
  localMaximum: number
  desktopActive: number
  desktopMaximum: number
  desktopConnected: boolean
}

export type AgentHost = 'hogwild' | 'desktop'

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

/** One pool spans both providers. Switching providers cannot double host capacity. */
export function createHostAgentPool(options: {
  localMaximum: number
  desktopMaximum: number
  desktopConnected: () => boolean
  wait: (signal: AbortSignal) => Promise<void>
}): HostAgentPool {
  for (const limit of [options.localMaximum, options.desktopMaximum]) {
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new Error('Host Agent limits must be nonnegative integers.')
  }
  let localActive = 0
  let desktopActive = 0
  const tasks = new Map<symbol, { taskId: string | null, host: AgentHost }>()
  const read = (): HostCapacity => ({
    localActive,
    localMaximum: options.localMaximum,
    desktopActive,
    desktopMaximum: options.desktopMaximum,
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
