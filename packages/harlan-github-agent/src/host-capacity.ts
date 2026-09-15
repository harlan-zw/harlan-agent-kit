import type { AgentProvider, AgentTurnRequest } from './agent-provider.ts'

export interface HostCapacity {
  localActive: number
  localMaximum: number
  desktopActive: number
  desktopMaximum: number
  desktopConnected: boolean
}

/** The desktop helps only after Hogwild fills every local Agent slot. */
export function agentHost(capacity: HostCapacity): 'hogwild' | 'desktop' | null {
  if (capacity.localActive < capacity.localMaximum)
    return 'hogwild'
  if (capacity.desktopConnected && capacity.desktopActive < capacity.desktopMaximum)
    return 'desktop'
  return null
}

export interface HostAgentPool {
  read: () => HostCapacity
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
  const read = (): HostCapacity => ({
    localActive,
    localMaximum: options.localMaximum,
    desktopActive,
    desktopMaximum: options.desktopMaximum,
    desktopConnected: options.desktopConnected(),
  })
  return {
    read,
    provider: (local, desktop) => ({
      name: local.name,
      runTurn: (request: AgentTurnRequest) => (async function* () {
        const pinned = request.sessionId?.startsWith('desktop:') === true
          ? 'desktop'
          : request.sessionId !== null ? 'hogwild' : null
        const select = (): 'hogwild' | 'desktop' | null => {
          const state = read()
          if (pinned === 'desktop')
            return state.desktopConnected && state.desktopActive < state.desktopMaximum ? 'desktop' : null
          if (pinned === 'hogwild')
            return state.localActive < state.localMaximum ? 'hogwild' : null
          return agentHost(state)
        }
        let host = select()
        while (host === null) {
          request.signal.throwIfAborted()
          await options.wait(request.signal)
          host = select()
        }
        request.signal.throwIfAborted()
        if (host === 'hogwild')
          localActive += 1
        else
          desktopActive += 1
        try {
          const target = host === 'hogwild' ? local : desktop
          const sessionId = host === 'desktop' ? request.sessionId?.replace(/^desktop:/, '') ?? null : request.sessionId
          for await (const event of target.runTurn({ ...request, sessionId })) {
            yield host === 'desktop' && event._tag === 'SessionStarted'
              ? { ...event, sessionId: `desktop:${event.sessionId}` }
              : event
          }
        }
        finally {
          if (host === 'hogwild')
            localActive -= 1
          else
            desktopActive -= 1
        }
      })(),
    }),
  }
}
