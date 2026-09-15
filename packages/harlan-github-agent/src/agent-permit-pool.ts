export interface AgentPermit {
  release: () => void
}

export interface AgentPermitPool {
  tryAcquire: () => AgentPermit | null
}

export function createAgentPermitPool(limit: number | (() => number)): AgentPermitPool {
  if (typeof limit === 'number' && (!Number.isSafeInteger(limit) || limit < 1))
    throw new Error('The active agent limit must be a positive integer.')

  let active = 0
  return {
    tryAcquire() {
      const maximum = typeof limit === 'number' ? limit : limit()
      if (!Number.isSafeInteger(maximum) || maximum < 0)
        throw new Error('The active Agent limit must be a nonnegative integer.')
      if (active >= maximum)
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
