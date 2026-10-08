import type { HostAgentPool } from './host-capacity.ts'
import type { DesktopSession, SessionTurn } from './session-protocol.ts'
import { createPoller } from './poller.ts'

/** Retired fences still reserve memory until the host proves their processes stopped. */
export function localSessionSlotMaximum(configured: number, sessions: readonly Pick<DesktopSession, 'id' | 'host' | 'status'>[], held: (sessionId: string) => boolean): number {
  const unconfirmed = sessions.filter(session => session.host === 'hogwild'
    && (session.status === 'running' || session.status === 'stopping' || session.status === 'interrupted')
    && !held(session.id)).length
  return Math.max(0, configured - unconfirmed)
}

/** Local sessions and maintenance share the same pool of host permits. */
export function createLocalSessionRunner(options: {
  pool: HostAgentPool
  maximum: () => number
  client: {
    report: () => Promise<void>
    claim: (freeSlots: number) => Promise<SessionTurn | null>
    run: (turn: SessionTurn) => Promise<void>
    defer: (turn: SessionTurn) => Promise<void>
  }
  onError: (error: unknown) => void
  abort?: () => void
  mayClaim?: () => boolean
}) {
  const running = new Set<Promise<void>>()
  const reservations = new Map<string, { sessionId: string, release: () => void }>()
  const pending = new Set<string>()
  const poller = createPoller({
    intervalMilliseconds: 3000,
    onError: options.onError,
    poll: async (signal) => {
      await options.client.report()
      while (!signal.aborted && (options.mayClaim?.() ?? true)) {
        const freeSlots = Math.max(0, Math.min(options.maximum(), options.pool.read().localMaximum) - options.pool.read().localActive)
        if (freeSlots === 0)
          return
        const turn = await options.client.claim(freeSlots)
        if (turn === null)
          return
        if (signal.aborted || !(options.mayClaim?.() ?? true)) {
          await options.client.defer(turn)
          return
        }
        if (turn.host !== 'hogwild')
          throw new Error('The local session belongs to another host.')
        pending.add(turn.sessionId)
        let permit: { release: () => void } | null
        try {
          permit = options.pool.tryAcquireLocal(`session:${turn.sessionId}`)
          if (permit !== null)
            reservations.set(turn.turnId, { ...permit, sessionId: turn.sessionId })
        }
        finally {
          pending.delete(turn.sessionId)
        }
        if (permit === null) {
          await options.client.defer(turn)
          return
        }
        const work = options.client.run(turn)
          .catch(options.onError)
          .finally(() => { running.delete(work) })
        running.add(work)
      }
    },
  })
  return {
    activeCount: () => reservations.size,
    holds: (sessionId: string) => pending.has(sessionId) || [...reservations.values()].some(permit => permit.sessionId === sessionId),
    release(turnId: string): void {
      const permit = reservations.get(turnId)
      if (permit === undefined)
        return
      permit.release()
      reservations.delete(turnId)
    },
    start: poller.start,
    runNow: poller.runNow,
    async stop(): Promise<void> {
      options.abort?.()
      await poller.stop()
      await Promise.all(running)
    },
  }
}
