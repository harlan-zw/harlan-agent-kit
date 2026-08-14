export interface AgentPermit {
  release: () => void
}

export interface AgentPermitPool {
  tryAcquire: () => AgentPermit | null
}

export function createAgentPermitPool(limit: number): AgentPermitPool {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error('The active agent limit must be a positive integer.')

  let active = 0
  return {
    tryAcquire() {
      if (active >= limit)
        return null
      active += 1
      let released = false
      return {
        release() {
          if (released)
            return
          released = true
          active -= 1
        },
      }
    },
  }
}
