import type { AgentEvent, AgentProvider } from './agent-provider.ts'
import type { ProviderCircuit, ProviderFailureClass, ProviderStartReservation } from './types.ts'
import { agentProviderFailureReason } from './agent-provider.ts'

export interface CircuitProtectedProviderStore {
  reserveProviderStart: (input: {
    provider: AgentProvider['name']
    credential: string
    model: string
    workerId: string
    at: string
    leaseMilliseconds: number
  }) => ProviderStartReservation
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
  /** One canary may hold the half-open state for this long. */
  leaseMilliseconds?: number
  now: () => Date
  provider: AgentProvider
  store: CircuitProtectedProviderStore
}

/** Classifies a provider failure without keeping random request identifiers. */
export function stableProviderFailureClass(reason: string): ProviderFailureClass {
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

/** Wraps one Agent provider with persistent circuit reservation and health recording. */
export function createCircuitProtectedProvider(options: CircuitProtectedProviderOptions): AgentProvider {
  const leaseMilliseconds = options.leaseMilliseconds ?? 2 * 60_000
  return {
    name: options.provider.name,
    runTurn: request => (async function* (): AsyncGenerator<AgentEvent> {
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
      try {
        for await (const event of options.provider.runTurn(request)) {
          if (request.signal.aborted)
            return
          if (event._tag === 'Failed' && !failed) {
            failed = true
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
          }
          if (event._tag === 'TurnCompleted')
            completed = true
          yield event
        }
      }
      catch (error) {
        if (request.signal.aborted)
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
        yield { _tag: 'Failed', reason: agentProviderFailureReason(options.provider.name, detail) }
      }
      if (failed || !completed || request.signal.aborted)
        return
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
    })(),
  }
}
