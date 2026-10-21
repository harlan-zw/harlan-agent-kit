import type { AgentEvent, AgentProvider } from './agent-provider.ts'
import type { ProviderCircuit, ProviderFailureClass, ProviderStartReservation } from './types.ts'
import { agentProviderFailureReason } from './agent-provider.ts'
import { desktopErrorCause } from './desktop-protocol.ts'

export interface CircuitProtectedProviderStore {
  reserveProviderStart: (input: {
    provider: AgentProvider['name']
    credential: string
    model: string
    workerId: string
    at: string
    leaseMilliseconds: number
  }) => ProviderStartReservation
  renewProviderStart: (input: { circuitId: string, workerId: string, fence: number, at: string, leaseMilliseconds: number }) => boolean
  releaseProviderStart: (input: { circuitId: string, workerId: string, fence: number, at: string }) => boolean
  recordProviderFailure: (input: {
    provider: AgentProvider['name']
    credential: string
    model: string
    failureClass: ProviderFailureClass
    detail: string
    workerId?: string
    canaryCircuitId?: string
    canaryFence?: number
    at: string
  }) => ProviderCircuit | unknown
  recordProviderSuccess: (input: {
    provider: AgentProvider['name']
    credential: string
    model: string
    workerId: string
    canaryCircuitId?: string
    canaryFence?: number
    at: string
  }) => number
}

export interface CircuitProtectedProviderOptions {
  credential: string
  /** Renew active canaries before this reservation lifetime expires. */
  leaseMilliseconds?: number
  now: () => Date
  provider: AgentProvider
  store: CircuitProtectedProviderStore
}

/** Classifies a provider failure without keeping random request identifiers. */
export function stableProviderFailureClass(reason: string): ProviderFailureClass {
  // Matched first. The provider rejected the model configuration the Task
  // pinned, not the provider's health, and no later pattern owns that
  // wording. Aligned with the provider_config kind in failure.ts.
  if (/\bvariant unavailable\b/i.test(reason))
    return 'provider_config'
  if (/\b(?:limit exhausted|usage limit|quota exceeded|credits? exhausted|weekly\/monthly limit)\b/i.test(reason))
    return 'usage_limit'
  if (/\b(?:network|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed)\b/i.test(reason))
    return 'network'
  if (/\b(?:overloaded|capacity|busy|too many requests)\b/i.test(reason))
    return 'overloaded'
  if (/\b(?:stopped sending output|stalled|timed out waiting for output)\b/i.test(reason))
    return 'stalled'
  if (/\b(?:exited with code|process exited|spawn.+ENOENT)\b/i.test(reason))
    return 'process_exit'
  if (/\b(?:authentication|credential|unauthorized|invalid token)\b/i.test(reason))
    return 'authentication'
  return 'unknown'
}

/** Abort pending provider reads before the generator queues its own return. */
function cancellableTurn(signal: AbortSignal, run: (signal: AbortSignal) => AsyncGenerator<AgentEvent>): AsyncIterable<AgentEvent> {
  const closed = new AbortController()
  const turn = run(AbortSignal.any([signal, closed.signal]))
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => turn.next(),
      return: () => {
        closed.abort()
        return turn.return(undefined)
      },
      throw: (error) => {
        closed.abort()
        return turn.throw(error)
      },
    }),
  }
}

/** Wraps one Agent provider with persistent circuit reservation and health recording. */
export function createCircuitProtectedProvider(options: CircuitProtectedProviderOptions): AgentProvider {
  const leaseMilliseconds = options.leaseMilliseconds ?? 2 * 60_000
  return {
    name: options.provider.name,
    runTurn: request => cancellableTurn(request.signal, turnSignal => (async function* (): AsyncGenerator<AgentEvent> {
      const workerId = request.taskId ?? request.workspace
      const reservation = options.store.reserveProviderStart({
        provider: options.provider.name,
        credential: options.credential,
        model: request.model,
        workerId,
        at: options.now().toISOString(),
        leaseMilliseconds,
      })
      if (reservation._tag === 'Paused') {
        yield {
          _tag: 'Failed',
          reason: agentProviderFailureReason(
            options.provider.name,
            `${reservation.reason} Retry after ${reservation.retryAt}.`,
          ),
        }
        return
      }

      let failed = false
      let completed = false
      let healthRecorded = false
      const renewal = new AbortController()
      let renewalTimer: ReturnType<typeof setInterval> | undefined
      const stopRenewal = () => {
        clearInterval(renewalTimer)
        turnSignal.removeEventListener('abort', stopRenewal)
      }
      try {
        if (turnSignal.aborted)
          return
        const canary = reservation.canary
        if (canary !== null) {
          renewalTimer = setInterval(() => {
            try {
              if (options.store.renewProviderStart({ ...canary, at: options.now().toISOString(), leaseMilliseconds }))
                return
              throw new Error('The provider canary reservation was lost.')
            }
            catch (error) {
              stopRenewal()
              // Stop the turn, then propagate this infrastructure failure without
              // treating it as evidence about provider health.
              renewal.abort(error)
            }
          }, Math.max(1, Math.floor(leaseMilliseconds / 3)))
          renewalTimer.unref()
          turnSignal.addEventListener('abort', stopRenewal, { once: true })
        }
        const signal = AbortSignal.any([turnSignal, renewal.signal])
        for await (const event of options.provider.runTurn({ ...request, signal })) {
          renewal.signal.throwIfAborted()
          if (turnSignal.aborted)
            return
          if (event._tag === 'Failed' || event._tag === 'TurnCompleted')
            stopRenewal()
          if (event._tag === 'Failed' && !failed) {
            failed = true
            if (event.cause !== undefined) {
              yield event
              continue
            }
            options.store.recordProviderFailure({
              provider: options.provider.name,
              credential: options.credential,
              model: request.model,
              failureClass: stableProviderFailureClass(event.reason),
              detail: event.reason,
              workerId,
              ...(reservation.canary === null
                ? {}
                : { canaryCircuitId: reservation.canary.circuitId, canaryFence: reservation.canary.fence }),
              at: options.now().toISOString(),
            })
            healthRecorded = true
          }
          if (event._tag === 'TurnCompleted')
            completed = true
          yield event
        }
        renewal.signal.throwIfAborted()
        if (!failed && completed && !turnSignal.aborted) {
          options.store.recordProviderSuccess({
            provider: options.provider.name,
            credential: options.credential,
            model: request.model,
            workerId,
            ...(reservation.canary === null
              ? {}
              : { canaryCircuitId: reservation.canary.circuitId, canaryFence: reservation.canary.fence }),
            at: options.now().toISOString(),
          })
          healthRecorded = true
        }
      }
      catch (error) {
        stopRenewal()
        renewal.signal.throwIfAborted()
        // No desktop cause says the Agent provider is unhealthy, so none of
        // them may open its circuit.
        if (error instanceof Error && desktopErrorCause(error) !== null) {
          if (!turnSignal.aborted)
            yield { _tag: 'Failed', reason: error.message }
          return
        }
        if (turnSignal.aborted)
          return
        failed = true
        const detail = error instanceof Error ? error.message : 'The Agent provider failed unexpectedly.'
        options.store.recordProviderFailure({
          provider: options.provider.name,
          credential: options.credential,
          model: request.model,
          failureClass: stableProviderFailureClass(detail),
          detail,
          workerId,
          ...(reservation.canary === null
            ? {}
            : { canaryCircuitId: reservation.canary.circuitId, canaryFence: reservation.canary.fence }),
          at: options.now().toISOString(),
        })
        healthRecorded = true
        yield { _tag: 'Failed', reason: agentProviderFailureReason(options.provider.name, detail) }
      }
      finally {
        stopRenewal()
        if (reservation.canary !== null && !healthRecorded)
          options.store.releaseProviderStart({ ...reservation.canary, at: options.now().toISOString() })
      }
    })()),
  }
}
