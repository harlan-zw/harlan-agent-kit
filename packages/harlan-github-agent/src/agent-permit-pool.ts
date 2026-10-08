export interface AgentPermit {
  release: () => void
}

export interface AgentPermitPool {
  tryAcquire: () => AgentPermit | null
}

/** Give one waiting Routine the next free permit while other Agents keep running. */
export function createRoutinePermitPools(pool: AgentPermitPool, prioritizeRoutine: () => boolean): { items: AgentPermitPool, routines: AgentPermitPool } {
  let routineActive = false
  return {
    items: {
      tryAcquire: () => !routineActive && prioritizeRoutine() ? null : pool.tryAcquire(),
    },
    routines: {
      tryAcquire() {
        if (routineActive)
          return null
        const permit = pool.tryAcquire()
        if (permit === null)
          return null
        routineActive = true
        let released = false
        return {
          release() {
            if (released)
              return
            released = true
            routineActive = false
            permit.release()
          },
        }
      },
    },
  }
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
